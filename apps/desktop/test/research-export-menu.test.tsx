import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";
const actualButtonModule = await import("../src/components/ui/button");
let exportMenuButtonMockEnabled = false;

mock.module("../src/components/ui/button", () => ({
  ...actualButtonModule,
  Button: ({
    children,
    ...props
  }: any) => exportMenuButtonMockEnabled
    ? createElement("button", props, children)
    : createElement(actualButtonModule.Button, props, children),
}));

const { useAppStore } = await import("../src/app/store");

function resetAppStore(overrides: Record<string, unknown> = {}) {
  const state = useAppStore.getInitialState();
  useAppStore.setState({
    ...state,
    exportResearch: async () => null,
    ...overrides,
  } as never);
}

describe("research export menu", () => {
  beforeEach(() => {
    exportMenuButtonMockEnabled = true;
  });

  afterEach(() => {
    exportMenuButtonMockEnabled = false;
  });

  test("dispatches each export format through the store action", async () => {
    const harness = setupJsdom();
    const exportResearchMock = mock(async () => "/Users/test/Downloads/report.pdf");
    const { ResearchExportMenu } = await import("../src/ui/research/ResearchExportMenu");

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      resetAppStore({
        exportResearch: exportResearchMock,
      });

      await act(async () => {
        root.render(createElement(ResearchExportMenu, {
          researchId: "research-1",
          pending: false,
        }));
      });

      const formats = [
        { label: "Markdown", format: "markdown" },
        { label: "PDF", format: "pdf" },
        { label: "Word", format: "docx" },
      ] as const;

      for (const entry of formats) {
        const trigger = container.querySelector('button[aria-haspopup="menu"]');
        if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing download trigger");
        }
        await act(async () => {
          trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
          await Promise.resolve();
        });

        const action = [...container.querySelectorAll('button[role="menuitem"]')]
          .find((node) => node.textContent?.includes(entry.label));
        if (!(action instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error(`missing ${entry.label} menu item`);
        }

        await act(async () => {
          action.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
          await Promise.resolve();
        });
      }

      expect(exportResearchMock.mock.calls).toEqual([
        ["research-1", "markdown"],
        ["research-1", "pdf"],
        ["research-1", "docx"],
      ]);

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });

  test("disables format actions while an export is pending", async () => {
    const harness = setupJsdom();
    const exportResearchMock = mock(async () => "/Users/test/Downloads/report.pdf");
    const { ResearchExportMenu } = await import("../src/ui/research/ResearchExportMenu");

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }

      const root = createRoot(container);
      resetAppStore({
        exportResearch: exportResearchMock,
      });

      await act(async () => {
        root.render(createElement(ResearchExportMenu, {
          researchId: "research-1",
          pending: true,
        }));
      });

      const trigger = container.querySelector('button[aria-haspopup="menu"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing download trigger");
      }

      expect(trigger.disabled).toBe(false);

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      const actions = [...container.querySelectorAll('button[role="menuitem"]')];
      expect(actions).toHaveLength(3);
      for (const action of actions) {
        expect((action as HTMLButtonElement).disabled).toBe(true);
      }
      expect(exportResearchMock).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      resetAppStore();
      harness.restore();
    }
  });
});
