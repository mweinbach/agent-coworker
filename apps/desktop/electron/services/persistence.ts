import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { app } from "electron";

import type {
  PersistedOnboardingState,
  PersistedState,
  ThreadRecord,
  TranscriptEvent,
  WorkspaceRecord,
  WorkspaceUserProfile,
} from "../../src/app/types";
import { normalizeWorkspaceUserProfile } from "../../src/app/types";
import { normalizeWorkspaceProviderOptions } from "../../src/app/openaiCompatibleProviderOptions";
import { normalizePersistedProviderState } from "../../src/app/persistedProviderState";
import { deriveDefaultLmStudioUiEnabled, normalizePersistedProviderUiState } from "../../src/app/providerUiState";
import type { TranscriptBatchInput } from "../../src/lib/desktopApi";
import {
  normalizeDesktopFeatureFlagOverrides,
  normalizeWorkspaceFeatureFlagOverrides,
  resolveWorkspaceFeatureFlags,
} from "../../../../src/shared/featureFlags";

import { assertDirection, assertSafeId, assertWithinTranscriptsDir } from "./validation";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

class AsyncLock {
  private pending: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;

    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function defaultState(): PersistedState {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    desktopFeatureFlagOverrides: {},
    providerUiState: normalizePersistedProviderUiState(undefined),
  };
}

function sanitizeOnboarding(value: unknown): PersistedOnboardingState | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  const normalizedStatus =
    status === "pending" || status === "dismissed" || status === "completed"
      ? status
      : "pending";
  const completedAt =
    typeof value.completedAt === "string" && value.completedAt.trim()
      ? value.completedAt.trim()
      : null;
  const dismissedAt =
    typeof value.dismissedAt === "string" && value.dismissedAt.trim()
      ? value.dismissedAt.trim()
      : null;
  return { status: normalizedStatus, completedAt, dismissedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asDefinedString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asSafeId(value: unknown): string | null {
  const candidate = asNonEmptyString(value);
  if (!candidate) {
    return null;
  }
  try {
    assertSafeId(candidate, "id");
    return candidate;
  } catch {
    return null;
  }
}

function asTimestamp(value: unknown): string | null {
  const candidate = asNonEmptyString(value);
  if (!candidate) {
    return null;
  }
  return Number.isNaN(Date.parse(candidate)) ? null : candidate;
}

function asOptionalString(value: unknown): string | undefined {
  const candidate = asNonEmptyString(value);
  return candidate ?? undefined;
}

function asLegacyPreferredChildModel(item: Record<string, unknown>): string | undefined {
  return asOptionalString(item.defaultSubAgentModel);
}

function asChildModelRoutingMode(value: unknown): WorkspaceRecord["defaultChildModelRoutingMode"] {
  return value === "same-provider" || value === "cross-provider-allowlist" ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => entry !== null);
}

function asNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function asOptionalNullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function asThreadStatus(value: unknown): ThreadRecord["status"] {
  return value === "active" || value === "disconnected" ? value : "disconnected";
}

function isPlaceholderThreadTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "new thread" || normalized === "new session" || normalized === "new conversation";
}

function asThreadTitleSource(value: unknown, fallbackTitle: string): ThreadRecord["titleSource"] {
  if (value === "default" || value === "model" || value === "heuristic" || value === "manual") {
    return value;
  }
  return isPlaceholderThreadTitle(fallbackTitle) ? "default" : "manual";
}

const transcriptEventSchema = z.object({
  ts: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  direction: z.enum(["server", "client"]),
  payload: z.unknown(),
}).passthrough();

async function resolveWorkspacePath(value: unknown): Promise<string | null> {
  const candidate = asNonEmptyString(value);
  if (!candidate) {
    return null;
  }

  const resolved = path.resolve(candidate);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return null;
    }
    return await fs.realpath(resolved);
  } catch {
    return null;
  }
}

