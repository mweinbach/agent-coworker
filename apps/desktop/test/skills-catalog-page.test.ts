import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
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

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const {
  InstallSkillDialog,
  shouldDisableSkillInstallForScope,
  shouldRequireFreshSkillPreviewForScope,
} = await import("../src/ui/skills/InstallSkillDialog");
const { SkillsCatalogPage } = await import("../src/ui/skills/SkillsCatalogPage");
mock.restore();

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("skills catalog page", () => {
  test("install dialog requires a fresh preview when switching install scope", () => {
    const preview = {
      source: {
        kind: "github_shorthand" as const,
        raw: "owner/repo",
        displaySource: "https://github.com/owner/repo",
        url: "https://github.com/owner/repo",
        repo: "owner/repo",
      },
      targetScope: "project" as const,
      candidates: [],
      warnings: [],
    };

    expect(
      shouldRequireFreshSkillPreviewForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "project",
        skillPreview: preview,
        targetScope: "project",
      }),
    ).toBe(false);

    expect(
      shouldRequireFreshSkillPreviewForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "project",
        skillPreview: preview,
        targetScope: "global",
      }),
    ).toBe(true);
  });

  test("install dialog disables install when the active preview has no valid skill candidates", () => {
    const invalidPreview = {
      source: {
        kind: "github_shorthand" as const,
        raw: "owner/repo",
        displaySource: "https://github.com/owner/repo",
        url: "https://github.com/owner/repo",
        repo: "owner/repo",
      },
      targetScope: "project" as const,
      candidates: [
        {
          name: "broken-skill",
          description: "Broken skill",
          relativeRootPath: ".",
          wouldBeEffective: true,
          shadowedInstallationIds: [],
          diagnostics: [
            {
              code: "missing_skill_md",
              severity: "error" as const,
              message: "Missing SKILL.md",
            },
          ],
        },
      ],
      warnings: [],
    };

    expect(
      shouldDisableSkillInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "project",
        skillPreview: invalidPreview,
        targetScope: "project",
        skillInstallInFlight: false,
        mutationBlocked: false,
      }),
    ).toBe(true);

    expect(
      shouldDisableSkillInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "project",
        skillPreview: invalidPreview,
        targetScope: "global",
        skillInstallInFlight: false,
        mutationBlocked: false,
      }),
    ).toBe(true);

    const validPreview = {
      ...invalidPreview,
      candidates: [
        {
          ...invalidPreview.candidates[0],
          diagnostics: [],
        },
      ],
    };

    expect(
      shouldDisableSkillInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "project",
        skillPreview: validPreview,
        targetScope: "project",
        skillInstallInFlight: false,
        mutationBlocked: false,
      }),
    ).toBe(false);
  });

  test("install dialog renders skill previews and labels the source field", async () => {
    const previousState = useAppStore.getState();
    const preview = {
      source: {
        kind: "github_shorthand" as const,
        raw: "owner/repo",
        displaySource: "https://github.com/owner/repo",
        url: "https://github.com/owner/repo",
        repo: "owner/repo",
      },
      targetScope: "project" as const,
      candidates: [
        {
          name: "imagegen",
          description: "Generate images",
          relativeRootPath: "skills/imagegen",
          wouldBeEffective: true,
          shadowedInstallationIds: [],
          diagnostics: [],
        },
      ],
      warnings: [],
    };
    const previewSkillInstall = mock(
      async (sourceInput: string, targetScope: "project" | "global") => {
        expect(sourceInput).toBe("owner/repo");
        expect(targetScope).toBe("project");
        const state = useAppStore.getState();
        useAppStore.setState({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            "ws-1": {
              ...state.workspaceRuntimeById["ws-1"],
              selectedSkillPreview: preview,
              skillMutationPendingKeys: {},
            },
          },
        } as any);
      },
    );
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          selectedSkillPreview: null,
          skillMutationPendingKeys: {},
        },
      },
      previewSkillInstall,
      installSkills: mock(async () => {}),
    } as any);

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(
          createElement(InstallSkillDialog, {
            workspaceId: "ws-1",
            initialOpen: true,
            initialSourceInput: "owner/repo",
          }),
        );
      });

      const doc = harness.dom.window.document;
      expect(doc.querySelector('textarea[aria-label="Skill source"]')).not.toBeNull();
      const previewButton = Array.from(doc.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Preview in Workspace"),
      );
      expect(previewButton).toBeDefined();

      await act(async () => {
        previewButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      await flushUi();

      expect(previewSkillInstall).toHaveBeenCalled();
      expect(doc.body.textContent).toContain("1 skill ready");
      expect(doc.body.textContent).toContain("Previewed for workspace install.");
      expect(doc.body.textContent).toContain("imagegen");
      expect(doc.body.textContent).toContain("skills/imagegen");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows a loading state while the catalog is loading", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          skillsCatalog: null,
          skillCatalogLoading: true,
        },
      },
    });

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SkillsCatalogPage, {
            workspaceId: "ws-1",
            searchQuery: "",
            setSearchQuery: () => {},
          }),
        );
      });

      expect(container.firstElementChild?.className).toContain("app-skills-view");
      expect(container.firstElementChild?.className).not.toContain("bg-background");
      expect(container.textContent).toContain("Loading...");
      expect(container.textContent).toContain("Fetching skills catalog.");
      expect(container.textContent).not.toContain("No skills found");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows the empty state after loading completes with no installations", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
          },
          skillCatalogLoading: false,
        },
      },
    });

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SkillsCatalogPage, {
            workspaceId: "ws-1",
            searchQuery: "",
            setSearchQuery: () => {},
          }),
        );
      });

      expect(container.textContent).toContain("No skills found");
      expect(container.textContent).toContain("Install a skill to give Codex superpowers.");
      expect(container.textContent).not.toContain("Loading...");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows inline error state when the skills catalog refresh fails", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          skillsCatalog: null,
          skillCatalogLoading: false,
          skillCatalogError: "Unable to refresh skills catalog.",
        },
      },
      refreshSkillsCatalog: async () => {},
    } as any);

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SkillsCatalogPage, {
            workspaceId: "ws-1",
            searchQuery: "",
            setSearchQuery: () => {},
          }),
        );
      });

      expect(container.textContent).toContain("Connection issue");
      expect(container.textContent).toContain("Unable to refresh skills catalog.");
      expect(container.textContent).toContain("Retry");
      expect(container.textContent).not.toContain("No skills found");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows user-scoped plugin skills in the Global view", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [
              {
                installationId: "plugin:figma-toolkit:import-frame",
                name: "figma-toolkit:import-frame",
                description: "Import a frame",
                scope: "user",
                enabled: true,
                writable: false,
                managed: false,
                effective: true,
                state: "effective",
                rootDir: "/tmp/home/.agents/plugins/figma-toolkit/skills/import-frame",
                skillPath: "/tmp/home/.agents/plugins/figma-toolkit/skills/import-frame/SKILL.md",
                path: "/tmp/home/.agents/plugins/figma-toolkit/skills/import-frame/SKILL.md",
                triggers: ["import-frame"],
                descriptionSource: "frontmatter",
                plugin: {
                  pluginId: "figma-toolkit",
                  name: "figma-toolkit",
                  displayName: "Figma Toolkit",
                  scope: "user",
                  discoveryKind: "direct",
                  rootDir: "/tmp/home/.agents/plugins/figma-toolkit",
                },
              },
            ],
          },
          skillCatalogLoading: false,
        },
      },
    } as any);

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SkillsCatalogPage, {
            workspaceId: "ws-1",
            managementScope: "global",
            searchQuery: "",
            setSearchQuery: () => {},
          }),
        );
      });

      expect(container.textContent).toContain("figma-toolkit:import-frame");
      expect(container.textContent).toContain("Figma Toolkit");
      expect(container.textContent).not.toContain("No skills found");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows standalone user-scoped skills in the Global view", async () => {
    const previousState = useAppStore.getState();

    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [
              {
                installationId: "user:custom-toolkit",
                name: "custom-toolkit",
                description: "Reusable user skill",
                scope: "user",
                enabled: true,
                writable: false,
                managed: false,
                effective: true,
                state: "effective",
                rootDir: "/tmp/home/.cowork/skills/custom-toolkit",
                skillPath: "/tmp/home/.cowork/skills/custom-toolkit/SKILL.md",
                path: "/tmp/home/.cowork/skills/custom-toolkit/SKILL.md",
                triggers: ["custom-toolkit"],
                descriptionSource: "frontmatter",
                diagnostics: [],
              },
              {
                installationId: "project:local-only",
                name: "local-only",
                description: "Workspace-only skill",
                scope: "project",
                enabled: true,
                writable: true,
                managed: false,
                effective: true,
                state: "effective",
                rootDir: "/tmp/workspace/.cowork/skills/local-only",
                skillPath: "/tmp/workspace/.cowork/skills/local-only/SKILL.md",
                path: "/tmp/workspace/.cowork/skills/local-only/SKILL.md",
                triggers: ["local-only"],
                descriptionSource: "frontmatter",
                diagnostics: [],
              },
            ],
          },
          skillCatalogLoading: false,
        },
      },
    } as any);

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SkillsCatalogPage, {
            workspaceId: "ws-1",
            managementScope: "global",
            searchQuery: "",
            setSearchQuery: () => {},
          }),
        );
      });

      expect(container.textContent).toContain("custom-toolkit");
      expect(container.textContent).not.toContain("local-only");
      expect(container.textContent).not.toContain("No skills found");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
