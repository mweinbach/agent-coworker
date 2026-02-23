import { z } from "zod";

import { parseStructuredToolInput } from "../../../../src/shared/structuredInput";

import type { FeedItem, TranscriptEvent } from "./types";
import { mapModelStreamChunk, type ModelStreamChunkEvent, type ModelStreamUpdate } from "./modelStream";

export type ThreadModelStreamRuntime = {
  assistantItemIdByTurn: Map<string, string>;
  assistantTextByTurn: Map<string, string>;
  reasoningItemIdByStream: Map<string, string>;
  reasoningTextByStream: Map<string, string>;
  reasoningTurns: Set<string>;
  toolItemIdByKey: Map<string, string>;
  toolInputByKey: Map<string, string>;
  lastAssistantTurnId: string | null;
  lastReasoningTurnId: string | null;
};

export type ThreadModelStreamFeedOps = {
  makeId: () => string;
  nowIso: () => string;
  pushFeedItem: (item: FeedItem) => void;
  updateFeedItem: (itemId: string, update: (item: FeedItem) => FeedItem) => void;
  onToolTerminal?: () => void;
};

export function createThreadModelStreamRuntime(): ThreadModelStreamRuntime {
  return {
    assistantItemIdByTurn: new Map(),
    assistantTextByTurn: new Map(),
    reasoningItemIdByStream: new Map(),
    reasoningTextByStream: new Map(),
    reasoningTurns: new Set(),
    toolItemIdByKey: new Map(),
    toolInputByKey: new Map(),
    lastAssistantTurnId: null,
    lastReasoningTurnId: null,
  };
}

export function clearThreadModelStreamRuntime(runtime: ThreadModelStreamRuntime) {
  runtime.assistantItemIdByTurn.clear();
  runtime.assistantTextByTurn.clear();
  runtime.reasoningItemIdByStream.clear();
  runtime.reasoningTextByStream.clear();
  runtime.reasoningTurns.clear();
  runtime.toolItemIdByKey.clear();
  runtime.toolInputByKey.clear();
  runtime.lastAssistantTurnId = null;
  runtime.lastReasoningTurnId = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewValue(value: unknown, maxChars = 160): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars - 1)}...` : value;
  }
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}...` : raw;
  } catch {
    const fallback = String(value);
    return fallback.length > maxChars ? `${fallback.slice(0, maxChars - 1)}...` : fallback;
  }
}

function normalizeToolArgsFromInput(inputText: string, existingArgs?: unknown): unknown {
  const parsed = parseStructuredToolInput(inputText);
  const base = isRecord(existingArgs) ? existingArgs : {};
  const { input: _discardInput, ...rest } = base;

  if (isRecord(parsed)) {
    return { ...rest, ...parsed };
  }

  if (Object.keys(rest).length > 0) {
    return { ...rest, input: inputText };
  }

  return { input: inputText };
}

export function shouldSuppressRawDebugLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^raw stream part:/i.test(trimmed)) return true;
  if (/response\.function_call_arguments\./i.test(trimmed)) return true;
  if (/response\.reasoning(?:_|\.|[a-z])/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"response\./i.test(trimmed)) return true;
  if (/\bobfuscation\b/i.test(trimmed)) return true;

  return false;
}

function modelStreamSystemLine(update: ModelStreamUpdate): string | null {
  if (update.kind === "turn_abort") {
    const reason = previewValue(update.reason);
    return reason ? `Turn aborted: ${reason}` : "Turn aborted";
  }

  if (update.kind === "turn_error") {
    const detail = previewValue(update.error);
    return detail ? `Stream error: ${detail}` : "Stream error";
  }

  if (update.kind === "reasoning_start") {
    return `Reasoning started (${update.mode})`;
  }

  if (update.kind === "reasoning_end") {
    return `Reasoning ended (${update.mode})`;
  }

  if (update.kind === "tool_approval_request") {
    const toolName = isRecord(update.toolCall) && typeof update.toolCall.toolName === "string"
      ? update.toolCall.toolName
      : "tool";
    return `Tool approval requested: ${toolName}`;
  }

  if (update.kind === "source") {
    const sourcePreview = previewValue(update.source);
    return sourcePreview ? `Source: ${sourcePreview}` : "Source";
  }

  if (update.kind === "file") {
    const filePreview = previewValue(update.file);
    return filePreview ? `File: ${filePreview}` : "File";
  }

  if (update.kind === "unknown") {
    const payloadPreview = previewValue(update.payload);
    return payloadPreview
      ? `Unhandled stream part (${update.partType}): ${payloadPreview}`
      : `Unhandled stream part (${update.partType})`;
  }

  return null;
}

