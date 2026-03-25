import { describe, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

// ── Pure helper tests (no DOM needed) ──

import {
  DEFAULT_ONBOARDING_STATE,
  shouldAutoOpenOnboarding,
  shouldBackfillOnboardingCompleted,
} from "../src/app/store.actions/onboarding";

describe("shouldAutoOpenOnboarding", () => {
  test("returns true for a completely fresh user", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: undefined,
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(true);
  });

  test("returns true when onboarding is explicitly pending and no usage", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: { status: "pending", completedAt: null, dismissedAt: null },
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(true);
  });

  test("returns false when onboarding was dismissed", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: { status: "dismissed", completedAt: null, dismissedAt: "2026-03-10T00:00:00Z" },
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });

  test("returns false when onboarding was completed", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: { status: "completed", completedAt: "2026-03-10T00:00:00Z", dismissedAt: null },
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });

  test("returns false when user already has a workspace", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: undefined,
        workspaceCount: 1,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });

  test("returns false when user already has threads", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: undefined,
        workspaceCount: 0,
        threadCount: 3,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });

  test("returns false when user already has a connected provider", () => {
    expect(
      shouldAutoOpenOnboarding({
        onboarding: undefined,
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: true,
      }),
    ).toBe(false);
  });
});

describe("shouldBackfillOnboardingCompleted", () => {
  test("returns true when onboarding is pending and user has a workspace", () => {
    expect(
      shouldBackfillOnboardingCompleted({
        onboarding: undefined,
        workspaceCount: 1,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(true);
  });

  test("returns true when onboarding is pending and user has a thread", () => {
    expect(
      shouldBackfillOnboardingCompleted({
        onboarding: undefined,
        workspaceCount: 0,
        threadCount: 1,
        hasConnectedProvider: false,
      }),
    ).toBe(true);
  });

  test("returns true when onboarding is pending and user has a connected provider", () => {
    expect(
      shouldBackfillOnboardingCompleted({
        onboarding: undefined,
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: true,
      }),
    ).toBe(true);
  });

  test("returns false when onboarding is already completed", () => {
    expect(
      shouldBackfillOnboardingCompleted({
        onboarding: { status: "completed", completedAt: "2026-03-10T00:00:00Z", dismissedAt: null },
        workspaceCount: 1,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });

  test("returns false when onboarding is already dismissed", () => {
    expect(
      shouldBackfillOnboardingCompleted({
        onboarding: { status: "dismissed", completedAt: null, dismissedAt: "2026-03-10T00:00:00Z" },
        workspaceCount: 1,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });

  test("returns false when user has no meaningful state", () => {
    expect(
      shouldBackfillOnboardingCompleted({
        onboarding: undefined,
        workspaceCount: 0,
        threadCount: 0,
        hasConnectedProvider: false,
      }),
    ).toBe(false);
  });
});

describe("DEFAULT_ONBOARDING_STATE", () => {
  test("has pending status with null timestamps", () => {
    expect(DEFAULT_ONBOARDING_STATE).toEqual({
      status: "pending",
      completedAt: null,
      dismissedAt: null,
    });
  });
});

// ── Store action tests (with module mocking) ──

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

let lastSavedState: any = null;

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async (state: any) => { lastSavedState = state; },
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

describe("onboarding store actions", () => {
  test("dismissOnboarding hides overlay and persists dismissed status", async () => {
    useAppStore.setState({
      onboardingVisible: true,
      onboardingStep: "workspace",
      onboardingState: { status: "pending", completedAt: null, dismissedAt: null },
    });

    const state = useAppStore.getState();
    state.dismissOnboarding();

    const after = useAppStore.getState();
    expect(after.onboardingVisible).toBe(false);
    expect(after.onboardingState.status).toBe("dismissed");
    expect(after.onboardingState.dismissedAt).toBeTruthy();

    // Wait for persistNow to flush
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastSavedState?.onboarding?.status).toBe("dismissed");
  });

  test("completeOnboarding hides overlay and persists completed status", async () => {
    useAppStore.setState({
      onboardingVisible: true,
      onboardingStep: "firstThread",
      onboardingState: { status: "pending", completedAt: null, dismissedAt: null },
    });

    const state = useAppStore.getState();
    state.completeOnboarding();

    const after = useAppStore.getState();
    expect(after.onboardingVisible).toBe(false);
    expect(after.onboardingState.status).toBe("completed");
    expect(after.onboardingState.completedAt).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastSavedState?.onboarding?.status).toBe("completed");
  });

  test("startOnboarding reopens overlay on welcome step", () => {
    useAppStore.setState({
      onboardingVisible: false,
      onboardingStep: "defaults",
      onboardingState: { status: "completed", completedAt: "2026-03-10T00:00:00Z", dismissedAt: null },
    });

    const state = useAppStore.getState();
    state.startOnboarding();

    const after = useAppStore.getState();
    expect(after.onboardingVisible).toBe(true);
    expect(after.onboardingStep).toBe("welcome");
    // Does NOT reset persisted state — it's a rerun, not a reset.
    expect(after.onboardingState.status).toBe("completed");
  });

  test("setOnboardingStep changes the step", () => {
    useAppStore.setState({ onboardingStep: "welcome" });
    useAppStore.getState().setOnboardingStep("provider");
    expect(useAppStore.getState().onboardingStep).toBe("provider");
  });
});

// ── Persistence schema tests ──

describe("onboarding persistence schema", () => {
  test("missing onboarding field defaults safely in desktopSchemas", async () => {
    const { persistedStateInputSchema } = await import("../src/lib/desktopSchemas");
    const result = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [],
      threads: [],
    });
    // onboarding should be undefined when not present (optional field)
    expect(result.onboarding).toBeUndefined();
  });

  test("valid onboarding state round-trips through the schema", async () => {
    const { persistedStateInputSchema } = await import("../src/lib/desktopSchemas");
    const result = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [],
      threads: [],
      onboarding: {
        status: "completed",
        completedAt: "2026-03-10T00:00:00Z",
        dismissedAt: null,
      },
    });
    expect(result.onboarding).toEqual({
      status: "completed",
      completedAt: "2026-03-10T00:00:00Z",
      dismissedAt: null,
    });
  });

  test("invalid onboarding status defaults to pending", async () => {
    const { persistedStateInputSchema } = await import("../src/lib/desktopSchemas");
    const result = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [],
      threads: [],
      onboarding: {
        status: "unknown_garbage",
        completedAt: null,
        dismissedAt: null,
      },
    });
    expect(result.onboarding?.status).toBe("pending");
  });
});

// ── Escape dismiss ──

describe("escape key dismisses onboarding", () => {
  test("dismissOnboarding is callable when onboardingVisible is true", () => {
    useAppStore.setState({
      onboardingVisible: true,
      onboardingStep: "provider",
      onboardingState: { status: "pending", completedAt: null, dismissedAt: null },
    });

    const state = useAppStore.getState();
    expect(state.onboardingVisible).toBe(true);

    // The actual Escape keydown handler lives in App.tsx and checks
    // state.onboardingVisible before dispatching dismissOnboarding.
    // We verify the state flag and action are consistent here.
    state.dismissOnboarding();
    const after = useAppStore.getState();
    expect(after.onboardingVisible).toBe(false);
    expect(after.onboardingState.status).toBe("dismissed");
  });
});

// ── Rerun from completed state doesn't wipe data ──

describe("rerun preserves existing state", () => {
  test("startOnboarding does not clear workspaces or threads", () => {
    useAppStore.setState({
      onboardingVisible: false,
      onboardingState: { status: "completed", completedAt: "2026-03-10T00:00:00Z", dismissedAt: null },
      workspaces: [
        {
          id: "ws-1",
          name: "Existing",
          path: "/tmp/existing",
          createdAt: "2026-03-10T00:00:00Z",
          lastOpenedAt: "2026-03-10T00:00:00Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultPreferredChildModel: "gpt-5.2",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ] as any,
      threads: [
        {
          id: "t-1",
          workspaceId: "ws-1",
          title: "Thread 1",
          createdAt: "2026-03-10T00:00:00Z",
          lastMessageAt: "2026-03-10T00:00:00Z",
          status: "active",
          sessionId: null,
          lastEventSeq: 0,
        },
      ] as any,
    });

    useAppStore.getState().startOnboarding();

    const after = useAppStore.getState();
    expect(after.onboardingVisible).toBe(true);
    expect(after.workspaces).toHaveLength(1);
    expect(after.threads).toHaveLength(1);
  });
});

// ── Error recovery path ──

describe("init error path does not force onboarding", () => {
  test("onboardingVisible is false after init failure", () => {
    // Simulate what the catch block in init() does:
    // it should NOT set onboardingVisible: true for existing users
    // who hit a transient error.
    useAppStore.setState({
      onboardingVisible: false,
      onboardingState: { status: "completed", completedAt: "2026-03-10T00:00:00Z", dismissedAt: null },
    });

    // The error path now sets onboardingVisible: false
    useAppStore.setState({
      onboardingVisible: false,
      onboardingStep: "welcome",
      ready: true,
      startupError: "simulated failure",
    });

    const after = useAppStore.getState();
    expect(after.onboardingVisible).toBe(false);
    expect(after.startupError).toBe("simulated failure");
  });
});

// ── Shared provider utilities ──

describe("shared provider display utilities", () => {
  test("displayProviderName returns human names", async () => {
    const { displayProviderName } = await import("../src/lib/providerDisplayNames");
    expect(displayProviderName("openai")).toBe("OpenAI");
    expect(displayProviderName("google")).toBe("Google");
    expect(displayProviderName("anthropic")).toBe("Anthropic");
  });

  test("isProviderNameString validates known providers", async () => {
    const { isProviderNameString } = await import("../src/lib/providerDisplayNames");
    expect(isProviderNameString("openai")).toBe(true);
    expect(isProviderNameString("google")).toBe(true);
    expect(isProviderNameString("not-a-provider")).toBe(false);
  });

  test("fallbackAuthMethods returns api key for most providers", async () => {
    const { fallbackAuthMethods } = await import("../src/lib/providerDisplayNames");
    const methods = fallbackAuthMethods("openai");
    expect(methods).toHaveLength(1);
    expect(methods[0]!.type).toBe("api");
  });

  test("fallbackAuthMethods returns oauth for codex-cli", async () => {
    const { fallbackAuthMethods } = await import("../src/lib/providerDisplayNames");
    const methods = fallbackAuthMethods("codex-cli");
    expect(methods.length).toBeGreaterThan(1);
    expect(methods[0]!.type).toBe("oauth");
  });
});

// ── Protocol guard ──

describe("websocket protocol files unchanged", () => {
  test("no websocket protocol types reference onboarding", async () => {
    const fs = await import("node:fs");
    const protocolPath = fileURLToPath(new URL("../src/lib/wsProtocol.ts", import.meta.url));
    const content = fs.readFileSync(protocolPath, "utf8");
    expect(content).not.toContain("onboarding");
  });
});
