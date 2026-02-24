import { z } from "zod";
import { parseStructuredToolInput } from "../../../src/shared/structuredInput";
import type { ModelStreamChunkEvent, ModelStreamUpdate } from "./modelStream";
import { mapModelStreamChunk } from "./modelStream";
import type { ContextUsageSnapshot, FeedItem } from "./syncTypes";

type SyncModelStreamLifecycleOptions = {
  nextFeedId: () => string;
  appendFeedItem: (item: FeedItem) => void;
  updateFeedItem: (id: string, update: (item: FeedItem) => FeedItem) => void;
  setContextUsage: (usage: ContextUsageSnapshot) => void;
  clearPendingTools: () => void;
};

const recordSchema = z.record(z.string(), z.unknown());
const finiteNumberSchema = z.number().finite();
const usageValueSchema = z.number().finite().nullable().optional();
const usageSnapshotInputSchema = z.object({
  inputTokens: usageValueSchema,
  promptTokens: usageValueSchema,
  outputTokens: usageValueSchema,
  completionTokens: usageValueSchema,
  totalTokens: usageValueSchema,
}).passthrough();

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteNumberSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function extractUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  const usage = usageSnapshotInputSchema.safeParse(value);
  if (!usage.success) return null;

  const raw = usage.data as Record<string, unknown>;
  const inputTokens = firstFiniteNumber(raw.inputTokens, raw.promptTokens, raw.requestTokens, raw.input, raw.prompt);
  const outputTokens = firstFiniteNumber(raw.outputTokens, raw.completionTokens, raw.responseTokens, raw.output, raw.completion);
  let totalTokens = firstFiniteNumber(raw.totalTokens, raw.tokenCount, raw.total);

  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }

  return { inputTokens, outputTokens, totalTokens };
}

function normalizeToolArgsFromInput(inputText: string, existingArgs?: unknown): unknown {
  const parsedInput = parseStructuredToolInput(inputText);
  const base = asRecord(existingArgs) ?? {};
  const { input: _discardInput, ...rest } = base;

  const structuredInput = asRecord(parsedInput);
  if (structuredInput) {
    return { ...rest, ...structuredInput };
  }

  if (Object.keys(rest).length > 0) {
    return { ...rest, input: inputText };
  }

  return { input: inputText };
}

function modelStreamSystemLine(update: ModelStreamUpdate): string | null {
  if (update.kind === "turn_abort") {
    const reason = previewValue(update.reason);
    return reason ? `turn aborted: ${reason}` : "turn aborted";
  }

  if (update.kind === "turn_error") {
    const detail = previewValue(update.error);
    return detail ? `stream error: ${detail}` : "stream error";
  }

  if (update.kind === "reasoning_start") {
    return `reasoning started (${update.mode})`;
  }

  if (update.kind === "reasoning_end") {
    return `reasoning ended (${update.mode})`;
  }

  if (update.kind === "tool_approval_request") {
    const toolName = asRecord(update.toolCall)?.toolName;
    const name = typeof toolName === "string" ? toolName : "tool";
    return `tool approval requested: ${name}`;
  }

  if (update.kind === "source") {
    const sourcePreview = previewValue(update.source);
    return sourcePreview ? `source: ${sourcePreview}` : "source";
  }

  if (update.kind === "file") {
    const filePreview = previewValue(update.file);
    return filePreview ? `file: ${filePreview}` : "file";
  }

  if (update.kind === "unknown") {
    const payloadPreview = previewValue(update.payload);
    return payloadPreview
      ? `unhandled stream part (${update.partType}): ${payloadPreview}`
      : `unhandled stream part (${update.partType})`;
  }

  return null;
}

