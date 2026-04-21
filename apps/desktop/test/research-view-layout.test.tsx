import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const noop = () => {};

const { useAppStore } = await import("../src/app/store");
const { DEFAULT_RESEARCH_SETTINGS } = await import("../src/app/types");
const { ResearchView } = await import("../src/ui/ResearchView");

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

      const sections = Array.from(viewRoot.children).filter((child) => child instanceof harness.dom.window.HTMLElement);
      const runsPane = sections[0];
      const detailPane = sections[1];

      expect(viewRoot.className).toContain("min-w-0");
      expect(runsPane?.className).toContain("min-w-[18rem]");
      expect(runsPane?.className).toContain("w-[clamp(18rem,26vw,23.75rem)]");
      expect(detailPane?.className).toContain("min-w-0");

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });
});
