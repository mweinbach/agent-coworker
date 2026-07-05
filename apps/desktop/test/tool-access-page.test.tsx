import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { ToolAccessTabs, useToolAccessCatalogWorkspaceId } = await import(
  "../src/ui/settings/pages/ToolAccessPage"
);
const { managementWorkspaceIdFor } = await import("../src/app/store.actions/skillPluginHelpers");
mock.restore();

type PluginCatalogEntry = import("../src/lib/wsProtocol").PluginCatalogEntry;
type InstalledPluginEntry = Extract<PluginCatalogEntry, { installed: true }>;
type MarketplacePluginEntry = Extract<PluginCatalogEntry, { installed: false }>;
type SkillInstallationEntry = import("../src/lib/wsProtocol").SkillInstallationEntry;
type MarketplaceSkillEntry = import("../src/lib/wsProtocol").MarketplaceSkillCatalogEntry;

const PLUGIN_MUTATION_ERROR = "Plugin install failed: marketplace source hash mismatch.";
const SKILL_MUTATION_ERROR = "Skill install failed: GitHub rate limit exceeded.";

function projectWorkspace(id: string) {
  return {
    id,
    name: "Workspace",
    path: `/tmp/${id}`,
    workspaceKind: "project" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    lastOpenedAt: "2026-06-02T00:00:00.000Z",
    defaultEnableMcp: true,
    defaultBackupsEnabled: false,
    yolo: false,
  };
}

function installedPlugin(id: string, displayName: string, description = ""): InstalledPluginEntry {
  return {
    id,
    name: id,
    displayName,
    description,
    scope: "user",
    discoveryKind: "marketplace",
    warnings: [],
    installed: true,
    enabled: true,
    rootDir: `/tmp/plugins/${id}`,
    manifestPath: `/tmp/plugins/${id}/manifest.json`,
    skillsPath: `/tmp/plugins/${id}/skills`,
    skills: [],
    mcpServers: [],
    apps: [],
  };
}

function marketplacePlugin(id: string, displayName: string): MarketplacePluginEntry {
  return {
    id,
    name: id,
    displayName,
    description: "Shared team workflows.",
    scope: "user",
    discoveryKind: "marketplace",
    installed: false,
    enabled: false,
    installSource: `https://github.com/example/cowork-plugins/tree/main/plugins/${id}`,
    marketplace: { name: "example-marketplace", category: "Productivity" },
    warnings: [],
  };
}

function skillInstallation(installationId: string, name: string): SkillInstallationEntry {
  return {
    installationId,
    name,
    description: "",
    scope: "global",
    enabled: true,
    writable: true,
    managed: true,
    effective: true,
    state: "effective",
    rootDir: `/tmp/skills/${name}`,
    skillPath: `/tmp/skills/${name}/SKILL.md`,
    path: `/tmp/skills/${name}`,
    triggers: [],
    descriptionSource: "frontmatter",
    diagnostics: [],
  };
}

function pluginSkillInstallation(pluginId: string, rawName: string): SkillInstallationEntry {
  return {
    ...skillInstallation(`plugin:user:${pluginId}:${rawName}`, `${pluginId}:${rawName}`),
    writable: false,
    managed: false,
    effective: false,
    state: "shadowed",
    plugin: {
      pluginId,
      name: pluginId,
      displayName: "Workspace Tools",
      scope: "user",
      discoveryKind: "marketplace",
      rootDir: `/tmp/plugins/${pluginId}`,
    },
  };
}

function marketplaceSkill(id: string, displayName: string): MarketplaceSkillEntry {
  return {
    id,
    name: id,
    displayName,
    description: "Generate images.",
    category: "Creative",
    scope: "user",
    discoveryKind: "marketplace",
    installed: false,
    enabled: false,
    installSource: `https://skills.sh/example/skills/${id}`,
    marketplace: { name: "example-marketplace", category: "Creative" },
    warnings: [],
  };
}

