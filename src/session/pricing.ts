/**
 * Token-cost math and display formatting shared by the desktop/mobile clients.
 *
 * Prices are in USD per 1 million tokens. The pricing catalog itself lives in
 * the Rust server (`crates/cowork-inference/src/pricing.rs`), which records
 * per-turn `pricing` in session usage snapshots; clients only re-derive cost
 * breakdowns from that recorded pricing.
 */

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

export type TokenCostBreakdown = {
  inputCostUsd: number;
  cachedInputCostUsd: number;
  cacheWriteInputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
};

/**
 * Calculate a USD cost estimate split across billable token buckets.
 */
export function calculateTokenCostBreakdown(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing,
  cachedPromptTokens = 0,
  cacheWritePromptTokens = 0,
): TokenCostBreakdown {
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
  return {
    inputCostUsd: inputCost,
    cachedInputCostUsd: cachedInputCost,
    cacheWriteInputCostUsd: cacheWriteInputCost,
    outputCostUsd: outputCost,
    totalCostUsd: inputCost + cachedInputCost + cacheWriteInputCost + outputCost,
  };
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
