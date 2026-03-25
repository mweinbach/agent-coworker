import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
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

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
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
const { EXA_SECTION_ID, ProvidersPage } = await import("../src/ui/settings/pages/ProvidersPage");

const defaultProviderActions = {
  requestProviderCatalog: useAppStore.getState().requestProviderCatalog,
  requestProviderAuthMethods: useAppStore.getState().requestProviderAuthMethods,
  refreshProviderStatus: useAppStore.getState().refreshProviderStatus,
};

describe("desktop providers page", () => {
  beforeEach(() => {
    (useAppStore as any).getInitialState = useAppStore.getState;
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
      providerConnected: [],
      providerUiState: {
        lmstudio: {
          enabled: false,
          hiddenModels: [],
        },
      },
      ...defaultProviderActions,
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

  test("derives the initial active tab from a tool provider deep link", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: EXA_SECTION_ID,
      }),
    );

    expect(html).toMatch(/class="[^"]*text-muted-foreground hover:text-foreground[^"]*"[^>]*>Model Providers<\/button>/);
    expect(html).toMatch(/class="[^"]*text-foreground[^"]*"[^>]*>.*Tool Providers<\/button>/);
  });

  test("shows provider auth result while API key setup is still in editing mode", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      providerLastAuthResult: {
        type: "provider_auth_result",
        sessionId: "control-session",
        provider: "google",
        methodId: "api_key",
        ok: false,
        mode: "api_key",
        message: "Auth failed.",
      } as any,
    });

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:google",
      }),
    );

    expect(html).toContain("Google");
    expect(html).toContain("Paste your API key");
    expect(html).toContain("Auth failed.");
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

  test("mount only triggers the consolidated provider refresh", async () => {
    const requestProviderCatalog = mock(async () => {});
    const requestProviderAuthMethods = mock(async () => {});
    const refreshProviderStatus = mock(async () => {});
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          requestProviderCatalog,
          requestProviderAuthMethods,
          refreshProviderStatus,
        });
      });

      await act(async () => {
        root.render(createElement(ProvidersPage));
      });

      expect(refreshProviderStatus).toHaveBeenCalledTimes(1);
      expect(requestProviderCatalog).not.toHaveBeenCalled();
      expect(requestProviderAuthMethods).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("sorts model providers by connection state while preserving the product order within each group", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      providerCatalog: [
        { id: "together", name: "Together AI" },
        { id: "openai", name: "OpenAI" },
        { id: "google", name: "Google" },
        { id: "opencode-zen", name: "OpenCode Zen" },
        { id: "codex-cli", name: "Codex CLI" },
        { id: "anthropic", name: "Anthropic" },
        { id: "baseten", name: "Baseten" },
        { id: "nvidia", name: "NVIDIA" },
        { id: "opencode-go", name: "OpenCode Go" },
      ] as any,
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
        openai: {
          provider: "openai",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        "codex-cli": {
          provider: "codex-cli",
          authorized: true,
          verified: true,
          mode: "oauth",
          account: null,
          message: "Connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        anthropic: {
          provider: "anthropic",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "Connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        "opencode-go": {
          provider: "opencode-go",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "Connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        "opencode-zen": {
          provider: "opencode-zen",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        nvidia: {
          provider: "nvidia",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        together: {
          provider: "together",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
        baseten: {
          provider: "baseten",
          authorized: true,
          verified: true,
          mode: "api_key",
          account: null,
          message: "Connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
      } as any,
    });

    const html = renderToStaticMarkup(createElement(ProvidersPage));
    const expectedVisibleOrder = [
      "Codex CLI",
      "OpenCode Go",
      "Anthropic",
      "Google",
      "OpenCode Zen",
      "NVIDIA",
      "Together AI",
      "OpenAI",
    ];
    const providerIndexes = expectedVisibleOrder.map((name) => html.indexOf(name));
    expect(providerIndexes.every((index) => index >= 0)).toBe(true);
    for (let index = 1; index < providerIndexes.length; index += 1) {
      expect(providerIndexes[index - 1]).toBeLessThan(providerIndexes[index]);
    }
    expect(html).not.toContain("Baseten");
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
    });

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

  test("codex oauth card shows logout when connected", () => {
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
        "codex-cli": {
          provider: "codex-cli",
          authorized: true,
          verified: false,
          mode: "oauth",
          account: null,
          message: "OAuth connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
      },
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

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:codex-cli",
      }),
    );

    expect(html).toContain("Log out");
  });

  test("codex provider card renders usage status and rate limits", () => {
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
        "codex-cli": {
          provider: "codex-cli",
          authorized: true,
          verified: true,
          mode: "oauth",
          account: { email: "max@example.com" },
          message: "Verified via Codex usage endpoint (pro).",
          checkedAt: "2026-03-07T00:00:00.000Z",
          usage: {
            accountId: "acct-123",
            email: "max@example.com",
            planType: "pro",
            rateLimits: [
              {
                limitId: "codex",
                allowed: false,
                limitReached: true,
                primaryWindow: {
                  usedPercent: 100,
                  windowSeconds: 18_000,
                  resetAfterSeconds: 1_800,
                  resetAt: "2026-03-07T01:00:00.000Z",
                },
                secondaryWindow: null,
                credits: {
                  hasCredits: true,
                  unlimited: false,
                  balance: "42.125",
                },
              },
              {
                limitId: "code_review",
                limitName: "Code Review",
                allowed: true,
                limitReached: false,
                primaryWindow: {
                  usedPercent: 12,
                  windowSeconds: 18_000,
                  resetAfterSeconds: 900,
                },
                credits: {
                  hasCredits: false,
                  unlimited: false,
                  balance: "7.9999",
                },
              },
            ],
          },
        },
      },
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

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:codex-cli",
      }),
    );

    expect(html).toContain("Usage");
    expect(html).toContain("Plan");
    expect(html).toContain("pro");
    expect(html).toContain("Email");
    expect(html).toContain("max@example.com");
    expect(html).not.toContain("acct-123");
    expect(html).toContain("Verified via Codex usage endpoint (pro).");
    expect(html).toContain("Rate limits");
    expect(html).toContain("Codex");
    expect(html).toContain("0% remaining");
    expect(html).toContain("Using credits");
    expect(html).toContain("42.13 remaining");
    expect(html).not.toContain("Allowed");
    expect(html).not.toContain("Limit reached");
    expect(html).not.toContain("Rate limited");
    expect(html).not.toContain("Code Review");
    expect(html).not.toContain("API key");
    expect(html).not.toContain("Credits balance");
    expect(html).not.toContain("42.125");
  });

  test("opencode sibling provider card shows saved-key reuse action", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      providerStatusByName: {
        "opencode-go": {
          provider: "opencode-go",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-03-07T00:00:00.000Z",
          savedApiKeyMasks: {
            api_key: "open...1234",
          },
        },
        "opencode-zen": {
          provider: "opencode-zen",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
      } as any,
      providerCatalog: [
        { id: "opencode-go", name: "OpenCode Go" },
        { id: "opencode-zen", name: "OpenCode Zen" },
      ] as any,
      providerAuthMethodsByProvider: {
        "opencode-go": [{ id: "api_key", type: "api", label: "API key" }],
        "opencode-zen": [{ id: "api_key", type: "api", label: "API key" }],
      } as any,
      providerLastAuthChallenge: null,
      providerLastAuthResult: null,
    });

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:opencode-zen",
      }),
    );

    expect(html).toContain("OpenCode Zen");
    expect(html).toContain("Use OpenCode Go key");
  });

  test("opencode sibling provider card hides saved-key reuse when the target already has a key", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      providerStatusByName: {
        "opencode-go": {
          provider: "opencode-go",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-03-07T00:00:00.000Z",
          savedApiKeyMasks: {
            api_key: "open...1234",
          },
        },
        "opencode-zen": {
          provider: "opencode-zen",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-03-07T00:00:00.000Z",
          savedApiKeyMasks: {
            api_key: "zen...5678",
          },
        },
      } as any,
      providerCatalog: [
        { id: "opencode-go", name: "OpenCode Go" },
        { id: "opencode-zen", name: "OpenCode Zen" },
      ] as any,
      providerAuthMethodsByProvider: {
        "opencode-go": [{ id: "api_key", type: "api", label: "API key" }],
        "opencode-zen": [{ id: "api_key", type: "api", label: "API key" }],
      } as any,
      providerLastAuthChallenge: null,
      providerLastAuthResult: null,
    });

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:opencode-zen",
      }),
    );

    expect(html).toContain("OpenCode Zen");
    expect(html).not.toContain("Use OpenCode Go key");
  });

  test("renders LM Studio as a local provider card without API token controls", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      providerStatusByName: {
        ...useAppStore.getState().providerStatusByName,
        lmstudio: {
          provider: "lmstudio",
          authorized: true,
          verified: true,
          mode: "local",
          account: null,
          message: "LM Studio reachable.",
          checkedAt: "2026-03-18T00:00:00.000Z",
        },
      } as any,
      providerCatalog: [
        {
          id: "lmstudio",
          name: "LM Studio",
          state: "ready",
          message: "LM Studio reachable.",
          models: [
            { id: "qwen/qwen3-30b-a3b", displayName: "Qwen 3 30B", knowledgeCutoff: "Unknown", supportsImageInput: false },
            { id: "llama/llama-3.2-vision", displayName: "Llama 3.2 Vision", knowledgeCutoff: "Unknown", supportsImageInput: true },
          ],
          defaultModel: "qwen/qwen3-30b-a3b",
        },
      ] as any,
      providerUiState: {
        lmstudio: {
          enabled: true,
          hiddenModels: ["llama/llama-3.2-vision"],
        },
      },
    });

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:lmstudio",
      }),
    );

    expect(html).toContain("LM Studio runs on a local server.");
    expect(html).toContain("Disable");
    expect(html).toContain("Refresh");
    expect(html).toContain("Models shown in chat");
    expect(html).toContain("Show all");
    expect(html).toContain("Qwen 3 30B");
    expect(html).toContain("Llama 3.2 Vision");
    expect(html).not.toContain("API TOKEN");
    expect(html).not.toContain("Paste your API key");
    expect(html).not.toContain("Reveal");
  });

  test("uses provider status fallback when LM Studio is enabled but the catalog entry is missing", () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      providerStatusByName: {
        ...useAppStore.getState().providerStatusByName,
        lmstudio: {
          provider: "lmstudio",
          authorized: false,
          verified: false,
          mode: "error",
          account: null,
          message: "LM Studio server is unreachable at http://localhost:1234.",
          checkedAt: "2026-03-18T00:00:00.000Z",
        },
      } as any,
      providerCatalog: [],
      providerUiState: {
        lmstudio: {
          enabled: true,
          hiddenModels: [],
        },
      },
    });

    const html = renderToStaticMarkup(
      createElement(ProvidersPage, {
        initialExpandedSectionId: "provider:lmstudio",
      }),
    );

    expect(html).toContain("Unavailable");
    expect(html).toContain("LM Studio server is unreachable at http://localhost:1234.");
    expect(html).not.toContain(">Checking<");
  });

  test("LM Studio card actions call local enable and model visibility handlers", async () => {
    const harness = setupJsdom();
    const setLmStudioEnabled = mock(async () => {});
    const setLmStudioModelVisible = mock(async () => {});
    const refreshProviderStatus = mock(async () => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          ...useAppStore.getState(),
          providerStatusByName: {
            ...useAppStore.getState().providerStatusByName,
            lmstudio: {
              provider: "lmstudio",
              authorized: false,
              verified: false,
              mode: "local",
              account: null,
              message: "LM Studio unavailable.",
              checkedAt: "2026-03-18T00:00:00.000Z",
            },
          } as any,
          providerCatalog: [
            {
              id: "lmstudio",
              name: "LM Studio",
              state: "unreachable",
              message: "LM Studio unavailable.",
              models: [
                { id: "qwen/qwen3-30b-a3b", displayName: "Qwen 3 30B", knowledgeCutoff: "Unknown", supportsImageInput: false },
              ],
              defaultModel: "qwen/qwen3-30b-a3b",
            },
          ] as any,
          providerUiState: {
            lmstudio: {
              enabled: false,
              hiddenModels: [],
            },
          },
          setLmStudioEnabled,
          setLmStudioModelVisible,
          refreshProviderStatus,
        });
      });

      await act(async () => {
        root.render(createElement(ProvidersPage, { initialExpandedSectionId: "provider:lmstudio" }));
      });

      const connectButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Connect");
      if (!connectButton) throw new Error("missing LM Studio connect button");
      await act(async () => {
        connectButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(setLmStudioEnabled).toHaveBeenCalledWith(true);

      const refreshButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
      if (!refreshButton) throw new Error("missing LM Studio refresh button");
      await act(async () => {
        refreshButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(refreshProviderStatus).toHaveBeenCalled();

      const modelCheckbox = container.querySelector('[aria-label="Show LM Studio model qwen/qwen3-30b-a3b in chat"]');
      if (!(modelCheckbox instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing LM Studio model checkbox");
      }
      await act(async () => {
        modelCheckbox.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(setLmStudioModelVisible).toHaveBeenCalledWith("qwen/qwen3-30b-a3b", false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
