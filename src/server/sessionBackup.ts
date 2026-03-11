import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureAiCoworkerHome, getAiCoworkerPaths } from "../connect";
import { workspaceFingerprint } from "./sessionBackup/fingerprint";
import {
  copyDirectoryContents,
  emptyDirectory,
  ensureSecureDirectory,
  ensureWorkingDirectory,
  isPathWithin,
} from "./sessionBackup/fileSystem";
import {
  readMetadata,
  type SessionBackupMetadata,
  type SessionBackupMetadataCheckpoint,
  writeJson,
} from "./sessionBackup/metadata";
import { createSnapshotWithTarFallback, restoreSnapshot, snapshotByteSize } from "./sessionBackup/snapshot";

export type SessionBackupCheckpointTrigger = "initial" | "auto" | "manual";

export type SessionBackupPublicCheckpoint = {
  id: string;
  index: number;
  createdAt: string;
  trigger: SessionBackupCheckpointTrigger;
  changed: boolean;
  patchBytes: number;
};

export type SessionBackupPublicState = {
  status: "initializing" | "ready" | "disabled" | "failed";
  sessionId: string;
  workingDirectory: string;
  backupDirectory: string | null;
  createdAt: string;
  originalSnapshot: { kind: "pending" | "directory" | "tar_gz" };
  checkpoints: SessionBackupPublicCheckpoint[];
  failureReason?: string;
};

export type WorkspaceBackupLifecycle = "active" | "closed" | "deleted";

