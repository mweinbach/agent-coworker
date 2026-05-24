import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());
mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { DesktopPage } = await import("../src/ui/settings/pages/DesktopPage");

const defaultStoreActions = {
  setQuickChatIconEnabled: useAppStore.getState().setQuickChatIconEnabled,
  setLiquidGlassComposerEnabled: useAppStore.getState().setLiquidGlassComposerEnabled,
  setQuickChatShortcutEnabled: useAppStore.getState().setQuickChatShortcutEnabled,
  setQuickChatShortcutAccelerator: useAppStore.getState().setQuickChatShortcutAccelerator,
};

describe("desktop settings page", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("quick chat icon switch updates desktop settings", async () => {
    const setQuickChatIconEnabled = mock(() => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          desktopFeatureFlags: {
            menuBar: true,
            remoteAccess: false,
            workspacePicker: true,
            workspaceLifecycle: true,
            a2ui: false,
          },
          desktopSettings: {
            quickChat: {
              iconEnabled: true,
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+Space",
            },
            liquidGlass: {
              composerEnabled: false,
            },
          },
          setQuickChatIconEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(DesktopPage));
      });

      const iconSwitch = container.querySelector('[aria-label="Show quick chat icon"]');
      if (!(iconSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing quick chat icon switch");
      }

      await act(async () => {
        iconSwitch.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setQuickChatIconEnabled).toHaveBeenCalledWith(false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("quick chat shortcut switch updates desktop settings", async () => {
    const setQuickChatShortcutEnabled = mock(() => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          desktopFeatureFlags: {
            menuBar: true,
            remoteAccess: false,
            workspacePicker: true,
            workspaceLifecycle: true,
            a2ui: false,
          },
          desktopSettings: {
            quickChat: {
              iconEnabled: true,
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+Space",
            },
            liquidGlass: {
              composerEnabled: false,
            },
          },
          setQuickChatShortcutEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(DesktopPage));
      });

      expect(container.textContent).toContain("Enable global shortcut");
      const shortcutSwitch = container.querySelector('[aria-label="Enable quick chat shortcut"]');
      if (!(shortcutSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing quick chat shortcut switch");
      }

      await act(async () => {
        shortcutSwitch.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setQuickChatShortcutEnabled).toHaveBeenCalledWith(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("liquid glass composer switch is gated by WebGPU support", async () => {
    const setLiquidGlassComposerEnabled = mock(() => {});
    const harness = setupJsdom();
    try {
      Object.defineProperty(globalThis.navigator, "gpu", {
        configurable: true,
        value: {},
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          desktopFeatureFlags: {
            menuBar: true,
            remoteAccess: false,
            workspacePicker: true,
            workspaceLifecycle: true,
            a2ui: false,
            openAiNativeConnectors: false,
            canvas: false,
          },
          desktopSettings: {
            quickChat: {
              iconEnabled: true,
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+Space",
            },
            liquidGlass: {
              composerEnabled: false,
            },
            archivedChatsAutoDeleteDays: 0,
            sidebarSectionOrder: ["projects", "chats"],
          },
          setLiquidGlassComposerEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(DesktopPage));
      });

      expect(container.textContent).toContain("Liquid glass composer");
      const liquidGlassSwitch = container.querySelector('[aria-label="Liquid glass composer"]');
      if (!(liquidGlassSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing liquid glass switch");
      }

      await act(async () => {
        liquidGlassSwitch.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setLiquidGlassComposerEnabled).toHaveBeenCalledWith(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
