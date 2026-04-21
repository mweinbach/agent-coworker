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
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

export function asNonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => !!entry);
  return next.length > 0 ? next : undefined;
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

  if (params.config.provider === "codex-cli") {
    const webSearchBackend = asNonEmptyString(providerSection.webSearchBackend);
    if (webSearchBackend) options.webSearchBackend = webSearchBackend;

    const webSearchMode = asNonEmptyString(providerSection.webSearchMode);
    if (webSearchMode) options.webSearchMode = webSearchMode;

    const webSearch = asRecord(providerSection.webSearch);
    const contextSize = asNonEmptyString(webSearch?.contextSize);
    if (contextSize) options.webSearchContextSize = contextSize;

    const allowedDomains = asNonEmptyStringArray(webSearch?.allowedDomains);
    if (allowedDomains) {
      options.webSearchAllowedDomains = allowedDomains;
    }

    const location = asRecord(webSearch?.location);
    if (location) {
      const webSearchLocation = {
        ...(asNonEmptyString(location.country) ? { country: asNonEmptyString(location.country)! } : {}),
        ...(asNonEmptyString(location.region) ? { region: asNonEmptyString(location.region)! } : {}),
        ...(asNonEmptyString(location.city) ? { city: asNonEmptyString(location.city)! } : {}),
        ...(asNonEmptyString(location.timezone) ? { timezone: asNonEmptyString(location.timezone)! } : {}),
      };
      if (Object.keys(webSearchLocation).length > 0) {
        options.webSearchLocation = webSearchLocation;
      }
    }
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

  // Google is handled by the Google Interactions runtime — no PI stream options needed.

  if (params.config.provider === "nvidia") {
    options.reasoningEffort = "high";
  }

  if (params.config.provider === "bedrock") {
    const region = asNonEmptyString(providerSection.region);
    if (region) options.region = region;

    const profile = asNonEmptyString(providerSection.profile);
    if (profile) options.profile = profile;

    const toolChoice = providerSection.toolChoice;
    if (
      toolChoice === "auto"
      || toolChoice === "any"
      || toolChoice === "none"
      || (asRecord(toolChoice)?.type === "tool" && asNonEmptyString(asRecord(toolChoice)?.name))
    ) {
      options.toolChoice = toolChoice;
    }

    const reasoning = asNonEmptyString(providerSection.reasoning);
    if (reasoning) options.reasoning = reasoning;

    const thinkingBudgets = asRecord(providerSection.thinkingBudgets);
    if (thinkingBudgets) {
      const mappedBudgets = {
        ...(asFiniteNumber(thinkingBudgets.minimal) !== undefined ? { minimal: asFiniteNumber(thinkingBudgets.minimal)! } : {}),
        ...(asFiniteNumber(thinkingBudgets.low) !== undefined ? { low: asFiniteNumber(thinkingBudgets.low)! } : {}),
        ...(asFiniteNumber(thinkingBudgets.medium) !== undefined ? { medium: asFiniteNumber(thinkingBudgets.medium)! } : {}),
        ...(asFiniteNumber(thinkingBudgets.high) !== undefined ? { high: asFiniteNumber(thinkingBudgets.high)! } : {}),
      };
      if (Object.keys(mappedBudgets).length > 0) {
        options.thinkingBudgets = mappedBudgets;
      }
    }

    if (providerSection.interleavedThinking === true || providerSection.interleavedThinking === false) {
      options.interleavedThinking = providerSection.interleavedThinking;
    }

    const requestMetadata = asRecord(providerSection.requestMetadata);
    if (requestMetadata) {
      const mappedMetadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(requestMetadata)) {
        const normalizedKey = asNonEmptyString(key);
        const normalizedValue = asNonEmptyString(value);
        if (normalizedKey && normalizedValue) {
          mappedMetadata[normalizedKey] = normalizedValue;
        }
      }
      if (Object.keys(mappedMetadata).length > 0) {
        options.requestMetadata = mappedMetadata;
      }
    }

    const temperature = asFiniteNumber(providerSection.temperature);
    if (temperature !== undefined) options.temperature = temperature;
    const maxTokens = asFiniteNumber(providerSection.maxTokens);
    if (maxTokens !== undefined) options.maxTokens = maxTokens;
  }

  return options;
}

export function buildOpenAiContinuationRequestOptions(
  previousResponseId?: string,
): Record<string, unknown> {
  return {
    truncation: "auto",
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  };
}

