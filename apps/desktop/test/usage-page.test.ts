import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

mock.module("../src/lib/desktopCommands", () => ({
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
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {
    connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

const { UsagePage } = await import("../src/ui/settings/pages/UsagePage");

describe("desktop usage page", () => {
  test("renders session usage breakdown, recent turns, and the estimate notice popup", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
        estimateNoticeOpen: true,
        thread: {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "Budget thread",
          createdAt: "2026-03-10T00:00:00.000Z",
          lastMessageAt: "2026-03-10T00:05:00.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 12,
        },
        runtime: {
          wsUrl: "ws://mock",
          connected: true,
          sessionId: "session-1",
          config: null,
          sessionConfig: null,
          sessionUsage: {
            sessionId: "session-1",
            totalTurns: 3,
            totalPromptTokens: 3200,
            totalCompletionTokens: 900,
            totalTokens: 4100,
            estimatedTotalCostUsd: 0.0235,
            costTrackingAvailable: true,
            byModel: [
              {
                provider: "openai",
                model: "gpt-5.4",
                turns: 2,
                totalPromptTokens: 2400,
                totalCompletionTokens: 700,
                totalTokens: 3100,
                estimatedCostUsd: 0.0184,
              },
              {
                provider: "google",
                model: "gemini-3-flash-preview",
                turns: 1,
                totalPromptTokens: 800,
                totalCompletionTokens: 200,
                totalTokens: 1000,
                estimatedCostUsd: 0.0051,
              },
            ],
            turns: [
              {
                turnId: "turn-2",
                turnIndex: 1,
                timestamp: "2026-03-10T00:03:00.000Z",
                provider: "openai",
                model: "gpt-5.4",
                usage: {
                  promptTokens: 1400,
                  completionTokens: 400,
                  totalTokens: 1800,
                  cachedPromptTokens: 300,
                },
                estimatedCostUsd: 0.0102,
                pricing: null,
              },
            ],
            budgetStatus: {
              configured: true,
              warnAtUsd: 0.02,
              stopAtUsd: 0.03,
              warningTriggered: true,
              stopTriggered: false,
              currentCostUsd: 0.0235,
            },
            createdAt: "2026-03-10T00:00:00.000Z",
            updatedAt: "2026-03-10T00:05:00.000Z",
          },
          lastTurnUsage: {
            turnId: "turn-3",
            usage: {
              promptTokens: 600,
              completionTokens: 200,
              totalTokens: 800,
              cachedPromptTokens: 100,
              estimatedCostUsd: 0.0049,
            },
          },
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [],
          transcriptOnly: false,
        },
        onClearHardCap: () => {},
      } as any),
    );

    expect(html).toContain("Usage");
    expect(html).toContain("Budget thread");
    expect(html).toContain("Model breakdown");
    expect(html).toContain("Recent turns");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("gemini-3-flash-preview");
    expect(html).toContain("est. $0.02");
    expect(html).toContain("Warning triggered");
    expect(html).toContain("Estimate notice");
  });

  test("renders an empty-state prompt when no thread is selected", () => {
    const html = renderToStaticMarkup(createElement(UsagePage, { thread: null, runtime: null }));

    expect(html).toContain("No thread selected");
    expect(html).toContain("Select a thread in the sidebar to inspect its session usage.");
    expect(html).toContain("Choose a thread first to see its model breakdown.");
  });

  test("keeps model and recent-turn estimates when only the session total is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(UsagePage, {
        thread: {
          id: "thread-2",
          workspaceId: "ws-1",
          title: "Mixed pricing thread",
          createdAt: "2026-03-10T00:00:00.000Z",
          lastMessageAt: "2026-03-10T00:05:00.000Z",
          status: "active",
          sessionId: "session-2",
          lastEventSeq: 5,
        },
        runtime: {
          wsUrl: "ws://mock",
          connected: true,
          sessionId: "session-2",
          config: null,
          sessionConfig: null,
          sessionUsage: {
            sessionId: "session-2",
            totalTurns: 2,
            totalPromptTokens: 2000,
            totalCompletionTokens: 400,
            totalTokens: 2400,
            estimatedTotalCostUsd: null,
            costTrackingAvailable: false,
            byModel: [
              {
                provider: "openai",
                model: "gpt-5.4",
                turns: 1,
                totalPromptTokens: 1000,
                totalCompletionTokens: 200,
                totalTokens: 1200,
                estimatedCostUsd: 0.004,
              },
            ],
            turns: [
              {
                turnId: "turn-2",
                turnIndex: 1,
                timestamp: "2026-03-10T00:03:00.000Z",
                provider: "openai",
                model: "gpt-5.4",
                usage: {
                  promptTokens: 1000,
                  completionTokens: 200,
                  totalTokens: 1200,
                },
                estimatedCostUsd: 0.0012,
                pricing: null,
              },
            ],
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
          lastTurnUsage: null,
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [],
          transcriptOnly: false,
        },
      } as any),
    );

    expect(html).toContain("Estimate unavailable");
    expect(html).toContain("est. $0.0040");
    expect(html).toContain("est. $0.0012");
  });
});