function applyModelStreamUpdate(
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate,
  ops: ThreadModelStreamFeedOps
) {
  const push = (item: FeedItem) => {
    ops.pushFeedItem(item);
  };

  if (update.kind === "turn_start") {
    clearThreadModelStreamRuntime(stream);
    return;
  }

  if (
    update.kind === "turn_finish" ||
    update.kind === "step_start" ||
    update.kind === "step_finish" ||
    update.kind === "assistant_text_start" ||
    update.kind === "assistant_text_end"
  ) {
    // Keep these as state-only boundaries to avoid noisy transcript/feed reconstruction.
    return;
  }

  if (update.kind === "assistant_delta") {
    stream.lastAssistantTurnId = update.turnId;
    const itemId = stream.assistantItemIdByTurn.get(update.turnId);
    const nextText = `${stream.assistantTextByTurn.get(update.turnId) ?? ""}${update.text}`;
    stream.assistantTextByTurn.set(update.turnId, nextText);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "message" && item.role === "assistant" ? { ...item, text: nextText } : item
      );
    } else {
      const id = ops.makeId();
      stream.assistantItemIdByTurn.set(update.turnId, id);
      push({ id, kind: "message", role: "assistant", ts: ops.nowIso(), text: update.text });
    }
    return;
  }

  if (update.kind === "reasoning_delta") {
    stream.lastReasoningTurnId = update.turnId;
    stream.reasoningTurns.add(update.turnId);
    const key = `${update.turnId}:${update.streamId}`;
    const itemId = stream.reasoningItemIdByStream.get(key);
    const nextText = `${stream.reasoningTextByStream.get(key) ?? ""}${update.text}`;
    stream.reasoningTextByStream.set(key, nextText);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "reasoning" ? { ...item, mode: update.mode, text: nextText } : item
      );
    } else {
      const id = ops.makeId();
      stream.reasoningItemIdByStream.set(key, id);
      push({ id, kind: "reasoning", mode: update.mode, ts: ops.nowIso(), text: update.text });
    }
    return;
  }

  if (update.kind === "tool_input_start") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "tool" ? { ...item, name: update.name, status: "running", args: update.args ?? item.args } : item
      );
      return;
    }

    const id = ops.makeId();
    stream.toolItemIdByKey.set(key, id);
    push({ id, kind: "tool", ts: ops.nowIso(), name: update.name, status: "running", args: update.args });
    return;
  }

  if (update.kind === "tool_input_delta") {
    const key = `${update.turnId}:${update.key}`;
    const nextInput = `${stream.toolInputByKey.get(key) ?? ""}${update.delta}`;
    stream.toolInputByKey.set(key, nextInput);
    const itemId = stream.toolItemIdByKey.get(key);
    if (!itemId) {
      const id = ops.makeId();
      stream.toolItemIdByKey.set(key, id);
      push({
        id,
        kind: "tool",
        ts: ops.nowIso(),
        name: "tool",
        status: "running",
        args: normalizeToolArgsFromInput(nextInput),
      });
      return;
    }
    ops.updateFeedItem(itemId, (item) => {
      if (item.kind !== "tool") return item;
      return { ...item, args: normalizeToolArgsFromInput(nextInput, item.args) };
    });
    return;
  }

  if (update.kind === "tool_input_end") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    const nextInput = stream.toolInputByKey.get(key) ?? "";

    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "tool"
          ? {
              ...item,
              name: update.name,
              args: nextInput ? normalizeToolArgsFromInput(nextInput, item.args) : item.args,
            }
          : item
      );
      return;
    }

    if (!nextInput) return;
    const id = ops.makeId();
    stream.toolItemIdByKey.set(key, id);
    push({
      id,
      kind: "tool",
      ts: ops.nowIso(),
      name: update.name,
      status: "running",
      args: normalizeToolArgsFromInput(nextInput),
    });
    return;
  }

  if (update.kind === "tool_call") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, status: "running", args: update.args ?? item.args }
          : item
      );
      return;
    }

    const id = ops.makeId();
    stream.toolItemIdByKey.set(key, id);
    push({ id, kind: "tool", ts: ops.nowIso(), name: update.name, status: "running", args: update.args });
    return;
  }

  if (update.kind === "tool_result" || update.kind === "tool_error" || update.kind === "tool_output_denied") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    const result =
      update.kind === "tool_result"
        ? update.result
        : update.kind === "tool_error"
          ? { error: update.error }
          : { denied: true, reason: update.reason };

    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, status: "done", result }
          : item
      );
    } else {
      const id = ops.makeId();
      stream.toolItemIdByKey.set(key, id);
      push({ id, kind: "tool", ts: ops.nowIso(), name: update.name, status: "done", result });
    }

    ops.onToolTerminal?.();
    return;
  }

  const systemLine = modelStreamSystemLine(update);
  if (systemLine) {
    push({ id: ops.makeId(), kind: "system", ts: ops.nowIso(), line: systemLine });
  }
}

