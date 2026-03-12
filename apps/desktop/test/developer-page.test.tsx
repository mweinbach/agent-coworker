import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

type JsdomHarness = {
  dom: JSDOM;
  restore: () => void;
};

function setupJsdom(): JsdomHarness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    getComputedStyle: globalThis.getComputedStyle,
    actEnv: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return {
    dom,
    restore: () => {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.navigator = saved.navigator;
      globalThis.HTMLElement = saved.HTMLElement;
      globalThis.Node = saved.Node;
      globalThis.getComputedStyle = saved.getComputedStyle;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.actEnv;
      dom.window.close();
    },
  };
}

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

const { useAppStore } = await import("../src/app/store");
const { DeveloperPage } = await import("../src/ui/settings/pages/DeveloperPage");

describe("desktop developer page", () => {
  test("renders workspace spill-file controls for tool output overflow", async () => {
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-03-12T00:00:00.000Z",
          lastOpenedAt: "2026-03-12T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          defaultSubAgentModel: "gpt-5.4",
          defaultToolOutputOverflowChars: 12000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
    });

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      expect(container.textContent).toContain("Workspace Tool Output Spill Files");
      expect(container.textContent).toContain("Enable spill files");
      expect(container.textContent).toContain("Character threshold");
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
});
