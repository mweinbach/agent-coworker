import { normalizeGoogleThinkingLevelForModel } from "../shared/googleThinking";
import { getGoogleNativeWebSearchFromProviderOptions } from "../shared/openaiCompatibleOptions";
import {
  type GoogleContinuationState,
  isGoogleContinuationState,
  isInvalidGoogleContinuationError,
} from "../shared/providerContinuation";
import type { ModelMessage } from "../types";
import { resolveGoogleInteractionsModel } from "./googleInteractionsModel";
import {
  classifyGoogleInteractionError,
  googleTurnMessagesToModelMessages,
  isRetryableGoogleInteractionError,
  type RunGoogleNativeInteractionStep,
  runGoogleNativeInteractionStep,
} from "./googleNativeInteractions";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
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
import {
  asNonEmptyString,
  asRecord,
  asString,
  extractToolCallsFromAssistant,
} from "./piRuntimeOptions";
import type {
  LlmRuntime,
  RuntimeRunTurnParams,
  RuntimeRunTurnResult,
  RuntimeStepOverride,
} from "./types";

type RuntimeStepOverrides = RuntimeStepOverride;

type GoogleInteractionsRuntimeOverrides = {
  runStepImpl?: RunGoogleNativeInteractionStep;
};

function stableFingerprintStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFingerprintStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableFingerprintStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildGoogleRequestFingerprint(input: {
  modelId: string;
  system: string;
  tools: Array<Record<string, unknown>>;
  streamOptions: Record<string, unknown>;
}): string {
  const { apiKey: _apiKey, signal: _signal, ...safeStreamOptions } = input.streamOptions;
  return stableFingerprintStringify({
    modelId: input.modelId,
    system: input.system,
    tools: input.tools,
    streamOptions: safeStreamOptions,
  });
}

function matchingGoogleProviderState(
  params: RuntimeRunTurnParams,
  modelId: string,
): GoogleContinuationState | null {
  const providerState = params.providerState;
  if (!isGoogleContinuationState(providerState)) {
    return null;
  }
  if (providerState.model !== modelId) return null;
  return providerState;
}

function googleContinuationRequestContextChanged(
  providerState: GoogleContinuationState | null,
  requestFingerprint: string,
): boolean {
  return Boolean(
    providerState?.requestFingerprint && providerState.requestFingerprint !== requestFingerprint,
  );
}

function nextGoogleProviderState(
  modelId: string,
  interactionId: string | undefined,
  requestFingerprint: string,
): GoogleContinuationState | undefined {
  const nextInteractionId = interactionId?.trim();
  if (!nextInteractionId) return undefined;

  return {
    provider: "google",
    model: modelId,
    interactionId: nextInteractionId,
    updatedAt: new Date().toISOString(),
    requestFingerprint,
  };
}

function isGoogleNotImplementedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("501") ||
    normalized.includes("not_implemented") ||
    normalized.includes("not implemented")
  );
}

function sanitizedTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const rawPart of content) {
    if (typeof rawPart === "string") {
      if (rawPart.trim()) parts.push(rawPart.trim());
      continue;
    }

    const part = asRecord(rawPart);
    if (!part) continue;
    const partType = asString(part.type);
    if (partType === "text" || partType === "input_text" || partType === "output_text") {
      const text = asString(part.text) ?? asString(part.inputText) ?? asString(part.outputText);
      if (text?.trim()) parts.push(text.trim());
      continue;
    }

    if (
      partType === "image" ||
      partType === "input_image" ||
      partType === "audio" ||
      partType === "video" ||
      partType === "document" ||
      partType === "file"
    ) {
      parts.push(`[${partType}]`);
    }
  }

  return parts.join("\n").trim();
}

function sanitizeGoogleReplayMessages(messages: ModelMessage[]): ModelMessage[] {
  const sanitized: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;

    if (message.role === "user" || message.role === "system") {
      const text = sanitizedTextFromContent(message.content);
      if (text) sanitized.push({ ...message, content: text });
      continue;
    }

    if (message.role === "assistant") {
      const text = sanitizedTextFromContent(message.content);
      if (text) sanitized.push({ role: "assistant", content: [{ type: "text", text }] });
    }
  }

  return sanitized;
}

function googleReplayMessagesWereSanitized(
  original: ModelMessage[],
  sanitized: ModelMessage[],
): boolean {
  return stableFingerprintStringify(original) !== stableFingerprintStringify(sanitized);
}

function isDisabledGoogleCodeExecutionPart(part: unknown): boolean {
  const record = asRecord(part);
  if (!record) return false;
  const type = asString(record.type);
  if (type === "code_execution_call" || type === "code_execution_result") return true;
  if (type !== "providerToolCall" && type !== "providerToolResult") return false;
  const name = asString(record.name) ?? asString(record.toolName);
  return name === "codeExecution";
}

