import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

const { OpenAiCompatibleModelSettingsCard } = await import("../src/ui/settings/pages/WorkspacesPage");

describe("desktop workspaces page", () => {
  test("renders workspace controls for openai-compatible verbosity, reasoning effort, and reasoning summary", () => {
    const html = renderToStaticMarkup(
      createElement(OpenAiCompatibleModelSettingsCard, {
        workspace: {
          id: "ws-1",
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
              textVerbosity: "medium",
            },
            "codex-cli": {
              reasoningEffort: "medium",
              reasoningSummary: "concise",
              textVerbosity: "low",
            },
          },
        },
        updateWorkspaceDefaults: async () => {},
      }),
    );

    expect(html).toContain("OpenAI-Compatible Model Settings");
    expect(html).toContain("OpenAI API");
    expect(html).toContain("Codex CLI");
    expect(html).toContain("Verbosity");
    expect(html).toContain("Reasoning effort");
    expect(html).toContain("Reasoning summary");
  });
});
