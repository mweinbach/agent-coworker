import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { ensureAiCoworkerHome, getAiCoworkerPaths } from "../connect";

export type SessionBackupCheckpointTrigger = "auto" | "manual";

export type SessionBackupPublicCheckpoint = {
  id: string;
  index: number;
  createdAt: string;
  trigger: SessionBackupCheckpointTrigger;
  changed: boolean;
  patchBytes: number;
};

export type SessionBackupPublicState = {
  status: "initializing" | "ready" | "failed";
  sessionId: string;
  workingDirectory: string;
  backupDirectory: string | null;
  createdAt: string;
  originalSnapshot: { kind: "pending" | "directory" | "tar_gz" };
  checkpoints: SessionBackupPublicCheckpoint[];
  failureReason?: string;
};

type SessionBackupMetadataCheckpoint = SessionBackupPublicCheckpoint & {
  patchFile?: string;
};

type SessionBackupMetadata = {
  version: 1;
  sessionId: string;
  workingDirectory: string;
  createdAt: string;
  state: "active" | "closed";
  closedAt?: string;
  compactedAt?: string;
  originalSnapshot: { kind: "directory" | "tar_gz"; path: string };
  checkpoints: SessionBackupMetadataCheckpoint[];
};

export type SessionBackupInitOptions = {
  sessionId: string;
  workingDirectory: string;
  homedir?: string;
};

export interface SessionBackupHandle {
  getPublicState(): SessionBackupPublicState;
  createCheckpoint(trigger: SessionBackupCheckpointTrigger): Promise<SessionBackupPublicCheckpoint>;
  restoreOriginal(): Promise<void>;
  restoreCheckpoint(checkpointId: string): Promise<void>;
  deleteCheckpoint(checkpointId: string): Promise<boolean>;
  close(): Promise<void>;
}

const METADATA_FILE = "metadata.json";
const ORIGINAL_DIR = "original";
const ORIGINAL_ARCHIVE = "original.tar.gz";
const CHECKPOINTS_DIR = "checkpoints";

function makeCheckpointId(index: number): string {
  return `cp-${String(index).padStart(4, "0")}`;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  if (!relative) return true;
  if (relative.startsWith("..")) return false;
  return !path.isAbsolute(relative);
}

function toPatchPrefix(absPath: string): string {
  const resolved = path.resolve(absPath).replace(/\\/g, "/").replace(/^\/+/, "");
  return resolved.endsWith("/") ? resolved : `${resolved}/`;
}

function normalizeDiffPatchPaths(diffPatch: string, originalDir: string, workingDir: string): string {
  if (!diffPatch.trim()) return "";

  const originalPrefix = toPatchPrefix(originalDir);
  const workingPrefix = toPatchPrefix(workingDir);

  const replacePrefix = (line: string, prefix: string) =>
    line.replace(`a/${prefix}`, "a/").replace(`b/${prefix}`, "b/");

  return diffPatch
    .split("\n")
    .map((line) => {
      if (!line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
        return line;
      }
      return replacePrefix(replacePrefix(line, originalPrefix), workingPrefix);
    })
    .join("\n");
}

type CommandResult = { exitCode: number | null; stdout: string; stderr: string };

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; stdin?: string } = {}
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const stdoutPromise = (async () => {
    if (!child.stdout) return;
    for await (const chunk of child.stdout) stdoutChunks.push(chunk);
  })();

  const stderrPromise = (async () => {
    if (!child.stderr) return;
    for await (const chunk of child.stderr) stderrChunks.push(chunk);
  })();

  const closePromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.write(opts.stdin);
  }
  child.stdin?.end();

  const [exitCode] = await Promise.all([closePromise, stdoutPromise, stderrPromise]);

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function ensureSecureDirectory(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(p, 0o700);
  } catch {
    // best effort only
  }
}

