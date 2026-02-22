import type { ModelMessage } from "ai";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { AiCoworkerPaths } from "../connect";
import { isProviderName } from "../types";
import type { AgentConfig, HarnessContextState, TodoItem } from "../types";
import { isRecord } from "../utils/typeGuards";
import type { SessionTitleSource } from "./sessionTitleService";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

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

const persistedSessionSnapshotSchema = z.object({
  version: z.literal(1),
  sessionId: z.preprocess((value) => asNonEmptyString(value), z.string()),
  createdAt: z.preprocess((value) => asNonEmptyString(value), z.string()),
  updatedAt: z.preprocess((value) => asNonEmptyString(value), z.string()),
  session: z.object({
    title: z.preprocess((value) => asNonEmptyString(value) ?? undefined, z.string().default("New session")),
    titleSource: z.preprocess((value) => {
      const raw = asNonEmptyString(value);
      if (raw === "model" || raw === "heuristic" || raw === "manual") return raw;
      return "default";
    }, sessionTitleSourceSchema),
    titleModel: z.preprocess((value) => (typeof value === "string" ? value : null), z.string().nullable()),
  }).passthrough(),
  config: z.object({
    provider: z.preprocess((value) => {
      const raw = asNonEmptyString(value);
      return raw && isProviderName(raw) ? raw : undefined;
    }, z.string()),
    model: z.preprocess((value) => asNonEmptyString(value), z.string()),
    enableMcp: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
    workingDirectory: z.preprocess((value) => asNonEmptyString(value), z.string()),
    outputDirectory: z.preprocess((value) => asNonEmptyString(value) ?? undefined, z.string().optional()),
    uploadsDirectory: z.preprocess((value) => asNonEmptyString(value) ?? undefined, z.string().optional()),
  }).passthrough(),
  context: z.object({
    system: z.preprocess((value) => asNonEmptyString(value) ?? "", z.string()),
    messages: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(z.unknown())),
    todos: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(z.unknown())),
    harnessContext: z.preprocess(
      (value) => (isRecord(value) ? value : null),
      z.record(z.string(), z.unknown()).nullable(),
    ),
  }).passthrough(),
}).passthrough();

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

export function parsePersistedSessionSnapshot(raw: unknown): PersistedSessionSnapshot | null {
  const parsed = persistedSessionSnapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  const provider = snapshot.config.provider as AgentConfig["provider"];
  const model = snapshot.config.model;
  const workingDirectory = snapshot.config.workingDirectory;
  const titleSource = snapshot.session.titleSource as SessionTitleSource;
  const titleModel = snapshot.session.titleModel;
  const messages = snapshot.context.messages as ModelMessage[];
  const todos = snapshot.context.todos as TodoItem[];
  const harnessContext = snapshot.context.harnessContext as HarnessContextState | null;

  return {
    version: 1,
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    session: {
      title: snapshot.session.title,
      titleSource,
      titleModel,
      provider,
      model,
    },
    config: {
      provider,
      model,
      enableMcp: snapshot.config.enableMcp,
      workingDirectory,
      outputDirectory: snapshot.config.outputDirectory,
      uploadsDirectory: snapshot.config.uploadsDirectory,
    },
    context: {
      system: snapshot.context.system,
      messages,
      todos,
      harnessContext,
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
    const parsed = JSON.parse(raw);
    return parsePersistedSessionSnapshot(parsed);
  } catch {
    return null;
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
    try {
      const raw = await fs.readFile(path.join(paths.sessionsDir, entry), "utf-8");
      const parsed = parsePersistedSessionSnapshot(JSON.parse(raw));
      if (!parsed) continue;
      summaries.push({
        sessionId: parsed.sessionId,
        title: parsed.session.title,
        provider: parsed.session.provider,
        model: parsed.session.model,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        messageCount: parsed.context.messages.length,
      });
    } catch {
      // skip unreadable files
    }
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
