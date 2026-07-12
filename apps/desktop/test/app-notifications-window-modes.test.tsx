import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useState } from "react";
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
const { CommandPalette } = await import("../src/ui/CommandPalette");
const { requestDesktopRailCommand } = await import("../src/lib/desktopRailCommands");
const { OverlayStackProvider } = await import("../src/ui/OverlayStack");

const defaultStoreState = useAppStore.getState();

function seedReadyState(audience: "foreground" | "background" = "foreground") {
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
    filePreview: null,
    lmStudioStartModal: null,
    onboardingVisible: false,
    workspaces: [],
    threads: [],
    notifications: [
      {
        id: "n-1",
        kind: "info",
        title: "Heads up",
        detail: "Popup test",
        ts: "2026-04-30T00:00:00.000Z",
        audience,
      },
    ],
  });
}

function seedTerminalTaskApprovalState(dismissPrompt: () => void) {
  const now = "2026-04-30T00:00:00.000Z";
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
    onboardingVisible: false,
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
    interactionsByThread: {
      "task-session-1": [
        {
          kind: "approval",
          approvalKind: "sandbox",
          requestId: "approval-1",
          command: "curl https://example.com",
          dangerous: true,
          reasonCode: "sandbox_denied_escalation",
          detail: "The OS sandbox blocked network access for this command.",
          category: "network",
          receivedSequence: 1,
          status: "pending",
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
    bootstrapPhase: "ready",
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
        status: "disconnected",
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

function seedBusyChatState(cancelThread: () => void) {
  const now = "2026-04-30T00:00:00.000Z";
  useAppStore.setState({
    ...useAppStore.getState(),
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
    onboardingVisible: false,
    filePreview: null,
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
    threads: [
      {
        id: "chat-session-1",
        workspaceId: "ws-1",
        title: "Busy chat",
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
        connected: true,
        hydrating: false,
        busy: true,
        feed: [],
      },
    },
    cancelThread,
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
      seedReadyState("background");
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

  test("main window keeps foreground notifications in-app", async () => {
    const harness = setupJsdom();

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

  test("main window forwards background notifications while unfocused", async () => {
    const harness = setupJsdom();

    try {
      Object.defineProperty(harness.dom.window.document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      Object.defineProperty(harness.dom.window.document, "hasFocus", {
        configurable: true,
        value: () => false,
      });
      seedReadyState("background");
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

  test("main window keeps background notifications in-app while focused", async () => {
    const harness = setupJsdom();

    try {
      Object.defineProperty(harness.dom.window.document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      Object.defineProperty(harness.dom.window.document, "hasFocus", {
        configurable: true,
        value: () => true,
      });
      seedReadyState("background");
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

  test("settings handles sidebar commands with its local narrow navigation drawer", async () => {
    const harness = setupJsdom();
    const toggleSidebar = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      Object.defineProperty(harness.dom.window, "innerWidth", {
        configurable: true,
        value: 680,
        writable: true,
      });
      seedReadyState();
      useAppStore.setState({ view: "settings", toggleSidebar } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(App));
      });
      const navigation = container.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Settings navigation"]',
      );
      expect(navigation?.getAttribute("aria-hidden")).toBe("true");

      await act(async () => requestDesktopRailCommand("toggle-sidebar"));

      expect(navigation?.hasAttribute("aria-hidden")).toBe(false);
      expect(navigation?.hasAttribute("inert")).toBe(false);
      expect(toggleSidebar).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => root?.unmount());
      }
      harness.restore();
    }
  });

  test("bare Escape does not deny inline sandbox approvals", async () => {
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

      expect(dismissPrompt).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("busy run plus command palette dismisses only the palette", async () => {
    const harness = setupJsdom();
    const cancelThread = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedBusyChatState(cancelThread);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      function BusyCommandPalette() {
        const [open, setOpen] = useState(true);
        return createElement(
          OverlayStackProvider,
          null,
          createElement(CommandPalette, { open, onOpenChange: setOpen }),
        );
      }

      await act(async () => root?.render(createElement(BusyCommandPalette)));
      const commandInput = harness.dom.window.document.querySelector('[data-slot="command-input"]');
      if (!(commandInput instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing command palette input");
      }
      await act(async () => {
        commandInput.dispatchEvent(
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
      expect(cancelThread).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });

  test("busy run plus file preview dismisses only the preview", async () => {
    const harness = setupJsdom();
    const cancelThread = mock(() => {});
    const closeFilePreview = mock(async () => {
      useAppStore.setState({ filePreview: null });
      return true;
    });
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedBusyChatState(cancelThread);
      useAppStore.setState({
        filePreview: { path: "/tmp/escape-test.txt" },
        closeFilePreview,
      } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => root?.render(createElement(App)));
      const preview = harness.dom.window.document.querySelector('[data-slot="dialog-content"]');
      if (!(preview instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing file preview");
      }

      await act(async () => {
        preview.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });

      expect(closeFilePreview).toHaveBeenCalledTimes(1);
      expect(cancelThread).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });

  test("queued asks ignore composing, editable, and bare Escape until explicitly answered", async () => {
    const harness = setupJsdom();
    const cancelThread = mock(() => {});
    const answerAsk = mock(() => true);
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedBusyChatState(cancelThread);
      useAppStore.setState({
        answerAsk,
        interactionsByThread: {
          "chat-session-1": [
            {
              kind: "ask",
              requestId: "ask-editable",
              receivedSequence: 1,
              status: "pending",
              question: "Continue editing?",
              options: [],
            },
          ],
        },
      } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => root?.render(createElement(App)));
      const input = harness.dom.window.document.querySelector('input[aria-label="Answer"]');
      if (!(input instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing queued ask input");
      }
      input.focus();

      for (const isComposing of [true, false]) {
        const editableEscape = new harness.dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        });
        Object.defineProperty(editableEscape, "isComposing", { value: isComposing });
        await act(async () => {
          input.dispatchEvent(editableEscape);
        });
      }

      input.blur();
      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });

      expect(answerAsk).not.toHaveBeenCalled();
      expect(cancelThread).not.toHaveBeenCalled();
      const skip = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Skip",
      );
      if (!skip) throw new Error("missing queued ask Skip action");
      await act(async () => {
        skip.click();
      });
      expect(answerAsk).toHaveBeenCalledTimes(1);
      expect(answerAsk).toHaveBeenCalledWith("chat-session-1", "ask-editable", "[skipped]");
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.restore();
    }
  });

  test("bare Escape never stops a busy run while Control+Period does", async () => {
    const harness = setupJsdom();
    const cancelThread = mock(() => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedBusyChatState(cancelThread);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => root?.render(createElement(App)));
      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });
      expect(cancelThread).not.toHaveBeenCalled();

      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            key: ".",
          }),
        );
      });
      expect(cancelThread).toHaveBeenCalledTimes(1);
    } finally {
      if (root) await act(async () => root?.unmount());
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

  test("leaves terminal task recovery to its Reopen action without a reconnect banner", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedTerminalTaskApprovalState(() => {});
      useAppStore.setState({
        interactionsByThread: {},
        threadRuntimeById: {
          "task-session-1": {
            wsUrl: null,
            connected: false,
            sessionId: "task-session-1",
            config: null,
            sessionConfig: null,
            sessionKind: "chat",
            parentSessionId: null,
            role: null,
            mode: null,
            depth: 0,
            nickname: null,
            requestedModel: null,
            effectiveModel: null,
            requestedReasoningEffort: null,
            effectiveReasoningEffort: null,
            executionState: null,
            lastMessagePreview: null,
            agents: [],
            sessionUsage: null,
            lastTurnUsage: null,
            enableMcp: null,
            busy: false,
            busySince: null,
            activeTurnId: null,
            pendingTurnStart: null,
            pendingSteer: null,
            feed: [],
            hydrating: false,
            transcriptOnly: false,
          },
        },
      } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(App));
      });

      expect(container.querySelectorAll('[data-slot="connection-banner"]')).toHaveLength(0);
      expect(container.textContent).toContain("Reopen task");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Escape closes settings without denying an inline task approval", async () => {
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

      expect(dismissPrompt).not.toHaveBeenCalled();
      expect(closeSettings).toHaveBeenCalledTimes(1);
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Escape honors composing settings overlays before closing settings", async () => {
    const harness = setupJsdom();
    const closeSettings = mock(() => {});
    const closeFilePreview = mock(async () => {
      useAppStore.setState({ filePreview: null });
      return true;
    });
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      seedReadyState();
      useAppStore.setState({
        view: "settings",
        lastNonSettingsView: "chat",
        settingsPage: "models",
        closeSettings,
        filePreview: { path: "/tmp/settings-overlay-test.txt" },
        closeFilePreview,
      } as never);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(App));
      });

      await act(
        () =>
          new Promise<void>((resolve) => {
            harness.dom.window.requestAnimationFrame(() => resolve());
          }),
      );
      const settingsDialog = harness.dom.window.document.querySelector(
        '[data-slot="dialog-content"][data-state="open"]',
      );
      if (!(settingsDialog instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing settings dialog");
      }
      const composingEscape = new harness.dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      });
      Object.defineProperty(composingEscape, "isComposing", { value: true });
      await act(async () => {
        settingsDialog.dispatchEvent(composingEscape);
      });
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).not.toBeNull();
      expect(closeSettings).not.toHaveBeenCalled();
      expect(closeFilePreview).not.toHaveBeenCalled();

      await act(async () => {
        settingsDialog.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await new Promise<void>((resolve) => {
          harness.dom.window.requestAnimationFrame(() => resolve());
        });
      });
      expect(
        harness.dom.window.document.querySelector(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      ).toBeNull();
      expect(closeSettings).not.toHaveBeenCalled();
      expect(closeFilePreview).toHaveBeenCalledTimes(1);

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
