import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";

import type { CanvasDocumentOpenRequest } from "../../../src/shared/canvasDocument";
import {
  type NativeCloseWindow,
  NativeWindowCloseCoordinator,
} from "../electron/services/windowCloseCoordinator";
import { composerDraftKeyForThread } from "../src/app/composerDrafts";
import { DESKTOP_STATE_CACHE_KEY } from "../src/app/localStateCache";
import type { PersistedState } from "../src/app/types";
import {
  type CanvasDocumentClient,
  CanvasDocumentController,
} from "../src/lib/canvasDocumentController";
import { registerCanvasDocumentTransitionHandler } from "../src/lib/canvasDocumentLifecycle";
import {
  DESKTOP_EVENT_CHANNELS,
  type WindowCloseRequest,
  type WindowCloseResponseInput,
} from "../src/lib/desktopApi";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

let canvasMounts = 0;
let canvasUnmounts = 0;
const showCanvasWindowMock = mock(async (_opts: { path: string }) => {});
const closeRequestListeners = new Set<(request: WindowCloseRequest) => void>();
const resolveWindowCloseRequestMock = mock(async (_response: WindowCloseResponseInput) => {});
const saveStateMock = mock(async (_state: PersistedState) => {});
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
    onWindowCloseRequested: (listener) => {
      closeRequestListeners.add(listener);
      return () => {
        closeRequestListeners.delete(listener);
      };
    },
    resolveWindowCloseRequest: resolveWindowCloseRequestMock,
    saveState: saveStateMock,
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
const { __internal: persistenceInternal, persistNow } = await import(
  "../src/app/store.helpers/persistence"
);
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
    closeRequestListeners.clear();
    resolveWindowCloseRequestMock.mockReset();
    resolveWindowCloseRequestMock.mockImplementation(async () => {});
    saveStateMock.mockReset();
    saveStateMock.mockImplementation(async () => {});
    persistenceInternal.resetPersistedStateCache();
    resetAppStore();
  });

  afterEach(async () => {
    saveStateMock.mockReset();
    saveStateMock.mockImplementation(async () => {});
    await persistNow(useAppStore.getState);
    persistenceInternal.resetPersistedStateCache();
    setAppState(initialState);
  });

  test.serial("keeps the approved editor usable when another window cancels quit", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    const path = "/workspace/notes.md";
    const client: CanvasDocumentClient = {
      open: openCanvasDocumentMock,
      revision: async () => {
        throw new Error("Unexpected revision read");
      },
      save: mock(async (_workspaceId, input) => ({
        ok: true,
        documentId: input.documentId,
        generation: input.generation,
        editRevision: input.editRevision,
        path,
        revision: {
          modifiedAtMs: input.editRevision,
          changeTimeMs: input.editRevision,
          size: input.content.length,
          fingerprint: `sha256:${input.content}`,
        },
        status: "saved",
      })),
      saveAs: async () => {
        throw new Error("Unexpected Save As");
      },
      close: mock(async (_workspaceId, input) => ({ ok: true, ...input })),
    };
    const controller = new CanvasDocumentController(client, {
      maxBytes: 1024,
      saveDelayMs: 60_000,
      createDocumentId: () => "close-approval-test",
    });
    const unregister = registerCanvasDocumentTransitionHandler((nextPath) =>
      controller.prepareForTransition(nextPath),
    );
    const coordinator = new NativeWindowCloseCoordinator();
    const secondRequests: WindowCloseRequest[] = [];
    const firstWindow = {
      webContents: {
        id: 101,
        send: (channel: string, payload: unknown) => {
          expect(channel).toBe(DESKTOP_EVENT_CHANNELS.windowCloseRequested);
          for (const listener of closeRequestListeners) listener(payload as WindowCloseRequest);
        },
      },
      isDestroyed: () => false,
      on: () => {},
      off: () => {},
      close: mock(() => {}),
      destroy: mock(() => {}),
    } satisfies NativeCloseWindow;
    const secondWindow = {
      webContents: {
        id: 102,
        send: (_channel: string, payload: unknown) => {
          secondRequests.push(payload as WindowCloseRequest);
        },
      },
      isDestroyed: () => false,
      on: () => {},
      off: () => {},
      close: mock(() => {}),
      destroy: mock(() => {}),
    } satisfies NativeCloseWindow;
    const untrackFirst = coordinator.track(firstWindow);
    const untrackSecond = coordinator.track(secondWindow);

    try {
      useAppStore.setState({ filePreview: null });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const createdRoot = createRoot(container);
      root = createdRoot;
      await act(async () => {
        createdRoot.render(createElement(App));
        await flushUi();
      });
      expect(closeRequestListeners.size).toBe(1);
      expect(await controller.open("workspace-1", path)).toBe(true);
      const document = controller.getState().document;
      controller.edit("Unsaved before quit");
      await act(async () => useAppStore.getState().setComposerText("Draft before canceled quit"));
      resolveWindowCloseRequestMock.mockImplementation(async (response) => {
        coordinator.resolve(firstWindow.webContents, response);
      });

      const quitting = coordinator.prepareToQuit();
      await act(async () => {
        await flushUi();
      });

      expect(resolveWindowCloseRequestMock).toHaveBeenCalledTimes(1);
      expect(resolveWindowCloseRequestMock.mock.calls[0]?.[0].canClose).toBe(true);
      expect(client.save).toHaveBeenCalledTimes(1);
      expect(saveStateMock.mock.calls.at(-1)?.[0].composerDrafts).toMatchObject({
        [composerDraftKeyForThread("thread-1")]: { text: "Draft before canceled quit" },
      });
      expect(client.close).not.toHaveBeenCalled();
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "Unsaved before quit",
        saveStatus: "saved",
        document: { documentId: document?.documentId, generation: document?.generation, path },
      });

      const secondRequest = secondRequests[0];
      if (!secondRequest) throw new Error("second window did not receive close approval request");
      coordinator.resolve(secondWindow.webContents, { ...secondRequest, canClose: false });
      expect(await quitting).toBe(false);
      expect(firstWindow.close).not.toHaveBeenCalled();
      expect(firstWindow.destroy).not.toHaveBeenCalled();
      expect(secondWindow.close).not.toHaveBeenCalled();
      expect(secondWindow.destroy).not.toHaveBeenCalled();
      expect(
        useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-1")]?.text,
      ).toBe("Draft before canceled quit");

      controller.edit("Typed after canceled quit");
      expect(await controller.flush()).toBe(true);
      expect(client.save).toHaveBeenCalledTimes(2);
      expect(client.close).not.toHaveBeenCalled();
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "Typed after canceled quit",
        saveStatus: "saved",
        document: { documentId: document?.documentId, generation: document?.generation, path },
      });
    } finally {
      unregister();
      untrackFirst();
      untrackSecond();
      await controller.dispose();
      if (root) {
        const mountedRoot = root;
        await act(async () => mountedRoot.unmount());
      }
      harness.restore();
    }
  });

  test.serial(
    "flushes fresh composer and creation drafts before approving an immediate close",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;
      let releaseFirstSave: () => void = () => {};
      const firstSave = new Promise<void>((resolve) => {
        releaseFirstSave = resolve;
      });
      saveStateMock.mockImplementationOnce(async () => firstSave);

      try {
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
          useAppStore.getState().setComposerText("Just typed before closing");
          useAppStore.getState().setTaskCreationDraft({ title: "Unsubmitted task" });
          useAppStore.getState().toggleSidebar();
          expect(saveStateMock).not.toHaveBeenCalled();
          for (const listener of closeRequestListeners)
            listener({ requestId: "close-fresh-draft" });
          await flushUi();
        });

        expect(saveStateMock).toHaveBeenCalledTimes(1);
        expect(resolveWindowCloseRequestMock).not.toHaveBeenCalled();
        expect(saveStateMock.mock.calls[0]?.[0]).toMatchObject({
          composerDrafts: {
            [composerDraftKeyForThread("thread-1")]: { text: "Just typed before closing" },
          },
          creationDrafts: { task: { title: "Unsubmitted task" } },
        });

        await act(async () => {
          useAppStore.getState().setComposerText("Typed while the close save was pending");
          releaseFirstSave();
          await flushUi();
        });

        expect(saveStateMock).toHaveBeenCalledTimes(2);
        expect(saveStateMock.mock.calls[1]?.[0].composerDrafts).toMatchObject({
          [composerDraftKeyForThread("thread-1")]: {
            text: "Typed while the close save was pending",
          },
        });
        expect(resolveWindowCloseRequestMock).toHaveBeenCalledWith({
          requestId: "close-fresh-draft",
          canClose: true,
        });
        const cached = JSON.parse(
          harness.dom.window.localStorage.getItem(DESKTOP_STATE_CACHE_KEY) ?? "{}",
        );
        expect(
          cached.persistedState.composerDrafts[composerDraftKeyForThread("thread-1")].text,
        ).toBe("Typed while the close save was pending");
        expect(cached.ui.sidebarCollapsed).toBe(useAppStore.getState().sidebarCollapsed);
      } finally {
        releaseFirstSave();
        if (root) {
          const mountedRoot = root;
          await act(async () => mountedRoot.unmount());
        }
        harness.restore();
      }
    },
  );

  test.serial(
    "denies close after a draft save failure and retains the draft for retry",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;
      saveStateMock.mockRejectedValueOnce(new Error("State storage is unavailable"));

      try {
        useAppStore.setState({ filePreview: null, notifications: [] });
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const createdRoot = createRoot(container);
        root = createdRoot;
        await act(async () => {
          createdRoot.render(createElement(App));
          await flushUi();
        });
        await act(async () => {
          useAppStore.getState().setComposerText("Keep this unsaved draft");
          for (const listener of closeRequestListeners)
            listener({ requestId: "close-failed-draft" });
          await flushUi();
        });

        expect(resolveWindowCloseRequestMock).toHaveBeenCalledWith({
          requestId: "close-failed-draft",
          canClose: false,
        });
        expect(
          useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-1")]?.text,
        ).toBe("Keep this unsaved draft");
        expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
          kind: "error",
          title: "Could not save before closing",
          detail: expect.stringContaining("State storage is unavailable"),
        });

        await act(async () => {
          for (const listener of closeRequestListeners)
            listener({ requestId: "retry-close-draft" });
          await flushUi();
        });
        expect(saveStateMock).toHaveBeenCalledTimes(2);
        expect(saveStateMock.mock.calls[1]?.[0].composerDrafts).toMatchObject({
          [composerDraftKeyForThread("thread-1")]: { text: "Keep this unsaved draft" },
        });
        expect(resolveWindowCloseRequestMock).toHaveBeenLastCalledWith({
          requestId: "retry-close-draft",
          canClose: true,
        });
        expect(
          useAppStore
            .getState()
            .notifications.some((entry) => entry.id === "desktop-close-save-failed"),
        ).toBe(false);
      } finally {
        if (root) {
          const mountedRoot = root;
          await act(async () => mountedRoot.unmount());
        }
        harness.restore();
      }
    },
  );

  test.serial(
    "does not persist a blank loading store when close has no owned pending save",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;
      try {
        useAppStore.setState({
          ready: false,
          bootstrapPhase: "loading",
          workspaces: [],
          threads: [],
          selectedWorkspaceId: null,
          selectedThreadId: null,
          filePreview: null,
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
          for (const listener of closeRequestListeners) listener({ requestId: "close-loading" });
          await flushUi();
        });
        expect(saveStateMock).not.toHaveBeenCalled();
        expect(harness.dom.window.localStorage.getItem(DESKTOP_STATE_CACHE_KEY)).toBeNull();
        expect(resolveWindowCloseRequestMock).toHaveBeenCalledWith({
          requestId: "close-loading",
          canClose: true,
        });
      } finally {
        if (root) {
          const mountedRoot = root;
          await act(async () => mountedRoot.unmount());
        }
        harness.restore();
      }
    },
  );

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

  test.serial(
    "restores an inline context rail after closing a compact canvas overlay",
    async () => {
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
        const context = harness.dom.window.document.querySelector(
          '[role="region"][aria-label="Context"]',
        );
        expect(context?.getAttribute("data-presentation")).toBe("inline");
        expect(context?.getAttribute("data-active")).toBe("true");
        expect(
          harness.dom.window.document.querySelector('[data-slot="adaptive-rail-backdrop"]'),
        ).toBeNull();
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

  test.serial(
    "keeps an inline context rail open after closing a narrow canvas overlay",
    async () => {
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
        const context = container.querySelector<HTMLElement>(
          '[role="region"][aria-label="Context"]',
        );
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
        expect(context?.getAttribute("data-presentation")).toBe("inline");
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

  test.serial(
    "restores the inline context rail after switching and closing canvas files",
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
        const context = container.querySelector<HTMLElement>(
          '[role="dialog"][aria-label="Context"]',
        );
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
        expect(context?.getAttribute("role")).toBe("region");
        expect(context?.getAttribute("data-presentation")).toBe("inline");
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

  test.serial("keeps context inline after closing canvas at full width and resizing", async () => {
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
      const context = container.querySelector<HTMLElement>('[role="region"][aria-label="Context"]');
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
      expect(context?.getAttribute("data-presentation")).toBe("inline");
      expect(context?.hasAttribute("aria-hidden")).toBe(false);
    } finally {
      if (root) {
        const mountedRoot = root;
        await act(async () => mountedRoot.unmount());
      }
      harness.restore();
    }
  });

  test.serial("keeps a dismissed canvas overlay closed when switching files", async () => {
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
      const context = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Context"]');
      expect(context?.getAttribute("aria-hidden")).toBe("true");

      await act(async () => {
        useAppStore.setState({
          filePreview: { path: "/Users/mweinbach/Projects/agent-coworker/notes.md" },
        });
        await flushUi();
      });

      expect(context?.getAttribute("aria-hidden")).toBe("true");
      expect(
        container.querySelector<HTMLButtonElement>('button[aria-label="Show context"]'),
      ).not.toBeNull();
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
