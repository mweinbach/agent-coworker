import type {
  Api as PiApi,
  Context as PiContext,
  Message as PiMessage,
  ProviderStreamOptions as PiProviderStreamOptions,
  Model as PiSdkModel,
} from "@earendil-works/pi-ai";
import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromAssistantRecord,
  parseTelemetrySettings,
  startPiModelCallSpan,
} from "../../observability/modelCallSpan";
import { asRecord, asString } from "../../shared/recordParsing";
import {
  assertTurnNotAborted,
  beginInProcessStep,
  buildInProcessTurnResult,
  completeInProcessAssistantStep,
  createInProcessTurnUsageTracker,
  createStreamPartEmitter,
  handleInProcessTurnFailure,
} from "../inProcessStepLoop";
import {
  normalizePiAssistantRecordForProvider,
  piTurnMessagesToModelMessages,
} from "../piMessageBridge";
import { createPiEventRawPartMapper } from "../piStreamParts";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult } from "../types";
import {
  preparePiModelForStream,
  resolvePiModel,
  stripPlaceholderCostFromAssistantRecord,
} from "./modelResolution";
import { withNvidiaPayloadNormalization } from "./nvidiaFetchPatch";
import {
  isRateLimitError,
  isTransientProviderError,
  isVisibleAssistantStreamPart,
  rateLimitBackoffDelayMs,
  resolveRateLimitMaxAttempts,
} from "./rateLimitRetry";
import { createPiRequestBudget, resolvePiRequestPolicy } from "./requestBudget";
import {
  buildInitialStepMessages,
  buildStepState,
  isAbortLikeError,
  resolveStepTools,
} from "./stepState";
import { streamPiModel } from "./stream";
import { toolMapToPiTools } from "./tools";
import type { PiRuntimeOverrides } from "./types";

function asPiMessage(message: Record<string, unknown>): PiMessage {
  return message as unknown as PiMessage;
}

