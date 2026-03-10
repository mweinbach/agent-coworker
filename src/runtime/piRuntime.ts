import { SpanStatusCode, trace, type AttributeValue, type Span } from "@opentelemetry/api";
import { stream as piStream } from "@mariozechner/pi-ai";
import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asString,
  buildPiStreamOptions,
  extractToolCallsFromAssistant,
  isZodSchema,
  pickKnownPiModel,
  toPiJsonSchema,
  type PiModel,
  type PiToolCallLike,
} from "./piRuntimeOptions";
import { mapPiEventToRawParts } from "./piStreamParts";

import { getSavedProviderApiKey } from "../config";
import { getAiCoworkerPaths } from "../connect";
import {
  CODEX_BACKEND_BASE_URL,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterialCoalesced,
} from "../providers/codex-auth";
import type { AgentConfig, ModelMessage, ProviderName } from "../types";
import type { TelemetrySettings } from "../observability/runtime";
import {
  continuationMatchesTarget,
  type OpenAiContinuationProvider,
  type OpenAiContinuationState,
} from "../shared/openaiContinuation";

import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  normalizePiUsage,
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
  toolResultContentFromOutput,
} from "./piMessageBridge";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeStepOverride, RuntimeToolDefinition } from "./types";
import { resolveCoworkHomedir } from "../utils/coworkHome";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactTelemetrySecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactTelemetrySecrets(entry, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    const sensitive =
      normalized.includes("api_key") ||
      normalized.includes("apikey") ||
      normalized.includes("authorization") ||
      normalized.includes("access_token") ||
      normalized.includes("refresh_token") ||
      normalized.includes("id_token") ||
      normalized === "token";
    out[key] = sensitive ? "[REDACTED]" : redactTelemetrySecrets(raw, seen);
  }
  return out;
}

function isModelMessageArray(value: unknown): value is ModelMessage[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    const record = asRecord(entry);
    return !!record && typeof record.role === "string" && "content" in record;
  });
}

export function splitStepOverrides(raw: unknown): RuntimeStepOverrides {
  const parsed = asRecord(raw);
  if (!parsed) return {};

  const messages = isModelMessageArray(parsed.messages) ? parsed.messages : undefined;
  const providerOptions = asRecord(parsed.providerOptions) ?? undefined;
  const explicitStreamOptions = asRecord(parsed.streamOptions);

  const streamOptions: Record<string, unknown> = explicitStreamOptions ? { ...explicitStreamOptions } : {};
  if (!explicitStreamOptions) {
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "messages" || key === "providerOptions") continue;
      streamOptions[key] = value;
    }
  }

  return {
    ...(messages ? { messages } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(Object.keys(streamOptions).length > 0 ? { streamOptions } : {}),
  };
}

export function buildStepState(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
  overrides: RuntimeStepOverrides,
  fallbackMessages: ModelMessage[]
): RuntimeStepState {
  const modelMessages = overrides.messages ?? fallbackMessages;
  const providerOptions = overrides.providerOptions ?? params.providerOptions;
  const baseStreamOptions = buildPiStreamOptions(
    { ...params, providerOptions } as RuntimeRunTurnParams,
    resolved.apiKey,
    resolved.headers
  );
  const streamOptions = {
    ...baseStreamOptions,
    ...(overrides.streamOptions ?? {}),
  };
  return {
    modelMessages,
    providerOptions,
    streamOptions,
    piMessages: modelMessagesToPiMessages(modelMessages, params.config.provider) as unknown as Array<Record<string, unknown>>,
  };
}

export function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("abort") || message.includes("cancel");
  }
  return false;
}

function runtimeHomeFromConfig(config: AgentConfig): string | undefined {
  return resolveCoworkHomedir(config.userAgentDir);
}

export type ResolvedPiRuntimeModel = {
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
  accountId?: string;
};

type ResolvedCodexAuth = {
  accessToken: string;
  accountId?: string;
};

type RuntimeStepOverrides = RuntimeStepOverride;

type RuntimeStepState = {
  modelMessages: ModelMessage[];
  providerOptions: Record<string, unknown> | undefined;
  streamOptions: Record<string, unknown>;
  piMessages: Array<Record<string, unknown>>;
};

