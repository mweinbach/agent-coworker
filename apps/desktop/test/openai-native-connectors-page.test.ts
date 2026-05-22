import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

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
    getSystemAppearance: async () => ({
      platform: "linux",
      themeSource: "system",
      shouldUseDarkColors: false,
      shouldUseHighContrastColors: false,
      shouldUseInvertedColorScheme: false,
      prefersReducedTransparency: false,
      inForcedColorsMode: false,
    }),
    setWindowAppearance: async () => ({
      platform: "linux",
      themeSource: "system",
      shouldUseDarkColors: false,
      shouldUseHighContrastColors: false,
      shouldUseInvertedColorScheme: false,
      prefersReducedTransparency: false,
      inForcedColorsMode: false,
    }),
    getUpdateState: async () => ({
      phase: "idle",
      currentVersion: "0.1.0",
      packaged: false,
      lastCheckedAt: null,
      release: null,
      progress: null,
      error: null,
    }),
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
const { OpenAiNativeConnectorsPage } = await import(
  "../src/ui/settings/pages/OpenAiNativeConnectorsPage"
);

describe("OpenAI native connectors settings page", () => {
  beforeEach(() => {
    const runtime = defaultWorkspaceRuntime();
    runtime.openAiNativeConnectorsAuthenticated = true;
    runtime.openAiNativeConnectorsEnabledIds = ["connector_gmail"];
    runtime.openAiNativeConnectors = [
      {
        id: "connector_gmail",
        name: "Gmail",
        description: "Search mail",
        isEnabled: true,
      },
    ];
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          createdAt: "2026-04-25T00:00:00.000Z",
          lastOpenedAt: "2026-04-25T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: { "ws-1": runtime },
      requestOpenAiNativeConnectors: async () => {},
      refreshOpenAiNativeConnectors: async () => {},
      setOpenAiNativeConnectorEnabled: async () => {},
    });
  });

  test("renders connector status and entries", () => {
    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root");
    if (!container) throw new Error("Missing root element");
    const root = createRoot(container);
    act(() => {
      root.render(createElement(OpenAiNativeConnectorsPage));
    });
    const markup = container.innerHTML;

    expect(markup).toContain("ChatGPT apps for Codex");
    expect(markup).toContain("Codex authenticated");
    expect(markup).toContain("Gmail");
    expect(markup).toContain("connector_gmail");
    act(() => root.unmount());
    harness.restore();
  });
});
