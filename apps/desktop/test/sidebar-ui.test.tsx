import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
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
  lastCheckStartedAt: null,
  downloadedAt: null,
  message: null,
  error: null,
  release: null,
  progress: null,
};

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
  confirmAction: async () => true,
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

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { useAppStore } = await import("../src/app/store");
const { Sidebar } = await import("../src/ui/Sidebar");

const defaultStoreState = useAppStore.getState();

function resetAppStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    ...defaultStoreState,
    ready: true,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    settingsPage: "providers",
    lastNonSettingsView: "chat",
    workspaces: [],
    threads: [],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    workspaceRuntimeById: {},
    threadRuntimeById: {},
    latestTodosByThreadId: {},
    workspaceExplorerById: {},
    promptModal: null,
    notifications: [],
    providerStatusByName: {},
    providerStatusLastUpdatedAt: null,
    providerStatusRefreshing: false,
    providerCatalog: [],
    providerDefaultModelByProvider: {},
    providerConnected: [],
    providerAuthMethodsByProvider: {},
    providerLastAuthChallenge: null,
    providerLastAuthResult: null,
    composerText: "",
    injectContext: false,
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    onboardingVisible: false,
    sidebarCollapsed: false,
    contextSidebarCollapsed: false,
    contextSidebarWidth: 300,
    messageBarHeight: 120,
    sidebarWidth: 248,
    ...overrides,
  } as any);
}

function makeWorkspace() {
  return {
    id: "ws-1",
    name: "Agent Coworker",
    path: "/tmp/agent-coworker",
    createdAt: "2026-03-24T00:00:00.000Z",
    lastOpenedAt: "2026-03-24T00:00:00.000Z",
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
    defaultPreferredChildModel: "gpt-5.4",
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
  };
}

function makeThreads(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const threadNumber = index + 1;

    return {
      id: `thread-${threadNumber}`,
      workspaceId: "ws-1",
      title: `Thread ${threadNumber}`,
      titleSource: "manual" as const,
      createdAt: `2026-03-${String(threadNumber).padStart(2, "0")}T09:00:00.000Z`,
      lastMessageAt: `2026-03-${String(threadNumber).padStart(2, "0")}T10:00:00.000Z`,
      status: "active" as const,
      sessionId: `session-${threadNumber}`,
      messageCount: threadNumber,
      lastEventSeq: threadNumber,
      draft: false,
    };
  });
}

function setupSidebarJsdom() {
  return setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: {
      ResizeObserver: MockResizeObserver,
    },
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

describe("desktop sidebar", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test.serial("expands the selected workspace and caps the visible thread list", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      resetAppStore({
        workspaces: [makeWorkspace()],
        threads: makeThreads(12),
        selectedWorkspaceId: "ws-1",
        selectedThreadId: "thread-12",
      });

      await act(async () => {
        root.render(createElement(Sidebar));
      });

      const visibleThreadRows = Array.from(container.querySelectorAll(".sidebar-thread-item"));
      const visibleThreadTitles = visibleThreadRows.map((row) => {
        const title = row.querySelector(".block.truncate");
        return title?.textContent?.trim() ?? "";
      });

      expect(container.textContent).toContain("Agent Coworker");
      expect(visibleThreadRows).toHaveLength(10);
      expect(visibleThreadTitles.includes("Thread 12")).toBe(true);
      expect(visibleThreadTitles.includes("Thread 3")).toBe(true);
      expect(visibleThreadTitles.includes("Thread 2")).toBe(false);
      expect(visibleThreadTitles.includes("Thread 1")).toBe(false);
      expect(container.textContent).toContain("Show 2 more");

      const collapseButton = container.querySelector('[aria-label="Collapse Agent Coworker"]');
      if (!(collapseButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing collapse button");
      }

      await act(async () => {
        collapseButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).not.toContain("Thread 12");
      expect(container.querySelector('[aria-label="Expand Agent Coworker"]')).not.toBeNull();

    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("switches a thread row into inline rename mode with a focused shared input", async () => {
    const harness = setupSidebarJsdom();
    const selectThread = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      resetAppStore({
        workspaces: [makeWorkspace()],
        threads: makeThreads(3),
        selectedWorkspaceId: "ws-1",
        selectedThreadId: "thread-3",
        selectThread,
      });

      await act(async () => {
        root.render(createElement(Sidebar));
      });

      const threadButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Thread 3"),
      );
      if (!(threadButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing thread row");
      }

      await act(async () => {
        threadButton.dispatchEvent(new harness.dom.window.MouseEvent("dblclick", { bubbles: true }));
      });

      const renameInput = container.querySelector("input");
      if (!(renameInput instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing rename input");
      }

      expect(harness.dom.window.document.activeElement).toBe(renameInput);
      expect(renameInput.value).toBe("Thread 3");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("shows chat navigation and clear workspace scope labels in the sidebar", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      resetAppStore({
        view: "skills",
        workspaces: [makeWorkspace()],
        threads: makeThreads(2),
        selectedWorkspaceId: "ws-1",
        selectedThreadId: "thread-2",
      });

      await act(async () => {
        root.render(createElement(Sidebar));
      });

      expect(container.textContent).toContain("New Chat");
      expect(container.textContent).toContain("Skills");
      expect(container.textContent).toContain("2 sessions");
      expect(container.textContent).toContain("viewing skills");

      const newChatButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("New Chat"),
      );
      if (!(newChatButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing new chat button");
      }
      expect(newChatButton.className).toContain("w-full");

      const skillsButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Skills"),
      );
      if (!(skillsButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing skills button");
      }
      expect(skillsButton.className).toContain("w-full");

      expect(newChatButton.querySelector("svg")?.className.baseVal ?? "").toContain("lucide-square-pen");
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
