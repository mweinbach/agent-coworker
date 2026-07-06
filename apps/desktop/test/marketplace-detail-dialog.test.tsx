import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { MarketplaceDetail, MarketplacesListEntry } from "../src/app/types";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const confirmActionMock = mock(async () => true);
const openExternalUrlMock = mock(async (_opts: { url: string }) => {});

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    confirmAction: confirmActionMock,
    openExternalUrl: openExternalUrlMock,
  }),
);

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { MarketplaceDetailDialog } = await import(
  "../src/ui/settings/toolAccess/MarketplaceDetailDialog"
);
mock.restore();

const workspaceId = "ws-marketplace-detail";

const builtInSource: MarketplacesListEntry = {
  id: "mweinbach/cowork-skills-plugins",
  repo: "mweinbach/cowork-skills-plugins",
  ref: "main",
  url: "https://github.com/mweinbach/cowork-skills-plugins/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: true,
  displayName: "Cowork Marketplace",
  pluginCount: 2,
  skillCount: 1,
};

const customSource: MarketplacesListEntry = {
  id: "acme/cowork-extras",
  repo: "acme/cowork-extras",
  ref: "main",
  url: "https://github.com/acme/cowork-extras/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: false,
  displayName: "Acme Extras",
  pluginCount: 0,
  skillCount: 0,
  addedAt: "2026-07-01T00:00:00.000Z",
};

const builtInDetail: MarketplaceDetail = {
  source: builtInSource,
  plugins: [
    {
      name: "workspace-tools",
      displayName: "Workspace Tools",
      category: "Productivity",
      installed: true,
      enabled: true,
      skills: ["documents", "spreadsheets"],
      mcpServers: ["workspace-tools-server"],
    },
    {
      name: "figma-toolkit",
      displayName: "Figma Toolkit",
      category: "Design",
      installed: false,
      installSource:
        "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit",
      skills: [],
      mcpServers: [],
    },
  ],
  skills: [
    {
      name: "create-skill",
      displayName: "Create Skill",
      category: "Authoring",
      installed: false,
      installSource:
        "https://github.com/mweinbach/cowork-skills-plugins/tree/main/skills/create-skill",
    },
  ],
  connectors: [
    {
      name: "workspace-tools-server",
      pluginName: "workspace-tools",
      pluginDisplayName: "Workspace Tools",
      installed: true,
    },
  ],
};

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

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function clickButton(harness: ReturnType<typeof setupJsdom>, button: Element | undefined | null) {
  if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
    throw new Error("missing button");
  }
  button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
}

function findButtonsByLabel(harness: ReturnType<typeof setupJsdom>, label: string) {
  return Array.from(harness.dom.window.document.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  );
}

