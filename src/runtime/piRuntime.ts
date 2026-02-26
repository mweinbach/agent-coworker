import path from "node:path";

import { getModel as getPiModel, getModels as getPiModels, stream as piStream } from "@mariozechner/pi-ai";
import { z } from "zod";

import { getSavedProviderApiKey } from "../config";
import { getAiCoworkerPaths } from "../connect";
import {
  CODEX_BACKEND_BASE_URL,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
} from "../providers/codex-auth";
import type { AgentConfig, ProviderName } from "../types";

import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeToolDefinition } from "./types";

type PiModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("abort") || message.includes("cancel");
  }
  return false;
}

function runtimeHomeFromConfig(config: AgentConfig): string | undefined {
  if (typeof config.userAgentDir === "string" && config.userAgentDir) {
    const marker = `${path.sep}.agent`;
    const idx = config.userAgentDir.lastIndexOf(marker);
    if (idx > 0) return config.userAgentDir.slice(0, idx);
  }
  return undefined;
}

function pickKnownPiModel(provider: string, modelId: string): PiModel | null {
  const direct = getPiModel(provider as any, modelId as any) as unknown;
  const directRecord = asRecord(direct);
  if (directRecord) {
    return directRecord as unknown as PiModel;
  }
  const fallbackModels = getPiModels(provider as any) as unknown;
  if (!Array.isArray(fallbackModels) || fallbackModels.length === 0) return null;
  const fallbackRecord = asRecord(fallbackModels[0]);
  if (!fallbackRecord) return null;

  return {
    ...(fallbackRecord as unknown as PiModel),
    id: modelId,
    name: modelId,
  };
}

type ResolvedPiRuntimeModel = {
  model: PiModel;
  apiKey?: string;
};