function mcpServer(name: string) {
  return {
    name,
    transport: { type: "http" as const, url: `https://${name}.example.test` },
    enabled: true,
    source: "user" as const,
    inherited: true,
    authMode: "none",
    authScope: "user" as const,
    authMessage: "",
  };
}

function catalogActionMocks(previousState: ReturnType<typeof useAppStore.getState>) {
  return {
    refreshPluginsCatalog: mock(async () => {}) as typeof previousState.refreshPluginsCatalog,
    refreshSkillsCatalog: mock(
      async (_workspaceId?: string) => {},
    ) as typeof previousState.refreshSkillsCatalog,
    requestWorkspaceMcpServers: mock(
      async (_workspaceId: string) => {},
    ) as typeof previousState.requestWorkspaceMcpServers,
    // The Skills tab mounts the marketplace sources list, which refreshes on mount.
    refreshMarketplaces: mock(
      async (_workspaceId?: string) => {},
    ) as typeof previousState.refreshMarketplaces,
  };
}

function findTab(harness: ReturnType<typeof setupJsdom>, label: string): HTMLButtonElement {
  const tab = Array.from(harness.dom.window.document.querySelectorAll('[role="tab"]')).find((el) =>
    (el.textContent ?? "").startsWith(label),
  );
  if (!(tab instanceof harness.dom.window.HTMLButtonElement)) {
    throw new Error(`missing tab ${label}`);
  }
  return tab;
}

