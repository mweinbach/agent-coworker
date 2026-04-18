import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
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
  updateWorkspaceDefaults: useAppStore.getState().updateWorkspaceDefaults,
  setDesktopFeatureFlagOverride: useAppStore.getState().setDesktopFeatureFlagOverride,
  selectWorkspace: useAppStore.getState().selectWorkspace,
};

describe("feature flags settings page", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("renders desktop and workspace feature flag sections", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "google",
              defaultModel: "gemini-2.5-pro",
              defaultPreferredChildModel: "gemini-2.5-pro",
              defaultChildModelRoutingMode: "same-provider",
              defaultPreferredChildModelRef: "google:gemini-2.5-pro",
              defaultAllowedChildModelRefs: [],
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              defaultFeatureFlags: { experimentalApi: true, a2ui: false },
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          desktopFeatureFlags: {
            remoteAccess: false,
            workspacePicker: true,
            workspaceLifecycle: true,
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

      expect(container.textContent).toContain("Desktop feature flags");
      expect(container.textContent).toContain("Workspace feature flags");
      expect(container.textContent).toContain("Remote access");
      expect(container.textContent).toContain("Experimental JSON-RPC capabilities");
      expect(container.textContent).toContain("Generative UI (A2UI)");
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

  test("workspace flag toggle applies a workspace defaults patch", async () => {
    const updateWorkspaceDefaults = mock(async () => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "google",
              defaultModel: "gemini-2.5-pro",
              defaultPreferredChildModel: "gemini-2.5-pro",
              defaultChildModelRoutingMode: "same-provider",
              defaultPreferredChildModelRef: "google:gemini-2.5-pro",
              defaultAllowedChildModelRefs: [],
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              defaultFeatureFlags: { experimentalApi: true, a2ui: false },
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          desktopFeatureFlags: {
            remoteAccess: true,
            workspacePicker: true,
            workspaceLifecycle: true,
          },
          updateWorkspaceDefaults,
        });
      });

      await act(async () => {
        root.render(createElement(FeatureFlagsPage));
      });

      const workspaceSwitch = container.querySelector('[aria-label="Experimental JSON-RPC capabilities"]');
      if (!(workspaceSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing workspace feature switch");
      }

      await act(async () => {
        workspaceSwitch.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(updateWorkspaceDefaults).toHaveBeenCalledWith("ws-1", {
        defaultFeatureFlags: {
          experimentalApi: false,
        },
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
