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
import { getBasetenModelSpec, resolveBasetenApiKey } from "../providers/basetenShared";
import { prepareLmStudioModelMetadataForInference } from "../providers/lmstudio/catalog";
import { lmStudioOpenAiBaseUrl } from "../providers/lmstudio/client";
import { getNvidiaModelSpec, resolveNvidiaApiKey } from "../providers/nvidiaShared";
import {
  getOpenCodeModelPricing,
  getOpenCodeModelSpec,
  getOpenCodeProviderConfig,
  isOpenCodeModelSupportedByProvider,
  isOpenCodeProviderName,
  resolveOpenCodeApiKey,
  type OpenCodeProviderName,
} from "../providers/opencodeShared";
import { getTogetherModelSpec, resolveTogetherApiKey } from "../providers/togetherShared";
import type { ModelMessage, ProviderName } from "../types";
import { getResolvedModelMetadataSync } from "../models/metadata";
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
import { maybeSpillToolOutputToWorkspace } from "./toolOutputOverflow";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeStepOverride, RuntimeToolDefinition } from "./types";

const LM_STUDIO_LOCAL_SENTINEL_API_KEY = "lmstudio-local";

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

const VALID_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const INVALID_TOOL_CALL_FORMAT_REMINDER =
  "Possible invalid tool call format detected. Use the exact tool name from the provided tool list and pass arguments as a structured object matching that tool schema. Do not include XML tags, arg markers, or prose in the tool name.";

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

export type ResolvedPiRuntimeModel = {
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
  accountId?: string;
};

const PI_PLACEHOLDER_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

function preparePiModelForStream(model: PiModel): PiModel {
  if (model.cost) return model;
  return {
    ...model,
    cost: { ...PI_PLACEHOLDER_COST },
  };
}

function stripPlaceholderCostFromAssistantRecord(
  assistant: Record<string, unknown>,
  model: PiModel,
): Record<string, unknown> {
  if (model.cost) return assistant;
  const usage = asRecord(assistant.usage);
  if (!usage || !("cost" in usage)) return assistant;
  const nextUsage = { ...usage };
  delete nextUsage.cost;
  return {
    ...assistant,
    usage: nextUsage,
  };
}

function applySupportedModelMetadata(model: PiModel, provider: ProviderName, modelId: string): PiModel {
  const supported = getResolvedModelMetadataSync(provider, modelId, "model");
  const input: Array<"text" | "image"> = supported.supportsImageInput ? ["text", "image"] : ["text"];
  return {
    ...model,
    id: supported.id,
    name: supported.displayName,
    input,
  };
}

function safeLmStudioMaxTokens(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow / 4));
}

function buildLmStudioPiModel(opts: {
  metadata: ReturnType<typeof getResolvedModelMetadataSync>;
  baseUrl: string;
}): PiModel {
  const contextWindow = opts.metadata.effectiveContextLength ?? opts.metadata.maxContextLength ?? 8192;
  return {
    id: opts.metadata.id,
    name: opts.metadata.displayName,
    api: "openai-completions",
    provider: "lmstudio",
    baseUrl: lmStudioOpenAiBaseUrl(opts.baseUrl),
    reasoning: false,
    input: opts.metadata.supportsImageInput ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens: safeLmStudioMaxTokens(contextWindow),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  };
}

function getOpenCodePiModel(provider: OpenCodeProviderName, modelId: string): PiModel | null {
  if (!isOpenCodeModelSupportedByProvider(provider, modelId)) return null;
  const modelSpec = getOpenCodeModelSpec(modelId);
  if (!modelSpec) return null;
  const pricing = getOpenCodeModelPricing(provider, modelId);

  const providerConfig = getOpenCodeProviderConfig(provider);
  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "opencode",
    baseUrl: providerConfig.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    ...(pricing
      ? {
          cost: {
            input: pricing.input,
            output: pricing.output,
            cacheRead: pricing.cacheRead,
            cacheWrite: pricing.cacheWrite,
          },
        }
      : {}),
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

function getBasetenPiModel(modelId: string): PiModel | null {
  const modelSpec = getBasetenModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "baseten",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    ...(modelSpec.pricing
      ? {
          cost: {
            input: modelSpec.pricing.input,
            output: modelSpec.pricing.output,
            cacheRead: 0,
            cacheWrite: 0,
          },
        }
      : {}),
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

function getTogetherPiModel(modelId: string): PiModel | null {
  const modelSpec = getTogetherModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "together",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    cost: {
      input: modelSpec.pricing.input,
      output: modelSpec.pricing.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

function getNvidiaPiModel(modelId: string): PiModel | null {
  const modelSpec = getNvidiaModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "nvidia",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
    compat: { ...modelSpec.compat },
  };
}

function isNvidiaChatCompletionsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://integrate.api.nvidia.com" && url.pathname === "/v1/chat/completions";
  } catch {
    return false;
  }
}

function normalizeNvidiaChatCompletionsBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  delete next.store;
  delete next.max_tokens;
  delete next.max_completion_tokens;
  delete next.reasoning_budget;
  delete next.reasoning_effort;
  delete next.enable_thinking;

  const chatTemplateKwargs = asRecord(body.chat_template_kwargs) ?? {};
  next.chat_template_kwargs = {
    ...chatTemplateKwargs,
    enable_thinking: true,
  };
  return next;
}

function requestUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function decodeRequestBody(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return null;
}

async function maybeRewriteNvidiaFetchRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[RequestInfo | URL, RequestInit | undefined]> {
  const url = requestUrlFromFetchInput(input);
  if (!isNvidiaChatCompletionsUrl(url)) {
    return [input, init];
  }

  let rawBody = decodeRequestBody(init?.body);
  if (!rawBody && input instanceof Request && init?.body === undefined) {
    rawBody = await input.clone().text();
  }
  if (!rawBody) {
    return [input, init];
  }

  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = asRecord(JSON.parse(rawBody));
  } catch {
    parsedBody = null;
  }
  if (!parsedBody) {
    return [input, init];
  }

  const rewrittenBody = JSON.stringify(normalizeNvidiaChatCompletionsBody(parsedBody));
  if (input instanceof Request && init === undefined) {
    return [new Request(input, { body: rewrittenBody }), undefined];
  }
  return [input, { ...(init ?? {}), body: rewrittenBody }];
}

const NVIDIA_FETCH_PATCH_STATE = Symbol.for("cowork.nvidia.fetchPatchState");

type NvidiaFetchPatchState = {
  refCount: number;
  originalFetch: typeof fetch;
};

async function withPatchedNvidiaFetch<T>(run: () => Promise<T>): Promise<T> {
  const globalWithState = globalThis as typeof globalThis & {
    [NVIDIA_FETCH_PATCH_STATE]?: NvidiaFetchPatchState;
  };
  const existingState = globalWithState[NVIDIA_FETCH_PATCH_STATE];
  if (existingState) {
    existingState.refCount += 1;
    try {
      return await run();
    } finally {
      existingState.refCount -= 1;
      if (existingState.refCount === 0) {
        globalThis.fetch = existingState.originalFetch;
        delete globalWithState[NVIDIA_FETCH_PATCH_STATE];
      }
    }
  }

  const originalFetch = globalThis.fetch;
  const wrappedFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const [nextInput, nextInit] = await maybeRewriteNvidiaFetchRequest(input, init);
      return originalFetch.call(globalThis, nextInput as any, nextInit as any);
    },
    originalFetch,
  );

  globalThis.fetch = wrappedFetch as typeof fetch;
  globalWithState[NVIDIA_FETCH_PATCH_STATE] = {
    refCount: 1,
    originalFetch,
  };

  try {
    return await run();
  } finally {
    const currentState = globalWithState[NVIDIA_FETCH_PATCH_STATE];
    if (currentState) {
      currentState.refCount -= 1;
      if (currentState.refCount === 0) {
        globalThis.fetch = currentState.originalFetch;
        delete globalWithState[NVIDIA_FETCH_PATCH_STATE];
      }
    }
  }
}

type RuntimeStepOverrides = RuntimeStepOverride;

type RuntimeStepState = {
  modelMessages: ModelMessage[];
  providerOptions: Record<string, unknown> | undefined;
  streamOptions: Record<string, unknown>;
  piMessages: Array<Record<string, unknown>>;
};

