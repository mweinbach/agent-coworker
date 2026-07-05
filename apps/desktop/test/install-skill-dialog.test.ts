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
} = await import("../src/ui/settings/toolAccess/InstallSkillDialog");
mock.restore();

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("install skill dialog", () => {
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

  test("install dialog hides project-scope targets for one-off chat anchors", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "New chat",
          path: "/tmp/home/.cowork/chats/chat-1",
          workspaceKind: "oneOffChat",
          createdAt: "2026-03-30T00:00:00.000Z",
          lastOpenedAt: "2026-03-30T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        "ws-1": defaultWorkspaceRuntime(),
      },
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
          }),
        );
      });

      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText).toContain("Install skill from source");
      expect(dialogText).not.toContain("Preview in Workspace");
      expect(dialogText).not.toContain("Install to Workspace");
      expect(dialogText).toContain("Preview in Library");
      expect(dialogText).toContain("Install to Cowork Library");
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
});
