/**
 * Model pricing catalog for token cost estimation.
 *
 * Prices are in USD per 1 million tokens.
 * Updated regularly to reflect current provider pricing.
 *
 * Note: `opencode-go` is intentionally excluded from local pricing and pricing
 * override support in this repo. Its billing is usage-based, so Cowork does not
 * attempt local per-model cost estimation for that provider.
 *
 * Sources:
 *   - https://openai.com/api/pricing
 *   - https://ai.google.dev/gemini-api/docs/pricing
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 *   - https://www.baseten.co/pricing/
 *   - https://docs.together.ai/docs/serverless-models
 *   - https://docs.fireworks.ai/serverless/pricing
 *
 * Override or extend entries at runtime with
 * `COWORK_MODEL_PRICING_OVERRIDES='{"provider:model":{"inputPerMillion":...,"outputPerMillion":...}}'`.
 */

import type { ProviderName } from "../types";
import {
  isFireworksInferenceProvider,
  listFireworksInferencePricingEntries,
} from "../providers/fireworksShared";

export type ModelPricing = {
  /** Cost per 1M input/prompt tokens in USD. */
  inputPerMillion: number;
  /** Cost per 1M output/completion tokens in USD. */
  outputPerMillion: number;
  /** Optional: cost per 1M cache read / cached input tokens in USD. */
  cachedInputPerMillion?: number;
  /** Optional: cost per 1M cache write / cache creation input tokens in USD. */
  cacheWriteInputPerMillion?: number;
  /** Optional: input-token threshold where long-context pricing begins. */
  longContextThresholdTokens?: number;
  /** Optional: cost per 1M input/prompt tokens above the long-context threshold. */
  longContextInputPerMillion?: number;
  /** Optional: cost per 1M output/completion tokens above the long-context threshold. */
  longContextOutputPerMillion?: number;
  /** Optional: cost per 1M cached input tokens above the long-context threshold. */
  longContextCachedInputPerMillion?: number;
};

export type PricingCatalogEntry = {
  provider: ProviderName;
  model: string;
  pricing: ModelPricing;
};

type PricingEnv = Record<string, string | undefined>;

function fireworksInferencePricingTable(): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const { key, pricing } of listFireworksInferencePricingEntries()) {
    table[key] = {
      inputPerMillion: pricing.input,
      outputPerMillion: pricing.output,
      ...(pricing.cacheRead !== undefined ? { cachedInputPerMillion: pricing.cacheRead } : {}),
      ...(pricing.cacheWrite !== undefined
        ? { cacheWriteInputPerMillion: pricing.cacheWrite }
        : {}),
    };
  }
  return table;
}

/**
 * Known model pricing. Keys are `provider:model` strings for direct lookup.
 * When an exact match isn't found we fall back to prefix matching.
 */
