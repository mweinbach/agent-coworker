import type {
  OpenAiContinuationProvider,
  OpenAiContinuationState,
} from "../shared/openaiContinuation";
import { buildRequestFingerprint } from "../shared/providerContinuation";
import { asNonEmptyString, asRecord, asString } from "../shared/recordParsing";
import type { ModelMessage } from "../types";
import {
  type RunOpenAiNativeResponseStep,
  runOpenAiNativeResponseStep,
} from "./openaiNativeResponses";
import { resolveOpenAiResponsesModel } from "./openaiResponsesModel";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
import {
  buildInitialStepMessages,
  buildInvalidToolCallFormatReminderMessage,
  buildStepState,
  emitPiEventAsRawPart,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  matchingProviderState,
  nextProviderState,
  parseTelemetrySettings,
  shouldAddInvalidToolCallFormatReminder,
  splitStepOverrides,
  startModelCallSpan,
  supportsProviderManagedContinuation,
  toolMapToPiTools,
} from "./piRuntime";
import { buildPiStreamOptions, extractToolCallsFromAssistant } from "./piRuntimeOptions";
import {
  type LlmRuntime,
  type PartialTurnError,
  RUNTIME_COMMITTED_PROGRESS,
  type RuntimeRunTurnParams,
  type RuntimeRunTurnResult,
  type RuntimeStepOverride,
} from "./types";

type RuntimeStepOverrides = RuntimeStepOverride;

type OpenAiResponsesRuntimeOverrides = {
  runStepImpl?: RunOpenAiNativeResponseStep;
};

