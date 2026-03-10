import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  canClearSessionHardCap,
  ChatThreadHeader,
  filterFeedForDeveloperMode,
  formatSessionBudgetLine,
  formatSessionUsageHeadline,
  reasoningLabelForMode,
  reasoningPreviewText,
  sessionUsageTone,
  shouldToggleReasoningExpanded,
} from "../src/ui/ChatView";

describe("desktop reasoning UI helpers", () => {
  test("maps reasoning mode to labels", () => {
    expect(reasoningLabelForMode("reasoning")).toBe("Reasoning");
    expect(reasoningLabelForMode("summary")).toBe("Summary");
  });

  test("builds collapsed preview from first lines", () => {
    expect(reasoningPreviewText("line 1\nline 2", 3)).toBe("line 1\nline 2");
    expect(reasoningPreviewText("line 1\nline 2\nline 3\nline 4", 3)).toBe("line 1\nline 2\nline 3...");
  });

  test("keyboard toggle helper only allows Enter and Space", () => {
    expect(shouldToggleReasoningExpanded("Enter")).toBe(true);
    expect(shouldToggleReasoningExpanded(" ")).toBe(true);
    expect(shouldToggleReasoningExpanded("Spacebar")).toBe(true);
    expect(shouldToggleReasoningExpanded("Escape")).toBe(false);
  });

  test("hides system feed entries unless developer mode is enabled", () => {
    const feed = [
      { id: "a", kind: "system", ts: "2024-01-01T00:00:00.000Z", line: "[server_hello]" },
      { id: "b", kind: "message", role: "assistant" as const, ts: "2024-01-01T00:00:01.000Z", text: "hi" },
    ];

    expect(filterFeedForDeveloperMode(feed, false)).toEqual([
      { id: "b", kind: "message", role: "assistant", ts: "2024-01-01T00:00:01.000Z", text: "hi" },
    ]);
    expect(filterFeedForDeveloperMode(feed, true)).toEqual(feed);
  });

  test("formats session usage headline for normal mode without token counts", () => {
    expect(
      formatSessionUsageHeadline(
        {
          sessionId: "thread-session",
          totalTurns: 2,
          totalPromptTokens: 300,
          totalCompletionTokens: 120,
          totalTokens: 420,
          estimatedTotalCostUsd: 0.0025,
          costTrackingAvailable: true,
          byModel: [],
          turns: [],
          budgetStatus: {
            configured: false,
            warnAtUsd: null,
            stopAtUsd: null,
            warningTriggered: false,
            stopTriggered: false,
            currentCostUsd: 0.0025,
          },
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:01.000Z",
        },
        {
          turnId: "turn-2",
          usage: {
            promptTokens: 200,
            completionTokens: 50,
            totalTokens: 250,
          },
        },
      ),
    ).toBe("est. $0.0025");
  });

  test("formats session usage headline with token counts in developer mode", () => {
    expect(
      formatSessionUsageHeadline(
        {
          sessionId: "thread-session",
          totalTurns: 2,
          totalPromptTokens: 300,
          totalCompletionTokens: 120,
          totalTokens: 420,
          estimatedTotalCostUsd: 0.0025,
          costTrackingAvailable: true,
          byModel: [],
          turns: [],
          budgetStatus: {
            configured: false,
            warnAtUsd: null,
            stopAtUsd: null,
            warningTriggered: false,
            stopTriggered: false,
            currentCostUsd: 0.0025,
          },
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:01.000Z",
        },
        {
          turnId: "turn-2",
          usage: {
            promptTokens: 200,
            completionTokens: 50,
            totalTokens: 250,
          },
        },
        { showTokens: true },
      ),
    ).toBe("2 turns • 420 tokens • est. $0.0025 • last 250 tokens");
  });

  test("formats budget lines and tone for warning and stop states", () => {
    const warningUsage = {
      sessionId: "thread-session",
      totalTurns: 1,
      totalPromptTokens: 100,
      totalCompletionTokens: 20,
      totalTokens: 120,
      estimatedTotalCostUsd: 0.02,
      costTrackingAvailable: true,
      byModel: [],
      turns: [],
      budgetStatus: {
        configured: true,
        warnAtUsd: 0.01,
        stopAtUsd: 1,
        warningTriggered: true,
        stopTriggered: false,
        currentCostUsd: 0.02,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    };

    expect(formatSessionBudgetLine(warningUsage)).toBe("Warning threshold reached at $0.01");
    expect(sessionUsageTone(warningUsage)).toContain("amber");

    expect(
      formatSessionBudgetLine({
        ...warningUsage,
        budgetStatus: {
          ...warningUsage.budgetStatus,
          stopTriggered: true,
          stopAtUsd: 0.02,
        },
      }),
    ).toBe("Hard cap exceeded at $0.02");
  });

  test("only exposes hard-cap clearing once the thread has reconnected", () => {
    const stoppedUsage = {
      sessionId: "session-1",
      totalTurns: 1,
      totalPromptTokens: 100,
      totalCompletionTokens: 20,
      totalTokens: 120,
      estimatedTotalCostUsd: 0.02,
      costTrackingAvailable: true,
      byModel: [],
      turns: [],
      budgetStatus: {
        configured: true,
        warnAtUsd: 0.01,
        stopAtUsd: 0.02,
        warningTriggered: true,
        stopTriggered: true,
        currentCostUsd: 0.02,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    };

    expect(canClearSessionHardCap({
      sessionUsage: stoppedUsage,
      transcriptOnly: false,
      connected: false,
      sessionId: null,
      threadStatus: "active",
    })).toBe(false);

    expect(canClearSessionHardCap({
      sessionUsage: stoppedUsage,
      transcriptOnly: false,
      connected: true,
      sessionId: "session-1",
      threadStatus: "active",
    })).toBe(true);
  });

  test("renders usage stats as a title hover/focus reveal instead of an always-on header row", () => {
    const sessionUsage = {
      sessionId: "session-1",
      totalTurns: 2,
      totalPromptTokens: 300,
      totalCompletionTokens: 120,
      totalTokens: 420,
      estimatedTotalCostUsd: 0.0025,
      costTrackingAvailable: true,
      byModel: [],
      turns: [],
      budgetStatus: {
        configured: true,
        warnAtUsd: 0.01,
        stopAtUsd: null,
        warningTriggered: false,
        stopTriggered: false,
        currentCostUsd: 0.0025,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(ChatThreadHeader, {
        title: "Usage thread",
        sessionUsage,
        usageHeadline: formatSessionUsageHeadline(sessionUsage, {
          turnId: "turn-2",
          usage: {
            promptTokens: 200,
            completionTokens: 50,
            totalTokens: 250,
          },
        }, { showTokens: true }),
        usageBudgetLine: formatSessionBudgetLine(sessionUsage),
        canClearHardCap: false,
        onClearHardCap: () => {},
      }),
    );

    expect(html).toContain("Usage thread");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-focus-within:opacity-100");
    expect(html).toContain("420 tokens");
  });

  test("renders normal-mode header copy without token counts", () => {
    const sessionUsage = {
      sessionId: "session-1",
      totalTurns: 2,
      totalPromptTokens: 300,
      totalCompletionTokens: 120,
      totalTokens: 420,
      estimatedTotalCostUsd: 0.0025,
      costTrackingAvailable: true,
      byModel: [],
      turns: [],
      budgetStatus: {
        configured: true,
        warnAtUsd: 0.01,
        stopAtUsd: null,
        warningTriggered: false,
        stopTriggered: false,
        currentCostUsd: 0.0025,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    };

    const html = renderToStaticMarkup(
      createElement(ChatThreadHeader, {
        title: "Usage thread",
        sessionUsage,
        usageHeadline: formatSessionUsageHeadline(sessionUsage, {
          turnId: "turn-2",
          usage: {
            promptTokens: 200,
            completionTokens: 50,
            totalTokens: 250,
          },
        }),
        usageBudgetLine: formatSessionBudgetLine(sessionUsage),
        canClearHardCap: false,
        onClearHardCap: () => {},
      }),
    );

    expect(html).toContain("est. $0.0025");
    expect(html).not.toContain("2 turns");
    expect(html).not.toContain("420 tokens");
    expect(html).not.toContain("last 250 tokens");
  });
});
