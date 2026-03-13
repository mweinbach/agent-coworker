import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

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

type JsdomHarness = {
  dom: JSDOM;
  restore: () => void;
};

function setupJsdom(): JsdomHarness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    actEnv: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return {
    dom,
    restore: () => {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.navigator = saved.navigator;
      globalThis.HTMLElement = saved.HTMLElement;
      globalThis.Node = saved.Node;
      globalThis.getComputedStyle = saved.getComputedStyle;
      globalThis.requestAnimationFrame = saved.requestAnimationFrame;
      globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.actEnv;
      dom.window.close();
    },
  };
}

const { useAppStore } = await import("../src/app/store");
const { ChatView } = await import("../src/ui/ChatView");

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
          transcriptOnly: false,
        },
      },
      composerText: "",
    });

    const harness = setupJsdom();
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
});