async function sanitizeWorkspaces(value: unknown): Promise<WorkspaceRecord[]> {
  if (!Array.isArray(value)) {
    return [];
  }

  const workspaces: WorkspaceRecord[] = [];
  const seenWorkspaceIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const id = asSafeId(item.id);
    const name = asNonEmptyString(item.name);
    const createdAt = asTimestamp(item.createdAt);
    const lastOpenedAt = asTimestamp(item.lastOpenedAt);
    const workspacePath = await resolveWorkspacePath(item.path);
    if (!id || !name || !createdAt || !lastOpenedAt || !workspacePath || seenWorkspaceIds.has(id)) {
      continue;
    }

    const defaultFeatureFlags = resolveWorkspaceFeatureFlags(
      normalizeWorkspaceFeatureFlagOverrides(item.defaultFeatureFlags)
      ?? (typeof item.defaultEnableA2ui === "boolean" ? { a2ui: item.defaultEnableA2ui } : undefined),
    );

    workspaces.push({
      id,
      name,
      path: workspacePath,
      createdAt,
      lastOpenedAt,
      wsProtocol: "jsonrpc",
      defaultProvider: asOptionalString(item.defaultProvider) as WorkspaceRecord["defaultProvider"],
      defaultModel: asOptionalString(item.defaultModel),
      defaultPreferredChildModel: asOptionalString(item.defaultPreferredChildModel) ?? asLegacyPreferredChildModel(item),
      defaultChildModelRoutingMode: asChildModelRoutingMode(item.defaultChildModelRoutingMode),
      defaultPreferredChildModelRef: asOptionalString(item.defaultPreferredChildModelRef),
      defaultAllowedChildModelRefs: asOptionalStringArray(item.defaultAllowedChildModelRefs),
      defaultToolOutputOverflowChars: asOptionalNullableNonNegativeInteger(item.defaultToolOutputOverflowChars),
      defaultFeatureFlags,
      providerOptions: normalizeWorkspaceProviderOptions(item.providerOptions),
      userName: asDefinedString(item.userName),
      userProfile: isRecord(item.userProfile)
        ? normalizeWorkspaceUserProfile(item.userProfile as Partial<WorkspaceUserProfile>)
        : undefined,
      defaultEnableMcp: typeof item.defaultEnableMcp === "boolean" ? item.defaultEnableMcp : true,
      defaultEnableA2ui: defaultFeatureFlags.a2ui,
      defaultBackupsEnabled: typeof item.defaultBackupsEnabled === "boolean" ? item.defaultBackupsEnabled : true,
      yolo: typeof item.yolo === "boolean" ? item.yolo : false,
    });
    seenWorkspaceIds.add(id);
  }

  return workspaces;
}

function sanitizeThreads(value: unknown, workspaceIds: Set<string>): ThreadRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const threads: ThreadRecord[] = [];
  const seenThreadIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const id = asSafeId(item.id);
    const workspaceId = asSafeId(item.workspaceId);
    const title = asNonEmptyString(item.title);
    const createdAt = asTimestamp(item.createdAt);
    const lastMessageAt = asTimestamp(item.lastMessageAt);
    if (!id || !workspaceId || !title || !createdAt || !lastMessageAt || seenThreadIds.has(id)) {
      continue;
    }
    if (!workspaceIds.has(workspaceId)) {
      continue;
    }

    threads.push({
      id,
      workspaceId,
      title,
      titleSource: asThreadTitleSource(item.titleSource, title),
      createdAt,
      lastMessageAt,
      status: asThreadStatus(item.status),
      sessionId: asNonEmptyString(item.sessionId) ?? null,
      messageCount: asNonNegativeInteger(item.messageCount, 0),
      lastEventSeq: asNonNegativeInteger(item.lastEventSeq, 0),
      legacyTranscriptId: asNonEmptyString(item.legacyTranscriptId) ?? null,
    });
    seenThreadIds.add(id);
  }

  return threads;
}

