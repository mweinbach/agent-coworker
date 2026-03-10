import {
  buildInitialStepMessages,
  buildStepState,
  emitPiEventAsRawPart,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  matchingProviderState,
  nextProviderState,
  parseTelemetrySettings,
  resolvePiModel,
  splitStepOverrides,
  startModelCallSpan,
  supportsProviderManagedContinuation,
  toolMapToPiTools,
} from "./piRuntime";
import { asNonEmptyString, asRecord, asString, extractToolCallsFromAssistant } from "./piRuntimeOptions";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
import {
  runOpenAiNativeResponseStep,
  type RunOpenAiNativeResponseStep,
} from "./openaiNativeResponses";

import type { OpenAiContinuationProvider, OpenAiContinuationState } from "../shared/openaiContinuation";
import type { ModelMessage } from "../types";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeStepOverride } from "./types";

type RuntimeStepOverrides = RuntimeStepOverride;

type OpenAiResponsesRuntimeOverrides = {
  runStepImpl?: RunOpenAiNativeResponseStep;
};

export function createOpenAiResponsesRuntime(
  overrides: OpenAiResponsesRuntimeOverrides = {},
): LlmRuntime {
  const runStepImpl = overrides.runStepImpl ?? runOpenAiNativeResponseStep;
  return {
    name: "pi",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      try {
        const resolved = await resolvePiModel(params);
        const telemetry = parseTelemetrySettings(params.telemetry);
        const piTools = toolMapToPiTools(params.tools);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        const turnMessages: Array<Record<string, unknown>> = [];
        let usage = undefined as RuntimeRunTurnResult["usage"];
        let activeProviderState = matchingProviderState(params, resolved);
        let finalProviderState = undefined as OpenAiContinuationState | undefined;
        let stepMessages: ModelMessage[] = buildInitialStepMessages(params, resolved);
        let stepProviderOptions: Record<string, unknown> | undefined = asRecord(params.providerOptions) ?? undefined;
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
            stepMessages
          );
          stepMessages = stepState.modelMessages;
          stepProviderOptions = stepState.providerOptions;

          const span = startModelCallSpan(
            telemetry,
            params,
            resolved,
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
              headers: asRecord(stepState.streamOptions.headers) as Record<string, string> | undefined,
              systemPrompt: params.system,
              piMessages: stepState.piMessages,
              tools: piTools,
              streamOptions: stepState.streamOptions,
              previousResponseId: activeProviderState?.responseId,
              onEvent: async (event) => {
                await emitPiEventAsRawPart(event, params.config.provider, includeUnknownRawParts, emitPart);
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
            markModelCallSpanError(span, error);
            throw error;
          }

          turnMessages.push(assistantRecord);
          usage = mergePiUsage(usage, assistantRecord.usage);
          finalProviderState = nextProviderState(params, resolved, responseId);
          activeProviderState = finalProviderState ?? activeProviderState;
          const assistantModelMessages = piTurnMessagesToModelMessages([assistantRecord as any]);
          if (!providerManagedContinuation) {
            stepMessages = [
              ...stepMessages,
              ...assistantModelMessages,
            ];
          }

          await emitPart({
            type: "finish-step",
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: normalizePiUsage(assistantRecord.usage),
            finishReason: assistantRecord.stopReason ?? "unknown",
          });

          const stopReason = asString(assistantRecord.stopReason);
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage = asString(assistantRecord.errorMessage) ?? "OpenAI Responses runtime model stream failed.";
            throw new Error(errorMessage);
          }

          const toolCalls = extractToolCallsFromAssistant(assistantRecord);
          if (toolCalls.length === 0) {
            break;
          }

          const toolResultMessages: ModelMessage[] = [];
          for (const toolCall of toolCalls) {
            if (params.abortSignal?.aborted) {
              throw new Error("Model turn aborted.");
            }
            const toolResult = await executeToolCall(toolCall, params, emitPart);
            turnMessages.push(toolResult);
            toolResultMessages.push(...piTurnMessagesToModelMessages([toolResult as any]));
          }

          stepMessages = providerManagedContinuation
            ? toolResultMessages
            : [...stepMessages, ...toolResultMessages];
        }

        return {
          text: extractPiAssistantText(turnMessages as any),
          reasoningText: extractPiReasoningText(turnMessages as any),
          responseMessages: piTurnMessagesToModelMessages(turnMessages as any),
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
