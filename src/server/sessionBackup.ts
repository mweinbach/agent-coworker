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