async function sanitizePersistedState(value: unknown): Promise<PersistedState> {
  if (!isRecord(value)) {
    return defaultState();
  }

  const workspaces = await sanitizeWorkspaces(value.workspaces);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const threads = sanitizeThreads(value.threads, workspaceIds);
  const providerState = normalizePersistedProviderState(value.providerState);
  const providerUiState = normalizePersistedProviderUiState(value.providerUiState, {
    defaultLmStudioEnabled: deriveDefaultLmStudioUiEnabled({
      providerState,
      workspaces,
    }),
  });
  const parsedVersion =
    typeof value.version === "number" && Number.isFinite(value.version)
      ? Math.max(0, Math.floor(value.version))
      : 0;
  const onboarding = sanitizeOnboarding(value.onboarding);
  return {
    version: parsedVersion >= 2 ? parsedVersion : 2,
    workspaces,
    threads,
    developerMode: typeof value.developerMode === "boolean" ? value.developerMode : false,
    showHiddenFiles: typeof value.showHiddenFiles === "boolean" ? value.showHiddenFiles : false,
    perWorkspaceSettings: typeof value.perWorkspaceSettings === "boolean" ? value.perWorkspaceSettings : false,
    desktopFeatureFlagOverrides: normalizeDesktopFeatureFlagOverrides(value.desktopFeatureFlagOverrides),
    ...(providerState ? { providerState } : {}),
    providerUiState,
    ...(onboarding ? { onboarding } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class PersistenceService {
  private readonly stateLock = new AsyncLock();
  private storageReady: Promise<void> | null = null;

  private get appDataDir(): string {
    return app.getPath("userData");
  }

  private get legacyAppDataDir(): string {
    return path.join(app.getPath("appData"), "desktop");
  }

  private get stateFilePath(): string {
    return path.join(this.appDataDir, "state.json");
  }

  private get transcriptsDir(): string {
    return path.join(this.appDataDir, "transcripts");
  }

  private transcriptFilePath(threadId: string): string {
    assertSafeId(threadId, "threadId");
    const file = path.join(this.transcriptsDir, `${threadId}.jsonl`);
    assertWithinTranscriptsDir(this.transcriptsDir, file);
    return file;
  }

  private async ensureStorageReady(): Promise<void> {
    if (!this.storageReady) {
      this.storageReady = this.migrateLegacyUserDataIfNeeded();
    }
    await this.storageReady;
  }

  private async migrateLegacyUserDataIfNeeded(): Promise<void> {
    const currentDir = path.resolve(this.appDataDir);
    const legacyDir = path.resolve(this.legacyAppDataDir);
    if (currentDir === legacyDir) {
      return;
    }

    let legacyStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      legacyStat = await fs.stat(legacyDir);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw new Error(`Failed to inspect legacy desktop data: ${String(error)}`);
    }

    if (!legacyStat.isDirectory()) {
      return;
    }

    await fs.mkdir(currentDir, { recursive: true, mode: PRIVATE_DIR_MODE });

    const migrateEntry = async (name: string) => {
      const from = path.join(legacyDir, name);
      const to = path.join(currentDir, name);

      try {
        await fs.stat(from);
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }

      try {
        await fs.stat(to);
        return;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }

      try {
        await fs.rename(from, to);
        return;
      } catch {
        // Fall back to copy on cross-device or partially-created target failures.
      }

      const anyFs = fs as typeof fs & {
        cp?: (src: string, dest: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
      };

      if (typeof anyFs.cp === "function") {
        await anyFs.cp(from, to, { recursive: true, force: false });
      } else {
        await copyLegacyEntry(from, to);
      }
    };

    await migrateEntry("state.json");
    await migrateEntry("transcripts");
    await migrateEntry(path.join("logs", "server.log"));
  }

  async loadState(): Promise<PersistedState> {
    await this.ensureStorageReady();
    return await this.stateLock.run(async () => {
      try {
        const raw = await fs.readFile(this.stateFilePath, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return defaultState();
        }
        return await sanitizePersistedState(parsed);
      } catch (error) {
        if (isNotFound(error)) {
          return defaultState();
        }
        throw new Error(`Failed to load state: ${String(error)}`);
      }
    });
  }

  async saveState(state: PersistedState): Promise<void> {
    await this.ensureStorageReady();
    await this.stateLock.run(async () => {
      await fs.mkdir(this.appDataDir, { recursive: true, mode: PRIVATE_DIR_MODE });

      const sanitizedState = await sanitizePersistedState(state);
      const tempPath = `${this.stateFilePath}.tmp`;
      const payload = JSON.stringify({ ...sanitizedState, version: sanitizedState.version || 2 }, null, 2);

      await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      await fs.rename(tempPath, this.stateFilePath);
      await fs.chmod(this.stateFilePath, PRIVATE_FILE_MODE);
    });
  }

  async readTranscript(threadId: string): Promise<TranscriptEvent[]> {
    await this.ensureStorageReady();
    const filePath = this.transcriptFilePath(threadId);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw new Error(`Failed to read transcript: ${String(error)}`);
    }

    const events: TranscriptEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const parsedLine = transcriptEventSchema.safeParse(parsedJson);
      if (!parsedLine.success) {
        continue;
      }
      events.push(parsedLine.data as TranscriptEvent);
    }

    return events;
  }

  async appendTranscriptEvent(event: TranscriptBatchInput): Promise<void> {
    await this.appendTranscriptBatch([event]);
  }

  async appendTranscriptBatch(events: TranscriptBatchInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.ensureStorageReady();
    await fs.mkdir(this.transcriptsDir, { recursive: true, mode: PRIVATE_DIR_MODE });

    const grouped = new Map<string, TranscriptBatchInput[]>();
    for (const event of events) {
      assertSafeId(event.threadId, "threadId");
      const direction = assertDirection(event.direction);
      const normalized = { ...event, direction };

      const bucket = grouped.get(normalized.threadId);
      if (bucket) {
        bucket.push(normalized);
      } else {
        grouped.set(normalized.threadId, [normalized]);
      }
    }

    for (const [threadId, chunk] of grouped) {
      const filePath = this.transcriptFilePath(threadId);
      const payload = chunk.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await fs.appendFile(filePath, payload, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      await fs.chmod(filePath, PRIVATE_FILE_MODE);
    }
  }

  async deleteTranscript(threadId: string): Promise<void> {
    await this.ensureStorageReady();
    const filePath = this.transcriptFilePath(threadId);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw new Error(`Failed to delete transcript: ${String(error)}`);
    }
  }
}

async function copyLegacyEntry(from: string, to: string): Promise<void> {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true, mode: PRIVATE_DIR_MODE });
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      await copyLegacyEntry(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }

  await fs.mkdir(path.dirname(to), { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.copyFile(from, to);
}
