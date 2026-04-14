import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, StrictMode } from "react";
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


const {
  GeminiApiSettingsCard,
  OpenAiCompatibleModelSettingsCard,
  SearchSettingsCard,
  WorkspacesPage,
  WorkspaceUserProfileCard,
} = await import("../src/ui/settings/pages/WorkspacesPage");
const App = (await import("../src/App")).default;
const { useAppStore } = await import("../src/app/store");
const defaultStoreActions = {
  updateWorkspaceDefaults: useAppStore.getState().updateWorkspaceDefaults,
};

function setupWorkspacePageJsdom() {
  return setupJsdom({ includeAnimationFrame: true });
}

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
      ...defaultStoreActions,
    }));
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("renders OpenAI and ChatGPT settings controls", () => {
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

    expect(html).toContain("OpenAI &amp; ChatGPT Settings");
    expect(html).toContain("Workspace defaults for ChatGPT Subscription and OpenAI API models.");
    expect(html).toContain("OpenAI API");
    expect(html).toContain("ChatGPT Subscription");
    expect(html).toContain("Verbosity");
    expect(html).toContain("Reasoning effort");
    expect(html).toContain("Reasoning summary");
    expect(html).toContain("OpenAI API");
  });

  test("reveals shared search controls and manages optional allowed domains", async () => {
    const harness = setupWorkspacePageJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    const updateWorkspaceDefaults = mock(async () => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SearchSettingsCard, {
            workspace: {
              id: "ws-1",
              providerOptions: {
                "codex-cli": {
                  reasoningEffort: "medium",
                  reasoningSummary: "concise",
                  textVerbosity: "low",
                  webSearchBackend: "native",
                  webSearchFallbackBackend: "parallel",
                  webSearchMode: "live",
                  webSearch: {
                    contextSize: "high",
                    location: {
                      country: "US",
                      timezone: "America/New_York",
                    },
                  },
                },
                google: {
                  nativeWebSearch: true,
                },
              },
            },
            providerStatusByName: {
              google: {
                savedApiKeyMasks: {
                  parallel_api_key: "para...1234",
                },
              },
            },
            updateWorkspaceDefaults,
          }),
        );
      });

      expect(container.textContent).toContain("Search provider");
      expect(container.textContent).toContain("doesn't include search");
      expect(container.textContent).not.toContain("Allowed domains");

      const advancedButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show"));
      if (!(advancedButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing search advanced options button");
      }

      await act(async () => {
        advancedButton.click();
      });

      const text = container.textContent ?? "";
      expect(text).toContain("Search mode");
      expect(text).toContain("Context size");
      expect(text).toContain("Allowed domains");
      expect(text).toContain("Country");
      expect(text).toContain("Timezone");
      expect(text).toContain("Open to all domains unless you add one or more here.");

      const helpButton = container.querySelector('[aria-label="Allowed domains help"]');
      if (!(helpButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing allowed domains help button");
      }
      expect(helpButton.getAttribute("aria-label")).toBe("Allowed domains help");

      const domainInput = container.querySelector('[aria-label="Codex allowed domains input"]');
      if (!(domainInput instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing allowed domains input");
      }

      const addButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add");
      if (!(addButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing add domains button");
      }
      expect(addButton.disabled).toBe(true);

      await act(async () => {
        domainInput.value = "https://OpenAI.com/docs, example.com/path; api.example.com:443";
        domainInput.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
        domainInput.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
      });

      const addButtonAfterInput = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add");
      if (!(addButtonAfterInput instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing add domains button after input");
      }
      expect(addButtonAfterInput.disabled).toBe(false);

      await act(async () => {
        addButtonAfterInput.click();
      });

      expect(domainInput.value).toBe("");
      expect(updateWorkspaceDefaults).toHaveBeenCalledTimes(1);
      expect(updateWorkspaceDefaults.mock.calls[0]).toEqual([
        "ws-1",
        {
          providerOptions: {
            "codex-cli": {
              reasoningEffort: "medium",
              reasoningSummary: "concise",
              textVerbosity: "low",
              webSearchBackend: "native",
              webSearchFallbackBackend: "parallel",
              webSearchMode: "live",
              webSearch: {
                contextSize: "high",
                allowedDomains: ["openai.com", "example.com", "api.example.com"],
                location: {
                  country: "US",
                  timezone: "America/New_York",
                },
              },
            },
            google: {
              nativeWebSearch: true,
            },
          },
        },
      ]);

    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("renders Gemini API settings controls for reasoning effort", () => {
    const html = renderToStaticMarkup(
      createElement(GeminiApiSettingsCard, {
        workspace: {
          id: "ws-1",
          defaultProvider: "google",
          defaultModel: "gemini-3-flash-preview",
          providerOptions: {
            google: {
              nativeWebSearch: true,
            },
          },
        },
        providerStatusByName: {
          google: { verified: true },
        },
        googleDefaultModel: "gemini-3.1-pro-preview",
        updateWorkspaceDefaults: async () => {},
      }),
    );

    expect(html).toContain("Gemini API settings");
    expect(html).toContain("Reasoning effort");
    expect(html).toContain("gemini-3-flash-preview");
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
      perWorkspaceSettings: true,
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
          id: "opencode-go",
          name: "OpenCode Go",
          defaultModel: "glm-5",
          models: [{ id: "glm-5", displayName: "GLM-5", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
        {
          id: "google",
          name: "Google",
          defaultModel: "gemini-3-flash-preview",
          models: [{ id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview", knowledgeCutoff: "unknown", supportsImageInput: true }],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          defaultModel: "claude-4.5-sonnet",
          models: [{ id: "claude-4.5-sonnet", displayName: "Claude 4.5 Sonnet", knowledgeCutoff: "unknown", supportsImageInput: true }],
        },
        {
          id: "opencode-zen",
          name: "OpenCode Zen",
          defaultModel: "glm-5",
          models: [{ id: "glm-5", displayName: "GLM-5", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
        {
          id: "nvidia",
          name: "NVIDIA",
          defaultModel: "nvidia/nemotron-3-super-120b-a12b",
          models: [{ id: "nvidia/nemotron-3-super-120b-a12b", displayName: "Nemotron 3 Super", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
        {
          id: "together",
          name: "Together AI",
          defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
          models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", displayName: "Llama 3.3 70B Turbo", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
        {
          id: "baseten",
          name: "Baseten",
          defaultModel: "nvidia/Nemotron-4-340B-Instruct",
          models: [{ id: "nvidia/Nemotron-4-340B-Instruct", displayName: "Nemotron 4 340B", knowledgeCutoff: "unknown", supportsImageInput: false }],
        },
      ],
      providerConnected: ["codex-cli", "opencode-go", "google", "anthropic", "opencode-zen", "nvidia", "together", "baseten"],
      providerDefaultModelByProvider: {
        "codex-cli": "gpt-5.4",
        "opencode-go": "glm-5",
        google: "gemini-3-flash-preview",
        anthropic: "claude-4.5-sonnet",
        "opencode-zen": "glm-5",
        nvidia: "nvidia/nemotron-3-super-120b-a12b",
        together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        baseten: "nvidia/Nemotron-4-340B-Instruct",
      },
      providerStatusByName: {
        "codex-cli": { authorized: true, verified: true },
        "opencode-go": { authorized: true, verified: true },
        google: { authorized: true, verified: true },
        anthropic: { authorized: true, verified: true },
        "opencode-zen": { authorized: true, verified: true },
        nvidia: { authorized: true, verified: true },
        together: { authorized: true, verified: true },
        baseten: { authorized: true, verified: true },
      },
    }));

    const harness = setupWorkspacePageJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(WorkspacesPage));
      });

      const topLevelText = container.textContent ?? "";
      expect(topLevelText).toContain("Current provider:");
      expect(topLevelText).toContain("Model:");
      expect(topLevelText).toContain("Subagent routing:");
      expect(topLevelText).toContain("Preferred subagent model:");
      expect(topLevelText.indexOf("Current provider:")).toBeLessThan(topLevelText.indexOf("Active workspace"));

      const modelsTab = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Models");
      if (!(modelsTab instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing Models tab");
      }

      await act(async () => {
        modelsTab.click();
      });

      const text = container.textContent ?? "";
      expect(text).toContain("Subagent routing");
      expect(text).toContain("Multiple providers");
      expect(text).toContain("Subagent Models");
      expect(text).toContain("Preferred subagent model");

      const subagentModelsToggle = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.trim() === "Show" && button.closest("[data-slot=\"card-content\"]")?.textContent?.includes("Subagent Models"),
      );
      if (!(subagentModelsToggle instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing Subagent Models toggle");
      }

      await act(async () => {
        subagentModelsToggle.click();
      });

      const expandedText = container.textContent ?? "";
      expect(expandedText).toContain("OpenCode Zen | glm-5");
      // Search within the subagent models section to avoid matching provider
      // names that appear earlier in the summary bar or dropdowns.
      const sectionStart = expandedText.lastIndexOf("Subagent Models");
      expect(sectionStart).toBeGreaterThanOrEqual(0);
      const sectionText = expandedText.slice(sectionStart);
      for (const expectedName of ["OpenCode Go", "OpenCode Zen"]) {
        expect(sectionText).toContain(expectedName);
      }
      expect(expandedText).not.toContain("Baseten");

      const subagentModelCheckbox = container.querySelector('[aria-label="Allow subagent model opencode-go:glm-5"]');
      if (!(subagentModelCheckbox instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing subagent model checkbox");
      }

      await act(async () => {
        subagentModelCheckbox.click();
      });

      expect(subagentModelCheckbox.isConnected).toBe(true);
      expect(subagentModelsToggle.textContent).toContain("Hide");
      expect(useAppStore.getState().workspaces[0]?.defaultAllowedChildModelRefs).toEqual(["opencode-zen:glm-5"]);
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
    const harness = setupWorkspacePageJsdom();
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
    const harness = setupWorkspacePageJsdom();
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
          perWorkspaceSettings: true,
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
