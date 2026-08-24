import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";

import { type RendererHotModule, renderRendererRoot } from "../src/lib/rendererRoot";
import { setupJsdom } from "./jsdomHarness";

function createHotModule(data: Record<string, unknown> = {}) {
  const disposeCallbacks: Array<(data: Record<string, unknown>) => void> = [];
  const hot: RendererHotModule = {
    data,
    dispose(callback) {
      disposeCallbacks.push(callback);
    },
  };
  return {
    hot,
    dispose() {
      for (const callback of disposeCallbacks) callback(data);
    },
  };
}

function NavigationProbe({ version }: { version: string }) {
  const [page, setPage] = useState("chat");
  return createElement(
    "button",
    {
      onClick: () => setPage((current) => (current === "chat" ? "settings" : "chat")),
    },
    `${version}:${page}`,
  );
}

describe("renderer root lifecycle", () => {
  test("reuses one mounted React root and preserves navigation through hot replacement", () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root") as HTMLElement;
    const errors: string[] = [];
    const originalError = console.error;
    let activeRoot: Root | null = null;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const firstModule = createHotModule();
      act(() => {
        activeRoot = renderRendererRoot(
          container,
          createElement(NavigationProbe, { version: "first" }),
          firstModule.hot,
        );
      });
      const firstRoot = activeRoot;
      act(() => {
        container.querySelector<HTMLButtonElement>("button")?.click();
      });
      expect(container.textContent).toBe("first:settings");

      firstModule.dispose();
      const replacementModule = createHotModule(firstModule.hot.data);
      act(() => {
        activeRoot = renderRendererRoot(
          container,
          createElement(NavigationProbe, { version: "second" }),
          replacementModule.hot,
        );
      });

      expect(activeRoot === firstRoot).toBe(true);
      expect(container.querySelectorAll("button")).toHaveLength(1);
      expect(container.textContent).toBe("second:settings");
      act(() => {
        container.querySelector<HTMLButtonElement>("button")?.click();
      });
      expect(container.textContent).toBe("second:chat");
      expect(errors).toEqual([]);
    } finally {
      if (activeRoot) act(() => activeRoot?.unmount());
      console.error = originalError;
      harness.restore();
    }
  });

  test("production rendering keeps the ordinary single-root behavior", () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root") as HTMLElement;
    let root: Root | null = null;

    try {
      act(() => {
        root = renderRendererRoot(
          container,
          createElement(NavigationProbe, { version: "release" }),
        );
      });
      expect(container.textContent).toBe("release:chat");
      act(() => {
        container.querySelector<HTMLButtonElement>("button")?.click();
      });
      expect(container.textContent).toBe("release:settings");
    } finally {
      if (root) act(() => root?.unmount());
      harness.restore();
    }
  });
});
