import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

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
  lastCheckStartedAt: null,
  downloadedAt: null,
  message: null,
  error: null,
  release: null,
  progress: null,
};
let workspacePickerEnabled = true;
let workspaceLifecycleEnabled = true;

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
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
    getDesktopFeatureFlags: () => ({
      menuBar: true,
      remoteAccess: true,
      workspacePicker: workspacePickerEnabled,
      workspaceLifecycle: workspaceLifecycleEnabled,
      a2ui: false,
    }),
    checkForUpdates: async () => {},
    quitAndInstallUpdate: async () => {},
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
  }),
);

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
    desktopFeatureFlags: {
      menuBar: true,
      remoteAccess: true,
      workspacePicker: workspacePickerEnabled,
      workspaceLifecycle: workspaceLifecycleEnabled,
      a2ui: false,
    },
    onboardingVisible: false,
    sidebarCollapsed: false,
    contextSidebarCollapsed: false,
    contextSidebarWidth: 300,
    messageBarHeight: 120,
    sidebarWidth: 248,
    ...overrides,
  } as any);
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    name: "Agent Coworker",
    path: "/tmp/agent-coworker",
    workspaceKind: "project",
    createdAt: "2026-03-24T00:00:00.000Z",
    lastOpenedAt: "2026-03-24T00:00:00.000Z",
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
    defaultPreferredChildModel: "gpt-5.4",
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
    ...overrides,
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
    workspacePickerEnabled = true;
    workspaceLifecycleEnabled = true;
    useAppStore.setState(defaultStoreState);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreState);
  });

  test.serial(
    "expands the selected workspace and caps the compact visible thread list",
    async () => {
      const harness = setupSidebarJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          resetAppStore({
            workspaces: [makeWorkspace()],
            threads: makeThreads(12),
            selectedWorkspaceId: "ws-1",
            selectedThreadId: "thread-12",
          });
          root.render(createElement(Sidebar));
        });

        const visibleThreadRows = Array.from(container.querySelectorAll(".sidebar-thread-item"));
        const visibleThreadTitles = visibleThreadRows.map((row) => {
          const title = row.querySelector(".block.truncate");
          return title?.textContent?.trim() ?? "";
        });

        expect(container.textContent).toContain("Agent Coworker");
        expect(visibleThreadRows).toHaveLength(5);
        expect(visibleThreadTitles.includes("Thread 12")).toBe(true);
        expect(visibleThreadTitles.includes("Thread 8")).toBe(true);
        expect(visibleThreadTitles.includes("Thread 7")).toBe(false);
        expect(visibleThreadTitles.includes("Thread 1")).toBe(false);
        expect(container.textContent).toContain("Show 7 more");

        const collapseButton = container.querySelector('[aria-label="Collapse Agent Coworker"]');
        if (!(collapseButton instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing collapse button");
        }

        await act(async () => {
          collapseButton.dispatchEvent(
            new harness.dom.window.MouseEvent("click", { bubbles: true }),
          );
        });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
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
    },
  );

  test.serial("keeps long chat titles clipped inside the sidebar", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [makeWorkspace()],
          threads: [
            {
              ...makeThreads(1)[0],
              title:
                "This is a very long chat title that should never make the left sidebar horizontally scroll",
            },
          ],
          selectedWorkspaceId: "ws-1",
          selectedThreadId: "thread-1",
        });
        root.render(createElement(Sidebar));
      });

      const sidebar = container.querySelector(".app-sidebar");
      const scroller = container.querySelector("section");
      const threadRow = container.querySelector(".sidebar-thread-item");
      const threadRowWrapper = threadRow?.parentElement;
      const title = threadRow?.querySelector(".block.truncate");

      expect(sidebar?.className).toContain("overflow-hidden");
      expect(sidebar?.className).toContain("min-w-0");
      expect(scroller?.className).toContain("overflow-x-hidden");
      expect(scroller?.className).toContain("min-w-0");
      expect(threadRowWrapper?.className).toContain("min-w-0");
      expect(title?.className).toContain("truncate");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("groups one-off chats separately from project workspaces", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [
            makeWorkspace(),
            makeWorkspace({
              id: "chat-ws-1",
              name: "Hidden one-off workspace",
              path: "/tmp/cowork-chat-1",
              workspaceKind: "oneOffChat",
            }),
          ],
          threads: [
            ...makeThreads(1),
            {
              id: "chat-thread-1",
              workspaceId: "chat-ws-1",
              title: "Loose idea",
              titleSource: "manual" as const,
              createdAt: "2026-03-24T00:00:00.000Z",
              lastMessageAt: "2026-03-24T12:00:00.000Z",
              status: "active" as const,
              sessionId: "chat-session-1",
              messageCount: 1,
              lastEventSeq: 1,
              draft: false,
            },
          ],
          selectedWorkspaceId: "chat-ws-1",
          selectedThreadId: "chat-thread-1",
        });
        root.render(createElement(Sidebar));
      });

      expect(container.textContent).toContain("Chats");
      expect(container.textContent).toContain("Loose idea");
      expect(container.textContent).toContain("Projects");
      expect(container.textContent).toContain("Agent Coworker");
      expect(container.textContent).not.toContain("Hidden one-off workspace");
      expect(
        Array.from(container.querySelectorAll("[data-sidebar-section]")).map((section) =>
          section.getAttribute("data-sidebar-section"),
        ),
      ).toEqual(["projects", "chats"]);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("honors the persisted Chats-above-Projects sidebar section order", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          desktopSettings: {
            ...defaultStoreState.desktopSettings,
            sidebarSectionOrder: ["chats", "projects"],
          },
          workspaces: [
            makeWorkspace(),
            makeWorkspace({
              id: "chat-ws-1",
              name: "Hidden one-off workspace",
              path: "/tmp/cowork-chat-1",
              workspaceKind: "oneOffChat",
            }),
          ],
          threads: [
            {
              id: "chat-thread-1",
              workspaceId: "chat-ws-1",
              title: "Loose idea",
              titleSource: "manual" as const,
              createdAt: "2026-03-24T00:00:00.000Z",
              lastMessageAt: "2026-03-24T12:00:00.000Z",
              status: "active" as const,
              sessionId: "chat-session-1",
              messageCount: 1,
              lastEventSeq: 1,
              draft: false,
            },
          ],
          selectedWorkspaceId: "chat-ws-1",
          selectedThreadId: "chat-thread-1",
        });
        root.render(createElement(Sidebar));
      });

      expect(
        Array.from(container.querySelectorAll("[data-sidebar-section]")).map((section) =>
          section.getAttribute("data-sidebar-section"),
        ),
      ).toEqual(["chats", "projects"]);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("New Chat opens the universal landing from the sidebar", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [makeWorkspace()],
          selectedWorkspaceId: "ws-1",
        });
        root.render(createElement(Sidebar));
      });

      const newChatButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "New Chat",
      );
      if (!(newChatButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing New Chat button");
      }

      await act(async () => {
        newChatButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      const state = useAppStore.getState();
      expect(state.workspaces).toHaveLength(1);
      expect(state.workspaces[0]?.workspaceKind).toBe("project");
      expect(state.selectedWorkspaceId).toBe("ws-1");
      expect(state.selectedThreadId).toBeNull();
      expect(state.newChatLandingTarget).toEqual({ kind: "project", workspaceId: "ws-1" });
      expect(state.threads).toEqual([]);
      expect(state.view).toBe("chat");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("one-off new chat landing does not emphasize a project row", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [makeWorkspace()],
          selectedWorkspaceId: "ws-1",
          selectedThreadId: null,
          newChatLandingTarget: { kind: "oneOff" },
        });
        root.render(createElement(Sidebar));
      });

      const workspaceCard = container.querySelector(".sidebar-workspace-card");
      expect(workspaceCard?.className ?? "").not.toContain("bg-foreground/[0.05]");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial(
    "switches a thread row into inline rename mode with a focused shared input",
    async () => {
      const harness = setupSidebarJsdom();
      const selectThread = mock(async () => {});
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          resetAppStore({
            workspaces: [makeWorkspace()],
            threads: makeThreads(3),
            selectedWorkspaceId: "ws-1",
            selectedThreadId: "thread-3",
            selectThread,
          });
          root.render(createElement(Sidebar));
        });

        const threadButton = Array.from(container.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Thread 3"),
        );
        if (!(threadButton instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing thread row");
        }

        await act(async () => {
          threadButton.dispatchEvent(
            new harness.dom.window.MouseEvent("dblclick", { bubbles: true }),
          );
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
    },
  );

  test.serial("shows chat navigation controls and workspace cards in the sidebar", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          view: "skills",
          workspaces: [makeWorkspace()],
          threads: makeThreads(2),
          selectedWorkspaceId: "ws-1",
          selectedThreadId: "thread-2",
        });
        root.render(createElement(Sidebar));
      });

      expect(container.textContent).toContain("New Chat");
      expect(container.textContent).toContain("Plugins");
      expect(container.textContent).toContain("Agent Coworker");

      const newChatButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("New Chat"),
      );
      if (!(newChatButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing new chat button");
      }
      expect(newChatButton.className).toMatch(/w-full|flex-1/);
      const titlebandButtons = Array.from(
        container.querySelectorAll(".app-sidebar__titleband-row > button"),
      );
      expect(titlebandButtons).toHaveLength(1);
      expect(titlebandButtons[0]?.textContent).toContain("New Chat");

      const skillsButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Plugins"),
      );
      if (!(skillsButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing plugins button");
      }
      expect(skillsButton.className).toContain("w-full");

      expect(newChatButton.querySelector("svg")?.className.baseVal ?? "").toContain(
        "lucide-square-pen",
      );
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("shows Research navigation only when a Google API key is saved", async () => {
    const harness = setupSidebarJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [makeWorkspace()],
          threads: makeThreads(1),
          selectedWorkspaceId: "ws-1",
        });
        root.render(createElement(Sidebar));
      });

      expect(container.textContent).not.toContain("Research");

      await act(async () => {
        resetAppStore({
          workspaces: [makeWorkspace()],
          threads: makeThreads(1),
          selectedWorkspaceId: "ws-1",
          providerStatusByName: {
            google: {
              provider: "google",
              authorized: true,
              verified: false,
              mode: "api_key",
              account: null,
              message: "API key saved.",
              checkedAt: "2026-05-15T00:00:00.000Z",
              savedApiKeyMasks: { api_key: "goog...1234" },
            },
          },
        });
      });

      expect(container.textContent).toContain("Research");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial(
    "hides add-workspace affordances when workspace lifecycle actions are disabled",
    async () => {
      const harness = setupSidebarJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        workspaceLifecycleEnabled = false;
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          resetAppStore({
            workspaces: [makeWorkspace()],
            threads: makeThreads(1),
            selectedWorkspaceId: "ws-1",
            selectedThreadId: "thread-1",
          });
          root.render(createElement(Sidebar));
        });

        expect(container.querySelector('[aria-label="Add workspace"]')).toBeNull();
        expect(
          [...container.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Add workspace",
          ),
        ).toBe(false);
        expect(container.querySelector(".sidebar-workspace-card--reorderable")).toBeNull();
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test.serial("moves a workspace with Alt+ArrowDown from the workspace row", async () => {
    const harness = setupSidebarJsdom();
    const setWorkspacesOrder = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [
            makeWorkspace(),
            makeWorkspace({
              id: "ws-2",
              name: "Research Lab",
              path: "/tmp/research-lab",
            }),
          ],
          threads: makeThreads(1),
          selectedWorkspaceId: "ws-1",
          selectedThreadId: "thread-1",
          setWorkspacesOrder,
        });
        root.render(createElement(Sidebar));
      });

      const workspaceCards = Array.from(container.querySelectorAll(".sidebar-workspace-card"));
      expect(workspaceCards).toHaveLength(2);
      expect(
        workspaceCards.every((card) =>
          card.className.includes("sidebar-workspace-card--reorderable"),
        ),
      ).toBe(true);
      expect(container.querySelector('[aria-label^="Reorder "]')).toBeNull();

      const firstWorkspaceButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Agent Coworker"),
      );
      if (!(firstWorkspaceButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing workspace button");
      }

      await act(async () => {
        firstWorkspaceButton.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            altKey: true,
            bubbles: true,
            key: "ArrowDown",
          }),
        );
      });

      expect(setWorkspacesOrder).toHaveBeenCalledWith(["ws-2", "ws-1"]);
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("moves a workspace with Alt+ArrowUp from the workspace row", async () => {
    const harness = setupSidebarJsdom();
    const setWorkspacesOrder = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        resetAppStore({
          workspaces: [
            makeWorkspace(),
            makeWorkspace({
              id: "ws-2",
              name: "Research Lab",
              path: "/tmp/research-lab",
            }),
          ],
          threads: makeThreads(1),
          selectedWorkspaceId: "ws-2",
          selectedThreadId: "thread-1",
          setWorkspacesOrder,
        });
        root.render(createElement(Sidebar));
      });

      const secondWorkspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Research Lab"),
      );
      if (!(secondWorkspaceButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing workspace button");
      }

      await act(async () => {
        secondWorkspaceButton.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", {
            altKey: true,
            bubbles: true,
            key: "ArrowUp",
          }),
        );
      });

      expect(setWorkspacesOrder).toHaveBeenCalledWith(["ws-2", "ws-1"]);
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial(
    "limits the workspace list to the active workspace when workspace picker is disabled",
    async () => {
      const harness = setupSidebarJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        workspacePickerEnabled = false;
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          resetAppStore({
            workspaces: [
              makeWorkspace(),
              makeWorkspace({
                id: "ws-2",
                name: "Research Lab",
                path: "/tmp/research-lab",
              }),
            ],
            threads: [
              ...makeThreads(1),
              {
                id: "thread-2",
                workspaceId: "ws-2",
                title: "Thread 2",
                titleSource: "manual" as const,
                createdAt: "2026-03-02T09:00:00.000Z",
                lastMessageAt: "2026-03-02T10:00:00.000Z",
                status: "active" as const,
                sessionId: "session-2",
                messageCount: 2,
                lastEventSeq: 2,
                draft: false,
              },
            ],
            selectedWorkspaceId: "ws-1",
            selectedThreadId: "thread-1",
          });
          root.render(createElement(Sidebar));
        });

        const workspaceCards = Array.from(container.querySelectorAll(".sidebar-workspace-card"));
        expect(workspaceCards).toHaveLength(1);
        expect(container.textContent).toContain("Agent Coworker");
        expect(container.textContent).not.toContain("Research Lab");
        expect(container.querySelector('[aria-label="Project section options"]')).not.toBeNull();
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test.serial(
    "uses the plugin management workspace as the active sidebar target in skills view",
    async () => {
      const harness = setupSidebarJsdom();
      const setPluginManagementWorkspace = mock(async () => {});
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          resetAppStore({
            view: "skills",
            workspaces: [
              makeWorkspace(),
              makeWorkspace({
                id: "ws-2",
                name: "Research Lab",
                path: "/tmp/research-lab",
              }),
            ],
            threads: [
              ...makeThreads(2),
              {
                id: "thread-3",
                workspaceId: "ws-2",
                title: "Thread 3",
                titleSource: "manual" as const,
                createdAt: "2026-03-03T09:00:00.000Z",
                lastMessageAt: "2026-03-03T10:00:00.000Z",
                status: "active" as const,
                sessionId: "session-3",
                messageCount: 3,
                lastEventSeq: 3,
                draft: false,
              },
            ],
            selectedWorkspaceId: "ws-1",
            pluginManagementWorkspaceId: "ws-2",
            pluginManagementMode: "workspace",
            setPluginManagementWorkspace,
          });
          root.render(createElement(Sidebar));
        });

        const workspaceCards = Array.from(container.querySelectorAll(".sidebar-workspace-card"));
        expect(workspaceCards).toHaveLength(2);
        expect(workspaceCards[0]?.className ?? "").not.toContain("bg-foreground/[0.05]");
        expect(workspaceCards[1]?.className ?? "").toContain("bg-foreground/[0.05]");

        const firstWorkspaceButton = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.includes("Agent Coworker"),
        );
        if (!(firstWorkspaceButton instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing first workspace button");
        }

        await act(async () => {
          firstWorkspaceButton.dispatchEvent(
            new harness.dom.window.MouseEvent("click", { bubbles: true }),
          );
        });

        expect(setPluginManagementWorkspace).toHaveBeenCalledWith("ws-1");
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        harness.restore();
      }
    },
  );
});
