import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "../types";
import type { SessionDb, SessionPersistenceStatus } from "./sessionDb";
import {
  getSessionBackupsRootDirs,
  type WorkspaceBackupDeltaPreview,
  type WorkspaceBackupLifecycle,
  type WorkspaceBackupPublicEntry,
  type SessionBackupPublicCheckpoint,
  SessionBackupManager,
} from "./sessionBackup";
import { summarizeSnapshotDelta } from "./sessionBackup/delta";
import { readMetadata, type SessionBackupMetadata } from "./sessionBackup/metadata";
import { snapshotByteSize } from "./sessionBackup/snapshot";

const METADATA_FILE = "metadata.json";

function isPathWithin(child: string, parent: string): boolean {
  const resolved = path.resolve(child);
  const resolvedParent = path.resolve(parent) + path.sep;
  return resolved.startsWith(resolvedParent) || resolved === path.resolve(parent);
}

type LiveWorkspaceBackupSession = {
  sessionId: string;
  title: string;
  provider: AgentConfig["provider"];
  model: string;
  updatedAt: string;
  status: SessionPersistenceStatus;
  busy: boolean;
  setBackupsEnabledOverride?: (enabled: boolean | null) => Promise<void>;
  reloadBackupStateFromDisk?: () => Promise<void>;
};

type WorkspaceBackupServiceOptions = {
  homedir?: string;
  sessionDb: SessionDb | null;
  getLiveSession: (sessionId: string) => LiveWorkspaceBackupSession | null;
};

type WorkspaceBackupLookup = {
  sessionDir: string;
  metadata: SessionBackupMetadata | null;
  failureReason?: string;
};

type WorkspaceBackupMetadataHint = {
  sessionId?: string;
  workingDirectory?: string;
  createdAt?: string;
  closedAt?: string;
  state?: "active" | "closed";
};

function maxIsoTimestamp(...values: Array<string | undefined>): string {
  const parsed = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? { value, ms } : null;
    })
    .filter((entry): entry is { value: string; ms: number } => !!entry);
  if (parsed.length === 0) return new Date(0).toISOString();
  parsed.sort((a, b) => b.ms - a.ms);
  return parsed[0].value;
}

function lifecycleFromState(
  sessionStatus: SessionPersistenceStatus | null,
): WorkspaceBackupLifecycle {
  if (sessionStatus === "active") return "active";
  if (sessionStatus === "closed") return "closed";
  return "deleted";
}

