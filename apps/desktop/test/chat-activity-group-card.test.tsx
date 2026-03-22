import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";

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
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { ActivityGroupCard } = await import("../src/ui/chat/ActivityGroupCard");

describe("desktop activity group card", () => {
  test("renders mixed reasoning and tool entries in chronological order", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          { id: "t1", kind: "tool", ts: "2024-01-01T00:00:01.000Z", name: "read", state: "output-error", args: { path: "a.ts" }, result: { error: "missing file" } },
          { id: "r1", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:02.000Z", text: "Inspecting the first file." },
          { id: "t2", kind: "tool", ts: "2024-01-01T00:00:03.000Z", name: "grep", state: "output-available", args: { pattern: "TODO" } },
          { id: "t3", kind: "tool", ts: "2024-01-01T00:00:04.000Z", name: "glob", state: "output-available", args: { pattern: "**/*.ts" } },
          { id: "r2", kind: "reasoning", mode: "summary", ts: "2024-01-01T00:00:05.000Z", text: "Summarizing the matched files." },
        ],
      }),
    );

    const readIndex = html.indexOf("Read");
    const firstSummaryIndex = html.indexOf("Inspecting the first file.");
    const grepIndex = html.indexOf("Grep");
    const globIndex = html.indexOf("Glob");
    const secondSummaryIndex = html.lastIndexOf("Summarizing the matched files.");

    expect(readIndex).toBeGreaterThan(-1);
    expect(firstSummaryIndex).toBeGreaterThan(readIndex);
    expect(grepIndex).toBeGreaterThan(firstSummaryIndex);
    expect(globIndex).toBeGreaterThan(grepIndex);
    expect(secondSummaryIndex).toBeGreaterThan(globIndex);
  });

  test("renders reasoning summaries once without a nested disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "read",
            state: "output-error",
          },
          {
            id: "r1",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:02.000Z",
            text: "first line\nsecond line\nthird hidden line",
          },
        ],
      }),
    );
    const doc = new JSDOM(html).window.document;
    const reasoningRow = doc.querySelector('[data-activity-entry-kind="reasoning"]');

    expect(html).toContain("first line");
    expect(html).toContain("third hidden line");
    expect(html).not.toContain("second line...");
    expect(reasoningRow).not.toBeNull();
    expect(reasoningRow?.querySelector("button")).toBeNull();
    expect(reasoningRow?.querySelector("[aria-controls]")).toBeNull();
  });

  test("collapsed card preview hides the standalone reasoning title", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          {
            id: "r1",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:02.000Z",
            text: "**Planning search strategy**\n\nI need to be careful not to make assumptions.\nI should verify the current product details.",
          },
        ],
      }),
    );

    expect(html).toContain("I need to be careful not to make assumptions.");
    expect(html).not.toContain("Planning search strategy");
  });

  test("auto-expands approval tools in trace mode", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "bash",
            state: "approval-requested",
            args: { cmd: "rm -rf /tmp/x" },
          },
        ],
      }),
    );

    expect(html).toContain("Needs review");
    expect(html).toContain("Review");
    expect(html).toContain("Bash");
    expect(html).toContain("rm -rf /tmp/x");
  });
});
