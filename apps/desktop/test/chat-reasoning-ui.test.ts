import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  canClearSessionHardCap,
  composerBusyHint,
  filterFeedForDeveloperMode,
  formatSessionBudgetLine,
  formatSessionUsageHeadline,
  getComposerSubmitState,
  loadOverflowCitationContext,
  reasoningLabelForMode,
  reasoningPreviewText,
  resolveCurrentReasoningEffort,
  sessionUsageTone,
  shouldToggleReasoningExpanded,
} from "../src/ui/ChatView";
import { ChatThreadHeader } from "../src/ui/chat/ChatThreadHeader";

describe("desktop reasoning UI helpers", () => {
  test("maps reasoning mode to labels", () => {
    expect(reasoningLabelForMode("reasoning")).toBe("Reasoning");
    expect(reasoningLabelForMode("summary")).toBe("Summary");
  });

  test("builds collapsed preview from first lines", () => {
    expect(reasoningPreviewText("line 1\nline 2", 3)).toBe("line 1\nline 2");
    expect(reasoningPreviewText("line 1\nline 2\nline 3\nline 4", 3)).toBe(
      "line 1\nline 2\nline 3...",
    );
  });

  test("keyboard toggle helper only allows Enter and Space", () => {
    expect(shouldToggleReasoningExpanded("Enter")).toBe(true);
    expect(shouldToggleReasoningExpanded(" ")).toBe(true);
    expect(shouldToggleReasoningExpanded("Spacebar")).toBe(true);
    expect(shouldToggleReasoningExpanded("Escape")).toBe(false);
  });

  test("reasoning effort precedence is composer then runtime then config then default", () => {
    // A pending composer selection wins over everything.
    expect(
      resolveCurrentReasoningEffort({
        composerEffort: "xhigh",
        runtimeEffort: "low",
        configuredEffort: "high",
        defaultEffort: "medium",
      }),
    ).toBe("xhigh");
    // Runtime (what the session is actually using) beats the config value; the
    // config-ack handler keeps runtime in sync so this never shows a stale one.
    expect(
      resolveCurrentReasoningEffort({
        composerEffort: null,
        runtimeEffort: "low",
        configuredEffort: "high",
        defaultEffort: "medium",
      }),
    ).toBe("low");
    // Config fills in when there is no runtime effort (e.g. a draft thread).
    expect(
      resolveCurrentReasoningEffort({
        composerEffort: null,
        runtimeEffort: undefined,
        configuredEffort: "high",
        defaultEffort: "medium",
      }),
    ).toBe("high");
    // Falls back to the model default when nothing else is set.
    expect(
      resolveCurrentReasoningEffort({
        composerEffort: null,
        runtimeEffort: undefined,
        configuredEffort: undefined,
        defaultEffort: "medium",
      }),
    ).toBe("medium");
  });

  test("hides system feed entries unless developer mode is enabled", () => {
    const feed = [
      { id: "a", kind: "system", ts: "2024-01-01T00:00:00.000Z", line: "[server_hello]" },
      {
        id: "b",
        kind: "message",
        role: "assistant" as const,
        ts: "2024-01-01T00:00:01.000Z",
        text: "hi",
      },
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
    expect(sessionUsageTone(warningUsage)).toContain("warning");

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
    expect(
      sessionUsageTone({
        ...warningUsage,
        budgetStatus: {
          ...warningUsage.budgetStatus,
          stopTriggered: true,
          stopAtUsd: 0.02,
        },
      }),
    ).toContain("destructive");
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

    expect(
      canClearSessionHardCap({
        sessionUsage: stoppedUsage,
        transcriptOnly: false,
        connected: false,
        sessionId: null,
        threadStatus: "active",
      }),
    ).toBe(false);

    expect(
      canClearSessionHardCap({
        sessionUsage: stoppedUsage,
        transcriptOnly: false,
        connected: true,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toBe(true);
  });

  test("keeps the stop action enabled while a run is active and the composer is empty", () => {
    expect(
      getComposerSubmitState({
        busy: true,
        hasBlockingOverlay: false,
        composerText: "",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: null,
        pendingSteer: null,
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: true, mode: "steer-ready" });

    expect(
      getComposerSubmitState({
        busy: true,
        hasBlockingOverlay: false,
        composerText: "",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: null,
        pendingSteer: null,
        submission: null,
        sessionId: null,
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: true, mode: "steer-ready" });

    expect(
      getComposerSubmitState({
        busy: true,
        hasBlockingOverlay: false,
        composerText: "tighten scope",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: null,
        pendingSteer: null,
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: false, mode: "steer-ready" });

    expect(
      getComposerSubmitState({
        busy: true,
        hasBlockingOverlay: false,
        composerText: "tighten scope",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: null,
        pendingSteer: {
          clientMessageId: "cmid-1",
          text: "tighten scope",
          attachmentSignature: "",
          status: "sending",
        },
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: true, mode: "steer-pending" });

    expect(
      getComposerSubmitState({
        busy: false,
        hasBlockingOverlay: false,
        composerText: "",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: null,
        pendingSteer: null,
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: true, mode: "send" });

    expect(
      getComposerSubmitState({
        busy: false,
        hasBlockingOverlay: false,
        composerText: "",
        hasPendingAttachments: true,
        pendingAttachmentSignature: "sig-1",
        pendingTurnStart: null,
        pendingSteer: null,
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: false, mode: "send" });

    expect(
      getComposerSubmitState({
        busy: true,
        hasBlockingOverlay: false,
        composerText: "",
        hasPendingAttachments: true,
        pendingAttachmentSignature: "sig-1",
        pendingTurnStart: null,
        pendingSteer: {
          clientMessageId: "cmid-2",
          text: "",
          attachmentSignature: "sig-1",
          status: "sending",
        },
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "ready", disabled: true, mode: "steer-pending" });

    expect(
      getComposerSubmitState({
        busy: false,
        hasBlockingOverlay: false,
        composerText: "",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: {
          clientMessageId: "cmid-3",
          text: "hello",
          attachmentSignature: "",
          status: "sending",
        },
        pendingSteer: null,
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "pending", disabled: true, mode: "send" });

    expect(
      getComposerSubmitState({
        busy: false,
        hasBlockingOverlay: false,
        composerText: "follow-up",
        hasPendingAttachments: false,
        pendingAttachmentSignature: "",
        pendingTurnStart: {
          clientMessageId: "cmid-4",
          text: "hello",
          attachmentSignature: "",
          status: "sending",
        },
        pendingSteer: null,
        submission: null,
        sessionId: "session-1",
        threadStatus: "active",
      }),
    ).toEqual({ status: "pending", disabled: true, mode: "send" });
  });

  test("renders steer-specific composer helper copy", () => {
    expect(composerBusyHint({ status: "pending", disabled: true, mode: "send" })).toBe(
      "Sending message. Waiting for the run to start.",
    );
    expect(composerBusyHint({ status: "ready", disabled: true, mode: "steer-ready" })).toBe(
      "Stop current response, or type guidance and press Enter to send it.",
    );
    expect(composerBusyHint({ status: "ready", disabled: false, mode: "steer-ready" })).toBe(
      "Press Enter to send guidance. Stop remains available.",
    );
    expect(composerBusyHint({ status: "ready", disabled: false, mode: "steer-pending" })).toBe(
      "Guidance sent. Waiting for the current run to accept it.",
    );
    expect(composerBusyHint({ status: "ready", disabled: false, mode: "send" })).toBeNull();
  });

  test("hydrates overflowed citation urls and sources from structured webSearch spill files", async () => {
    const spillContent = JSON.stringify(
      {
        provider: "exa",
        count: 2,
        response: {
          results: [
            { title: "NVIDIA Blog", url: "https://blogs.nvidia.com/gtc" },
            { title: "CNBC", url: "https://www.cnbc.com/gtc" },
          ],
        },
      },
      null,
      2,
    );

    const result = await loadOverflowCitationContext(
      [["assistant-1", "/tmp/exa-results.json"]],
      async ({ path }) => {
        expect(path).toBe("/tmp/exa-results.json");
        return spillContent;
      },
    );

    expect(result.urlsByMessageId).toEqual(
      new Map([
        [
          "assistant-1",
          new Map([
            [1, "https://blogs.nvidia.com/gtc"],
            [2, "https://www.cnbc.com/gtc"],
          ]),
        ],
      ]),
    );
    expect(result.sourcesByMessageId).toEqual(
      new Map([
        [
          "assistant-1",
          [
            { title: "NVIDIA Blog", url: "https://blogs.nvidia.com/gtc" },
            { title: "CNBC", url: "https://www.cnbc.com/gtc" },
          ],
        ],
      ]),
    );
  });

  test("hydrates duplicate spill files for each cited block but keeps sources on the latest block", async () => {
    const spillContent = JSON.stringify(
      {
        provider: "exa",
        count: 2,
        response: {
          results: [
            { title: "NVIDIA Blog", url: "https://blogs.nvidia.com/gtc" },
            { title: "CNBC", url: "https://www.cnbc.com/gtc" },
          ],
        },
      },
      null,
      2,
    );

    const result = await loadOverflowCitationContext(
      [
        ["assistant-1", "/tmp/exa-results.json"],
        ["assistant-3", "/tmp/exa-results.json"],
      ],
      async ({ path }) => {
        expect(path).toBe("/tmp/exa-results.json");
        return spillContent;
      },
    );

    expect(result.urlsByMessageId).toEqual(
      new Map([
        [
          "assistant-1",
          new Map([
            [1, "https://blogs.nvidia.com/gtc"],
            [2, "https://www.cnbc.com/gtc"],
          ]),
        ],
        [
          "assistant-3",
          new Map([
            [1, "https://blogs.nvidia.com/gtc"],
            [2, "https://www.cnbc.com/gtc"],
          ]),
        ],
      ]),
    );
    expect(result.sourcesByMessageId).toEqual(
      new Map([
        [
          "assistant-3",
          [
            { title: "NVIDIA Blog", url: "https://blogs.nvidia.com/gtc" },
            { title: "CNBC", url: "https://www.cnbc.com/gtc" },
          ],
        ],
      ]),
    );
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
        usageHeadline: formatSessionUsageHeadline(
          sessionUsage,
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
