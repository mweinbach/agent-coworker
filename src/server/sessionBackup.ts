import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type SessionBackupMetadataCheckpoint = SessionBackupPublicCheckpoint & {
  fingerprint: string;
  snapshot: {
    kind: "directory" | "tar_gz";
    path: string;
  };
};

type SessionBackupMetadata = {
  version: 1;
  sessionId: string;
  workingDirectory: string;
  createdAt: string;
  state: "active" | "closed";
  closedAt?: string;
  originalSnapshot: {
    kind: "directory" | "tar_gz";
    path: string;
  };
  checkpoints: SessionBackupMetadataCheckpoint[];
};

const snapshotRefSchema = z.object({
  kind: z.enum(["directory", "tar_gz"]),
  path: z.string().min(1),
});

const sessionBackupMetadataCheckpointSchema = z.object({
  id: z.string().min(1),
  index: z.number(),
  createdAt: z.string().min(1),
  trigger: z.enum(["auto", "manual"]),
  changed: z.boolean(),
  patchBytes: z.number(),
  fingerprint: z.string().min(1),
  snapshot: snapshotRefSchema,
}).passthrough();

const sessionBackupMetadataSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  workingDirectory: z.string().min(1),
  createdAt: z.string().min(1),
  state: z.enum(["active", "closed"]),
  closedAt: z.string().optional(),
  originalSnapshot: snapshotRefSchema,
  checkpoints: z.array(sessionBackupMetadataCheckpointSchema),
}).passthrough();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METADATA_FILE = "metadata.json";
const ORIGINAL_DIR = "original";
const ORIGINAL_ARCHIVE = "original.tar.gz";
const CHECKPOINTS_DIR = "checkpoints";
const DEFAULT_MAX_CLOSED_SESSIONS = 20;
const DEFAULT_MAX_CLOSED_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function makeCheckpointId(index: number): string {
  return `cp-${String(index).padStart(4, "0")}`;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  if (!relative) return true;
  if (relative.startsWith("..")) return false;
  return !path.isAbsolute(relative);
}

type CommandResult = { exitCode: number | null; stdout: string; stderr: string };

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<CommandResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: String(err) };
  }

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

  let spawnErr: unknown = null;
  const closePromise = new Promise<number | null>((resolve) => {
    child.once("error", (err) => {
      spawnErr = err;
      resolve(127);
    });
    child.once("close", (exitCode) => resolve(exitCode));
  });

  child.stdin?.end();

  const [exitCode] = await Promise.all([closePromise, stdoutPromise, stderrPromise]);

  const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
  const stderrBase = Buffer.concat(stderrChunks).toString("utf-8");
  const stderr = spawnErr ? `${stderrBase}\n${String((spawnErr as any)?.message ?? spawnErr)}`.trim() : stderrBase;

  return { exitCode, stdout, stderr };
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

async function emptyDirectory(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function copyDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true, force: true, errorOnExist: false });
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

async function directoryByteSize(rootDir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryByteSize(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(entryPath);
    total += stat.size;
  }
  return total;
}

async function updateHashWithFileContent(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
}

async function updateHashWithDirectory(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  currentDir: string
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      hash.update(`D:${relativePath}\n`);
      await updateHashWithDirectory(hash, rootDir, absolutePath);
      continue;
    }
    if (entry.isFile()) {
      hash.update(`F:${relativePath}\n`);
      await updateHashWithFileContent(hash, absolutePath);
      hash.update("\n");
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath).catch(() => "<unreadable>");
      hash.update(`L:${relativePath}->${target}\n`);
      continue;
    }
    const stat = await fs.lstat(absolutePath);
    hash.update(`O:${relativePath}:${stat.mode}:${stat.size}\n`);
  }
}

async function workspaceFingerprint(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("session-backup-workspace-v1\n");
  await updateHashWithDirectory(hash, rootDir, rootDir);
  return hash.digest("hex");
}

async function createSnapshotWithTarFallback(opts: {
  sourceDir: string;
  sessionDir: string;
  tarPath: string;
  directoryPath: string;
}): Promise<{ kind: "directory" | "tar_gz"; path: string }> {
  const archivePath = path.join(opts.sessionDir, opts.tarPath);
  try {
    await createTarGz(opts.sourceDir, archivePath);
    return { kind: "tar_gz", path: opts.tarPath };
  } catch {
    const directoryPath = path.join(opts.sessionDir, opts.directoryPath);
    await copyDirectory(opts.sourceDir, directoryPath);
    return { kind: "directory", path: opts.directoryPath };
  }
}

async function snapshotByteSize(
  sessionDir: string,
  snapshot: { kind: "directory" | "tar_gz"; path: string }
): Promise<number> {
  const absolutePath = path.join(sessionDir, snapshot.path);
  if (snapshot.kind === "tar_gz") {
    const stat = await fs.stat(absolutePath);
    return stat.size;
  }
  return directoryByteSize(absolutePath);
}

