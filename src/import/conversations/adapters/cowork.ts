import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import { type SessionFeedItem, sessionSnapshotSchema } from "../../../shared/sessionSnapshot";
import {
  extractTextFromContent,
  makeExternalItemId,
  normalizeExternalConversation,
  normalizeIsoTimestamp,
} from "../normalize";
import type {
  ConversationDiscoverOptions,
  ConversationPreviewOptions,
  ConversationSourceCandidate,
  ExternalConversation,
  ExternalConversationItem,
} from "../types";
import { asRecord, asString, pathExists } from "./common";
import type { ConversationSourceAdapter } from "./types";

const COWORK_SOURCE = "cowork" as const;

type CoworkRow = Record<string, unknown>;

async function resolveCoworkDbPath(inputPath: string): Promise<string> {
  const stat = await fs.stat(inputPath).catch(() => null);
  if (stat?.isDirectory()) return path.join(inputPath, "sessions.db");
  return inputPath;
}

async function sameFilePath(
  left: string | null | undefined,
  right: string | null | undefined,
): Promise<boolean> {
  if (!left || !right) return false;
  try {
    const [leftReal, rightReal] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
    return leftReal === rightReal;
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function feedToExternalItems(
  feed: SessionFeedItem[],
  sourceId: string,
): ExternalConversationItem[] {
  const items: ExternalConversationItem[] = [];
  for (const item of feed) {
    if (item.kind === "message") {
      items.push({
        kind: item.role,
        id: makeExternalItemId({
          source: COWORK_SOURCE,
          sourceId,
          index: items.length,
          kind: item.role,
          seed: item.id,
        }),
        ts: item.ts,
        text: item.text,
      });
      continue;
    }
    if (item.kind === "tool") {
      items.push({
        kind: "tool",
        id: makeExternalItemId({
          source: COWORK_SOURCE,
          sourceId,
          index: items.length,
          kind: "tool",
          seed: item.id,
        }),
        ts: item.ts,
        name: item.name,
        ...(item.args !== undefined ? { args: item.args } : {}),
        ...(item.state === "output-error" || item.state === "output-denied"
          ? { error: extractTextFromContent(item.result) || String(item.result ?? item.state) }
          : item.result !== undefined
            ? { result: item.result }
            : {}),
      });
      continue;
    }
    if (item.kind === "reasoning") {
      items.push({
        kind: "reasoning",
        id: makeExternalItemId({
          source: COWORK_SOURCE,
          sourceId,
          index: items.length,
          kind: "reasoning",
          seed: item.id,
        }),
        ts: item.ts,
        mode: "summary",
        text: item.text,
      });
      continue;
    }
    if (item.kind === "system" || item.kind === "log") {
      items.push({
        kind: "system",
        id: makeExternalItemId({
          source: COWORK_SOURCE,
          sourceId,
          index: items.length,
          kind: "system",
          seed: item.id,
        }),
        ts: item.ts,
        text: item.kind === "system" ? item.line : item.line,
      });
    }
  }
  return items;
}

function messagesToExternalItems(
  messages: unknown,
  sourceId: string,
  fallbackTs: string,
): ExternalConversationItem[] {
  if (!Array.isArray(messages)) return [];
  const items: ExternalConversationItem[] = [];
  for (const [index, message] of messages.entries()) {
    const record = asRecord(message);
    if (!record) continue;
    const role = asString(record.role);
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextFromContent(record.content);
    if (!text) continue;
    items.push({
      kind: role,
      id: makeExternalItemId({ source: COWORK_SOURCE, sourceId, index, kind: role, seed: text }),
      ts: fallbackTs,
      text,
    });
  }
  return items;
}

function rowToConversation(row: CoworkRow, dbPath: string): ExternalConversation | null {
  const sourceId = asString(row.session_id);
  if (!sourceId) return null;
  const createdAt = normalizeIsoTimestamp(row.created_at, new Date(0).toISOString());
  const updatedAt = normalizeIsoTimestamp(row.updated_at, createdAt);
  const snapshotRaw = parseJson(row.snapshot_json);
  const snapshotParsed = sessionSnapshotSchema.safeParse(snapshotRaw);
  const items = snapshotParsed.success
    ? feedToExternalItems(snapshotParsed.data.feed, sourceId)
    : messagesToExternalItems(parseJson(row.messages_json), sourceId, updatedAt);
  const warnings: ExternalConversation["warnings"] = [];
  const cwd = asString(row.working_directory);
  if (!cwd)
    warnings.push({
      code: "missing_cwd",
      message: "Cowork session did not include a working directory.",
    });
  return normalizeExternalConversation({
    source: COWORK_SOURCE,
    sourceId,
    sourcePath: dbPath,
    cwd,
    title:
      asString(row.title) ??
      (snapshotParsed.success ? snapshotParsed.data.title : "Imported Cowork chat"),
    createdAt,
    updatedAt,
    originalProvider: asString(row.provider),
    originalModel: asString(row.model),
    items,
    summary: null,
    warnings,
  });
}

function countCoworkSessions(dbPath: string): number | undefined {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, strict: false });
    const row = db
      .query("SELECT COUNT(*) AS count FROM sessions WHERE COALESCE(session_kind, 'root') = 'root'")
      .get() as Record<string, unknown> | null;
    return typeof row?.count === "number" ? row.count : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export const coworkConversationAdapter: ConversationSourceAdapter = {
  source: COWORK_SOURCE,

  async discover(opts: ConversationDiscoverOptions): Promise<ConversationSourceCandidate[]> {
    const paths = opts.explicitPaths ?? [];
    const candidates: ConversationSourceCandidate[] = [];
    for (const inputPath of paths) {
      const dbPath = await resolveCoworkDbPath(inputPath);
      const available = await pathExists(dbPath);
      const isCurrent = await sameFilePath(dbPath, opts.currentCoworkDbPath);
      candidates.push({
        source: COWORK_SOURCE,
        id: `cowork:${dbPath}`,
        path: dbPath,
        available: available && !isCurrent,
        ...(available && !isCurrent ? { conversationCount: countCoworkSessions(dbPath) } : {}),
        ...(!available
          ? { warning: "Cowork sessions database was not found." }
          : isCurrent
            ? { warning: "The current Cowork sessions database cannot be imported into itself." }
            : {}),
      });
    }
    return candidates;
  },

  async preview(
    candidate: ConversationSourceCandidate,
    opts: ConversationPreviewOptions,
  ): Promise<ExternalConversation[]> {
    if (!candidate.available) return [];
    if (await sameFilePath(candidate.path, opts.currentCoworkDbPath)) return [];
    let db: Database | null = null;
    try {
      db = new Database(candidate.path, { readonly: true, strict: false });
      const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 250)));
      const rows = db
        .query(
          [
            "SELECT s.*, st.messages_json, snap.snapshot_json",
            "FROM sessions s",
            "JOIN session_state st ON st.session_id = s.session_id",
            "LEFT JOIN session_snapshots snap ON snap.session_id = s.session_id",
            "WHERE COALESCE(s.session_kind, 'root') = 'root'",
            "ORDER BY s.updated_at DESC",
            "LIMIT ?",
          ].join("\n"),
        )
        .all(limit) as CoworkRow[];
      return rows
        .map((row) => rowToConversation(row, candidate.path))
        .filter((conversation): conversation is ExternalConversation => conversation !== null);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  },
};
