import type { ModelMessage } from "ai";
import fs from "node:fs/promises";
import path from "node:path";

import type { AiCoworkerPaths } from "../connect";
import { isProviderName } from "../types";
import type { AgentConfig, HarnessContextState, TodoItem } from "../types";
import type { SessionTitleSource } from "./sessionTitleService";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;

  const sessionId = asNonEmptyString(raw.sessionId);
  const createdAt = asNonEmptyString(raw.createdAt);
  const updatedAt = asNonEmptyString(raw.updatedAt);
  if (!sessionId || !createdAt || !updatedAt) return null;

  const sessionRaw = isRecord(raw.session) ? raw.session : null;
  const configRaw = isRecord(raw.config) ? raw.config : null;
  const contextRaw = isRecord(raw.context) ? raw.context : null;
  if (!sessionRaw || !configRaw || !contextRaw) return null;

  const title = asNonEmptyString(sessionRaw.title) ?? "New session";
  const titleSourceRaw = asNonEmptyString(sessionRaw.titleSource) ?? "default";
  const titleSource: SessionTitleSource =
    titleSourceRaw === "model" || titleSourceRaw === "heuristic" || titleSourceRaw === "manual" ? titleSourceRaw : "default";
  const titleModel = typeof sessionRaw.titleModel === "string" ? sessionRaw.titleModel : null;

  const providerRaw = asNonEmptyString(configRaw.provider);
  const provider = providerRaw && isProviderName(providerRaw) ? providerRaw : null;
  const model = asNonEmptyString(configRaw.model);
  const workingDirectory = asNonEmptyString(configRaw.workingDirectory);
  const outputDirectory = asNonEmptyString(configRaw.outputDirectory) ?? undefined;
  const uploadsDirectory = asNonEmptyString(configRaw.uploadsDirectory) ?? undefined;
  if (!provider || !model || !workingDirectory) return null;

  const enableMcp = typeof configRaw.enableMcp === "boolean" ? configRaw.enableMcp : false;
  const system = asNonEmptyString(contextRaw.system) ?? "";
  const messages = Array.isArray(contextRaw.messages) ? (contextRaw.messages as ModelMessage[]) : [];
  const todos = Array.isArray(contextRaw.todos) ? (contextRaw.todos as TodoItem[]) : [];
  const harnessContext = isRecord(contextRaw.harnessContext)
    ? (contextRaw.harnessContext as HarnessContextState)
    : null;

  return {
    version: 1,
    sessionId,
    createdAt,
    updatedAt,
    session: {
      title,
      titleSource,
      titleModel,
      provider,
      model,
    },
    config: {
      provider,
      model,
      enableMcp,
      workingDirectory,
      outputDirectory,
      uploadsDirectory,
    },
    context: {
      system,
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