export function createPiRuntime(overrides: PiRuntimeOverrides = {}): LlmRuntime {
  const piStreamImpl = overrides.piStreamImpl ?? streamPiModel;
  const retrySleep = overrides.retrySleep;
  return {
    name: "pi",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = createStreamPartEmitter(params);
      const turnMessages: Array<Record<string, unknown>> = [];
      const usageTracker = createInProcessTurnUsageTracker();

      try {
        assertTurnNotAborted(params);
        const resolved = await resolvePiModel(params);
        assertTurnNotAborted(params);
        const streamModel = preparePiModelForStream(resolved.model) as unknown as PiSdkModel<PiApi>;
        const telemetry = parseTelemetrySettings(params.telemetry);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        let stepMessages = buildInitialStepMessages(params, resolved);
        let stepProviderOptions: Record<string, unknown> | undefined =
          asRecord(params.providerOptions) ?? undefined;

        const maxSteps = Math.max(1, params.maxSteps);
        const maxModelCallAttempts = resolveRateLimitMaxAttempts(params.config);
        const mapPiEventToRawParts = createPiEventRawPartMapper(
          params.config.provider,
          includeUnknownRawParts,
        );
        for (let step = 0; step < maxSteps; step += 1) {
          const stepOverrides = await beginInProcessStep({
            params,
            stepNumber: step + 1,
            modelId: resolved.model.id,
            stepMessages,
            emitPart,
            recheckAbortBetweenBoundaries: true,
          });

          const stepState = buildStepState(
            { ...params, providerOptions: stepProviderOptions } as RuntimeRunTurnParams,
            resolved,
            stepOverrides,
            stepMessages,
          );
          stepMessages = stepState.modelMessages;
          stepProviderOptions = stepState.providerOptions;
          const stepTools = await resolveStepTools(params, stepState.piMessages);
          assertTurnNotAborted(params);
          const piTools = toolMapToPiTools(stepTools, params.config.provider);
          // Revalidate after prepareStep overrides: a step cannot disable the
          // deadline or re-enable SDK retries underneath Cowork's retry loop.
          const requestPolicy = resolvePiRequestPolicy(stepState.streamOptions);
          const { stepTimeoutMs, ...requestOptions } = requestPolicy;
          const baseStreamOptions: Record<string, unknown> = {
            ...stepState.streamOptions,
            ...requestOptions,
          };
          delete baseStreamOptions.stepTimeoutMs;
          const streamOptions =
            params.config.provider === "nvidia"
              ? withNvidiaPayloadNormalization(baseStreamOptions as PiProviderStreamOptions)
              : (baseStreamOptions as PiProviderStreamOptions);

          const span = startPiModelCallSpan(
            telemetry,
            params,
            resolved.model.id,
            step + 1,
            streamOptions,
            stepState.piMessages,
          );
          const requestBudget = createPiRequestBudget({
            signal: params.abortSignal,
            stepTimeoutMs,
          });
          let assistantRecord: Record<string, unknown> = {};
          try {
            // Provider rate limits (HTTP 429 / ResourceExhausted) frequently
            // surface mid-stream, after the request was accepted, so
            // request-level retry knobs cannot cover them. Restart the model
            // call with bounded backoff — but only while the failed attempt
            // emitted no assistant content or tool-call activity, so a retry
            // never duplicates visible output.
            for (let attempt = 1; ; attempt += 1) {
              assertTurnNotAborted(params);
              requestBudget.throwIfAborted();
              assistantRecord = {};
              let emittedAssistantContent = false;
              let streamConsumerFailed = false;
              // Provider error chunks are buffered while a retry is still
              // possible so a transient rate limit does not surface a phantom
              // error in the transcript; they are emitted once the failure is
              // final.
              const bufferedErrorParts: unknown[] = [];

              const runModelStep = async () => {
                const stream = piStreamImpl(
                  streamModel,
                  {
                    systemPrompt: params.system,
                    messages: stepState.piMessages as unknown as PiMessage[],
                    tools: piTools as unknown as PiContext["tools"],
                  },
                  { ...streamOptions, signal: requestBudget.signal },
                );

                for await (const event of stream) {
                  requestBudget.throwIfAborted();
                  for (const part of mapPiEventToRawParts(event)) {
                    requestBudget.throwIfAborted();
                    if (asRecord(part)?.type === "error") {
                      bufferedErrorParts.push(part);
                      continue;
                    }
                    emittedAssistantContent ||= isVisibleAssistantStreamPart(part);
                    try {
                      await emitPart(part);
                    } catch (error) {
                      // A client callback failure is not a provider outage,
                      // even when its message resembles a retryable HTTP error.
                      streamConsumerFailed = true;
                      throw error;
                    }
                  }
                }

                const assistant = await stream.result();
                requestBudget.throwIfAborted();
                assistantRecord = normalizePiAssistantRecordForProvider(
                  stripPlaceholderCostFromAssistantRecord(
                    asRecord(assistant) ?? {},
                    resolved.model,
                  ),
                  params.config.provider,
                );

                // The PI SDK reports provider/stream failures on the assistant
                // record instead of throwing; raise them so they can be retried.
                const attemptStopReason = asString(assistantRecord.stopReason);
                if (attemptStopReason === "aborted") {
                  throw new DOMException(
                    asString(assistantRecord.errorMessage) ?? "Model turn aborted.",
                    "AbortError",
                  );
                }
                if (attemptStopReason === "error") {
                  throw new Error(
                    asString(assistantRecord.errorMessage) ?? "PI runtime model stream failed.",
                  );
                }
              };

              try {
                await requestBudget.run(runModelStep);
                markModelCallSpanSuccessFromAssistantRecord(span, telemetry, assistantRecord);
                break;
              } catch (error) {
                const retryableProviderFailure =
                  attempt < maxModelCallAttempts &&
                  !emittedAssistantContent &&
                  !streamConsumerFailed &&
                  !requestBudget.signal.aborted &&
                  !isAbortLikeError(error, params.abortSignal) &&
                  isTransientProviderError(error);
                if (!retryableProviderFailure) {
                  // Preserve terminal partial output, but never replay tool calls
                  // from a failed step: those calls have not been executed.
                  const partialContent = Array.isArray(assistantRecord.content)
                    ? assistantRecord.content.filter((part) => {
                        const type = asRecord(part)?.type;
                        return type === "text" || type === "thinking";
                      })
                    : [];
                  if (partialContent.length > 0) {
                    turnMessages.push({ ...assistantRecord, content: partialContent });
                  }
                  usageTracker.recordPartialErrorUsage(error, assistantRecord.usage);
                  for (const part of bufferedErrorParts) {
                    await emitPart(part);
                  }
                  throw error;
                }
                const delayMs = Math.min(
                  rateLimitBackoffDelayMs(attempt),
                  requestPolicy.maxRetryDelayMs,
                );
                const failureDescription = isRateLimitError(error)
                  ? "rate-limited the model call"
                  : "encountered a temporary provider failure";
                params.log?.(
                  `pi: ${params.config.provider} ${failureDescription}; retrying attempt ${attempt + 1}/${maxModelCallAttempts} in ${(delayMs / 1000).toFixed(1)}s`,
                );
                if (retrySleep) {
                  await requestBudget.run((signal) => retrySleep(delayMs, signal));
                } else {
                  await requestBudget.sleep(delayMs);
                }
              }
            }
          } catch (error) {
            const failure = params.abortSignal?.aborted
              ? new DOMException("Model turn aborted.", "AbortError")
              : error;
            markModelCallSpanError(span, failure, telemetry);
            throw failure;
          } finally {
            requestBudget.dispose();
          }

          turnMessages.push(assistantRecord);
          usageTracker.recordStepUsage(assistantRecord.usage);
          const completedAssistantMessages = piTurnMessagesToModelMessages([
            asPiMessage(assistantRecord),
          ]);

          const completedStep = await completeInProcessAssistantStep({
            stepNumber: step + 1,
            assistantRecord,
            assistantMessages: completedAssistantMessages,
            stepMessages,
            params,
            stepTools,
            emitPart,
            turnMessages,
          });
          stepMessages = completedStep.stepMessages;
          if (!completedStep.shouldContinue) break;
        }

        return buildInProcessTurnResult({
          turnMessages,
          usageTracker,
        });
      } catch (error) {
        return await handleInProcessTurnFailure({
          error,
          params,
          turnMessages,
          usageTracker,
        });
      }
    },
  };
}
