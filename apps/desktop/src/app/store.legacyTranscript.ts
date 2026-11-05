import { z } from "zod";
import type { FeedItem } from "./types";

/**
 * Decoding for transcript event shapes written by the retired TypeScript harness.
 *
 * Local transcripts saved before the Rust server persisted assistant replies as
 * `assistant_message` / `reasoning` events and streamed turns as
 * `model_stream_chunk` (normalized parts) plus `model_stream_raw` (provider-native
 * frames). The live protocol no longer emits any of these, so they are decoded
 * here — transcript-only — rather than re-added to the `SessionEvent` union.
 *
 * Replay is intentionally minimal: normalized text / reasoning deltas and tool
 * lifecycle parts are rebuilt into feed items, final `assistant_message` /
 * `reasoning` events are de-duplicated against what the stream already
 * produced, and raw provider frames (always mirrored by normalized chunks) are
 * ignored.
 */

/** Legacy event types that carry nothing worth showing when replayed. */
export const LEGACY_TRANSCRIPT_SILENT_TYPES: ReadonlySet<string> = new Set([
  "model_stream_raw",
  "reset_done",
  "interaction_resolved",
  "observability_status",
  "harness_context",
  "pong",
]);

const textPayloadSchema = z.object({ text: z.unknown().optional() }).passthrough();

const legacyPayloadSchema = z.discriminatedUnion("type", [
  textPayloadSchema.extend({ type: z.literal("assistant_message") }),
  textPayloadSchema.extend({
    type: z.literal("reasoning"),
    kind: z.enum(["reasoning", "summary"]).optional(),
  }),
  textPayloadSchema.extend({ type: z.literal("assistant_reasoning") }),
  textPayloadSchema.extend({ type: z.literal("reasoning_summary") }),
  z
    .object({
      type: z.literal("model_stream_chunk"),
      turnId: z.string().optional(),
      index: z.number().optional(),
      partType: z.string(),
      part: z.unknown().optional(),
    })
    .passthrough(),
]);

export type LegacyTranscriptPayload = z.infer<typeof legacyPayloadSchema>;

