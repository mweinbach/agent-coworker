import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};
const MOCK_UPDATE_STATE = {
  phase: "idle",
  currentVersion: "0.1.0",
  packaged: false,
  lastCheckedAt: null,
  release: null,
  progress: null,
  error: null,
};

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    appendTranscriptBatch: async () => {},
    appendTranscriptEvent: async () => {},
    deleteTranscript: async () => {},
    listDirectory: async () => [],
    loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
    pickWorkspaceDirectory: async () => null,
    readTranscript: async () => [],
    saveState: async () => {},
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
    stopWorkspaceServer: async () => {},
    showContextMenu: async () => null,
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    getPlatform: async () => "linux",
    readFile: async () => "",
    previewOSFile: async () => {},
    openPath: async () => {},
    openExternalUrl: async () => {},
    revealPath: async () => {},
    copyPath: async () => {},
    createDirectory: async () => {},
    renamePath: async () => {},
    trashPath: async () => {},
    confirmAction: async () => true,
    showNotification: async () => true,
    getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    getUpdateState: async () => MOCK_UPDATE_STATE,
    checkForUpdates: async () => {},
    quitAndInstallUpdate: async () => {},
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { UsagePage, aggregateUsageFromRuntimes } = await import(
  "../src/ui/settings/pages/UsagePage"
);

