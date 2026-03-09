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

    private budgetThresholds: BudgetThresholds = {};
    private warningTriggered = false;
    private stopTriggered = false;

    private readonly createdAt: string;
    private updatedAt: string;

    constructor(sessionId: string, budget?: BudgetThresholds) {
        this.sessionId = sessionId;
        if (budget) this.budgetThresholds = { ...budget };
        this.createdAt = new Date().toISOString();
        this.updatedAt = this.createdAt;
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
        const costUsd = pricing
            ? calculateTokenCost(usage.promptTokens, usage.completionTokens, pricing)
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

        if (costUsd !== null) {
            this.costTrackingAvailable = true;
            this.estimatedTotalCostUsd = (this.estimatedTotalCostUsd ?? 0) + costUsd;
        }

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
        this.budgetThresholds = { ...thresholds };
        // Reset triggers if thresholds increased
        if (thresholds.warnAtUsd !== undefined && this.estimatedTotalCostUsd !== null) {
            this.warningTriggered = this.estimatedTotalCostUsd >= thresholds.warnAtUsd;
        }
        if (thresholds.stopAtUsd !== undefined && this.estimatedTotalCostUsd !== null) {
            this.stopTriggered = this.estimatedTotalCostUsd >= thresholds.stopAtUsd;
        }
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
            byModel: Array.from(this.modelSummaries.values()),
            turns: [...this.turns],
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
            const time = new Date(turn.timestamp).toLocaleTimeString();
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
            if (costUsd !== null) {
                existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + costUsd;
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