function messageHasDisabledGoogleCodeExecution(message: ModelMessage): boolean {
  return Array.isArray(message.content) && message.content.some(isDisabledGoogleCodeExecutionPart);
}

function messagesHaveDisabledGoogleCodeExecution(messages: readonly ModelMessage[]): boolean {
  return messages.some(messageHasDisabledGoogleCodeExecution);
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

  const googleSection =
    asRecord(providerOptions?.google) ?? asRecord(providerOptions?.vertex) ?? {};

  const thinkingConfig = asRecord(googleSection.thinkingConfig);
  if (thinkingConfig) {
    const includeThoughts = thinkingConfig.includeThoughts !== false;
    const level = normalizeGoogleThinkingLevelForModel(
      modelId,
      asNonEmptyString(thinkingConfig.thinkingLevel),
    );
    if (level) options.thinkingLevel = level;
    options.thinkingSummaries = includeThoughts ? "auto" : "none";
    const budget =
      typeof thinkingConfig.thinkingBudget === "number" ? thinkingConfig.thinkingBudget : undefined;
    if (budget !== undefined) options.thinkingBudget = budget;
  }

  const temperature =
    typeof googleSection.temperature === "number" ? googleSection.temperature : undefined;
  if (temperature !== undefined) options.temperature = temperature;

  const toolChoice = asNonEmptyString(googleSection.toolChoice);
  if (toolChoice) options.toolChoice = toolChoice;

  if (googleSection.responseFormat !== undefined) {
    options.responseFormat = googleSection.responseFormat;
  }
  const responseMimeType = asNonEmptyString(googleSection.responseMimeType);
  if (responseMimeType) options.responseMimeType = responseMimeType;

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

      const turnMessages: Array<Record<string, unknown>> = [];
      let usage = undefined as RuntimeRunTurnResult["usage"];
      let finalProviderState = undefined as GoogleContinuationState | undefined;

      try {
        const resolved = await resolveGoogleInteractionsModel(params);
        const telemetry = parseTelemetrySettings(params.telemetry);
        const piTools = toolMapToPiTools(params.tools, params.config.provider);
        const includeUnknownRawParts = params.includeRawChunks ?? true;
        let finalStopReason: string | undefined;
        let stepProviderOptions: Record<string, unknown> | undefined =
          asRecord(params.providerOptions) ?? undefined;
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

        const initialGoogleStreamOptions = buildGoogleStreamOptions(
          resolved.model.id,
          stepProviderOptions ?? asRecord(params.config.providerOptions) ?? undefined,
          params.abortSignal,
          resolved.apiKey,
        );
        const initialRequestFingerprint = buildGoogleRequestFingerprint({
          modelId: resolved.model.id,
          system: params.system,
          tools: piTools,
          streamOptions: initialGoogleStreamOptions,
        });
        const matchingProviderState = messagesHaveDisabledGoogleCodeExecution(
          params.allMessages ?? params.messages,
        )
          ? null
          : matchingGoogleProviderState(params, resolved.model.id);
        const requestContextChanged = googleContinuationRequestContextChanged(
          matchingProviderState,
          initialRequestFingerprint,
        );
        const activeProviderState = requestContextChanged ? null : matchingProviderState;
        if (isGoogleContinuationState(params.providerState) && !matchingProviderState) {
          params.log?.(
            "google-interactions: Not reusing stored continuation because model or history is incompatible.",
          );
        } else if (requestContextChanged) {
          params.log?.(
            "google-interactions: Not reusing stored continuation because request context changed; replaying transcript.",
          );
        }
        let previousInteractionId: string | undefined = activeProviderState?.interactionId;
        let stepMessages: ModelMessage[] = activeProviderState
          ? (() => {
              const deltaMessages = messagesAfterLastAssistant(params.messages);
              return deltaMessages.length > 0 ? deltaMessages : [...params.messages];
            })()
          : [...(params.allMessages ?? params.messages)];

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
            stepMessages,
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

          const requestFingerprint = buildGoogleRequestFingerprint({
            modelId: resolved.model.id,
            system: params.system,
            tools: piTools,
            streamOptions: mergedStreamOptions,
          });
          params.log?.(
            `google-interactions: calling ${resolved.model.id} step=${step + 1} previous=${previousInteractionId ? "yes" : "no"} tools=${piTools.length}`,
          );

          const callGoogleStep = async (messages: ModelMessage[], previousId?: string) =>
            await runStepImpl({
              model: resolved.model,
              apiKey: asNonEmptyString(mergedStreamOptions.apiKey as unknown) ?? resolved.apiKey,
              systemPrompt: params.system,
              messages,
              tools: piTools,
              streamOptions: mergedStreamOptions as any,
              previousInteractionId: previousId,
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

          const retryWithTextOnlyReplay = async (messages: ModelMessage[], error: unknown) => {
            const sanitizedMessages = sanitizeGoogleReplayMessages(messages);
            if (
              sanitizedMessages.length === 0 ||
              !googleReplayMessagesWereSanitized(messages, sanitizedMessages)
            ) {
              markModelCallSpanError(span, error);
              throw error;
            }
            params.log?.(
              "google-interactions: request is not implemented for full replay; retrying with text-only replay.",
            );
            return await callGoogleStep(sanitizedMessages, undefined);
          };

          let assistantRecord: Record<string, unknown> = {};
          let interactionId: string | undefined;
          let requestMessages: ModelMessage[] = stepMessages;
          try {
            const requestStartIndex = Math.min(nextInteractionInputStartIndex, stepMessages.length);
            requestMessages = previousInteractionId
              ? stepMessages.slice(requestStartIndex)
              : stepMessages;
            let result: Awaited<ReturnType<RunGoogleNativeInteractionStep>> | undefined;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                result = await callGoogleStep(
                  requestMessages.length > 0 ? requestMessages : stepMessages,
                  previousInteractionId,
                );
                break;
              } catch (error) {
                if (
                  previousInteractionId ||
                  attempt >= 2 ||
                  !isRetryableGoogleInteractionError(error)
                ) {
                  throw error;
                }
                params.log?.(
                  `google-interactions: transient model call failure (${classifyGoogleInteractionError(error)}), retrying attempt ${attempt + 2}/3`,
                );
                await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
              }
            }
            if (!result) throw new Error("Google Interactions model call did not return a result.");
            assistantRecord = asRecord(result.assistant) ?? {};
            interactionId = result.interactionId;
            markModelCallSpanSuccess(span, telemetry, assistantRecord);
          } catch (error) {
            if (previousInteractionId && isInvalidGoogleContinuationError(error)) {
              params.log?.(
                "google-interactions: Stateful request failed. Retrying with clean state.",
              );
              previousInteractionId = undefined;
              const cleanStateMessages = activeProviderState
                ? [...(params.allMessages ?? params.messages)]
                : stepMessages;
              let result: Awaited<ReturnType<RunGoogleNativeInteractionStep>>;
              try {
                result = await callGoogleStep(cleanStateMessages, undefined);
              } catch (cleanStateError) {
                if (!isGoogleNotImplementedError(cleanStateError)) {
                  markModelCallSpanError(span, cleanStateError);
                  throw cleanStateError;
                }
                result = await retryWithTextOnlyReplay(cleanStateMessages, cleanStateError);
              }
              assistantRecord = asRecord(result.assistant) ?? {};
              interactionId = result.interactionId;
              markModelCallSpanSuccess(span, telemetry, assistantRecord);
            } else if (!previousInteractionId && isGoogleNotImplementedError(error)) {
              const result = await retryWithTextOnlyReplay(requestMessages, error);
              assistantRecord = asRecord(result.assistant) ?? {};
              interactionId = result.interactionId;
              markModelCallSpanSuccess(span, telemetry, assistantRecord);
            } else {
              markModelCallSpanError(span, error);
              throw error;
            }
          }

          turnMessages.push(assistantRecord);
          usage = mergePiUsage(usage, assistantRecord.usage);
          finalProviderState =
            nextGoogleProviderState(resolved.model.id, interactionId, requestFingerprint) ??
            finalProviderState;
          previousInteractionId = interactionId ?? previousInteractionId;
          const assistantModelMessages = googleTurnMessagesToModelMessages([assistantRecord]);
          stepMessages = [...stepMessages, ...assistantModelMessages];
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
            const errorMessage =
              asString(assistantRecord.errorMessage) ??
              "Google Interactions runtime model stream failed.";
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
        if (error && typeof error === "object") {
          try {
            (error as any).usage = usage;
            const responseMessages =
              typeof turnMessages !== "undefined" && Array.isArray(turnMessages)
                ? googleTurnMessagesToModelMessages(turnMessages)
                : [];
            Object.defineProperty(error, "responseMessages", {
              value: responseMessages,
              configurable: true,
              writable: true,
            });
            if (typeof finalProviderState !== "undefined" && finalProviderState) {
              Object.defineProperty(error, "providerState", {
                value: finalProviderState,
                configurable: true,
                writable: true,
              });
            }
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
