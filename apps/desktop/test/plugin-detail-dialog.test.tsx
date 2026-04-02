import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
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
  release: null,
  progress: null,
  error: null,
};

const revealPathMock = mock(async () => {});
const enablePluginMock = mock(async (_pluginId: string, _scope?: "workspace" | "user") => {});
const disablePluginMock = mock(async (_pluginId: string, _scope?: "workspace" | "user") => {});

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
  revealPath: revealPathMock,
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

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { PluginDetailDialog } = await import("../src/ui/plugins/PluginDetailDialog");
mock.restore();

describe("plugin detail dialog", () => {
  test("reveals the plugin folder and toggles disabled plugins", async () => {
    revealPathMock.mockClear();
    enablePluginMock.mockClear();
    disablePluginMock.mockClear();

    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      enablePlugin: enablePluginMock as typeof previousState.enablePlugin,
      disablePlugin: disablePluginMock as typeof previousState.disablePlugin,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "plugin-1",
          selectedPluginScope: "workspace",
          selectedPlugin: {
            id: "plugin-1",
            name: "figma-toolkit",
            displayName: "Figma Toolkit",
            description: "Bring Figma bundles into Cowork.",
            scope: "workspace",
            discoveryKind: "marketplace",
            enabled: false,
            rootDir: "/tmp/workspace/.agents/plugins/figma-toolkit",
            manifestPath: "/tmp/workspace/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
            skillsPath: "/tmp/workspace/.agents/plugins/figma-toolkit/skills",
            mcpPath: "/tmp/workspace/.agents/plugins/figma-toolkit/.mcp.json",
            appPath: "/tmp/workspace/.agents/plugins/figma-toolkit/.app.json",
            version: "1.2.3",
            authorName: "Cowork",
            homepage: "https://example.com/figma-toolkit",
            repository: "https://example.com/repo",
            license: "MIT",
            keywords: ["figma"],
            interface: {
              displayName: "Figma Toolkit",
              shortDescription: "Import Figma data.",
              longDescription: "Plugin long description.",
            },
            marketplace: {
              name: "cowork-marketplace",
              displayName: "Cowork Marketplace",
              category: "Design",
            },
            skills: [
              {
                name: "figma-toolkit:import-frame",
                description: "Import a frame",
                enabled: true,
              },
            ],
            mcpServers: ["figma-mcp"],
            apps: [
              {
                id: "figma-app",
                displayName: "Figma App",
                description: "Metadata only",
                authType: "oauth",
              },
            ],
            warnings: [],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginDetailDialog, { workspaceId: "ws-1" }));
      });

      const openFolderButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Open folder"),
      );
      if (!(openFolderButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing open folder button");
      }

      await act(async () => {
        openFolderButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(revealPathMock).toHaveBeenCalledWith({
        path: "/tmp/workspace/.agents/plugins/figma-toolkit",
      });

      const enableButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Enable Plugin"),
      );
      if (!(enableButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing enable plugin button");
      }

      await act(async () => {
        enableButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(enablePluginMock).toHaveBeenCalledTimes(1);
      expect(enablePluginMock).toHaveBeenCalledWith("plugin-1", "workspace");
      expect(disablePluginMock).not.toHaveBeenCalled();
      const pageText = harness.dom.window.document.body.textContent ?? "";
      expect(pageText).toContain("Bundled Skills");
      expect(pageText).toContain("Bundled MCP Servers");
      expect(pageText).toContain("Bundled Apps");

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

  test("shows plugin mutation errors even when they arrive via skillMutationError", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "plugin-1",
          selectedPluginScope: "workspace",
          skillMutationError: "Plugin is shadowed by a global install.",
          selectedPlugin: {
            id: "plugin-1",
            name: "figma-toolkit",
            displayName: "Figma Toolkit",
            description: "Bring Figma bundles into Cowork.",
            scope: "workspace",
            discoveryKind: "marketplace",
            enabled: true,
            rootDir: "/tmp/workspace/.agents/plugins/figma-toolkit",
            manifestPath: "/tmp/workspace/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
            skillsPath: "/tmp/workspace/.agents/plugins/figma-toolkit/skills",
            skills: [],
            mcpServers: [],
            apps: [],
            warnings: [],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(PluginDetailDialog, { workspaceId: "ws-1" }));
      });

      expect(harness.dom.window.document.body.textContent ?? "").toContain(
        "Plugin is shadowed by a global install.",
      );
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
