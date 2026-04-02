import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

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

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
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
}));

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { shouldRequireFreshPluginPreviewForScope } = await import("../src/ui/plugins/InstallPluginDialog");
const { PluginsCatalogPage } = await import("../src/ui/plugins/PluginsCatalogPage");
mock.restore();

const workspaceId = "ws-plugins";

function baseWorkspaceState() {
  return {
    workspaces: [{
      id: workspaceId,
      name: "Plugin Workspace",
      path: "/tmp/plugin-workspace",
      createdAt: "2026-03-30T00:00:00.000Z",
      lastOpenedAt: "2026-03-30T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: true,
      yolo: false,
    }],
    threads: [{
      id: "thread-1",
      workspaceId,
      title: "Thread 1",
      titleSource: "manual",
      createdAt: "2026-03-30T00:00:00.000Z",
      lastMessageAt: "2026-03-30T00:00:00.000Z",
      status: "active",
      sessionId: "session-1",
      messageCount: 1,
      lastEventSeq: 1,
      draft: false,
    }],
    selectedWorkspaceId: workspaceId,
    selectedThreadId: "thread-1",
    selectThread: mock(async () => {}),
    newThread: mock(async () => {}),
    refreshPluginsCatalog: mock(async () => {}),
    selectPlugin: mock(async () => {}),
  };
}

