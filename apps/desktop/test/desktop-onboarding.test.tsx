import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
      shouldUseDarkColorsForSystemIntegratedUI: false,
      shouldUseHighContrastColors: false,
      shouldUseInvertedColorScheme: false,
      prefersReducedTransparency: false,
      inForcedColorsMode: false,
    }),
    setWindowAppearance: async () => ({
      platform: "linux",
      themeSource: "system",
      shouldUseDarkColors: false,
      shouldUseDarkColorsForSystemIntegratedUI: false,
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
      lastCheckStartedAt: null,
      downloadedAt: null,
      message: null,
      error: null,
      release: null,
      progress: null,
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
const { DesktopOnboarding } = await import("../src/ui/onboarding/DesktopOnboarding");
const defaultStoreState = useAppStore.getState();

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(input, value);
    return;
  }
  if (valueSetter) {
    valueSetter.call(input, value);
    return;
  }
  input.value = value;
}

describe("desktop onboarding", () => {
  beforeEach(() => {
    useAppStore.setState(defaultStoreState, true);
    useAppStore.setState({
      ready: true,
      bootstrapPending: false,
      onboardingVisible: true,
      onboardingStep: "provider",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: "2026-06-17T00:00:00.000Z",
          lastOpenedAt: "2026-06-17T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      providerStatusByName: {
        openai: {
          provider: "openai",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Not connected.",
          checkedAt: "2026-06-17T00:00:00.000Z",
        },
      } as any,
      providerCatalog: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              id: "gpt-5.2",
              displayName: "GPT-5.2",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
          defaultModel: "gpt-5.2",
        },
      ] as any,
      providerAuthMethodsByProvider: {
        openai: [{ id: "api_key", type: "api", label: "API key" }],
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
      refreshProviderStatus: mock(async () => {}),
    });
  });

  test("pasting an API key into the provider step keeps the onboarding overlay mounted", async () => {
    const harness = setupJsdom();
    const setProviderApiKey = mock(async () => {});
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      useAppStore.setState({ setProviderApiKey });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(DesktopOnboarding));
      });

      const openAiButton = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("OpenAI"),
      );
      if (!openAiButton) throw new Error("missing OpenAI provider button");
      await act(async () => {
        openAiButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const input = container.querySelector('input[aria-label="OpenAI API key"]');
      if (!(input instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing OpenAI API key input");
      }
      await act(async () => {
        input.focus();
        setNativeInputValue(input, "sk-test-pasted");
        input.dispatchEvent(
          new harness.dom.window.InputEvent("input", {
            bubbles: true,
            inputType: "insertFromPaste",
            data: "sk-test-pasted",
          }),
        );
        input.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
      });

      expect(container.querySelector('[aria-label="Onboarding"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Something went wrong.");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      harness.restore();
    }
  });

  test("input change handlers capture event values before functional state updates", async () => {
    const source = await readFile("apps/desktop/src/ui/onboarding/DesktopOnboarding.tsx", "utf-8");

    expect(source).toContain("const nextValue = e.currentTarget.value;");
    expect(source).not.toContain(
      "setApiKeys((s) => ({ ...s, [stateKey]: e.currentTarget.value }))",
    );
    expect(source).not.toContain("[stateKey]: e.currentTarget.value");
  });
});
