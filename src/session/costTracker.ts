/**
 * Session-level cost tracker.
 *
 * Accumulates per-turn token usage and cost estimates across the lifetime
 * of an agent session. Designed to integrate with the existing `turn_usage`
 * protocol event and emits cumulative `session_usage` summaries.
 *
 * Features:
 *   - Per-turn and cumulative token/cost tracking
 *   - Budget alerts (warn / hard-stop thresholds)
 *   - Per-provider, per-model breakdown
 *   - Export-friendly snapshots
 *   - Thread-safe accumulation (single-writer)
 */

import type { ProviderName } from "../types";
import {
  calculateTokenCostBreakdown,
  formatCost,
  type ModelPricing,
  resolveModelPricing,
  type TokenCostBreakdown,
} from "./pricing";

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

export type BudgetThresholds = {
  /** Soft limit in USD — triggers a warning but does not stop the agent. */
  warnAtUsd?: number;
  /** Hard limit in USD — should signal to stop accepting new turns. */
  stopAtUsd?: number;
};

export type BudgetThresholdUpdate = {
  warnAtUsd?: number | null;
  stopAtUsd?: number | null;
};

export type BudgetStatus = {
  configured: boolean;
  warnAtUsd: number | null;
  stopAtUsd: number | null;
  warningTriggered: boolean;
  stopTriggered: boolean;
  currentCostUsd: number | null;
};

export type CostTrackerEvent =
  | { type: "turn_recorded"; entry: TurnCostEntry; cumulative: SessionUsageSnapshot }
  | { type: "usage_changed"; cumulative: SessionUsageSnapshot }
  | { type: "budget_warning"; currentCostUsd: number; thresholdUsd: number; message: string }
  | { type: "budget_exceeded"; currentCostUsd: number; thresholdUsd: number; message: string };

export type CostTrackerListener = (event: CostTrackerEvent) => void;

// ── Implementation ─────────────────────────────────────────────────────

const MAX_TURNS = 512;

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

function calculateTurnUsageCost(
  usage: TurnUsage,
  pricing: ModelPricing | null,
  requestUsages: readonly TurnUsage[] | null | undefined,
): { costUsd: number | null; costBreakdown: UsageCostBreakdown | null } {
  const requests =
    requestUsages === undefined
      ? [usage]
      : requestUsages?.length && hasMatchingTokenUsage(usage, requestUsages)
        ? requestUsages
        : null;
  if (
    requests === null &&
    pricing?.longContextThresholdTokens !== undefined &&
    usage.promptTokens > pricing.longContextThresholdTokens
  ) {
    return { costUsd: null, costBreakdown: null };
  }

  let costUsd = 0;
  let costBreakdown = emptyUsageCostBreakdown();
  for (const request of requests ?? [usage]) {
    if (pricing) {
      const breakdown = calculateTokenCostBreakdown(
        request.promptTokens,
        request.completionTokens,
        pricing,
        request.cachedPromptTokens ?? 0,
        request.cacheWritePromptTokens ?? 0,
      );
      costUsd += breakdown.totalCostUsd;
      costBreakdown = addUsageCostBreakdown(
        costBreakdown,
        usageCostBreakdownFromTokenBreakdown(breakdown),
      );
    } else if (
      typeof request.estimatedCostUsd === "number" &&
      Number.isFinite(request.estimatedCostUsd)
    ) {
      costUsd += request.estimatedCostUsd;
      costBreakdown = addUsageCostBreakdown(
        costBreakdown,
        usageCostBreakdownFromUnattributedCost(request.estimatedCostUsd),
      );
    } else {
      return { costUsd: null, costBreakdown: null };
    }
  }
  return { costUsd, costBreakdown };
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
  options: DeriveUsageCostBreakdownOptions,
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
    const breakdowns = modelTurns.map((entry) => deriveTurnUsageCostBreakdown(entry, options));
    if (breakdowns.every((breakdown) => breakdown !== null)) {
      return reconcileDerivedCostBreakdown(
        breakdowns.reduce(addUsageCostBreakdown, emptyUsageCostBreakdown()),
        summary.estimatedCostUsd,
      );
    }
  }

  const pricing =
    options.resolveMissingPricing === false
      ? null
      : resolveModelPricing(summary.provider, summary.model);
  if (pricing && pricing.longContextThresholdTokens === undefined) {
    const breakdown = calculateTokenCostBreakdown(
      summary.totalPromptTokens,
      summary.totalCompletionTokens,
      pricing,
      summary.totalCachedPromptTokens ?? 0,
      summary.totalCacheWritePromptTokens ?? 0,
    );
    if (Math.abs(breakdown.totalCostUsd - summary.estimatedCostUsd) < 0.000001) {
      return usageCostBreakdownFromTokenBreakdown(breakdown);
    }
  }

  return usageCostBreakdownFromUnattributedCost(summary.estimatedCostUsd);
}

