import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";

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
  phase: "disabled",
  packaged: false,
  currentVersion: "0.1.9",
  lastCheckStartedAt: null,
  lastCheckedAt: null,
  downloadedAt: null,
  message: "Updates are only available in packaged builds.",
  error: null,
  progress: null,
  release: null,
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
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { UpdatesPage } = await import("../src/ui/settings/pages/UpdatesPage");

describe("desktop updates page", () => {
  test("renders disabled packaged messaging for unpackaged builds", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPage, { state: MOCK_UPDATE_STATE as any }));

    expect(html).toContain("Updates");
    expect(html).toContain("Current build");
    expect(html).toContain("Updates are only available in packaged builds.");
    expect(html).toContain("Check now");
    expect(html).toContain("Not available in dev mode");
  });

  test("renders unavailable feed messaging for packaged builds without update metadata", () => {
    const html = renderToStaticMarkup(
      createElement(UpdatesPage, {
        state: {
          ...MOCK_UPDATE_STATE,
          packaged: true,
          message: "Updates are unavailable for this platform because no update feed is published.",
        } as any,
      }),
    );

    expect(html).toContain("0.1.9");
    expect(html).toContain("Updates are unavailable for this platform because no update feed is published.");
    expect(html).toContain("Latest seen version");
    expect(html).toContain("Check now");
  });

  test("renders download progress and restart action for downloaded updates", () => {
    const html = renderToStaticMarkup(
      createElement(UpdatesPage, {
        state: {
          phase: "downloaded",
          packaged: true,
          currentVersion: "0.1.9",
          lastCheckStartedAt: "2026-03-07T12:00:00.000Z",
          lastCheckedAt: "2026-03-07T12:00:30.000Z",
          downloadedAt: "2026-03-07T12:01:00.000Z",
          message: "Restart Cowork to install 0.2.0.",
          error: null,
          progress: {
            percent: 100,
            transferred: 1000,
            total: 1000,
            bytesPerSecond: 0,
          },
          release: {
            version: "0.2.0",
            releaseName: "Cowork 0.2.0",
            releaseDate: "2026-03-07T10:00:00.000Z",
            releaseNotes: "Bug fixes",
            releasePageUrl: "https://github.com/mweinbach/agent-coworker/releases/latest",
          },
        },
      }),
    );

    expect(html).toContain("Ready to restart");
    expect(html).toContain("Restart to update");
    expect(html).toContain("Cowork 0.2.0");
    expect(html).toContain("Bug fixes");
    expect(html).toContain("Open release notes");
  });

  test("renders HTML-formatted release notes as formatted content instead of escaped tags", () => {
    const html = renderToStaticMarkup(
      createElement(UpdatesPage, {
        state: {
          ...MOCK_UPDATE_STATE,
          phase: "downloaded",
          packaged: true,
          release: {
            version: "0.1.21",
            releaseName: "v0.1.21",
            releaseDate: "2026-03-12T12:00:00.000Z",
            releaseNotes: "<h1>Cowork 0.1.21</h1><p>This release fixes the macOS auto-update path by forcing full signed update downloads.</p><ul><li>Mac updater reliability</li></ul>",
            releasePageUrl: "https://github.com/mweinbach/agent-coworker/releases/tag/v0.1.21",
          },
        } as any,
      }),
    );

    expect(html).toContain("<h1");
    expect(html).toContain("Cowork 0.1.21</h1>");
    expect(html).toContain("<p>This release fixes the macOS auto-update path by forcing full signed update downloads.</p>");
    expect(html).toContain("<li");
    expect(html).toContain("Mac updater reliability</li>");
    expect(html).not.toContain("&lt;h1&gt;Cowork 0.1.19&lt;/h1&gt;");
  });
});