async function restoreSnapshot(opts: {
  sessionDir: string;
  targetDir: string;
  snapshot: { kind: "directory" | "tar_gz"; path: string };
}): Promise<void> {
  const absolutePath = path.join(opts.sessionDir, opts.snapshot.path);
  if (opts.snapshot.kind === "tar_gz") {
    await extractTarGz(absolutePath, opts.targetDir);
    return;
  }
  await copyDirectoryContents(absolutePath, opts.targetDir);
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
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid backup metadata JSON at ${filePath}: ${String(error)}`);
    }
    const parsed = sessionBackupMetadataSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid backup metadata schema at ${filePath}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
    }
    return parsed.data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tar operations
// ---------------------------------------------------------------------------

async function createTarGz(sourceDir: string, targetArchive: string): Promise<void> {
  await ensureSecureDirectory(path.dirname(targetArchive));
  const res = await runCommand("tar", ["-czf", targetArchive, "-C", sourceDir, "."]);
  if (res.exitCode !== 0) {
    throw new Error(`tar create failed: ${res.stderr || res.stdout || `exit=${String(res.exitCode)}`}`);
  }
  try {
    await fs.chmod(targetArchive, 0o600);
  } catch {
    // best effort only
  }
}

async function extractTarGz(archivePath: string, targetDir: string): Promise<void> {
  await ensureSecureDirectory(targetDir);
  const res = await runCommand("tar", ["-xzf", archivePath, "-C", targetDir]);
  if (res.exitCode !== 0) {
    throw new Error(`tar extract failed: ${res.stderr || res.stdout || `exit=${String(res.exitCode)}`}`);
  }
}

// ---------------------------------------------------------------------------
// SessionBackupManager
// ---------------------------------------------------------------------------

export class SessionBackupManager implements SessionBackupHandle {
  static async pruneClosedSessions(
    backupsRootDir: string,
    opts?: { maxClosedSessions?: number; maxClosedAgeDays?: number; skipSessionId?: string }
  ): Promise<void> {
    await ensureSecureDirectory(backupsRootDir);
    const maxClosedSessions = Math.max(1, Math.floor(opts?.maxClosedSessions ?? DEFAULT_MAX_CLOSED_SESSIONS));
    const maxClosedAgeDays = Math.max(1, Math.floor(opts?.maxClosedAgeDays ?? DEFAULT_MAX_CLOSED_AGE_DAYS));
    const maxClosedAgeMs = maxClosedAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const entries = await fs.readdir(backupsRootDir, { withFileTypes: true });
    const closedSessions: Array<{ sessionId: string; sessionDir: string; closedAtMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (opts?.skipSessionId && entry.name === opts.skipSessionId) continue;
      const sessionDir = path.join(backupsRootDir, entry.name);
      const metadata = await readMetadata(path.join(sessionDir, METADATA_FILE));
      if (!metadata || metadata.state !== "closed") continue;
      const closedAtMs = Date.parse(metadata.closedAt ?? metadata.createdAt);
      closedSessions.push({
        sessionId: metadata.sessionId,
        sessionDir,
        closedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : 0,
      });
    }

    closedSessions.sort((a, b) => b.closedAtMs - a.closedAtMs);
    const keep = new Set(closedSessions.slice(0, maxClosedSessions).map((x) => x.sessionId));

    for (const session of closedSessions) {
      const tooOld = session.closedAtMs > 0 && now - session.closedAtMs > maxClosedAgeMs;
      const overLimit = !keep.has(session.sessionId);
      if (!tooOld && !overLimit) continue;
      await fs.rm(session.sessionDir, { recursive: true, force: true });
    }
  }

  static async create(opts: SessionBackupInitOptions): Promise<SessionBackupManager> {
    const workingDirectory = path.resolve(opts.workingDirectory);
    const paths = getAiCoworkerPaths({ homedir: opts.homedir });
    const defaultBackupsRootDir = path.join(paths.rootDir, "session-backups");

    await ensureAiCoworkerHome(paths);

    const backupsRootDir = isPathWithin(workingDirectory, defaultBackupsRootDir)
      ? path.join(os.tmpdir(), "cowork-session-backups")
      : defaultBackupsRootDir;
    const sessionDir = path.join(backupsRootDir, opts.sessionId);

    if (isPathWithin(workingDirectory, sessionDir)) {
      throw new Error(`Refusing to create session backup inside working directory: ${workingDirectory}`);
    }

    await ensureSecureDirectory(backupsRootDir);
    await ensureSecureDirectory(sessionDir);
    await ensureSecureDirectory(path.join(sessionDir, CHECKPOINTS_DIR));
    await ensureWorkingDirectory(workingDirectory);
    const originalFingerprint = await workspaceFingerprint(workingDirectory);

    const originalSnapshot = await createSnapshotWithTarFallback({
      sourceDir: workingDirectory,
      sessionDir,
      tarPath: ORIGINAL_ARCHIVE,
      directoryPath: ORIGINAL_DIR,
    });

    const metadata: SessionBackupMetadata = {
      version: 1,
      sessionId: opts.sessionId,
      workingDirectory,
      createdAt: new Date().toISOString(),
      state: "active",
      originalSnapshot,
      checkpoints: [],
    };
    const metadataPath = path.join(sessionDir, METADATA_FILE);
    await writeJson(metadataPath, metadata);

    return new SessionBackupManager({ metadata, originalFingerprint, sessionDir, metadataPath });
  }

  private metadata: SessionBackupMetadata;
  private readonly originalFingerprint: string;
  private readonly sessionDir: string;
  private readonly metadataPath: string;

  private constructor(opts: {
    metadata: SessionBackupMetadata;
    originalFingerprint: string;
    sessionDir: string;
    metadataPath: string;
  }) {
    this.metadata = opts.metadata;
    this.originalFingerprint = opts.originalFingerprint;
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
    await ensureWorkingDirectory(this.metadata.workingDirectory);
    const index = this.metadata.checkpoints.length + 1;
    const id = makeCheckpointId(index);
    const createdAt = new Date().toISOString();
    const previousCheckpoint = this.metadata.checkpoints[this.metadata.checkpoints.length - 1];
    const currentFingerprint = await workspaceFingerprint(this.metadata.workingDirectory);
    const previousFingerprint = previousCheckpoint?.fingerprint ?? this.originalFingerprint;
    const changed = currentFingerprint !== previousFingerprint;

    let patchBytes = 0;
    let snapshot: SessionBackupMetadataCheckpoint["snapshot"];
    if (changed) {
      const tarPath = path.join(CHECKPOINTS_DIR, `${id}.tar.gz`);
      const directoryPath = path.join(CHECKPOINTS_DIR, id);
      snapshot = await createSnapshotWithTarFallback({
        sourceDir: this.metadata.workingDirectory,
        sessionDir: this.sessionDir,
        tarPath,
        directoryPath,
      });
      patchBytes = await snapshotByteSize(this.sessionDir, snapshot);
    } else {
      const previousSnapshot = previousCheckpoint?.snapshot ?? this.metadata.originalSnapshot;
      snapshot = { kind: previousSnapshot.kind, path: previousSnapshot.path };
    }

    const checkpoint: SessionBackupMetadataCheckpoint = {
      id,
      index,
      createdAt,
      trigger,
      changed,
      patchBytes,
      fingerprint: currentFingerprint,
      snapshot,
    };

    this.metadata.checkpoints.push(checkpoint);
    await this.persistMetadata();

    return { id, index, createdAt, trigger, changed, patchBytes };
  }

  async restoreOriginal(): Promise<void> {
    if (isPathWithin(this.metadata.workingDirectory, this.sessionDir)) {
      throw new Error("Refusing to restore: backup directory is inside the working directory");
    }
    await this.restoreSnapshotSafely(this.metadata.originalSnapshot);
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    const checkpoint = this.metadata.checkpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);

    if (isPathWithin(this.metadata.workingDirectory, this.sessionDir)) {
      throw new Error("Refusing to restore: backup directory is inside the working directory");
    }
    await this.restoreSnapshotSafely(checkpoint.snapshot);
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    const idx = this.metadata.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (idx < 0) return false;

    const checkpoint = this.metadata.checkpoints[idx];
    this.metadata.checkpoints.splice(idx, 1);
    const snapshotStillReferenced =
      this.metadata.checkpoints.some(
        (cp) => cp.snapshot.kind === checkpoint.snapshot.kind && cp.snapshot.path === checkpoint.snapshot.path
      ) ||
      (this.metadata.originalSnapshot.kind === checkpoint.snapshot.kind &&
        this.metadata.originalSnapshot.path === checkpoint.snapshot.path);
    if (!snapshotStillReferenced) {
      await fs.rm(path.join(this.sessionDir, checkpoint.snapshot.path), { recursive: true, force: true });
    }
    await this.persistMetadata();
    return true;
  }

  async close(): Promise<void> {
    if (this.metadata.state === "closed") return;
    this.metadata.state = "closed";
    this.metadata.closedAt = new Date().toISOString();
    await this.persistMetadata();
    try {
      await SessionBackupManager.pruneClosedSessions(path.dirname(this.sessionDir), {
        skipSessionId: this.metadata.sessionId,
      });
    } catch {
      // best-effort cleanup
    }
  }

  private async persistMetadata(): Promise<void> {
    await writeJson(this.metadataPath, this.metadata);
  }

  private async restoreSnapshotSafely(snapshot: {
    kind: "directory" | "tar_gz";
    path: string;
  }): Promise<void> {
    await ensureWorkingDirectory(this.metadata.workingDirectory);
    const restoreStageDir = await fs.mkdtemp(path.join(this.sessionDir, ".restore-stage-"));
    try {
      await restoreSnapshot({
        sessionDir: this.sessionDir,
        targetDir: restoreStageDir,
        snapshot,
      });
      await emptyDirectory(this.metadata.workingDirectory);
      await copyDirectoryContents(restoreStageDir, this.metadata.workingDirectory);
    } finally {
      await fs.rm(restoreStageDir, { recursive: true, force: true });
    }
  }
}
