import { describe, expect, mock, test } from "bun:test";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "./jsdomHarness";

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};
const MOCK_UPDATE_STATE = {
  phase: "idle",
  currentVersion: "0.1.0",
  packaged: false,
  lastCheckedAt: null,
  release: null,
  progress: null,
  error: null,
};

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
  showContextMenu: async () => null,
  windowMinimize: async () => {},
  windowMaximize: async () => {},
  windowClose: async () => {},
  getPlatform: async () => "linux",
  readFile: async () => "",
  previewOSFile: async () => {},
  openPath: async () => {},
  revealPath: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  renamePath: async () => {},
  trashPath: async () => {},
  confirmAction: async () => true,
  showNotification: async () => true,
  getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
  setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
  getUpdateState: async () => MOCK_UPDATE_STATE,
  checkForUpdates: async () => {},
  quitAndInstallUpdate: async () => {},
  onSystemAppearanceChanged: () => () => {},
  onMenuCommand: () => () => {},
  onUpdateStateChanged: () => () => {},
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {
    connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

function setupChatViewJsdom() {
  return setupJsdom({
    includeAnimationFrame: {
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
      cancelAnimationFrame: (id: number) => clearTimeout(id),
    },
    setupWindow: (dom) => {
      if (typeof dom.window.HTMLElement.prototype.attachEvent !== "function") {
        (dom.window.HTMLElement.prototype as { attachEvent?: (name: string, handler: unknown) => void }).attachEvent = () => {};
      }
      if (typeof dom.window.HTMLElement.prototype.detachEvent !== "function") {
        (dom.window.HTMLElement.prototype as { detachEvent?: (name: string, handler: unknown) => void }).detachEvent = () => {};
      }
    },
  });
}


const { useAppStore } = await import("../src/app/store");
const { ChatView, countActiveChildAgents } = await import("../src/ui/ChatView");

describe("desktop chat view stability", () => {
  test("does not loop when citation overflow state is empty", async () => {
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "thread-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "Thread 1",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastMessageAt: "2026-03-12T00:00:00.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 0,
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          wsUrl: null,
          connected: true,
          sessionId: "session-1",
          config: {
            provider: "openai",
            model: "gpt-5.4",
          },
          sessionConfig: null,
          sessionUsage: null,
          lastTurnUsage: null,
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [],
          pendingSteer: null,
          transcriptOnly: false,
        },
      },
      composerText: "",
    });

    const harness = setupChatViewJsdom();
    const realError = console.error;
    const consoleErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(ChatView),
          ),
        );
      });

      expect(container.textContent).toContain("Thread 1");
      expect(consoleErrors.some((entry) => entry.includes("Maximum update depth exceeded"))).toBe(false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      console.error = realError;
      harness.restore();
    }
  });

  test("shows a loading state while the selected startup thread is still hydrating", async () => {
    useAppStore.setState({
      ready: true,
      bootstrapPending: false,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "thread-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "Existing thread",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastMessageAt: "2026-03-12T00:01:00.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 0,
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          wsUrl: null,
          connected: false,
          sessionId: null,
          config: null,
          sessionConfig: null,
          sessionKind: null,
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
          pendingSteer: null,
          feed: [],
          hydrating: true,
          transcriptOnly: false,
        },
      },
      composerText: "",
    });

    const harness = setupChatViewJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(ChatView),
          ),
        );
      });

      expect(container.textContent).toContain("Existing thread");
      expect(container.textContent).toContain("Loading thread");
      expect(container.textContent).not.toContain("Send a message to start.");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("busy composer stays editable and swaps between stop and send based on draft text", async () => {
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "thread-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "Thread 1",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastMessageAt: "2026-03-12T00:00:00.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 0,
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          wsUrl: null,
          connected: true,
          sessionId: "session-1",
          config: {
            provider: "openai",
            model: "gpt-5.4",
          },
          sessionConfig: null,
          sessionUsage: null,
          lastTurnUsage: null,
          enableMcp: true,
          busy: true,
          busySince: "2026-03-12T00:00:05.000Z",
          feed: [],
          pendingSteer: null,
          transcriptOnly: false,
          activeTurnId: "turn-1",
        },
      },
      composerText: "",
    });

    const harness = setupChatViewJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const textarea = container.querySelector("textarea");
      expect(textarea?.hasAttribute("disabled")).toBe(false);
      expect(container.querySelector('[aria-label="Stop generating response"]')).not.toBeNull();

      await act(async () => {
        useAppStore.setState({ composerText: "tighten scope" });
      });

      expect(container.querySelector('[aria-label="Stop generating response"]')).toBeNull();
      expect(container.querySelector('[aria-label="Steer current response"]')).not.toBeNull();
      expect(container.textContent).toContain("Steer ready. Press Enter to inject it into the current run.");

      await act(async () => {
        useAppStore.setState((state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            "thread-1": {
              ...state.threadRuntimeById["thread-1"]!,
              pendingSteer: {
                clientMessageId: "cmid-1",
                text: "tighten scope",
                status: "sending",
              },
            },
          },
        }));
      });

      expect(container.querySelector('[aria-label="Steer current response"]')).not.toBeNull();
      expect(container.textContent).toContain("Steer sent. Waiting for the running turn to accept it.");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("counts only active child agents for stop-scope decisions", () => {
    expect(countActiveChildAgents([
      {
        agentId: "agent-running",
        parentSessionId: "session-1",
        role: "worker",
        mode: "delegate",
        depth: 1,
        title: "Running worker",
        provider: "openai",
        effectiveModel: "gpt-5.4-mini",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:05.000Z",
        lifecycleState: "active",
        executionState: "running",
        busy: true,
      },
      {
        agentId: "agent-complete",
        parentSessionId: "session-1",
        role: "worker",
        mode: "delegate",
        depth: 1,
        title: "Completed worker",
        provider: "openai",
        effectiveModel: "gpt-5.4-mini",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:05.000Z",
        lifecycleState: "active",
        executionState: "completed",
        busy: false,
      },
      {
        agentId: "agent-closed",
        parentSessionId: "session-1",
        role: "worker",
        mode: "delegate",
        depth: 1,
        title: "Closed worker",
        provider: "openai",
        effectiveModel: "gpt-5.4-mini",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:05.000Z",
        lifecycleState: "closed",
        executionState: "closed",
        busy: false,
      },
    ])).toBe(1);
  });
});
