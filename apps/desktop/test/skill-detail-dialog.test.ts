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

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {
    connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

mock.module("streamdown", () => ({
  Streamdown: ({ children }: { children: unknown }) => createElement("div", null, children),
}));

mock.module("lucide-react", () => ({
  ExternalLinkIcon: () => createElement("span", null, "icon"),
}));

mock.module("../src/components/ui/badge", () => ({
  Badge: ({ children }: { children: unknown }) => createElement("span", null, children),
}));

mock.module("../src/components/ui/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) => createElement("button", props, children),
}));

mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: unknown }) => createElement("div", null, children),
  DialogContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  DialogHeader: ({ children }: { children: unknown }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: unknown }) => createElement("h2", null, children),
  DialogDescription: ({ children }: { children: unknown }) => createElement("p", null, children),
}));

mock.module("../src/ui/skills/utils", () => ({
  actionPending: () => false,
  normalizeDisplayContent: (value: string | null) => value,
  scopeLabel: (scope: string) => scope,
  skillSourceLabel: (source: string) => source,
  stateTone: () => "secondary",
  SkillIcon: ({ icon }: { icon: string }) => createElement("span", null, icon),
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
          selectedSkillContent: "# Example skill",
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

      await act(async () => {
        root.render(createElement(SkillDetailDialog, { workspaceId: "ws-1" }));
      });

      const openFolderButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Open folder"),
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
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