function appendModelStreamUpdateToFeed(
  out: FeedItem[],
  ts: string,
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate
) {
  applyModelStreamUpdate(stream, update, {
    makeId: () => crypto.randomUUID(),
    nowIso: () => ts,
    pushFeedItem: (item) => out.push(item),
    updateFeedItem: (itemId, updateItem) => {
      const idx = out.findIndex((item) => item.id === itemId);
      if (idx < 0) return;
      out[idx] = updateItem(out[idx]!);
    },
  });
}

const transcriptPayloadTypeSchema = z.object({
  type: z.string(),
}).passthrough();

const transcriptUserMessagePayloadSchema = z.object({
  type: z.literal("user_message"),
  text: z.unknown().optional(),
  clientMessageId: z.string().optional(),
}).passthrough();

const transcriptModelStreamPayloadSchema = z.object({
  type: z.literal("model_stream_chunk"),
}).passthrough();

const transcriptAssistantMessagePayloadSchema = z.object({
  type: z.literal("assistant_message"),
  text: z.unknown().optional(),
}).passthrough();

const transcriptReasoningPayloadSchema = z.object({
  type: z.literal("reasoning"),
  kind: z.enum(["reasoning", "summary"]).optional(),
  text: z.unknown().optional(),
}).passthrough();

const transcriptTodosPayloadSchema = z.object({
  type: z.literal("todos"),
  todos: z.unknown().optional(),
}).passthrough();

const transcriptLogPayloadSchema = z.object({
  type: z.literal("log"),
  line: z.unknown().optional(),
}).passthrough();

const transcriptErrorPayloadSchema = z.object({
  type: z.literal("error"),
  message: z.unknown().optional(),
  code: z.unknown().optional(),
  source: z.unknown().optional(),
}).passthrough();

const transcriptSessionBusyPayloadSchema = z.object({
  type: z.literal("session_busy"),
  busy: z.boolean().optional(),
}).passthrough();

const transcriptFeedPayloadSchema = z.discriminatedUnion("type", [
  transcriptUserMessagePayloadSchema,
  transcriptModelStreamPayloadSchema,
  transcriptAssistantMessagePayloadSchema,
  transcriptReasoningPayloadSchema,
  transcriptTodosPayloadSchema,
  transcriptLogPayloadSchema,
  transcriptErrorPayloadSchema,
  transcriptSessionBusyPayloadSchema,
]);

