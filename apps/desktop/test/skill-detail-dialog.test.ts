import { beforeEach, describe, expect, mock, test } from "bun:test";
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
  release: null,
  progress: null,
  error: null,
};

const openPathMock = mock(async () => {});
const revealPathMock = mock(async () => {});

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
  openPath: openPathMock,
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

mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: unknown }) => createElement("div", null, children),
  DialogContent: ({ children, ...props }: Record<string, unknown>) => createElement("div", props, children),
  DialogHeader: ({ children, ...props }: Record<string, unknown>) => createElement("div", props, children),
  DialogTitle: ({ children, ...props }: Record<string, unknown>) => createElement("h2", props, children),
  DialogDescription: ({ children, ...props }: Record<string, unknown>) => createElement("p", props, children),
}));

const { reactivateWorkspaceJsonRpcState } = await import("../src/app/store.helpers");
const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { SkillDetailDialog } = await import("../src/ui/skills/SkillDetailDialog");

/** Avoid `ws-1`, which many desktop tests use concurrently under `bun test --max-concurrency`. */
const SKILL_DETAIL_WORKSPACE_ID = "ws-skill-detail-dialog";

describe("skill detail dialog", () => {
  beforeEach(() => {
    reactivateWorkspaceJsonRpcState(SKILL_DETAIL_WORKSPACE_ID);
  });

  test("reveals the installation folder for non-workspace skills", async () => {
    openPathMock.mockClear();
    revealPathMock.mockClear();

    const installationRoot = "/home/test/.cowork/skills/example-skill";

    useAppStore.setState((state) => ({
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [SKILL_DETAIL_WORKSPACE_ID]: {
          ...defaultWorkspaceRuntime(),
          selectedSkillContent: null,
          selectedSkillInstallationId: "skill-1",
          selectedSkillInstallation: {
            installationId: "skill-1",
            name: "example-skill",
            description: "Example skill",
            scope: "global",
            enabled: true,
            writable: false,
            managed: false,
            effective: true,
            state: "effective",
            rootDir: installationRoot,
            skillPath: `${installationRoot}/SKILL.md`,
            path: `${installationRoot}/SKILL.md`,
            triggers: [],
            descriptionSource: "unknown",
            diagnostics: [],
          },
        },
      },
    }));

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(SkillDetailDialog, { workspaceId: SKILL_DETAIL_WORKSPACE_ID }));
      });

      const openFolderButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find((button) =>
        (button.textContent ?? "").includes("Open folder"),
      );

      if (!openFolderButton) {
        throw new Error("missing open folder button");
      }

      await act(async () => {
        openFolderButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(revealPathMock).toHaveBeenCalledTimes(1);
      expect(revealPathMock).toHaveBeenCalledWith({ path: installationRoot });
      expect(openPathMock).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState((state) => {
        const { [SKILL_DETAIL_WORKSPACE_ID]: _, ...rest } = state.workspaceRuntimeById;
        return { workspaceRuntimeById: rest };
      });
      harness.restore();
    }
  });

  test("uninstall does not clear the selected installation before the delete response returns", async () => {
    openPathMock.mockClear();
    revealPathMock.mockClear();

    const previousState = useAppStore.getState();
    const deleteSkillInstallationMock = mock(async () => {});
    const selectSkillInstallationMock = mock(async () => {});
    const installationRoot = "/home/test/.cowork/skills/example-skill";

    useAppStore.setState((state) => ({
      deleteSkillInstallation: deleteSkillInstallationMock as typeof previousState.deleteSkillInstallation,
      selectSkillInstallation: selectSkillInstallationMock as typeof previousState.selectSkillInstallation,
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [SKILL_DETAIL_WORKSPACE_ID]: {
          ...defaultWorkspaceRuntime(),
          selectedSkillContent: null,
          selectedSkillInstallationId: "skill-1",
          selectedSkillInstallation: {
            installationId: "skill-1",
            name: "example-skill",
            description: "Example skill",
            scope: "project",
            enabled: true,
            writable: true,
            managed: true,
            effective: true,
            state: "effective",
            rootDir: installationRoot,
            skillPath: `${installationRoot}/SKILL.md`,
            path: `${installationRoot}/SKILL.md`,
            triggers: [],
            descriptionSource: "unknown",
            diagnostics: [],
          },
        },
      },
    }));

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(SkillDetailDialog, { workspaceId: SKILL_DETAIL_WORKSPACE_ID }));
      });

      const uninstallButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find((button) =>
        (button.textContent ?? "").includes("Uninstall"),
      );

      if (!uninstallButton) {
        throw new Error("missing uninstall button");
      }

      await act(async () => {
        uninstallButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(deleteSkillInstallationMock).toHaveBeenCalledTimes(1);
      expect(deleteSkillInstallationMock).toHaveBeenCalledWith("skill-1");
      expect(selectSkillInstallationMock).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState((state) => {
        const { [SKILL_DETAIL_WORKSPACE_ID]: _, ...rest } = state.workspaceRuntimeById;
        return { workspaceRuntimeById: rest };
      });
      harness.restore();
    }
  });
});
