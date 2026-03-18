import {
  buildInvalidToolCallFormatReminderMessage,
  buildStepState,
  emitPiEventAsRawPart,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
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
  runGoogleNativeInteractionStep,
  type RunGoogleNativeInteractionStep,
} from "./googleNativeInteractions";

import type { ModelMessage } from "../types";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeStepOverride } from "./types";

type RuntimeStepOverrides = RuntimeStepOverride;

type GoogleInteractionsRuntimeOverrides = {
  runStepImpl?: RunGoogleNativeInteractionStep;
};

function buildGoogleStreamOptions(
  params: RuntimeRunTurnParams,
  apiKey?: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (apiKey) options.apiKey = apiKey;
  if (params.abortSignal) options.signal = params.abortSignal;

  const providerOptions = params.providerOptions ?? params.config.providerOptions;
  const googleSection = asRecord(providerOptions?.google) ?? asRecord(providerOptions?.vertex) ?? {};

  const thinkingConfig = asRecord(googleSection.thinkingConfig);
  if (thinkingConfig) {
    const includeThoughts = thinkingConfig.includeThoughts !== false;
    if (includeThoughts) {
      const level = asNonEmptyString(thinkingConfig.thinkingLevel);
      if (level) options.thinkingLevel = level;
      options.thinkingSummaries = "auto";
    } else {
      options.thinkingLevel = "none";
    }
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
        const piTools = toolMapToPiTools(params.tools);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        const turnMessages: Array<Record<string, unknown>> = [];
        let usage = undefined as RuntimeRunTurnResult["usage"];
        let previousInteractionId: string | undefined;
        let stepMessages: ModelMessage[] = [...(params.allMessages ?? params.messages)];
        let stepProviderOptions: Record<string, unknown> | undefined = asRecord(params.providerOptions) ?? undefined;

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

          const googleStreamOptions = buildGoogleStreamOptions(params, resolved.apiKey);
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
            const result = await runStepImpl({
              model: resolved.model,
              apiKey: asNonEmptyString(mergedStreamOptions.apiKey as unknown) ?? resolved.apiKey,
              systemPrompt: params.system,
              messages: stepMessages,
              tools: piTools,
              streamOptions: mergedStreamOptions as any,
              previousInteractionId,
              onEvent: async (event) => {
                await emitPiEventAsRawPart(event, params.config.provider, includeUnknownRawParts, emitPart);
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
          previousInteractionId = interactionId ?? previousInteractionId;
          const assistantModelMessages = piTurnMessagesToModelMessages([assistantRecord as any]);
          stepMessages = [
            ...stepMessages,
            ...assistantModelMessages,
          ];

          await emitPart({
            type: "finish-step",
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: normalizePiUsage(assistantRecord.usage),
            finishReason: assistantRecord.stopReason ?? "unknown",
          });

          const stopReason = asString(assistantRecord.stopReason);
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

        return {
          text: extractPiAssistantText(turnMessages as any),
          reasoningText: extractPiReasoningText(turnMessages as any),
          responseMessages: piTurnMessagesToModelMessages(turnMessages as any),
          usage,
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
