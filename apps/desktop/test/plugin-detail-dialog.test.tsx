import { describe, expect, mock, test } from "bun:test";
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
  release: null,
  progress: null,
  error: null,
};

const revealPathMock = mock(async () => {});
const installPluginsMock = mock(async (_sourceInput: string, _scope: "workspace" | "user") => {});
const enablePluginMock = mock(async (_pluginId: string, _scope?: "workspace" | "user") => {});
const disablePluginMock = mock(async (_pluginId: string, _scope?: "workspace" | "user") => {});
const checkPluginUpdateMock = mock(async (_pluginId: string, _scope?: "workspace" | "user") => {});
const updatePluginMock = mock(async (_pluginId: string, _scope?: "workspace" | "user") => {});

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
  }),
);

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { PluginDetailDialog } = await import("../src/ui/settings/toolAccess/PluginDetailDialog");
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
          selectedPluginId: "workspace-tools",
          selectedPluginScope: "workspace",
          selectedPlugin: {
            id: "workspace-tools",
            name: "workspace-tools",
            displayName: "Workspace Tools",
            description: "Create and edit workspace artifacts.",
            scope: "workspace",
            discoveryKind: "marketplace",
            installed: true,
            enabled: false,
            rootDir: "/tmp/workspace/.agents/plugins/workspace-tools",
            manifestPath:
              "/tmp/workspace/.agents/plugins/workspace-tools/.codex-plugin/plugin.json",
            skillsPath: "/tmp/workspace/.agents/plugins/workspace-tools/skills",
            mcpPath: "/tmp/workspace/.agents/plugins/workspace-tools/.mcp.json",
            appPath: "/tmp/workspace/.agents/plugins/workspace-tools/.app.json",
            version: "1.2.3",
            authorName: "Cowork",
            homepage: "https://example.com/workspace-tools",
            repository: "https://example.com/repo",
            license: "MIT",
            keywords: ["documents", "presentations", "spreadsheets"],
            interface: {
              displayName: "Workspace Tools",
              shortDescription: "Create workspace artifacts.",
              longDescription: "Plugin long description.",
            },
            marketplace: {
              name: "cowork-marketplace",
              displayName: "Cowork Marketplace",
              category: "Productivity",
            },
            skills: [
              {
                name: "workspace-tools:documents",
                description: "Create documents",
                enabled: true,
              },
              {
                name: "workspace-tools:presentations",
                description: "Create presentations",
                enabled: true,
              },
              {
                name: "workspace-tools:spreadsheets",
                description: "Create spreadsheets",
                enabled: true,
              },
            ],
            mcpServers: ["workspace-tools-mcp"],
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

      const openFolderButton = Array.from(
        harness.dom.window.document.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("Open folder"));
      if (!(openFolderButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing open folder button");
      }

      await act(async () => {
        openFolderButton.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(revealPathMock).toHaveBeenCalledWith({
        path: "/tmp/workspace/.agents/plugins/workspace-tools",
      });

      const enableButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Enable plugin"),
      );
      if (!(enableButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing enable plugin button");
      }

      await act(async () => {
        enableButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(enablePluginMock).toHaveBeenCalledTimes(1);
      expect(enablePluginMock).toHaveBeenCalledWith("workspace-tools", "workspace");
      expect(disablePluginMock).not.toHaveBeenCalled();
      const pageText = harness.dom.window.document.body.textContent ?? "";
      expect(pageText).toContain("Bundled Skills");
      // Namespaced skill ids render as prettified display names.
      expect(pageText).toContain("Documents");
      expect(pageText).toContain("Presentations");
      expect(pageText).toContain("Spreadsheets");
      expect(pageText).not.toContain("workspace-tools:documents");
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

  test("wires bundled skill switches to skill installation toggles", async () => {
    const enableSkillInstallationMock = mock(async (_installationId: string) => {});
    const disableSkillInstallationMock = mock(async (_installationId: string) => {});
    const previousState = useAppStore.getState();

    const pluginOwner = {
      pluginId: "workspace-tools",
      name: "workspace-tools",
      displayName: "Workspace Tools",
      scope: "workspace",
      discoveryKind: "marketplace",
      rootDir: "/tmp/workspace/.agents/plugins/workspace-tools",
    };
    const skillInstallation = (rawName: string, enabled: boolean) => ({
      installationId: `plugin:workspace:workspace-tools:${rawName}`,
      name: `workspace-tools:${rawName}`,
      description: `Create ${rawName}`,
      scope: "project",
      enabled,
      writable: false,
      managed: false,
      effective: false,
      state: enabled ? "shadowed" : "disabled",
      rootDir: `/tmp/workspace/.agents/plugins/workspace-tools/skills/${rawName}`,
      skillPath: `/tmp/workspace/.agents/plugins/workspace-tools/skills/${rawName}/SKILL.md`,
      path: `/tmp/workspace/.agents/plugins/workspace-tools/skills/${rawName}`,
      triggers: [],
      descriptionSource: "frontmatter",
      diagnostics: [],
      plugin: pluginOwner,
    });

    useAppStore.setState({
      ...previousState,
      enableSkillInstallation:
        enableSkillInstallationMock as typeof previousState.enableSkillInstallation,
      disableSkillInstallation:
        disableSkillInstallationMock as typeof previousState.disableSkillInstallation,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "workspace-tools",
          selectedPluginScope: "workspace",
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [
              skillInstallation("documents", true),
              skillInstallation("presentations", false),
            ],
            availableSkills: [],
          },
          selectedPlugin: {
            id: "workspace-tools",
            name: "workspace-tools",
            displayName: "Workspace Tools",
            description: "Create and edit workspace artifacts.",
            scope: "workspace",
            discoveryKind: "marketplace",
            installed: true,
            enabled: true,
            rootDir: "/tmp/workspace/.agents/plugins/workspace-tools",
            manifestPath:
              "/tmp/workspace/.agents/plugins/workspace-tools/.codex-plugin/plugin.json",
            skillsPath: "/tmp/workspace/.agents/plugins/workspace-tools/skills",
            skills: [
              {
                name: "workspace-tools:documents",
                rawName: "documents",
                description: "Create documents",
                enabled: true,
              },
              {
                name: "workspace-tools:presentations",
                rawName: "presentations",
                description: "Create presentations",
                enabled: false,
              },
              {
                name: "workspace-tools:orphaned-skill",
                rawName: "orphaned-skill",
                description: "No catalog installation",
                enabled: true,
              },
            ],
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

      const findSwitch = (label: string) => {
        const el = harness.dom.window.document.querySelector(
          `[role="switch"][aria-label="${label}"]`,
        );
        if (!(el instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error(`missing switch ${label}`);
        }
        return el;
      };

      const documentsSwitch = findSwitch("Enable Documents");
      expect(documentsSwitch.getAttribute("aria-checked")).toBe("true");
      await act(async () => {
        documentsSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(disableSkillInstallationMock).toHaveBeenCalledWith(
        "plugin:workspace:workspace-tools:documents",
      );

      const presentationsSwitch = findSwitch("Enable Presentations");
      expect(presentationsSwitch.getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        presentationsSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(enableSkillInstallationMock).toHaveBeenCalledWith(
        "plugin:workspace:workspace-tools:presentations",
      );

      // Skills without a matching catalog installation render a disabled switch.
      const orphanSwitch = findSwitch("Enable Orphaned Skill");
      expect(orphanSwitch.hasAttribute("disabled")).toBe(true);
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

  test("shows plugin mutation errors from the plugin channel", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "plugin-1",
          selectedPluginScope: "workspace",
          skillMutationError: "Skill install failed.",
          pluginMutationError: "Plugin is shadowed by a global install.",
          selectedPlugin: {
            id: "plugin-1",
            name: "figma-toolkit",
            displayName: "Figma Toolkit",
            description: "Bring Figma bundles into Cowork.",
            scope: "workspace",
            discoveryKind: "marketplace",
            installed: true,
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
      expect(harness.dom.window.document.body.textContent ?? "").not.toContain(
        "Skill install failed.",
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

  test("handles rejected install and update actions from detail buttons", async () => {
    const scenarios = [
      {
        buttonText: "Install plugin",
        action: "install" as const,
        plugin: {
          id: "marketplace-tools",
          name: "marketplace-tools",
          displayName: "Marketplace Tools",
          description: "Installable plugin.",
          scope: "user" as const,
          discoveryKind: "marketplace" as const,
          installed: false,
          enabled: false,
          installSource: "github:mweinbach/marketplace-tools",
          marketplace: {
            name: "marketplace-tools",
            displayName: "Marketplace Tools",
            category: "Productivity",
          },
          warnings: [],
        },
      },
      {
        buttonText: "Update plugin",
        action: "update" as const,
        plugin: {
          id: "marketplace-tools",
          name: "marketplace-tools",
          displayName: "Marketplace Tools",
          description: "Installed plugin.",
          scope: "user" as const,
          discoveryKind: "marketplace" as const,
          installed: true,
          enabled: true,
          installSource: "github:mweinbach/marketplace-tools",
          updateAvailable: true,
          rootDir: "/tmp/home/.cowork/plugins/marketplace-tools",
          manifestPath: "/tmp/home/.cowork/plugins/marketplace-tools/.codex-plugin/plugin.json",
          skillsPath: "/tmp/home/.cowork/plugins/marketplace-tools/skills",
          skills: [],
          mcpServers: [],
          apps: [],
          warnings: [],
        },
      },
    ];

    for (const scenario of scenarios) {
      const previousState = useAppStore.getState();
      let rejectionHandled = false;
      installPluginsMock.mockClear();
      updatePluginMock.mockClear();
      const actionMock = scenario.action === "install" ? installPluginsMock : updatePluginMock;
      actionMock.mockImplementation(
        () =>
          ({
            then: (_resolve: () => void, reject?: (error: Error) => void) => {
              rejectionHandled = typeof reject === "function";
              reject?.(new Error("Install failed"));
            },
          }) as Promise<void>,
      );

      useAppStore.setState({
        ...previousState,
        installPlugins: installPluginsMock as typeof previousState.installPlugins,
        updatePlugin: updatePluginMock as typeof previousState.updatePlugin,
        workspaceRuntimeById: {
          ...previousState.workspaceRuntimeById,
          "ws-1": {
            ...defaultWorkspaceRuntime(),
            selectedPluginId: scenario.plugin.id,
            selectedPluginScope: scenario.plugin.scope,
            selectedPlugin: scenario.plugin,
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

        const actionButton = Array.from(
          harness.dom.window.document.querySelectorAll("button"),
        ).find((button) => button.textContent?.includes(scenario.buttonText));
        if (!(actionButton instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error(`missing ${scenario.buttonText} button`);
        }

        await act(async () => {
          actionButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        if (scenario.action === "install") {
          expect(installPluginsMock).toHaveBeenCalledWith(
            "github:mweinbach/marketplace-tools",
            "user",
          );
        } else {
          expect(updatePluginMock).toHaveBeenCalledWith("marketplace-tools", "user");
        }
        expect(rejectionHandled).toBe(true);
      } finally {
        if (root) {
          await act(async () => {
            root.unmount();
          });
        }
        useAppStore.setState(previousState);
        harness.restore();
      }
    }
  });

  test("shows plugin update actions only when an update is available", async () => {
    const previousState = useAppStore.getState();
    checkPluginUpdateMock.mockClear();
    updatePluginMock.mockClear();

    useAppStore.setState({
      ...previousState,
      checkPluginUpdate: checkPluginUpdateMock as typeof previousState.checkPluginUpdate,
      updatePlugin: updatePluginMock as typeof previousState.updatePlugin,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "marketplace-tools",
          selectedPluginScope: "user",
          selectedPlugin: {
            id: "marketplace-tools",
            name: "marketplace-tools",
            displayName: "Marketplace Tools",
            description: "Installed plugin.",
            scope: "user",
            discoveryKind: "marketplace",
            installed: true,
            enabled: true,
            installSource: "github:mweinbach/marketplace-tools",
            updateAvailable: false,
            rootDir: "/tmp/home/.cowork/plugins/marketplace-tools",
            manifestPath: "/tmp/home/.cowork/plugins/marketplace-tools/.codex-plugin/plugin.json",
            skillsPath: "/tmp/home/.cowork/plugins/marketplace-tools/skills",
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

      const buttons = Array.from(harness.dom.window.document.querySelectorAll("button"));
      expect(buttons.some((button) => button.textContent?.includes("Update plugin"))).toBe(false);
      const checkButton = buttons.find((button) =>
        button.textContent?.includes("Check for updates"),
      );
      if (!(checkButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing Check for updates button");
      }

      await act(async () => {
        checkButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(checkPluginUpdateMock).toHaveBeenCalledWith("marketplace-tools", "user");
      expect(updatePluginMock).not.toHaveBeenCalled();
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

  test("does not show enable or disable actions for non-installable marketplace details", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "catalog-only",
          selectedPluginScope: "user",
          selectedPlugin: {
            id: "catalog-only",
            name: "catalog-only",
            displayName: "Catalog Only",
            description: "Metadata is visible, but there is no installable source.",
            scope: "user",
            discoveryKind: "marketplace",
            installed: false,
            enabled: false,
            marketplace: {
              name: "catalog-only",
              displayName: "Catalog Only",
              category: "Productivity",
            },
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

      const pageText = harness.dom.window.document.body.textContent ?? "";
      expect(pageText).toContain("Catalog Only");
      expect(pageText).not.toContain("Install plugin");
      expect(pageText).not.toContain("Enable plugin");
      expect(pageText).not.toContain("Disable plugin");
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

  test("shows loading state for scope-less plugin detail selections", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedPluginId: "marketplace-tools",
          selectedPluginScope: null,
          selectedPlugin: null,
          pluginsLoading: true,
          pluginsError: null,
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

      const pageText = harness.dom.window.document.body.textContent ?? "";
      expect(pageText).toContain("Loading plugin");
      expect(pageText).not.toContain("Plugin unavailable");
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