describe("marketplace detail dialog", () => {
  test("renders sections with installed state and dispatches installs", async () => {
    const previousState = useAppStore.getState();
    const installPluginsMock = mock(
      async (_sourceInput: string, _scope: "workspace" | "user") => {},
    );
    const installSkillsMock = mock(
      async (_sourceInput: string, _scope: "project" | "global") => {},
    );
    const readMarketplaceDetailMock = mock(async (_id: string, _workspaceId?: string) => {});
    openExternalUrlMock.mockClear();

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      installPlugins: installPluginsMock as typeof previousState.installPlugins,
      installSkills: installSkillsMock as typeof previousState.installSkills,
      readMarketplaceDetail:
        readMarketplaceDetailMock as typeof previousState.readMarketplaceDetail,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          marketplaces: [builtInSource],
          selectedMarketplaceId: builtInSource.id,
          selectedMarketplaceDetail: builtInDetail,
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceDetailDialog, { workspaceId }));
        await flushUi();
      });

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("Cowork Marketplace");
      expect(bodyText).toContain("Built-in");
      expect(bodyText).toContain("mweinbach/cowork-skills-plugins");
      expect(bodyText).toContain("main");
      expect(bodyText).toContain("Open on GitHub");
      expect(bodyText).toContain("Plugins");
      expect(bodyText).toContain("Workspace Tools");
      expect(bodyText).toContain("Productivity");
      expect(bodyText).toContain("Installed");
      expect(bodyText).toContain("Enabled");
      expect(bodyText).toContain("Figma Toolkit");
      expect(bodyText).toContain("Skills");
      expect(bodyText).toContain("Create Skill");
      expect(bodyText).toContain("Connectors");
      expect(bodyText).toContain("workspace-tools-server");
      expect(bodyText).toContain("via Workspace Tools");
      // The built-in marketplace cannot be removed.
      expect(findButtonsByLabel(harness, "Remove marketplace")).toHaveLength(0);

      // One Install button per uninstalled entry: figma-toolkit then create-skill.
      const installButtons = findButtonsByLabel(harness, "Install");
      expect(installButtons).toHaveLength(2);

      await act(async () => {
        clickButton(harness, installButtons[0]);
        await flushUi();
      });
      expect(installPluginsMock).toHaveBeenCalledWith(
        "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit",
        "user",
      );
      expect(readMarketplaceDetailMock).toHaveBeenCalledWith(builtInSource.id);

      await act(async () => {
        clickButton(harness, findButtonsByLabel(harness, "Install")[1]);
        await flushUi();
      });
      expect(installSkillsMock).toHaveBeenCalledWith(
        "https://github.com/mweinbach/cowork-skills-plugins/tree/main/skills/create-skill",
        "global",
      );
      expect(readMarketplaceDetailMock).toHaveBeenCalledTimes(2);

      const githubButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Open on GitHub"),
      );
      await act(async () => {
        clickButton(harness, githubButton);
      });
      expect(openExternalUrlMock).toHaveBeenCalledWith({ url: builtInSource.url });
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

  test("shows the connectors empty state and removes user-added marketplaces", async () => {
    const previousState = useAppStore.getState();
    const removeMarketplaceMock = mock(async (_id: string) => {});
    const selectMarketplaceMock = mock(async (_id: string | null) => {});
    confirmActionMock.mockClear();
    confirmActionMock.mockResolvedValue(true);

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      removeMarketplace: removeMarketplaceMock as typeof previousState.removeMarketplace,
      selectMarketplace: selectMarketplaceMock as typeof previousState.selectMarketplace,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          marketplaces: [customSource],
          selectedMarketplaceId: customSource.id,
          selectedMarketplaceDetail: {
            source: customSource,
            plugins: [],
            skills: [],
            connectors: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceDetailDialog, { workspaceId }));
        await flushUi();
      });

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("Acme Extras");
      expect(bodyText).toContain(
        "Connectors appear here once a plugin that provides them is installed.",
      );
      // Empty plugin/skill manifests omit their sections entirely.
      expect(bodyText).not.toContain("Install");

      const removeButtons = findButtonsByLabel(harness, "Remove marketplace");
      expect(removeButtons).toHaveLength(1);

      await act(async () => {
        clickButton(harness, removeButtons[0]);
        await flushUi();
      });

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(removeMarketplaceMock).toHaveBeenCalledWith(customSource.id);
      // A successful remove closes the dialog.
      expect(selectMarketplaceMock).toHaveBeenCalledWith(null);
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

  test("renders the loading skeleton, then the inline error with retry", async () => {
    const previousState = useAppStore.getState();
    const readMarketplaceDetailMock = mock(async (_id: string, _workspaceId?: string) => {});

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      readMarketplaceDetail:
        readMarketplaceDetailMock as typeof previousState.readMarketplaceDetail,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          marketplaces: [customSource],
          selectedMarketplaceId: customSource.id,
          selectedMarketplaceDetail: null,
          marketplaceDetailLoading: true,
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceDetailDialog, { workspaceId }));
        await flushUi();
      });

      // The cached list entry still labels the dialog while the detail loads.
      expect(harness.dom.window.document.body.textContent ?? "").toContain("Acme Extras");
      expect(
        harness.dom.window.document.querySelectorAll("[data-slot='skeleton']").length,
      ).toBeGreaterThan(0);

      const errorMessage = 'Failed to read marketplace: Marketplace "acme/gone" is not configured.';
      await act(async () => {
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [workspaceId]: {
              ...state.workspaceRuntimeById[workspaceId],
              marketplaceDetailLoading: false,
              marketplaceDetailError: errorMessage,
            },
          },
        }));
        await flushUi();
      });

      expect(harness.dom.window.document.body.textContent ?? "").toContain(errorMessage);
      expect(harness.dom.window.document.querySelectorAll("[data-slot='skeleton']").length).toBe(0);

      const retryButton = findButtonsByLabel(harness, "Retry")[0];
      await act(async () => {
        clickButton(harness, retryButton);
        await flushUi();
      });
      expect(readMarketplaceDetailMock).toHaveBeenCalledWith(customSource.id);
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
