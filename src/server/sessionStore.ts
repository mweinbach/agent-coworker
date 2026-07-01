import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { AiCoworkerPaths } from "../connect";
import { sameWorkspacePath } from "../utils/workspacePath";
import {
  LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ,
  type PersistedSessionSnapshot,
  type PersistedSessionSummary,
  parsePersistedSessionSnapshot,
} from "./sessionStore/snapshots";

export type { PersistedSessionSnapshot, PersistedSessionSummary };
export { LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ, parsePersistedSessionSnapshot };

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

export function getPersistedSessionFilePath(
  paths: Pick<AiCoworkerPaths, "sessionsDir">,
  sessionId: string,
): string {
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

export async function readPersistedSessionSnapshot(opts: {
  paths: Pick<AiCoworkerPaths, "sessionsDir">;
  sessionId: string;
}): Promise<PersistedSessionSnapshot | null> {
  const filePath = getPersistedSessionFilePath(opts.paths, opts.sessionId);
  try {
    const raw = await Bun.file(filePath).text();
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
  paths: Pick<AiCoworkerPaths, "sessionsDir">,
  opts?: { workingDirectory?: string },
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
      raw = await Bun.file(filePath).text();
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

    const sessionKind =
      parsed.version === 3 ||
      parsed.version === 4 ||
      parsed.version === 5 ||
      parsed.version === 6 ||
      parsed.version === 7
        ? parsed.session.sessionKind
        : "root";
    if (sessionKind !== "root") continue;

    if (
      opts?.workingDirectory &&
      !sameWorkspacePath(parsed.config.workingDirectory, opts.workingDirectory)
    ) {
      continue;
    }

    summaries.push({
      sessionId: parsed.sessionId,
      title: parsed.session.title,
      titleSource: parsed.session.titleSource,
      titleModel: parsed.session.titleModel,
      provider: parsed.session.provider,
      model: parsed.session.model,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      messageCount: parsed.context.messages.length,
      lastEventSeq: LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
  }

  summaries.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return summaries;
}

export async function deletePersistedSessionSnapshot(
  paths: Pick<AiCoworkerPaths, "sessionsDir">,
  sessionId: string,
): Promise<void> {
  const filePath = getPersistedSessionFilePath(paths, sessionId);
  await fs.rm(filePath, { force: true });
}
