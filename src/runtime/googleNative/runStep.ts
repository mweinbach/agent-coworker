import { buildGoogleNativeRequest } from "./buildRequest";
import { getGoogleInteractionsClient, resolveGoogleApiKey } from "./client";
import {
  isGoogleGeneratedResponseSizeLimitError,
  makeGoogleGeneratedResponseSizeLimitError,
} from "./errors";
import { asNonEmptyString, usageNumber } from "./messageToInput";
import {
  googleStreamEventContentType,
  isGoogleCodeExecutionContentType,
  queueTextBlockAnnotationEnrichment,
} from "./nativeTools";
import { mapGoogleEventToStreamParts } from "./stream/mapToStreamParts";
import { normalizeGoogleStreamEvent } from "./stream/normalize";
import { processStreamEvent } from "./stream/processEvent";
import type { AssistantContentBlock, ProviderToolCallState } from "./stream/types";
import type {
  GoogleNativeStepRequest,
  GoogleNativeStepResult,
  RunGoogleNativeInteractionStep,
} from "./types";

function queueEventDelivery(
  pendingEventDelivery: Promise<void>,
  emitEvent: (event: Record<string, unknown>) => Promise<void>,
  event: Record<string, unknown>,
): Promise<void> {
  return pendingEventDelivery.then(() => emitEvent(event));
}

