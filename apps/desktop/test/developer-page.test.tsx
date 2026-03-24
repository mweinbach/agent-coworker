import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
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
}));

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } = await import("../src/lib/wsProtocol");
const { DeveloperPage } = await import("../src/ui/settings/pages/DeveloperPage");

const defaultStoreActions = {
  updateWorkspaceDefaults: useAppStore.getState().updateWorkspaceDefaults,
};

describe("desktop developer page", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("renders workspace spill-file controls for tool output overflow", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultPreferredChildModel: "gpt-5.2",
              defaultToolOutputOverflowChars: 12000,
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      expect(container.textContent).toContain("Large Tool Output Handling");
      expect(container.textContent).toContain("Save oversized tool output to scratch files");
      expect(container.textContent).toContain("Spill after this many characters");
      expect(container.textContent).toContain("Cowork keeps a fixed inline preview");
      expect(container.textContent).toContain("first 5,000 characters inline");
      expect(container.textContent).toContain("Set the threshold to 0 to spill immediately");
      expect(container.textContent).toContain("Workspace 1");
      expect(container.textContent).toContain("/tmp/workspace-1");
      expect(container.innerHTML).toContain('value="12000"');

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("inherit default clears the persisted overflow override instead of pinning 25000", async () => {
    const updateWorkspaceDefaults = mock(async () => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultPreferredChildModel: "gpt-5.2",
              defaultToolOutputOverflowChars: 12000,
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          updateWorkspaceDefaults,
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Inherit default"));
      if (!button) throw new Error("missing inherit default button");

      await act(async () => {
        button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(updateWorkspaceDefaults).toHaveBeenCalledWith("ws-1", {
        clearDefaultToolOutputOverflowChars: true,
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("uses the inherited runtime overflow threshold when the workspace override is unset", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultPreferredChildModel: "gpt-5.2",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          workspaceRuntimeById: {
            "ws-1": {
              controlSessionConfig: {
                toolOutputOverflowChars: 12000,
              },
            } as any,
          },
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      const checkbox = container.querySelector('[aria-label="Save oversized tool output to scratch files"]');
      if (!(checkbox instanceof harness.dom.window.HTMLElement)) throw new Error("missing overflow checkbox");
      const thresholdInput = container.querySelector('[aria-label="Spill after this many characters"]');
      if (!(thresholdInput instanceof harness.dom.window.HTMLInputElement)) throw new Error("missing threshold input");
      const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Inherit default"));
      if (!button) throw new Error("missing inherit default button");

      expect(checkbox.hasAttribute("aria-label")).toBe(true);
      expect(thresholdInput.disabled).toBe(false);
      expect(thresholdInput.value).toBe("12000");
      expect(button.hasAttribute("disabled")).toBe(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("enable default restores inherited overflow behavior from a disabled workspace override", async () => {
    const updateWorkspaceDefaults = mock(async () => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultPreferredChildModel: "gpt-5.2",
              defaultToolOutputOverflowChars: null,
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          updateWorkspaceDefaults,
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Enable default"));
      if (!button) throw new Error("missing enable default button");

      await act(async () => {
        button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(updateWorkspaceDefaults).toHaveBeenCalledWith("ws-1", {
        clearDefaultToolOutputOverflowChars: true,
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("enable default writes the built-in threshold when the inherited runtime default is disabled", async () => {
    const updateWorkspaceDefaults = mock(async () => {});
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultPreferredChildModel: "gpt-5.2",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          workspaceRuntimeById: {
            "ws-1": {
              controlSessionConfig: {
                toolOutputOverflowChars: null,
              },
            } as any,
          },
          updateWorkspaceDefaults,
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      const checkbox = container.querySelector('[aria-label="Save oversized tool output to scratch files"]');
      if (!(checkbox instanceof harness.dom.window.HTMLElement)) throw new Error("missing overflow checkbox");
      const thresholdInput = container.querySelector('[aria-label="Spill after this many characters"]');
      if (!(thresholdInput instanceof harness.dom.window.HTMLInputElement)) throw new Error("missing threshold input");
      const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Enable default"));
      if (!button) throw new Error("missing enable default button");

      expect(checkbox.hasAttribute("aria-label")).toBe(true);
      expect(thresholdInput.disabled).toBe(true);
      expect(thresholdInput.value).toBe(String(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS));

      await act(async () => {
        button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(updateWorkspaceDefaults).toHaveBeenCalledWith("ws-1", {
        defaultToolOutputOverflowChars: DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS,
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
