import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const showNotification = mock(async () => true);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    showNotification,
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const App = (await import("../src/App")).default;
const { useAppStore } = await import("../src/app/store");

const defaultStoreState = useAppStore.getState();

function seedReadyState() {
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPending: false,
    startupError: null,
    workspaces: [],
    threads: [],
    notifications: [
      {
        id: "n-1",
        kind: "info",
        title: "Heads up",
        detail: "Popup test",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
    ],
  });
}

function seedTerminalTaskApprovalState(dismissPrompt: () => void) {
  const now = "2026-04-30T00:00:00.000Z";
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPending: false,
    startupError: null,
    onboardingVisible: false,
    promptModal: null,
    view: "task",
    workspaces: [
      {
        id: "ws-1",
        name: "Project",
        path: "/tmp/workspace",
        createdAt: now,
        lastOpenedAt: now,
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    selectedWorkspaceId: "ws-1",
    selectedThreadId: "task-session-1",
    selectedTaskId: "task-1",
    threads: [
      {
        id: "task-session-1",
        workspaceId: "ws-1",
        title: "Terminal task",
        createdAt: now,
        lastMessageAt: now,
        status: "active",
        sessionId: "task-session-1",
        messageCount: 0,
        lastEventSeq: 0,
        draft: false,
        taskId: "task-1",
        taskThreadId: "task-thread-1",
      },
    ],
    tasksById: {
      "task-1": {
        id: "task-1",
        workspacePath: "/tmp/workspace",
        title: "Terminal task",
        objective: "Verify pending approvals are not stranded.",
        status: "completed",
        revision: 1,
        reviewRequired: false,
        createdAt: now,
        updatedAt: now,
        threadCount: 1,
        completedWorkItemCount: 0,
        totalWorkItemCount: 0,
        activeBlockerCount: 0,
        pendingQuestionCount: 0,
        blockingQuestionCount: 0,
        requirements: [],
        threads: [{ id: "task-thread-1", taskId: "task-1", sessionId: "task-session-1" }],
        workItems: [],
        decisions: [],
        questions: [],
        artifacts: [],
        blockers: [],
        activity: [],
        latestCheckpoint: null,
      },
    } as never,
    sandboxApprovalsByThread: {
      "task-session-1": [
        {
          requestId: "approval-1",
          command: "curl https://example.com",
          reason: "The OS sandbox blocked network access for this command.",
          category: "network",
          receivedSequence: 1,
        },
      ],
    },
    dismissPrompt,
  } as never);
}

function seedDisconnectedChatState(hydrating: boolean) {
  const now = "2026-04-30T00:00:00.000Z";
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    workspaces: [
      {
        id: "ws-1",
        name: "Project",
        path: "/tmp/workspace",
        createdAt: now,
        lastOpenedAt: now,
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    selectedWorkspaceId: "ws-1",
    selectedThreadId: "chat-session-1",
    selectedTaskId: null,
    threads: [
      {
        id: "chat-session-1",
        workspaceId: "ws-1",
        title: "Disconnected chat",
        createdAt: now,
        lastMessageAt: now,
        status: "active",
        sessionId: "chat-session-1",
        messageCount: 0,
        lastEventSeq: 0,
        draft: false,
      },
    ],
    threadRuntimeById: {
      "chat-session-1": {
        sessionId: "chat-session-1",
        connected: false,
        hydrating,
        busy: false,
        feed: [],
      },
    },
  } as never);
}