async function ensureWorkingDirectory(workingDirectory: string): Promise<void> {
  try {
    const st = await fs.stat(workingDirectory);
    if (!st.isDirectory()) throw new Error(`Working directory is not a directory: ${workingDirectory}`);
  } catch {
    await fs.mkdir(workingDirectory, { recursive: true });
  }
}

async function copyDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true, force: true, errorOnExist: false });
}

async function emptyDirectory(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function copyDirectoryContents(sourceDir: string, destinationDir: string): Promise<void> {
  await ensureDirectory(destinationDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort only
  }
}

async function readMetadata(filePath: string): Promise<SessionBackupMetadata | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as SessionBackupMetadata;
    if (parsed && parsed.version === 1 && typeof parsed.sessionId === "string") return parsed;
  } catch {
    // ignore malformed files; compaction should continue best-effort
  }
  return null;
}

async function createTarGzFromDirectory(sourceDir: string, targetArchive: string): Promise<void> {
  await ensureSecureDirectory(path.dirname(targetArchive));
  const parentDir = path.dirname(sourceDir);
  const dirName = path.basename(sourceDir);
  const res = await runCommand("tar", ["-czf", targetArchive, "-C", parentDir, dirName]);
  if (res.exitCode !== 0) {
    throw new Error(`tar create failed: ${res.stderr || res.stdout || `exit=${String(res.exitCode)}`}`);
  }
  try {
    await fs.chmod(targetArchive, 0o600);
  } catch {
    // best effort only
  }
}

async function extractTarGzIntoDirectory(archivePath: string, targetDir: string): Promise<void> {
  await ensureSecureDirectory(targetDir);
  const res = await runCommand("tar", ["-xzf", archivePath, "-C", targetDir]);
  if (res.exitCode !== 0) {
    throw new Error(`tar extract failed: ${res.stderr || res.stdout || `exit=${String(res.exitCode)}`}`);
  }
}

async function createDiffPatch(originalDir: string, workingDir: string): Promise<string> {
  const res = await runCommand("git", ["diff", "--no-index", "--binary", originalDir, workingDir]);
  if (res.exitCode === 0) return "";
  if (res.exitCode === 1) return normalizeDiffPatchPaths(res.stdout, originalDir, workingDir);
  throw new Error(res.stderr || res.stdout || `git diff failed (exit=${String(res.exitCode)})`);
}

async function applyDiffPatch(workingDir: string, patchText: string): Promise<void> {
  if (!patchText.trim()) return;
  const res = await runCommand("git", ["apply", "--binary", "--whitespace=nowarn"], {
    cwd: workingDir,
    stdin: patchText,
  });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr || res.stdout || `git apply failed (exit=${String(res.exitCode)})`);
  }
}

