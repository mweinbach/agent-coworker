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
  lastCheckStartedAt: null,
  downloadedAt: null,
  message: null,
  error: null,
  release: null,
  progress: null,
};

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
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
    send() { return true; }
    close() {}
  },
  JsonRpcSocket: NoopJsonRpcSocket,
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setupOnboardingJsdom() {
  return setupJsdom({
    includeAnimationFrame: {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      },
      cancelAnimationFrame: () => {},
    },
    extraGlobals: {
      ResizeObserver: MockResizeObserver,
    },
  });
}

const { useAppStore } = await import("../src/app/store");
const { DesktopOnboarding } = await import("../src/ui/onboarding/DesktopOnboarding");
const { DeveloperPage } = await import("../src/ui/settings/pages/DeveloperPage");

const defaultProviderActions = {
  requestProviderCatalog: useAppStore.getState().requestProviderCatalog,
  requestProviderAuthMethods: useAppStore.getState().requestProviderAuthMethods,
  refreshProviderStatus: useAppStore.getState().refreshProviderStatus,
};
const defaultStoreActions = {
  ...defaultProviderActions,
  setLmStudioEnabled: useAppStore.getState().setLmStudioEnabled,
  startOnboarding: useAppStore.getState().startOnboarding,
};

describe("DeveloperPage rerun onboarding button", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("renders the 'Run onboarding again' button", async () => {
    const harness = setupOnboardingJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Test Workspace",
              path: "/tmp/test",
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
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      expect(container.textContent).toContain("Onboarding");
      expect(container.textContent).toContain("Run onboarding again");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("provider step only triggers the consolidated provider refresh", async () => {
    const requestProviderCatalog = mock(async () => {});
    const requestProviderAuthMethods = mock(async () => {});
    const refreshProviderStatus = mock(async () => {});
    const harness = setupOnboardingJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          onboardingVisible: true,
          onboardingStep: "provider",
          providerCatalog: [
            { id: "openai", name: "OpenAI" },
            { id: "codex-cli", name: "Codex CLI" },
          ] as any,
          providerConnected: [],
          ...defaultProviderActions,
          requestProviderCatalog,
          requestProviderAuthMethods,
          refreshProviderStatus,
        });
      });

      await act(async () => {
        root.render(createElement(DesktopOnboarding));
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

  test("provider step shows LM Studio local connect controls instead of an API key field", async () => {
    const harness = setupOnboardingJsdom();
    const setLmStudioEnabled = mock(async () => {});
    const refreshProviderStatus = mock(async () => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          onboardingVisible: true,
          onboardingStep: "provider",
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
          providerStatusByName: {
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
          providerConnected: [],
          providerUiState: {
            lmstudio: {
              enabled: false,
              hiddenModels: [],
            },
          },
          setLmStudioEnabled,
          ...defaultProviderActions,
          refreshProviderStatus,
        });
      });

      await act(async () => {
        root.render(createElement(DesktopOnboarding));
      });

      const lmStudioButton = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("LM Studio"),
      );
      if (!lmStudioButton) throw new Error("missing LM Studio onboarding card");

      await act(async () => {
        lmStudioButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).toContain("LM Studio runs on a local server.");
      expect(container.textContent).toContain("Connect");
      expect(container.textContent).toContain("Refresh");
      expect(container.textContent).not.toContain("Paste your API key");
      expect(container.textContent).not.toContain("API token");

      const connectButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Connect");
      if (!connectButton) throw new Error("missing LM Studio connect button");
      await act(async () => {
        connectButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(setLmStudioEnabled).toHaveBeenCalledWith(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("clicking 'Run onboarding again' calls startOnboarding", async () => {
    const startOnboarding = mock(() => {});
    const harness = setupOnboardingJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          onboardingVisible: false,
          onboardingStep: "welcome",
          onboardingState: { status: "completed", completedAt: "2026-03-10T00:00:00Z", dismissedAt: null },
          startOnboarding,
          workspaces: [
            {
              id: "ws-1",
              name: "Test Workspace",
              path: "/tmp/test",
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
        });
      });

      await act(async () => {
        root.render(createElement(DeveloperPage));
      });

      const button = [...container.querySelectorAll("button")].find(
        (btn) => btn.textContent?.includes("Run onboarding again"),
      );
      if (!button) throw new Error("missing 'Run onboarding again' button");

      await act(async () => {
        button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(startOnboarding).toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
