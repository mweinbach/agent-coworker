import {
  buildInvalidToolCallFormatReminderMessage,
  buildStepState,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  messagesAfterLastAssistant,
  parseTelemetrySettings,
  shouldAddInvalidToolCallFormatReminder,
  splitStepOverrides,
  startModelCallSpan,
  toolMapToPiTools,
} from "./piRuntime";
import { resolveGoogleInteractionsModel } from "./googleInteractionsModel";
import { asNonEmptyString, asRecord, asString, extractToolCallsFromAssistant } from "./piRuntimeOptions";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
import {
  googleTurnMessagesToModelMessages,
  runGoogleNativeInteractionStep,
  type RunGoogleNativeInteractionStep,
} from "./googleNativeInteractions";
import { normalizeGoogleThinkingLevelForModel } from "../shared/googleThinking";
import { getGoogleNativeWebSearchFromProviderOptions } from "../shared/openaiCompatibleOptions";
import { isGoogleContinuationState, type GoogleContinuationState } from "../shared/providerContinuation";

import type { ModelMessage } from "../types";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeStepOverride } from "./types";

type RuntimeStepOverrides = RuntimeStepOverride;

type GoogleInteractionsRuntimeOverrides = {
  runStepImpl?: RunGoogleNativeInteractionStep;
};

function matchingGoogleProviderState(
  params: RuntimeRunTurnParams,
  modelId: string,
): GoogleContinuationState | null {
  const providerState = params.providerState;
  if (!isGoogleContinuationState(providerState)) {
    return null;
  }
  return providerState.model === modelId ? providerState : null;
}

function nextGoogleProviderState(
  modelId: string,
  interactionId?: string,
): GoogleContinuationState | undefined {
  const nextInteractionId = interactionId?.trim();
  if (!nextInteractionId) return undefined;

  return {
    provider: "google",
    model: modelId,
    interactionId: nextInteractionId,
    updatedAt: new Date().toISOString(),
  };
}

function buildGoogleStreamOptions(
  modelId: string,
  providerOptions: Record<string, unknown> | undefined,
  abortSignal: AbortSignal | undefined,
  apiKey?: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (apiKey) options.apiKey = apiKey;
  if (abortSignal) options.signal = abortSignal;

  const googleSection = asRecord(providerOptions?.google) ?? asRecord(providerOptions?.vertex) ?? {};

  const thinkingConfig = asRecord(googleSection.thinkingConfig);
  if (thinkingConfig) {
    const includeThoughts = thinkingConfig.includeThoughts !== false;
    const level = normalizeGoogleThinkingLevelForModel(modelId, asNonEmptyString(thinkingConfig.thinkingLevel));
    if (level) options.thinkingLevel = level;
    options.thinkingSummaries = includeThoughts ? "auto" : "none";
    const budget = typeof thinkingConfig.thinkingBudget === "number"
      ? thinkingConfig.thinkingBudget
      : undefined;
    if (budget !== undefined) options.thinkingBudget = budget;
  }

  const temperature = typeof googleSection.temperature === "number"
    ? googleSection.temperature
    : undefined;
  if (temperature !== undefined) options.temperature = temperature;

  const toolChoice = asNonEmptyString(googleSection.toolChoice);
  if (toolChoice) options.toolChoice = toolChoice;

  if (getGoogleNativeWebSearchFromProviderOptions(providerOptions) === true) {
    options.nativeWebSearch = true;
  }

  return options;
}

