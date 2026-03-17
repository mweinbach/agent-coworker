import { describe, expect, mock, test } from "bun:test";

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

mock.module("../src/lib/desktopCommands", () => ({
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

// ── Protocol guard ──

describe("websocket protocol files unchanged", () => {
  test("no websocket protocol types reference onboarding", async () => {
    const fs = await import("node:fs");
    const protocolPath = new URL("../src/lib/wsProtocol.ts", import.meta.url).pathname;
    const content = fs.readFileSync(protocolPath, "utf8");
    expect(content).not.toContain("onboarding");
  });
});