export type WorkspaceBackupPublicEntry = {
  targetSessionId: string;
  title?: string | null;
  provider?: string | null;
  model?: string | null;
  lifecycle: WorkspaceBackupLifecycle;
  status: SessionBackupPublicState["status"];
  workingDirectory: string;
  backupDirectory: string | null;
  originalSnapshotKind: SessionBackupPublicState["originalSnapshot"]["kind"];
  originalSnapshotBytes: number | null;
  checkpointBytesTotal: number | null;
  totalBytes: number | null;
  checkpoints: SessionBackupPublicCheckpoint[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  failureReason?: string;
};

export type WorkspaceBackupDeltaFile = {
  path: string;
  change: "added" | "modified" | "deleted";
  kind: "file" | "directory" | "symlink";
};

export type WorkspaceBackupDeltaPreview = {
  targetSessionId: string;
  checkpointId: string;
  baselineLabel: string;
  currentLabel: string;
  counts: {
    added: number;
    modified: number;
    deleted: number;
  };
  files: WorkspaceBackupDeltaFile[];
  truncated: boolean;
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
  reloadFromDisk(): Promise<SessionBackupPublicState>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METADATA_FILE = "metadata.json";
const ORIGINAL_DIR = "original";
const ORIGINAL_ARCHIVE = "original.tar.gz";
const CHECKPOINTS_DIR = "checkpoints";
const DEFAULT_MAX_CLOSED_SESSIONS = 20;
const DEFAULT_MAX_CLOSED_AGE_DAYS = 7;

export function getSessionBackupsRootDirs(opts: { homedir?: string } = {}): string[] {
  const paths = getAiCoworkerPaths({ homedir: opts.homedir });
  return [
    path.join(paths.rootDir, "session-backups"),
    path.join(os.tmpdir(), "cowork-session-backups"),
  ];
}

function resolveSessionBackupsRootDir(workingDirectory: string, opts: { homedir?: string } = {}): string {
  const [defaultBackupsRootDir, fallbackBackupsRootDir] = getSessionBackupsRootDirs(opts);
  return isPathWithin(workingDirectory, defaultBackupsRootDir) ? fallbackBackupsRootDir : defaultBackupsRootDir;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function makeCheckpointId(index: number): string {
  return `cp-${String(index).padStart(4, "0")}`;
}

function buildInitialCheckpoint(opts: {
  createdAt: string;
  fingerprint: string;
  snapshot: SessionBackupMetadata["originalSnapshot"];
}): SessionBackupMetadataCheckpoint {
  return {
    id: makeCheckpointId(1),
    index: 1,
    createdAt: opts.createdAt,
    trigger: "initial",
    changed: false,
    patchBytes: 0,
    fingerprint: opts.fingerprint,
    snapshot: {
      kind: opts.snapshot.kind,
      path: opts.snapshot.path,
    },
  };
}

function withInitialCheckpoint(
  metadata: SessionBackupMetadata,
  originalFingerprint: string,
): { metadata: SessionBackupMetadata; changed: boolean } {
  if (metadata.checkpoints.length > 0) {
    return { metadata, changed: false };
  }

  return {
    metadata: {
      ...metadata,
      checkpoints: [
        buildInitialCheckpoint({
          createdAt: metadata.createdAt,
          fingerprint: originalFingerprint,
          snapshot: metadata.originalSnapshot,
        }),
      ],
    },
    changed: true,
  };
}

async function fingerprintSnapshot(sessionDir: string, snapshot: { kind: "directory" | "tar_gz"; path: string }): Promise<string> {
  const fingerprintStageDir = await fs.mkdtemp(path.join(sessionDir, ".fingerprint-stage-"));
  try {
    await restoreSnapshot({
      sessionDir,
      targetDir: fingerprintStageDir,
      snapshot,
    });
    return await workspaceFingerprint(fingerprintStageDir);
  } finally {
    await fs.rm(fingerprintStageDir, { recursive: true, force: true });
  }
}

async function normalizeMetadataOnLoad(
  metadata: SessionBackupMetadata,
  sessionDir: string,
  metadataPath: string,
): Promise<{ metadata: SessionBackupMetadata; originalFingerprint: string }> {
  const originalFingerprint = metadata.originalFingerprint
    ?? await fingerprintSnapshot(sessionDir, metadata.originalSnapshot);
  const fingerprintNormalizedMetadata = metadata.originalFingerprint
    ? metadata
    : { ...metadata, originalFingerprint };
  const { metadata: normalizedMetadata, changed: addedInitialCheckpoint } = withInitialCheckpoint(
    fingerprintNormalizedMetadata,
    originalFingerprint,
  );
  if (!metadata.originalFingerprint || addedInitialCheckpoint) {
    await writeJson(metadataPath, normalizedMetadata);
  }
  return { metadata: normalizedMetadata, originalFingerprint };
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

    await ensureAiCoworkerHome(paths);

    const backupsRootDir = resolveSessionBackupsRootDir(workingDirectory, { homedir: opts.homedir });
    const sessionDir = path.join(backupsRootDir, opts.sessionId);
    const metadataPath = path.join(sessionDir, METADATA_FILE);

    if (isPathWithin(workingDirectory, sessionDir)) {
      throw new Error(`Refusing to create session backup inside working directory: ${workingDirectory}`);
    }

    await ensureSecureDirectory(backupsRootDir);
    await ensureSecureDirectory(sessionDir);
    await ensureSecureDirectory(path.join(sessionDir, CHECKPOINTS_DIR));
    const existing = await readMetadata(metadataPath);
    if (existing) {
      if (existing.sessionId !== opts.sessionId) {
        throw new Error(`Refusing to reuse backup with mismatched session id at ${metadataPath}`);
      }
      if (path.resolve(existing.workingDirectory) !== workingDirectory) {
        throw new Error(`Refusing to reuse backup with mismatched working directory at ${metadataPath}`);
      }
      return await SessionBackupManager.openExisting({ sessionDir, reopen: true });
    }
    await ensureWorkingDirectory(workingDirectory);
    const originalFingerprint = await workspaceFingerprint(workingDirectory);

    const originalSnapshot = await createSnapshotWithTarFallback({
      sourceDir: workingDirectory,
      sessionDir,
      tarPath: ORIGINAL_ARCHIVE,
      directoryPath: ORIGINAL_DIR,
    });

    const createdAt = new Date().toISOString();
    const metadata: SessionBackupMetadata = {
      version: 1,
      sessionId: opts.sessionId,
      workingDirectory,
      createdAt,
      state: "active",
      originalFingerprint,
      originalSnapshot,
      checkpoints: [
        buildInitialCheckpoint({
          createdAt,
          fingerprint: originalFingerprint,
          snapshot: originalSnapshot,
        }),
      ],
    };
    await writeJson(metadataPath, metadata);

    return new SessionBackupManager({ metadata, originalFingerprint, sessionDir, metadataPath });
  }

  static async openExisting(opts: { sessionDir: string; reopen?: boolean }): Promise<SessionBackupManager> {
    const sessionDir = path.resolve(opts.sessionDir);
    const metadataPath = path.join(sessionDir, METADATA_FILE);
    const metadata = await readMetadata(metadataPath);
    if (!metadata) {
      throw new Error(`Missing backup metadata at ${metadataPath}`);
    }
    const normalized = await normalizeMetadataOnLoad(metadata, sessionDir, metadataPath);
    let resolvedMetadata = normalized.metadata;
    if (opts.reopen && (resolvedMetadata.state !== "active" || resolvedMetadata.closedAt !== undefined)) {
      const { closedAt: _closedAt, ...activeMetadata } = resolvedMetadata;
      resolvedMetadata = {
        ...activeMetadata,
        state: "active",
      };
      await writeJson(metadataPath, resolvedMetadata);
    }
    return new SessionBackupManager({
      metadata: resolvedMetadata,
      originalFingerprint: normalized.originalFingerprint,
      sessionDir,
      metadataPath,
    });
  }

  private metadata: SessionBackupMetadata;
  private originalFingerprint: string;
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
    if (checkpoint.trigger === "initial") {
      throw new Error("Cannot delete the initial checkpoint");
    }

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

  async reloadFromDisk(): Promise<SessionBackupPublicState> {
    const metadata = await readMetadata(this.metadataPath);
    if (!metadata) {
      throw new Error(`Missing backup metadata at ${this.metadataPath}`);
    }
    const normalized = await normalizeMetadataOnLoad(metadata, this.sessionDir, this.metadataPath);
    this.metadata = normalized.metadata;
    this.originalFingerprint = normalized.originalFingerprint;
    return this.getPublicState();
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
