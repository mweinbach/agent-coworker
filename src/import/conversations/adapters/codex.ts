import { Database } from "bun:sqlite";
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
import { asNumber, asRecord, asString, pathExists, readJsonlRecords } from "./common";
import type { ConversationSourceAdapter } from "./types";

const CODEX_SOURCE = "codex" as const;

type CodexThreadRow = Record<string, unknown>;

function codexStatePath(homedir: string): string {
  return path.join(homedir, ".codex", "state_5.sqlite");
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

function resolveRolloutPath(row: CodexThreadRow, stateDbPath: string): string | null {
  const rolloutPath = asString(row.rollout_path);
  if (!rolloutPath) return null;
  if (path.isAbsolute(rolloutPath)) return rolloutPath;
  return path.resolve(path.dirname(stateDbPath), rolloutPath);
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

async function threadRowToConversation(
  row: CodexThreadRow,
  stateDbPath: string,
): Promise<ExternalConversation | null> {
  const sourceId = asString(row.id) ?? asString(row.thread_id);
  if (!sourceId) return null;
  const createdAt = rowTimestamp(row, "created_at_ms", "created_at", new Date(0).toISOString());
  const updatedAt = rowTimestamp(row, "updated_at_ms", "updated_at", createdAt);
  const rolloutPath = resolveRolloutPath(row, stateDbPath);
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
        : [codexStatePath(opts.homedir)];
    const candidates: ConversationSourceCandidate[] = [];
    for (const candidatePath of paths) {
      const available = await pathExists(candidatePath);
      candidates.push({
        source: CODEX_SOURCE,
        id: `codex:${candidatePath}`,
        path: candidatePath,
        available,
        ...(available
          ? { conversationCount: readThreadCount(candidatePath) }
          : { warning: "Codex state database was not found." }),
      });
    }
    return candidates;
  },

  async preview(
    candidate: ConversationSourceCandidate,
    opts: ConversationPreviewOptions,
  ): Promise<ExternalConversation[]> {
    if (!candidate.available) return [];
    let db: Database | null = null;
    try {
      db = new Database(candidate.path, { readonly: true, strict: false });
      const includeArchived = opts.includeArchived === true;
      const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 250)));
      const sql = includeArchived
        ? "SELECT * FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ?"
        : "SELECT * FROM threads WHERE archived = 0 ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ?";
      const rows = db.query(sql).all(limit) as CodexThreadRow[];
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
