/**
 * Session usage snapshot types and client-side cost-breakdown derivation.
 *
 * The Rust server (`crates/cowork-inference/src/cost_tracker.rs`) owns usage
 * accumulation and budgets; clients only read its snapshots and split the
 * recorded totals into display buckets.
 */

import type { ProviderName } from "../types";
import { calculateTokenCostBreakdown, type ModelPricing, type TokenCostBreakdown } from "./pricing";

// ── Public types ───────────────────────────────────────────────────────

export type TurnUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheWritePromptTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCostUsd?: number;
};

export type UsageCostBreakdown = {
  inputCostUsd: number;
  cachedInputCostUsd: number;
  cacheWriteInputCostUsd: number;
  outputCostUsd: number;
  otherCostUsd: number;
};

export type TurnCostEntry = {
  turnId: string;
  turnIndex: number;
  timestamp: string;
  provider: ProviderName;
  model: string;
  usage: TurnUsage;
  estimatedCostUsd: number | null;
  costBreakdown?: UsageCostBreakdown | null;
  pricing: ModelPricing | null;
};

export type ModelUsageSummary = {
  provider: ProviderName;
  model: string;
  turns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCachedPromptTokens?: number;
  totalCacheWritePromptTokens?: number;
  totalReasoningOutputTokens?: number;
  estimatedCostUsd: number | null;
  costBreakdown?: UsageCostBreakdown;
};

export type SessionUsageSnapshot = {
  sessionId: string;
  totalTurns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCachedPromptTokens?: number;
  totalCacheWritePromptTokens?: number;
  totalReasoningOutputTokens?: number;
  estimatedTotalCostUsd: number | null;
  costBreakdown?: UsageCostBreakdown;
  costTrackingAvailable: boolean;
  byModel: ModelUsageSummary[];
  turns: TurnCostEntry[];
  budgetStatus: BudgetStatus;
  createdAt: string;
  updatedAt: string;
};

export type BudgetStatus = {
  configured: boolean;
  warnAtUsd: number | null;
  stopAtUsd: number | null;
  warningTriggered: boolean;
  stopTriggered: boolean;
  currentCostUsd: number | null;
};

// ── Implementation ─────────────────────────────────────────────────────

function emptyUsageCostBreakdown(): UsageCostBreakdown {
  return {
    inputCostUsd: 0,
    cachedInputCostUsd: 0,
    cacheWriteInputCostUsd: 0,
    outputCostUsd: 0,
    otherCostUsd: 0,
  };
}

function usageCostBreakdownFromTokenBreakdown(breakdown: TokenCostBreakdown): UsageCostBreakdown {
  return {
    inputCostUsd: breakdown.inputCostUsd,
    cachedInputCostUsd: breakdown.cachedInputCostUsd,
    cacheWriteInputCostUsd: breakdown.cacheWriteInputCostUsd,
    outputCostUsd: breakdown.outputCostUsd,
    otherCostUsd: 0,
  };
}

function usageCostBreakdownFromUnattributedCost(costUsd: number): UsageCostBreakdown {
  return {
    ...emptyUsageCostBreakdown(),
    otherCostUsd: costUsd,
  };
}

function addUsageCostBreakdown(
  target: UsageCostBreakdown,
  next: UsageCostBreakdown,
): UsageCostBreakdown {
  return {
    inputCostUsd: target.inputCostUsd + next.inputCostUsd,
    cachedInputCostUsd: target.cachedInputCostUsd + next.cachedInputCostUsd,
    cacheWriteInputCostUsd: target.cacheWriteInputCostUsd + next.cacheWriteInputCostUsd,
    outputCostUsd: target.outputCostUsd + next.outputCostUsd,
    otherCostUsd: target.otherCostUsd + next.otherCostUsd,
  };
}

function hasMatchingTokenUsage(usage: TurnUsage, requests: readonly TurnUsage[]): boolean {
  for (const field of [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cachedPromptTokens",
    "cacheWritePromptTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (
      requests.reduce((total, request) => total + (request[field] ?? 0), 0) !== (usage[field] ?? 0)
    ) {
      return false;
    }
  }
  return true;
}

function reconcileDerivedCostBreakdown(
  breakdown: UsageCostBreakdown,
  expectedCostUsd: number | null,
): UsageCostBreakdown {
  if (expectedCostUsd === null || !Number.isFinite(expectedCostUsd)) {
    return breakdown;
  }

  const derivedTotal =
    breakdown.inputCostUsd +
    breakdown.cachedInputCostUsd +
    breakdown.cacheWriteInputCostUsd +
    breakdown.outputCostUsd +
    breakdown.otherCostUsd;
  const delta = expectedCostUsd - derivedTotal;
  if (Math.abs(delta) < 0.000001) {
    return breakdown;
  }
  if (delta < 0) {
    return usageCostBreakdownFromUnattributedCost(expectedCostUsd);
  }

  return {
    ...breakdown,
    otherCostUsd: breakdown.otherCostUsd + delta,
  };
}

