import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { AiCoworkerPaths } from "../connect";
import { PROVIDER_NAMES } from "../types";
import type { AgentConfig, HarnessContextState, ModelMessage, TodoItem } from "../types";
import type { SessionTitleSource } from "./sessionTitleService";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type PersistedSessionSnapshotV1 = {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
  };
};

export type PersistedSessionSnapshot = PersistedSessionSnapshotV1;

export type PersistedSessionSummary = {
  sessionId: string;
  title: string;
  provider: AgentConfig["provider"];
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

const sessionTitleSourceSchema = z.enum(["default", "model", "heuristic", "manual"]);
const providerNameSchema = z.enum(PROVIDER_NAMES);
const isoTimestampSchema = z.string().datetime({ offset: true });
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();
const modelMessageSchema = z.custom<ModelMessage>(
  (value) => typeof value === "object" && value !== null,
  "Invalid model message entry",
);
const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string(),
}).strict();
const harnessContextMetadataSchema = z.record(z.string(), z.string());
const harnessContextStateSchema = z.object({
  runId: z.string(),
  taskId: z.string().optional(),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  metadata: harnessContextMetadataSchema.optional(),
  updatedAt: isoTimestampSchema,
}).strict();

const persistedSessionSnapshotSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
  }).strict(),
}).strict();

export function getPersistedSessionFilePath(paths: Pick<AiCoworkerPaths, "sessionsDir">, sessionId: string): string {
  return path.join(paths.sessionsDir, `${sanitizeSessionId(sessionId)}.json`);
}

async function ensureSecureSessionsDir(sessionsDir: string): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(sessionsDir, PRIVATE_DIR_MODE);
  } catch {
    // best effort only
  }
}

export function parsePersistedSessionSnapshot(raw: unknown): PersistedSessionSnapshot {
  const parsed = persistedSessionSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid persisted session snapshot: ${parsed.error.issues[0]?.message ?? "validation_failed"}`
    );
  }

  const snapshot = parsed.data;
  return {
    version: 1,
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    session: {
      title: snapshot.session.title,
      titleSource: snapshot.session.titleSource,
      titleModel: snapshot.session.titleModel,
      provider: snapshot.session.provider,
      model: snapshot.session.model,
    },
    config: {
      provider: snapshot.config.provider,
      model: snapshot.config.model,
      enableMcp: snapshot.config.enableMcp,
      workingDirectory: snapshot.config.workingDirectory,
      outputDirectory: snapshot.config.outputDirectory,
      uploadsDirectory: snapshot.config.uploadsDirectory,
    },
    context: {
      system: snapshot.context.system,
      messages: snapshot.context.messages,
      todos: snapshot.context.todos,
      harnessContext: snapshot.context.harnessContext,
    },
  };
}

export async function readPersistedSessionSnapshot(opts: {
  paths: Pick<AiCoworkerPaths, "sessionsDir">;
  sessionId: string;
}): Promise<PersistedSessionSnapshot | null> {
  const filePath = getPersistedSessionFilePath(opts.paths, opts.sessionId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in persisted session snapshot ${filePath}: ${String(error)}`);
    }
    return parsePersistedSessionSnapshot(parsedJson);
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return null;
    if (error instanceof Error) throw error;
    throw new Error(`Failed to read persisted session snapshot ${filePath}: ${String(error)}`);
  }
}

export async function writePersistedSessionSnapshot(opts: {
  paths: Pick<AiCoworkerPaths, "sessionsDir">;
  snapshot: PersistedSessionSnapshot;
}): Promise<string> {
  await ensureSecureSessionsDir(opts.paths.sessionsDir);

  const filePath = getPersistedSessionFilePath(opts.paths, opts.snapshot.sessionId);
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(toJsonSafe(opts.snapshot), null, 2)}\n`;

  await fs.writeFile(tempPath, payload, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  try {
    await fs.chmod(tempPath, PRIVATE_FILE_MODE);
  } catch {
    // best effort only
  }

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch {
    // best effort only
  }

  return filePath;
}

export async function listPersistedSessionSnapshots(
  paths: Pick<AiCoworkerPaths, "sessionsDir">
): Promise<PersistedSessionSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.sessionsDir);
  } catch {
    return [];
  }

  const summaries: PersistedSessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(paths.sessionsDir, entry);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      const parsedCode = errorWithCodeSchema.safeParse(error);
      const code = parsedCode.success ? parsedCode.data.code : undefined;
      if (code === "ENOENT") continue;
      throw error;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue;
    }

    let parsed: PersistedSessionSnapshot;
    try {
      parsed = parsePersistedSessionSnapshot(parsedJson);
    } catch {
      continue;
    }

    summaries.push({
      sessionId: parsed.sessionId,
      title: parsed.session.title,
      provider: parsed.session.provider,
      model: parsed.session.model,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      messageCount: parsed.context.messages.length,
    });
  }

  summaries.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return summaries;
}

export async function deletePersistedSessionSnapshot(
  paths: Pick<AiCoworkerPaths, "sessionsDir">,
  sessionId: string
): Promise<void> {
  const filePath = getPersistedSessionFilePath(paths, sessionId);
  await fs.rm(filePath, { force: true });
}