export async function resolvePiModel(params: RuntimeRunTurnParams): Promise<ResolvedPiRuntimeModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;

  if (provider === "openai") {
    const model = pickKnownPiModel("openai", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider openai (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: getSavedProviderApiKey(params.config, "openai"),
    };
  }

  if (provider === "google") {
    const model = pickKnownPiModel("google", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider google (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: getSavedProviderApiKey(params.config, "google"),
    };
  }

  if (provider === "anthropic") {
    const model = pickKnownPiModel("anthropic", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider anthropic (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: getSavedProviderApiKey(params.config, "anthropic"),
    };
  }

  if (provider === "baseten") {
    const model = getBasetenPiModel(modelId);
    if (!model) throw new Error(`No PI model metadata available for provider baseten (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveBasetenApiKey({
        savedKey: getSavedProviderApiKey(params.config, "baseten"),
      }),
    };
  }

  if (provider === "together") {
    const model = getTogetherPiModel(modelId);
    if (!model) throw new Error(`No PI model metadata available for provider together (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveTogetherApiKey({
        savedKey: getSavedProviderApiKey(params.config, "together"),
      }),
    };
  }

  if (provider === "nvidia") {
    const model = getNvidiaPiModel(modelId);
    if (!model) throw new Error(`No PI model metadata available for provider nvidia (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveNvidiaApiKey({
        savedKey: getSavedProviderApiKey(params.config, "nvidia"),
      }),
    };
  }

  if (provider === "lmstudio") {
    const prepared = await prepareLmStudioModelMetadataForInference({
      modelId,
      providerOptions: params.providerOptions ?? params.config.providerOptions,
      log: params.log,
    });
    const configuredApiKey = prepared.provider.apiKey ?? getSavedProviderApiKey(params.config, "lmstudio");
    return {
      model: buildLmStudioPiModel({
        metadata: prepared.metadata,
        baseUrl: prepared.provider.baseUrl,
      }),
      // pi-ai's OpenAI-compatible client refuses to initialize without a truthy apiKey,
      // even for local endpoints that do not require authentication.
      apiKey: configuredApiKey ?? LM_STUDIO_LOCAL_SENTINEL_API_KEY,
      ...(configuredApiKey
        ? {
            headers: {
              authorization: `Bearer ${configuredApiKey}`,
            },
          }
        : {}),
    };
  }

  if (isOpenCodeProviderName(provider)) {
    const model = getOpenCodePiModel(provider, modelId);
    if (!model) throw new Error(`No PI model metadata available for provider ${provider} (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveOpenCodeApiKey(provider, {
        savedKey: getSavedProviderApiKey(params.config, provider),
      }),
    };
  }

  if (provider === "codex-cli") {
    throw new Error("codex-cli is handled by the OpenAI Responses runtime model resolver.");
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
  return Object.entries(tools).flatMap(([name, def]) => {
    const toolRecord = asRecord(def);
    if (!toolRecord) return [];

    return [{
      name,
      description: asNonEmptyString(toolRecord.description) ?? name,
      parameters: toPiJsonSchema(toolRecord.inputSchema),
    }];
  });
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

    const overflow = await maybeSpillToolOutputToWorkspace({
      output: result,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      workingDirectory: params.config.workingDirectory,
      toolOutputOverflowChars: params.config.toolOutputOverflowChars,
      log: params.log,
    });
    const emittedOutput = overflow?.output ?? result;
    const content = toolResultContentFromOutput(emittedOutput);
    await emitPart({
      type: "tool-result",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: emittedOutput,
    });
    if (overflow) {
      await emitPart({
        type: "file",
        file: overflow.file,
      });
    }
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content,
      details: asRecord(emittedOutput) ?? emittedOutput,
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

export function shouldAddInvalidToolCallFormatReminder(
  toolCall: PiToolCallLike,
  toolResult: Record<string, unknown>,
  tools: RuntimeRunTurnParams["tools"],
): boolean {
  if (toolResult.isError !== true) return false;

  const toolName = toolCall.name.trim();
  const errorMessage = extractToolExecutionErrorMessage(toolResult)?.trim() ?? "";
  if (!toolName || !errorMessage) return false;

  const hasKnownTool = Object.prototype.hasOwnProperty.call(tools, toolName);
  if (!hasKnownTool) {
    if (!VALID_TOOL_NAME_PATTERN.test(toolName)) return true;
    if (/^tool(?:[<\s]|$)/i.test(toolName)) return true;
    if (/[<>]/.test(toolName) || /arg_(?:key|value)|tool_call/i.test(toolName)) return true;
    return toolName === "tool" && /tool .* not found/i.test(errorMessage);
  }

  const input = asRecord(toolCall.arguments);
  const inputKeys = input ? Object.keys(input) : [];
  return inputKeys.length === 0 && /invalid input|expected .* received|too small:/i.test(errorMessage);
}

export function buildInvalidToolCallFormatReminderMessage(): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: INVALID_TOOL_CALL_FORMAT_REMINDER }],
  };
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
  normalizeNvidiaChatCompletionsBody,
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
            const runModelStep = async () => {
              const stream = piStreamImpl(
                preparePiModelForStream(resolved.model) as any,
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

          stepMessages = [
            ...stepMessages,
            ...toolResultMessages,
          ];
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
