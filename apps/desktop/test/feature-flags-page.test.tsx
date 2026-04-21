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
const { FeatureFlagsPage } = await import("../src/ui/settings/pages/FeatureFlagsPage");

const defaultStoreActions = {
  setDesktopFeatureFlagOverride: useAppStore.getState().setDesktopFeatureFlagOverride,
};

describe("feature flags settings page", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("renders a single global feature flag section", async () => {
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
          updateState: {
            ...useAppStore.getState().updateState,
            packaged: true,
          },
        });
      });

      await act(async () => {
        root.render(createElement(FeatureFlagsPage));
      });

      expect(container.textContent).toContain("Feature flags");
      expect(container.textContent).toContain("Menu bar / tray");
      expect(container.textContent).toContain("Remote access");
      expect(container.textContent).toContain("Generative UI (A2UI)");
      expect(container.textContent).toContain("Quick chat shortcut");
      expect(container.textContent).toContain("Unavailable in packaged builds.");
      const remoteSwitch = container.querySelector('[aria-label="Remote access"]');
      expect(remoteSwitch?.hasAttribute("disabled")).toBe(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("menu bar toggle applies a global desktop override", async () => {
    const setDesktopFeatureFlagOverride = mock(async () => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          desktopFeatureFlags: {
            menuBar: true,
            remoteAccess: true,
            workspacePicker: true,
            workspaceLifecycle: true,
            a2ui: false,
          },
          setDesktopFeatureFlagOverride,
        });
      });

      await act(async () => {
        root.render(createElement(FeatureFlagsPage));
      });

      const menuBarSwitch = container.querySelector('[aria-label="Menu bar / tray"]');
      if (!(menuBarSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing menu bar feature switch");
      }

      await act(async () => {
        menuBarSwitch.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setDesktopFeatureFlagOverride).toHaveBeenCalledWith("menuBar", false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("a2ui toggle applies a global desktop override", async () => {
    const setDesktopFeatureFlagOverride = mock(async () => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          desktopFeatureFlags: {
            menuBar: true,
            remoteAccess: true,
            workspacePicker: true,
            workspaceLifecycle: true,
            a2ui: false,
          },
          setDesktopFeatureFlagOverride,
        });
      });

      await act(async () => {
        root.render(createElement(FeatureFlagsPage));
      });

      const a2uiSwitch = container.querySelector('[aria-label="Generative UI (A2UI)"]');
      if (!(a2uiSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing a2ui feature switch");
      }

      await act(async () => {
        a2uiSwitch.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setDesktopFeatureFlagOverride).toHaveBeenCalledWith("a2ui", true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("quick chat shortcut switch updates desktop settings from feature flags page", async () => {
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
            remoteAccess: true,
            workspacePicker: true,
            workspaceLifecycle: true,
            a2ui: false,
          },
          desktopSettings: {
            quickChat: {
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+Space",
            },
          },
          setQuickChatShortcutEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(FeatureFlagsPage));
      });

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
});