async function selectTab(harness: ReturnType<typeof setupJsdom>, label: string) {
  const tab = findTab(harness, label);
  await act(async () => {
    tab.dispatchEvent(
      new harness.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    tab.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
  });
}

type InputChangeProps = {
  onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
};

function setInputValue(
  harness: ReturnType<typeof setupJsdom>,
  input: HTMLInputElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    harness.dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  // The Bun preload imports React before jsdom exists, so direct DOM events
  // alone do not reliably drive controlled fields; call the React prop too.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? ((input as unknown as Record<string, unknown>)[propsKey] as InputChangeProps)
    : {};
  props.onChange?.({ target: input, currentTarget: input });
  input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
}

describe("tool access tabs", () => {
  test("renders mutation error banners in the tab shell and clears them on dismiss", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginMutationError: PLUGIN_MUTATION_ERROR,
          skillMutationError: SKILL_MUTATION_ERROR,
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      // Banners live in the shell, so they are visible from the default tab.
      expect(bodyText()).toContain("Install failed");
      expect(bodyText()).toContain(PLUGIN_MUTATION_ERROR);
      expect(bodyText()).toContain(SKILL_MUTATION_ERROR);

      const dismissButtons = () =>
        Array.from(harness.dom.window.document.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Dismiss",
        );
      expect(dismissButtons()).toHaveLength(2);

      // The plugin banner renders first; dismissing it must not clear the skill error.
      const pluginDismiss = dismissButtons()[0];
      if (!(pluginDismiss instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing plugin dismiss button");
      }
      await act(async () => {
        pluginDismiss.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(useAppStore.getState().workspaceRuntimeById["ws-1"]?.pluginMutationError).toBeNull();
      expect(useAppStore.getState().workspaceRuntimeById["ws-1"]?.skillMutationError).toBe(
        SKILL_MUTATION_ERROR,
      );
      expect(bodyText()).not.toContain(PLUGIN_MUTATION_ERROR);
      expect(bodyText()).toContain(SKILL_MUTATION_ERROR);

      const skillDismiss = dismissButtons()[0];
      if (!(skillDismiss instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing skill dismiss button");
      }
      await act(async () => {
        skillDismiss.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(useAppStore.getState().workspaceRuntimeById["ws-1"]?.skillMutationError).toBeNull();
      expect(bodyText()).not.toContain(SKILL_MUTATION_ERROR);
      expect(bodyText()).not.toContain("Install failed");
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

  test("renders tabs with counts and gates the Apps tab behind the feature flag", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      desktopFeatureFlags: {
        ...previousState.desktopFeatureFlags,
        openAiNativeConnectors: false,
      },
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [
              installedPlugin("alpha", "Alpha Plugin"),
              installedPlugin("beta", "Beta Plugin"),
            ],
            availablePlugins: [marketplacePlugin("cursor-team-kit", "Cursor Team Kit")],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [skillInstallation("skill-1", "skill-one")],
            availableSkills: [marketplaceSkill("imagegen", "Imagegen")],
          },
          mcpServers: [mcpServer("grep")],
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      expect(findTab(harness, "Plugins").textContent).toBe("Plugins2");
      expect(findTab(harness, "Skills").textContent).toBe("Skills1");
      expect(findTab(harness, "Connectors").textContent).toBe("Connectors1");
      // Marketplace content lives inside the Plugins and Skills tabs now.
      expect(() => findTab(harness, "Marketplace")).toThrow("missing tab Marketplace");
      // The Search tab has no count.
      expect(findTab(harness, "Search").textContent).toBe("Search");
      expect(() => findTab(harness, "Apps")).toThrow("missing tab Apps");

      await act(async () => {
        useAppStore.setState((state) => ({
          desktopFeatureFlags: {
            ...state.desktopFeatureFlags,
            openAiNativeConnectors: true,
          },
        }));
      });

      expect(findTab(harness, "Apps")).toBeDefined();
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

  test("skills tab excludes plugin-owned installations from the count and list", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [installedPlugin("workspace-tools", "Workspace Tools")],
            availablePlugins: [],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [
              skillInstallation("skill-1", "skill-one"),
              pluginSkillInstallation("workspace-tools", "documents"),
              pluginSkillInstallation("workspace-tools", "presentations"),
            ],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      // Plugin-owned installations are managed from the plugin detail dialog,
      // so the tab count only reflects the standalone installation.
      expect(findTab(harness, "Skills").textContent).toBe("Skills1");

      await selectTab(harness, "Skills");

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("skill-one");
      expect(bodyText).not.toContain("workspace-tools:documents");
      expect(bodyText).not.toContain("workspace-tools:presentations");
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

  test("switching tabs swaps the active section content", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [installedPlugin("alpha", "Alpha Plugin")],
            availablePlugins: [],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [skillInstallation("skill-1", "skill-one")],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      expect(bodyText()).toContain("Alpha Plugin");
      expect(bodyText()).not.toContain("skill-one");

      await selectTab(harness, "Skills");

      expect(bodyText()).toContain("skill-one");
      expect(bodyText()).not.toContain("Alpha Plugin");
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

  test("search input filters the installed plugins list", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [
              installedPlugin("alpha", "Alpha Plugin"),
              installedPlugin("beta", "Beta Plugin"),
            ],
            availablePlugins: [],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      const searchInput = harness.dom.window.document.querySelector(
        'input[aria-label="Search plugins…"]',
      );
      if (!(searchInput instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing plugins search input");
      }

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      expect(bodyText()).toContain("Alpha Plugin");
      expect(bodyText()).toContain("Beta Plugin");

      await act(async () => {
        setInputValue(harness, searchInput, "alpha");
      });

      expect(bodyText()).toContain("Alpha Plugin");
      expect(bodyText()).not.toContain("Beta Plugin");

      await act(async () => {
        setInputValue(harness, searchInput, "zzz");
      });

      expect(bodyText()).not.toContain("Alpha Plugin");
      expect(bodyText()).not.toContain("Beta Plugin");
      expect(bodyText()).toContain("No matches for “zzz”");
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

  test("skills tab hosts the marketplace grid, add-marketplace action, and sources", async () => {
    const previousState = useAppStore.getState();
    const installSkillsMock = mock(
      async (_sourceInput: string, _targetScope: "project" | "global") => {},
    );

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      installSkills: installSkillsMock as typeof previousState.installSkills,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: { plugins: [], availablePlugins: [], warnings: [] },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [skillInstallation("skill-1", "skill-one")],
            availableSkills: [marketplaceSkill("imagegen", "Imagegen")],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      await selectTab(harness, "Skills");

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      expect(bodyText()).toContain("Skills available to install from your marketplaces.");
      expect(bodyText()).toContain("Imagegen");
      expect(bodyText()).toContain("Add marketplace");
      expect(bodyText()).toContain("Marketplace sources");
      expect(bodyText()).toContain("No marketplaces configured.");

      const installButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Install",
      );
      if (!(installButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing skill install button");
      }
      await act(async () => {
        installButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(installSkillsMock).toHaveBeenCalledWith(
        "https://skills.sh/example/skills/imagegen",
        "global",
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

  test("skills tab keeps the marketplace section with a compact empty state", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: { plugins: [], availablePlugins: [], warnings: [] },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [skillInstallation("skill-1", "skill-one")],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      await selectTab(harness, "Skills");

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("Everything from your marketplaces is installed.");
      expect(bodyText).toContain("Add marketplace");
      expect(bodyText).toContain("Marketplace sources");
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

  test("plugins tab shows the available section only when the marketplace has plugins", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [installedPlugin("alpha", "Alpha Plugin")],
            availablePlugins: [],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      expect(bodyText()).toContain("Alpha Plugin");
      // No available plugins: the marketplace section stays hidden entirely.
      expect(bodyText()).not.toContain("Available from marketplaces");

      await act(async () => {
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            "ws-1": {
              ...state.workspaceRuntimeById["ws-1"],
              pluginsCatalog: {
                plugins: [installedPlugin("alpha", "Alpha Plugin")],
                availablePlugins: [marketplacePlugin("cursor-team-kit", "Cursor Team Kit")],
                warnings: [],
              },
            },
          },
        }));
      });

      expect(bodyText()).toContain("Available from marketplaces");
      expect(bodyText()).toContain("Cursor Team Kit");
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

  test("search filters the available marketplace cards in both tabs", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [installedPlugin("alpha", "Alpha Plugin")],
            availablePlugins: [marketplacePlugin("cursor-team-kit", "Cursor Team Kit")],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [skillInstallation("skill-1", "skill-one")],
            availableSkills: [marketplaceSkill("imagegen", "Imagegen")],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      const searchInput = (label: string) => {
        const input = harness.dom.window.document.querySelector(`input[aria-label="${label}"]`);
        if (!(input instanceof harness.dom.window.HTMLInputElement)) {
          throw new Error(`missing search input ${label}`);
        }
        return input;
      };

      // Plugins tab: the query narrows both installed and available cards.
      expect(bodyText()).toContain("Alpha Plugin");
      expect(bodyText()).toContain("Cursor Team Kit");

      await act(async () => {
        setInputValue(harness, searchInput("Search plugins…"), "cursor");
      });
      expect(bodyText()).toContain("Cursor Team Kit");
      expect(bodyText()).not.toContain("Alpha Plugin");

      await act(async () => {
        setInputValue(harness, searchInput("Search plugins…"), "alpha");
      });
      expect(bodyText()).toContain("Alpha Plugin");
      expect(bodyText()).not.toContain("Available from marketplaces");
      expect(bodyText()).not.toContain("Cursor Team Kit");

      // Skills tab: the query narrows both installed and available cards.
      await selectTab(harness, "Skills");

      await act(async () => {
        setInputValue(harness, searchInput("Search skills…"), "imagegen");
      });
      expect(bodyText()).toContain("Imagegen");
      expect(bodyText()).not.toContain("skill-one");

      await act(async () => {
        setInputValue(harness, searchInput("Search skills…"), "skill-one");
      });
      expect(bodyText()).toContain("skill-one");
      expect(bodyText()).not.toContain("Imagegen");
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

  test("chat-only workspaces still anchor the catalog and marketplace installs", async () => {
    const previousState = useAppStore.getState();
    const installPluginsMock = mock(
      async (_sourceInput: string, _targetScope: "workspace" | "user") => {},
    );
    const installSkillsMock = mock(
      async (_sourceInput: string, _targetScope: "project" | "global") => {},
    );

    const chatWorkspace = {
      id: "chat-1",
      name: "New chat",
      path: "/tmp/home/.cowork/chats/chat-1",
      workspaceKind: "oneOffChat" as const,
      createdAt: "2026-06-02T00:00:00.000Z",
      lastOpenedAt: "2026-06-02T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: false,
      yolo: false,
    };

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [chatWorkspace],
      selectedWorkspaceId: "chat-1",
      installPlugins: installPluginsMock as typeof previousState.installPlugins,
      installSkills: installSkillsMock as typeof previousState.installSkills,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "chat-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [],
            availablePlugins: [marketplacePlugin("cursor-team-kit", "Cursor Team Kit")],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
            availableSkills: [marketplaceSkill("imagegen", "Imagegen")],
          },
        },
      },
    });

    // The store-side anchor used by plugin/skill actions resolves to the chat
    // workspace instead of null, so installs are no longer silent no-ops.
    expect(managementWorkspaceIdFor(useAppStore.getState)).toBe("chat-1");

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      expect(bodyText()).not.toContain("No workspaces yet");

      // The default Plugins tab surfaces the available marketplace plugin.
      expect(bodyText()).toContain("Available from marketplaces");
      expect(bodyText()).toContain("Cursor Team Kit");

      const findInstallButtons = () =>
        Array.from(harness.dom.window.document.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Install",
        );
      const pluginInstallButtons = findInstallButtons();
      expect(pluginInstallButtons).toHaveLength(1);
      const pluginInstall = pluginInstallButtons[0];
      if (!(pluginInstall instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing plugin install button");
      }
      await act(async () => {
        pluginInstall.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(installPluginsMock).toHaveBeenCalledWith(
        "https://github.com/example/cowork-plugins/tree/main/plugins/cursor-team-kit",
        "user",
      );

      // The Skills tab surfaces the available marketplace skill.
      await selectTab(harness, "Skills");
      expect(bodyText()).toContain("Imagegen");

      const skillInstallButtons = findInstallButtons();
      expect(skillInstallButtons).toHaveLength(1);
      const skillInstall = skillInstallButtons[0];
      if (!(skillInstall instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing skill install button");
      }
      await act(async () => {
        skillInstall.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(installSkillsMock).toHaveBeenCalledWith(
        "https://skills.sh/example/skills/imagegen",
        "global",
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

  test("marketplace install button attaches a rejection handler for failed installs", async () => {
    const previousState = useAppStore.getState();
    let rejectionHandled = false;
    const installPluginsMock = mock(
      (_sourceInput: string, _targetScope: "workspace" | "user") =>
        ({
          catch(onRejected?: (error: unknown) => void) {
            rejectionHandled = typeof onRejected === "function";
            return Promise.resolve();
          },
        }) as unknown as Promise<void>,
    );

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [projectWorkspace("ws-1")],
      selectedWorkspaceId: "ws-1",
      installPlugins: installPluginsMock as typeof previousState.installPlugins,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [],
            availablePlugins: [marketplacePlugin("cursor-team-kit", "Cursor Team Kit")],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessTabs));
      });

      // The available plugin card renders on the default Plugins tab.
      const installButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Install",
      );
      if (!(installButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing marketplace install button");
      }

      await act(async () => {
        installButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(installPluginsMock).toHaveBeenCalledWith(
        "https://github.com/example/cowork-plugins/tree/main/plugins/cursor-team-kit",
        "user",
      );
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
  });

  test("no-workspace state keeps the tab shell with catalog empty states", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      ...catalogActionMocks(previousState),
      workspaces: [],
      selectedWorkspaceId: null,
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      const AnchorHarness = () => {
        const workspaceId = useToolAccessCatalogWorkspaceId();
        return createElement(
          "div",
          null,
          createElement("span", null, workspaceId ?? "anchor-null"),
          createElement(ToolAccessTabs),
        );
      };

      await act(async () => {
        root.render(createElement(AnchorHarness));
      });

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("anchor-null");
      expect(findTab(harness, "Plugins")).toBeDefined();
      expect(bodyText).toContain("No workspaces yet");
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
