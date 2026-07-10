import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

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

const { ActivityGroupCard } = await import("../src/ui/chat/ActivityGroupCard");

describe("desktop activity group card", () => {
  test("renders mixed reasoning and tool entries in chronological order", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        live: true,
        items: [
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "read",
            state: "output-available",
            args: { path: "a.ts" },
            result: { chars: 20 },
          },
          {
            id: "r1",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:02.000Z",
            text: "Inspecting the first file.",
          },
          {
            id: "t2",
            kind: "tool",
            ts: "2024-01-01T00:00:03.000Z",
            name: "grep",
            state: "output-available",
            args: { pattern: "TODO" },
          },
          {
            id: "t3",
            kind: "tool",
            ts: "2024-01-01T00:00:04.000Z",
            name: "glob",
            state: "output-available",
            args: { pattern: "**/*.ts" },
          },
          {
            id: "r2",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:05.000Z",
            text: "Summarizing the matched files.",
          },
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
        live: true,
        items: [
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "read",
            state: "output-available",
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

    expect(html).toContain("Worked");
    expect(html).not.toContain("activity-thinking-shimmer");
    expect(html).not.toContain("I need to be careful not to make assumptions.");
    expect(html).not.toContain("Planning search strategy");
  });

  test("renders completed activity as a compact worked-for row", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          {
            id: "r1",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:00.000Z",
            text: "Checking the current leadership context.",
          },
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:02:49.000Z",
            name: "nativeWebSearch",
            state: "output-available",
            result: { status: "completed" },
          },
        ],
      }),
    );

    expect(html).toContain("Worked for 2m 49s");
    expect(html).toContain('data-slot="marker"');
    expect(html).toContain("before:hidden");
    expect(html).toContain("group-data-[variant=separator]/marker:text-left");
    expect(html).toContain('data-variant="separator"');
    expect(html).not.toContain("rounded-xl border border-border/32");
    expect(html).not.toContain("Checking the current leadership context.");
  });

  test("renders a single completed tool duration from completedAt", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:00.000Z",
            completedAt: "2024-01-01T00:00:12.000Z",
            name: "bash",
            state: "output-available",
            result: { exitCode: 0 },
          },
        ],
      }),
    );

    expect(html).toContain("Worked for 12s");
  });

  test("renders live terminal-looking activity as a compact working-for row", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        live: true,
        liveStartedAt: "2024-01-01T00:00:00.000Z",
        liveNowMs: Date.parse("2024-01-01T00:00:56.000Z"),
        items: [
          {
            id: "r1",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:10.000Z",
            text: "Checking the files.",
          },
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:12.000Z",
            name: "read",
            state: "output-available",
            result: { status: "completed" },
          },
        ],
      }),
    );

    expect(html).toContain("Working for 56s");
    expect(html).toContain('data-slot="marker"');
    expect(html).toContain('data-variant="border"');
    expect(html).toContain("activity-trace-content");
    expect(html).not.toContain("Worked for");
    expect(html).not.toContain("rounded-xl border border-border/32");
  });

  test("falls back to the first activity timestamp for live elapsed time", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        live: true,
        liveNowMs: Date.parse("2024-01-01T00:01:10.000Z"),
        items: [
          {
            id: "t1",
            kind: "tool",
            ts: "2024-01-01T00:00:10.000Z",
            name: "read",
            state: "output-available",
          },
        ],
      }),
    );

    expect(html).toContain("Working for 1m 0s");
  });

  test("skips blank reasoning placeholders and keeps unrecovered memory errors plus web search", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        live: true,
        items: [
          {
            id: "r-empty",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:00.000Z",
            text: "",
          },
          {
            id: "t-memory",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "memory",
            state: "output-error",
            args: { action: "search", query: "lga" },
            result: { error: 'No memory found for "lga".' },
          },
          {
            id: "r-summary",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:02.000Z",
            text: "**Searching for crash details**\n\nChecking local sources first.",
          },
          {
            id: "t-web",
            kind: "tool",
            ts: "2024-01-01T00:00:03.000Z",
            name: "nativeWebSearch",
            state: "output-available",
            result: {
              status: "completed",
              action: {
                type: "search",
                query: "LGA crash 2026",
                sources: [{ type: "url", url: "https://example.com/lga-crash" }],
              },
            },
          },
        ],
      }),
    );
    const doc = new JSDOM(html).window.document;
    const reasoningRows = doc.querySelectorAll('[data-activity-entry-kind="reasoning"]');
    const toolRows = doc.querySelectorAll('[data-activity-entry-kind="tool"]');

    // A later different tool success must not hide the unrecovered memory error.
    expect(reasoningRows).toHaveLength(1);
    expect(toolRows).toHaveLength(2);
    expect(html).toContain("Memory");
    expect(html).toContain("Web Search");
    expect(html).toContain("Search: LGA crash 2026");
    expect(reasoningRows[0]?.textContent).not.toContain("Summary");
    expect(reasoningRows[0]?.textContent).toContain("Searching for crash details");
  });

  test("renders only an unrecovered failure as a collapsed compact trace", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        onRetry: async () => true,
        items: [
          {
            id: "t-failed",
            kind: "tool",
            ts: "2024-01-01T00:00:00.000Z",
            completedAt: "2024-01-01T00:00:12.000Z",
            name: "read",
            state: "output-error",
            result: { error: "missing file" },
          },
        ],
      }),
    );

    const doc = new JSDOM(html).window.document;

    expect(doc.body.textContent).toContain("Couldn't finish after 12s");
    expect(html).toContain('data-variant="separator"');
    expect(html).toContain('aria-expanded="false"');
    expect(doc.body.textContent).toContain("Retry");
    expect(html).not.toContain("rounded-xl border border-border/32");
    expect(html).not.toContain("missing file");
  });

  test("retry action invokes the continuation callback", async () => {
    const harness = setupJsdom();
    const onRetry = mock(async () => true);
    const root = createRoot(harness.dom.window.document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(
          createElement(ActivityGroupCard, {
            onRetry,
            items: [
              {
                id: "t-failed",
                kind: "tool",
                ts: "2024-01-01T00:00:00.000Z",
                name: "read",
                state: "output-error",
                result: { error: "missing file" },
              },
            ],
          }),
        );
      });

      const retryButton = harness.dom.window.document.querySelector<HTMLButtonElement>(
        'button[data-slot="button"]',
      );
      expect(retryButton?.textContent).toContain("Retry");
      await act(async () => {
        retryButton?.click();
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("renders a pending reasoning placeholder before summary text arrives", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        items: [
          {
            id: "r-pending",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:00.000Z",
            text: "",
          },
        ],
      }),
    );
    const doc = new JSDOM(html).window.document;
    expect(doc.body.textContent).toContain("Thinking");
    expect(html).toContain("activity-thinking-shimmer");
    expect(doc.body.textContent).not.toContain("Working");
    expect(doc.body.textContent).not.toContain("Summary");
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
