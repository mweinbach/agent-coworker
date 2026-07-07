import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import {
  extractTextFromContent,
  makeExternalItemId,
  normalizeExternalConversation,
  normalizeIsoTimestamp,
  normalizeText,
} from "../normalize";
import type {
  ConversationDiscoverOptions,
  ConversationPreviewOptions,
  ConversationSourceCandidate,
  ExternalConversation,
  ExternalConversationItem,
} from "../types";
import {
  asNumber,
  asRecord,
  asString,
  listFilesRecursive,
  pathExists,
  readJsonlRecords,
  statSafe,
} from "./common";
import type { ConversationSourceAdapter } from "./types";

const CODEX_SOURCE = "codex" as const;

type CodexThreadRow = Record<string, unknown>;

function codexStatePath(homedir: string): string {
  return path.join(homedir, ".codex", "state_5.sqlite");
}

function codexSessionsPath(homedir: string): string {
  return path.join(homedir, ".codex", "sessions");
}

function codexArchivedSessionsPath(homedir: string): string {
  return path.join(homedir, ".codex", "archived_sessions");
}

function isSqlitePath(candidatePath: string): boolean {
  const name = path.basename(candidatePath).toLowerCase();
  return name.endsWith(".sqlite") || name.endsWith(".sqlite3") || name.endsWith(".db");
}

function readThreadCount(dbPath: string): number | undefined {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, strict: false });
    const row = db.query("SELECT COUNT(*) AS count FROM threads").get() as Record<
      string,
      unknown
    > | null;
    return typeof row?.count === "number" ? row.count : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

async function countCodexRollouts(candidatePath: string): Promise<number | undefined> {
  const stat = await statSafe(candidatePath);
  if (!stat) return undefined;
  if (stat.isFile()) return candidatePath.endsWith(".jsonl") ? 1 : 0;
  const files = await listFilesRecursive(candidatePath, (filePath) => filePath.endsWith(".jsonl"));
  return files.length;
}

