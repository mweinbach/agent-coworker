import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");

function setupJsdom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    getComputedStyle: globalThis.getComputedStyle,
    actEnv: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return {
    dom,
    restore: () => {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.navigator = saved.navigator;
      globalThis.HTMLElement = saved.HTMLElement;
      globalThis.Node = saved.Node;
      globalThis.getComputedStyle = saved.getComputedStyle;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.actEnv;
      dom.window.close();
    },
  };
}

describe("desktop app top bar", () => {
  test("renders the right toolbar as plain top-bar controls", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: true,
            onToggleSidebar: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
          }),
        );
      });

      const rightToolbar = container.querySelector(".app-topbar__toolbar--right");
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');
      const sidebarToggle = container.querySelector('button[aria-label="Hide sidebar"]');

      expect(rightToolbar).not.toBeNull();
      expect(rightToolbar?.className).toContain("app-topbar__controls");
      expect(rightToolbar?.className).not.toContain("rounded");
      expect(contextToggle).not.toBeNull();
      expect(sidebarToggle).not.toBeNull();
      expect(sidebarToggle?.className).toContain("app-topbar__sidebar-toggle-button");
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(container.textContent).toContain("Busy");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