function deriveTurnUsageCostBreakdown(
  entry: TurnCostEntry,
  options: DeriveUsageCostBreakdownOptions,
): UsageCostBreakdown | null {
  if (entry.costBreakdown !== undefined) {
    return entry.costBreakdown ? { ...entry.costBreakdown } : null;
  }
  if (entry.estimatedCostUsd === null) return null;

  const pricing =
    entry.pricing ??
    (options.resolveMissingPricing === false
      ? null
      : resolveModelPricing(entry.provider, entry.model));
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

export type DeriveUsageCostBreakdownOptions = {
  resolveMissingPricing?: boolean;
};

export function deriveUsageCostBreakdown(
  snapshot: Pick<
    SessionUsageSnapshot,
    "byModel" | "costBreakdown" | "estimatedTotalCostUsd" | "turns"
  >,
  options: DeriveUsageCostBreakdownOptions = {},
): UsageCostBreakdown | null {
  if (snapshot.costBreakdown) {
    return { ...snapshot.costBreakdown };
  }

  let aggregate: UsageCostBreakdown | null = null;
  const modelBreakdowns = snapshot.byModel
    .map((summary) => deriveModelUsageCostBreakdown(summary, snapshot.turns, options))
    .filter((breakdown): breakdown is UsageCostBreakdown => breakdown !== null);

  if (modelBreakdowns.length === snapshot.byModel.length && modelBreakdowns.length > 0) {
    aggregate = modelBreakdowns.reduce(
      (current, next) => addUsageCostBreakdown(current, next),
      emptyUsageCostBreakdown(),
    );
  } else if (snapshot.turns.length > 0) {
    aggregate = snapshot.turns.reduce<UsageCostBreakdown | null>((current, entry) => {
      const next = deriveTurnUsageCostBreakdown(entry, options);
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

export class SessionCostTracker {
  private static readonly COMPACT_SNAPSHOT_TURNS_LIMIT = 8;
  private readonly sessionId: string;
  private readonly turns: TurnCostEntry[] = [];
  private readonly modelSummaries = new Map<string, ModelUsageSummary>();
  private readonly listeners = new Set<CostTrackerListener>();

  private lifetimeTurnCount = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;
  private totalCachedPromptTokens = 0;
  private totalCacheWritePromptTokens = 0;
  private totalReasoningOutputTokens = 0;
  private estimatedTotalCostUsd: number | null = null;
  private costBreakdown: UsageCostBreakdown | null = emptyUsageCostBreakdown();
  private costTrackingAvailable: boolean = false;
  private hasUnknownCostTurns: boolean = false;

  private budgetThresholds: BudgetThresholds = {};
  private warningTriggered = false;
  private stopTriggered = false;

  private createdAt: string;
  private updatedAt: string;

  constructor(sessionId: string, budget?: BudgetThresholds) {
    this.sessionId = sessionId;
    if (budget) this.budgetThresholds = { ...budget };
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
  }

  static fromSnapshot(snapshot: SessionUsageSnapshot): SessionCostTracker {
    const tracker = new SessionCostTracker(snapshot.sessionId, {
      ...(snapshot.budgetStatus.warnAtUsd !== null
        ? { warnAtUsd: snapshot.budgetStatus.warnAtUsd }
        : {}),
      ...(snapshot.budgetStatus.stopAtUsd !== null
        ? { stopAtUsd: snapshot.budgetStatus.stopAtUsd }
        : {}),
    });

    tracker.turns.push(
      ...snapshot.turns.map((entry) => ({
        ...entry,
        usage: { ...entry.usage },
        ...(entry.costBreakdown !== undefined
          ? {
              costBreakdown: entry.costBreakdown ? { ...entry.costBreakdown } : null,
            }
          : {}),
        pricing: entry.pricing ? { ...entry.pricing } : null,
      })),
    );

    tracker.modelSummaries.clear();
    for (const summary of snapshot.byModel) {
      tracker.modelSummaries.set(`${summary.provider}:${summary.model}`, {
        ...summary,
        ...(summary.costBreakdown ? { costBreakdown: { ...summary.costBreakdown } } : {}),
      });
    }

    tracker.lifetimeTurnCount = Math.max(snapshot.totalTurns, snapshot.turns.length);
    tracker.totalPromptTokens = snapshot.totalPromptTokens;
    tracker.totalCompletionTokens = snapshot.totalCompletionTokens;
    tracker.totalTokens = snapshot.totalTokens;
    tracker.totalCachedPromptTokens =
      snapshot.totalCachedPromptTokens ??
      snapshot.turns.reduce((total, entry) => total + (entry.usage.cachedPromptTokens ?? 0), 0);
    tracker.totalCacheWritePromptTokens =
      snapshot.totalCacheWritePromptTokens ??
      snapshot.turns.reduce((total, entry) => total + (entry.usage.cacheWritePromptTokens ?? 0), 0);
    tracker.totalReasoningOutputTokens =
      snapshot.totalReasoningOutputTokens ??
      snapshot.turns.reduce((total, entry) => total + (entry.usage.reasoningOutputTokens ?? 0), 0);
    tracker.hasUnknownCostTurns =
      (tracker.lifetimeTurnCount > 0 && snapshot.estimatedTotalCostUsd === null) ||
      snapshot.byModel.some((summary) => summary.estimatedCostUsd === null) ||
      snapshot.turns.some((entry) => entry.estimatedCostUsd === null);
    tracker.estimatedTotalCostUsd = tracker.hasUnknownCostTurns
      ? null
      : snapshot.estimatedTotalCostUsd;
    tracker.costBreakdown = tracker.hasUnknownCostTurns ? null : deriveUsageCostBreakdown(snapshot);
    tracker.costTrackingAvailable =
      !tracker.hasUnknownCostTurns &&
      snapshot.costTrackingAvailable &&
      snapshot.estimatedTotalCostUsd !== null;
    tracker.warningTriggered = snapshot.budgetStatus.warningTriggered;
    tracker.stopTriggered = snapshot.budgetStatus.stopTriggered;
    tracker.createdAt = snapshot.createdAt;
    tracker.updatedAt = snapshot.updatedAt;

    return tracker;
  }

  // ── Core recording method ──────────────────────────────────────────

  /**
   * Record a completed turn's token usage.
   * Resolves pricing, accumulates totals, and emits events.
   */
  recordTurn(opts: {
    turnId: string;
    provider: ProviderName;
    model: string;
    usage: TurnUsage;
    /** Undefined is a single request; null or empty means unknown request boundaries. */
    requestUsages?: readonly TurnUsage[] | null;
  }): TurnCostEntry {
    const { turnId, provider, model, usage } = opts;
    const pricing = resolveModelPricing(provider, model);
    const { costUsd, costBreakdown } = calculateTurnUsageCost(usage, pricing, opts.requestUsages);

    const entry: TurnCostEntry = {
      turnId,
      turnIndex: this.lifetimeTurnCount,
      timestamp: new Date().toISOString(),
      provider,
      model,
      usage: { ...usage },
      estimatedCostUsd: costUsd,
      costBreakdown,
      pricing,
    };

    this.turns.push(entry);
    this.lifetimeTurnCount += 1;

    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    this.totalCachedPromptTokens += usage.cachedPromptTokens ?? 0;
    this.totalCacheWritePromptTokens += usage.cacheWritePromptTokens ?? 0;
    this.totalReasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
    this.recordSessionCost(costUsd, costBreakdown);
    this.updateModelSummary(provider, model, usage, costUsd, costBreakdown);

    if (this.turns.length > MAX_TURNS) {
      this.turns.splice(0, this.turns.length - MAX_TURNS);
    }

    this.updatedAt = entry.timestamp;

    // Emit turn-recorded event
    const cumulative = this.getSnapshot();
    this.emit({ type: "turn_recorded", entry, cumulative });

    // Check budget thresholds
    this.checkBudget();

    return entry;
  }

  recordUnattributedCost(usdCost: number): void {
    if (!Number.isFinite(usdCost) || usdCost < 0) {
      throw new Error("Unattributed cost must be a finite non-negative number.");
    }
    if (usdCost === 0) return;

    this.recordSessionCost(usdCost, usageCostBreakdownFromUnattributedCost(usdCost));
    this.updatedAt = new Date().toISOString();
    this.checkBudget();
    this.emit({ type: "usage_changed", cumulative: this.getSnapshot() });
  }

  // ── Budget management ──────────────────────────────────────────────

  setBudget(thresholds: BudgetThresholds): void {
    this.assertValidBudgetThresholds(thresholds);
    this.budgetThresholds = { ...thresholds };
    const currentCostUsd = this.estimatedTotalCostUsd;
    this.warningTriggered =
      thresholds.warnAtUsd !== undefined && currentCostUsd !== null
        ? currentCostUsd >= thresholds.warnAtUsd
        : false;
    this.stopTriggered =
      thresholds.stopAtUsd !== undefined && currentCostUsd !== null
        ? currentCostUsd >= thresholds.stopAtUsd
        : false;
    this.updatedAt = new Date().toISOString();
  }

  updateBudget(thresholds: BudgetThresholdUpdate): void {
    this.setBudget(this.resolveUpdatedBudgetThresholds(thresholds));
  }

  getBudgetStatus(): BudgetStatus {
    return {
      configured:
        this.budgetThresholds.warnAtUsd !== undefined ||
        this.budgetThresholds.stopAtUsd !== undefined,
      warnAtUsd: this.budgetThresholds.warnAtUsd ?? null,
      stopAtUsd: this.budgetThresholds.stopAtUsd ?? null,
      warningTriggered: this.warningTriggered,
      stopTriggered: this.stopTriggered,
      currentCostUsd: this.estimatedTotalCostUsd,
    };
  }

  isBudgetExceeded(): boolean {
    return this.stopTriggered;
  }

  // ── Snapshot / export ──────────────────────────────────────────────

  getSnapshot(): SessionUsageSnapshot {
    return this.buildSnapshot();
  }

  getCompactSnapshot(
    turnsLimit = SessionCostTracker.COMPACT_SNAPSHOT_TURNS_LIMIT,
  ): SessionUsageSnapshot {
    return this.buildSnapshot(turnsLimit);
  }

  private buildSnapshot(turnsLimit?: number): SessionUsageSnapshot {
    const turns =
      turnsLimit === undefined
        ? this.turns
        : turnsLimit >= 1
          ? this.turns.slice(-Math.trunc(turnsLimit))
          : [];
    return {
      sessionId: this.sessionId,
      totalTurns: this.lifetimeTurnCount,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
      ...(this.totalCachedPromptTokens > 0
        ? { totalCachedPromptTokens: this.totalCachedPromptTokens }
        : {}),
      ...(this.totalCacheWritePromptTokens > 0
        ? { totalCacheWritePromptTokens: this.totalCacheWritePromptTokens }
        : {}),
      ...(this.totalReasoningOutputTokens > 0
        ? { totalReasoningOutputTokens: this.totalReasoningOutputTokens }
        : {}),
      estimatedTotalCostUsd: this.estimatedTotalCostUsd,
      ...(this.costBreakdown ? { costBreakdown: { ...this.costBreakdown } } : {}),
      costTrackingAvailable: this.costTrackingAvailable,
      byModel: Array.from(this.modelSummaries.values()).map((summary) => ({
        ...summary,
        ...(summary.costBreakdown ? { costBreakdown: { ...summary.costBreakdown } } : {}),
      })),
      turns: turns.map((entry) => ({
        ...entry,
        usage: { ...entry.usage },
        ...(entry.costBreakdown !== undefined
          ? {
              costBreakdown: entry.costBreakdown ? { ...entry.costBreakdown } : null,
            }
          : {}),
        pricing: entry.pricing ? { ...entry.pricing } : null,
      })),
      budgetStatus: this.getBudgetStatus(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  // ── Event listeners ────────────────────────────────────────────────

  addListener(listener: CostTrackerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private updateModelSummary(
    provider: ProviderName,
    model: string,
    usage: TurnUsage,
    costUsd: number | null,
    costBreakdown: UsageCostBreakdown | null,
  ): void {
    const key = `${provider}:${model}`;
    const existing = this.modelSummaries.get(key);

    if (existing) {
      existing.turns += 1;
      existing.totalPromptTokens += usage.promptTokens;
      existing.totalCompletionTokens += usage.completionTokens;
      existing.totalTokens += usage.totalTokens;
      const cachedPromptTokens = usage.cachedPromptTokens ?? 0;
      if (existing.totalCachedPromptTokens !== undefined || cachedPromptTokens > 0) {
        existing.totalCachedPromptTokens =
          (existing.totalCachedPromptTokens ?? 0) + cachedPromptTokens;
      }
      const cacheWritePromptTokens = usage.cacheWritePromptTokens ?? 0;
      if (existing.totalCacheWritePromptTokens !== undefined || cacheWritePromptTokens > 0) {
        existing.totalCacheWritePromptTokens =
          (existing.totalCacheWritePromptTokens ?? 0) + cacheWritePromptTokens;
      }
      const reasoningOutputTokens = usage.reasoningOutputTokens ?? 0;
      if (existing.totalReasoningOutputTokens !== undefined || reasoningOutputTokens > 0) {
        existing.totalReasoningOutputTokens =
          (existing.totalReasoningOutputTokens ?? 0) + reasoningOutputTokens;
      }
      if (existing.estimatedCostUsd === null || costUsd === null) {
        existing.estimatedCostUsd = null;
        delete existing.costBreakdown;
      } else {
        existing.estimatedCostUsd += costUsd;
        if (existing.costBreakdown && costBreakdown) {
          existing.costBreakdown = addUsageCostBreakdown(existing.costBreakdown, costBreakdown);
        } else {
          delete existing.costBreakdown;
        }
      }
    } else {
      this.modelSummaries.set(key, {
        provider,
        model,
        turns: 1,
        totalPromptTokens: usage.promptTokens,
        totalCompletionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        ...(usage.cachedPromptTokens ? { totalCachedPromptTokens: usage.cachedPromptTokens } : {}),
        ...(usage.cacheWritePromptTokens
          ? { totalCacheWritePromptTokens: usage.cacheWritePromptTokens }
          : {}),
        ...(usage.reasoningOutputTokens
          ? { totalReasoningOutputTokens: usage.reasoningOutputTokens }
          : {}),
        estimatedCostUsd: costUsd,
        ...(costBreakdown ? { costBreakdown: { ...costBreakdown } } : {}),
      });
    }
  }

  private recordSessionCost(
    costUsd: number | null,
    costBreakdown: UsageCostBreakdown | null,
  ): void {
    if (costUsd === null) {
      this.hasUnknownCostTurns = true;
      this.costTrackingAvailable = false;
      this.estimatedTotalCostUsd = null;
      this.costBreakdown = null;
      return;
    }

    if (this.hasUnknownCostTurns) {
      this.costTrackingAvailable = false;
      this.estimatedTotalCostUsd = null;
      this.costBreakdown = null;
      return;
    }

    this.costTrackingAvailable = true;
    this.estimatedTotalCostUsd = (this.estimatedTotalCostUsd ?? 0) + costUsd;
    if (this.costBreakdown && costBreakdown) {
      this.costBreakdown = addUsageCostBreakdown(this.costBreakdown, costBreakdown);
    } else {
      this.costBreakdown = null;
    }
  }

  private checkBudget(): void {
    if (this.estimatedTotalCostUsd === null) return;

    const { warnAtUsd, stopAtUsd } = this.budgetThresholds;

    if (
      warnAtUsd !== undefined &&
      !this.warningTriggered &&
      this.estimatedTotalCostUsd >= warnAtUsd
    ) {
      this.warningTriggered = true;
      this.emit({
        type: "budget_warning",
        currentCostUsd: this.estimatedTotalCostUsd,
        thresholdUsd: warnAtUsd,
        message: `⚠️  Budget warning: session cost ${formatCost(this.estimatedTotalCostUsd)} has reached the warning threshold of ${formatCost(warnAtUsd)}.`,
      });
    }

    if (stopAtUsd !== undefined && !this.stopTriggered && this.estimatedTotalCostUsd >= stopAtUsd) {
      this.stopTriggered = true;
      this.emit({
        type: "budget_exceeded",
        currentCostUsd: this.estimatedTotalCostUsd,
        thresholdUsd: stopAtUsd,
        message: `🛑 Budget exceeded: session cost ${formatCost(this.estimatedTotalCostUsd)} has exceeded the hard cap of ${formatCost(stopAtUsd)}. No further turns will be processed.`,
      });
    }
  }

  private resolveUpdatedBudgetThresholds(thresholds: BudgetThresholdUpdate): BudgetThresholds {
    const current = this.getBudgetStatus();
    const nextWarnAtUsd =
      thresholds.warnAtUsd === undefined ? current.warnAtUsd : thresholds.warnAtUsd;
    const nextStopAtUsd =
      thresholds.stopAtUsd === undefined ? current.stopAtUsd : thresholds.stopAtUsd;

    return {
      ...(typeof nextWarnAtUsd === "number" ? { warnAtUsd: nextWarnAtUsd } : {}),
      ...(typeof nextStopAtUsd === "number" ? { stopAtUsd: nextStopAtUsd } : {}),
    };
  }

  private assertValidBudgetThresholds(thresholds: BudgetThresholds): void {
    if (
      thresholds.warnAtUsd !== undefined &&
      thresholds.stopAtUsd !== undefined &&
      thresholds.warnAtUsd >= thresholds.stopAtUsd
    ) {
      throw new Error("Warning threshold must be less than the hard-stop threshold.");
    }
  }

  private emit(event: CostTrackerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners should not throw, but we don't want to crash the tracker.
      }
    }
  }
}
