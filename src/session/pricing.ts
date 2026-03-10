/**
 * Model pricing catalog for token cost estimation.
 *
 * Prices are in USD per 1 million tokens.
 * Updated regularly to reflect current provider pricing.
 *
 * Sources:
 *   - https://openai.com/api/pricing
 *   - https://ai.google.dev/pricing
 *   - https://www.anthropic.com/pricing
 */

import type { ProviderName } from "../types";

export type ModelPricing = {
  /** Cost per 1M input/prompt tokens in USD. */
  inputPerMillion: number;
  /** Cost per 1M output/completion tokens in USD. */
  outputPerMillion: number;
  /** Optional: cost per 1M cached input tokens in USD. */
  cachedInputPerMillion?: number;
};

export type PricingCatalogEntry = {
  provider: ProviderName;
  model: string;
  pricing: ModelPricing;
};

/**
 * Known model pricing. Keys are `provider:model` strings for direct lookup.
 * When an exact match isn't found we fall back to prefix matching.
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────────────────
  "anthropic:claude-opus-4-6": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cachedInputPerMillion: 1.875,
  },
  "anthropic:claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.375,
  },
  "anthropic:claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.375,
  },
  "anthropic:claude-haiku-4-5": {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cachedInputPerMillion: 0.08,
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  "openai:gpt-5.4": {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.25,
  },
  "openai:gpt-5.2": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 1.25,
  },
  "openai:gpt-5.2-codex": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 1.25,
  },
  "openai:gpt-5.2-pro": {
    inputPerMillion: 15,
    outputPerMillion: 60,
    cachedInputPerMillion: 7.5,
  },
  "openai:gpt-5.1": {
    inputPerMillion: 2,
    outputPerMillion: 8,
    cachedInputPerMillion: 1,
  },
  "openai:gpt-5-mini": {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    cachedInputPerMillion: 0.1,
  },

  // ── Codex CLI (same pricing as OpenAI) ───────────────────────────────
  "codex-cli:gpt-5.4": {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.25,
  },
  "codex-cli:gpt-5.3-codex": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 1.25,
  },
  "codex-cli:gpt-5.2-codex": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 1.25,
  },
  "codex-cli:gpt-5.2": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 1.25,
  },

  // ── Google ───────────────────────────────────────────────────────────
  "google:gemini-3.1-pro-preview-customtools": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cachedInputPerMillion: 0.315,
  },
  "google:gemini-3.1-pro-preview": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cachedInputPerMillion: 0.315,
  },
  "google:gemini-3-pro-preview": {
    inputPerMillion: 1.25,
    outputPerMillion: 5,
    cachedInputPerMillion: 0.315,
  },
  "google:gemini-3-flash-preview": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cachedInputPerMillion: 0.0375,
  },
};

/**
 * Resolve pricing for a provider + model pair.
 *
 * 1. Try exact key `provider:model`.
 * 2. Try prefix matching (e.g. request `google:gemini-3-pro-preview` matches catalog `google:gemini-3`).
 * 3. Return null when no match is found.
 */
export function resolveModelPricing(
  provider: ProviderName,
  model: string,
): ModelPricing | null {
  const exactKey = `${provider}:${model}`;
  if (PRICING_TABLE[exactKey]) return PRICING_TABLE[exactKey];

  // Prefix matching: find the most specific (longest) matching key.
  const prefix = `${provider}:`;
  let bestMatch: ModelPricing | null = null;
  let bestMatchLength = 0;

  for (const [key, pricing] of Object.entries(PRICING_TABLE)) {
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
): number {
  const normalizedCachedPromptTokens = Math.min(
    Math.max(0, cachedPromptTokens),
    Math.max(0, promptTokens),
  );
  const uncachedPromptTokens = Math.max(0, promptTokens - normalizedCachedPromptTokens);
  const inputCost = (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion;
  const cachedInputCost =
    (normalizedCachedPromptTokens / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion);
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + cachedInputCost + outputCost;
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
export function listPricingCatalog(): PricingCatalogEntry[] {
  return Object.entries(PRICING_TABLE).map(([key, pricing]) => {
    const [provider, ...modelParts] = key.split(":");
    return {
      provider: provider as ProviderName,
      model: modelParts.join(":"),
      pricing,
    };
  });
}
