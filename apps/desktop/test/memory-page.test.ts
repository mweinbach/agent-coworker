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
  openPath: async () => {},
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
  AgentSocket: class {
    connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

const {
  MEMORY_LOADING_STALL_MS,
  MemoryPage,
  isMemoryLoadStalled,
  resolveDraftMemoryId,
} = await import("../src/ui/settings/pages/MemoryPage");
const { useAppStore } = await import("../src/app/store");

describe("desktop memory page", () => {
  test("blank ids resolve to the prompt-loaded hot cache entry", () => {
    expect(resolveDraftMemoryId("")).toBe("hot");
    expect(resolveDraftMemoryId("   ")).toBe("hot");
    expect(resolveDraftMemoryId(" AGENT.md ")).toBe("AGENT.md");
    expect(resolveDraftMemoryId("people/sarah")).toBe("people/sarah");
  });

  test("stalled empty memory loads fall back to the empty state instead of spinning forever", async () => {
    const previousState = useAppStore.getState();
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-03-13T00:00:00.000Z",
          lastOpenedAt: "2026-03-13T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        "ws-1": {
          serverUrl: "ws://mock",
          starting: false,
          error: null,
          controlSessionId: "control-session",
          controlConfig: null,
          controlSessionConfig: null,
          controlEnableMcp: true,
          mcpServers: [],
          mcpLegacy: null,
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          selectedSkillName: null,
          selectedSkillContent: null,
          memories: [],
          memoriesLoading: true,
          workspaceBackupsPath: null,
          workspaceBackups: [],
          workspaceBackupsLoading: false,
          workspaceBackupsError: null,
          workspaceBackupPendingActionKeys: {},
          workspaceBackupDelta: null,
          workspaceBackupDeltaLoading: false,
          workspaceBackupDeltaError: null,
        },
      },
      requestWorkspaceMemories: mock(async () => {}),
    });

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(MemoryPage));
      });

      expect(container.textContent).toContain("Loading...");
      expect(container.textContent).not.toContain("No memories yet");

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, MEMORY_LOADING_STALL_MS + 100));
      });

      expect(container.textContent).toContain("No memories yet");
      expect(container.textContent).not.toContain("Loading...");
      expect(container.textContent).toContain("Refresh");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("memory loading stall helper only trips after the grace period", () => {
    expect(isMemoryLoadStalled(false, Date.now(), Date.now())).toBe(false);
    expect(isMemoryLoadStalled(true, null, Date.now())).toBe(false);
    expect(isMemoryLoadStalled(true, 1000, 1000 + MEMORY_LOADING_STALL_MS - 1)).toBe(false);
    expect(isMemoryLoadStalled(true, 1000, 1000 + MEMORY_LOADING_STALL_MS)).toBe(true);
  });
});