describe("desktop usage page", () => {
  test("aggregateUsageFromRuntimes sums across multiple thread runtimes by provider and model", () => {
    const runtimes = {
      "thread-1": {
        sessionUsage: {
          sessionId: "s1",
          totalTurns: 3,
          totalPromptTokens: 3200,
          totalCompletionTokens: 900,
          totalCachedPromptTokens: 600,
          totalCacheWritePromptTokens: 70,
          totalReasoningOutputTokens: 250,
          totalTokens: 4100,
          estimatedTotalCostUsd: 0.0235,
          costTrackingAvailable: true,
          byModel: [
            {
              provider: "openai",
              model: "gpt-5.2",
              turns: 2,
              totalPromptTokens: 2400,
              totalCompletionTokens: 700,
              totalCachedPromptTokens: 500,
              totalCacheWritePromptTokens: 40,
              totalReasoningOutputTokens: 200,
              totalTokens: 3100,
              estimatedCostUsd: 0.0184,
            },
            {
              provider: "google",
              model: "gemini-3-flash-preview",
              turns: 1,
              totalPromptTokens: 800,
              totalCompletionTokens: 200,
              totalCachedPromptTokens: 100,
              totalCacheWritePromptTokens: 30,
              totalReasoningOutputTokens: 50,
              totalTokens: 1000,
              estimatedCostUsd: 0.0051,
            },
          ],
          turns: [],
          budgetStatus: {
            configured: false,
            warnAtUsd: null,
            stopAtUsd: null,
            warningTriggered: false,
            stopTriggered: false,
            currentCostUsd: null,
          },
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:05:00.000Z",
        },
      },
      "thread-2": {
        sessionUsage: {
          sessionId: "s2",
          totalTurns: 2,
          totalPromptTokens: 1000,
          totalCompletionTokens: 500,
          totalCachedPromptTokens: 50,
          totalCacheWritePromptTokens: 20,
          totalReasoningOutputTokens: 125,
          totalTokens: 1500,
          estimatedTotalCostUsd: 0.01,
          costTrackingAvailable: true,
          byModel: [
            {
              provider: "openai",
              model: "gpt-5.2",
              turns: 2,
              totalPromptTokens: 1000,
              totalCompletionTokens: 500,
              totalCachedPromptTokens: 50,
              totalCacheWritePromptTokens: 20,
              totalReasoningOutputTokens: 125,
              totalTokens: 1500,
              estimatedCostUsd: 0.01,
            },
          ],
          turns: [],
          budgetStatus: {
            configured: false,
            warnAtUsd: null,
            stopAtUsd: null,
            warningTriggered: false,
            stopTriggered: false,
            currentCostUsd: null,
          },
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:06:00.000Z",
        },
      },
      "thread-3": {
        sessionUsage: null,
      },
    } as any;

    const agg = aggregateUsageFromRuntimes(runtimes);

    expect(agg.totalSessions).toBe(2);
    expect(agg.totalTurns).toBe(5);
    expect(agg.totalTokens).toBe(5600);
    expect(agg.totalPromptTokens).toBe(4200);
    expect(agg.totalCompletionTokens).toBe(1400);
    expect(agg.totalCachedPromptTokens).toBe(650);
    expect(agg.totalCacheWritePromptTokens).toBe(90);
    expect(agg.totalReasoningOutputTokens).toBe(375);
    expect(agg.totalCostUsd).toBeCloseTo(0.0335, 4);
    expect(agg.costTrackingAvailable).toBe(true);
    expect(agg.providers.length).toBe(2);

    // openai should be first (higher cost)
    const openai = agg.providers.find((p: any) => p.provider === "openai")!;
    expect(openai.models.length).toBe(1);
    expect(openai.models[0].model).toBe("gpt-5.2");
    expect(openai.models[0].turns).toBe(4);
    expect(openai.models[0].sessions).toBe(2);
    expect(openai.models[0].totalTokens).toBe(4600);
    expect(openai.models[0].totalCachedPromptTokens).toBe(550);
    expect(openai.models[0].totalCacheWritePromptTokens).toBe(60);
    expect(openai.models[0].totalReasoningOutputTokens).toBe(325);
    expect(openai.models[0].estimatedCostUsd).toBeCloseTo(0.0284, 4);

    const google = agg.providers.find((p: any) => p.provider === "google")!;
    expect(google.models.length).toBe(1);
    expect(google.models[0].sessions).toBe(1);
    expect(google.models[0].totalCachedPromptTokens).toBe(100);
    expect(google.models[0].totalCacheWritePromptTokens).toBe(30);
    expect(google.models[0].totalReasoningOutputTokens).toBe(50);
  });

  test("renders aggregate usage breakdown with provider groups and the estimate notice popup", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
        estimateNoticeOpen: true,
        aggregate: {
          totalCostUsd: 0.0335,
          costTrackingAvailable: true,
          totalTokens: 5600,
          totalPromptTokens: 4200,
          totalCompletionTokens: 1400,
          totalCachedPromptTokens: 650,
          totalCacheWritePromptTokens: 90,
          totalReasoningOutputTokens: 375,
          totalTurns: 5,
          totalSessions: 2,
          providers: [
            {
              provider: "openai",
              models: [
                {
                  provider: "openai",
                  model: "gpt-5.2",
                  turns: 4,
                  sessions: 2,
                  totalPromptTokens: 3400,
                  totalCompletionTokens: 1200,
                  totalCachedPromptTokens: 550,
                  totalCacheWritePromptTokens: 60,
                  totalReasoningOutputTokens: 325,
                  totalTokens: 4600,
                  estimatedCostUsd: 0.0284,
                },
              ],
              totalTokens: 4600,
              totalCachedPromptTokens: 550,
              totalCacheWritePromptTokens: 60,
              totalReasoningOutputTokens: 325,
              totalTurns: 4,
              estimatedCostUsd: 0.0284,
            },
            {
              provider: "google",
              models: [
                {
                  provider: "google",
                  model: "gemini-3-flash-preview",
                  turns: 1,
                  sessions: 1,
                  totalPromptTokens: 800,
                  totalCompletionTokens: 200,
                  totalCachedPromptTokens: 100,
                  totalCacheWritePromptTokens: 30,
                  totalReasoningOutputTokens: 50,
                  totalTokens: 1000,
                  estimatedCostUsd: 0.0051,
                },
              ],
              totalTokens: 1000,
              totalCachedPromptTokens: 100,
              totalCacheWritePromptTokens: 30,
              totalReasoningOutputTokens: 50,
              totalTurns: 1,
              estimatedCostUsd: 0.0051,
            },
          ],
        },
      } as any),
    );

    expect(html).toContain("data-usage-page");
    expect(html).toContain("By provider");
    expect(html).toContain("gpt-5.2");
    expect(html).toContain("gemini-3-flash-preview");
    expect(html).toContain("openai");
    expect(html).toContain("google");
    expect(html).toContain("$0.03");
    expect(html).toContain("How estimates work");
    expect(html).toContain("5.6k");
    expect(html).toContain("650 cache read");
    expect(html).toContain("90 cache write");
    expect(html).toContain("375 reasoning");
    expect(html).toContain("Cache read:");
    expect(html).toContain("Cache write:");
    expect(html).toContain("Reasoning:");
  });

  test("renders empty state when no usage data exists", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
        aggregate: {
          totalCostUsd: null,
          costTrackingAvailable: false,
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCachedPromptTokens: 0,
          totalCacheWritePromptTokens: 0,
          totalReasoningOutputTokens: 0,
          totalTurns: 0,
          totalSessions: 0,
          providers: [],
        },
      } as any),
    );

    expect(html).toContain("No usage data recorded yet");
    expect(html).toContain("Usage");
  });

  test("handles models with unavailable pricing gracefully", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
        aggregate: {
          totalCostUsd: null,
          costTrackingAvailable: false,
          totalTokens: 2400,
          totalPromptTokens: 2000,
          totalCompletionTokens: 400,
          totalCachedPromptTokens: 0,
          totalCacheWritePromptTokens: 0,
          totalReasoningOutputTokens: 0,
          totalTurns: 2,
          totalSessions: 1,
          providers: [
            {
              provider: "openai",
              models: [
                {
                  provider: "openai",
                  model: "gpt-5.2",
                  turns: 2,
                  sessions: 1,
                  totalPromptTokens: 2000,
                  totalCompletionTokens: 400,
                  totalCachedPromptTokens: 0,
                  totalCacheWritePromptTokens: 0,
                  totalReasoningOutputTokens: 0,
                  totalTokens: 2400,
                  estimatedCostUsd: null,
                },
              ],
              totalTokens: 2400,
              totalCachedPromptTokens: 0,
              totalCacheWritePromptTokens: 0,
              totalReasoningOutputTokens: 0,
              totalTurns: 2,
              estimatedCostUsd: null,
            },
          ],
        },
      } as any),
    );

    expect(html).toContain("No pricing");
    expect(html).toContain("gpt-5.2");
    expect(html).toContain("2.4k");
  });
});