export function isZodSchema(value: unknown): value is z.ZodTypeAny {
  const maybe = value as { safeParse?: unknown; _zod?: unknown };
  return !!maybe && typeof maybe.safeParse === "function" && typeof maybe._zod === "object";
}

type ToolJsonSchema = Record<string, unknown> | boolean;

const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const SCHEMA_SINGLE_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const SCHEMA_ARRAY_KEYS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
]);

const FIREWORKS_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "maxItems",
  "maxLength",
  "minItems",
  "minLength",
  "pattern",
]);

const FIREWORKS_TOOL_SCHEMA_MAX_BYTES = 4096;
const FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES = 12288;

type ToolSchemaBudgetState = {
  totalBytes: number;
};

function normalizeSchemaArray(value: unknown): ToolJsonSchema[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeToolJsonSchema(entry))
    .filter((entry): entry is ToolJsonSchema => entry !== undefined);
}

function collapseTupleSchemas(entries: ToolJsonSchema[]): ToolJsonSchema | undefined {
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0];

  const first = JSON.stringify(entries[0]);
  if (entries.every((entry) => JSON.stringify(entry) === first)) {
    return entries[0];
  }

  return { anyOf: entries };
}

function normalizeToolJsonSchema(schema: unknown): ToolJsonSchema | undefined {
  if (typeof schema === "boolean") return schema;

  const record = asRecord(schema);
  if (!record) return undefined;

  const normalized: Record<string, unknown> = {};
  const tupleItems = Array.isArray(record.items) ? normalizeSchemaArray(record.items) : [];
  const prefixItems = normalizeSchemaArray(record.prefixItems);
  const normalizedItems = collapseTupleSchemas(tupleItems.length > 0 ? tupleItems : prefixItems);

  for (const [key, value] of Object.entries(record)) {
    if (key === "$schema" || key === "additionalItems" || key === "prefixItems") continue;

    if (key === "items") {
      if (Array.isArray(value)) {
        if (normalizedItems !== undefined) {
          normalized.items = normalizedItems;
        }
        continue;
      }

      const normalizedValue = normalizeToolJsonSchema(value);
      if (normalizedValue !== undefined) {
        normalized.items = normalizedValue;
      }
      continue;
    }

    if (SCHEMA_MAP_KEYS.has(key)) {
      const childRecord = asRecord(value);
      if (!childRecord) continue;

      const childNormalized: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(childRecord)) {
        const normalizedChildValue = normalizeToolJsonSchema(childValue);
        if (normalizedChildValue !== undefined) {
          childNormalized[childKey] = normalizedChildValue;
        }
      }
      normalized[key] = childNormalized;
      continue;
    }

    if (SCHEMA_SINGLE_KEYS.has(key)) {
      const normalizedValue = normalizeToolJsonSchema(value);
      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
      continue;
    }

    if (SCHEMA_ARRAY_KEYS.has(key)) {
      const normalizedValue = normalizeSchemaArray(value);
      if (normalizedValue.length > 0) {
        normalized[key] = normalizedValue;
      }
      continue;
    }

    normalized[key] = value;
  }

  if (normalized.items === undefined && prefixItems.length > 0 && normalizedItems !== undefined) {
    normalized.items = normalizedItems;
  }
  if (
    tupleItems.length > 0
    && record.additionalItems === false
    && typeof normalized.maxItems !== "number"
    && typeof record.maxItems !== "number"
  ) {
    normalized.maxItems = tupleItems.length;
  }
  if (
    prefixItems.length > 0
    && record.items === undefined
    && typeof normalized.maxItems !== "number"
    && typeof record.maxItems !== "number"
  ) {
    normalized.maxItems = prefixItems.length;
  }

  return normalized;
}

function sanitizeProviderSchemaArray(
  value: unknown,
  provider?: ProviderName,
): ToolJsonSchema[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => sanitizeProviderToolJsonSchema(entry as ToolJsonSchema, provider))
    .filter((entry): entry is ToolJsonSchema => entry !== undefined);
}