function readTableColumns(db: Database, tableName: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function buildCodexThreadsQuery(db: Database, includeArchived: boolean): string {
  const columns = readTableColumns(db, "threads");
  const where = !includeArchived && columns.has("archived") ? "WHERE archived = 0" : "";
  const orderExpr = columns.has("updated_at_ms")
    ? "updated_at_ms"
    : columns.has("updated_at")
      ? "updated_at"
      : "rowid";
  return `SELECT * FROM threads ${where} ORDER BY ${orderExpr} DESC LIMIT ?`;
}

async function resolveRolloutPath(
  row: CodexThreadRow,
  stateDbPath: string,
): Promise<string | null> {
  const rolloutPath = asString(row.rollout_path);
  if (!rolloutPath) return null;
  if (path.isAbsolute(rolloutPath)) return rolloutPath;
  const codexRoot = path.dirname(stateDbPath);
  const candidates = [
    path.resolve(codexRoot, rolloutPath),
    path.resolve(codexRoot, "sessions", rolloutPath),
    path.resolve(codexRoot, "archived_sessions", rolloutPath),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[1] ?? candidates[0] ?? null;
}

function rowTimestamp(
  row: CodexThreadRow,
  msKey: string,
  secondsKey: string,
  fallback: string,
): string {
  return normalizeIsoTimestamp(
    asNumber(row[msKey]) ?? asNumber(row[secondsKey]) ?? fallback,
    fallback,
  );
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toolResultText(payload: Record<string, unknown>): unknown {
  if (payload.output !== undefined) return payload.output;
  if (payload.result !== undefined) return payload.result;
  if (payload.content !== undefined) return payload.content;
  return undefined;
}

function appendReasoningSummary(input: {
  payload: Record<string, unknown>;
  items: ExternalConversationItem[];
  warnings: ExternalConversation["warnings"];
  ts: string;
  sourceId: string;
}): void {
  const summary = input.payload.summary;
  const text = Array.isArray(summary)
    ? summary
        .map((part) => extractTextFromContent(part))
        .filter(Boolean)
        .join("\n")
    : extractTextFromContent(summary);
  if (text) {
    input.items.push({
      kind: "reasoning",
      id: makeExternalItemId({
        source: CODEX_SOURCE,
        sourceId: input.sourceId,
        index: input.items.length,
        kind: "reasoning",
        seed: text,
      }),
      ts: input.ts,
      mode: "summary",
      text,
    });
  }
  if (input.payload.encrypted_content || input.payload.content) {
    input.warnings.push({
      code: "reasoning_redacted",
      message:
        "Codex reasoning content was redacted; only visible reasoning summaries were imported.",
    });
  }
}

export async function parseCodexRollout(input: {
  rolloutPath: string;
  sourceId: string;
  fallbackCreatedAt: string;
  fallbackUpdatedAt: string;
}): Promise<Pick<ExternalConversation, "items" | "warnings" | "summary">> {
  const warnings: ExternalConversation["warnings"] = [];
  const records = await readJsonlRecords(input.rolloutPath, warnings);
  const items: ExternalConversationItem[] = [];
  const pendingToolIndexByCallId = new Map<string, number>();
  const seenUserMessages = new Set<string>();

  for (const record of records) {
    const ts = normalizeIsoTimestamp(record.timestamp, input.fallbackUpdatedAt);
    const type = asString(record.type);
    const payload = asRecord(record.payload);
    if (!payload) continue;

    if (type === "event_msg" && payload.type === "user_message") {
      const text = extractTextFromContent(payload.message);
      if (!text || seenUserMessages.has(text)) continue;
      seenUserMessages.add(text);
      items.push({
        kind: "user",
        id: makeExternalItemId({
          source: CODEX_SOURCE,
          sourceId: input.sourceId,
          index: items.length,
          kind: "user",
          seed: text,
        }),
        ts,
        text,
      });
      continue;
    }

    if (type !== "response_item") continue;
    const payloadType = asString(payload.type);
    if (payloadType === "message") {
      const role = asString(payload.role);
      if (role !== "assistant") continue;
      const text = extractTextFromContent(payload.content);
      if (!text) continue;
      items.push({
        kind: "assistant",
        id: makeExternalItemId({
          source: CODEX_SOURCE,
          sourceId: input.sourceId,
          index: items.length,
          kind: "assistant",
          seed: text,
        }),
        ts,
        text,
      });
      continue;
    }

    if (payloadType === "reasoning") {
      appendReasoningSummary({ payload, items, warnings, ts, sourceId: input.sourceId });
      continue;
    }

    if (payloadType === "function_call") {
      const name = normalizeText(asString(payload.name) ?? "tool") || "tool";
      const callId = asString(payload.call_id);
      const toolItem: ExternalConversationItem = {
        kind: "tool",
        id: makeExternalItemId({
          source: CODEX_SOURCE,
          sourceId: input.sourceId,
          index: items.length,
          kind: "tool",
          seed: payload,
        }),
        ts,
        name,
        ...(payload.arguments !== undefined ? { args: parseJsonMaybe(payload.arguments) } : {}),
      };
      items.push(toolItem);
      if (callId) pendingToolIndexByCallId.set(callId, items.length - 1);
      warnings.push({
        code: "tool_protocol_redacted",
        message:
          "Codex tool-call protocol identifiers were used only for pairing and were not imported as continuation state.",
      });
      continue;
    }

    if (payloadType === "function_call_output") {
      const callId = asString(payload.call_id);
      const result = toolResultText(payload);
      const index = callId ? pendingToolIndexByCallId.get(callId) : undefined;
      if (index !== undefined) {
        const existing = items[index];
        if (existing?.kind === "tool") {
          items[index] = { ...existing, result };
        }
      } else {
        items.push({
          kind: "tool",
          id: makeExternalItemId({
            source: CODEX_SOURCE,
            sourceId: input.sourceId,
            index: items.length,
            kind: "tool",
            seed: payload,
          }),
          ts,
          name: "tool",
          result,
        });
      }
    }
  }

  return { items, warnings, summary: null };
}

async function codexRolloutFileToConversation(filePath: string): Promise<ExternalConversation> {
  const sourceId = path.relative(path.dirname(filePath), filePath) || path.basename(filePath);
  const stat = await fs.stat(filePath).catch(() => null);
  const fallbackTs = (stat?.mtime ?? new Date(0)).toISOString();
  const parsed = await parseCodexRollout({
    rolloutPath: filePath,
    sourceId,
    fallbackCreatedAt: fallbackTs,
    fallbackUpdatedAt: fallbackTs,
  });
  const warnings = [
    ...parsed.warnings,
    {
      code: "missing_cwd" as const,
      message: "Codex rollout file did not include thread metadata with a working directory.",
    },
  ];
  const firstUser = parsed.items.find((item) => item.kind === "user");
  return normalizeExternalConversation({
    source: CODEX_SOURCE,
    sourceId,
    sourcePath: filePath,
    cwd: null,
    title: firstUser?.text ?? "Imported Codex chat",
    createdAt: fallbackTs,
    updatedAt: fallbackTs,
    originalProvider: "openai",
    originalModel: null,
    items: parsed.items,
    summary: parsed.summary,
    warnings,
  });
}

async function threadRowToConversation(
  row: CodexThreadRow,
  stateDbPath: string,
): Promise<ExternalConversation | null> {
  const sourceId = asString(row.id) ?? asString(row.thread_id);
  if (!sourceId) return null;
  const createdAt = rowTimestamp(row, "created_at_ms", "created_at", new Date(0).toISOString());
  const updatedAt = rowTimestamp(row, "updated_at_ms", "updated_at", createdAt);
  const rolloutPath = await resolveRolloutPath(row, stateDbPath);
  const parsed = rolloutPath
    ? await parseCodexRollout({
        rolloutPath,
        sourceId,
        fallbackCreatedAt: createdAt,
        fallbackUpdatedAt: updatedAt,
      })
    : {
        items: [],
        warnings: [
          {
            code: "parse_partial" as const,
            message: "Codex thread did not include a rollout path.",
          },
        ],
        summary: null,
      };
  const cwd = asString(row.cwd);
  const warnings = [...parsed.warnings];
  if (!cwd)
    warnings.push({
      code: "missing_cwd",
      message: "Codex thread did not include a working directory.",
    });
  const title =
    asString(row.title) ??
    asString(row.preview) ??
    asString(row.first_user_message) ??
    "Imported Codex chat";
  return normalizeExternalConversation({
    source: CODEX_SOURCE,
    sourceId,
    sourcePath: rolloutPath,
    cwd,
    title,
    createdAt,
    updatedAt,
    originalProvider: asString(row.model_provider) ?? "openai",
    originalModel: asString(row.model),
    items: parsed.items,
    summary: parsed.summary,
    warnings,
  });
}

export const codexConversationAdapter: ConversationSourceAdapter = {
  source: CODEX_SOURCE,

  async discover(opts: ConversationDiscoverOptions): Promise<ConversationSourceCandidate[]> {
    const paths =
      opts.explicitPaths && opts.explicitPaths.length > 0
        ? opts.explicitPaths
        : [
            codexStatePath(opts.homedir),
            codexSessionsPath(opts.homedir),
            codexArchivedSessionsPath(opts.homedir),
          ];
    const candidates: ConversationSourceCandidate[] = [];
    for (const candidatePath of paths) {
      const available = await pathExists(candidatePath);
      const conversationCount = available
        ? isSqlitePath(candidatePath)
          ? readThreadCount(candidatePath)
          : await countCodexRollouts(candidatePath)
        : undefined;
      candidates.push({
        source: CODEX_SOURCE,
        id: `codex:${candidatePath}`,
        path: candidatePath,
        available,
        ...(available
          ? { conversationCount }
          : { warning: "Codex conversation source was not found." }),
      });
    }
    return candidates;
  },

  async preview(
    candidate: ConversationSourceCandidate,
    opts: ConversationPreviewOptions,
  ): Promise<ExternalConversation[]> {
    if (!candidate.available) return [];
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 250)));
    if (!isSqlitePath(candidate.path)) {
      const stat = await statSafe(candidate.path);
      const files = stat?.isFile()
        ? [candidate.path]
        : await listFilesRecursive(candidate.path, (filePath) => filePath.endsWith(".jsonl"));
      const sorted = await Promise.all(
        files.map(async (filePath) => ({
          filePath,
          stat: await fs.stat(filePath).catch(() => null),
        })),
      );
      sorted.sort((left, right) => (right.stat?.mtimeMs ?? 0) - (left.stat?.mtimeMs ?? 0));
      return await Promise.all(
        sorted.slice(0, limit).map((entry) => codexRolloutFileToConversation(entry.filePath)),
      );
    }

    let db: Database | null = null;
    try {
      db = new Database(candidate.path, { readonly: true, strict: false });
      const includeArchived = opts.includeArchived === true;
      const rows = db
        .query(buildCodexThreadsQuery(db, includeArchived))
        .all(limit) as CodexThreadRow[];
      const conversations = await Promise.all(
        rows.map((row) => threadRowToConversation(row, candidate.path)),
      );
      return conversations.filter(
        (conversation): conversation is ExternalConversation => conversation !== null,
      );
    } catch {
      return [];
    } finally {
      db?.close();
    }
  },
};
