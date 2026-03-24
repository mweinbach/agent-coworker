import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const { AppTopBar } = await import("../src/ui/layout/AppTopBar");

describe("desktop app top bar", () => {
  test("renders the inline sidebar toggle and right toolbar controls", async () => {
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
            onNewChat: () => {},
            sidebarCollapsed: false,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
          }),
        );
      });

      const strip = container.querySelector(".app-topbar");
      const sidebarFill = container.querySelector(".app-topbar__sidebar-fill");
      const sidebarToggle = container.querySelector('button[aria-label="Hide sidebar"]');
      const contextToggle = container.querySelector('button[aria-label="Hide context"]');
      const newChatButton = container.querySelector('button[aria-label="New Chat"]');

      expect(strip).not.toBeNull();
      expect(sidebarFill).not.toBeNull();
      expect(sidebarToggle).not.toBeNull();
      expect(sidebarToggle?.className).toContain("app-topbar__sidebar-toggle-button");
      expect(newChatButton).toBeNull();
      expect(contextToggle).not.toBeNull();
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(contextToggle?.className).toContain("app-topbar__toolbar-button");
      expect(container.textContent).toContain("Busy");
      expect(container.textContent).toContain("Cowork");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("shows a collapsed new chat icon beside the sidebar toggle", async () => {
    const harness = setupJsdom();
    const onNewChat = mock(() => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AppTopBar, {
            busy: false,
            onToggleSidebar: () => {},
            onNewChat,
            sidebarCollapsed: true,
            sidebarWidth: 280,
            contextSidebarCollapsed: false,
            onToggleContextSidebar: () => {},
          }),
        );
      });

      const sidebarToggle = container.querySelector('button[aria-label="Show sidebar"]');
      const newChatButton = container.querySelector('button[aria-label="New Chat"]');

      expect(sidebarToggle).not.toBeNull();
      expect(newChatButton).not.toBeNull();
      expect(newChatButton?.className).toContain("app-topbar__toolbar-button");

      await act(async () => {
        newChatButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(onNewChat).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