export class SessionBackupManager implements SessionBackupHandle {
  static async compactClosedSessions(backupsRootDir: string, skipSessionId?: string): Promise<void> {
    await ensureSecureDirectory(backupsRootDir);
    const entries = await fs.readdir(backupsRootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipSessionId && entry.name === skipSessionId) continue;

      const sessionDir = path.join(backupsRootDir, entry.name);
      const metadataPath = path.join(sessionDir, METADATA_FILE);
      const metadata = await readMetadata(metadataPath);
      if (!metadata) continue;
      if (metadata.state !== "closed") continue;
      if (metadata.originalSnapshot.kind !== "directory") continue;

      const originalDir = path.join(sessionDir, metadata.originalSnapshot.path);
      if (!(await pathExists(originalDir))) continue;

      try {
        const archivePath = path.join(sessionDir, ORIGINAL_ARCHIVE);
        await createTarGzFromDirectory(originalDir, archivePath);
        await fs.rm(originalDir, { recursive: true, force: true });
        metadata.originalSnapshot = { kind: "tar_gz", path: ORIGINAL_ARCHIVE };
        metadata.compactedAt = new Date().toISOString();
        await writeJson(metadataPath, metadata);
      } catch {
        // best-effort compaction; leave uncompressed if tar is unavailable/fails
      }
    }
  }

  static async create(opts: SessionBackupInitOptions): Promise<SessionBackupManager> {
    const workingDirectory = path.resolve(opts.workingDirectory);
    const paths = getAiCoworkerPaths({ homedir: opts.homedir });
    const defaultBackupsRootDir = path.join(paths.rootDir, "session-backups");

    // Ensure ~/.cowork exists and isn't world-readable before adding backups beneath it.
    await ensureAiCoworkerHome(paths);

    // If the default backup directory would be created inside the working directory (e.g. when
    // the working directory is the user's home), fall back to a temp location to avoid self-copies
    // and restore routines deleting their own backup source.
    const backupsRootDir = isPathWithin(workingDirectory, defaultBackupsRootDir)
      ? path.join(os.tmpdir(), "cowork-session-backups")
      : defaultBackupsRootDir;
    const sessionDir = path.join(backupsRootDir, opts.sessionId);
    const originalDir = path.join(sessionDir, ORIGINAL_DIR);
    const metadataPath = path.join(sessionDir, METADATA_FILE);

    if (isPathWithin(workingDirectory, sessionDir)) {
      // If the working directory is "/" (or similar), there is no safe backup location; refuse.
      throw new Error(`Refusing to create session backup inside working directory: ${workingDirectory}`);
    }

    await ensureSecureDirectory(backupsRootDir);
    await SessionBackupManager.compactClosedSessions(backupsRootDir, opts.sessionId);

    await ensureSecureDirectory(sessionDir);
    await ensureSecureDirectory(path.join(sessionDir, CHECKPOINTS_DIR));
    await ensureWorkingDirectory(workingDirectory);
    await copyDirectory(workingDirectory, originalDir);

    const metadata: SessionBackupMetadata = {
      version: 1,
      sessionId: opts.sessionId,
      workingDirectory,
      createdAt: new Date().toISOString(),
      state: "active",
      originalSnapshot: { kind: "directory", path: ORIGINAL_DIR },
      checkpoints: [],
    };
    await writeJson(metadataPath, metadata);

    return new SessionBackupManager({
      metadata,
      sessionDir,
      metadataPath,
    });
  }

  private metadata: SessionBackupMetadata;
  private readonly sessionDir: string;
  private readonly metadataPath: string;

  private constructor(opts: {
    metadata: SessionBackupMetadata;
    sessionDir: string;
    metadataPath: string;
  }) {
    this.metadata = opts.metadata;
    this.sessionDir = opts.sessionDir;
    this.metadataPath = opts.metadataPath;
  }

  getPublicState(): SessionBackupPublicState {
    return {
      status: "ready",
      sessionId: this.metadata.sessionId,
      workingDirectory: this.metadata.workingDirectory,
      backupDirectory: this.sessionDir,
      createdAt: this.metadata.createdAt,
      originalSnapshot: { kind: this.metadata.originalSnapshot.kind },
      checkpoints: this.metadata.checkpoints.map((cp) => ({
        id: cp.id,
        index: cp.index,
        createdAt: cp.createdAt,
        trigger: cp.trigger,
        changed: cp.changed,
        patchBytes: cp.patchBytes,
      })),
    };
  }

  async createCheckpoint(trigger: SessionBackupCheckpointTrigger): Promise<SessionBackupPublicCheckpoint> {
    const originalDir = await this.ensureOriginalDirectory();
    const diffPatch = await createDiffPatch(originalDir, this.metadata.workingDirectory);
    const changed = diffPatch.trim().length > 0;

    const index = this.metadata.checkpoints.length + 1;
    const id = makeCheckpointId(index);
    const createdAt = new Date().toISOString();

    let patchBytes = 0;
    let patchFile: string | undefined;

    if (changed) {
      const patchAbsPath = path.join(this.sessionDir, CHECKPOINTS_DIR, `${id}.patch.gz`);
      const compressed = gzipSync(Buffer.from(diffPatch, "utf-8"));
      patchBytes = compressed.byteLength;
      await fs.writeFile(patchAbsPath, compressed, { mode: 0o600 });
      try {
        await fs.chmod(patchAbsPath, 0o600);
      } catch {
        // best effort only
      }
      patchFile = path.join(CHECKPOINTS_DIR, `${id}.patch.gz`);
    }

    const checkpoint: SessionBackupMetadataCheckpoint = {
      id,
      index,
      createdAt,
      trigger,
      changed,
      patchBytes,
      patchFile,
    };

    this.metadata.checkpoints.push(checkpoint);
    await this.persistMetadata();

    return {
      id: checkpoint.id,
      index: checkpoint.index,
      createdAt: checkpoint.createdAt,
      trigger: checkpoint.trigger,
      changed: checkpoint.changed,
      patchBytes: checkpoint.patchBytes,
    };
  }

  async restoreOriginal(): Promise<void> {
    // Restoring is inherently destructive. Refuse if the backup dir lives inside the working directory
    // (e.g. misconfigured workingDirectory="/"), as we'd be deleting our own restore source.
    if (isPathWithin(this.metadata.workingDirectory, this.sessionDir)) {
      throw new Error("Refusing to restore: backup directory is inside the working directory");
    }

    const originalDir = await this.ensureOriginalDirectory();
    await ensureWorkingDirectory(this.metadata.workingDirectory);
    await emptyDirectory(this.metadata.workingDirectory);
    await copyDirectoryContents(originalDir, this.metadata.workingDirectory);
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    const checkpoint = this.metadata.checkpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);

    await this.restoreOriginal();
    if (!checkpoint.changed) return;
    if (!checkpoint.patchFile) {
      throw new Error(`Checkpoint ${checkpointId} is marked changed but has no patch file`);
    }

    const patchAbsPath = path.join(this.sessionDir, checkpoint.patchFile);
    const compressed = await fs.readFile(patchAbsPath);
    const patchText = gunzipSync(compressed).toString("utf-8");
    await applyDiffPatch(this.metadata.workingDirectory, patchText);
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    const idx = this.metadata.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (idx < 0) return false;

    const checkpoint = this.metadata.checkpoints[idx];
    this.metadata.checkpoints.splice(idx, 1);

    if (checkpoint.patchFile) {
      const patchAbsPath = path.join(this.sessionDir, checkpoint.patchFile);
      await fs.rm(patchAbsPath, { force: true });
    }

    await this.persistMetadata();
    return true;
  }

  async close(): Promise<void> {
    if (this.metadata.state === "closed") return;
    this.metadata.state = "closed";
    this.metadata.closedAt = new Date().toISOString();
    await this.persistMetadata();
  }

  private async ensureOriginalDirectory(): Promise<string> {
    if (this.metadata.originalSnapshot.kind === "directory") {
      const originalDir = path.join(this.sessionDir, this.metadata.originalSnapshot.path);
      if (await pathExists(originalDir)) return originalDir;
    }

    if (this.metadata.originalSnapshot.kind === "tar_gz") {
      const archivePath = path.join(this.sessionDir, this.metadata.originalSnapshot.path);
      await extractTarGzIntoDirectory(archivePath, this.sessionDir);
      this.metadata.originalSnapshot = { kind: "directory", path: ORIGINAL_DIR };
      await this.persistMetadata();
      return path.join(this.sessionDir, ORIGINAL_DIR);
    }

    const originalDir = path.join(this.sessionDir, ORIGINAL_DIR);
    if (!(await pathExists(originalDir))) {
      throw new Error("Original backup snapshot is unavailable");
    }
    return originalDir;
  }

  private async persistMetadata(): Promise<void> {
    await writeJson(this.metadataPath, this.metadata);
  }
}