export function parseLegacyTranscriptPayload(payload: unknown): LegacyTranscriptPayload | null {
  const parsed = legacyPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

type ToolItem = Extract<FeedItem, { kind: "tool" }>;

/** Per-turn state for rebuilding streamed output from `model_stream_chunk` parts. */
export type LegacyStreamReplay = {
  turnId: string | null;
  /** Streamed assistant text per stream id, in arrival order. */
  assistantStreams: Map<string, StreamedText>;
  /** Streamed reasoning text per stream id, in arrival order. */
  reasoningStreams: Map<string, StreamedText>;
  toolItemIdByKey: Map<string, string>;
};

type StreamedText = { itemId: string; text: string };

export function createLegacyStreamReplay(): LegacyStreamReplay {
  return {
    turnId: null,
    assistantStreams: new Map(),
    reasoningStreams: new Map(),
    toolItemIdByKey: new Map(),
  };
}

export function resetLegacyStreamReplay(replay: LegacyStreamReplay): void {
  Object.assign(replay, createLegacyStreamReplay());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findItem<K extends FeedItem["kind"]>(
  out: FeedItem[],
  id: string | undefined,
  kind: K,
): Extract<FeedItem, { kind: K }> | undefined {
  if (!id) return undefined;
  const item = out.find((entry) => entry.id === id);
  return item?.kind === kind ? (item as Extract<FeedItem, { kind: K }>) : undefined;
}

function appendStreamText(
  out: FeedItem[],
  streams: Map<string, StreamedText>,
  streamId: string,
  delta: string,
  create: (id: string) => Extract<FeedItem, { kind: "message" | "reasoning" }>,
): void {
  const existing = streams.get(streamId);
  if (existing) {
    existing.text += delta;
    const item = out.find((entry) => entry.id === existing.itemId);
    if (item?.kind === "message" || item?.kind === "reasoning") item.text = existing.text;
    return;
  }
  const item = create(crypto.randomUUID());
  streams.set(streamId, { itemId: item.id, text: delta });
  out.push(item);
}

function upsertTool(
  out: FeedItem[],
  replay: LegacyStreamReplay,
  ts: string,
  key: string,
  name: string,
  patch: Partial<ToolItem>,
): void {
  const existing = findItem(out, replay.toolItemIdByKey.get(key), "tool");
  if (existing) {
    Object.assign(existing, patch);
    return;
  }
  const id = crypto.randomUUID();
  replay.toolItemIdByKey.set(key, id);
  out.push({ id, kind: "tool", ts, name, state: "input-available", ...patch });
}

/** Applies one legacy `model_stream_chunk` to the feed. */
export function applyLegacyModelStreamChunk(
  out: FeedItem[],
  replay: LegacyStreamReplay,
  ts: string,
  chunk: Extract<LegacyTranscriptPayload, { type: "model_stream_chunk" }>,
): void {
  const turnId = chunk.turnId ?? null;
  if (turnId !== replay.turnId) {
    resetLegacyStreamReplay(replay);
    replay.turnId = turnId;
  }

  const part = isRecord(chunk.part) ? chunk.part : {};
  const index = chunk.index ?? 0;
  const toolKey = () => asId(part.toolCallId) ?? asId(part.id) ?? `tool:${turnId}:${index}`;
  const toolName = () => asString(part.toolName) ?? "tool";

  switch (chunk.partType) {
    case "text_delta": {
      const text = asString(part.text);
      if (!text) return;
      const streamId = asId(part.id) ?? `text:${index}`;
      // Codex "commentary" phase text was surfaced as a reasoning summary.
      if (part.phase === "commentary") {
        appendStreamText(out, replay.reasoningStreams, `commentary:${streamId}`, text, (id) => ({
          id,
          kind: "reasoning",
          mode: "summary",
          ts,
          text,
        }));
        return;
      }
      appendStreamText(out, replay.assistantStreams, streamId, text, (id) => ({
        id,
        kind: "message",
        role: "assistant",
        ts,
        text,
      }));
      return;
    }
    case "reasoning_delta": {
      const text = asString(part.text);
      if (!text) return;
      const mode = part.mode === "summary" ? "summary" : "reasoning";
      appendStreamText(
        out,
        replay.reasoningStreams,
        asId(part.id) ?? `reasoning:${index}`,
        text,
        (id) => ({ id, kind: "reasoning", mode, ts, text }),
      );
      return;
    }
    case "tool_input_start":
      upsertTool(out, replay, ts, toolKey(), toolName(), { state: "input-streaming" });
      return;
    case "tool_call":
      upsertTool(out, replay, ts, toolKey(), toolName(), {
        state: "input-available",
        args: part.input,
      });
      return;
    case "tool_result":
      upsertTool(out, replay, ts, toolKey(), toolName(), {
        state: "output-available",
        result: part.output,
        completedAt: ts,
      });
      return;
    case "tool_error":
      upsertTool(out, replay, ts, toolKey(), toolName(), {
        state: "output-error",
        result: { error: part.error },
        completedAt: ts,
      });
      return;
    case "tool_output_denied":
      upsertTool(out, replay, ts, toolKey(), toolName(), {
        state: "output-denied",
        result: part.reason === undefined ? undefined : { reason: part.reason },
        completedAt: ts,
      });
      return;
    default:
      return;
  }
}

/** True when a final `assistant_message` repeats text the stream already rendered. */
export function legacyAssistantMessageAlreadyStreamed(
  replay: LegacyStreamReplay,
  text: string,
): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  const streamed = [...replay.assistantStreams.values()].map((entry) => entry.text);
  if (streamed.some((text) => normalizeText(text) === normalized)) return true;
  const aggregate = normalizeText(streamed.join(""));
  return aggregate.length > 0 && (aggregate === normalized || aggregate.startsWith(normalized));
}

/** True when a final reasoning event repeats text the stream already rendered. */
export function legacyReasoningAlreadyStreamed(replay: LegacyStreamReplay, text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  const streamed = [...replay.reasoningStreams.values()].map((entry) => entry.text);
  if (streamed.some((text) => normalizeText(text) === normalized)) return true;
  const aggregate = normalizeText(streamed.join("\n\n"));
  return aggregate.length > 0 && aggregate === normalized;
}

/**
 * Feed index where a final reasoning event belongs: before the turn's first
 * streamed assistant reply (reasoning precedes the answer), else the end.
 */
export function legacyReasoningInsertIndex(out: FeedItem[], replay: LegacyStreamReplay): number {
  const first = replay.assistantStreams.values().next().value;
  if (!first) return out.length;
  const index = out.findIndex((entry) => entry.id === first.itemId);
  return index >= 0 ? index : out.length;
}