async function resolveCodexAccessToken(config: AgentConfig, log?: (line: string) => void): Promise<string> {
  const paths = getAiCoworkerPaths({ homedir: runtimeHomeFromConfig(config) });
  let material = await readCodexAuthMaterial(paths, { migrateLegacy: true });
  if (!material?.accessToken) {
    throw new Error("Codex auth is missing. Run /connect codex-cli to authenticate.");
  }

  if (isTokenExpiring(material) && material.refreshToken) {
    try {
      material = await refreshCodexAuthMaterial({
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

  return material.accessToken;
}

async function resolvePiModel(params: RuntimeRunTurnParams): Promise<ResolvedPiRuntimeModel> {
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
    return {
      model: {
        ...codexModel,
        id: modelId,
        name: modelId,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: CODEX_BACKEND_BASE_URL,
      },
      apiKey: await resolveCodexAccessToken(params.config, params.log),
    };
  }

  const exhaustive: never = provider;
  throw new Error(`Unsupported provider for PI runtime: ${String(exhaustive)}`);
}

function providerSectionForPi(provider: ProviderName, providerOptions?: Record<string, any>): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object") return {};
  if (provider === "codex-cli") {
    const codex = asRecord(providerOptions["codex-cli"]);
    if (codex) return codex;
    return asRecord(providerOptions.openai) ?? {};
  }
  if (provider === "google") {
    return asRecord(providerOptions.google) ?? asRecord(providerOptions.vertex) ?? {};
  }
  return asRecord(providerOptions[provider]) ?? {};
}

function toGoogleThinkingLevel(value: unknown): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined {
  const text = asNonEmptyString(value)?.toLowerCase();
  if (!text) return undefined;
  if (text === "minimal") return "MINIMAL";
  if (text === "low") return "LOW";
  if (text === "medium") return "MEDIUM";
  if (text === "high") return "HIGH";
  return undefined;
}

function buildPiStreamOptions(params: RuntimeRunTurnParams, apiKey?: string): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (apiKey) options.apiKey = apiKey;
  if (params.abortSignal) options.signal = params.abortSignal;

  const providerSection = providerSectionForPi(params.config.provider, params.providerOptions);

  if (params.config.provider === "openai" || params.config.provider === "codex-cli") {
    const reasoningEffort = asNonEmptyString(providerSection.reasoningEffort);
    if (reasoningEffort) options.reasoningEffort = reasoningEffort;
    const reasoningSummary = asNonEmptyString(providerSection.reasoningSummary);
    if (reasoningSummary) options.reasoningSummary = reasoningSummary;
    const textVerbosity = asNonEmptyString(providerSection.textVerbosity);
    if (textVerbosity) options.textVerbosity = textVerbosity;
    const temperature = asFiniteNumber(providerSection.temperature);
    if (temperature !== undefined) options.temperature = temperature;
  }

  if (params.config.provider === "anthropic") {
    const thinking = asRecord(providerSection.thinking);
    if (thinking?.type === "enabled") {
      options.thinkingEnabled = true;
      const budget = asFiniteNumber(thinking.budgetTokens);
      if (budget !== undefined) options.thinkingBudgetTokens = budget;
    }
    const effort = asNonEmptyString(providerSection.effort);
    if (effort) options.effort = effort;
    if (providerSection.interleavedThinking === true || providerSection.interleavedThinking === false) {
      options.interleavedThinking = providerSection.interleavedThinking;
    }
  }

  if (params.config.provider === "google") {
    const thinkingConfig = asRecord(providerSection.thinkingConfig);
    if (thinkingConfig) {
      const includeThoughts = thinkingConfig.includeThoughts !== false;
      const level = toGoogleThinkingLevel(thinkingConfig.thinkingLevel);
      const budget = asFiniteNumber(thinkingConfig.thinkingBudget);
      options.thinking = {
        enabled: includeThoughts,
        ...(level ? { level } : {}),
        ...(budget !== undefined ? { budgetTokens: budget } : {}),
      };
    }
    const temperature = asFiniteNumber(providerSection.temperature);
    if (temperature !== undefined) options.temperature = temperature;
    const toolChoice = asNonEmptyString(providerSection.toolChoice);
    if (toolChoice) options.toolChoice = toolChoice;
  }

  return options;
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  const maybe = value as { safeParse?: unknown; _zod?: unknown };
  return !!maybe && typeof maybe.safeParse === "function" && typeof maybe._zod === "object";
}

function toPiJsonSchema(inputSchema: unknown): Record<string, unknown> {
  if (isZodSchema(inputSchema)) {
    const schema = z.toJSONSchema(inputSchema);
    const record = asRecord(schema);
    if (record) {
      const { $schema: _dropSchema, ...rest } = record;
      return rest;
    }
  }

  const record = asRecord(inputSchema);
  if (record) return record;
  return { type: "object", properties: {}, additionalProperties: true };
}

function toolMapToPiTools(tools: RuntimeRunTurnParams["tools"]): Array<Record<string, unknown>> {
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

function normalizeToolResultContent(result: unknown): Array<{ type: "text"; text: string }> {
  if (typeof result === "string") return [{ type: "text", text: result }];
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
    return [{ type: "text", text: String(result) }];
  }
  if (result === undefined || result === null) return [{ type: "text", text: "" }];
  return [{ type: "text", text: safeJsonStringify(result) }];
}

function reasoningModeForProvider(provider: ProviderName): "reasoning" | "summary" {
  return provider === "openai" || provider === "codex-cli" ? "summary" : "reasoning";
}

function toolCallFromPartial(event: any): {
  toolCallId: string;
  toolName: string;
  input?: unknown;
} {
  const partial = asRecord(event?.partial);
  const contentIndex = typeof event?.contentIndex === "number" ? event.contentIndex : -1;
  const partialContent = Array.isArray(partial?.content) ? partial.content : [];
  const part = contentIndex >= 0 ? asRecord(partialContent[contentIndex]) : null;
  const toolCallId = asNonEmptyString(part?.id) ?? `tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const toolName = asNonEmptyString(part?.name) ?? "tool";
  const input = part?.arguments ?? {};
  return { toolCallId, toolName, input };
}

async function emitPiEventAsRawPart(
  event: any,
  provider: ProviderName,
  emit: (part: unknown) => Promise<void>
): Promise<void> {
  const mode = reasoningModeForProvider(provider);
  const contentIndex = typeof event?.contentIndex === "number" ? event.contentIndex : 0;
  const streamId = `s${contentIndex}`;

  switch (event?.type) {
    case "start":
      await emit({ type: "start" });
      return;
    case "text_start":
      await emit({ type: "text-start", id: streamId });
      return;
    case "text_delta":
      await emit({ type: "text-delta", id: streamId, text: String(event.delta ?? "") });
      return;
    case "text_end":
      await emit({ type: "text-end", id: streamId });
      return;
    case "thinking_start":
      await emit({ type: "reasoning-start", id: streamId, mode });
      return;
    case "thinking_delta":
      await emit({ type: "reasoning-delta", id: streamId, mode, text: String(event.delta ?? "") });
      return;
    case "thinking_end":
      await emit({ type: "reasoning-end", id: streamId, mode });
      return;
    case "toolcall_start": {
      const toolCall = toolCallFromPartial(event);
      await emit({
        type: "tool-input-start",
        id: toolCall.toolCallId,
        toolName: toolCall.toolName,
      });
      return;
    }
    case "toolcall_delta": {
      const toolCall = toolCallFromPartial(event);
      await emit({
        type: "tool-input-delta",
        id: toolCall.toolCallId,
        delta: String(event.delta ?? ""),
      });
      return;
    }
    case "toolcall_end":
      await emit({
        type: "tool-input-end",
        id: event.toolCall?.id,
      });
      await emit({
        type: "tool-call",
        toolCallId: event.toolCall?.id,
        toolName: event.toolCall?.name,
        input: event.toolCall?.arguments ?? {},
      });
      return;
    case "done":
      await emit({
        type: "finish",
        finishReason: event.reason,
        totalUsage: event.message?.usage
          ? {
              promptTokens: event.message.usage.input,
              completionTokens: event.message.usage.output,
              totalTokens: event.message.usage.totalTokens,
            }
          : undefined,
      });
      return;
    case "error":
      await emit({
        type: "error",
        error: event.error?.errorMessage ?? event.error ?? "PI stream error",
      });
      return;
    default:
      await emit({
        type: "unknown",
        sdkType: String(event?.type ?? "unknown"),
        raw: event,
      });
      return;
  }
}

type PiToolCallLike = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

function extractToolCallsFromAssistant(assistant: Record<string, unknown>): PiToolCallLike[] {
  const rawContent = Array.isArray(assistant.content) ? assistant.content : [];
  const out: PiToolCallLike[] = [];
  for (const rawPart of rawContent) {
    const part = asRecord(rawPart);
    if (!part || part.type !== "toolCall") continue;
    const id = asNonEmptyString(part.id) ?? `tool_${Date.now()}_${out.length + 1}`;
    const name = asNonEmptyString(part.name) ?? "tool";
    const argumentsRecord = asRecord(part.arguments) ?? {};
    out.push({ id, name, arguments: argumentsRecord });
  }
  return out;
}

async function executeToolCall(
  toolCall: PiToolCallLike,
  params: RuntimeRunTurnParams,
  emitPart: (part: unknown) => Promise<void>
): Promise<Record<string, unknown>> {
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
    const content = normalizeToolResultContent(result);
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

export function createPiRuntime(): LlmRuntime {
  return {
    name: "pi",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      try {
        const resolved = await resolvePiModel(params);
        const piTools = toolMapToPiTools(params.tools);
        const streamOptions = buildPiStreamOptions(params, resolved.apiKey);
        const piMessages = modelMessagesToPiMessages(params.messages);
        const turnMessages: any[] = [];
        let usage = undefined as RuntimeRunTurnResult["usage"];

        const maxSteps = Math.max(1, params.maxSteps);
        for (let step = 0; step < maxSteps; step += 1) {
          if (params.abortSignal?.aborted) {
            await params.onModelAbort?.();
            throw new Error("Model turn aborted.");
          }

          await emitPart({
            type: "start-step",
            stepNumber: step + 1,
            request: { model: resolved.model.id, provider: params.config.provider },
          });

          const stream = piStream(
            resolved.model as any,
            {
              systemPrompt: params.system,
              messages: piMessages as any,
              tools: piTools as any,
            },
            streamOptions as any
          );

          for await (const event of stream as any) {
            await emitPiEventAsRawPart(event, params.config.provider, emitPart);
          }

          const assistant = await (stream as any).result();
          const assistantRecord = asRecord(assistant) ?? {};
          turnMessages.push(assistantRecord);
          piMessages.push(assistantRecord as any);
          usage = mergePiUsage(usage, assistantRecord.usage);

          await emitPart({
            type: "finish-step",
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: assistantRecord.usage
              ? {
                  promptTokens: asFiniteNumber((assistantRecord.usage as any).input) ?? 0,
                  completionTokens: asFiniteNumber((assistantRecord.usage as any).output) ?? 0,
                  totalTokens: asFiniteNumber((assistantRecord.usage as any).totalTokens) ?? 0,
                }
              : undefined,
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
            const toolResult = await executeToolCall(toolCall, params, emitPart);
            turnMessages.push(toolResult);
            piMessages.push(toolResult as any);
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

export const __internal = {
  providerSectionForPi,
  toGoogleThinkingLevel,
  buildPiStreamOptions,
  toPiJsonSchema,
  toolCallFromPartial,
  extractToolCallsFromAssistant,
  pickKnownPiModel,
};
