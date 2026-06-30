import { describe, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { buildAttachmentSignature } from "../src/app/attachmentInputs";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
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

class MockMutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const requestAnimationFrameMock = (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;

const cancelAnimationFrameMock = (id: number) => clearTimeout(id);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
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
    openExternalUrl: async () => {},
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
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

function setupChatViewJsdom() {
  return setupJsdom({
    includeAnimationFrame: {
      requestAnimationFrame: requestAnimationFrameMock,
      cancelAnimationFrame: cancelAnimationFrameMock,
    },
    extraGlobals: { MutationObserver: MockMutationObserver },
    setupWindow: (dom) => {
      dom.window.requestAnimationFrame = requestAnimationFrameMock;
      dom.window.cancelAnimationFrame = cancelAnimationFrameMock;
      Object.assign(dom.window, { event: undefined });
      if (typeof dom.window.HTMLElement.prototype.attachEvent !== "function") {
        (
          dom.window.HTMLElement.prototype as {
            attachEvent?: (name: string, handler: unknown) => void;
          }
        ).attachEvent = () => {};
      }
      if (typeof dom.window.HTMLElement.prototype.detachEvent !== "function") {
        (
          dom.window.HTMLElement.prototype as {
            detachEvent?: (name: string, handler: unknown) => void;
          }
        ).detachEvent = () => {};
      }
    },
  });
}

const { useAppStore } = await import("../src/app/store");
const { ChatView, countActiveChildAgents } = await import("../src/ui/ChatView");

describe("desktop chat view stability", () => {
  test("shows the universal new chat landing when no thread is selected", async () => {
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: "ws-1",
      selectedThreadId: null,
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          workspaceKind: "project",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          yolo: false,
        },
      ],
      threads: [],
      threadRuntimeById: {},
      providerCatalog: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
              reasoning: { defaultEffort: "high" },
            },
          ],
          defaultModel: "gpt-5.4",
        },
      ],
      providerConnected: ["openai"],
      composerText: "",
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      expect(container.textContent).toContain("What should we work on?");
      expect(container.textContent).toContain("Workspace 1");
      expect(container.textContent).not.toContain("Let's build");
      expect(container.textContent).not.toContain("New thread");
      expect(container.querySelector('[data-slot="select-trigger"]')).not.toBeNull();
      const reasoningToggle = container.querySelector<HTMLButtonElement>(
        '[data-slot="composer-reasoning-toggle"]',
      );
      expect(reasoningToggle?.getAttribute("aria-pressed")).toBe("true");
      await act(async () => {
        reasoningToggle?.click();
      });
      expect(reasoningToggle?.getAttribute("aria-pressed")).toBe("false");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("new chat landing starts a no-project chat on submit", async () => {
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: null,
      selectedThreadId: null,
      workspaces: [],
      threads: [],
      workspaceRuntimeById: {},
      threadRuntimeById: {},
      composerText: "Draft a release note",
      providerDefaultModelByProvider: {},
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const sendButton = container.querySelector(
        'button[aria-label="Send message"]',
      ) as HTMLButtonElement | null;
      expect(sendButton).not.toBeNull();

      await act(async () => {
        sendButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const state = useAppStore.getState();
      const chatWorkspace = state.workspaces.find(
        (workspace) => workspace.workspaceKind === "oneOffChat",
      );
      expect(chatWorkspace).toBeDefined();
      expect(state.threads[0]).toMatchObject({
        workspaceId: chatWorkspace?.id,
        title: "Draft a release note",
        draft: false,
      });
      expect(state.selectedThreadId).toBe(state.threads[0]?.id);
      expect(state.threadRuntimeById[state.threads[0]?.id ?? ""]?.draftComposerProvider).toBe(
        "google",
      );
      expect(state.threadRuntimeById[state.threads[0]?.id ?? ""]?.draftComposerModel).toBeTruthy();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("new chat landing starts a project thread for the selected project", async () => {
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: "ws-1",
      selectedThreadId: null,
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          workspaceKind: "project",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      workspaceRuntimeById: {},
      threadRuntimeById: {},
      composerText: "Plan the onboarding flow",
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const sendButton = container.querySelector(
        'button[aria-label="Send message"]',
      ) as HTMLButtonElement | null;
      expect(sendButton).not.toBeNull();

      await act(async () => {
        sendButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const state = useAppStore.getState();
      expect(state.workspaces).toHaveLength(1);
      expect(state.threads[0]).toMatchObject({
        workspaceId: "ws-1",
        title: "Plan the onboarding flow",
        draft: false,
      });
      expect(state.selectedThreadId).toBe(state.threads[0]?.id);
      expect(state.threadRuntimeById[state.threads[0]?.id ?? ""]?.draftComposerProvider).toBe(
        "openai",
      );
      expect(state.threadRuntimeById[state.threads[0]?.id ?? ""]?.draftComposerModel).toBe(
        "gpt-5.4",
      );
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

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

    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      expect(container.textContent).toContain("Send a message to start.");
      expect(consoleErrors.some((entry) => entry.includes("Maximum update depth exceeded"))).toBe(
        false,
      );
      expect(container.querySelector('[data-slot="message-composer-status"]')).toBeNull();
      expect(container.textContent).not.toContain("Press Enter to send");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      console.error = realError;
      harness.restore();
    }
  });

  test("hides REMOVEDUI surfaces and dock when REMOVEDUI is disabled", async () => {
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "thread-1",
      desktopFeatureFlags: {
        menuBar: true,
        remoteAccess: true,
        workspacePicker: true,
        workspaceLifecycle: true,
        REMOVEDUI: false,
      },
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
          lastMessageAt: "2026-03-12T00:00:30.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 1,
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
          sessionConfig: {
            enableREMOVEDUI: false,
          },
          sessionUsage: null,
          lastTurnUsage: null,
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [
            {
              id: "RemovedSurface:surface-1",
              kind: "REMOVED_SURFACE",
              ts: "2026-03-12T00:00:30.000Z",
              surfaceId: "surface-1",
              catalogId: "https://REMOVEDUI.org/specification/v0_9/basic_catalog.json",
              version: "v0.9",
              revision: 1,
              deleted: false,
              root: {
                id: "root",
                type: "Text",
                text: "REMOVEDUI content",
              },
            },
          ],
          pendingSteer: null,
          transcriptOnly: false,
        },
      },
      composerText: "",
    } as any);

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      expect(container.textContent).toContain("Send a message to start.");
      expect(container.textContent).not.toContain("surface-1");
      expect(container.textContent).not.toContain("REMOVEDUI content");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("shows the active session model as a read-only footer indicator even after messages exist", async () => {
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
          lastMessageAt: "2026-03-12T00:00:30.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 1,
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          wsUrl: null,
          connected: true,
          sessionId: "session-1",
          config: {
            provider: "openai",
            model: "gpt-5.4-session-lock",
          },
          sessionConfig: null,
          sessionUsage: null,
          lastTurnUsage: null,
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [
            {
              id: "msg-1",
              kind: "message",
              role: "assistant",
              ts: "2026-03-12T00:00:30.000Z",
              text: "Existing reply",
            },
          ],
          pendingSteer: null,
          transcriptOnly: false,
        },
      },
      composerText: "",
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      expect(container.textContent).toContain("Existing reply");
      const attachButton = container.querySelector('[aria-label="Attach files"]');
      const modelIndicator = container.querySelector('[title="OpenAI / gpt-5.4-session-lock"]');
      const toolsRow = attachButton?.parentElement;
      const footer = toolsRow?.parentElement;

      expect(attachButton).not.toBeNull();
      expect(modelIndicator?.textContent).toContain("gpt-5.4-session-lock");
      expect(toolsRow?.className).not.toContain("overflow-hidden");
      expect(footer?.className).toContain("flex-wrap");
      expect(container.querySelector('[data-slot="select-trigger"]')).toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("keeps the message bar resize rail invisible and exposes minimum-height semantics", async () => {
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
      messageBarHeight: 144,
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const separator = container.querySelector('[aria-label="Resize minimum message bar height"]');
      const composerShell = separator?.parentElement;
      const reservedSpace = container.querySelector(
        '[data-slot="message-bar-reserved-space"]',
      ) as HTMLElement | null;
      const overlay = container.querySelector(
        '[data-slot="message-bar-overlay"]',
      ) as HTMLElement | null;

      expect(separator).not.toBeNull();
      expect(separator?.className).toContain("-top-1");
      expect(separator?.className).toContain("h-3");
      expect(separator?.className).not.toContain("hover:bg-border/80");
      expect(separator?.getAttribute("tabindex")).toBe("0");
      expect(separator?.getAttribute("aria-valuenow")).toBe("144");
      expect(separator?.getAttribute("aria-valuetext")).toBe("Minimum height 144 pixels");
      expect(composerShell?.className).not.toContain("border-t");
      expect(reservedSpace?.style.height).toBe("140px");
      expect(overlay?.style.minHeight).toBe("140px");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("keeps the scroll-to-bottom affordance above the absolute composer", async () => {
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
          lastMessageAt: "2026-03-12T00:00:30.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 1,
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
          feed: [
            {
              id: "msg-1",
              kind: "message",
              role: "assistant",
              ts: "2026-03-12T00:00:30.000Z",
              text: "Existing reply",
            },
          ],
          pendingSteer: null,
          transcriptOnly: false,
        },
      },
      composerText: "",
      messageBarHeight: 120,
    });

    const harness = setupChatViewJsdom();
    const originalGetBoundingClientRect =
      harness.dom.window.HTMLElement.prototype.getBoundingClientRect;
    harness.dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
      this: HTMLElement,
    ) {
      if (this.getAttribute("data-slot") === "message-bar-overlay") {
        return {
          bottom: 220,
          height: 220,
          left: 0,
          right: 600,
          toJSON: () => ({}),
          top: 0,
          width: 600,
          x: 0,
          y: 0,
        } as DOMRect;
      }
      if (this.getAttribute("data-slot") === "message-scroller-viewport") {
        return {
          bottom: 400,
          height: 400,
          left: 0,
          right: 600,
          toJSON: () => ({}),
          top: 0,
          width: 600,
          x: 0,
          y: 0,
        } as DOMRect;
      }
      if (this.getAttribute("data-slot") === "message-scroller-item") {
        const viewport = this.closest('[data-slot="message-scroller-viewport"]') as HTMLElement;
        const isComposerClearance = this.querySelector('[data-slot="message-bar-reserved-space"]');
        const height = isComposerClearance ? 220 : 800;
        const top = (isComposerClearance ? 800 : 0) - (viewport?.scrollTop ?? 0);
        return {
          bottom: top + height,
          height,
          left: 0,
          right: 600,
          toJSON: () => ({}),
          top,
          width: 600,
          x: 0,
          y: top,
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const feed = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      const reservedSpace = container.querySelector(
        '[data-slot="message-bar-reserved-space"]',
      ) as HTMLElement | null;
      if (!feed) throw new Error("missing feed");
      expect(reservedSpace?.style.height).toBe("220px");

      Object.defineProperty(feed, "clientHeight", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(feed, "scrollHeight", {
        configurable: true,
        value: 1020,
      });
      Object.defineProperty(feed, "scrollTop", {
        configurable: true,
        value: 100,
        writable: true,
      });
      Object.defineProperty(feed, "scrollTo", {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          feed.scrollTop = top ?? feed.scrollTop;
        },
      });

      await act(async () => {
        feed.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const scrollButton = container.querySelector(
        '[aria-label="Scroll to end"]',
      ) as HTMLButtonElement | null;
      expect(scrollButton).not.toBeNull();
      expect(scrollButton?.dataset.active).toBe("true");
      expect(scrollButton?.style.bottom).toBe("234px");

      await act(async () => {
        scrollButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(feed.scrollTop).toBe(620);
      expect(
        container.querySelector('[aria-label="Scroll to end"]')?.getAttribute("data-active"),
      ).toBe("false");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("does not repin a completed thread after a user scrolls upward", async () => {
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
          workspaceKind: "project",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "Completed thread",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:01:00.000Z",
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          status: "connected",
          sessionKind: "chat",
          title: "Completed thread",
          config: { provider: "openai", model: "gpt-5.4" },
          sessionConfig: null,
          busy: false,
          busySince: null,
          feed: [
            {
              id: "msg-1",
              kind: "message",
              role: "assistant",
              ts: "2026-03-12T00:00:30.000Z",
              text: "Completed reply",
            },
          ],
          pendingSteer: null,
          transcriptOnly: false,
        },
      },
      composerText: "",
      messageBarHeight: 120,
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const feed = container.querySelector(
        '[data-slot="message-scroller-viewport"]',
      ) as HTMLElement | null;
      if (!feed) throw new Error("missing feed");

      Object.defineProperty(feed, "clientHeight", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(feed, "scrollHeight", {
        configurable: true,
        value: 1000,
      });
      Object.defineProperty(feed, "scrollTop", {
        configurable: true,
        value: 1000,
        writable: true,
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      feed.scrollTop = 500;

      await act(async () => {
        feed.dispatchEvent(new harness.dom.window.Event("wheel", { bubbles: true }));
        feed.dispatchEvent(new harness.dom.window.Event("scroll", { bubbles: true }));
      });

      await act(async () => {
        useAppStore.setState({ composerText: "draft after reading" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(feed.scrollTop).toBe(500);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("shows the draft model selector with its reasoning toggle before the first message", async () => {
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
          defaultProvider: "openai",
          defaultModel: "gpt-5.2-draft-default",
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "New thread",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastMessageAt: "2026-03-12T00:00:00.000Z",
          status: "active",
          sessionId: null,
          lastEventSeq: 0,
          draft: true,
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          wsUrl: null,
          connected: false,
          sessionId: null,
          config: null,
          sessionConfig: null,
          sessionUsage: null,
          lastTurnUsage: null,
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [],
          pendingSteer: null,
          transcriptOnly: false,
          draftComposerProvider: null,
          draftComposerModel: null,
        },
      },
      providerCatalog: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              id: "gpt-5.2-draft-default",
              displayName: "GPT-5.2 Draft Default",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
              reasoning: { defaultEffort: "high" },
            },
          ],
          defaultModel: "gpt-5.2-draft-default",
        },
      ],
      providerConnected: ["openai"],
      composerText: "",
    });

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      expect(container.textContent).toContain("Send a message to start.");
      const modelSelector = container.querySelector('[data-slot="select-trigger"]');
      expect(modelSelector).not.toBeNull();
      const reasoningToggle = container.querySelector<HTMLButtonElement>(
        '[data-slot="composer-reasoning-toggle"]',
      );
      expect(reasoningToggle?.getAttribute("aria-pressed")).toBe("true");
      await act(async () => {
        reasoningToggle?.click();
      });
      expect(useAppStore.getState().threadRuntimeById["thread-1"]?.composerReasoningEffort).toBe(
        "none",
      );
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
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
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      expect(container.textContent).toContain("Loading thread");
      expect(container.textContent).not.toContain("Send a message to start.");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("annotated assistant messages use citation chips instead of the footer sources carousel", async () => {
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
          lastMessageAt: "2026-03-12T00:00:30.000Z",
          status: "active",
          sessionId: "session-1",
          lastEventSeq: 2,
        },
      ],
      threadRuntimeById: {
        "thread-1": {
          wsUrl: null,
          connected: true,
          sessionId: "session-1",
          config: {
            provider: "google",
            model: "gemini-3.1-pro-preview",
          },
          sessionConfig: null,
          sessionUsage: null,
          lastTurnUsage: null,
          enableMcp: true,
          busy: false,
          busySince: null,
          feed: [
            {
              id: "tool-1",
              kind: "tool",
              name: "nativeWebSearch",
              state: "completed",
              result: {
                action: {
                  type: "search",
                  query: "laguardia crash",
                  sources: [
                    { title: "Collision Report", url: "https://example.com/collision" },
                    { title: "Safety Memo", url: "https://example.com/safety" },
                  ],
                },
              },
            },
            {
              id: "msg-1",
              kind: "message",
              role: "assistant",
              ts: "2026-03-12T00:00:30.000Z",
              text: "* **The Collision:** Plane hit a truck.",
              annotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: "The Collision: Plane hit a truck.".length,
                  title: "Collision Report",
                  url: "https://example.com/collision",
                },
              ],
            },
          ],
          pendingSteer: null,
          transcriptOnly: false,
        },
      },
      composerText: "",
    } as any);

    const harness = setupChatViewJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const chipButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Collision Report"),
      );
      expect(chipButton).not.toBeNull();
      expect(container.textContent).not.toContain("Sources");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
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

    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const textarea = container.querySelector("textarea");
      expect(textarea?.hasAttribute("disabled")).toBe(false);
      const stopButton = container.querySelector('[aria-label="Stop generating response"]');
      expect(stopButton).not.toBeNull();
      expect(stopButton?.className).toContain("bg-destructive");
      const statusRow = container.querySelector('[data-slot="message-composer-status"]');
      expect(statusRow).not.toBeNull();
      expect(statusRow?.textContent).toContain("Type to steer, or use stop to cancel.");

      await act(async () => {
        useAppStore.setState({ composerText: "tighten scope" });
      });

      expect(container.querySelector('[aria-label="Stop generating response"]')).toBeNull();
      const steerButton = container.querySelector('[aria-label="Steer current response"]');
      expect(steerButton).not.toBeNull();
      expect(steerButton?.className).toContain("bg-warning");
      const steerRow = container.querySelector('[data-slot="message-composer-status"]');
      expect(steerRow?.textContent).toContain(
        "Steer ready. Press Enter to inject it into the current run.",
      );

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
      const pendingRow = container.querySelector('[data-slot="message-composer-status"]');
      expect(pendingRow?.textContent).toContain(
        "Steer sent. Waiting for the running turn to accept it.",
      );

      await act(async () => {
        useAppStore.setState((state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            "thread-1": {
              ...state.threadRuntimeById["thread-1"]!,
              busy: false,
              pendingSteer: null,
            },
          },
        }));
      });

      const sendButton = container.querySelector('[aria-label="Send message"]');
      expect(sendButton).not.toBeNull();
      expect(sendButton?.className).toContain("bg-primary");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("busy composer keeps minimum-height separator semantics when attachments make the shell grow", async () => {
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
          threadIds: ["thread-1"],
          settings: {},
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          title: "Busy attachments",
          status: "active",
          updatedAt: "2026-03-12T00:00:00.000Z",
          model: "gpt-5.4",
          provider: "openai",
          mcpServers: [],
          draft: false,
          plannerEnabled: false,
          effort: "medium",
          reasoningSummary: "auto",
        },
      ],
      threadRuntimeById: {
        "thread-1": {
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
      messageBarHeight: 120,
    });

    const harness = setupChatViewJsdom();

    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!fileInput) throw new Error("missing file input");

      const fakeFile = {
        name: "diagram.png",
        type: "image/png",
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as File;
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [fakeFile],
      });

      await act(async () => {
        fileInput.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
        await Promise.resolve();
      });

      expect(container.textContent).toContain("diagram.png");
      expect(
        container.querySelector('[data-slot="message-composer-status"]')?.textContent,
      ).toContain("Steer ready. Press Enter to inject it into the current run.");
      const steerButton = container.querySelector('[aria-label="Steer current response"]');
      expect(steerButton).not.toBeNull();
      expect(steerButton?.hasAttribute("disabled")).toBe(false);

      const separator = container.querySelector('[aria-label="Resize minimum message bar height"]');
      expect(separator?.getAttribute("aria-valuenow")).toBe("120");
      expect(separator?.getAttribute("aria-valuetext")).toBe("Minimum height 120 pixels");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("keeps attachment-only steers pending until acceptance, then clears them", async () => {
    const originalState = useAppStore.getState();
    let submittedAttachmentSignature = "";

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
      sendMessage: async (
        text: string,
        busyPolicy?: "reject" | "steer",
        attachments?: Array<{ filename: string; contentBase64: string; mimeType: string }>,
      ) => {
        expect(text).toBe("");
        expect(busyPolicy).toBe("steer");
        submittedAttachmentSignature = buildAttachmentSignature(attachments);
        return true;
      },
    } as any);

    const harness = setupChatViewJsdom();

    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(ChatView)));
      });

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
      const form = container.querySelector("form");
      if (!fileInput || !form) throw new Error("missing composer controls");

      const fakeFile = {
        name: "diagram.png",
        type: "image/png",
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as File;
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [fakeFile],
      });

      await act(async () => {
        fileInput.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
        await Promise.resolve();
      });

      expect(container.textContent).toContain("diagram.png");

      await act(async () => {
        form.dispatchEvent(
          new harness.dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });

      expect(submittedAttachmentSignature).not.toBe("");
      expect(container.textContent).toContain("diagram.png");

      await act(async () => {
        useAppStore.setState((state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            "thread-1": {
              ...state.threadRuntimeById["thread-1"]!,
              pendingSteer: {
                clientMessageId: "cmid-attachment-steer",
                text: "",
                attachmentSignature: submittedAttachmentSignature,
                status: "sending",
              },
            },
          },
        }));
        await Promise.resolve();
      });

      const pendingSteerButton = container.querySelector(
        'button[aria-label="Steer current response"]',
      );
      expect(pendingSteerButton).not.toBeNull();
      expect((pendingSteerButton as HTMLButtonElement | null)?.disabled).toBe(true);
      expect(container.textContent).toContain(
        "Steer sent. Waiting for the running turn to accept it.",
      );

      await act(async () => {
        useAppStore.setState((state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            "thread-1": {
              ...state.threadRuntimeById["thread-1"]!,
              pendingSteer: {
                ...state.threadRuntimeById["thread-1"]!.pendingSteer!,
                status: "accepted",
              },
            },
          },
        }));
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain("diagram.png");
      expect(container.querySelector('[aria-label="Stop generating response"]')).not.toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(originalState as any);
      harness.restore();
    }
  });

  test("counts only active child agents for stop-scope decisions", () => {
    expect(
      countActiveChildAgents([
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
      ]),
    ).toBe(1);
  });
});
