import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { app } from "electron";

import type {
  PersistedState,
  ThreadRecord,
  TranscriptEvent,
  WorkspaceRecord,
} from "../../src/app/types";
import type { TranscriptBatchInput } from "../../src/lib/desktopApi";

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
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function asNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

const safeIdSchema = z.preprocess((value) => asSafeId(value), z.string());
const timestampSchema = z.preprocess((value) => asTimestamp(value), z.string());
const nonEmptyStringSchema = z.preprocess((value) => asNonEmptyString(value), z.string());
const optionalStringSchema = z.preprocess((value) => asOptionalString(value), z.string().optional());

const workspaceRecordInputSchema = z.object({
  id: safeIdSchema,
  name: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  createdAt: timestampSchema,
  lastOpenedAt: timestampSchema,
  defaultProvider: optionalStringSchema,
  defaultModel: optionalStringSchema,
  defaultSubAgentModel: optionalStringSchema,
  defaultEnableMcp: z.boolean(),
  yolo: z.boolean(),
}).strict();

const threadRecordInputSchema = z.object({
  id: safeIdSchema,
  workspaceId: safeIdSchema,
  title: nonEmptyStringSchema,
  titleSource: z.enum(["default", "model", "heuristic", "manual"]),
  createdAt: timestampSchema,
  lastMessageAt: timestampSchema,
  status: z.enum(["active", "disconnected"]),
  sessionId: z.preprocess((value) => asNonEmptyString(value) ?? null, z.string().nullable()),
  lastEventSeq: z.preprocess((value) => asNonNegativeInteger(value, -1), z.number().int().min(0)),
}).strict();

const persistedStateInputSchema = z.object({
  version: z.number().int().min(2),
  workspaces: z.array(z.unknown()),
  threads: z.array(z.unknown()),
  developerMode: z.boolean(),
  showHiddenFiles: z.boolean(),
}).strict();

const transcriptEventSchema = z.object({
  ts: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  direction: z.enum(["server", "client"]),
  payload: z.unknown(),
}).strict();

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
  const parsedWorkspaces = z.array(workspaceRecordInputSchema).safeParse(value);
  if (!parsedWorkspaces.success) {
    throw new Error(`Invalid workspace state: ${parsedWorkspaces.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const workspaces: WorkspaceRecord[] = [];
  const seenWorkspaceIds = new Set<string>();
  for (const workspace of parsedWorkspaces.data) {
    const workspacePath = await resolveWorkspacePath(workspace.path);
    if (!workspacePath) {
      throw new Error(`Workspace path is missing or invalid: ${workspace.path}`);
    }
    if (seenWorkspaceIds.has(workspace.id)) {
      throw new Error(`Duplicate workspace id in persisted state: ${workspace.id}`);
    }

    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      path: workspacePath,
      createdAt: workspace.createdAt,
      lastOpenedAt: workspace.lastOpenedAt,
      defaultProvider: workspace.defaultProvider as WorkspaceRecord["defaultProvider"],
      defaultModel: workspace.defaultModel,
      defaultSubAgentModel: workspace.defaultSubAgentModel,
      defaultEnableMcp: workspace.defaultEnableMcp,
      yolo: workspace.yolo,
    });
    seenWorkspaceIds.add(workspace.id);
  }

  return workspaces;
}

function sanitizeThreads(value: unknown, workspaceIds: Set<string>): ThreadRecord[] {
  const parsedThreads = z.array(threadRecordInputSchema).safeParse(value);
  if (!parsedThreads.success) {
    throw new Error(`Invalid thread state: ${parsedThreads.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const threads: ThreadRecord[] = [];
  const seenThreadIds = new Set<string>();
  for (const thread of parsedThreads.data) {
    if (seenThreadIds.has(thread.id)) {
      throw new Error(`Duplicate thread id in persisted state: ${thread.id}`);
    }
    if (!workspaceIds.has(thread.workspaceId)) {
      throw new Error(`Thread references unknown workspace: ${thread.workspaceId}`);
    }

    threads.push({
      id: thread.id,
      workspaceId: thread.workspaceId,
      title: thread.title,
      titleSource: thread.titleSource,
      createdAt: thread.createdAt,
      lastMessageAt: thread.lastMessageAt,
      status: thread.status,
      sessionId: thread.sessionId,
      lastEventSeq: thread.lastEventSeq,
    });
    seenThreadIds.add(thread.id);
  }

  return threads;
}

async function sanitizePersistedState(value: unknown): Promise<PersistedState> {
  const parsedState = persistedStateInputSchema.safeParse(value);
  if (!parsedState.success) {
    throw new Error(`Invalid persisted state schema: ${parsedState.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const workspaces = await sanitizeWorkspaces(parsedState.data.workspaces);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const threads = sanitizeThreads(parsedState.data.threads, workspaceIds);
  const parsedVersion = parsedState.data.version;
  return {
    version: parsedVersion >= 2 ? parsedVersion : 2,
    workspaces,
    threads,
    developerMode: parsedState.data.developerMode,
    showHiddenFiles: parsedState.data.showHiddenFiles,
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class PersistenceService {
  private readonly stateLock = new AsyncLock();

  private get appDataDir(): string {
    return app.getPath("userData");
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

  async loadState(): Promise<PersistedState> {
    return await this.stateLock.run(async () => {
      try {
        const raw = await fs.readFile(this.stateFilePath, "utf8");
        return await sanitizePersistedState(JSON.parse(raw));
      } catch (error) {
        if (isNotFound(error)) {
          return defaultState();
        }
        throw new Error(`Failed to load state: ${String(error)}`);
      }
    });
  }

  async saveState(state: PersistedState): Promise<void> {
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
    for (const [idx, line] of raw.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsedLine = transcriptEventSchema.parse(JSON.parse(trimmed));
        events.push(parsedLine as TranscriptEvent);
      } catch (error) {
        throw new Error(`Failed to parse transcript line ${idx + 1}: ${String(error)}`);
      }
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
