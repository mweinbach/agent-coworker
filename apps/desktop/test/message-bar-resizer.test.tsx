import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const { MessageBarResizer } = await import("../src/ui/layout/MessageBarResizer");

function resetAppStore(overrides: Record<string, unknown> = {}) {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    messageBarHeight: 120,
    ...overrides,
  } as any);
}

describe("MessageBarResizer", () => {
  test.serial("renders successfully and handles keyboard events correctly", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      resetAppStore();

      await act(async () => {
        root.render(createElement(MessageBarResizer));
      });

      const resizer = container.querySelector('[aria-label="Resize minimum message bar height"]');

      expect(resizer).not.toBeNull();
      expect(resizer?.className).toContain("app-native-no-drag");
      expect(resizer?.getAttribute("aria-valuenow")).toBe("120");

      await act(async () => {
        resizer?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            key: "ArrowUp",
            bubbles: true,
          } as any),
        );
      });
      expect(useAppStore.getState().messageBarHeight).toBe(136);

      await act(async () => {
        resizer?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
          } as any),
        );
      });
      expect(useAppStore.getState().messageBarHeight).toBe(120);

      await act(async () => {
        resizer?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            key: "Home",
            bubbles: true,
          } as any),
        );
      });
      expect(useAppStore.getState().messageBarHeight).toBe(500);

      await act(async () => {
        resizer?.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            key: "End",
            bubbles: true,
          } as any),
        );
      });
      expect(useAppStore.getState().messageBarHeight).toBe(80);
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });

  test.serial("handles dragging with pointer events correctly", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      resetAppStore();

      await act(async () => {
        root.render(createElement(MessageBarResizer));
      });

      const resizer = container.querySelector('[aria-label="Resize minimum message bar height"]');
      expect(resizer).not.toBeNull();

      await act(async () => {
        resizer?.dispatchEvent(
          new harness.dom.window.PointerEvent("pointerdown", {
            button: 0,
            clientY: 100,
            bubbles: true,
          } as any),
        );
      });

      expect(harness.dom.window.document.body.classList.contains("app-resizing-message-bar")).toBe(
        true,
      );

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.PointerEvent("pointermove", {
            clientY: 50,
            bubbles: true,
          } as any),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(useAppStore.getState().messageBarHeight).toBe(170);

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.PointerEvent("pointerup", {
            bubbles: true,
          } as any),
        );
      });

      expect(harness.dom.window.document.body.classList.contains("app-resizing-message-bar")).toBe(
        false,
      );
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });
});
