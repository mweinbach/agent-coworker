import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

mock.module("../src/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: any) => createElement("button", props, children),
}));

mock.module("../src/ui/research/ResearchFollowUpComposer", () => ({
  ResearchFollowUpComposer: () => createElement("div", { "data-testid": "research-follow-up-composer" }, "follow-up"),
}));

mock.module("../src/ui/research/ResearchReportRenderer", () => ({
  ResearchReportRenderer: ({ markdown }: { markdown: string }) =>
    createElement("div", { "data-testid": "research-report-renderer" }, markdown),
}));

mock.module("../src/ui/research/ResearchSourcesList", () => ({
  ResearchSourcesList: ({ sources }: { sources: Array<unknown> }) =>
    createElement("div", { "data-testid": "research-sources-list" }, `sources:${sources.length}`),
}));

const { useAppStore } = await import("../src/app/store");
const { DEFAULT_RESEARCH_SETTINGS } = await import("../src/app/types");
const { ResearchDetailPane } = await import("../src/ui/research/ResearchDetailPane");
mock.restore();

class MockResizeObserver {
  static width = 640;

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: {
            width: MockResizeObserver.width,
            height: 0,
            top: 0,
            left: 0,
            bottom: 0,
            right: MockResizeObserver.width,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  unobserve() {}

  disconnect() {}
}

function resetAppStore(overrides: Record<string, unknown> = {}) {
  const state = useAppStore.getInitialState();
  useAppStore.setState({
    ...state,
    cancelResearch: async () => {},
    researchExportPendingIds: [],
    ...overrides,
  } as never);
}

describe("research detail pane layout", () => {
  test("renders one report surface without prompt chrome and expands the sources drawer with a responsive width", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      resetAppStore();

      await act(async () => {
        root.render(
          createElement(ResearchDetailPane, {
            research: {
              id: "research-1",
              parentResearchId: null,
              title: "Research title",
              prompt: "Research prompt",
              status: "cancelled",
              interactionId: null,
              lastEventId: null,
              inputs: {
                fileSearchStoreName: undefined,
                files: [],
              },
              settings: DEFAULT_RESEARCH_SETTINGS,
              outputsMarkdown: "# Research title\n\nSummary",
              thoughtSummaries: [
                {
                  id: "thought-1",
                  text: "A progress note",
                  ts: "2026-04-21T21:05:00.000Z",
                },
              ],
              sources: [
                {
                  url: "https://example.com/one",
                  title: "Example One",
                  sourceType: "url",
                },
                {
                  url: "https://example.com/two",
                  title: "Example Two",
                  sourceType: "url",
                },
              ],
              createdAt: "2026-04-21T21:00:00.000Z",
              updatedAt: "2026-04-21T21:10:00.000Z",
              error: null,
            },
          }),
        );
      });

      const toggle = container.querySelector('button[aria-label="Show sources panel"]');
      const drawer = container.querySelector('aside[aria-label="Sources"]');

      if (!(toggle instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing sources toggle");
      }
      if (!(drawer instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing sources drawer");
      }

      expect(container.querySelector('[role="tablist"][aria-label="Research detail sections"]')).toBeNull();
      expect(container.textContent).not.toContain("Brief");
      expect(container.textContent).not.toContain("Research prompt");
      expect(container.querySelector('[aria-label="Reasoning stream"]')).toBeNull();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.getAttribute("aria-controls")).toBe(drawer.id);
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(drawer.getAttribute("data-sources-presentation")).toBe("inline");
      expect(drawer.getAttribute("style")).toContain("--research-sources-panel-width: clamp(18rem, 30vw, 26rem)");
      expect(drawer.getAttribute("style")).toContain("width: 0px");
      expect(drawer.getAttribute("style")).toContain("flex-basis: 0px");

      await act(async () => {
        toggle.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      const openToggle = container.querySelector('button[aria-label="Hide sources panel"]');
      const openDrawer = container.querySelector('aside[aria-label="Sources"]');
      if (!(openToggle instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing expanded sources toggle");
      }
      if (!(openDrawer instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing expanded sources drawer");
      }

      expect(openToggle.getAttribute("aria-expanded")).toBe("true");
      expect(openDrawer.getAttribute("aria-hidden")).toBe("false");
      expect(openDrawer.getAttribute("data-sources-presentation")).toBe("inline");
      expect(openDrawer.getAttribute("style")).toContain("--research-sources-panel-width: clamp(18rem, 30vw, 26rem)");
      expect(openDrawer.getAttribute("style")).toContain("width: var(--research-sources-panel-width)");
      expect(openDrawer.getAttribute("style")).toContain("flex-basis: var(--research-sources-panel-width)");

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("shows reasoning updates inside the report while research is running", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      resetAppStore();

      await act(async () => {
        root.render(
          createElement(ResearchDetailPane, {
            research: {
              id: "research-running",
              parentResearchId: null,
              title: "Research title",
              prompt: "Research prompt",
              status: "running",
              interactionId: null,
              lastEventId: null,
              inputs: {
                fileSearchStoreName: undefined,
                files: [],
              },
              settings: DEFAULT_RESEARCH_SETTINGS,
              outputsMarkdown: "",
              thoughtSummaries: [
                {
                  id: "thought-1",
                  text: "Checking the most relevant source set",
                  ts: "2026-04-21T21:05:00.000Z",
                },
              ],
              sources: [],
              createdAt: "2026-04-21T21:00:00.000Z",
              updatedAt: "2026-04-21T21:05:00.000Z",
              error: null,
            },
          }),
        );
      });

      const stream = container.querySelector('[aria-label="Reasoning stream"]');
      expect(stream).not.toBeNull();
      expect(stream?.textContent).toContain("Reasoning stream");
      expect(stream?.textContent).toContain("Step 1");
      expect(stream?.textContent).toContain("Checking the most relevant source set");
      expect(container.querySelector('[role="tablist"][aria-label="Research detail sections"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("switches the sources panel to an overlay drawer when the detail pane gets too narrow", async () => {
    MockResizeObserver.width = 320;
    const harness = setupJsdom({
      extraGlobals: {
        ResizeObserver: MockResizeObserver,
      },
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);

      resetAppStore();

      await act(async () => {
        root.render(
          createElement(ResearchDetailPane, {
            research: {
              id: "research-overlay",
              parentResearchId: null,
              title: "Research title",
              prompt: "Research prompt",
              status: "completed",
              interactionId: null,
              lastEventId: null,
              inputs: {
                fileSearchStoreName: undefined,
                files: [],
              },
              settings: DEFAULT_RESEARCH_SETTINGS,
              outputsMarkdown: "# Research title\n\nSummary",
              thoughtSummaries: [],
              sources: [
                {
                  url: "https://example.com/one",
                  title: "Example One",
                  sourceType: "url",
                },
              ],
              createdAt: "2026-04-21T21:00:00.000Z",
              updatedAt: "2026-04-21T21:10:00.000Z",
              error: null,
            },
          }),
        );
      });

      const toggle = container.querySelector('button[aria-label="Show sources panel"]');
      const drawer = container.querySelector('aside[aria-label="Sources"]');

      if (!(toggle instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing sources toggle");
      }
      if (!(drawer instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing sources drawer");
      }

      expect(drawer.getAttribute("data-sources-presentation")).toBe("overlay");
      expect(drawer.className).toContain("absolute");
      expect(drawer.getAttribute("style")).toContain("width: 0px");
      expect(drawer.getAttribute("style")).not.toContain("flex-basis");

      await act(async () => {
        toggle.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      const openDrawer = container.querySelector('aside[aria-label="Sources"]');
      if (!(openDrawer instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing expanded sources drawer");
      }

      expect(openDrawer.getAttribute("aria-hidden")).toBe("false");
      expect(openDrawer.getAttribute("data-sources-presentation")).toBe("overlay");
      expect(openDrawer.getAttribute("style")).toContain(
        "width: min(var(--research-sources-panel-width), calc(100% - 0.75rem))",
      );
      expect(openDrawer.getAttribute("style")).not.toContain("flex-basis");

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("passes export availability to the export menu based on completion and report content", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      resetAppStore({
        researchExportPendingIds: ["research-complete"],
      });

      await act(async () => {
        root.render(
          createElement("div", null,
            createElement(ResearchDetailPane, {
              research: {
                id: "research-empty",
                parentResearchId: null,
                title: "Empty report",
                prompt: "Research prompt",
                status: "completed",
                interactionId: null,
                lastEventId: null,
                inputs: { fileSearchStoreName: undefined, files: [] },
                settings: DEFAULT_RESEARCH_SETTINGS,
                outputsMarkdown: "   ",
                thoughtSummaries: [],
                sources: [],
                createdAt: "2026-04-21T21:00:00.000Z",
                updatedAt: "2026-04-21T21:05:00.000Z",
                error: null,
              },
            }),
            createElement(ResearchDetailPane, {
              research: {
                id: "research-complete",
                parentResearchId: null,
                title: "Completed report",
                prompt: "Research prompt",
                status: "completed",
                interactionId: null,
                lastEventId: null,
                inputs: { fileSearchStoreName: undefined, files: [] },
                settings: DEFAULT_RESEARCH_SETTINGS,
                outputsMarkdown: "# Completed report",
                thoughtSummaries: [],
                sources: [],
                createdAt: "2026-04-21T21:00:00.000Z",
                updatedAt: "2026-04-21T21:05:00.000Z",
                error: null,
              },
            }),
          ),
        );
      });

      const exportButtons = [...container.querySelectorAll('button[aria-haspopup="menu"]')];
      expect(exportButtons).toHaveLength(2);

      expect((exportButtons[0] as HTMLButtonElement).disabled).toBe(true);
      expect((exportButtons[1] as HTMLButtonElement).disabled).toBe(false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });
});