export function createSyncModelStreamLifecycle(options: SyncModelStreamLifecycleOptions) {
  const streamedAssistantItemIds = new Map<string, string>();
  const streamedAssistantText = new Map<string, string>();
  const streamedReasoningItemIds = new Map<string, string>();
  const streamedReasoningText = new Map<string, string>();
  const streamedToolItemIds = new Map<string, string>();
  const streamedToolInput = new Map<string, string>();
  let lastStreamedAssistantTurnId: string | null = null;
  let lastStreamedReasoningTurnId: string | null = null;
  let modelStreamTurnActive = false;

  function appendSystemLineFromModelStream(update: ModelStreamUpdate) {
    const line = modelStreamSystemLine(update);
    if (!line) return;
    options.appendFeedItem({ id: options.nextFeedId(), type: "system", line });
  }

  function reset() {
    streamedAssistantItemIds.clear();
    streamedAssistantText.clear();
    streamedReasoningItemIds.clear();
    streamedReasoningText.clear();
    streamedToolItemIds.clear();
    streamedToolInput.clear();
    lastStreamedAssistantTurnId = null;
    lastStreamedReasoningTurnId = null;
    modelStreamTurnActive = false;
  }

  function handleSessionBusy(busy: boolean) {
    if (busy) {
      modelStreamTurnActive = false;
      lastStreamedAssistantTurnId = null;
      lastStreamedReasoningTurnId = null;
      return;
    }
    reset();
  }

  function shouldSuppressAssistantMessage(text: string): boolean {
    if (!lastStreamedAssistantTurnId) return false;
    const streamed = (streamedAssistantText.get(lastStreamedAssistantTurnId) ?? "").trim();
    return Boolean(streamed) && streamed === text.trim();
  }

  function shouldSuppressReasoningMessage(): boolean {
    if (!lastStreamedReasoningTurnId) return false;
    const prefix = `${lastStreamedReasoningTurnId}:`;
    return Array.from(streamedReasoningText.keys()).some((key) => key.startsWith(prefix));
  }

  function isTurnActive(): boolean {
    return modelStreamTurnActive;
  }

  function handleChunkEvent(evt: ModelStreamChunkEvent) {
    const mapped = mapModelStreamChunk(evt);
    if (!mapped) return;

    if (mapped.kind === "turn_start") {
      reset();
      options.clearPendingTools();
      modelStreamTurnActive = true;
      return;
    }

    if (!modelStreamTurnActive) {
      options.clearPendingTools();
      modelStreamTurnActive = true;
    }

    if (mapped.kind === "turn_finish") {
      const usage = extractUsageSnapshot(mapped.totalUsage);
      if (usage) {
        options.setContextUsage(usage);
      }
      // Keep as a state-only boundary to avoid noisy feed output.
      return;
    }

    if (mapped.kind === "step_finish") {
      const usage = extractUsageSnapshot(mapped.usage);
      if (usage) {
        options.setContextUsage(usage);
      }
      return;
    }

    if (
      mapped.kind === "step_start" ||
      mapped.kind === "assistant_text_start" ||
      mapped.kind === "assistant_text_end"
    ) {
      // Keep these as state-only boundaries to avoid noisy feed output.
      return;
    }

    if (mapped.kind === "assistant_delta") {
      lastStreamedAssistantTurnId = mapped.turnId;
      const existingId = streamedAssistantItemIds.get(mapped.turnId);
      if (existingId) {
        const nextText = `${streamedAssistantText.get(mapped.turnId) ?? ""}${mapped.text}`;
        streamedAssistantText.set(mapped.turnId, nextText);
        options.updateFeedItem(existingId, (item) =>
          item.type === "message" && item.role === "assistant"
            ? { ...item, text: nextText }
            : item
        );
      } else {
        const id = options.nextFeedId();
        streamedAssistantItemIds.set(mapped.turnId, id);
        streamedAssistantText.set(mapped.turnId, mapped.text);
        options.appendFeedItem({ id, type: "message", role: "assistant", text: mapped.text });
      }
      return;
    }

    if (mapped.kind === "reasoning_start" || mapped.kind === "reasoning_end") {
      appendSystemLineFromModelStream(mapped);
      return;
    }

    if (mapped.kind === "reasoning_delta") {
      lastStreamedReasoningTurnId = mapped.turnId;
      const key = `${mapped.turnId}:${mapped.streamId}`;
      const existingId = streamedReasoningItemIds.get(key);
      if (existingId) {
        const nextText = `${streamedReasoningText.get(key) ?? ""}${mapped.text}`;
        streamedReasoningText.set(key, nextText);
        options.updateFeedItem(existingId, (item) =>
          item.type === "reasoning" ? { ...item, text: nextText, kind: mapped.mode } : item
        );
      } else {
        const id = options.nextFeedId();
        streamedReasoningItemIds.set(key, id);
        streamedReasoningText.set(key, mapped.text);
        options.appendFeedItem({ id, type: "reasoning", kind: mapped.mode, text: mapped.text });
      }
      return;
    }

    if (mapped.kind === "tool_approval_request") {
      appendSystemLineFromModelStream(mapped);
      return;
    }

    if (mapped.kind === "tool_input_start") {
      const key = `${mapped.turnId}:${mapped.key}`;
      const existingId = streamedToolItemIds.get(key);
      if (!existingId) {
        const id = options.nextFeedId();
        streamedToolItemIds.set(key, id);
        options.appendFeedItem({
          id,
          type: "tool",
          name: mapped.name,
          status: "running",
          args: mapped.args,
        });
      }
      return;
    }

    if (mapped.kind === "tool_input_delta") {
      const key = `${mapped.turnId}:${mapped.key}`;
      const existingId = streamedToolItemIds.get(key);
      const nextInput = `${streamedToolInput.get(key) ?? ""}${mapped.delta}`;
      streamedToolInput.set(key, nextInput);
      if (existingId) {
        options.updateFeedItem(existingId, (item) =>
          item.type === "tool" ? { ...item, args: normalizeToolArgsFromInput(nextInput, item.args) } : item
        );
      } else {
        const id = options.nextFeedId();
        streamedToolItemIds.set(key, id);
        options.appendFeedItem({
          id,
          type: "tool",
          name: "tool",
          status: "running",
          args: normalizeToolArgsFromInput(nextInput),
        });
      }
      return;
    }

    if (mapped.kind === "tool_input_end") {
      const key = `${mapped.turnId}:${mapped.key}`;
      const existingId = streamedToolItemIds.get(key);
      const nextInput = streamedToolInput.get(key) ?? "";
      if (existingId) {
        options.updateFeedItem(existingId, (item) =>
          item.type === "tool"
            ? {
                ...item,
                name: mapped.name,
                args: nextInput ? normalizeToolArgsFromInput(nextInput, item.args) : item.args,
              }
            : item
        );
      } else if (nextInput) {
        const id = options.nextFeedId();
        streamedToolItemIds.set(key, id);
        options.appendFeedItem({
          id,
          type: "tool",
          name: mapped.name,
          status: "running",
          args: normalizeToolArgsFromInput(nextInput),
        });
      }
      return;
    }

    if (mapped.kind === "tool_call") {
      const key = `${mapped.turnId}:${mapped.key}`;
      const existingId = streamedToolItemIds.get(key);
      if (existingId) {
        options.updateFeedItem(existingId, (item) =>
          item.type === "tool"
            ? { ...item, name: mapped.name, status: "running", args: mapped.args ?? item.args }
            : item
        );
      } else {
        const id = options.nextFeedId();
        streamedToolItemIds.set(key, id);
        options.appendFeedItem({
          id,
          type: "tool",
          name: mapped.name,
          status: "running",
          args: mapped.args,
        });
      }
      return;
    }

    if (mapped.kind === "tool_result" || mapped.kind === "tool_error" || mapped.kind === "tool_output_denied") {
      const key = `${mapped.turnId}:${mapped.key}`;
      const existingId = streamedToolItemIds.get(key);
      const result =
        mapped.kind === "tool_result"
          ? mapped.result
          : mapped.kind === "tool_error"
            ? { error: mapped.error }
            : { denied: true, reason: mapped.reason };

      if (existingId) {
        options.updateFeedItem(existingId, (item) =>
          item.type === "tool"
            ? { ...item, name: mapped.name, status: "done", result }
            : item
        );
      } else {
        const id = options.nextFeedId();
        streamedToolItemIds.set(key, id);
        options.appendFeedItem({
          id,
          type: "tool",
          name: mapped.name,
          status: "done",
          result,
        });
      }
      return;
    }

    appendSystemLineFromModelStream(mapped);
  }

  return {
    reset,
    handleSessionBusy,
    shouldSuppressAssistantMessage,
    shouldSuppressReasoningMessage,
    isTurnActive,
    handleChunkEvent,
  };
}

export type SyncModelStreamLifecycle = ReturnType<typeof createSyncModelStreamLifecycle>;