function sanitizeProviderToolJsonSchema(
  schema: ToolJsonSchema | undefined,
  provider?: ProviderName,
): ToolJsonSchema | undefined {
  if (provider !== "fireworks" || schema === undefined || typeof schema === "boolean") {
    return schema;
  }

  const record = asRecord(schema);
  if (!record) return schema;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (FIREWORKS_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === "items") {
      if (Array.isArray(value)) {
        const collapsed = collapseTupleSchemas(sanitizeProviderSchemaArray(value, provider));
        if (collapsed !== undefined) {
          sanitized.items = collapsed;
        }
        continue;
      }

      const sanitizedValue = sanitizeProviderToolJsonSchema(value as ToolJsonSchema, provider);
      if (sanitizedValue !== undefined) {
        sanitized.items = sanitizedValue;
      }
      continue;
    }

    if (SCHEMA_MAP_KEYS.has(key)) {
      const childRecord = asRecord(value);
      if (!childRecord) continue;

      const childSanitized: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(childRecord)) {
        const sanitizedChildValue = sanitizeProviderToolJsonSchema(childValue as ToolJsonSchema, provider);
        if (sanitizedChildValue !== undefined) {
          childSanitized[childKey] = sanitizedChildValue;
        }
      }
      sanitized[key] = childSanitized;
      continue;
    }

    if (SCHEMA_SINGLE_KEYS.has(key)) {
      const sanitizedValue = sanitizeProviderToolJsonSchema(value as ToolJsonSchema, provider);
      if (sanitizedValue !== undefined) {
        sanitized[key] = sanitizedValue;
      }
      continue;
    }

    if (SCHEMA_ARRAY_KEYS.has(key)) {
      const targetKey = key === "oneOf" ? "anyOf" : key;
      const sanitizedValue = sanitizeProviderSchemaArray(value, provider);
      if (sanitizedValue.length > 0) {
        if (targetKey === "anyOf" && Array.isArray(sanitized.anyOf)) {
          sanitized.anyOf = [...(sanitized.anyOf as ToolJsonSchema[]), ...sanitizedValue];
        } else {
          sanitized[targetKey] = sanitizedValue;
        }
      }
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export function toPiJsonSchema(
  inputSchema: unknown,
  provider?: ProviderName,
  state?: ToolSchemaBudgetState,
): Record<string, unknown> {
  if (isZodSchema(inputSchema)) {
    const schema = z.toJSONSchema(inputSchema);
    const normalized = normalizeToolJsonSchema(schema);
    const sanitized = sanitizeProviderToolJsonSchema(normalized, provider);
    const record = asRecord(sanitized);
    if (record) {
      return applyProviderToolSchemaBudget(provider, record, state);
    }
  }

  const normalized = normalizeToolJsonSchema(inputSchema);
  const sanitized = sanitizeProviderToolJsonSchema(normalized, provider);
  const record = asRecord(sanitized);
  if (record) return applyProviderToolSchemaBudget(provider, record, state);
  return { type: "object", properties: {}, additionalProperties: true };
}

function relaxedToolJsonSchema(): Record<string, unknown> {
  return { type: "object", properties: {}, additionalProperties: true };
}

function estimateSchemaBytes(schema: Record<string, unknown>): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(schema), "utf8");
  } catch {
    return undefined;
  }
}

function fitsFireworksSchemaBudget(
  schemaBytes: number | undefined,
  totalBytes: number,
): schemaBytes is number {
  return (
    schemaBytes !== undefined
    && schemaBytes <= FIREWORKS_TOOL_SCHEMA_MAX_BYTES
    && totalBytes + schemaBytes <= FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES
  );
}

function shapePreservingShallowObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== "object") return relaxedToolJsonSchema();

  const properties = asRecord(schema.properties);
  if (!properties) return relaxedToolJsonSchema();

  const shallowProperties = Object.fromEntries(
    Object.keys(properties).map((key) => [key, {}]),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    type: "object",
    properties: shallowProperties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

export function applyProviderToolSchemaBudget(
  provider: ProviderName | undefined,
  schema: Record<string, unknown>,
  state?: ToolSchemaBudgetState,
): Record<string, unknown> {
  if (provider !== "fireworks") return schema;

  const totalBytes = state?.totalBytes ?? 0;
  const candidates = [
    schema,
    shapePreservingShallowObjectSchema(schema),
    relaxedToolJsonSchema(),
  ];

  for (const candidate of candidates) {
    const candidateBytes = estimateSchemaBytes(candidate);
    if (!fitsFireworksSchemaBudget(candidateBytes, totalBytes)) continue;
    if (state) state.totalBytes += candidateBytes;
    return candidate;
  }

  const relaxed = relaxedToolJsonSchema();
  const relaxedBytes = estimateSchemaBytes(relaxed);
  if (state && relaxedBytes !== undefined) {
    state.totalBytes += relaxedBytes;
  }
  return relaxed;
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
