import { beforeEach, describe, expect, test } from "bun:test";

import { createUsageTool } from "../src/tools/usage";
import { SessionCostTracker } from "../src/session/costTracker";
import type { ToolContext } from "../src/tools/context";
import type { AgentConfig } from "../src/types";

describe("usage tool", () => {
    let tracker: SessionCostTracker;
    let ctx: ToolContext;

    beforeEach(() => {
        tracker = new SessionCostTracker("session-123");

        // Simulate some usage
        tracker.recordTurn({
            turnId: "turn-1",
            provider: "openai",
            model: "gpt-4o",
            usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        });

        ctx = {
            config: {} as AgentConfig,
            log: () => { },
            askUser: async () => "",
            approveCommand: async () => true,
            costTracker: tracker,
        };
    });

    test("summary action returns formatted summary from tracker", async () => {
        const tool = createUsageTool(ctx);
        const result = await tool.execute({ action: "summary" });
        expect(result).toContain("1 turn");
        expect(result).toContain("1.5k total");
        expect(result).toContain("Cost:");
    });

    test("detail action returns breakdown with recent turns", async () => {
        const tool = createUsageTool(ctx);
        const result = await tool.execute({ action: "detail", lastN: 5 });
        expect(result).toContain("Recent turns:");
        expect(result).toContain("gpt-4o");
        expect(result).toContain("1.5k tokens");
    });

    test("budget action shows empty status initially", async () => {
        const tool = createUsageTool(ctx);
        const result = await tool.execute({ action: "budget" });
        expect(result).toContain("No budget thresholds configured");
    });

    test("set_budget action configures thresholds correctly", async () => {
        const tool = createUsageTool(ctx);
        const result = await tool.execute({ action: "set_budget", warnAtUsd: 1.0, stopAtUsd: 5.0 });
        expect(result).toContain("Warning at: $1.00");
        expect(result).toContain("Hard stop at: $5.00");

        const budgetStatus = await tool.execute({ action: "budget" });
        expect(budgetStatus).toContain("Warning threshold:  $1.00");
        expect(budgetStatus).toContain("Hard-stop threshold: $5.00");
    });

    test("set_budget preserves unspecified thresholds", async () => {
        const tool = createUsageTool(ctx);
        await tool.execute({ action: "set_budget", warnAtUsd: 1.0, stopAtUsd: 5.0 });
        await tool.execute({ action: "set_budget", warnAtUsd: 2.0 });

        const budgetStatus = await tool.execute({ action: "budget" });
        expect(budgetStatus).toContain("Warning threshold:  $2.00");
        expect(budgetStatus).toContain("Hard-stop threshold: $5.00");
    });

    test("set_budget clears explicit thresholds with null", async () => {
        const tool = createUsageTool(ctx);
        await tool.execute({ action: "set_budget", warnAtUsd: 1.0, stopAtUsd: 5.0 });

        const result = await tool.execute({ action: "set_budget", stopAtUsd: null });
        expect(result).toContain("Hard stop cleared");

        const budgetStatus = await tool.execute({ action: "budget" });
        expect(budgetStatus).toContain("Warning threshold:  $1.00");
        expect(budgetStatus).not.toContain("Hard-stop threshold:");
    });

    test("set_budget rejects invalid configurations", async () => {
        const tool = createUsageTool(ctx);
        const missingBoth = await tool.execute({ action: "set_budget" });
        expect(missingBoth).toContain("Provide at least one of");

        const warnHigherThanStop = await tool.execute({ action: "set_budget", warnAtUsd: 10, stopAtUsd: 5 });
        expect(warnHigherThanStop).toContain("Warning threshold must be less than");

        await tool.execute({ action: "set_budget", stopAtUsd: 5 });
        const invalidMergedUpdate = await tool.execute({ action: "set_budget", warnAtUsd: 10 });
        expect(invalidMergedUpdate).toContain("Warning threshold must be less than");
    });

    test("pricing action lists the catalog", async () => {
        const tool = createUsageTool(ctx);
        const result = await tool.execute({ action: "pricing" });
        expect(result).toContain("Known Model Pricing");
        expect(result).toContain("gpt-5.4");
        expect(result).toContain("claude-opus-4-6");
    });

    test("returns unavailable message if no costTracker in context", async () => {
        const noTrackerCtx = { ...ctx, costTracker: undefined };
        const tool = createUsageTool(noTrackerCtx);
        const result = await tool.execute({ action: "summary" });
        expect(result).toBe("Cost tracking is not available for this session.");
    });
});