export const runGoogleNativeInteractionStep: RunGoogleNativeInteractionStep = async (
  opts: GoogleNativeStepRequest,
): Promise<GoogleNativeStepResult> => {
  const apiKey = resolveGoogleApiKey(opts.apiKey);
  const client = getGoogleInteractionsClient(apiKey);

  const request = buildGoogleNativeRequest(opts);

  // Create streaming interaction
  const stream = await client.create(
    request,
    opts.streamOptions.signal ? { signal: opts.streamOptions.signal } : undefined,
  );

  const contentBlocks = new Map<number, AssistantContentBlock>();
  const providerToolCallsById = new Map<string, ProviderToolCallState>();
  const pendingAnnotationEnrichments: Array<Promise<void>> = [];
  let interactionId: string | undefined;
  let pendingEventDelivery = Promise.resolve();
  let usageData: Record<string, unknown> | undefined;

  const assistant: Record<string, unknown> = {
    role: "assistant",
    api: "google-interactions",
    provider: "google",
    model: opts.model.id,
    content: [],
    timestamp: Date.now(),
  };

  const emitEvent = async (event: Record<string, unknown>) => {
    await opts.onEvent?.(event);
  };

  const emitRawEvent = async (event: Record<string, unknown>) => {
    await opts.onRawEvent?.(event);
  };

  try {
    for await (const event of stream) {
      const eventRecord = event as unknown as Record<string, unknown>;
      const normalizedEvent = normalizeGoogleStreamEvent(eventRecord);
      const eventType = normalizedEvent.eventType;

      // Emit raw event for observability and replay.
      pendingEventDelivery = pendingEventDelivery.then(() => emitRawEvent(eventRecord));

      if (isGoogleCodeExecutionContentType(googleStreamEventContentType(eventRecord))) {
        throw new Error(
          "Google native code execution is disabled. Use the harness bash tool for code execution.",
        );
      }

      if (eventType === "interaction.start" || eventType === "interaction.created") {
        const interaction = eventRecord.interaction as Record<string, unknown> | undefined;
        interactionId =
          asNonEmptyString(interaction?.id) ??
          asNonEmptyString(eventRecord.interaction_id) ??
          interactionId;
        continue;
      }

      if (eventType === "interaction.complete" || eventType === "interaction.completed") {
        const interaction = eventRecord.interaction as Record<string, unknown> | undefined;
        interactionId =
          asNonEmptyString(interaction?.id) ??
          asNonEmptyString(eventRecord.interaction_id) ??
          interactionId;
        usageData = interaction?.usage as Record<string, unknown> | undefined;
        continue;
      }

      if (eventType === "interaction.status_update") {
        interactionId = asNonEmptyString(eventRecord.interaction_id) ?? interactionId;
        continue;
      }

      if (eventType === "error") {
        const error = (eventRecord.error as Record<string, unknown>) ?? {};
        const message =
          (error.message as string) ?? (error.code as string) ?? "Google Interactions API error";
        if (isGoogleGeneratedResponseSizeLimitError(message)) {
          throw makeGoogleGeneratedResponseSizeLimitError();
        }
        throw new Error(message);
      }

      if (normalizedEvent.kind === "content") {
        processStreamEvent(eventRecord, contentBlocks, providerToolCallsById);
        if (eventType === "content.stop" || eventType === "step.stop") {
          const blockIndex = typeof eventRecord.index === "number" ? eventRecord.index : 0;
          queueTextBlockAnnotationEnrichment(
            pendingAnnotationEnrichments,
            contentBlocks.get(blockIndex),
          );
        }
        for (const part of mapGoogleEventToStreamParts(
          eventRecord,
          contentBlocks,
          providerToolCallsById,
        )) {
          pendingEventDelivery = queueEventDelivery(pendingEventDelivery, emitEvent, part);
        }
        continue;
      }

      if (normalizedEvent.kind === "unknown") {
        pendingEventDelivery = queueEventDelivery(pendingEventDelivery, emitEvent, {
          type: "unknown",
          provider: "google",
          eventType,
          event: eventRecord,
        });
      }
    }

    // Stream parts (including text-end) are emitted before citation fetches finish; see
    // test "queueTextBlockAnnotationEnrichment keeps slow citation fetches off the text-end hot path".
    // We still wait for enrichment before assembling assistant.content so follow-up Google steps
    // receive resolved citation URLs/titles in history.
    await Promise.all([pendingEventDelivery, Promise.all(pendingAnnotationEnrichments)]);

    if (opts.streamOptions.signal?.aborted) {
      throw new Error("Request was aborted");
    }

    // Build assistant content from collected blocks
    const contentArray: AssistantContentBlock[] = [];
    const sortedIndices = [...contentBlocks.keys()].sort((a, b) => a - b);
    for (const index of sortedIndices) {
      const block = contentBlocks.get(index);
      if (!block) continue;
      contentArray.push(block);
    }
    assistant.content = contentArray;

    // Determine stop reason
    const hasToolCalls = contentArray.some((b) => b.type === "toolCall");
    assistant.stopReason = hasToolCalls ? "tool_calls" : "stop";

    // Map usage
    if (usageData) {
      const cacheRead = usageNumber(usageData, [
        "total_cached_tokens",
        "totalCachedTokens",
        "cached_tokens",
        "cachedTokens",
        "cached_content_token_count",
        "cachedContentTokenCount",
        "cache_read_tokens",
        "cacheReadTokens",
      ]);
      const cacheWrite = usageNumber(usageData, [
        "total_cache_write_tokens",
        "totalCacheWriteTokens",
        "cache_write_tokens",
        "cacheWriteTokens",
        "cache_creation_tokens",
        "cacheCreationTokens",
      ]);
      const reasoningOutputTokens = usageNumber(usageData, [
        "total_thought_tokens",
        "totalThoughtTokens",
        "thought_tokens",
        "thoughtTokens",
        "thoughts_token_count",
        "thoughtsTokenCount",
        "thinking_tokens",
        "thinkingTokens",
        "reasoning_output_tokens",
        "reasoningOutputTokens",
      ]);

      assistant.usage = {
        input:
          usageNumber(usageData, [
            "total_input_tokens",
            "totalInputTokens",
            "input_tokens",
            "inputTokens",
            "prompt_token_count",
            "promptTokenCount",
          ]) ?? 0,
        output:
          usageNumber(usageData, [
            "total_output_tokens",
            "totalOutputTokens",
            "output_tokens",
            "outputTokens",
            "candidates_token_count",
            "candidatesTokenCount",
          ]) ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
        ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
        totalTokens:
          usageNumber(usageData, [
            "total_tokens",
            "totalTokens",
            "total_token_count",
            "totalTokenCount",
          ]) ?? 0,
      };
    }

    return { assistant, interactionId };
  } catch (error) {
    const normalizedError = isGoogleGeneratedResponseSizeLimitError(error)
      ? makeGoogleGeneratedResponseSizeLimitError()
      : error;
    await pendingEventDelivery.catch(() => undefined);
    await Promise.allSettled(pendingAnnotationEnrichments);
    await emitEvent({
      type: "error",
      error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
    });
    throw normalizedError;
  }
};
