import { beforeEach as resetNavigationBeforeEach } from "bun:test";
import { appNavigation } from "../src/app/navigation";
import { setAppState } from "./helpers/navigation";

resetNavigationBeforeEach(() =>
  appNavigation.update({ view: "chat", settingsPage: "models", lastNonSettingsView: "chat" }, true),
);

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const windowClose = mock(async () => {});

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({ windowClose }));

const { useAppStore } = await import("../src/app/store");
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
  "../src/components/ui/dialog"
);
const { OverlayStackProvider } = await import("../src/ui/OverlayStack");
const { QuickChatShell } = await import("../src/ui/quickChat/QuickChatShell");

const defaultStoreState = useAppStore.getState();

function resetAppStore(overrides: Record<string, unknown> = {}) {
  setAppState(useAppStore, {
    ...defaultStoreState,
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
    navigation: { view: "chat" },
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
      REMOVEDUI: false,
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

function makeThread(id: string) {
  return {
    id,
    workspaceId: "workspace-1",
    title: id,
    createdAt: "2026-03-24T09:00:00.000Z",
    lastMessageAt: "2026-03-24T09:00:00.000Z",
    status: "active" as const,
    sessionId: null,
    messageCount: 0,
    lastEventSeq: 0,
    draft: true,
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("quick chat shell", () => {
  beforeEach(() => {
    windowClose.mockClear();
    resetAppStore();
  });

  afterEach(() => {
    setAppState(useAppStore, defaultStoreState);
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
        root.render(
          createElement(QuickChatShell, {
            init: async () => {},
            ready: true,
            startupError: null,
          }),
        );
      });
      await act(async () => {
        await waitForCondition(() => useAppStore.getState().workspaces.length > 0);
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

  test("does not reselect the launch thread after starting a new chat", async () => {
    const harness = setupQuickChatJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      harness.dom.reconfigure({
        url: "http://localhost/?window=quick-chat&threadId=launch-thread",
      });
      const selectThread = mock(async (threadId: string) => {
        setAppState(useAppStore, { selectedThreadId: threadId });
      });
      const newThread = mock(async () => {
        setAppState(useAppStore, { selectedThreadId: "new-thread" });
        return true;
      });
      resetAppStore({
        threads: [makeThread("launch-thread"), makeThread("new-thread")],
        selectedThreadId: "launch-thread",
        selectThread,
        newThread,
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(QuickChatShell, { init: async () => {}, ready: true, startupError: null }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Start a new chat"]')?.click();
      });

      expect(newThread).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().selectedThreadId).toBe("new-thread");
      expect(selectThread).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });

  test("waits for the launch thread to hydrate without creating another chat", async () => {
    const harness = setupQuickChatJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      harness.dom.reconfigure({
        url: "http://localhost/?window=quick-chat&threadId=launch-thread",
      });
      const selectThread = mock(async (threadId: string) => {
        setAppState(useAppStore, { selectedThreadId: threadId });
      });
      const newThread = mock(async () => true);
      resetAppStore({ selectThread, newThread });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(QuickChatShell, { init: async () => {}, ready: true, startupError: null }),
        );
      });
      expect(newThread).not.toHaveBeenCalled();

      await act(async () => {
        setAppState(useAppStore, { threads: [makeThread("launch-thread")] });
      });
      expect(selectThread).toHaveBeenCalledTimes(1);
      expect(selectThread).toHaveBeenCalledWith("launch-thread");
      expect(useAppStore.getState().selectedThreadId).toBe("launch-thread");
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });

  test("honors a new chat before the launch thread finishes hydrating", async () => {
    const harness = setupQuickChatJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      harness.dom.reconfigure({
        url: "http://localhost/?window=quick-chat&threadId=launch-thread",
      });
      const selectThread = mock(async (threadId: string) => {
        setAppState(useAppStore, { selectedThreadId: threadId });
      });
      const newThread = mock(async () => {
        setAppState(useAppStore, {
          threads: [makeThread("new-thread")],
          selectedThreadId: "new-thread",
        });
        return true;
      });
      resetAppStore({ selectThread, newThread });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(QuickChatShell, { init: async () => {}, ready: true, startupError: null }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Start a new chat"]')?.click();
      });
      await act(async () => {
        setAppState(useAppStore, {
          threads: [makeThread("launch-thread"), makeThread("new-thread")],
        });
      });

      expect(newThread).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().selectedThreadId).toBe("new-thread");
      expect(selectThread).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });

  test("dismisses a Quick Chat overlay before closing its window", async () => {
    const harness = setupQuickChatJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      function QuickChatWithDialog() {
        const [open, setOpen] = useState(true);
        return createElement(
          OverlayStackProvider,
          null,
          createElement(QuickChatShell, {
            init: async () => {},
            ready: false,
            startupError: null,
          }),
          createElement(
            Dialog,
            { open, onOpenChange: setOpen },
            createElement(
              DialogContent,
              null,
              createElement(DialogTitle, null, "Quick Chat dialog"),
              createElement(DialogDescription, null, "Overlay ownership test"),
            ),
          ),
        );
      }

      await act(async () => root?.render(createElement(QuickChatWithDialog)));
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).not.toBeNull();

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });

      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).toBeNull();
      expect(windowClose).not.toHaveBeenCalled();

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });
      expect(windowClose).toHaveBeenCalledTimes(1);
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });
});