export function mapTranscriptToFeed(events: TranscriptEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const seenUser = new Set<string>();
  const stream = createThreadModelStreamRuntime();
  const makeId = () => crypto.randomUUID();

  for (const evt of events) {
    const parsedPayload = transcriptFeedPayloadSchema.safeParse(evt.payload);
    if (!parsedPayload.success) {
      const parsedTypeOnly = transcriptPayloadTypeSchema.safeParse(evt.payload);
      if (!parsedTypeOnly.success) continue;
      out.push({
        id: makeId(),
        kind: "system",
        ts: evt.ts,
        line: `[${parsedTypeOnly.data.type}]`,
      });
      continue;
    }

    const payload = parsedPayload.data;

    if (payload.type === "user_message") {
      clearThreadModelStreamRuntime(stream);
      const cmid = payload.clientMessageId ?? "";
      if (cmid && seenUser.has(cmid)) continue;
      if (cmid) seenUser.add(cmid);
      out.push({
        id: cmid || makeId(),
        kind: "message",
        role: "user",
        ts: evt.ts,
        text: String(payload.text ?? ""),
      });
      continue;
    }

    if (payload.type === "model_stream_chunk") {
      const mapped = mapModelStreamChunk(payload as ModelStreamChunkEvent);
      if (mapped) appendModelStreamUpdateToFeed(out, evt.ts, stream, mapped);
      continue;
    }

    if (payload.type === "assistant_message") {
      const text = String(payload.text ?? "");
      if (stream.lastAssistantTurnId) {
        const streamed = (stream.assistantTextByTurn.get(stream.lastAssistantTurnId) ?? "").trim();
        if (streamed && streamed === text.trim()) continue;
      }
      out.push({
        id: makeId(),
        kind: "message",
        role: "assistant",
        ts: evt.ts,
        text,
      });
      continue;
    }

    if (payload.type === "reasoning") {
      if (stream.lastReasoningTurnId && stream.reasoningTurns.has(stream.lastReasoningTurnId)) continue;
      out.push({
        id: makeId(),
        kind: "reasoning",
        mode: payload.kind === "summary" ? "summary" : "reasoning",
        ts: evt.ts,
        text: String(payload.text ?? ""),
      });
      continue;
    }

    if (payload.type === "todos") {
      out.push({
        id: makeId(),
        kind: "todos",
        ts: evt.ts,
        todos: Array.isArray(payload.todos) ? payload.todos : [],
      });
      continue;
    }

    if (payload.type === "log") {
      const line = String(payload.line ?? "");
      if (shouldSuppressRawDebugLogLine(line)) continue;
      out.push({ id: makeId(), kind: "log", ts: evt.ts, line });
      continue;
    }

    if (payload.type === "error") {
      out.push({
        id: makeId(),
        kind: "error",
        ts: evt.ts,
        message: String(payload.message ?? ""),
        code: String(payload.code ?? "internal_error") as any,
        source: String(payload.source ?? "session") as any,
      });
      continue;
    }

    if (payload.type === "session_busy") {
      if (payload.busy === false) {
        clearThreadModelStreamRuntime(stream);
      }
      out.push({
        id: makeId(),
        kind: "system",
        ts: evt.ts,
        line: `[${payload.type}]`,
      });
      continue;
    }
  }

  return out;
}

export function applyModelStreamUpdateToThreadFeed(
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate,
  ops: ThreadModelStreamFeedOps
) {
  applyModelStreamUpdate(stream, update, ops);
}

export function buildContextPreamble(feed: FeedItem[], maxPairs = 10): string {
  const pairs: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    if (item.kind !== "message") continue;
    pairs.push({ role: item.role, text: item.text });
    if (pairs.length >= maxPairs * 2) break;
  }
  pairs.reverse();

  if (pairs.length === 0) return "";

  const lines: string[] = ["Context (previous thread transcript):", ""];
  for (const p of pairs) {
    lines.push(`${p.role === "user" ? "User" : "Assistant"}: ${p.text}`);
    lines.push("");
  }
  lines.push("---", "");
  return lines.join("\n");
}
