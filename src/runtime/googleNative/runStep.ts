import { normalizePiUsage } from "../piMessageBridge";
import type { PartialTurnError } from "../types";
import { buildGoogleNativeRequest } from "./buildRequest";
import { getGoogleInteractionsClient, resolveGoogleApiKey } from "./client";
import {
  isGoogleGeneratedResponseSizeLimitError,
  makeGoogleGeneratedResponseSizeLimitError,
} from "./errors";
import { googleTurnMessagesToModelMessages } from "./interactionsToModel";
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

function populateAssistantMessage(
  assistant: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
  usageData: Record<string, unknown> | undefined,
): AssistantContentBlock[] {
  const content = [...contentBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  assistant.content = content;
  if (!usageData) return content;

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
  return content;
}

function googleInteractionStatusError(status: string | undefined): Error {
  return status === "cancelled"
    ? new DOMException("Google Interactions request was aborted (cancelled).", "AbortError")
    : new Error(`Google Interactions request ended with status "${status ?? "unknown"}".`);
}

function isFailedInteractionStatus(status: string | undefined): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "incomplete" ||
    status === "budget_exceeded"
  );
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
  const openContentBlocks = new Set<number>();
  const providerToolCallsById = new Map<string, ProviderToolCallState>();
  const pendingAnnotationEnrichments: Array<Promise<void>> = [];
  let interactionId: string | undefined;
  let pendingEventDelivery = Promise.resolve();
  let usageData: Record<string, unknown> | undefined;
  let completion: { status?: string } | undefined;
  let failedStatus: string | undefined;

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
        completion = { status: asNonEmptyString(interaction?.status) };
        if (isFailedInteractionStatus(completion.status)) failedStatus = completion.status;
        continue;
      }

      if (eventType === "interaction.status_update") {
        interactionId = asNonEmptyString(eventRecord.interaction_id) ?? interactionId;
        const status = asNonEmptyString(eventRecord.status);
        if (isFailedInteractionStatus(status)) failedStatus = status;
        continue;
      }

      if (eventType === "error") {
        const error = eventRecord.error;
        const errorRecord =
          typeof error === "object" && error !== null && !Array.isArray(error)
            ? (error as Record<string, unknown>)
            : {};
        const message =
          asNonEmptyString(errorRecord.message) ??
          asNonEmptyString(errorRecord.code) ??
          "Google Interactions API error";
        if (isGoogleGeneratedResponseSizeLimitError(message)) {
          throw makeGoogleGeneratedResponseSizeLimitError();
        }
        throw new Error(message);
      }

      if (normalizedEvent.kind === "content") {
        processStreamEvent(eventRecord, contentBlocks, providerToolCallsById);
        const blockIndex = typeof eventRecord.index === "number" ? eventRecord.index : 0;
        if (eventType === "content.stop" || eventType === "step.stop") {
          openContentBlocks.delete(blockIndex);
          queueTextBlockAnnotationEnrichment(
            pendingAnnotationEnrichments,
            contentBlocks.get(blockIndex),
          );
        } else if (contentBlocks.has(blockIndex)) {
          openContentBlocks.add(blockIndex);
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

    opts.streamOptions.signal?.throwIfAborted();
    if (failedStatus) throw googleInteractionStatusError(failedStatus);
    if (!completion) {
      throw new Error("Google Interactions stream ended before interaction completion.");
    }
    if (completion.status !== "completed" && completion.status !== "requires_action") {
      throw googleInteractionStatusError(completion.status);
    }
    if (openContentBlocks.size > 0) {
      throw new Error("Google Interactions stream ended with unfinished content.");
    }

    // Determine stop reason
    const hasToolCalls = [...contentBlocks.values()].some((block) => block.type === "toolCall");
    if (completion.status === "requires_action" && !hasToolCalls) {
      throw new Error("Google Interactions requires_action response has no completed tool calls.");
    }
    assistant.stopReason = hasToolCalls ? "tool_calls" : "stop";
    populateAssistantMessage(assistant, contentBlocks, usageData);

    return { assistant, interactionId };
  } catch (error) {
    const normalizedError = isGoogleGeneratedResponseSizeLimitError(error)
      ? makeGoogleGeneratedResponseSizeLimitError()
      : error;
    await pendingEventDelivery.catch(() => undefined);
    await Promise.allSettled(pendingAnnotationEnrichments);
    const partialContent = populateAssistantMessage(assistant, contentBlocks, usageData);
    if (normalizedError && typeof normalizedError === "object") {
      try {
        const content = partialContent.filter(
          (block) =>
            block.type === "text" ||
            block.type === "thinking" ||
            block.type === "image" ||
            block.type === "audio" ||
            block.type === "video" ||
            block.type === "document",
        );
        Object.defineProperty(normalizedError, "responseMessages", {
          value:
            content.length > 0
              ? googleTurnMessagesToModelMessages([{ ...assistant, content }])
              : [],
          configurable: true,
          writable: true,
        });
        const usage = normalizePiUsage(assistant.usage);
        const partialError = normalizedError as PartialTurnError;
        partialError.usage = usage;
        if (usage) partialError.requestUsages = [usage];
      } catch {
        // Preserve the original failure if its error object is not writable.
      }
    }
    await emitEvent({
      type: "error",
      error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
    });
    throw normalizedError;
  }
};
