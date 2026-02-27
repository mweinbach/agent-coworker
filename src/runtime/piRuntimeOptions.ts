import { z } from "zod";
import { getModel as getPiModel, getModels as getPiModels } from "@mariozechner/pi-ai";
import type { ProviderName } from "../types";
import type { RuntimeRunTurnParams } from "./types";

export type PiModel = {
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

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pickKnownPiModel(provider: string, modelId: string): PiModel | null {
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

export function providerSectionForPi(provider: ProviderName, providerOptions?: Record<string, any>): Record<string, unknown> {
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

export function toGoogleThinkingLevel(value: unknown): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined {
  const text = asNonEmptyString(value)?.toLowerCase();
  if (!text) return undefined;
  if (text === "minimal") return "MINIMAL";
  if (text === "low") return "LOW";
  if (text === "medium") return "MEDIUM";
  if (text === "high") return "HIGH";
  return undefined;
}

export function buildPiStreamOptions(
  params: RuntimeRunTurnParams,
  apiKey?: string,
  headers?: Record<string, string>
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (apiKey) options.apiKey = apiKey;
  if (params.abortSignal) options.signal = params.abortSignal;
  if (headers && Object.keys(headers).length > 0) {
    options.headers = { ...headers };
  }

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

export function isZodSchema(value: unknown): value is z.ZodTypeAny {
  const maybe = value as { safeParse?: unknown; _zod?: unknown };
  return !!maybe && typeof maybe.safeParse === "function" && typeof maybe._zod === "object";
}

export function toPiJsonSchema(inputSchema: unknown): Record<string, unknown> {
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

export function toolCallFromPartial(event: any): {
  toolCallId: string;
  toolName: string;
  input?: unknown;
} {
  const partial = asRecord(event?.partial);
  const contentIndex = typeof event?.contentIndex === "number" ? event.contentIndex : -1;
  const partialContent = Array.isArray(partial?.content) ? partial.content : [];
  const part = contentIndex >= 0 ? asRecord(partialContent[contentIndex]) : null;
  const fallbackId = contentIndex >= 0 ? `tool_call_${contentIndex}` : `tool_${Date.now()}`;
  const toolCallId = asNonEmptyString(part?.id) ?? asNonEmptyString(event?.toolCall?.id) ?? fallbackId;
  const toolName = asNonEmptyString(part?.name) ?? "tool";
  const input = part?.arguments ?? {};
  return { toolCallId, toolName, input };
}

export type PiToolCallLike = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export function extractToolCallsFromAssistant(assistant: Record<string, unknown>): PiToolCallLike[] {
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