describe("app window-mode notification routing", () => {
  beforeEach(() => {
    showNotification.mockClear();
    useAppStore.setState(defaultStoreState);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test("only the main window forwards store notifications to OS notices", async () => {
    const harness = setupJsdom({
      setupWindow: (dom) => {
        dom.window.history.replaceState({}, "", "http://localhost/?window=quick-chat");
      },
    });

    try {
      seedReadyState();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      expect(showNotification).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("main window still forwards new notifications to the OS", async () => {
    const harness = setupJsdom();

    try {
      seedReadyState();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      expect(showNotification).toHaveBeenCalledWith({
        title: "Heads up",
        body: "Popup test",
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("settings replaces the chat shell across the full window", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedReadyState();
      useAppStore.getState().openSettings("models");
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(App));
      });

      expect(container.querySelector(".app-shell--settings")).not.toBeNull();
      expect(container.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
      expect(container.querySelector(".app-shell--chat")).toBeNull();
      expect(container.querySelector(".app-sidebar")).toBeNull();
      expect(container.querySelector(".app-topbar")).toBeNull();

      await act(async () => {
        useAppStore.getState().closeSettings();
        root?.render(createElement(App));
      });

      expect(useAppStore.getState().view).toBe("chat");
      expect(container.querySelector(".app-shell--settings")).toBeNull();
      expect(container.querySelector(".app-shell--chat")).not.toBeNull();
      expect(container.querySelector(".app-sidebar")).not.toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Escape dismisses pending sandbox approvals for terminal task threads", async () => {
    const harness = setupJsdom();
    const dismissPrompt = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedTerminalTaskApprovalState(dismissPrompt);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(App));
      });

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });

      expect(dismissPrompt).toHaveBeenCalledTimes(1);
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("renders one reconnect banner only after hydration completes", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedDisconnectedChatState(true);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(App));
      });
      expect(container.querySelectorAll('[data-slot="connection-banner"]')).toHaveLength(0);

      await act(async () => {
        useAppStore.setState((state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            "chat-session-1": {
              ...state.threadRuntimeById["chat-session-1"],
              hydrating: false,
            },
          },
        }));
      });

      expect(container.querySelectorAll('[data-slot="connection-banner"]')).toHaveLength(1);
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Escape dismisses pending sandbox approvals while settings overlays task", async () => {
    const harness = setupJsdom();
    const dismissPrompt = mock(() => {});
    const closeSettings = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedTerminalTaskApprovalState(dismissPrompt);
      useAppStore.setState({
        view: "settings",
        lastNonSettingsView: "task",
        closeSettings,
      } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });

      expect(dismissPrompt).toHaveBeenCalledTimes(1);
      expect(closeSettings).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Escape with an open dialog closes just the dialog, not settings", async () => {
    const harness = setupJsdom();
    const closeSettings = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedReadyState();
      useAppStore.setState({
        view: "settings",
        lastNonSettingsView: "chat",
        closeSettings,
      } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      // Simulate an open modal surface (e.g. the Manage models dialog).
      const overlay = harness.dom.window.document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("data-state", "open");
      harness.dom.window.document.body.appendChild(overlay);

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(closeSettings).not.toHaveBeenCalled();

      // A dismissing Radix layer consumes the event; settings must stay put
      // even after the layer has already unmounted.
      overlay.remove();
      await act(async () => {
        const consumed = new harness.dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        });
        consumed.preventDefault();
        harness.dom.window.dispatchEvent(consumed);
      });
      expect(closeSettings).not.toHaveBeenCalled();

      // With no overlay left, Escape closes settings as before.
      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(closeSettings).toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Escape closes settings-over-chat without dismissing hidden task approvals", async () => {
    const harness = setupJsdom();
    const dismissPrompt = mock(() => {});
    const closeSettings = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedTerminalTaskApprovalState(dismissPrompt);
      useAppStore.setState((state) => ({
        view: "settings",
        lastNonSettingsView: "chat",
        selectedTaskId: null,
        selectedThreadId: "chat-session-1",
        threads: [
          ...state.threads,
          {
            id: "chat-session-1",
            workspaceId: "ws-1",
            title: "Ordinary chat",
            createdAt: "2026-04-30T00:00:00.000Z",
            lastMessageAt: "2026-04-30T00:00:00.000Z",
            status: "active",
            sessionId: "chat-session-1",
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
          },
        ],
        closeSettings,
      }));
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });

      expect(dismissPrompt).not.toHaveBeenCalled();
      expect(closeSettings).toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });
});