function deriveModelUsageCostBreakdown(
  summary: ModelUsageSummary,
  turns: TurnCostEntry[],
): UsageCostBreakdown | null {
  if (summary.costBreakdown) {
    return { ...summary.costBreakdown };
  }
  if (summary.estimatedCostUsd === null) return null;

  const modelTurns = turns.filter(
    (entry) => entry.provider === summary.provider && entry.model === summary.model,
  );
  // Compacted zero-token turns can be absent while retained rows cover all usage.
  const hasCompleteTokenCoverage =
    modelTurns.length > 0 &&
    hasMatchingTokenUsage(
      {
        promptTokens: summary.totalPromptTokens,
        completionTokens: summary.totalCompletionTokens,
        totalTokens: summary.totalTokens,
        cachedPromptTokens: summary.totalCachedPromptTokens ?? 0,
        cacheWritePromptTokens: summary.totalCacheWritePromptTokens ?? 0,
        reasoningOutputTokens: summary.totalReasoningOutputTokens ?? 0,
      },
      modelTurns.map((entry) => entry.usage),
    );

  if (hasCompleteTokenCoverage) {
    const breakdowns = modelTurns.map((entry) => deriveTurnUsageCostBreakdown(entry));
    if (breakdowns.every((breakdown) => breakdown !== null)) {
      return reconcileDerivedCostBreakdown(
        breakdowns.reduce(addUsageCostBreakdown, emptyUsageCostBreakdown()),
        summary.estimatedCostUsd,
      );
    }
  }

  return usageCostBreakdownFromUnattributedCost(summary.estimatedCostUsd);
}

function deriveTurnUsageCostBreakdown(entry: TurnCostEntry): UsageCostBreakdown | null {
  if (entry.costBreakdown !== undefined) {
    return entry.costBreakdown ? { ...entry.costBreakdown } : null;
  }
  if (entry.estimatedCostUsd === null) return null;

  const pricing = entry.pricing;
  if (pricing) {
    return reconcileDerivedCostBreakdown(
      usageCostBreakdownFromTokenBreakdown(
        calculateTokenCostBreakdown(
          entry.usage.promptTokens,
          entry.usage.completionTokens,
          pricing,
          entry.usage.cachedPromptTokens ?? 0,
          entry.usage.cacheWritePromptTokens ?? 0,
        ),
      ),
      entry.estimatedCostUsd,
    );
  }

  return usageCostBreakdownFromUnattributedCost(entry.estimatedCostUsd);
}

/**
 * Derives a spend breakdown only from pricing recorded in the snapshot; catalog
 * pricing lookup lives in the Rust server.
 */
export function deriveUsageCostBreakdown(
  snapshot: Pick<
    SessionUsageSnapshot,
    "byModel" | "costBreakdown" | "estimatedTotalCostUsd" | "turns"
  >,
): UsageCostBreakdown | null {
  if (snapshot.costBreakdown) {
    return { ...snapshot.costBreakdown };
  }

  let aggregate: UsageCostBreakdown | null = null;
  const modelBreakdowns = snapshot.byModel
    .map((summary) => deriveModelUsageCostBreakdown(summary, snapshot.turns))
    .filter((breakdown): breakdown is UsageCostBreakdown => breakdown !== null);

  if (modelBreakdowns.length === snapshot.byModel.length && modelBreakdowns.length > 0) {
    aggregate = modelBreakdowns.reduce(
      (current, next) => addUsageCostBreakdown(current, next),
      emptyUsageCostBreakdown(),
    );
  } else if (snapshot.turns.length > 0) {
    aggregate = snapshot.turns.reduce<UsageCostBreakdown | null>((current, entry) => {
      const next = deriveTurnUsageCostBreakdown(entry);
      if (!next) return current;
      return current ? addUsageCostBreakdown(current, next) : { ...next };
    }, null);
  }

  return aggregate
    ? reconcileDerivedCostBreakdown(aggregate, snapshot.estimatedTotalCostUsd)
    : snapshot.estimatedTotalCostUsd !== null
      ? usageCostBreakdownFromUnattributedCost(snapshot.estimatedTotalCostUsd)
      : null;
}
