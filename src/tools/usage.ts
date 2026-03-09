/**
 * `usage` tool — query session token usage and estimated costs.
 *
 * Gives the agent and user visibility into how many tokens have been
 * consumed, what it costs, and whether budget thresholds are approaching.
 *
 * Actions:
 *   - summary:  compact overview of session usage
 *   - detail:   per-turn breakdown with costs
 *   - budget:   current budget status
 *   - set_budget: configure warn/stop thresholds
 */

import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { formatCost, listPricingCatalog } from "../session/pricing";

export function createUsageTool(ctx: ToolContext) {
    return defineTool({
        description: `Query session token usage, cost estimates, and budget status.

Actions:
- "summary": Get a compact overview of session token usage and estimated cost.
- "detail": Get per-turn breakdown including model, tokens, and cost per turn.
- "budget": Check current budget thresholds and whether they have been triggered.
- "set_budget": Set warning and/or hard-stop cost thresholds in USD.
- "pricing": List known model pricing for reference.

Use this tool to monitor spending, check costs before expensive operations, or set budget limits.`,
        inputSchema: z.object({
            action: z
                .enum(["summary", "detail", "budget", "set_budget", "pricing"])
                .describe("The usage query action to perform"),
            warnAtUsd: z
                .number()
                .positive()
                .optional()
                .describe("Budget warning threshold in USD (for set_budget)"),
            stopAtUsd: z
                .number()
                .positive()
                .optional()
                .describe("Budget hard-stop threshold in USD (for set_budget)"),
            lastN: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Number of recent turns to show (for detail, default 10)"),
        }),
        execute: async ({
            action,
            warnAtUsd,
            stopAtUsd,
            lastN,
        }: {
            action: "summary" | "detail" | "budget" | "set_budget" | "pricing";
            warnAtUsd?: number;
            stopAtUsd?: number;
            lastN?: number;
        }) => {
            ctx.log(`tool> usage ${JSON.stringify({ action })}`);

            const tracker = ctx.costTracker;

            if (!tracker) {
                return "Cost tracking is not available for this session.";
            }

            switch (action) {
                case "summary": {
                    const summary = tracker.formatSummary();
                    ctx.log(`tool< usage summary`);
                    return summary;
                }

                case "detail": {
                    const count = lastN ?? 10;
                    const snapshot = tracker.getSnapshot();
                    const header = tracker.formatSummary();
                    const recent = tracker.formatRecentTurns(count);
                    const totalNote =
                        snapshot.totalTurns > count
                            ? `\n\n(Showing last ${count} of ${snapshot.totalTurns} turns)`
                            : "";

                    const result = `${header}\n\nRecent turns:\n${recent}${totalNote}`;
                    ctx.log(`tool< usage detail turns=${snapshot.totalTurns}`);
                    return result;
                }

                case "budget": {
                    const status = tracker.getBudgetStatus();
                    if (!status.configured) {
                        const currentCost =
                            status.currentCostUsd !== null
                                ? `Current estimated cost: ${formatCost(status.currentCostUsd)}`
                                : "No cost data available yet.";
                        return `No budget thresholds configured.\n${currentCost}\n\nUse action "set_budget" to configure warning and/or hard-stop thresholds.`;
                    }

                    const lines: string[] = ["Budget Status:"];
                    if (status.warnAtUsd !== null) {
                        lines.push(`  Warning threshold:  ${formatCost(status.warnAtUsd)}${status.warningTriggered ? " ⚠️  TRIGGERED" : ""}`);
                    }
                    if (status.stopAtUsd !== null) {
                        lines.push(`  Hard-stop threshold: ${formatCost(status.stopAtUsd)}${status.stopTriggered ? " 🛑 EXCEEDED" : ""}`);
                    }
                    if (status.currentCostUsd !== null) {
                        lines.push(`  Current cost:        ${formatCost(status.currentCostUsd)}`);
                    }

                    ctx.log(`tool< usage budget configured=${status.configured}`);
                    return lines.join("\n");
                }

                case "set_budget": {
                    if (warnAtUsd === undefined && stopAtUsd === undefined) {
                        return 'Provide at least one of "warnAtUsd" or "stopAtUsd" to set a budget threshold.';
                    }

                    if (stopAtUsd !== undefined && warnAtUsd !== undefined && warnAtUsd >= stopAtUsd) {
                        return "Warning threshold must be less than the hard-stop threshold.";
                    }

                    tracker.setBudget({
                        warnAtUsd,
                        stopAtUsd,
                    });

                    const parts: string[] = ["Budget updated:"];
                    if (warnAtUsd !== undefined) parts.push(`  Warning at: ${formatCost(warnAtUsd)}`);
                    if (stopAtUsd !== undefined) parts.push(`  Hard stop at: ${formatCost(stopAtUsd)}`);

                    ctx.log(`tool< usage set_budget warn=${warnAtUsd} stop=${stopAtUsd}`);
                    return parts.join("\n");
                }

                case "pricing": {
                    const catalog = listPricingCatalog();
                    if (catalog.length === 0) return "No pricing data available.";

                    const lines: string[] = [
                        "Known Model Pricing (per 1M tokens):",
                        "",
                        "Provider         | Model                                      | Input    | Output   | Cached",
                        "─────────────────|────────────────────────────────────────────|──────────|──────────|────────",
                    ];

                    for (const entry of catalog) {
                        const cached = entry.pricing.cachedInputPerMillion !== undefined
                            ? `$${entry.pricing.cachedInputPerMillion.toFixed(3)}`
                            : "n/a";
                        lines.push(
                            `${entry.provider.padEnd(17)}| ${entry.model.padEnd(43)}| $${entry.pricing.inputPerMillion.toFixed(3).padEnd(7)}| $${entry.pricing.outputPerMillion.toFixed(3).padEnd(7)}| ${cached}`
                        );
                    }

                    ctx.log(`tool< usage pricing entries=${catalog.length}`);
                    return lines.join("\n");
                }

                default:
                    return `Unknown action: ${action}`;
            }
        },
    });
}
