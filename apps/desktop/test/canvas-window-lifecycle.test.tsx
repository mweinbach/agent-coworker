import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";

import type { CanvasDocumentOpenRequest } from "../../../src/shared/canvasDocument";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

let canvasMounts = 0;
let canvasUnmounts = 0;
const showCanvasWindowMock = mock(async (_opts: { path: string }) => {});
const openCanvasDocumentMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentOpenRequest, "cwd">) => ({
    ok: true as const,
    document: {
      documentId: input.documentId,
      generation: input.generation,
      path: input.path,
      content: "# Notes",
      truncated: false,
      revision: {
        modifiedAtMs: 1,
        changeTimeMs: 1,
        size: 7,
        fingerprint: "sha256:notes",
      },
    },
  }),
);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    showCanvasWindow: showCanvasWindowMock,
  }),
);

mock.module("../src/ui/LazyUniverSpreadsheetCanvas", () => ({
  LazyUniverSpreadsheetCanvas: ({ path }: { path: string }) => {
    useEffect(() => {
      canvasMounts += 1;
      return () => {
        canvasUnmounts += 1;
      };
    }, []);
    return createElement("div", { "data-testid": "canvas" }, path);
  },
}));

const { useAppStore } = await import("../src/app/store");
const { defaultThreadRuntime, defaultWorkspaceRuntime } = await import("../src/app/store.helpers");
const App = (await import("../src/App")).default;

type AppStoreState = ReturnType<typeof useAppStore.getState>;

const initialState = useAppStore.getState();

function setAppState(state: AppStoreState) {
  useAppStore.setState(state);
}

