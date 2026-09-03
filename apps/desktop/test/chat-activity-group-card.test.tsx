import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatRenderItem } from "../src/ui/chat/activityGroups";
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
const { ToolClusterNode } = await import("../src/ui/chat/activityToolCluster");
const { ChatFeed } = await import("../src/ui/chat/ChatFeed");
const { CrashReportingErrorBoundary } = await import("../src/ui/CrashReportingErrorBoundary");

async function expandActivity(container: Element) {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="activity-disclosure"]');
  if (trigger?.getAttribute("aria-expanded") === "false") {
    await act(async () => trigger.click());
  }
}

async function renderExpandedActivity(element: ReactNode, openReasoning = false): Promise<string> {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await expandActivity(container);
    if (openReasoning) {
      for (const button of container.querySelectorAll<HTMLButtonElement>(
        '[data-activity-entry-kind="reasoning"] button',
      )) {
        await act(async () => button.click());
      }
    }
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    harness.restore();
  }
}

describe("desktop activity group card", () => {
  test("updates the compact action to the latest heading within streamed reasoning", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const renderReasoning = async (text: string) => {
      await act(async () =>
        root.render(
          createElement(ActivityGroupCard, {
            live: true,
            liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
            items: [
              {
                id: "reasoning-phases",
                kind: "reasoning",
                mode: "summary",
                ts: "2024-01-01T00:00:00.000Z",
                text,
              },
            ],
          }),
        ),
      );
    };
    try {
      await renderReasoning("**Planning the approach**\nInspect the sources.");
      const action = container.querySelector('[data-slot="activity-current-action"]');
      expect(action?.textContent).toBe("Planning the approach");
      await renderReasoning(
        "**Planning the approach**\nInspect the sources.\n\n## Verifying the completed change\nRunning the checks.",
      );
      expect(action?.textContent).toBe("Verifying the completed change");
      expect(
        container.querySelector('[data-slot="activity-disclosure"]')?.getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
  });

  test("uses concise plain-text previews for untitled reasoning", async () => {
    const html = await renderExpandedActivity(
      createElement(ActivityGroupCard, {
        live: true,
        liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
        items: [
          {
            id: "reasoning-plain-preview",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:00.000Z",
            text:
              "Checking **bold** and _emphasized_ [docs](https://example.com/docs) with `my_file.ts` at <https://example.com/details>.\n\n" +
              "Further detail ".repeat(50),
          },
        ],
      }),
    );
    const doc = new JSDOM(html).window.document;
    const action = doc.querySelector('[data-slot="activity-current-action"]');
    const reasoningDisclosure = doc.querySelector('[data-activity-entry-kind="reasoning"] button');
    for (const preview of [action?.textContent ?? "", reasoningDisclosure?.textContent ?? ""]) {
      expect(preview).toContain("Checking bold and emphasized docs with my_file.ts");
      expect(preview).not.toContain("https:");
      expect(preview).not.toMatch(/\*|`|\[|\]|\(|\)|_emphasized_/);
      expect(preview.length).toBeLessThanOrEqual(140);
    }
  });

  test("formats only the visible previews in a collapsed tool cluster", () => {
    const reads = Array.from({ length: 12 }, () => mock(() => "report.md"));
    const entries = reads.map((readPath, index) => ({
      kind: "tool" as const,
      item: {
        kind: "tool" as const,
        id: `read-${index}`,
        sourceIds: [`read-${index}`],
        ts: "2024-01-01T00:00:00.000Z",
        name: "read",
        state: "output-available" as const,
        args: {
          get path() {
            return readPath();
          },
        },
      },
    }));

    const html = renderToStaticMarkup(
      createElement(ToolClusterNode, {
        entries,
        isLastBucket: true,
        recoveredToolIds: new Set<string>(),
      }),
    );

    expect(html).toContain("×12");
    expect(html).toContain("+9 more");
    expect(reads.slice(0, 3).every((readPath) => readPath.mock.calls.length > 0)).toBe(true);
    expect(reads.slice(3).every((readPath) => readPath.mock.calls.length === 0)).toBe(true);
  });

  test("renders mixed reasoning and tool entries in chronological order", async () => {
    const html = await renderExpandedActivity(
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

    // Prefer unique body content over tool titles — the collapsed header also
    // lists tool names for the content summary and would otherwise confuse order.
    const readIndex = html.indexOf("a.ts");
    const firstSummaryIndex = html.indexOf("Inspecting the first file.");
    const grepIndex = html.indexOf("TODO");
    const globIndex = html.indexOf("**/*.ts");
    const secondSummaryIndex = html.lastIndexOf("Summarizing the matched files.");

    expect(readIndex).toBeGreaterThan(-1);
    expect(firstSummaryIndex).toBeGreaterThan(readIndex);
    expect(grepIndex).toBeGreaterThan(firstSummaryIndex);
    expect(globIndex).toBeGreaterThan(grepIndex);
    expect(secondSummaryIndex).toBeGreaterThan(globIndex);
  });

  test("clusters consecutive same-name tools and labels live subagents", async () => {
    const html = await renderExpandedActivity(
      createElement(ActivityGroupCard, {
        live: true,
        activeAgentLabels: ["ntia-scout", "congress-watch", "agency-policy", "export-controls"],
        items: [
          {
            id: "s1",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "webSearch",
            state: "output-available",
            args: { query: "NTIA open weights" },
            result: { count: 10 },
          },
          {
            id: "s2",
            kind: "tool",
            ts: "2024-01-01T00:00:02.000Z",
            name: "webSearch",
            state: "output-available",
            args: { query: "EO 14110 open source" },
            result: { count: 8 },
          },
          {
            id: "s3",
            kind: "tool",
            ts: "2024-01-01T00:00:03.000Z",
            name: "webSearch",
            state: "input-available",
            args: { query: "Congress open models bill" },
          },
        ],
      }),
    );

    expect(html).toContain('data-activity-entry-kind="tool-cluster"');
    expect(html).toContain('data-tool-cluster-size="3"');
    expect(html).toContain('data-slot="tool-cluster-label"');
    expect(html).toContain("×3");
    expect(html).toContain("NTIA open weights");
    expect(html).toContain("EO 14110 open source");
    expect(html).toContain("Congress open models bill");
    // More than 3 active labels collapses to a count suffix on the live header.
    expect(html).toContain("4 subagents");
  });

  test("groups command aliases without repeated completed placeholders or duplicated previews", async () => {
    const html = await renderExpandedActivity(
      createElement(ActivityGroupCard, {
        live: true,
        items: [
          {
            id: "command-provider",
            kind: "tool",
            ts: "2024-01-01T00:00:01.000Z",
            name: "commandExecution",
            state: "output-available",
            args: { command: "find . -maxdepth 2" },
          },
          {
            id: "command-harness",
            kind: "tool",
            ts: "2024-01-01T00:00:02.000Z",
            name: "exec_command",
            state: "input-available",
            args: { cmd: "rg -n purpose AGENTS.md" },
          },
        ],
      }),
    );
    const doc = new JSDOM(html).window.document;
    const cluster = doc.querySelector('[data-activity-entry-kind="tool-cluster"]');

    expect(cluster?.getAttribute("data-tool-cluster-size")).toBe("2");
    expect(doc.querySelector('[data-slot="activity-content-summary"]')?.textContent).toBe(
      "Run command ×2",
    );
    expect(cluster?.textContent).not.toContain("Completed");
    expect(cluster?.textContent?.match(/find \. -maxdepth 2/g)).toHaveLength(1);
    expect(cluster?.textContent?.match(/rg -n purpose AGENTS\.md/g)).toHaveLength(1);
    expect(
      cluster?.querySelector('[data-activity-entry-kind="tool"] span.font-mono'),
    ).not.toBeNull();
  });

  test("reveals approvals added to a previously collapsed tool cluster", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);
    const completedItems: Parameters<typeof ActivityGroupCard>[0]["items"] = [
      {
        id: "read-1",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "read",
        state: "output-available",
        args: { path: "first.ts" },
      },
      {
        id: "read-2",
        kind: "tool",
        ts: "2024-01-01T00:00:02.000Z",
        name: "read",
        state: "output-available",
        args: { path: "second.ts" },
      },
    ];
    const approvalItem: Parameters<typeof ActivityGroupCard>[0]["items"][number] = {
      id: "read-approval",
      kind: "tool",
      ts: "2024-01-01T00:00:03.000Z",
      name: "read",
      state: "approval-requested",
      args: { path: "restricted.ts" },
      approval: { approvalId: "approval-1" },
    };
    const renderItems = async (items: Parameters<typeof ActivityGroupCard>[0]["items"]) => {
      await act(async () => {
        root.render(
          createElement(ActivityGroupCard, {
            live: true,
            liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
            items,
          }),
        );
      });
    };

    try {
      await renderItems(completedItems);
      await expandActivity(container);
      const clusterToggle = container.querySelector<HTMLButtonElement>(
        '[data-slot="tool-cluster-label"]',
      );
      expect(clusterToggle?.getAttribute("aria-expanded")).toBe("false");

      await renderItems([...completedItems, approvalItem]);
      expect(clusterToggle?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("Approval required");

      await act(async () => {
        clusterToggle?.click();
      });
      expect(clusterToggle?.getAttribute("aria-expanded")).toBe("false");

      await renderItems([
        ...completedItems,
        approvalItem,
        {
          ...approvalItem,
          id: "read-approval-2",
          approval: { approvalId: "approval-2" },
        },
      ]);
      expect(clusterToggle?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("keeps completed tool payloads inspectable inside tool clusters", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(ActivityGroupCard, {
            live: true,
            liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
            items: [
              {
                id: "read-report-1",
                kind: "tool",
                ts: "2024-01-01T00:00:01.000Z",
                name: "read",
                state: "output-available",
                args: { path: "first-report.md" },
                result: { report: "First completed workflow report" },
              },
              {
                id: "read-report-2",
                kind: "tool",
                ts: "2024-01-01T00:00:02.000Z",
                name: "read",
                state: "output-available",
                args: { path: "second-report.md" },
                result: { report: "Second completed workflow report" },
              },
            ],
          }),
        );
      });

      await expandActivity(container);
      const clusterToggle = container.querySelector<HTMLButtonElement>(
        '[data-slot="tool-cluster-label"]',
      );
      await act(async () => {
        clusterToggle?.click();
      });

      const toolRows = container.querySelectorAll('[data-activity-entry-kind="tool"]');
      expect(toolRows).toHaveLength(2);
      const firstToolToggle = toolRows[0]?.querySelector<HTMLButtonElement>("button");
      expect(firstToolToggle).not.toBeNull();

      await act(async () => {
        firstToolToggle?.click();
      });
      const rawToggle = Array.from(toolRows[0]?.querySelectorAll("button") ?? []).find((button) =>
        button.textContent?.includes("Raw input/output"),
      );
      expect(rawToggle).toBeDefined();

      await act(async () => {
        rawToggle?.click();
      });
      expect(toolRows[0]?.textContent).toContain("First completed workflow report");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("keeps reasoning bodies unmounted until their disclosure opens", async () => {
    const element = createElement(ActivityGroupCard, {
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
    });
    const collapsedHtml = renderToStaticMarkup(element);
    expect(collapsedHtml).toContain("first line");
    expect(collapsedHtml).not.toContain("third hidden line");
    expect(collapsedHtml).not.toContain('data-activity-entry-kind="reasoning"');

    const historyHtml = await renderExpandedActivity(element);
    expect(historyHtml).toContain("first line");
    expect(historyHtml).not.toContain("third hidden line");

    const html = await renderExpandedActivity(element, true);
    const doc = new JSDOM(html).window.document;
    const reasoningRow = doc.querySelector('[data-activity-entry-kind="reasoning"]');

    expect(html).toContain("first line");
    expect(html).toContain("third hidden line");
    expect(html).not.toContain("second line...");
    expect(reasoningRow).not.toBeNull();
    expect(reasoningRow?.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(reasoningRow?.querySelector("[aria-controls]")).not.toBeNull();
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
    expect(html).toContain('data-slot="activity-disclosure"');
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
    expect(html).toContain('data-slot="activity-disclosure"');
    expect(html).toContain('data-variant="default"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Latest: Read");
    expect(html).not.toContain('data-slot="activity-timeline-viewport"');
    expect(html).toContain("activity-trace-content");
    expect(html).not.toContain("Worked for");
    expect(html).not.toContain("rounded-xl border border-border/32");
  });

  test("keeps a live turn working when a tool fails without hiding the failure", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        live: true,
        liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
        items: [
          {
            id: "failed-read",
            kind: "tool",
            ts: "2024-01-01T00:00:00.000Z",
            name: "read",
            state: "output-error",
            result: { error: "missing file" },
          },
        ],
      }),
    );
    const doc = new JSDOM(html).window.document;
    expect(doc.body.textContent).toContain("Working for 5s");
    expect(doc.body.textContent).toContain("missing file");
    expect(doc.body.textContent).not.toContain("Couldn't finish");
    expect(doc.body.textContent).not.toContain("could not finish");
    expect(doc.querySelector('[role="alert"]')?.textContent).toContain("still working");
  });

  test.each(["approval-requested", "output-error"] as const)(
    "opens collapsed live history when a tool changes to %s",
    async (state) => {
      const harness = setupJsdom();
      const container = harness.dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const item = {
        id: "read-latest",
        kind: "tool" as const,
        ts: "2024-01-01T00:00:00.000Z",
        name: "read",
        state: "input-available" as const,
        args: { path: "report.md" },
      };
      try {
        await act(async () =>
          root.render(
            createElement(ActivityGroupCard, {
              live: true,
              items: [item],
            }),
          ),
        );
        const trigger = container.querySelector('[data-slot="activity-disclosure"]');
        expect(trigger?.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelector('[data-slot="activity-timeline-viewport"]')).toBeNull();

        await act(async () =>
          root.render(
            createElement(ActivityGroupCard, {
              live: true,
              items: [
                {
                  ...item,
                  state,
                  ...(state === "approval-requested"
                    ? { approval: { approvalId: "approval-read" } }
                    : { result: { error: "Report is missing" } }),
                },
              ],
            }),
          ),
        );
        expect(trigger?.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelector('[data-slot="activity-timeline-viewport"]')).not.toBeNull();
        expect(container.textContent).toContain(
          state === "approval-requested" ? "Approval required" : "Report is missing",
        );
      } finally {
        await act(async () => root.unmount());
        harness.restore();
      }
    },
  );

  test("serializes raw tool output only after its disclosure opens", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const serialize = mock(() => ({ data: "large tool output" }));
    try {
      await act(async () => {
        root.render(
          createElement(ActivityGroupCard, {
            live: true,
            liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
            items: [
              {
                id: "tool",
                kind: "tool",
                ts: "2024-01-01T00:00:00.000Z",
                name: "read",
                state: "output-available",
                result: { toJSON: serialize },
              },
            ],
          }),
        );
      });
      expect(serialize).not.toHaveBeenCalled();
      await expandActivity(container);
      const toolToggle = container.querySelector<HTMLButtonElement>(
        '[data-activity-entry-kind="tool"] button',
      );
      if (!toolToggle) throw new Error("missing tool disclosure");
      await act(async () => toolToggle.click());
      expect(serialize).not.toHaveBeenCalled();
      const rawToggle = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Raw input/output"),
      );
      if (!rawToggle) throw new Error("missing raw output disclosure");
      await act(async () => rawToggle.click());
      expect(serialize).toHaveBeenCalledTimes(1);
      expect(container.querySelector("pre")?.textContent).toContain("large tool output");
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
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

  test("repairs concatenated Markdown boundaries in streamed reasoning", async () => {
    const malformedReasoning =
      "**Filtering upcoming data center projects in NYISO queue****Identifying specific data center projects in New York Listing known data center locations Refining data center capacity thresholds Planning top tables for project impact****Listing potential data center projects**";
    const html = await renderExpandedActivity(
      createElement(ActivityGroupCard, {
        live: true,
        items: [
          {
            id: "r-malformed-markdown",
            kind: "reasoning",
            mode: "summary",
            ts: "2024-01-01T00:00:02.000Z",
            text: malformedReasoning,
          },
        ],
      }),
      true,
    );
    const doc = new JSDOM(html).window.document;
    const reasoningRow = doc.querySelector('[data-activity-entry-kind="reasoning"]');

    expect(html).not.toContain("****");
    expect(reasoningRow?.textContent).toContain("Filtering upcoming data center projects");
    expect(reasoningRow?.textContent).toContain("Identifying specific data center projects");
    expect(reasoningRow?.textContent).toContain("Listing potential data center projects");
    expect(reasoningRow?.querySelectorAll("p").length).toBeGreaterThan(1);
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

  test("explains when exact retry is unavailable without rendering a retry action", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroupCard, {
        retryUnavailableReason: "Exact retry isn’t available with this server.",
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
    const doc = new JSDOM(html).window.document;
    const retryButtons = Array.from(doc.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Retry",
    );

    expect(doc.querySelector('[data-slot="activity-retry-unavailable"]')?.textContent).toBe(
      "Exact retry isn’t available with this server.",
    );
    expect(retryButtons).toHaveLength(0);
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

  test("streams reasoning from empty through multiple deltas in Strict Mode", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);
    const consoleErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    const originalWindowConsoleError = harness.dom.window.console.error;
    const captureConsoleError = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    console.error = captureConsoleError;
    harness.dom.window.console.error = captureConsoleError;

    const renderReasoning = async (text: string) => {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(ActivityGroupCard, {
              live: true,
              liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
              items: [
                {
                  id: "r-stream",
                  kind: "reasoning",
                  mode: "summary",
                  ts: "2024-01-01T00:00:00.000Z",
                  text,
                },
              ],
            }),
          ),
        );
      });
    };

    try {
      await renderReasoning("");
      expect(container.textContent).toContain("Thinking");
      await expandActivity(container);
      const reasoningRow = container.querySelector('[data-activity-entry-kind="reasoning"]');
      expect(reasoningRow).not.toBeNull();

      await renderReasoning("first delta");
      expect(container.textContent).toContain("first delta");
      expect(container.querySelector('[data-activity-entry-kind="reasoning"]')).toBe(reasoningRow);
      const disclosure = reasoningRow?.querySelector<HTMLButtonElement>("button");
      expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => disclosure?.click());
      const markdown = reasoningRow?.querySelector(".streaming-markdown-caret");
      expect(markdown).not.toBeNull();

      await renderReasoning("first delta and second delta");
      expect(container.textContent).toContain("first delta and second delta");
      expect(container.querySelector('[data-activity-entry-kind="reasoning"]')).toBe(reasoningRow);
      expect(reasoningRow?.querySelector(".streaming-markdown-caret")).toBe(markdown);

      await renderReasoning("");
      expect(container.textContent).toContain("Thinking");
      expect(container.querySelector('[data-activity-entry-kind="reasoning"]')).toBe(reasoningRow);
      expect(consoleErrors).toEqual([]);
    } finally {
      console.error = originalConsoleError;
      harness.dom.window.console.error = originalWindowConsoleError;
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("preserves manual reasoning disclosure state across streamed body deltas", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);

    const renderReasoning = async (body: string) => {
      await act(async () => {
        root.render(
          createElement(ActivityGroupCard, {
            live: true,
            liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
            items: [
              {
                id: "reasoning-source-1",
                kind: "reasoning",
                mode: "summary",
                ts: "2024-01-01T00:00:00.000Z",
                text: `**Plan**\n\n${body}`,
              },
            ],
          }),
        );
      });
    };

    try {
      await renderReasoning("Initial streamed body.");
      await expandActivity(container);
      const disclosure = container.querySelector<HTMLButtonElement>(
        '[data-activity-entry-kind="reasoning"] button',
      );
      expect(disclosure?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        disclosure?.click();
      });
      expect(disclosure?.getAttribute("aria-expanded")).toBe("true");

      await renderReasoning(
        "A completely different streamed body prefix that previously changed the React key.",
      );
      const updatedDisclosure = container.querySelector<HTMLButtonElement>(
        '[data-activity-entry-kind="reasoning"] button',
      );
      expect(updatedDisclosure).toBe(disclosure);
      expect(updatedDisclosure?.getAttribute("aria-expanded")).toBe("true");
      expect(updatedDisclosure?.getAttribute("aria-controls")).toContain("reasoning-source-1");

      await act(async () => updatedDisclosure?.click());
      await renderReasoning("Another streamed delta after manually collapsing.");
      expect(updatedDisclosure?.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain(
        "Another streamed delta after manually collapsing.",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("keeps nested Activity scrolling detached and reports new entries", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);
    let nestedScrollHeight = 900;

    const renderActivity = async (toolCount: number) => {
      await act(async () => {
        root.render(
          createElement(ActivityGroupCard, {
            live: true,
            liveNowMs: Date.parse("2024-01-01T00:00:05.000Z"),
            items: Array.from({ length: toolCount }, (_, index) => ({
              id: `tool-${index + 1}`,
              kind: "tool" as const,
              ts: `2024-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
              name: "read",
              state: "output-available" as const,
              args: { path: `file-${index + 1}.ts` },
            })),
          }),
        );
      });
    };

    try {
      await renderActivity(4);
      await expandActivity(container);
      const timeline = container.querySelector(
        '[data-slot="activity-timeline-viewport"]',
      ) as HTMLElement | null;
      if (!timeline) throw new Error("missing activity timeline");
      Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 300 });
      Object.defineProperty(timeline, "scrollHeight", {
        configurable: true,
        get: () => nestedScrollHeight,
      });
      timeline.scrollTop = 200;
      await act(async () => {
        timeline.dispatchEvent(
          new harness.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -60 }),
        );
        timeline.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });

      nestedScrollHeight = 1_100;
      await renderActivity(6);
      expect(timeline.scrollTop).toBe(200);
      const jumpButton = container.querySelector(
        '[aria-label="2 new updates. Jump to latest activity"]',
      ) as HTMLButtonElement | null;
      expect(jumpButton?.textContent).toContain("2 new updates");
      expect(jumpButton?.textContent).toContain("Latest activity");
      const toolbar = container.querySelector('[data-slot="activity-timeline-toolbar"]');
      expect(toolbar?.contains(jumpButton)).toBe(true);
      expect(timeline.contains(jumpButton)).toBe(false);
      expect(jumpButton?.className).not.toContain("absolute");

      await act(async () => {
        jumpButton?.click();
      });
      expect(timeline.scrollTop).toBe(800);
      expect(
        container.querySelector('[aria-label="2 new updates. Jump to latest activity"]'),
      ).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("isolates an activity-card render failure with an inline fallback", async () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("missing root");
    const root = createRoot(container);
    const brokenActivityGroup = {
      kind: "activity-group",
      id: "activity-broken",
      items: [
        {
          id: "r-broken",
          kind: "reasoning",
          mode: "summary",
          ts: "2024-01-01T00:00:00.000Z",
          text: null,
        },
      ],
    } as unknown as ChatRenderItem;
    const healthyActivityGroup: ChatRenderItem = {
      kind: "activity-group",
      id: "activity-healthy",
      items: [
        {
          id: "t-healthy",
          kind: "tool",
          ts: "2024-01-01T00:00:01.000Z",
          name: "bash",
          state: "approval-requested",
          args: { command: "echo healthy" },
        },
      ],
    };
    const originalConsoleError = console.error;
    const originalWindowConsoleError = harness.dom.window.console.error;
    console.error = () => {};
    harness.dom.window.console.error = () => {};

    const renderFeed = async () => {
      await act(async () => {
        root.render(
          createElement(
            CrashReportingErrorBoundary,
            { captureError: () => {} },
            createElement(ChatFeed, {
              transcriptOnly: false,
              disconnected: false,
              visibleFeedLength: 2,
              hydrating: false,
              renderItems: [brokenActivityGroup, healthyActivityGroup],
              liveActivityGroupId: null,
              liveStartedAt: null,
              showWorkingPlaceholder: false,
              citationUrlsByMessageId: new Map(),
              citationSourcesByMessageId: new Map(),
              desktopBasePath: null,
              bottomOffset: 0,
              interactions: [],
              onAnswerAsk: () => true,
              onAnswerApproval: () => true,
              onRetryInteraction: () => true,
              selectedThreadId: "thread-1",
            }),
          ),
        );
      });
    };

    try {
      await renderFeed();

      const alert = container.querySelector('[role="alert"]');
      const healthyRow = container.querySelector('[data-message-id="activity-healthy"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("This activity couldn't be rendered.");
      expect(alert?.className).not.toContain("min-h-screen");
      expect(healthyRow).not.toBeNull();
      expect(container.textContent).toContain("Run command");
      expect(container.textContent).not.toContain("Something went wrong.");

      await renderFeed();
      expect(container.querySelector('[data-message-id="activity-healthy"]')).toBe(healthyRow);
      expect(container.textContent).toContain("Run command");
      expect(container.textContent).not.toContain("Something went wrong.");
    } finally {
      console.error = originalConsoleError;
      harness.dom.window.console.error = originalWindowConsoleError;
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
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
    expect(html).toContain("Run command");
    expect(html).toContain("rm -rf /tmp/x");
  });
});
