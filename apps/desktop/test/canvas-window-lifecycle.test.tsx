import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

let canvasMounts = 0;
let canvasUnmounts = 0;
const showCanvasWindowMock = mock(async (_opts: { path: string }) => {});

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    showCanvasWindow: showCanvasWindowMock,
  }),
);

mock.module("../src/ui/Canvas", () => ({
  Canvas: ({ path }: { path: string }) => {
    useEffect(() => {
      canvasMounts += 1;
      return () => {
        canvasUnmounts += 1;
      };
    }, []);
    return createElement("div", { "data-testid": "canvas" }, path);
  },
}));

mock.module("../src/ui/layout/AppTopBar", () => ({
  AppTopBar: ({
    onPopOutCanvas,
    onToggleCanvasMaximized,
  }: {
    onPopOutCanvas?: () => void;
    onToggleCanvasMaximized?: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "topbar" },
      onPopOutCanvas
        ? createElement(
            "button",
            { "data-testid": "popout-canvas", onClick: onPopOutCanvas },
            "pop out",
          )
        : null,
      onToggleCanvasMaximized
        ? createElement(
            "button",
            { "data-testid": "toggle-canvas-maximized", onClick: onToggleCanvasMaximized },
            "maximize",
          )
        : null,
    ),
}));

mock.module("../src/ui/ContextSidebar", () => ({
  ContextSidebar: () => createElement("div", { "data-testid": "context-sidebar" }),
}));
mock.module("../src/ui/Sidebar", () => ({
  Sidebar: () => createElement("div", { "data-testid": "left-sidebar" }),
}));
mock.module("../src/ui/layout/PrimaryContent", () => ({
  PrimaryContent: () => createElement("main", { "data-testid": "primary-content" }),
}));
mock.module("../src/ui/layout/ContextSidebarResizer", () => ({
  ContextSidebarResizer: () => createElement("div", { "data-testid": "context-resizer" }),
}));
mock.module("../src/ui/layout/SidebarResizer", () => ({
  SidebarResizer: () => createElement("div", { "data-testid": "sidebar-resizer" }),
}));
mock.module("../src/ui/FilePreviewModal", () => ({
  FilePreviewModal: () => null,
}));
mock.module("../src/ui/PromptModal", () => ({
  PromptModal: () => null,
}));
mock.module("../src/ui/onboarding/DesktopOnboarding", () => ({
  DesktopOnboarding: () => null,
}));
mock.module("../src/ui/layout/SettingsContent", () => ({
  SettingsContent: () => createElement("div", { "data-testid": "settings-content" }),
}));
mock.module("../src/ui/menuBar/MenuBarUtilityShell", () => ({
  MenuBarUtilityShell: () => createElement("div", { "data-testid": "menu-bar-shell" }),
}));
mock.module("../src/ui/quickChat/QuickChatShell", () => ({
  QuickChatShell: () => createElement("div", { "data-testid": "quick-chat-shell" }),
}));

const { useAppStore } = await import("../src/app/store");
const { defaultThreadRuntime, defaultWorkspaceRuntime } = await import("../src/app/store.helpers");
const App = (await import("../src/App")).default;

type AppStoreState = ReturnType<typeof useAppStore.getState>;

const initialState = useAppStore.getState();

function setAppState(state: AppStoreState) {
  useAppStore.setState(state, true);
}

function resetAppStore() {
  setAppState(initialState);
  useAppStore.setState({
    ready: true,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    workspaces: [
      {
        id: "workspace-1",
        name: "Workspace",
        path: "/Users/mweinbach/Projects/agent-coworker",
        createdAt: "2026-05-31T00:00:00.000Z",
        lastOpenedAt: "2026-05-31T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    selectedWorkspaceId: "workspace-1",
    threads: [
      {
        id: "thread-1",
        workspaceId: "workspace-1",
        title: "Thread",
        createdAt: "2026-05-31T00:00:00.000Z",
        lastMessageAt: "2026-05-31T00:00:00.000Z",
        status: "active",
        sessionId: "thread-1",
        messageCount: 1,
        lastEventSeq: 0,
      },
    ],
    selectedThreadId: "thread-1",
    threadRuntimeById: { "thread-1": defaultThreadRuntime() },
    workspaceRuntimeById: { "workspace-1": defaultWorkspaceRuntime() },
    desktopFeatureFlags: {
      ...initialState.desktopFeatureFlags,
      canvas: true,
    },
    filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/model.xlsx" },
    contextSidebarCollapsed: false,
    isCanvasMaximized: false,
  } as Partial<AppStoreState>);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("canvas window lifecycle", () => {
  beforeEach(() => {
    canvasMounts = 0;
    canvasUnmounts = 0;
    showCanvasWindowMock.mockClear();
    resetAppStore();
  });

  afterEach(() => {
    setAppState(initialState);
  });

  test.serial("keeps the same canvas mounted while maximizing and restoring", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      expect(canvasMounts).toBe(1);
      expect(canvasUnmounts).toBe(0);

      await act(async () => {
        useAppStore.getState().setCanvasMaximized(true);
        await flushUi();
      });
      expect(canvasMounts).toBe(1);
      expect(canvasUnmounts).toBe(0);

      await act(async () => {
        useAppStore.getState().setCanvasMaximized(false);
        await flushUi();
      });
      expect(canvasMounts).toBe(1);
      expect(canvasUnmounts).toBe(0);
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => {
          mountedRoot.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial(
    "does not expose spreadsheet pop-out while the embedded editor is active",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const createdRoot = createRoot(container);
        root = createdRoot;

        await act(async () => {
          createdRoot.render(createElement(App));
          await flushUi();
        });

        expect(
          harness.dom.window.document.querySelector("[data-testid='popout-canvas']"),
        ).toBeNull();
        expect(showCanvasWindowMock).not.toHaveBeenCalled();
        expect(useAppStore.getState().filePreview).toEqual({
          path: "/Users/mweinbach/Projects/agent-coworker/model.xlsx",
        });
        expect(canvasUnmounts).toBe(0);
      } finally {
        if (root) {
          const mountedRoot = root;
          await act(async () => {
            mountedRoot.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test.serial("opens a document canvas window without closing the active preview", async () => {
    useAppStore.setState({
      filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/notes.md" },
    } as Partial<AppStoreState>);
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      const popOut = harness.dom.window.document.querySelector("[data-testid='popout-canvas']");
      if (!(popOut instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing pop-out button");
      }

      await act(async () => {
        popOut.click();
        await flushUi();
      });

      expect(showCanvasWindowMock).toHaveBeenCalledWith({
        path: "/Users/mweinbach/Projects/agent-coworker/notes.md",
      });
      expect(useAppStore.getState().filePreview).toEqual({
        path: "/Users/mweinbach/Projects/agent-coworker/notes.md",
      });
      expect(canvasUnmounts).toBe(0);
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => {
          mountedRoot.unmount();
        });
      }
      harness.restore();
    }
  });
});