const BASE_PRICING_TABLE: Record<string, ModelPricing> = {
  ...fireworksInferencePricingTable(),
  // ── Anthropic ────────────────────────────────────────────────────────
  "anthropic:claude-opus-4-6": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cachedInputPerMillion: 0.5,
    cacheWriteInputPerMillion: 6.25,
  },
  "anthropic:claude-opus-4-7": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cachedInputPerMillion: 0.5,
    cacheWriteInputPerMillion: 6.25,
  },
  "anthropic:claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    cacheWriteInputPerMillion: 3.75,
  },
  "anthropic:claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    cacheWriteInputPerMillion: 3.75,
  },
  "anthropic:claude-haiku-4-5": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cachedInputPerMillion: 0.1,
    cacheWriteInputPerMillion: 1.25,
  },

  // ── Baseten ──────────────────────────────────────────────────────────
  "baseten:moonshotai/Kimi-K2.5": {
    inputPerMillion: 0.6,
    outputPerMillion: 3,
    cachedInputPerMillion: 0.12,
  },
  "baseten:zai-org/GLM-5": {
    inputPerMillion: 0.95,
    outputPerMillion: 3.15,
    cachedInputPerMillion: 0.2,
  },
  "baseten:nvidia/Nemotron-120B-A12B": {
    inputPerMillion: 0.3,
    outputPerMillion: 0.75,
    cachedInputPerMillion: 0.06,
  },
  // ── Together AI ──────────────────────────────────────────────────────
  "together:moonshotai/Kimi-K2.5": {
    inputPerMillion: 0.5,
    outputPerMillion: 2.8,
  },
  "together:Qwen/Qwen3.5-397B-A17B": {
    inputPerMillion: 0.6,
    outputPerMillion: 3.6,
  },
  "together:zai-org/GLM-5": {
    inputPerMillion: 1,
    outputPerMillion: 3.2,
  },
  // OpenCode Go is intentionally excluded from local pricing estimates.
  "opencode-zen:glm-5": {
    inputPerMillion: 1,
    outputPerMillion: 3.2,
    cachedInputPerMillion: 0.2,
  },
  "opencode-zen:kimi-k2.5": {
    inputPerMillion: 0.6,
    outputPerMillion: 3,
    cachedInputPerMillion: 0.08,
  },
  "opencode-zen:nemotron-3-super-free": {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  "opencode-zen:mimo-v2-flash-free": {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  "opencode-zen:big-pickle": {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  "opencode-zen:minimax-m2.5-free": {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  "opencode-zen:minimax-m2.5": {
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cachedInputPerMillion: 0.06,
    cacheWriteInputPerMillion: 0.375,
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  "openai:gpt-5.5": {
    inputPerMillion: 5,
    outputPerMillion: 30,
    cachedInputPerMillion: 0.5,
    longContextThresholdTokens: 272_000,
    longContextInputPerMillion: 10,
    longContextOutputPerMillion: 45,
    longContextCachedInputPerMillion: 1,
  },
  "openai:gpt-5.4": {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.25,
    longContextThresholdTokens: 272_000,
    longContextInputPerMillion: 5,
    longContextOutputPerMillion: 22.5,
    longContextCachedInputPerMillion: 0.5,
  },
  "openai:gpt-5.4-mini": {
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    cachedInputPerMillion: 0.075,
  },
  "openai:gpt-5.2": {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    cachedInputPerMillion: 0.175,
  },
  "openai:gpt-5.2-pro": {
    inputPerMillion: 21,
    outputPerMillion: 168,
  },
  "openai:gpt-5-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cachedInputPerMillion: 0.025,
  },

  // ── Codex CLI (same pricing as OpenAI) ───────────────────────────────
  "codex-cli:gpt-5.5": {
    inputPerMillion: 5,
    outputPerMillion: 30,
    cachedInputPerMillion: 0.5,
    longContextThresholdTokens: 272_000,
    longContextInputPerMillion: 10,
    longContextOutputPerMillion: 45,
    longContextCachedInputPerMillion: 1,
  },
  "codex-cli:gpt-5.4": {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.25,
    longContextThresholdTokens: 272_000,
    longContextInputPerMillion: 5,
    longContextOutputPerMillion: 22.5,
    longContextCachedInputPerMillion: 0.5,
  },
  "codex-cli:gpt-5.4-mini": {
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    cachedInputPerMillion: 0.075,
  },
  "codex-cli:gpt-5.3-codex": {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    cachedInputPerMillion: 0.175,
  },
  "codex-cli:gpt-5.3-codex-spark": {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    cachedInputPerMillion: 0.175,
  },

  // ── Google ───────────────────────────────────────────────────────────
  "google:gemini-3.1-pro-preview-customtools": {
    inputPerMillion: 2,
    outputPerMillion: 12,
    cachedInputPerMillion: 0.2,
    longContextThresholdTokens: 200_000,
    longContextInputPerMillion: 4,
    longContextOutputPerMillion: 18,
    longContextCachedInputPerMillion: 0.4,
  },
  "google:gemini-3.1-pro-preview": {
    inputPerMillion: 2,
    outputPerMillion: 12,
    cachedInputPerMillion: 0.2,
    longContextThresholdTokens: 200_000,
    longContextInputPerMillion: 4,
    longContextOutputPerMillion: 18,
    longContextCachedInputPerMillion: 0.4,
  },
  "google:gemini-3-flash-preview": {
    inputPerMillion: 0.5,
    outputPerMillion: 3,
    cachedInputPerMillion: 0.05,
  },
  "google:gemini-3.1-flash-lite-preview": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.5,
    cachedInputPerMillion: 0.025,
  },
  "google:gemini-3.5-flash": {
    inputPerMillion: 1.5,
    outputPerMillion: 9,
    cachedInputPerMillion: 0.15,
  },

  // ── Antigravity (Gemini-hosted model IDs) ────────────────────────────
  "antigravity:gemini-3.1-pro-preview": {
    inputPerMillion: 2,
    outputPerMillion: 12,
    cachedInputPerMillion: 0.2,
    longContextThresholdTokens: 200_000,
    longContextInputPerMillion: 4,
    longContextOutputPerMillion: 18,
    longContextCachedInputPerMillion: 0.4,
  },
  "antigravity:gemini-3.5-flash": {
    inputPerMillion: 1.5,
    outputPerMillion: 9,
    cachedInputPerMillion: 0.15,
  },
  "antigravity:gemini-3.1-flash-lite": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.5,
    cachedInputPerMillion: 0.025,
  },
};

const pricingOverrideSchema = {
  inputPerMillion: (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0,
  outputPerMillion: (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0,
  cachedInputPerMillion: (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
  cacheWriteInputPerMillion: (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
  longContextThresholdTokens: (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0),
  longContextInputPerMillion: (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
  longContextOutputPerMillion: (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
  longContextCachedInputPerMillion: (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
};

let cachedPricingOverrideRaw: string | null = null;
let cachedPricingOverrides: Record<string, ModelPricing> = {};

function isModelPricing(value: unknown): value is ModelPricing {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    pricingOverrideSchema.inputPerMillion(record.inputPerMillion) &&
    pricingOverrideSchema.outputPerMillion(record.outputPerMillion) &&
    pricingOverrideSchema.cachedInputPerMillion(record.cachedInputPerMillion) &&
    pricingOverrideSchema.cacheWriteInputPerMillion(record.cacheWriteInputPerMillion) &&
    pricingOverrideSchema.longContextThresholdTokens(record.longContextThresholdTokens) &&
    pricingOverrideSchema.longContextInputPerMillion(record.longContextInputPerMillion) &&
    pricingOverrideSchema.longContextOutputPerMillion(record.longContextOutputPerMillion) &&
    pricingOverrideSchema.longContextCachedInputPerMillion(record.longContextCachedInputPerMillion)
  );
}

function isPricingOverrideKey(value: string): value is `${ProviderName}:${string}` {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return false;
  const provider = value.slice(0, separatorIndex);
  // `opencode-go` intentionally has no local pricing or override support.
  return (
    provider === "google" ||
    provider === "antigravity" ||
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "baseten" ||
    provider === "together" ||
    isFireworksInferenceProvider(provider as ProviderName) ||
    provider === "opencode-zen" ||
    provider === "codex-cli"
  );
}

function loadPricingOverridesFromEnv(env: PricingEnv = process.env): Record<string, ModelPricing> {
  const raw = env.COWORK_MODEL_PRICING_OVERRIDES?.trim() ?? "";
  if (raw === cachedPricingOverrideRaw) {
    return cachedPricingOverrides;
  }

  cachedPricingOverrideRaw = raw;
  if (!raw) {
    cachedPricingOverrides = {};
    return cachedPricingOverrides;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[pricing] Ignoring invalid COWORK_MODEL_PRICING_OVERRIDES JSON: ${String(error)}`,
    );
    cachedPricingOverrides = {};
    return cachedPricingOverrides;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(
      "[pricing] Ignoring COWORK_MODEL_PRICING_OVERRIDES because it is not a JSON object.",
    );
    cachedPricingOverrides = {};
    return cachedPricingOverrides;
  }

  const overrides: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isPricingOverrideKey(key)) {
      console.warn(
        `[pricing] Ignoring model pricing override with invalid key "${key}". Expected "provider:model".`,
      );
      continue;
    }
    if (!isModelPricing(value)) {
      console.warn(
        `[pricing] Ignoring model pricing override for "${key}" because the pricing payload is invalid.`,
      );
      continue;
    }
    overrides[key] = {
      inputPerMillion: value.inputPerMillion,
      outputPerMillion: value.outputPerMillion,
      ...(value.cachedInputPerMillion !== undefined
        ? { cachedInputPerMillion: value.cachedInputPerMillion }
        : {}),
      ...(value.cacheWriteInputPerMillion !== undefined
        ? { cacheWriteInputPerMillion: value.cacheWriteInputPerMillion }
        : {}),
      ...(value.longContextThresholdTokens !== undefined
        ? { longContextThresholdTokens: value.longContextThresholdTokens }
        : {}),
      ...(value.longContextInputPerMillion !== undefined
        ? { longContextInputPerMillion: value.longContextInputPerMillion }
        : {}),
      ...(value.longContextOutputPerMillion !== undefined
        ? { longContextOutputPerMillion: value.longContextOutputPerMillion }
        : {}),
      ...(value.longContextCachedInputPerMillion !== undefined
        ? { longContextCachedInputPerMillion: value.longContextCachedInputPerMillion }
        : {}),
    };
  }

  cachedPricingOverrides = overrides;
  return cachedPricingOverrides;
}

function getPricingTable(env: PricingEnv = process.env): Record<string, ModelPricing> {
  return {
    ...BASE_PRICING_TABLE,
    ...loadPricingOverridesFromEnv(env),
  };
}

/**
 * Resolve pricing for a provider + model pair.
 *
 * 1. Try exact key `provider:model`.
 * 2. Try prefix matching (e.g. request `google:gemini-3.1-pro-preview` matches catalog `google:gemini-3.1`).
 * 3. Return null when no match is found.
 */
export function resolveModelPricing(
  provider: ProviderName,
  model: string,
  env: PricingEnv = process.env,
): ModelPricing | null {
  const pricingTable = getPricingTable(env);
  const exactKey = `${provider}:${model}`;
  if (pricingTable[exactKey]) return pricingTable[exactKey];

  // Prefix matching: find the most specific (longest) matching key.
  const prefix = `${provider}:`;
  let bestMatch: ModelPricing | null = null;
  let bestMatchLength = 0;

  for (const [key, pricing] of Object.entries(pricingTable)) {
    if (!key.startsWith(prefix)) continue;
    const modelPart = key.slice(prefix.length);
    if (model.startsWith(modelPart) && modelPart.length > bestMatchLength) {
      bestMatch = pricing;
      bestMatchLength = modelPart.length;
    }
  }

  return bestMatch;
}

/**
 * Calculate cost in USD for a given token count and pricing.
 */
export function calculateTokenCost(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing,
  cachedPromptTokens = 0,
  cacheWritePromptTokens = 0,
): number {
  const useLongContextPricing =
    pricing.longContextThresholdTokens !== undefined &&
    promptTokens > pricing.longContextThresholdTokens;
  const inputPerMillion =
    useLongContextPricing && pricing.longContextInputPerMillion !== undefined
      ? pricing.longContextInputPerMillion
      : pricing.inputPerMillion;
  const outputPerMillion =
    useLongContextPricing && pricing.longContextOutputPerMillion !== undefined
      ? pricing.longContextOutputPerMillion
      : pricing.outputPerMillion;
  const cachedInputPerMillion =
    useLongContextPricing && pricing.longContextCachedInputPerMillion !== undefined
      ? pricing.longContextCachedInputPerMillion
      : (pricing.cachedInputPerMillion ?? inputPerMillion);
  const cacheWriteInputPerMillion = pricing.cacheWriteInputPerMillion ?? inputPerMillion;
  const normalizedCachedPromptTokens = Math.min(
    Math.max(0, cachedPromptTokens),
    Math.max(0, promptTokens),
  );
  const normalizedCacheWritePromptTokens = Math.min(
    Math.max(0, cacheWritePromptTokens),
    Math.max(0, promptTokens - normalizedCachedPromptTokens),
  );
  const uncachedPromptTokens = Math.max(
    0,
    promptTokens - normalizedCachedPromptTokens - normalizedCacheWritePromptTokens,
  );
  const inputCost = (uncachedPromptTokens / 1_000_000) * inputPerMillion;
  const cachedInputCost = (normalizedCachedPromptTokens / 1_000_000) * cachedInputPerMillion;
  const cacheWriteInputCost =
    (normalizedCacheWritePromptTokens / 1_000_000) * cacheWriteInputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * outputPerMillion;
  return inputCost + cachedInputCost + cacheWriteInputCost + outputCost;
}

/**
 * Format a USD cost for display.
 * - Below $0.01: show with 4 decimal places (e.g. "$0.0012")
 * - Above $0.01: show with 2 decimal places (e.g. "$1.23")
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a token count for display (e.g. 1234 → "1.2k", 1234567 → "1.2M").
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/**
 * List all known pricing entries. Useful for UIs.
 */
export function listPricingCatalog(env: PricingEnv = process.env): PricingCatalogEntry[] {
  return Object.entries(getPricingTable(env)).map(([key, pricing]) => {
    const [provider, ...modelParts] = key.split(":");
    return {
      provider: provider as ProviderName,
      model: modelParts.join(":"),
      pricing,
    };
  });
}
