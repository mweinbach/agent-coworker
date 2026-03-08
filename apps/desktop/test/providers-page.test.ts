import { beforeEach, describe, expect, mock, test } from "bun:test";
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

const { useAppStore } = await import("../src/app/store");
const { EXA_SECTION_ID, ProvidersPage } = await import("../src/ui/settings/pages/ProvidersPage");

describe("desktop providers page", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          createdAt: "2026-03-07T00:00:00.000Z",
          lastOpenedAt: "2026-03-07T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      providerStatusByName: {
        google: {
          provider: "google",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
      },
      providerStatusRefreshing: false,
      providerCatalog: [
        { id: "google", name: "Google" },
        { id: "openai", name: "OpenAI" },
        { id: "codex-cli", name: "Codex CLI" },
      ] as any,
      providerAuthMethodsByProvider: {
        google: [
          { id: "api_key", type: "api", label: "API key" },
          { id: "exa_api_key", type: "api", label: "Exa API key (web search)" },
        ],
        openai: [{ id: "api_key", type: "api", label: "API key" }],
        "codex-cli": [
          { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
        ],
      } as any,
      providerLastAuthChallenge: null,
      providerLastAuthResult: null,
    });
  });

  test("keeps Exa out of the expanded Google settings card", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:google",
      }),
    );

    expect(html).toContain("Google");
    expect(html).toContain("Paste your API key");
    expect(html).not.toContain("Paste your Exa API key");
    expect(html).toContain("Exa Search");
  });

  test("renders a dedicated Exa Search settings card", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: EXA_SECTION_ID,
      }),
    );

    expect(html).toContain("Exa Search");
    expect(html).toContain("Paste your Exa API key");
    expect(html).toContain("provider-panel-exa-search");
  });

  test("auto oauth providers do not render a separate continue step", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:codex-cli",
      }),
    );

    expect(html).toContain("Codex CLI");
    expect(html).toContain("Sign in with ChatGPT (browser)");
    expect(html).not.toContain("device code");
    expect(html).not.toContain(">Continue<");
  });

  test("codex browser auth ignores stale challenge URLs", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          createdAt: "2026-03-07T00:00:00.000Z",
          lastOpenedAt: "2026-03-07T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      providerLastAuthChallenge: {
        type: "provider_auth_challenge",
        sessionId: "control-session",
        provider: "codex-cli",
        methodId: "oauth_cli",
        challenge: {
          method: "auto",
          instructions: "Continue to open browser-based ChatGPT OAuth and finish sign-in.",
          url: "https://auth.openai.com/oauth/authorize",
        },
      } as any,
    }, true);

    expect(useAppStore.getState().selectedWorkspaceId).toBe("ws-1");
    expect(useAppStore.getState().workspaces).toHaveLength(1);

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:codex-cli",
      }),
    );

    expect(html).not.toContain("Open link");
    expect(html).not.toContain("https://auth.openai.com/oauth/authorize");
  });
});