export function createOpenAiResponsesRuntime(
  overrides: OpenAiResponsesRuntimeOverrides = {},
): LlmRuntime {
  const runStepImpl = overrides.runStepImpl ?? runOpenAiNativeResponseStep;
  return {
    name: "openai-responses",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      const turnMessages: Array<Record<string, unknown>> = [];
      let usage = undefined as RuntimeRunTurnResult["usage"];
      const requestUsages: NonNullable<RuntimeRunTurnResult["requestUsages"]> = [];
      let finalProviderState = undefined as OpenAiContinuationState | undefined;

      try {
        const resolved = await resolveOpenAiResponsesModel(params);
        const telemetry = parseTelemetrySettings(params.telemetry);
        const piTools = toolMapToPiTools(params.tools, params.config.provider);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        let stepProviderOptions: Record<string, unknown> | undefined =
          asRecord(params.providerOptions) ?? undefined;
        let activeProviderState = matchingProviderState(params, resolved);

        const initialStreamOptions = buildPiStreamOptions(
          { ...params, providerOptions: stepProviderOptions } as RuntimeRunTurnParams,
          resolved.apiKey,
          resolved.headers,
          false, // This native adapter owns its transport, not PI's request budget.
        );
        const initialRequestFingerprint = buildRequestFingerprint({
          modelId: resolved.model.id,
          system: params.system,
          tools: piTools,
          streamOptions: initialStreamOptions,
        });

        if (
          activeProviderState?.requestFingerprint &&
          activeProviderState.requestFingerprint !== initialRequestFingerprint
        ) {
          params.log?.(
            "openai-responses: Stored continuation request context changed; starting a fresh session instead of reusing the continuation ID.",
          );
          activeProviderState = null;
        }
        let stepMessages: ModelMessage[] = activeProviderState
          ? buildInitialStepMessages(params, resolved)
          : [...(params.allMessages ?? params.messages)];
        const providerManagedContinuation = supportsProviderManagedContinuation(params, resolved);

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
            resolved,
            overrides,
            stepMessages,
            false,
          );
          stepMessages = stepState.modelMessages;
          stepProviderOptions = stepState.providerOptions;

          const span = startModelCallSpan(
            telemetry,
            params,
            resolved.model.id,
            step + 1,
            stepState.streamOptions,
            stepState.piMessages,
            "openai-responses",
            "agent.runtime.openai_responses.model_call",
          );

          let assistantRecord: Record<string, unknown> = {};
          let responseId: string | undefined;
          try {
            const result = await runStepImpl({
              provider: params.config.provider as OpenAiContinuationProvider,
              model: resolved.model,
              apiKey: asNonEmptyString(stepState.streamOptions.apiKey) ?? resolved.apiKey,
              headers: asRecord(stepState.streamOptions.headers) as
                | Record<string, string>
                | undefined,
              systemPrompt: params.system,
              piMessages: stepState.piMessages,
              tools: piTools,
              streamOptions: stepState.streamOptions,
              previousResponseId: activeProviderState?.responseId,
              onEvent: async (event) => {
                await emitPiEventAsRawPart(
                  event,
                  params.config.provider,
                  includeUnknownRawParts,
                  emitPart,
                );
              },
              onRawEvent: async (event) => {
                await params.onModelRawEvent?.({
                  format: "openai-responses-v1",
                  event,
                });
              },
            });
            assistantRecord = asRecord(result.assistant) ?? {};
            responseId = result.responseId;
            markModelCallSpanSuccess(span, telemetry, assistantRecord);
          } catch (error) {
            markModelCallSpanError(span, error, telemetry);
            throw error;
          }

          turnMessages.push(assistantRecord);
          const stepUsage = normalizePiUsage(assistantRecord.usage);
          usage = mergePiUsage(usage, stepUsage);
          if (stepUsage) requestUsages.push(stepUsage);
          finalProviderState = nextProviderState(params, resolved, responseId);
          if (finalProviderState) {
            finalProviderState.requestFingerprint = initialRequestFingerprint;
          }
          activeProviderState = finalProviderState ?? activeProviderState;
          const assistantModelMessages = piTurnMessagesToModelMessages([assistantRecord]);
          if (!providerManagedContinuation) {
            stepMessages = [...stepMessages, ...assistantModelMessages];
          }

          await emitPart({
            type: "finish-step",
            [RUNTIME_COMMITTED_PROGRESS]: { assistantMessages: assistantModelMessages },
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: normalizePiUsage(assistantRecord.usage),
            finishReason: assistantRecord.stopReason ?? "unknown",
          });

          const stopReason = asString(assistantRecord.stopReason);
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage =
              asString(assistantRecord.errorMessage) ??
              "OpenAI Responses runtime model stream failed.";
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
            toolResultMessages.push(...piTurnMessagesToModelMessages([toolResult]));
            needsInvalidToolCallReminder ||= shouldAddInvalidToolCallFormatReminder(
              toolCall,
              toolResult,
              params.tools,
            );
          }

          if (needsInvalidToolCallReminder) {
            toolResultMessages.push(buildInvalidToolCallFormatReminderMessage());
          }

          stepMessages = providerManagedContinuation
            ? toolResultMessages
            : [...stepMessages, ...toolResultMessages];
          if (params.shouldStopAfterToolStep?.()) break;
        }

        return {
          text: extractPiAssistantText(turnMessages),
          reasoningText: extractPiReasoningText(turnMessages),
          responseMessages: piTurnMessagesToModelMessages(turnMessages),
          usage,
          ...(requestUsages.length > 0 ? { requestUsages } : {}),
          ...(finalProviderState ? { providerState: finalProviderState } : {}),
        };
      } catch (error) {
        if (error && typeof error === "object") {
          try {
            const partialError = error as PartialTurnError;
            const partialUsage = normalizePiUsage(partialError.usage);
            const partialRequestUsages = Array.isArray(partialError.requestUsages)
              ? partialError.requestUsages
              : [];
            const hasCompleteRequestUsage = !partialUsage || partialRequestUsages.length > 0;
            if (partialUsage) {
              requestUsages.push(...partialRequestUsages);
            }
            partialError.usage = mergePiUsage(usage, partialUsage);
            partialError.requestUsages =
              hasCompleteRequestUsage && requestUsages.length > 0 ? requestUsages : undefined;
            const responseMessages = [
              ...piTurnMessagesToModelMessages(turnMessages),
              ...(Array.isArray(partialError.responseMessages)
                ? partialError.responseMessages
                : []),
            ];
            Object.defineProperty(error, "responseMessages", {
              value: responseMessages,
              configurable: true,
              writable: true,
            });
            // The failed request may never have entered provider history.
            // Replay local history next turn, including its user input and partial output.
            Object.defineProperty(error, "providerState", {
              value: null,
              configurable: true,
              writable: true,
            });
          } catch {
            // Ignore if error object is not extensible/writable
          }
        }
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
