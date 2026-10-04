import type {
  OpenAiContinuationProvider,
  OpenAiContinuationState,
} from "../shared/openaiContinuation";
import { buildRequestFingerprint } from "../shared/providerContinuation";
import { asNonEmptyString, asRecord } from "../shared/recordParsing";
import type { ModelMessage } from "../types";
import {
  beginInProcessStep,
  buildInProcessTurnResult,
  completeInProcessAssistantStep,
  createInProcessTurnUsageTracker,
  createStreamPartEmitter,
  handleInProcessTurnFailure,
} from "./inProcessStepLoop";
import {
  type RunOpenAiNativeResponseStep,
  runOpenAiNativeResponseStep,
} from "./openaiNativeResponses";
import { resolveOpenAiResponsesModel } from "./openaiResponsesModel";
import { piTurnMessagesToModelMessages } from "./piMessageBridge";
import {
  buildInitialStepMessages,
  buildStepState,
  emitPiEventAsRawPart,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  matchingProviderState,
  nextProviderState,
  parseTelemetrySettings,
  startModelCallSpan,
  supportsProviderManagedContinuation,
  toolMapToPiTools,
} from "./piRuntime";
import { buildPiStreamOptions } from "./piRuntimeOptions";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult } from "./types";

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
      const emitPart = createStreamPartEmitter(params);
      const turnMessages: Array<Record<string, unknown>> = [];
      const usageTracker = createInProcessTurnUsageTracker();
      let finalProviderState: OpenAiContinuationState | undefined;

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
          const stepOverrides = await beginInProcessStep({
            params,
            stepNumber: step + 1,
            modelId: resolved.model.id,
            stepMessages,
            emitPart,
          });

          const stepState = buildStepState(
            { ...params, providerOptions: stepProviderOptions } as RuntimeRunTurnParams,
            resolved,
            stepOverrides,
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
          usageTracker.recordStepUsage(assistantRecord.usage);
          finalProviderState = nextProviderState(params, resolved, responseId);
          if (finalProviderState) {
            finalProviderState.requestFingerprint = initialRequestFingerprint;
          }
          activeProviderState = finalProviderState ?? activeProviderState;
          const assistantModelMessages = piTurnMessagesToModelMessages([assistantRecord as never]);

          const completedStep = await completeInProcessAssistantStep({
            stepNumber: step + 1,
            assistantRecord,
            assistantMessages: assistantModelMessages,
            stepMessages,
            appendAssistantToStepMessages: !providerManagedContinuation,
            replaceStepMessagesWithToolResults: providerManagedContinuation,
            terminalFailureFallbackMessage: "OpenAI Responses runtime model stream failed.",
            params,
            emitPart,
            turnMessages,
          });
          stepMessages = completedStep.stepMessages;
          if (!completedStep.shouldContinue) break;
        }

        return buildInProcessTurnResult({
          turnMessages,
          usageTracker,
          providerState: finalProviderState,
        });
      } catch (error) {
        return await handleInProcessTurnFailure({
          error,
          params,
          turnMessages,
          usageTracker,
          includeErrorPartialUsage: true,
          includeErrorResponseMessages: true,
          clearProviderStateOnError: true,
        });
      }
    },
  };
}
