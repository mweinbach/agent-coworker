import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const { SidebarResizer } = await import("../src/ui/layout/SidebarResizer");

function resetAppStore(overrides: Record<string, unknown> = {}) {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    sidebarWidth: 248,
    ...overrides,
  } as any);
}

describe("desktop sidebar resizer", () => {
  test.serial("opts out of native drag regions so the left sidebar stays resizable", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      resetAppStore();

      await act(async () => {
        root.render(createElement(SidebarResizer));
      });

      const separator = container.querySelector('[aria-label="Resize sidebar"]');

      expect(separator).not.toBeNull();
      expect(separator?.className).toContain("app-native-no-drag");
      expect(separator?.className).toContain("right-0");
      expect(separator?.className).toContain("w-2");
      expect(separator?.className).not.toContain("bg-primary/20");
      expect(separator?.getAttribute("aria-valuenow")).toBe("248");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