describe("plugins catalog page", () => {
  test("shows loading state while plugins are loading", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: null,
          pluginsLoading: true,
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      (harness.dom.window.HTMLElement.prototype as { attachEvent?: () => void; detachEvent?: () => void }).attachEvent = () => {};
      (harness.dom.window.HTMLElement.prototype as { attachEvent?: () => void; detachEvent?: () => void }).detachEvent = () => {};
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginsCatalogPage, { workspaceId, searchQuery: "", setSearchQuery: () => {} }));
      });

      expect(container.textContent).toContain("Loading...");
      expect(container.textContent).toContain("Fetching plugins catalog.");

      await act(async () => {
        root.unmount();
      });
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows inline error state when plugin catalog refresh fails", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: null,
          pluginsLoading: false,
          pluginsError: "Unable to refresh plugins catalog.",
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginsCatalogPage, { workspaceId, searchQuery: "", setSearchQuery: () => {} }));
      });

      expect(container.textContent).toContain("Connection issue");
      expect(container.textContent).toContain("Unable to refresh plugins catalog.");
      expect(container.textContent).toContain("Retry");

      await act(async () => {
        root.unmount();
      });
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("renders the new plugin install affordance", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            warnings: [],
            plugins: [],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginsCatalogPage, { workspaceId, searchQuery: "", setSearchQuery: () => {} }));
      });

      expect(container.textContent).toContain("+ New plugin");

      await act(async () => {
        root.unmount();
      });
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("new plugin dialog opens from a clean state", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          selectedPluginPreview: {
            source: {
              kind: "local_path",
              raw: "/tmp/old-plugin",
              displaySource: "/tmp/old-plugin",
              localPath: "/tmp/old-plugin",
            },
            targetScope: "workspace",
            warnings: [],
            candidates: [{
              pluginId: "old-plugin",
              displayName: "Old Plugin",
              description: "Old preview should be cleared",
              relativeRootPath: ".",
              wouldBePrimary: true,
              shadowedPluginIds: [],
              diagnostics: [],
            }],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginsCatalogPage, { workspaceId, searchQuery: "", setSearchQuery: () => {} }));
      });

      const newPluginButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("+ New plugin"),
      );
      if (!(newPluginButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing new plugin button");
      }

      await act(async () => {
        newPluginButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText).toContain("Install plugin from source");
      expect(dialogText).not.toContain("Old Plugin");
      expect(dialogText).not.toContain("/tmp/old-plugin");

      const textarea = harness.dom.window.document.querySelector("textarea");
      expect(textarea?.getAttribute("placeholder")).toContain("https://github.com/example/codex-plugin-repo");
      expect((textarea as HTMLTextAreaElement | null)?.value ?? "").toBe("");

      await act(async () => {
        root.unmount();
      });
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("install dialog requires a fresh preview when switching install scope", () => {
    const preview = {
      source: {
        kind: "github_shorthand" as const,
        raw: "owner/repo",
        displaySource: "https://github.com/owner/repo",
        url: "https://github.com/owner/repo",
        repo: "owner/repo",
      },
      targetScope: "workspace" as const,
      candidates: [],
      warnings: [],
    };

    expect(shouldRequireFreshPluginPreviewForScope({
      normalizedSourceInput: "owner/repo",
      lastPreviewSourceInput: "owner/repo",
      lastPreviewTargetScope: "workspace",
      pluginPreview: preview,
      targetScope: "workspace",
    })).toBe(false);

    expect(shouldRequireFreshPluginPreviewForScope({
      normalizedSourceInput: "owner/repo",
      lastPreviewSourceInput: "owner/repo",
      lastPreviewTargetScope: "workspace",
      pluginPreview: preview,
      targetScope: "user",
    })).toBe(true);
  });

  test("renders enabled and disabled plugin sections with counts", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            warnings: [],
            plugins: [
              {
                id: "plugin-1",
                name: "figma-toolkit",
                displayName: "Figma Toolkit",
                description: "Figma helpers",
                scope: "workspace",
                discoveryKind: "marketplace",
                enabled: true,
                rootDir: "/tmp/plugin-workspace/.agents/plugins/figma-toolkit",
                manifestPath: "/tmp/plugin-workspace/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
                skillsPath: "/tmp/plugin-workspace/.agents/plugins/figma-toolkit/skills",
                skills: [{ name: "figma-toolkit:import-frame", description: "Import frame", enabled: true }],
                mcpServers: ["figma"],
                apps: [{ id: "figma-app", displayName: "Figma App", description: "Metadata only" }],
                warnings: [],
              },
              {
                id: "plugin-2",
                name: "slack-toolkit",
                displayName: "Slack Toolkit",
                description: "Slack helpers",
                scope: "user",
                discoveryKind: "direct",
                enabled: false,
                rootDir: "/tmp/home/.agents/plugins/slack-toolkit",
                manifestPath: "/tmp/home/.agents/plugins/slack-toolkit/.codex-plugin/plugin.json",
                skillsPath: "/tmp/home/.agents/plugins/slack-toolkit/skills",
                skills: [],
                mcpServers: ["slack"],
                apps: [],
                warnings: [],
              },
            ],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginsCatalogPage, { workspaceId, searchQuery: "", setSearchQuery: () => {} }));
      });

      expect(container.textContent).toContain("Enabled");
      expect(container.textContent).toContain("Disabled");
      expect(container.textContent).toContain("Figma Toolkit");
      expect(container.textContent).toContain("Slack Toolkit");
      expect(container.textContent).toContain("1 skill");
      expect(container.textContent).not.toContain("1 apps");

      await act(async () => {
        root.unmount();
      });
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("renders duplicate plugin ids from different scopes without collapsing a card", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            warnings: [],
            plugins: [
              {
                id: "figma-toolkit",
                name: "figma-toolkit",
                displayName: "Workspace Figma Toolkit",
                description: "Workspace helpers",
                scope: "workspace",
                discoveryKind: "direct",
                enabled: true,
                rootDir: "/tmp/plugin-workspace/.agents/plugins/figma-toolkit",
                manifestPath: "/tmp/plugin-workspace/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
                skillsPath: "/tmp/plugin-workspace/.agents/plugins/figma-toolkit/skills",
                skills: [],
                mcpServers: [],
                apps: [],
                warnings: [],
              },
              {
                id: "figma-toolkit",
                name: "figma-toolkit",
                displayName: "User Figma Toolkit",
                description: "Global helpers",
                scope: "user",
                discoveryKind: "direct",
                enabled: false,
                rootDir: "/tmp/home/.agents/plugins/figma-toolkit",
                manifestPath: "/tmp/home/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
                skillsPath: "/tmp/home/.agents/plugins/figma-toolkit/skills",
                skills: [],
                mcpServers: [],
                apps: [],
                warnings: [],
              },
            ],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginsCatalogPage, { workspaceId, searchQuery: "", setSearchQuery: () => {} }));
      });

      const pageText = container.textContent ?? "";
      expect(pageText).toContain("Workspace Figma Toolkit");
      expect(pageText).toContain("User Figma Toolkit");
      expect(pageText).toContain("Workspace plugin");
      expect(pageText).toContain("User plugin");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
