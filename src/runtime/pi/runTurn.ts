import {
  stream as piStream,
  type Api as PiApi,
  type Context as PiContext,
  type Message as PiMessage,
  type Model as PiSdkModel,
  type ProviderStreamOptions as PiProviderStreamOptions,
} from "@earendil-works/pi-ai";
import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromAssistantRecord,
  parseTelemetrySettings,
  startPiModelCallSpan,
} from "../../observability/modelCallSpan";
import type { ModelMessage } from "../../types";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "../piMessageBridge";
import { asRecord, asString, extractToolCallsFromAssistant } from "../piRuntimeOptions";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult } from "../types";
import {
  preparePiModelForStream,
  resolvePiModel,
  stripPlaceholderCostFromAssistantRecord,
} from "./modelResolution";
import { withPatchedNvidiaFetch } from "./nvidiaFetchPatch";
import {
  buildInitialStepMessages,
  buildStepState,
  isAbortLikeError,
  splitStepOverrides,
} from "./stepState";
import {
  buildInvalidToolCallFormatReminderMessage,
  emitPiEventAsRawPart,
  executeToolCall,
  shouldAddInvalidToolCallFormatReminder,
  toolMapToPiTools,
} from "./tools";
import type { PiRuntimeOverrides, RuntimeStepOverrides } from "./types";

function asPiMessage(message: Record<string, unknown>): PiMessage {
  return message as unknown as PiMessage;
}

export function createPiRuntime(overrides: PiRuntimeOverrides = {}): LlmRuntime {
  const piStreamImpl = overrides.piStreamImpl ?? piStream;
  return {
    name: "pi",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      const turnMessages: PiMessage[] = [];
      let usage = undefined as RuntimeRunTurnResult["usage"];

      try {
        const resolved = await resolvePiModel(params);
        const telemetry = parseTelemetrySettings(params.telemetry);
        const piTools = toolMapToPiTools(params.tools, params.config.provider);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        let stepMessages = buildInitialStepMessages(params, resolved);
        let stepProviderOptions: Record<string, unknown> | undefined =
          asRecord(params.providerOptions) ?? undefined;

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
          );
          stepMessages = stepState.modelMessages;
          stepProviderOptions = stepState.providerOptions;

          const span = startPiModelCallSpan(
            telemetry,
            params,
            resolved.model.id,
            step + 1,
            stepState.streamOptions,
            stepState.piMessages,
          );
          let assistantRecord: Record<string, unknown> = {};
          try {
            const runModelStep = async () => {
              const stream = piStreamImpl(
                preparePiModelForStream(resolved.model) as unknown as PiSdkModel<PiApi>,
                {
                  systemPrompt: params.system,
                  messages: stepState.piMessages as unknown as PiMessage[],
                  tools: piTools as unknown as PiContext["tools"],
                },
                stepState.streamOptions as PiProviderStreamOptions,
              );

              for await (const event of stream) {
                await emitPiEventAsRawPart(
                  event,
                  params.config.provider,
                  includeUnknownRawParts,
                  emitPart,
                );
              }

              const assistant = await stream.result();
              assistantRecord = stripPlaceholderCostFromAssistantRecord(
                asRecord(assistant) ?? {},
                resolved.model,
              );
            };

            if (params.config.provider === "nvidia") {
              await withPatchedNvidiaFetch(runModelStep);
            } else {
              await runModelStep();
            }
            markModelCallSpanSuccessFromAssistantRecord(span, telemetry, assistantRecord);
          } catch (error) {
            markModelCallSpanError(span, error);
            throw error;
          }

          turnMessages.push(asPiMessage(assistantRecord));
          usage = mergePiUsage(usage, assistantRecord.usage);
          stepMessages = [...stepMessages, ...piTurnMessagesToModelMessages([asPiMessage(assistantRecord)])];

          await emitPart({
            type: "finish-step",
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: normalizePiUsage(assistantRecord.usage),
            finishReason: assistantRecord.stopReason ?? "unknown",
          });

          const stopReason = asString(assistantRecord.stopReason);
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage =
              asString(assistantRecord.errorMessage) ?? "PI runtime model stream failed.";
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
            turnMessages.push(asPiMessage(toolResult));
            toolResultMessages.push(...piTurnMessagesToModelMessages([asPiMessage(toolResult)]));
            needsInvalidToolCallReminder ||= shouldAddInvalidToolCallFormatReminder(
              toolCall,
              toolResult,
              params.tools,
            );
          }

          if (needsInvalidToolCallReminder) {
            toolResultMessages.push(buildInvalidToolCallFormatReminderMessage());
          }

          stepMessages = [...stepMessages, ...toolResultMessages];
        }

        return {
          text: extractPiAssistantText(turnMessages),
          reasoningText: extractPiReasoningText(turnMessages),
          responseMessages: piTurnMessagesToModelMessages(turnMessages),
          usage,
        };
      } catch (error) {
        if (error && typeof error === "object") {
          try {
            (error as { usage?: RuntimeRunTurnResult["usage"] }).usage = usage;
            const responseMessages =
              typeof turnMessages !== "undefined" && Array.isArray(turnMessages)
                ? piTurnMessagesToModelMessages(turnMessages)
                : [];
            Object.defineProperty(error, "responseMessages", {
              value: responseMessages,
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