export function createGoogleInteractionsRuntime(
  overrides: GoogleInteractionsRuntimeOverrides = {},
): LlmRuntime {
  const runStepImpl = overrides.runStepImpl ?? runGoogleNativeInteractionStep;
  return {
    name: "google-interactions",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      try {
        const resolved = await resolveGoogleInteractionsModel(params);
        const telemetry = parseTelemetrySettings(params.telemetry);
        const piTools = toolMapToPiTools(params.tools, params.config.provider);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        const turnMessages: Array<Record<string, unknown>> = [];
        let usage = undefined as RuntimeRunTurnResult["usage"];
        let finalStopReason: string | undefined;
        const activeProviderState = matchingGoogleProviderState(params, resolved.model.id);
        let finalProviderState = undefined as GoogleContinuationState | undefined;
        let previousInteractionId: string | undefined = activeProviderState?.interactionId;
        let stepMessages: ModelMessage[] = activeProviderState
          ? (() => {
              const deltaMessages = messagesAfterLastAssistant(params.messages);
              return deltaMessages.length > 0 ? deltaMessages : [...params.messages];
            })()
          : [...(params.allMessages ?? params.messages)];
        let stepProviderOptions: Record<string, unknown> | undefined = asRecord(params.providerOptions) ?? undefined;
        let nextInteractionInputStartIndex = 0;

        // Build a PiModel-compatible object for shared utilities (telemetry, etc.)
        const piModelCompat = {
          id: resolved.model.id,
          name: resolved.model.name,
          api: "google-interactions",
          provider: "google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          reasoning: resolved.model.reasoning,
          input: resolved.model.input,
          contextWindow: resolved.model.contextWindow,
          maxTokens: resolved.model.maxTokens,
          ...(resolved.model.cost ? { cost: resolved.model.cost } : {}),
        };
        const resolvedCompat = {
          model: piModelCompat,
          apiKey: resolved.apiKey,
        };

        const maxSteps = Math.max(1, params.maxSteps);
        await emitPart({ type: "start" });
        for (let step = 0; step < maxSteps; step += 1) {
          if (params.abortSignal?.aborted) {
            throw new Error("Model turn aborted.");
          }

          await emitPart({
            type: "start-step",
            stepNumber: step + 1,
            request: { model: resolved.model.id, provider: params.config.provider },
          });

          let overrides: RuntimeStepOverrides = {};
          if (params.prepareStep) {
            const stepOverrides = await params.prepareStep({
              stepNumber: step + 1,
              messages: stepMessages,
            });
            overrides = splitStepOverrides(stepOverrides);
          }

          const stepState = buildStepState(
            { ...params, providerOptions: stepProviderOptions } as RuntimeRunTurnParams,
            resolvedCompat as any,
            overrides,
            stepMessages
          );
          stepMessages = stepState.modelMessages;
          stepProviderOptions = stepState.providerOptions;

          const googleStreamOptions = buildGoogleStreamOptions(
            resolved.model.id,
            stepProviderOptions ?? asRecord(params.config.providerOptions) ?? undefined,
            params.abortSignal,
            resolved.apiKey,
          );
          const mergedStreamOptions = {
            ...googleStreamOptions,
            ...(overrides.streamOptions ?? {}),
          };

          const span = startModelCallSpan(
            telemetry,
            params,
            resolvedCompat as any,
            step + 1,
            mergedStreamOptions,
            stepState.piMessages,
            "google-interactions",
            "agent.runtime.google_interactions.model_call",
          );

          let assistantRecord: Record<string, unknown> = {};
          let interactionId: string | undefined;
          try {
            const requestStartIndex = Math.min(nextInteractionInputStartIndex, stepMessages.length);
            const requestMessages =
              previousInteractionId
                ? stepMessages.slice(requestStartIndex)
                : stepMessages;
            const result = await runStepImpl({
              model: resolved.model,
              apiKey: asNonEmptyString(mergedStreamOptions.apiKey as unknown) ?? resolved.apiKey,
              systemPrompt: params.system,
              messages: requestMessages.length > 0 ? requestMessages : stepMessages,
              tools: piTools,
              streamOptions: mergedStreamOptions as any,
              previousInteractionId,
              onEvent: async (event) => {
                if (!includeUnknownRawParts && event.type === "unknown") return;
                await emitPart(event);
              },
              onRawEvent: async (event) => {
                await params.onModelRawEvent?.({
                  format: "google-interactions-v1",
                  event,
                });
              },
            });
            assistantRecord = asRecord(result.assistant) ?? {};
            interactionId = result.interactionId;
            markModelCallSpanSuccess(span, telemetry, assistantRecord);
          } catch (error) {
            markModelCallSpanError(span, error);
            throw error;
          }

          turnMessages.push(assistantRecord);
          usage = mergePiUsage(usage, assistantRecord.usage);
          finalProviderState = nextGoogleProviderState(resolved.model.id, interactionId) ?? finalProviderState;
          previousInteractionId = interactionId ?? previousInteractionId;
          const assistantModelMessages = googleTurnMessagesToModelMessages([assistantRecord]);
          stepMessages = [
            ...stepMessages,
            ...assistantModelMessages,
          ];
          nextInteractionInputStartIndex = stepMessages.length;

          await emitPart({
            type: "finish-step",
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: normalizePiUsage(assistantRecord.usage),
            finishReason: assistantRecord.stopReason ?? "unknown",
          });

          const stopReason = asString(assistantRecord.stopReason);
          finalStopReason = stopReason ?? finalStopReason;
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage = asString(assistantRecord.errorMessage) ?? "Google Interactions runtime model stream failed.";
            throw new Error(errorMessage);
          }

          const toolCalls = extractToolCallsFromAssistant(assistantRecord);
          if (toolCalls.length === 0) {
            break;
          }

          const toolResultMessages: ModelMessage[] = [];
          let needsInvalidToolCallReminder = false;
          for (const toolCall of toolCalls) {
            if (params.abortSignal?.aborted) {
              throw new Error("Model turn aborted.");
            }
            const toolResult = await executeToolCall(toolCall, params, emitPart);
            turnMessages.push(toolResult);
            toolResultMessages.push(...piTurnMessagesToModelMessages([toolResult as any]));
            needsInvalidToolCallReminder ||= shouldAddInvalidToolCallFormatReminder(toolCall, toolResult, params.tools);
          }

          if (needsInvalidToolCallReminder) {
            toolResultMessages.push(buildInvalidToolCallFormatReminderMessage());
          }

          stepMessages = [...stepMessages, ...toolResultMessages];
        }

        await emitPart({
          type: "finish",
          finishReason: finalStopReason ?? "unknown",
          totalUsage: usage,
        });

        return {
          text: extractPiAssistantText(turnMessages as any),
          reasoningText: extractPiReasoningText(turnMessages as any),
          responseMessages: googleTurnMessagesToModelMessages(turnMessages),
          usage,
          ...(finalProviderState ? { providerState: finalProviderState } : {}),
        };
      } catch (error) {
        if (isAbortLikeError(error, params.abortSignal)) {
          await params.onModelAbort?.();
        } else {
          await params.onModelError?.(error);
        }
        throw error;
      }
    },
  };
}
