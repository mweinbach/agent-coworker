import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

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
        root.render(
          createElement(ResearchExportMenu, {
            researchId: "research-1",
            pending: false,
          }),
        );
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
          trigger.dispatchEvent(
            new harness.dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
          );
          trigger.click();
          await Promise.resolve();
        });

        // Radix DropdownMenu portals content into document.body.
        const body = harness.dom.window.document.body;
        const action = [...body.querySelectorAll('[role="menuitem"]')].find((node) =>
          node.textContent?.includes(entry.label),
        );
        if (!action) {
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
        root.render(
          createElement(ResearchExportMenu, {
            researchId: "research-1",
            pending: true,
          }),
        );
      });

      const trigger = container.querySelector('button[aria-haspopup="menu"]');
      if (!(trigger instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing download trigger");
      }

      expect(trigger.disabled).toBe(false);

      await act(async () => {
        trigger.dispatchEvent(
          new harness.dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        trigger.click();
        await Promise.resolve();
      });

      // Radix DropdownMenu portals content into document.body.
      const body = harness.dom.window.document.body;
      const actions = [...body.querySelectorAll('[role="menuitem"]')];
      expect(actions).toHaveLength(3);
      for (const action of actions) {
        expect(action.getAttribute("aria-disabled")).toBe("true");
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