function resetAppStore() {
  setAppState(initialState);
  useAppStore.setState({
    ready: true,
    bootstrapPhase: "ready",
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
    openCanvasDocument: openCanvasDocumentMock,
    closeCanvasDocument: async (_workspaceId, input) => ({ ok: true, ...input }),
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
    openCanvasDocumentMock.mockClear();
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
      const pane = harness.dom.window.document.querySelector(".app-right-sidebar-pane");
      if (!(pane instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing right sidebar pane");
      }
      expect(pane.style.width).toBe("0px");
      expect(pane.className).toContain("overflow-visible");
      expect(pane.className).not.toContain("overflow-hidden");

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

  test.serial("keeps canvas chrome available when a resize hides the overlay rail", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 1_240,
        writable: true,
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      expect(
        harness.dom.window.document.querySelector('button[aria-label="Close canvas"]'),
      ).not.toBeNull();

      expect(
        harness.dom.window.document.querySelector('button[aria-label="Hide context"]'),
      ).not.toBeNull();

      await act(async () => {
        harness.dom.window.innerWidth = 800;
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).not.toBeNull();
      expect(
        harness.dom.window.document.querySelector('button[aria-label="Close canvas"]'),
      ).not.toBeNull();
      expect(
        harness.dom.window.document.querySelector('button[aria-label="Close context"]'),
      ).not.toBeNull();

      await act(async () => {
        harness.dom.window.document
          .querySelector<HTMLButtonElement>('button[aria-label="Close canvas"]')
          ?.click();
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).toBeNull();
      expect(
        harness.dom.window.document
          .querySelector('[role="dialog"][aria-label="Context"]')
          ?.getAttribute("aria-hidden"),
      ).toBe("true");
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

  test.serial("closes the sidebar overlay when opening a canvas overlay", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 680,
        writable: true,
      });
      useAppStore.setState({ filePreview: null });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Show sidebar"]')?.click();
        await flushUi();
      });
      const sidebar = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Sidebar"]');
      expect(sidebar?.hasAttribute("aria-hidden")).toBe(false);

      await act(async () => {
        useAppStore.setState({
          filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/model.xlsx" },
        });
        await flushUi();
      });

      expect(sidebar?.getAttribute("aria-hidden")).toBe("true");
      expect(
        container
          .querySelector<HTMLElement>('[role="dialog"][aria-label="Context"]')
          ?.hasAttribute("aria-hidden"),
      ).toBe(false);
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => mountedRoot.unmount());
      }
      harness.restore();
    }
  });

  test.serial("keeps a manually opened context overlay open after closing canvas", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 680,
        writable: true,
      });
      useAppStore.setState({ filePreview: null });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Show context"]')?.click();
        await flushUi();
      });
      const context = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Context"]');
      expect(context?.hasAttribute("aria-hidden")).toBe(false);

      await act(async () => {
        useAppStore.setState({
          filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/model.xlsx" },
        });
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Close canvas"]')?.click();
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).toBeNull();
      expect(context?.hasAttribute("aria-hidden")).toBe(false);
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => mountedRoot.unmount());
      }
      harness.restore();
    }
  });

  test.serial("closes a canvas-owned overlay after switching canvas files", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 680,
        writable: true,
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      const context = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Context"]');
      expect(context?.hasAttribute("aria-hidden")).toBe(false);

      await act(async () => {
        useAppStore.setState({
          filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/notes.md" },
        });
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Close canvas"]')?.click();
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).toBeNull();
      expect(context?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => mountedRoot.unmount());
      }
      harness.restore();
    }
  });

  test.serial(
    "relinquishes canvas ownership after a manual overlay dismiss and reopen",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;
      try {
        Object.defineProperty(harness.dom.window, "innerWidth", {
          configurable: true,
          value: 680,
          writable: true,
        });
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const createdRoot = createRoot(container);
        root = createdRoot;

        await act(async () => {
          createdRoot.render(createElement(App));
          await flushUi();
        });
        await act(async () => {
          container.querySelector<HTMLButtonElement>('button[aria-label="Close context"]')?.click();
          await flushUi();
        });
        await act(async () => {
          container.querySelector<HTMLButtonElement>('button[aria-label="Show context"]')?.click();
          await flushUi();
        });
        const context = container.querySelector<HTMLElement>(
          '[role="dialog"][aria-label="Context"]',
        );
        expect(context?.hasAttribute("aria-hidden")).toBe(false);

        await act(async () => {
          container.querySelector<HTMLButtonElement>('button[aria-label="Close canvas"]')?.click();
          await flushUi();
        });

        expect(useAppStore.getState().filePreview).toBeNull();
        expect(context?.hasAttribute("aria-hidden")).toBe(false);
      } finally {
        if (root) {
          const mountedRoot = root;
          await act(async () => mountedRoot.unmount());
        }
        harness.restore();
      }
    },
  );

  test.serial("clears canvas overlay ownership when canvas closes at full width", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 680,
        writable: true,
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;

      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      await act(async () => {
        harness.dom.window.innerWidth = 1_240;
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Close canvas"]')?.click();
        await flushUi();
      });
      await act(async () => {
        harness.dom.window.innerWidth = 680;
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Show context"]')?.click();
        await flushUi();
      });
      const context = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Context"]');
      expect(context?.hasAttribute("aria-hidden")).toBe(false);

      await act(async () => {
        useAppStore.setState({
          filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/notes.md" },
        });
        await flushUi();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Close canvas"]')?.click();
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).toBeNull();
      expect(context?.hasAttribute("aria-hidden")).toBe(false);
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => mountedRoot.unmount());
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
          harness.dom.window.document.querySelector('button[aria-label="Open canvas in window"]'),
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
      const viewOptions = harness.dom.window.document.querySelector(
        'button[aria-label="Canvas view options"]',
      );
      if (!(viewOptions instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing Canvas view options");
      }

      await act(async () => {
        viewOptions.dispatchEvent(
          new harness.dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        await flushUi();
      });
      const popOut = Array.from(
        harness.dom.window.document.body.querySelectorAll('[role="menuitem"]'),
      ).find((item) => item.textContent?.includes("Open in window"));
      if (!popOut) {
        throw new Error("missing compact Canvas pop-out action");
      }

      await act(async () => {
        popOut.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
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
