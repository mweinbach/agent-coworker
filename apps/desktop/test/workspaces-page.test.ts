import { beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
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

const {
  OpenAiCompatibleModelSettingsCard,
  WorkspacesPage,
  WorkspaceUserProfileCard,
} = await import("../src/ui/settings/pages/WorkspacesPage");
const App = (await import("../src/App")).default;
const { useAppStore } = await import("../src/app/store");

describe("desktop workspaces page", () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      ready: true,
      settingsPage: "workspaces",
      workspaces: [],
      selectedWorkspaceId: null,
      providerCatalog: [],
      providerConnected: [],
      providerDefaultModelByProvider: {},
      providerStatusByName: {},
    }));
  });

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
              webSearchBackend: "native",
              webSearchMode: "live",
              webSearch: {
                contextSize: "high",
                allowedDomains: ["openai.com"],
                location: {
                  country: "US",
                  timezone: "America/New_York",
                },
              },
            },
          },
        },
        providerStatusByName: {
          openai: { verified: true },
          "codex-cli": { authorized: true, mode: "oauth" },
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
    expect(html).toContain("Web search");
    expect(html).toContain("Search backend");
    expect(html).toContain("Web search mode");
    expect(html).toContain("Context size");
    expect(html).toContain("Allowed domains");
    expect(html).toContain("Country");
    expect(html).toContain("Timezone");
    expect(html).toContain("Choose whether Codex uses the built-in native search tool or the local Exa tool. Native is the default.");
    expect(html).toContain("Native uses Responses `web_search`. Exa uses the local `webSearch` tool and requires Exa access.");
    expect(html).toContain("Cached uses indexed results only. Live allows live internet access. Domains should omit protocol.");
    expect(html).toContain("Applies when this workspace runs on OpenAI API.");
  });

  test("renders workspace controls for user profile context", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceUserProfileCard, {
        workspace: {
          id: "ws-1",
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun and TypeScript",
          },
        },
        updateWorkspaceDefaults: async () => {},
      }),
    );

    expect(html).toContain("How Cowork should understand you in this workspace");
    expect(html).toContain("Name");
    expect(html).toContain("Role or work context");
    expect(html).toContain("Instructions");
    expect(html).toContain("Background details");
  });

  test("renders cross-provider child routing controls for workspace defaults", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: "2026-03-16T00:00:00.000Z",
          lastOpenedAt: "2026-03-16T00:00:00.000Z",
          defaultProvider: "codex-cli",
          defaultModel: "gpt-5.4",
          defaultPreferredChildModel: "gpt-5.4",
          defaultChildModelRoutingMode: "cross-provider-allowlist",
          defaultPreferredChildModelRef: "opencode-zen:glm-5",
          defaultAllowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      providerCatalog: [
        {
          id: "codex-cli",
          name: "Codex CLI",
          defaultModel: "gpt-5.4",
          models: [{ id: "gpt-5.4", displayName: "GPT-5.4", knowledgeCutoff: "unknown", supportsImageInput: true }],
        },
        {
          id: "opencode-zen",
          name: "OpenCode Zen",
          defaultModel: "glm-5",
          models: [{ id: "glm-5", displayName: "GLM-5", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
        {
          id: "opencode-go",
          name: "OpenCode Go",
          defaultModel: "glm-5",
          models: [{ id: "glm-5", displayName: "GLM-5", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
      ],
      providerConnected: ["codex-cli", "opencode-zen", "opencode-go"],
      providerDefaultModelByProvider: {
        "codex-cli": "gpt-5.4",
        "opencode-zen": "glm-5",
        "opencode-go": "glm-5",
      },
    }));

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(WorkspacesPage));
      });

      const modelsTab = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Models");
      if (!(modelsTab instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing Models tab");
      }

      await act(async () => {
        modelsTab.click();
      });

      const text = container.textContent ?? "";
      expect(text).toContain("Child routing mode");
      expect(text).toContain("cross-provider-allowlist");
      expect(text).toContain("Allowed child targets");
      expect(text).toContain("Preferred child target");
      expect(text).toContain("opencode-zen:glm-5");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("typing into workspace profile fields does not trigger a render loop", async () => {
    const harness = setupJsdom();
    const realError = console.error;
    const consoleErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(WorkspaceUserProfileCard, {
              workspace: {
                id: "ws-1",
                userName: "Alex",
                userProfile: {
                  instructions: "",
                  work: "",
                  details: "",
                },
              },
              updateWorkspaceDefaults: async () => {},
            }),
          ),
        );
      });

      const textarea = container.querySelector('[aria-label="Workspace work context"]');
      if (!(textarea instanceof harness.dom.window.HTMLTextAreaElement)) {
        throw new Error("missing workspace work context textarea");
      }

      await act(async () => {
        textarea.value = "Platform engineer";
        textarea.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
        textarea.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
      });

      expect(container.textContent).toContain("How Cowork should understand you in this workspace");
      expect(textarea.value).toBe("Platform engineer");
      expect(consoleErrors.some((entry) => entry.includes("Maximum update depth exceeded"))).toBe(false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      console.error = realError;
      harness.restore();
    }
  });

  test("typing into workspace profile fields does not blank the full settings app", async () => {
    const harness = setupJsdom();
    const realError = console.error;
    const consoleErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          ready: true,
          startupError: null,
          view: "settings",
          settingsPage: "workspaces",
          lastNonSettingsView: "chat",
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace 1",
              path: "/tmp/workspace-1",
              createdAt: "2026-03-12T00:00:00.000Z",
              lastOpenedAt: "2026-03-12T00:00:00.000Z",
              defaultProvider: "openai",
              defaultModel: "gpt-5.4",
              defaultPreferredChildModel: "gpt-5.4",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
              userName: "",
              userProfile: {
                instructions: "",
                work: "",
                details: "",
              },
            },
          ],
          selectedWorkspaceId: "ws-1",
          selectedThreadId: null,
          threads: [],
          threadRuntimeById: {},
          workspaceRuntimeById: {},
        });
      });

      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(App),
          ),
        );
      });

      const textarea = container.querySelector('[aria-label="Workspace work context"]');
      if (!(textarea instanceof harness.dom.window.HTMLTextAreaElement)) {
        throw new Error("missing workspace work context textarea");
      }

      await act(async () => {
        textarea.value = "Platform engineer";
        textarea.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
        textarea.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
        textarea.dispatchEvent(new harness.dom.window.FocusEvent("blur", { bubbles: true }));
      });

      expect(container.textContent).toContain("How Cowork should understand you in this workspace");
      expect(container.textContent).toContain("Workspace 1");
      expect(consoleErrors.some((entry) => entry.includes("Maximum update depth exceeded"))).toBe(false);

      await act(async () => {
        root.unmount();
      });
    } finally {
      console.error = realError;
      harness.restore();
    }
  });
});