function tryExtractJsonString(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`));
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function tryExtractJsonEnum(raw: string, key: string, values: string[]): string | undefined {
  const value = tryExtractJsonString(raw, key);
  return value && values.includes(value) ? value : undefined;
}

async function readMetadataHint(metadataPath: string): Promise<WorkspaceBackupMetadataHint | null> {
  try {
    const raw = await fs.readFile(metadataPath, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      return {
        sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
        workingDirectory: typeof record.workingDirectory === "string" ? record.workingDirectory : undefined,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
        closedAt: typeof record.closedAt === "string" ? record.closedAt : undefined,
        state: record.state === "active" || record.state === "closed" ? record.state : undefined,
      };
    } catch {
      return {
        sessionId: tryExtractJsonString(raw, "sessionId"),
        workingDirectory: tryExtractJsonString(raw, "workingDirectory"),
        createdAt: tryExtractJsonString(raw, "createdAt"),
        closedAt: tryExtractJsonString(raw, "closedAt"),
        state: tryExtractJsonEnum(raw, "state", ["active", "closed"]) as "active" | "closed" | undefined,
      };
    }
  } catch {
    return null;
  }
}

export class WorkspaceBackupService {
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: WorkspaceBackupServiceOptions) {}

  private async withSessionLock<T>(targetSessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(targetSessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.sessionLocks.set(targetSessionId, next);
    try {
      return await next;
    } finally {
      if (this.sessionLocks.get(targetSessionId) === next) {
        this.sessionLocks.delete(targetSessionId);
      }
    }
  }

  async listWorkspaceBackups(workingDirectoryRaw: string): Promise<WorkspaceBackupPublicEntry[]> {
    const workingDirectory = path.resolve(workingDirectoryRaw);
    const entries: WorkspaceBackupPublicEntry[] = [];
    for (const rootDir of getSessionBackupsRootDirs({ homedir: this.opts.homedir })) {
      let rootEntries: Dirent[];
      try {
        rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : null;
        if (code === "ENOENT") continue;
        throw error;
      }

      for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(rootDir, String(entry.name));
        const backupEntry = await this.buildWorkspaceBackupEntry(sessionDir, workingDirectory);
        if (backupEntry) entries.push(backupEntry);
      }
    }

    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.targetSessionId.localeCompare(b.targetSessionId));
    return entries;
  }

  async createCheckpoint(workingDirectory: string, targetSessionId: string): Promise<WorkspaceBackupPublicEntry[]> {
    return this.withSessionLock(targetSessionId, async () => {
      const lookup = await this.findWorkspaceBackup(workingDirectory, targetSessionId);
      if (!lookup) throw new Error(`Unknown workspace backup: ${targetSessionId}`);
      if (!lookup.metadata) throw new Error(lookup.failureReason ?? `Workspace backup is unavailable: ${targetSessionId}`);
      await this.guardLiveSession(targetSessionId);

      const manager = await SessionBackupManager.openExisting({ sessionDir: lookup.sessionDir });
      await manager.createCheckpoint("manual");
      await this.syncLiveSession(targetSessionId);
      return await this.listWorkspaceBackups(workingDirectory);
    });
  }

  async restoreBackup(workingDirectory: string, targetSessionId: string, checkpointId?: string): Promise<WorkspaceBackupPublicEntry[]> {
    return this.withSessionLock(targetSessionId, async () => {
      const lookup = await this.findWorkspaceBackup(workingDirectory, targetSessionId);
      if (!lookup) throw new Error(`Unknown workspace backup: ${targetSessionId}`);
      if (!lookup.metadata) throw new Error(lookup.failureReason ?? `Workspace backup is unavailable: ${targetSessionId}`);
      await this.guardLiveSession(targetSessionId);

      const manager = await SessionBackupManager.openExisting({ sessionDir: lookup.sessionDir });

      // Validate checkpoint exists before creating safety checkpoint
      if (checkpointId) {
        const state = manager.getPublicState();
        const checkpointExists = state.checkpoints.some(cp => cp.id === checkpointId);
        if (!checkpointExists) {
          throw new Error(`Unknown checkpoint: ${checkpointId}`);
        }
      }

      await manager.createCheckpoint("manual");
      if (checkpointId) {
        await manager.restoreCheckpoint(checkpointId);
      } else {
        await manager.restoreOriginal();
      }
      await this.syncLiveSession(targetSessionId);
      return await this.listWorkspaceBackups(workingDirectory);
    });
  }

  async deleteCheckpoint(workingDirectory: string, targetSessionId: string, checkpointId: string): Promise<WorkspaceBackupPublicEntry[]> {
    return this.withSessionLock(targetSessionId, async () => {
      const lookup = await this.findWorkspaceBackup(workingDirectory, targetSessionId);
      if (!lookup) throw new Error(`Unknown workspace backup: ${targetSessionId}`);
      if (!lookup.metadata) throw new Error(lookup.failureReason ?? `Workspace backup is unavailable: ${targetSessionId}`);
      await this.guardLiveSession(targetSessionId);

      const manager = await SessionBackupManager.openExisting({ sessionDir: lookup.sessionDir });
      const removed = await manager.deleteCheckpoint(checkpointId);
      if (!removed) throw new Error(`Unknown checkpoint id: ${checkpointId}`);
      await this.syncLiveSession(targetSessionId);
      return await this.listWorkspaceBackups(workingDirectory);
    });
  }

  async deleteEntry(workingDirectory: string, targetSessionId: string): Promise<WorkspaceBackupPublicEntry[]> {
    return this.withSessionLock(targetSessionId, async () => {
      const lookup = await this.findWorkspaceBackup(workingDirectory, targetSessionId);
      if (!lookup) throw new Error(`Unknown workspace backup: ${targetSessionId}`);
      await this.guardLiveSession(targetSessionId);

      const liveSession = this.opts.getLiveSession(targetSessionId);
      if (liveSession) {
        if (!liveSession.setBackupsEnabledOverride) {
          throw new Error("Live session backup override is unavailable");
        }
        await liveSession.setBackupsEnabledOverride(false);
      }

      await fs.rm(lookup.sessionDir, { recursive: true, force: true });
      return await this.listWorkspaceBackups(workingDirectory);
    });
  }

  async getCheckpointDelta(
    workingDirectory: string,
    targetSessionId: string,
    checkpointId: string,
  ): Promise<WorkspaceBackupDeltaPreview> {
    const lookup = await this.findWorkspaceBackup(workingDirectory, targetSessionId);
    if (!lookup) throw new Error(`Unknown workspace backup: ${targetSessionId}`);
    if (!lookup.metadata) throw new Error(lookup.failureReason ?? `Workspace backup is unavailable: ${targetSessionId}`);

    const checkpointIndex = lookup.metadata.checkpoints.findIndex((checkpoint) => checkpoint.id === checkpointId);
    if (checkpointIndex < 0) {
      throw new Error(`Unknown checkpoint id: ${checkpointId}`);
    }

    const checkpoint = lookup.metadata.checkpoints[checkpointIndex];
    const baselineCheckpoint = checkpointIndex > 0 ? lookup.metadata.checkpoints[checkpointIndex - 1] : null;
    const baselineSnapshot = baselineCheckpoint?.snapshot ?? lookup.metadata.originalSnapshot;
    const baselineLabel = baselineCheckpoint?.id ?? "Original snapshot";

    if (
      checkpoint.snapshot.kind === baselineSnapshot.kind &&
      checkpoint.snapshot.path === baselineSnapshot.path
    ) {
      return {
        targetSessionId,
        checkpointId,
        baselineLabel,
        currentLabel: checkpoint.id,
        counts: { added: 0, modified: 0, deleted: 0 },
        files: [],
        truncated: false,
      };
    }

    const delta = await summarizeSnapshotDelta({
      sessionDir: lookup.sessionDir,
      baseline: baselineSnapshot,
      current: checkpoint.snapshot,
    });

    return {
      targetSessionId,
      checkpointId,
      baselineLabel,
      currentLabel: checkpoint.id,
      ...delta,
    };
  }

  private async buildWorkspaceBackupEntry(
    sessionDir: string,
    workingDirectory: string,
  ): Promise<WorkspaceBackupPublicEntry | null> {
    const metadataPath = path.join(sessionDir, METADATA_FILE);
    try {
      const metadata = await readMetadata(metadataPath);
      if (!metadata) return null;
      if (path.resolve(metadata.workingDirectory) !== workingDirectory) return null;
      return await this.buildReadyEntry(sessionDir, metadata);
    } catch (error) {
      const hint = await readMetadataHint(metadataPath);
      if (!hint?.workingDirectory || path.resolve(hint.workingDirectory) !== workingDirectory) {
        return null;
      }
      return await this.buildFailedEntry(sessionDir, error, hint);
    }
  }

  private async buildReadyEntry(
    sessionDir: string,
    metadata: SessionBackupMetadata,
  ): Promise<WorkspaceBackupPublicEntry> {
    const sessionRecord = this.opts.sessionDb?.getSessionRecord(metadata.sessionId) ?? null;
    const liveSession = this.opts.getLiveSession(metadata.sessionId);
    const lifecycle = lifecycleFromState(liveSession?.status ?? sessionRecord?.status ?? null);

    const originalSnapshotBytes = await snapshotByteSize(sessionDir, metadata.originalSnapshot);
    const checkpointBytesTotal = await this.sumCheckpointSnapshotBytes(
      sessionDir,
      metadata.originalSnapshot,
      metadata.checkpoints,
    );
    const updatedAt = maxIsoTimestamp(
      liveSession?.updatedAt,
      sessionRecord?.updatedAt,
      metadata.closedAt,
      metadata.checkpoints.at(-1)?.createdAt,
      metadata.createdAt,
    );

    return {
      targetSessionId: metadata.sessionId,
      title: liveSession?.title ?? sessionRecord?.title ?? null,
      provider: liveSession?.provider ?? sessionRecord?.provider ?? null,
      model: liveSession?.model ?? sessionRecord?.model ?? null,
      lifecycle,
      status: "ready",
      workingDirectory: metadata.workingDirectory,
      backupDirectory: sessionDir,
      originalSnapshotKind: metadata.originalSnapshot.kind,
      originalSnapshotBytes,
      checkpointBytesTotal,
      totalBytes: originalSnapshotBytes + checkpointBytesTotal,
      checkpoints: metadata.checkpoints.map(this.toPublicCheckpoint),
      createdAt: metadata.createdAt,
      updatedAt,
      ...(metadata.closedAt ? { closedAt: metadata.closedAt } : {}),
    };
  }

  private async buildFailedEntry(
    sessionDir: string,
    error: unknown,
    hint: WorkspaceBackupMetadataHint,
  ): Promise<WorkspaceBackupPublicEntry> {
    const targetSessionId = hint.sessionId ?? path.basename(sessionDir);
    const sessionRecord = this.opts.sessionDb?.getSessionRecord(targetSessionId) ?? null;
    const liveSession = this.opts.getLiveSession(targetSessionId);
    const stats = await fs.stat(sessionDir).catch(() => null);
    const createdAt = hint.createdAt
      ?? (stats?.birthtime ? stats.birthtime.toISOString() : stats?.mtime.toISOString())
      ?? new Date(0).toISOString();
    const updatedAt = maxIsoTimestamp(
      liveSession?.updatedAt,
      sessionRecord?.updatedAt,
      hint.closedAt,
      createdAt,
      stats?.mtime?.toISOString(),
    );

    return {
      targetSessionId,
      title: liveSession?.title ?? sessionRecord?.title ?? null,
      provider: liveSession?.provider ?? sessionRecord?.provider ?? null,
      model: liveSession?.model ?? sessionRecord?.model ?? null,
      lifecycle: lifecycleFromState(liveSession?.status ?? sessionRecord?.status ?? null),
      status: "failed",
      workingDirectory: hint.workingDirectory ?? "",
      backupDirectory: sessionDir,
      originalSnapshotKind: "pending",
      originalSnapshotBytes: null,
      checkpointBytesTotal: null,
      totalBytes: null,
      checkpoints: [],
      createdAt,
      updatedAt,
      ...(hint.closedAt ? { closedAt: hint.closedAt } : {}),
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }

  private async findWorkspaceBackup(
    workingDirectoryRaw: string,
    targetSessionId: string,
  ): Promise<WorkspaceBackupLookup | null> {
    const workingDirectory = path.resolve(workingDirectoryRaw);
    for (const rootDir of getSessionBackupsRootDirs({ homedir: this.opts.homedir })) {
      const sessionDir = path.join(rootDir, targetSessionId);
      if (!isPathWithin(sessionDir, rootDir)) continue;
      const metadataPath = path.join(sessionDir, METADATA_FILE);
      try {
        const metadata = await readMetadata(metadataPath);
        if (!metadata) continue;
        if (path.resolve(metadata.workingDirectory) !== workingDirectory) continue;
        return { sessionDir, metadata };
      } catch (error) {
        const hint = await readMetadataHint(metadataPath);
        if (!hint?.workingDirectory || path.resolve(hint.workingDirectory) !== workingDirectory) continue;
        return {
          sessionDir,
          metadata: null,
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return null;
  }

  private async sumCheckpointSnapshotBytes(
    sessionDir: string,
    originalSnapshot: SessionBackupMetadata["originalSnapshot"],
    checkpoints: SessionBackupMetadata["checkpoints"],
  ): Promise<number> {
    const seen = new Set<string>([
      `${originalSnapshot.kind}:${originalSnapshot.path}`,
    ]);
    let total = 0;
    for (const checkpoint of checkpoints) {
      const key = `${checkpoint.snapshot.kind}:${checkpoint.snapshot.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += await snapshotByteSize(sessionDir, checkpoint.snapshot);
    }
    return total;
  }

  private toPublicCheckpoint(checkpoint: SessionBackupMetadata["checkpoints"][number]): SessionBackupPublicCheckpoint {
    return {
      id: checkpoint.id,
      index: checkpoint.index,
      createdAt: checkpoint.createdAt,
      trigger: checkpoint.trigger,
      changed: checkpoint.changed,
      patchBytes: checkpoint.patchBytes,
    };
  }

  private async guardLiveSession(targetSessionId: string): Promise<void> {
    const liveSession = this.opts.getLiveSession(targetSessionId);
    if (liveSession?.busy) {
      throw new Error("Session is busy");
    }
  }

  private async syncLiveSession(targetSessionId: string): Promise<void> {
    const liveSession = this.opts.getLiveSession(targetSessionId);
    if (!liveSession?.reloadBackupStateFromDisk) return;
    await liveSession.reloadBackupStateFromDisk();
  }
}
