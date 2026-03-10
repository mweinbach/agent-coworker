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
    calculateTokenCost,
    formatCost,
    formatTokenCount,
    resolveModelPricing,
    type ModelPricing,
} from "./pricing";

// ── Public types ───────────────────────────────────────────────────────

export type TurnUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    estimatedCostUsd?: number;
};

export type TurnCostEntry = {
    turnId: string;
    turnIndex: number;
    timestamp: string;
    provider: ProviderName;
    model: string;
    usage: TurnUsage;
    estimatedCostUsd: number | null;
    pricing: ModelPricing | null;
};

export type ModelUsageSummary = {
    provider: ProviderName;
    model: string;
    turns: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
};

export type SessionUsageSnapshot = {
    sessionId: string;
    totalTurns: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    estimatedTotalCostUsd: number | null;
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
    | { type: "budget_warning"; currentCostUsd: number; thresholdUsd: number; message: string }
    | { type: "budget_exceeded"; currentCostUsd: number; thresholdUsd: number; message: string };

export type CostTrackerListener = (event: CostTrackerEvent) => void;

// ── Implementation ─────────────────────────────────────────────────────

export class SessionCostTracker {
    private readonly sessionId: string;
    private readonly turns: TurnCostEntry[] = [];
    private readonly modelSummaries = new Map<string, ModelUsageSummary>();
    private readonly listeners = new Set<CostTrackerListener>();

    private totalPromptTokens = 0;
    private totalCompletionTokens = 0;
    private totalTokens = 0;
    private estimatedTotalCostUsd: number | null = null;
    private costTrackingAvailable = false;
    private hasUnknownCostTurns = false;

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
            ...(snapshot.budgetStatus.warnAtUsd !== null ? { warnAtUsd: snapshot.budgetStatus.warnAtUsd } : {}),
            ...(snapshot.budgetStatus.stopAtUsd !== null ? { stopAtUsd: snapshot.budgetStatus.stopAtUsd } : {}),
        });

        tracker.turns.push(...snapshot.turns.map((entry) => ({
            ...entry,
            usage: { ...entry.usage },
            pricing: entry.pricing ? { ...entry.pricing } : null,
        })));

        tracker.modelSummaries.clear();
        for (const summary of snapshot.byModel) {
            tracker.modelSummaries.set(
                `${summary.provider}:${summary.model}`,
                { ...summary },
            );
        }

        tracker.totalPromptTokens = snapshot.totalPromptTokens;
        tracker.totalCompletionTokens = snapshot.totalCompletionTokens;
        tracker.totalTokens = snapshot.totalTokens;
        tracker.hasUnknownCostTurns = snapshot.turns.some((entry) => entry.estimatedCostUsd === null);
        tracker.estimatedTotalCostUsd = tracker.hasUnknownCostTurns ? null : snapshot.estimatedTotalCostUsd;
        tracker.costTrackingAvailable = (
            !tracker.hasUnknownCostTurns
            && snapshot.costTrackingAvailable
            && snapshot.estimatedTotalCostUsd !== null
        );
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
    }): TurnCostEntry {
        const { turnId, provider, model, usage } = opts;
        const pricing = resolveModelPricing(provider, model);
        const costUsd =
            typeof usage.estimatedCostUsd === "number" && Number.isFinite(usage.estimatedCostUsd)
                ? usage.estimatedCostUsd
                : pricing
                    ? calculateTokenCost(
                        usage.promptTokens,
                        usage.completionTokens,
                        pricing,
                        usage.cachedPromptTokens ?? 0,
                    )
                    : null;

        const entry: TurnCostEntry = {
            turnId,
            turnIndex: this.turns.length,
            timestamp: new Date().toISOString(),
            provider,
            model,
            usage: { ...usage },
            estimatedCostUsd: costUsd,
            pricing,
        };

        this.turns.push(entry);
        this.totalPromptTokens += usage.promptTokens;
        this.totalCompletionTokens += usage.completionTokens;
        this.totalTokens += usage.totalTokens;
        this.recordSessionCost(costUsd);

        this.updateModelSummary(provider, model, usage, costUsd);
        this.updatedAt = entry.timestamp;

        // Emit turn-recorded event
        const cumulative = this.getSnapshot();
        this.emit({ type: "turn_recorded", entry, cumulative });

        // Check budget thresholds
        this.checkBudget();

        return entry;
    }

    // ── Budget management ──────────────────────────────────────────────

    setBudget(thresholds: BudgetThresholds): void {
        this.assertValidBudgetThresholds(thresholds);
        this.budgetThresholds = { ...thresholds };
        const currentCostUsd = this.estimatedTotalCostUsd;
        this.warningTriggered = thresholds.warnAtUsd !== undefined && currentCostUsd !== null
            ? currentCostUsd >= thresholds.warnAtUsd
            : false;
        this.stopTriggered = thresholds.stopAtUsd !== undefined && currentCostUsd !== null
            ? currentCostUsd >= thresholds.stopAtUsd
            : false;
        this.updatedAt = new Date().toISOString();
    }

    updateBudget(thresholds: BudgetThresholdUpdate): void {
        this.setBudget(this.resolveUpdatedBudgetThresholds(thresholds));
    }

    getBudgetStatus(): BudgetStatus {
        return {
            configured: this.budgetThresholds.warnAtUsd !== undefined || this.budgetThresholds.stopAtUsd !== undefined,
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
        return {
            sessionId: this.sessionId,
            totalTurns: this.turns.length,
            totalPromptTokens: this.totalPromptTokens,
            totalCompletionTokens: this.totalCompletionTokens,
            totalTokens: this.totalTokens,
            estimatedTotalCostUsd: this.estimatedTotalCostUsd,
            costTrackingAvailable: this.costTrackingAvailable,
            byModel: Array.from(this.modelSummaries.values()).map(s => ({ ...s })),
            turns: this.turns.map((entry) => ({
                ...entry,
                usage: { ...entry.usage },
                pricing: entry.pricing ? { ...entry.pricing } : null,
            })),
            budgetStatus: this.getBudgetStatus(),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    /**
     * Return a compact human-readable summary suitable for terminal display.
     */
    formatSummary(): string {
        const lines: string[] = [];

        if (this.turns.length === 0) {
            lines.push("No turns recorded yet.");
            return lines.join("\n");
        }

        lines.push(`Session Usage (${this.turns.length} turn${this.turns.length !== 1 ? "s" : ""}):`);
        lines.push(`  Tokens:  ${formatTokenCount(this.totalPromptTokens)} in / ${formatTokenCount(this.totalCompletionTokens)} out / ${formatTokenCount(this.totalTokens)} total`);

        if (this.estimatedTotalCostUsd !== null) {
            lines.push(`  Cost:    ${formatCost(this.estimatedTotalCostUsd)}`);
        } else {
            lines.push("  Cost:    (pricing unavailable for this model)");
        }

        if (this.modelSummaries.size > 1) {
            lines.push("  Breakdown:");
            for (const summary of this.modelSummaries.values()) {
                const cost = summary.estimatedCostUsd !== null ? formatCost(summary.estimatedCostUsd) : "n/a";
                lines.push(`    ${summary.provider}/${summary.model}: ${summary.turns} turns, ${formatTokenCount(summary.totalTokens)} tokens, ${cost}`);
            }
        }

        const budget = this.getBudgetStatus();
        if (budget.configured) {
            lines.push("  Budget:");
            if (budget.warnAtUsd !== null) {
                const pct = this.estimatedTotalCostUsd !== null
                    ? ` (${((this.estimatedTotalCostUsd / budget.warnAtUsd) * 100).toFixed(0)}%)`
                    : "";
                lines.push(`    Warning:  ${formatCost(budget.warnAtUsd)}${pct}${budget.warningTriggered ? " ⚠️  TRIGGERED" : ""}`);
            }
            if (budget.stopAtUsd !== null) {
                const pct = this.estimatedTotalCostUsd !== null
                    ? ` (${((this.estimatedTotalCostUsd / budget.stopAtUsd) * 100).toFixed(0)}%)`
                    : "";
                lines.push(`    Hard cap:  ${formatCost(budget.stopAtUsd)}${pct}${budget.stopTriggered ? " 🛑 EXCEEDED" : ""}`);
            }
        }

        return lines.join("\n");
    }

    /**
     * Format the last N turns for display.
     */
    formatRecentTurns(count = 5): string {
        const recent = this.turns.slice(-count);
        if (recent.length === 0) return "No turns recorded.";

        const lines: string[] = [];
        for (const turn of recent) {
            const cost = turn.estimatedCostUsd !== null ? formatCost(turn.estimatedCostUsd) : "n/a";
            const time = this.formatTurnTimestamp(turn.timestamp);
            lines.push(`  #${turn.turnIndex + 1} [${time}] ${turn.provider}/${turn.model}: ${formatTokenCount(turn.usage.totalTokens)} tokens, ${cost}`);
        }
        return lines.join("\n");
    }

    // ── Event listeners ────────────────────────────────────────────────

    addListener(listener: CostTrackerListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    removeListener(listener: CostTrackerListener): void {
        this.listeners.delete(listener);
    }

    // ── Internals ──────────────────────────────────────────────────────

    private updateModelSummary(
        provider: ProviderName,
        model: string,
        usage: TurnUsage,
        costUsd: number | null,
    ): void {
        const key = `${provider}:${model}`;
        const existing = this.modelSummaries.get(key);

        if (existing) {
            existing.turns += 1;
            existing.totalPromptTokens += usage.promptTokens;
            existing.totalCompletionTokens += usage.completionTokens;
            existing.totalTokens += usage.totalTokens;
            if (existing.estimatedCostUsd === null || costUsd === null) {
                existing.estimatedCostUsd = null;
            } else {
                existing.estimatedCostUsd += costUsd;
            }
        } else {
            this.modelSummaries.set(key, {
                provider,
                model,
                turns: 1,
                totalPromptTokens: usage.promptTokens,
                totalCompletionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                estimatedCostUsd: costUsd,
            });
        }
    }

    private recordSessionCost(costUsd: number | null): void {
        if (costUsd === null) {
            this.hasUnknownCostTurns = true;
            this.costTrackingAvailable = false;
            this.estimatedTotalCostUsd = null;
            return;
        }

        if (this.hasUnknownCostTurns) {
            this.costTrackingAvailable = false;
            this.estimatedTotalCostUsd = null;
            return;
        }

        this.costTrackingAvailable = true;
        this.estimatedTotalCostUsd = (this.estimatedTotalCostUsd ?? 0) + costUsd;
    }

    private checkBudget(): void {
        if (this.estimatedTotalCostUsd === null) return;

        const { warnAtUsd, stopAtUsd } = this.budgetThresholds;

        if (warnAtUsd !== undefined && !this.warningTriggered && this.estimatedTotalCostUsd >= warnAtUsd) {
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
        const nextWarnAtUsd = thresholds.warnAtUsd === undefined ? current.warnAtUsd : thresholds.warnAtUsd;
        const nextStopAtUsd = thresholds.stopAtUsd === undefined ? current.stopAtUsd : thresholds.stopAtUsd;

        return {
            ...(typeof nextWarnAtUsd === "number" ? { warnAtUsd: nextWarnAtUsd } : {}),
            ...(typeof nextStopAtUsd === "number" ? { stopAtUsd: nextStopAtUsd } : {}),
        };
    }

    private assertValidBudgetThresholds(thresholds: BudgetThresholds): void {
        if (
            thresholds.warnAtUsd !== undefined
            && thresholds.stopAtUsd !== undefined
            && thresholds.warnAtUsd >= thresholds.stopAtUsd
        ) {
            throw new Error("Warning threshold must be less than the hard-stop threshold.");
        }
    }

    private formatTurnTimestamp(timestamp: string): string {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return timestamp;
        }
        return `${date.toISOString().slice(11, 19)}Z`;
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
