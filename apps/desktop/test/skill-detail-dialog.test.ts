import { describe, expect, mock, test } from "bun:test";
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

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { SkillDetailDialog } = await import("../src/ui/skills/SkillDetailDialog");

describe("skill detail dialog", () => {
  test("reveals the installation folder for non-workspace skills", async () => {
    openPathMock.mockClear();
    revealPathMock.mockClear();

    const previousState = useAppStore.getState();
    const installationRoot = "/home/test/.cowork/skills/example-skill";

    useAppStore.setState({
      workspaceRuntimeById: {
        "ws-1": {
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
    });

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      // Verify store state is correct before render
      const storeState = useAppStore.getState();
      const rt = storeState.workspaceRuntimeById["ws-1"];
      if (!rt) {
        throw new Error(`store has no ws-1 runtime. keys: ${Object.keys(storeState.workspaceRuntimeById).join(",")}`);
      }
      if (!rt.selectedSkillInstallation) {
        throw new Error(`ws-1 runtime has no selectedSkillInstallation. installationId: ${rt.selectedSkillInstallationId}`);
      }

      // Verify basic React rendering works in this JSDOM
      await act(async () => {
        root.render(createElement("div", { id: "canary" }, "hello"));
      });
      const canary = harness.dom.window.document.getElementById("canary");
      if (!canary) {
        throw new Error("React basic render failed: canary div not found in JSDOM");
      }

      // Render SkillDetailDialog inside a wrapper that also dumps debug state
      function Wrapper() {
        const wsRtById2 = useAppStore((s) => s.workspaceRuntimeById);
        const rt2 = wsRtById2["ws-1"];
        const installationId = rt2?.selectedSkillInstallationId ?? "null";
        const hasInstallation = rt2?.selectedSkillInstallation ? "yes" : "no";
        const selectedName = rt2?.selectedSkillName ?? "null";
        return createElement("div", null,
          createElement("div", { id: "wrapper-debug" },
            `id=${installationId}|inst=${hasInstallation}|name=${selectedName}`
          ),
          createElement(SkillDetailDialog, { workspaceId: "ws-1" }),
        );
      }

      await act(async () => {
        root.render(createElement(Wrapper));
      });

      const debugEl = harness.dom.window.document.getElementById("wrapper-debug");
      const debugText = debugEl?.textContent ?? "(wrapper-debug missing)";

      const openFolderButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Open folder"),
      );

      if (!openFolderButton) {
        const html = harness.dom.window.document.getElementById("root")?.innerHTML ?? "(empty)";
        throw new Error(
          `missing open folder button.` +
          ` wrapperDebug: ${debugText}` +
          ` | DOM: ${html.slice(0, 500)}`
        );
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
      useAppStore.setState(previousState);
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

    useAppStore.setState({
      deleteSkillInstallation: deleteSkillInstallationMock as typeof previousState.deleteSkillInstallation,
      selectSkillInstallation: selectSkillInstallationMock as typeof previousState.selectSkillInstallation,
      workspaceRuntimeById: {
        "ws-1": {
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
    });

    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(SkillDetailDialog, { workspaceId: "ws-1" }));
      });

      const uninstallButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Uninstall"),
      );

      if (!uninstallButton) {
        const html = harness.dom.window.document.getElementById("root")?.innerHTML ?? "(empty)";
        throw new Error(`missing uninstall button. DOM: ${html.slice(0, 500)}`);
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
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
