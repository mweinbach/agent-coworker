import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { PlatformTopBarChrome } = await import("../src/ui/layout/PlatformTopBarChrome");

type Info = {
  platform: "macos" | "windows" | "linux" | "other";
  rawPlatform: string;
  sidebarTitlebandMode: "native" | "topbar";
  topbarControlPlacement: "sidebar" | "left-rail" | "inline";
  usesNativeGlass: boolean;
  disableCssBlur: boolean;
};

function makeInfo(overrides: Partial<Info>): Info {
  return {
    platform: "linux",
    rawPlatform: "linux",
    sidebarTitlebandMode: "topbar",
    topbarControlPlacement: "inline",
    usesNativeGlass: false,
    disableCssBlur: false,
    ...overrides,
  };
}

describe("PlatformTopBarChrome", () => {
  test("renders macOS SidebarCollapseControl when placement is sidebar", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(PlatformTopBarChrome, {
            platformInfo: makeInfo({
              platform: "macos",
              rawPlatform: "darwin",
              topbarControlPlacement: "sidebar",
            }),
            sidebarCollapsed: false,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarLabel: "Hide sidebar",
          }),
        );
      });

      expect(container.querySelector(".app-sidebar-collapse-control")).not.toBeNull();
      expect(container.querySelector(".app-topbar__win32-left-rail")).toBeNull();
      expect(container.querySelector(".app-topbar__inline-sidebar-toggle")).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders Windows left rail with collapse control when sidebar is expanded", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(PlatformTopBarChrome, {
            platformInfo: makeInfo({
              platform: "windows",
              rawPlatform: "win32",
              sidebarTitlebandMode: "native",
              topbarControlPlacement: "left-rail",
            }),
            sidebarCollapsed: false,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarLabel: "Hide sidebar",
          }),
        );
      });

      expect(container.querySelector(".app-sidebar-collapse-control")).toBeNull();
      expect(container.querySelector(".app-topbar__win32-left-rail")).not.toBeNull();
      expect(container.querySelector(".app-topbar__inline-sidebar-toggle")).toBeNull();
      expect(container.querySelector('button[aria-label="New Chat"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Hide sidebar"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders Windows left rail with expand and new chat when collapsed", async () => {
    const harness = setupJsdom();
    const onNewChat = mock(() => {});
    const onToggleSidebar = mock(() => {});
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(PlatformTopBarChrome, {
            platformInfo: makeInfo({
              platform: "windows",
              rawPlatform: "win32",
              sidebarTitlebandMode: "native",
              topbarControlPlacement: "left-rail",
            }),
            sidebarCollapsed: true,
            onToggleSidebar,
            onNewChat,
            sidebarLabel: "Show sidebar",
          }),
        );
      });

      const leftRail = container.querySelector(".app-topbar__win32-left-rail");
      const buttons = Array.from(leftRail?.querySelectorAll("button") ?? []);
      expect(leftRail).not.toBeNull();
      expect(buttons).toHaveLength(2);
      expect(buttons[0]?.getAttribute("aria-label")).toBe("Show sidebar");
      expect(buttons[1]?.getAttribute("aria-label")).toBe("New Chat");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders inline toggle on Linux", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(PlatformTopBarChrome, {
            platformInfo: makeInfo({
              platform: "linux",
              rawPlatform: "linux",
              topbarControlPlacement: "inline",
            }),
            sidebarCollapsed: false,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarLabel: "Hide sidebar",
          }),
        );
      });

      expect(container.querySelector(".app-topbar__inline-sidebar-toggle")).not.toBeNull();
      expect(container.querySelector(".app-sidebar-collapse-control")).toBeNull();
      expect(container.querySelector(".app-topbar__win32-left-rail")).toBeNull();

      // With sidebar expanded, no New Chat button (only sidebar toggle)
      expect(container.querySelector('button[aria-label="New Chat"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Hide sidebar"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("Linux inline toggle adds New Chat when sidebar is collapsed", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(PlatformTopBarChrome, {
            platformInfo: makeInfo({
              platform: "linux",
              rawPlatform: "linux",
              topbarControlPlacement: "inline",
            }),
            sidebarCollapsed: true,
            onToggleSidebar: () => {},
            onNewChat: () => {},
            sidebarLabel: "Show sidebar",
          }),
        );
      });

      expect(container.querySelector('button[aria-label="New Chat"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