async function resolveCodexAccessToken(
  config: AgentConfig,
  log?: (line: string) => void
): Promise<ResolvedCodexAuth> {
  const paths = getAiCoworkerPaths({ homedir: runtimeHomeFromConfig(config) });
  let material = await readCodexAuthMaterial(paths);
  if (!material?.accessToken) {
    throw new Error("Codex auth is missing. Run /connect codex-cli to authenticate.");
  }

  if (isTokenExpiring(material) && material.refreshToken) {
    try {
      material = await refreshCodexAuthMaterialCoalesced({
        paths,
        material,
        fetchImpl: fetch,
      });
      log?.("[auth] refreshed Codex runtime token");
    } catch (error) {
      log?.(`[warn] failed to refresh Codex runtime token: ${String(error)}`);
    }
  }

  if (isTokenExpiring(material, 0)) {
    throw new Error("Codex token is expired. Run /connect codex-cli to re-authenticate.");
  }

  const accountId = material.accountId?.trim();
  return {
    accessToken: material.accessToken,
    ...(accountId ? { accountId } : {}),
  };
}

export async function resolvePiModel(params: RuntimeRunTurnParams): Promise<ResolvedPiRuntimeModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;

  if (provider === "openai") {
    const model = pickKnownPiModel("openai", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider openai (model: ${modelId}).`);
    return {
      model,
      apiKey: getSavedProviderApiKey(params.config, "openai"),
    };
  }

  if (provider === "google") {
    const model = pickKnownPiModel("google", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider google (model: ${modelId}).`);
    return {
      model,
      apiKey: getSavedProviderApiKey(params.config, "google"),
    };
  }

  if (provider === "anthropic") {
    const model = pickKnownPiModel("anthropic", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider anthropic (model: ${modelId}).`);
    return {
      model,
      apiKey: getSavedProviderApiKey(params.config, "anthropic"),
    };
  }

  if (provider === "codex-cli") {
    const savedKey = getSavedProviderApiKey(params.config, "codex-cli");
    if (savedKey) {
      const openaiModel = pickKnownPiModel("openai", modelId);
      if (!openaiModel) {
        throw new Error(`No PI model metadata available for provider codex-cli/openai (model: ${modelId}).`);
      }
      return {
        model: {
          ...openaiModel,
          id: modelId,
          name: modelId,
          provider: "openai",
          api: "openai-responses",
        },
        apiKey: savedKey,
      };
    }

    const codexModel = pickKnownPiModel("openai-codex", modelId);
    if (!codexModel) {
      throw new Error(`No PI model metadata available for provider codex-cli/openai-codex (model: ${modelId}).`);
    }
    const codexAuth = await resolveCodexAccessToken(params.config, params.log);
    const codexHeaders = codexAuth.accountId
      ? { "ChatGPT-Account-ID": codexAuth.accountId }
      : undefined;

    return {
      model: {
        ...codexModel,
        id: modelId,
        name: modelId,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: CODEX_BACKEND_BASE_URL,
        ...(codexHeaders ? { headers: { ...(codexModel.headers ?? {}), ...codexHeaders } } : {}),
      },
      apiKey: codexAuth.accessToken,
      ...(codexAuth.accountId ? { accountId: codexAuth.accountId } : {}),
      ...(codexHeaders ? { headers: codexHeaders } : {}),
    };
  }

  const exhaustive: never = provider;
  throw new Error(`Unsupported provider for PI runtime: ${String(exhaustive)}`);
}

export function parseTelemetrySettings(raw: unknown): TelemetrySettings | undefined {
  const parsed = asRecord(raw);
  if (!parsed || parsed.isEnabled !== true) return undefined;

  const metadataInput = asRecord(parsed.metadata);
  const metadata: Record<string, AttributeValue> = {};
  if (metadataInput) {
    for (const [key, value] of Object.entries(metadataInput)) {
      if (typeof value === "string" || typeof value === "boolean") {
        metadata[key] = value;
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        metadata[key] = value;
      }
    }
  }

  return {
    isEnabled: true,
    recordInputs: parsed.recordInputs === true,
    recordOutputs: parsed.recordOutputs === true,
    functionId: asNonEmptyString(parsed.functionId),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function startModelCallSpan(
  telemetry: TelemetrySettings | undefined,
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
  stepNumber: number,
  stepOptions: Record<string, unknown>,
  piMessages: unknown,
  runtimeLabel = "pi",
  defaultFunctionId = "agent.runtime.pi.model_call",
): Span | null {
  if (!telemetry?.isEnabled) return null;

  const attributes: Record<string, AttributeValue> = {
    "llm.runtime": runtimeLabel,
    "llm.provider": params.config.provider,
    "llm.model": resolved.model.id,
    "llm.step_number": stepNumber,
    ...(telemetry.metadata ?? {}),
  };

  if (telemetry.recordInputs) {
    attributes["llm.input.system"] = params.system;
    attributes["llm.input.messages"] = safeJsonStringify(piMessages);
    attributes["llm.input.options"] = safeJsonStringify(redactTelemetrySecrets(stepOptions));
  }

  return trace
    .getTracer("agent-coworker.runtime")
    .startSpan(telemetry.functionId ?? defaultFunctionId, { attributes });
}

export function markModelCallSpanSuccess(
  span: Span | null,
  telemetry: TelemetrySettings | undefined,
  assistantRecord: Record<string, unknown>
): void {
  if (!span) return;

  if (telemetry?.recordOutputs) {
    span.setAttribute("llm.output.stop_reason", asString(assistantRecord.stopReason) ?? "unknown");
    span.setAttribute("llm.output.response", safeJsonStringify(assistantRecord));
  }

  const usage = asRecord(assistantRecord.usage);
  const input = asFiniteNumber(usage?.input);
  const output = asFiniteNumber(usage?.output);
  const total = asFiniteNumber(usage?.totalTokens);
  if (input !== undefined) span.setAttribute("llm.usage.input_tokens", input);
  if (output !== undefined) span.setAttribute("llm.usage.output_tokens", output);
  if (total !== undefined) span.setAttribute("llm.usage.total_tokens", total);

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function markModelCallSpanError(span: Span | null, error: unknown): void {
  if (!span) return;
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  if (error instanceof Error) {
    span.recordException(error);
  }
  span.end();
}

export function toolMapToPiTools(tools: RuntimeRunTurnParams["tools"]): Array<Record<string, unknown>> {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description ?? name,
    parameters: toPiJsonSchema(def.inputSchema),
  }));
}

function validateToolInput(def: RuntimeToolDefinition, input: unknown): unknown {
  if (!isZodSchema(def.inputSchema)) return input;
  const parsed = def.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(issue?.message ?? "Invalid tool input.");
}

function extractToolExecutionErrorMessage(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record || record.isError !== true) return undefined;

  const contentParts = Array.isArray(record.content) ? record.content : [];
  const contentText = contentParts
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return asString(partRecord.text) ?? "";
    })
    .join("\n")
    .trim();
  if (contentText) return contentText;

  const explicitMessage = asNonEmptyString(record.error) ?? asNonEmptyString(record.message);
  if (explicitMessage) return explicitMessage;

  return safeJsonStringify(result);
}

export function messagesAfterLastAssistant(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const record = asRecord(messages[i]);
    if (record?.role === "assistant") {
      return messages.slice(i + 1);
    }
  }
  return [...messages];
}

function continuationTarget(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): { provider: OpenAiContinuationProvider; model: string; accountId?: string } {
  return {
    provider: params.config.provider as OpenAiContinuationProvider,
    model: params.config.model,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

export function supportsProviderManagedContinuation(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): boolean {
  if (params.config.provider === "openai") return true;
  if (params.config.provider !== "codex-cli") return false;
  return resolved.model.api === "openai-responses";
}

export function matchingProviderState(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): OpenAiContinuationState | null {
  if (!supportsProviderManagedContinuation(params, resolved)) {
    return null;
  }
  const providerState = params.providerState ?? null;
  if (!providerState) return null;
  return continuationMatchesTarget(providerState, continuationTarget(params, resolved)) ? providerState : null;
}

export function buildInitialStepMessages(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): ModelMessage[] {
  if (!supportsProviderManagedContinuation(params, resolved)) {
    return [...(params.allMessages ?? params.messages)];
  }
  const providerState = matchingProviderState(params, resolved);
  if (providerState) {
    const deltaMessages = messagesAfterLastAssistant(params.messages);
    return deltaMessages.length > 0 ? deltaMessages : [...params.messages];
  }
  return [...(params.allMessages ?? params.messages)];
}

export function nextProviderState(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
  responseId?: string,
): OpenAiContinuationState | undefined {
  if (!supportsProviderManagedContinuation(params, resolved)) {
    return undefined;
  }
  const nextResponseId = responseId?.trim();
  if (!nextResponseId) return undefined;

  return {
    provider: params.config.provider as OpenAiContinuationProvider,
    model: params.config.model,
    responseId: nextResponseId,
    updatedAt: new Date().toISOString(),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

export async function emitPiEventAsRawPart(
  event: any,
  provider: ProviderName,
  includeUnknown: boolean,
  emit: (part: unknown) => Promise<void>
): Promise<void> {
  for (const part of mapPiEventToRawParts(event, provider, includeUnknown)) {
    await emit(part);
  }
}

export async function executeToolCall(
  toolCall: PiToolCallLike,
  params: RuntimeRunTurnParams,
  emitPart: (part: unknown) => Promise<void>
): Promise<Record<string, unknown>> {
  if (params.abortSignal?.aborted) {
    throw new Error("Model turn aborted.");
  }

  const toolDef = params.tools[toolCall.name];
  if (!toolDef) {
    const result = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: `Tool ${toolCall.name} not found` }],
      isError: true,
      timestamp: Date.now(),
    };
    await emitPart({
      type: "tool-error",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      error: `Tool ${toolCall.name} not found`,
    });
    return result;
  }

  try {
    const parsedInput = validateToolInput(toolDef, toolCall.arguments);
    const result = await toolDef.execute(parsedInput);
    const executionError = extractToolExecutionErrorMessage(result);
    if (executionError) {
      await emitPart({
        type: "tool-error",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        error: executionError,
      });
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: executionError }],
        details: asRecord(result) ?? result,
        isError: true,
        timestamp: Date.now(),
      };
    }

    const content = toolResultContentFromOutput(result);
    await emitPart({
      type: "tool-result",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: result,
    });
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content,
      details: asRecord(result) ?? result,
      isError: false,
      timestamp: Date.now(),
    };
  } catch (error) {
    if (isAbortLikeError(error, params.abortSignal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await emitPart({
      type: "tool-error",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      error: message,
    });
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: message }],
      isError: true,
      timestamp: Date.now(),
    };
  }
}

type PiRuntimeOverrides = {
  piStreamImpl?: typeof piStream;
};

export const __internal = {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  buildStepState,
  redactTelemetrySecrets,
  splitStepOverrides,
  emitPiEventAsRawPart,
  extractToolExecutionErrorMessage,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  messagesAfterLastAssistant,
  matchingProviderState,
  buildInitialStepMessages,
  nextProviderState,
  parseTelemetrySettings,
  resolvePiModel,
  startModelCallSpan,
  toolMapToPiTools,
  toPiJsonSchema,
} as const;

export function createPiRuntime(overrides: PiRuntimeOverrides = {}): LlmRuntime {
  const piStreamImpl = overrides.piStreamImpl ?? piStream;
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
        let stepMessages: ModelMessage[] = [...params.messages];
        let stepProviderOptions: Record<string, unknown> | undefined = asRecord(params.providerOptions) ?? undefined;

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
            stepState.piMessages
          );
          let assistantRecord: Record<string, unknown> = {};
          try {
            const stream = piStreamImpl(
              resolved.model as any,
              {
                systemPrompt: params.system,
                messages: stepState.piMessages as any,
                tools: piTools as any,
              },
              stepState.streamOptions as any
            );

            for await (const event of stream as any) {
              await emitPiEventAsRawPart(event, params.config.provider, includeUnknownRawParts, emitPart);
            }

            const assistant = await (stream as any).result();
            assistantRecord = asRecord(assistant) ?? {};
            markModelCallSpanSuccess(span, telemetry, assistantRecord);
          } catch (error) {
            markModelCallSpanError(span, error);
            throw error;
          }

          turnMessages.push(assistantRecord);
          usage = mergePiUsage(usage, assistantRecord.usage);
          stepMessages = [
            ...stepMessages,
            ...piTurnMessagesToModelMessages([assistantRecord as any]),
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
            const errorMessage = asString(assistantRecord.errorMessage) ?? "PI runtime model stream failed.";
            throw new Error(errorMessage);
          }

          const toolCalls = extractToolCallsFromAssistant(assistantRecord);
          if (toolCalls.length === 0) {
            break;
          }

          for (const toolCall of toolCalls) {
            if (params.abortSignal?.aborted) {
              throw new Error("Model turn aborted.");
            }
            const toolResult = await executeToolCall(toolCall, params, emitPart);
            turnMessages.push(toolResult);
            const responseToolMessages = piTurnMessagesToModelMessages([toolResult as any]);
            stepMessages = [
              ...stepMessages,
              ...responseToolMessages,
            ];
          }
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
