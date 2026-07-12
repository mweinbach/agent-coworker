import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const noop = () => {};

const { useAppStore } = await import("../src/app/store");
const { DEFAULT_RESEARCH_SETTINGS } = await import("../src/app/types");
const { ResearchView } = await import("../src/ui/ResearchView");
const { collectResearchSubtreeIds } = await import("../src/ui/research/ResearchCardGrid");

class LayoutResizeObserver {
  static width = 640;
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: LayoutResizeObserver.width },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

function resetAppStore(overrides: Record<string, unknown> = {}) {
  const state = useAppStore.getInitialState();
  useAppStore.setState({
    ...state,
    refreshResearchList: noop,
    researchById: {},
    researchListError: null,
    researchListLoading: false,
    researchOrder: [],
    selectedResearchId: null,
    selectResearch: noop,
    ...overrides,
  } as never);
}

describe("research view layout", () => {
  test("keeps the detail pane shrinkable while the runs rail uses a responsive width clamp", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      const research = {
        id: "research-1",
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
        sources: [],
        createdAt: "2026-04-21T21:00:00.000Z",
        updatedAt: "2026-04-21T21:10:00.000Z",
        error: null,
      };

      resetAppStore({
        researchById: { [research.id]: research },
        researchOrder: [research.id],
        selectedResearchId: research.id,
      });

      await act(async () => {
        root.render(createElement(ResearchView));
      });

      const viewRoot = container.firstElementChild;
      if (!(viewRoot instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing research view root");
      }

      const sections = Array.from(viewRoot.children).filter(
        (child) => child instanceof harness.dom.window.HTMLElement,
      );
      const runsPane = sections[0];
      const detailPane = sections[1];

      expect(viewRoot.className).toContain("min-w-0");
      expect(runsPane?.className).toContain("min-w-[18rem]");
      expect(runsPane?.className).toContain("w-[clamp(18rem,26vw,23.75rem)]");
      expect(detailPane?.className).toContain("min-w-0");
      expect(container.textContent).toContain("Select a run or follow-up");
      expect(container.textContent).not.toContain("Deep Research runs in the background");

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("uses one-pane history navigation when its actual container is compact", async () => {
    const harness = setupJsdom({ extraGlobals: { ResizeObserver: LayoutResizeObserver } });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      const research = {
        id: "research-compact",
        parentResearchId: null,
        title: "Compact research",
        prompt: "Research prompt",
        status: "completed",
        interactionId: null,
        lastEventId: null,
        inputs: { files: [] },
        settings: DEFAULT_RESEARCH_SETTINGS,
        outputsMarkdown: "# Compact research\n\nSummary",
        thoughtSummaries: [],
        sources: [],
        createdAt: "2026-04-21T21:00:00.000Z",
        updatedAt: "2026-04-21T21:10:00.000Z",
        error: null,
      };
      resetAppStore({
        researchById: { [research.id]: research },
        researchOrder: [research.id],
        selectedResearchId: research.id,
      });

      await act(async () => root.render(createElement(ResearchView)));
      await act(async () => await Promise.resolve());

      const view = container.querySelector('[data-research-layout="compact"]');
      const historyButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open research history"]',
      );
      expect(view).not.toBeNull();
      expect(historyButton).not.toBeNull();
      expect(container.textContent).toContain("Summary");

      await act(async () => historyButton?.click());
      expect(container.textContent).toContain("Select a run or follow-up");
      expect(
        container.querySelector('[role="listbox"][aria-label="Research history"]'),
      ).not.toBeNull();

      const option = container.querySelector<HTMLElement>('[role="option"]');
      await act(async () => option?.click());
      expect(container.textContent).toContain("Summary");

      await act(async () => root.unmount());
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("shows readiness status without restoring the retired helper copy", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      resetAppStore();

      await act(async () => {
        root.render(createElement(ResearchView));
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-slot="message-composer-status"]')?.getAttribute("aria-live"),
      ).toBe("polite");
      expect(container.textContent).not.toContain(
        "Deep Research runs in the background and streams cited markdown as it arrives.",
      );

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("renders research history as a selectable list with an active option", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      const parentResearch = {
        id: "research-parent",
        parentResearchId: null,
        title: "Comprehensive analysis",
        prompt: "Compare model vendors",
        status: "completed",
        interactionId: null,
        lastEventId: null,
        inputs: {
          fileSearchStoreName: undefined,
          files: [],
        },
        settings: DEFAULT_RESEARCH_SETTINGS,
        outputsMarkdown: "# Comprehensive analysis\n\nA concise report summary.",
        thoughtSummaries: [{ label: "Working set", text: "notes" }],
        sources: [
          { id: "source-1", title: "Source", url: "https://example.com", domain: "example.com" },
        ],
        createdAt: "2026-04-21T21:00:00.000Z",
        updatedAt: "2026-04-21T21:10:00.000Z",
        error: null,
      };
      const childResearch = {
        ...parentResearch,
        id: "research-child",
        parentResearchId: parentResearch.id,
        title: "Follow-up analysis",
        outputsMarkdown: "# Follow-up analysis\n\nA narrower follow-up summary.",
        updatedAt: "2026-04-21T21:12:00.000Z",
      };

      resetAppStore({
        researchById: { [parentResearch.id]: parentResearch, [childResearch.id]: childResearch },
        researchOrder: [parentResearch.id, childResearch.id],
        selectedResearchId: childResearch.id,
      });

      await act(async () => {
        root.render(createElement(ResearchView));
      });

      const listbox = container.querySelector('[role="listbox"][aria-label="Research history"]');
      expect(listbox).not.toBeNull();

      const selectedOption = container.querySelector('[role="option"][aria-selected="true"]');
      expect(selectedOption?.textContent).toContain("Follow-up");
      expect(selectedOption?.textContent).toContain("Follow-up analysis");

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("defines hide behavior over the complete research follow-up subtree", () => {
    const parent = {
      id: "research-parent",
      parentResearchId: null,
    };
    const child = {
      id: "research-child",
      parentResearchId: parent.id,
    };
    const grandchild = {
      id: "research-grandchild",
      parentResearchId: child.id,
    };
    const sibling = {
      id: "research-sibling",
      parentResearchId: null,
    };

    expect(
      collectResearchSubtreeIds([parent, child, grandchild, sibling] as never, parent.id),
    ).toEqual(new Set([parent.id, child.id, grandchild.id]));
  });

  test("restores hidden research and its follow-ups from the empty state", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);
      const parent = {
        id: "research-hidden-parent",
        parentResearchId: null,
        title: "Hidden parent",
        prompt: "Parent prompt",
        status: "completed",
        interactionId: "interaction-parent",
        lastEventId: null,
        inputs: { files: [] },
        settings: DEFAULT_RESEARCH_SETTINGS,
        outputsMarkdown: "",
        thoughtSummaries: [],
        sources: [],
        createdAt: "2026-04-21T21:00:00.000Z",
        updatedAt: "2026-04-21T21:10:00.000Z",
        error: null,
      };
      const child = {
        ...parent,
        id: "research-hidden-child",
        parentResearchId: parent.id,
        title: "Hidden follow-up",
        updatedAt: "2026-04-21T21:12:00.000Z",
      };
      harness.dom.window.localStorage.setItem(
        "cowork.research.hiddenIds",
        JSON.stringify([parent.id, child.id]),
      );
      resetAppStore({
        researchById: { [parent.id]: parent, [child.id]: child },
        researchOrder: [child.id, parent.id],
      });

      await act(async () => {
        root?.render(createElement(ResearchView));
      });

      expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
      const restoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Restore hidden research (2)"),
      );
      expect(restoreButton).toBeDefined();

      await act(async () => {
        restoreButton?.click();
      });

      expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(container.textContent).toContain("Hidden parent");
      expect(container.textContent).toContain("Hidden follow-up");
      expect(harness.dom.window.localStorage.getItem("cowork.research.hiddenIds")).toBe("[]");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      resetAppStore();
      harness.restore();
    }
  });
});
