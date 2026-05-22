import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { useAppStore } = await import("../src/app/store");
const { QuickChatShell } = await import("../src/ui/quickChat/QuickChatShell");

const defaultStoreState = useAppStore.getState();

function resetAppStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    ...defaultStoreState,
    ready: true,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    workspaces: [],
    threads: [],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    workspaceRuntimeById: {},
    threadRuntimeById: {},
    notifications: [],
    providerDefaultModelByProvider: {},
    desktopFeatureFlags: {
      menuBar: true,
      remoteAccess: true,
      workspacePicker: true,
      workspaceLifecycle: true,
      a2ui: false,
    },
    ...overrides,
  } as any);
}

function setupQuickChatJsdom() {
  return setupJsdom({
    setupWindow: (dom) => {
      Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
        configurable: true,
        value: () => {},
      });
      Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
        configurable: true,
        value: () => {},
      });
    },
  });
}

describe("quick chat shell", () => {
  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test("renders the popup surface edge-to-edge without its own outer rounded corner", async () => {
    const harness = setupQuickChatJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(QuickChatShell, {
            init: async () => {},
            ready: false,
            startupError: null,
          }),
        );
      });

      const surface = container.querySelector(".app-surface-overlay");
      expect(surface).toBeInstanceOf(harness.dom.window.HTMLElement);
      expect(surface?.className).toContain("[contain:paint]");
      expect(surface?.className).not.toContain("rounded-[22px]");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("starts a one-off chat even when no project workspaces exist", async () => {
    const harness = setupQuickChatJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        resetAppStore();
        root.render(
          createElement(QuickChatShell, {
            init: async () => {},
            ready: true,
            startupError: null,
          }),
        );
        await Promise.resolve();
      });

      const state = useAppStore.getState();
      expect(state.workspaces[0]?.workspaceKind).toBe("oneOffChat");
      expect(state.threads[0]?.workspaceId).toBe(state.workspaces[0]?.id);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
