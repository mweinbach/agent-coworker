import { reasoningModeForProvider } from "../server/modelStream";
import {
  createThinkTagStripState,
  flushThinkTagSplitState,
  splitThinkTaggedTextChunk,
  type ThinkTagStripState,
} from "../shared/thinkTags";
import type { ProviderName } from "../types";
import { normalizePiUsage } from "./piMessageBridge";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toolCallFromPartialLite(event: unknown): {
  toolCallId: string;
  toolName: string;
  input?: unknown;
} {
  const eventRecord = asRecord(event);
  const partial = asRecord(eventRecord?.partial);
  const contentIndex =
    typeof eventRecord?.contentIndex === "number" ? eventRecord.contentIndex : -1;
  const partialContent = Array.isArray(partial?.content) ? partial.content : [];
  const part = contentIndex >= 0 ? asRecord(partialContent[contentIndex]) : null;
  const fallbackId = contentIndex >= 0 ? `tool_call_${contentIndex}` : `tool_${Date.now()}`;
  const toolCallId =
    asNonEmptyString(part?.id) ??
    asNonEmptyString(asRecord(eventRecord?.toolCall)?.id) ??
    fallbackId;
  const toolName = asNonEmptyString(part?.name) ?? "tool";
  const input = part?.arguments ?? {};
  return { toolCallId, toolName, input };
}

export function mapPiEventToRawParts(
  event: unknown,
  provider: ProviderName,
  includeUnknown: boolean,
): unknown[] {
  const eventRecord = asRecord(event);
  const mode = reasoningModeForProvider(provider);
  const contentIndex = typeof eventRecord?.contentIndex === "number" ? eventRecord.contentIndex : 0;
  const streamId = `s${contentIndex}`;

  switch (eventRecord?.type) {
    case "start":
      return [{ type: "start" }];
    case "text_start":
      return [
        {
          type: "text-start",
          id: streamId,
          ...(typeof eventRecord.phase === "string" ? { phase: eventRecord.phase } : {}),
        },
      ];
    case "text_delta":
      return [
        {
          type: "text-delta",
          id: streamId,
          text: String(eventRecord.delta ?? ""),
          ...(typeof eventRecord.phase === "string" ? { phase: eventRecord.phase } : {}),
        },
      ];
    case "text_end":
      return [
        {
          type: "text-end",
          id: streamId,
          ...(Array.isArray(eventRecord.annotations)
            ? { annotations: eventRecord.annotations }
            : {}),
          ...(typeof eventRecord.phase === "string" ? { phase: eventRecord.phase } : {}),
        },
      ];
    case "thinking_start":
      return [{ type: "reasoning-start", id: streamId, mode }];
    case "thinking_delta":
      return [
        { type: "reasoning-delta", id: streamId, mode, text: String(eventRecord.delta ?? "") },
      ];
    case "thinking_end":
      return [{ type: "reasoning-end", id: streamId, mode }];
    case "toolcall_start": {
      const toolCall = toolCallFromPartialLite(event);
      return [
        {
          type: "tool-input-start",
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
      ];
    }
    case "toolcall_delta": {
      const toolCall = toolCallFromPartialLite(event);
      return [
        {
          type: "tool-input-delta",
          id: toolCall.toolCallId,
          delta: String(eventRecord.delta ?? ""),
        },
      ];
    }
    case "toolcall_end": {
      const toolCall = toolCallFromPartialLite(event);
      return [
        {
          type: "tool-input-end",
          id: toolCall.toolCallId,
        },
        {
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: asRecord(toolCall.input) ?? {},
        },
      ];
    }
    case "done": {
      const totalUsage = normalizePiUsage(asRecord(eventRecord.message)?.usage);
      return [
        {
          type: "finish",
          finishReason: eventRecord.reason,
          totalUsage,
        },
      ];
    }
    case "error":
      return [
        {
          type: "error",
          error:
            asNonEmptyString(asRecord(eventRecord.error)?.errorMessage) ??
            eventRecord.error ??
            "PI stream error",
        },
      ];
    default:
      if (!includeUnknown) return [];
      return [
        {
          type: "unknown",
          sdkType: String(eventRecord?.type ?? "unknown"),
          raw: event,
        },
      ];
  }
}

type ThinkTagStreamState = {
  stripState: ThinkTagStripState;
  reasoningStarted: boolean;
};

function thinkStreamId(textStreamId: string): string {
  return `${textStreamId}:think`;
}

function minimaxThinkTagRawPartNormalizer() {
  const streamStateById = new Map<string, ThinkTagStreamState>();

  const ensureState = (streamId: string): ThinkTagStreamState => {
    const existing = streamStateById.get(streamId);
    if (existing) return existing;
    const next = { stripState: createThinkTagStripState(), reasoningStarted: false };
    streamStateById.set(streamId, next);
    return next;
  };

  const appendThinking = (
    out: Array<Record<string, unknown>>,
    streamId: string,
    state: ThinkTagStreamState,
    text: string,
  ) => {
    if (!text) return;
    if (!state.reasoningStarted) {
      out.push({ type: "reasoning-start", id: thinkStreamId(streamId), mode: "reasoning" });
      state.reasoningStarted = true;
    }
    out.push({ type: "reasoning-delta", id: thinkStreamId(streamId), mode: "reasoning", text });
  };

  return (part: unknown): unknown[] => {
    const record = asRecord(part);
    if (!record) return [part];
    const type = asNonEmptyString(record.type);
    const streamId = asNonEmptyString(record.id);
    if (!type || !streamId) return [part];

    if (type === "text-delta") {
      const text = typeof record.text === "string" ? record.text : "";
      const state = ensureState(streamId);
      const split = splitThinkTaggedTextChunk(text, state.stripState);
      const out: Array<Record<string, unknown>> = [];
      appendThinking(out, streamId, state, split.thinkingText);
      if (split.visibleText) {
        out.push({ ...record, text: split.visibleText });
      }
      return out;
    }

    if (type === "text-end") {
      const state = streamStateById.get(streamId);
      if (!state) return [part];
      const split = flushThinkTagSplitState(state.stripState);
      const out: Array<Record<string, unknown>> = [];
      appendThinking(out, streamId, state, split.thinkingText);
      if (split.visibleText) {
        out.push({ type: "text-delta", id: streamId, text: split.visibleText });
      }
      if (state.reasoningStarted) {
        out.push({ type: "reasoning-end", id: thinkStreamId(streamId), mode: "reasoning" });
      }
      streamStateById.delete(streamId);
      out.push(part as Record<string, unknown>);
      return out;
    }

    return [part];
  };
}

export function createPiEventRawPartMapper(
  provider: ProviderName,
  includeUnknown: boolean,
): (event: unknown) => unknown[] {
  const normalizeRawPart =
    provider === "minimax" ? minimaxThinkTagRawPartNormalizer() : (part: unknown) => [part];

  return (event: unknown) =>
    mapPiEventToRawParts(event, provider, includeUnknown).flatMap((part) => normalizeRawPart(part));
}
