import type { ModelStreamRawEvent, ModelStreamUpdate } from "./modelStream";
import { createModelStreamReplayRuntime, replayModelStreamRawEvent } from "./modelStreamReplay";
import { isFailedToolOutcome } from "./toolRetry";
import type { ToolCallMetadata, ToolRetryAttemptTracker } from "./toolRetryAttempts";

export type RawToolCallMetadata = ToolCallMetadata & {
  toolKey: string;
  toolName: string;
};

export type RawToolRetryTrackingResult = {
  metadata: RawToolCallMetadata[];
  toolKeys: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseCompleteArguments(value: unknown): unknown | undefined {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function openAiExactToolInput(
  runtime: ReturnType<typeof createModelStreamReplayRuntime>,
  event: ModelStreamRawEvent,
): { key: string; name: string; args: unknown } | null {
  if (event.format !== "openai-responses-v1") return null;
  const payload = asRecord(event.event);
  const eventType = asNonEmptyString(payload?.type);
  if (!payload || !eventType) return null;

  if (eventType === "response.function_call_arguments.done") {
    const block = runtime.projectorByTurn.get(event.turnId)?.currentBlock;
    if (block?.type !== "toolCall") return null;
    const args = parseCompleteArguments(payload.arguments);
    return args === undefined
      ? null
      : {
          key: block.id,
          name: block.name,
          args,
        };
  }

  const item = asRecord(payload.item);
  if (eventType === "response.output_item.done" && item?.type === "function_call") {
    const callId = asNonEmptyString(item.call_id);
    const itemId = asNonEmptyString(item.id);
    const name = asNonEmptyString(item.name);
    const args = parseCompleteArguments(item.arguments);
    if (!callId || !itemId || !name || args === undefined) return null;
    return {
      key: `${callId}|${itemId}`,
      name,
      args,
    };
  }

  if (eventType === "response.output_item.added" && item?.type === "web_search_call") {
    const key =
      asNonEmptyString(item.item_id) ?? asNonEmptyString(item.call_id) ?? asNonEmptyString(item.id);
    if (!key) return null;
    return {
      key,
      name: "nativeWebSearch",
      args: {
        action: asRecord(item.action) ?? {},
      },
    };
  }

  return null;
}

function googleExactToolInput(
  runtime: ReturnType<typeof createModelStreamReplayRuntime>,
  event: ModelStreamRawEvent,
): { key: string; name: string; args: unknown } | null {
  if (event.format !== "google-interactions-v1") return null;
  const payload = asRecord(event.event);
  const eventType = asNonEmptyString(payload?.event_type);
  if (!payload || (eventType !== "content.stop" && eventType !== "step.stop")) {
    return null;
  }
  const index = typeof payload.index === "number" ? payload.index : 0;
  const block = runtime.googleStateByTurn.get(event.turnId)?.contentBlocks.get(index);
  if (
    (block?.type !== "toolCall" && block?.type !== "providerToolCall") ||
    "__jsonDelta" in block.arguments
  ) {
    return null;
  }
  return {
    key: block.id,
    name: block.name,
    args: block.arguments,
  };
}

function exactToolInput(
  runtime: ReturnType<typeof createModelStreamReplayRuntime>,
  event: ModelStreamRawEvent,
): { key: string; name: string; args: unknown } | null {
  return openAiExactToolInput(runtime, event) ?? googleExactToolInput(runtime, event);
}

export function createRawToolRetryEventTracker(attempts: ToolRetryAttemptTracker): {
  track(event: ModelStreamRawEvent): RawToolRetryTrackingResult;
} {
  const replayRuntime = createModelStreamReplayRuntime();

  return {
    track(event) {
      const metadataByKey = new Map<string, RawToolCallMetadata>();
      const toolKeys = new Set<string>();
      const rememberMetadata = (
        key: string,
        name: string,
        metadata: ToolCallMetadata | null,
      ): void => {
        if (!metadata) return;
        metadataByKey.set(key, {
          toolKey: key,
          toolName: name,
          ...metadata,
        });
      };
      const trackUpdate = (update: ModelStreamUpdate): void => {
        switch (update.kind) {
          case "tool_input_start":
            toolKeys.add(update.key);
            attempts.start(update.key, update.name);
            return;
          case "tool_input_delta":
            toolKeys.add(update.key);
            attempts.appendInput(update.key, update.delta);
            return;
          case "tool_input_end":
            toolKeys.add(update.key);
            rememberMetadata(
              update.key,
              update.name,
              attempts.finalizeBuffered(update.key, update.name),
            );
            return;
          case "tool_call":
            toolKeys.add(update.key);
            rememberMetadata(
              update.key,
              update.name,
              attempts.finalize(update.key, update.name, update.args),
            );
            return;
          case "tool_result":
            toolKeys.add(update.key);
            attempts.complete(
              update.key,
              !isFailedToolOutcome(update.name, "output-available", update.result),
            );
            return;
          case "tool_error":
          case "tool_output_denied":
            toolKeys.add(update.key);
            attempts.complete(update.key, false);
            return;
          default:
            return;
        }
      };

      for (const update of replayModelStreamRawEvent(replayRuntime, event)) {
        trackUpdate(update);
      }

      const exact = exactToolInput(replayRuntime, event);
      if (exact) {
        toolKeys.add(exact.key);
        rememberMetadata(
          exact.key,
          exact.name,
          attempts.finalize(exact.key, exact.name, exact.args),
        );
      }

      return {
        metadata: [...metadataByKey.values()],
        toolKeys: [...toolKeys],
      };
    },
  };
}
