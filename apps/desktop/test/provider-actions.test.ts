import { beforeEach, describe, expect, mock, test } from "bun:test";

const startWorkspaceServerMock = mock(async () => ({ url: "ws://mock" }));

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {
    throw new Error("disk full");
  },
  startWorkspaceServer: startWorkspaceServerMock,
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
  getSystemAppearance: async () => ({
    platform: "linux",
    themeSource: "system",
    shouldUseDarkColors: false,
    shouldUseHighContrastColors: false,
    shouldUseInvertedColorScheme: false,
    prefersReducedTransparency: false,
    inForcedColorsMode: false,
  }),
  setWindowAppearance: async () => ({
    platform: "linux",
    themeSource: "system",
    shouldUseDarkColors: false,
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
    release: null,
    progress: null,
    error: null,
  }),
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

const { createProviderActions } = await import("../src/app/store.actions/provider");
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");

type TestState = {
  selectedWorkspaceId: string | null;
  workspaces: Array<{ id: string }>;
  workspaceRuntimeById: Record<string, unknown>;
  providerStatusByName: Record<string, unknown>;
  providerStatusLastUpdatedAt: string | null;
  providerStatusRefreshing: boolean;
  providerUiState: {
    lmstudio: {
      enabled: boolean;
      hiddenModels: string[];
    };
  };
  notifications: Array<{ detail?: string }>;
  userConfigLastResult: Record<string, unknown> | null;
  pendingUserConfigSave: boolean;
  threads: Array<{ draft?: boolean }>;
  developerMode: boolean;
  showHiddenFiles: boolean;
  perWorkspaceSettings: Record<string, unknown>;
  onboardingState: Record<string, unknown>;
  selectedThreadId: string | null;
  view: string;
  settingsPage: string;
  lastNonSettingsView: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextSidebarCollapsed: boolean;
  contextSidebarWidth: number;
  messageBarHeight: number;
  refreshProviderStatus: () => Promise<void>;
};

function createState(): TestState {
  return {
    selectedWorkspaceId: null,
    workspaces: [],
    workspaceRuntimeById: {},
    providerStatusByName: {},
    providerStatusLastUpdatedAt: null,
    providerStatusRefreshing: false,
    providerUiState: {
      lmstudio: {
        enabled: false,
        hiddenModels: [],
      },
    },
    notifications: [],
    userConfigLastResult: null,
    pendingUserConfigSave: false,
    threads: [],
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: {},
    onboardingState: {},
    selectedThreadId: null,
    view: "chat",
    settingsPage: "providers",
    lastNonSettingsView: "chat",
    sidebarCollapsed: false,
    sidebarWidth: 280,
    contextSidebarCollapsed: false,
    contextSidebarWidth: 320,
    messageBarHeight: 120,
    refreshProviderStatus: async () => {},
  };
}

function createStoreHarness(state: TestState) {
  const get = () => state as any;
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state as any) : updater;
    Object.assign(state, patch);
  };
  return { get, set };
}

describe("provider store actions", () => {
  beforeEach(() => {
    RUNTIME.controlSockets.clear();
    RUNTIME.threadSockets.clear();
    RUNTIME.sessionSnapshots.clear();
    startWorkspaceServerMock.mockReset();
    startWorkspaceServerMock.mockImplementation(async () => ({ url: "ws://mock" }));
  });

  test("refreshProviderStatus notifies when control session cannot be prepared", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);
    const actions = createProviderActions(set as any, get as any);

    await actions.refreshProviderStatus();

    expect(state.providerStatusRefreshing).toBe(false);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.detail).toBe("Unable to refresh provider status.");
  });

  test("setGlobalOpenAiProxyBaseUrl publishes a failed result when control session cannot be prepared", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);
    const actions = createProviderActions(set as any, get as any);

    await actions.setGlobalOpenAiProxyBaseUrl("https://proxy.example.com/v1");

    expect(state.pendingUserConfigSave).toBe(false);
    expect(state.userConfigLastResult).toEqual({
      type: "user_config_result",
      sessionId: "",
      ok: false,
      message: "Unable to update global user config.",
    });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.detail).toBe("Unable to update global user config.");
  });

  test("setLmStudioEnabled rolls back local state and skips refresh when persist fails", async () => {
    const state = createState();
    const refreshProviderStatus = mock(async () => {});
    state.refreshProviderStatus = refreshProviderStatus;
    const { get, set } = createStoreHarness(state);
    const actions = createProviderActions(set as any, get as any);

    await actions.setLmStudioEnabled(true);

    expect(state.providerUiState.lmstudio.enabled).toBe(false);
    expect(refreshProviderStatus).toHaveBeenCalledTimes(0);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.detail).toBe("Unable to save LM Studio settings.");
  });

  test("setLmStudioModelVisible rolls back hidden models when persist fails", async () => {
    const state = createState();
    state.providerUiState.lmstudio.hiddenModels = ["kept-model"];
    const { get, set } = createStoreHarness(state);
    const actions = createProviderActions(set as any, get as any);

    await actions.setLmStudioModelVisible("new-model", false);

    expect(state.providerUiState.lmstudio.hiddenModels).toEqual(["kept-model"]);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.detail).toBe("Unable to save LM Studio model visibility.");
  });
});
