import { beforeEach, describe, expect, mock, test } from "bun:test";
import { __internalResearchActionBindings } from "../src/app/store.actions/research";
import { disposeAllJsonRpcSocketState } from "../src/app/store.helpers/jsonRpcSocket";
import { defaultWorkspaceRuntime, RUNTIME } from "../src/app/store.helpers/runtimeState";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

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
const savedStates: any[] = [];
let startWorkspaceServerCalls = 0;
let agentSocketConnectCalls = 0;
let remoteAccessEnabled = true;
let stopMobileRelayCalls = 0;
let packagedApp = false;

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    appendTranscriptBatch: async () => {},
    appendTranscriptEvent: async () => {},
    deleteTranscript: async () => {},
    listDirectory: async () => [],
    loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
    pickWorkspaceDirectory: async () => null,
    readTranscript: async () => [],
    saveState: async (state: any) => {
      savedStates.push(structuredClone(state));
    },
    startWorkspaceServer: async () => {
      startWorkspaceServerCalls += 1;
      return { url: "ws://mock" };
    },
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
    getDesktopFeatureFlags: (featureOverrides) => ({
      remoteAccess:
        typeof featureOverrides?.remoteAccess === "boolean"
          ? featureOverrides.remoteAccess
          : remoteAccessEnabled,
      workspacePicker:
        typeof featureOverrides?.workspacePicker === "boolean"
          ? featureOverrides.workspacePicker
          : true,
      workspaceLifecycle:
        typeof featureOverrides?.workspaceLifecycle === "boolean"
          ? featureOverrides.workspaceLifecycle
          : true,
      a2ui: typeof featureOverrides?.a2ui === "boolean" ? featureOverrides.a2ui : false,
    }),
    isPackagedDesktopApp: () => packagedApp,
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
    stopMobileRelay: async () => {
      stopMobileRelayCalls += 1;
      return {
        status: "idle",
        workspaceId: null,
        workspacePath: null,
        relaySource: "unavailable",
        relaySourceMessage: null,
        relayServiceStatus: "unknown",
        relayServiceMessage: null,
        relayServiceUpdatedAt: null,
        relayUrl: null,
        sessionId: null,
        pairingPayload: null,
        trustedPhoneDeviceId: null,
        trustedPhoneFingerprint: null,
        lastError: null,
      };
    },
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");

describe("settings nav (store)", () => {
  beforeEach(() => {
    __internalResearchActionBindings.reset();
    disposeAllJsonRpcSocketState();
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.pluginInstallWaiters.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadAttachments.clear();
    RUNTIME.pendingThreadSteers.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.nextThreadSelectionRequestId = 0;
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.modelStreamByThread.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.workspacePickerOpen = false;
    RUNTIME.providerStatusRefreshGeneration = 0;
    savedStates.length = 0;
    startWorkspaceServerCalls = 0;
    agentSocketConnectCalls = 0;
    remoteAccessEnabled = true;
    stopMobileRelayCalls = 0;
    packagedApp = false;
    useAppStore.setState({
      view: "chat",
      lastNonSettingsView: "chat",
      settingsPage: "providers",
      updateState: MOCK_UPDATE_STATE,
      desktopFeatureFlags: {
        remoteAccess: true,
        workspacePicker: true,
        workspaceLifecycle: true,
        a2ui: false,
      },
      notifications: [],
      workspaces: [],
      workspaceRuntimeById: {},
      selectedWorkspaceId: null,
      researchTransportWorkspaceId: null,
      researchById: {},
      researchOrder: [],
      selectedResearchId: null,
      researchListLoading: false,
      researchListError: null,
      researchSubscribedIds: [],
      researchExportPendingIds: [],
      threads: [],
      threadRuntimeById: {},
      selectedThreadId: null,
    });
  });

  test("openSettings records lastNonSettingsView and enters settings", () => {
    useAppStore.setState({ view: "skills" });
    useAppStore.getState().openSettings();
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().lastNonSettingsView).toBe("skills");
  });

  test("openSettings optionally selects a settings page", () => {
    useAppStore.getState().openSettings("workspaces");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("workspaces");
  });

  test("closeSettings restores the prior view", () => {
    useAppStore.setState({ view: "skills" });
    useAppStore.getState().openSettings();
    useAppStore.getState().closeSettings();
    expect(useAppStore.getState().view).toBe("skills");
  });

  test("setSettingsPage updates settingsPage", () => {
    useAppStore.getState().setSettingsPage("workspaces");
    expect(useAppStore.getState().settingsPage).toBe("workspaces");
  });

  test("setSettingsPage accepts mcp page", () => {
    useAppStore.getState().setSettingsPage("mcp");
    expect(useAppStore.getState().settingsPage).toBe("mcp");
  });

  test("setSettingsPage accepts desktop page", () => {
    useAppStore.getState().setSettingsPage("desktop");
    expect(useAppStore.getState().settingsPage).toBe("desktop");
  });

  test("setSettingsPage accepts backup page", () => {
    useAppStore.getState().setSettingsPage("backup");
    expect(useAppStore.getState().settingsPage).toBe("backup");
  });

  test("openSettings accepts usage page", () => {
    useAppStore.getState().openSettings("usage");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("usage");
  });

  test("openSettings accepts backup page", () => {
    useAppStore.getState().openSettings("backup");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("backup");
  });

  test("openSettings accepts updates page", () => {
    useAppStore.getState().openSettings("updates");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("updates");
  });

  test("openSettings accepts desktop page", () => {
    useAppStore.getState().openSettings("desktop");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("desktop");
  });

  test("openSettings accepts remote access page", () => {
    useAppStore.getState().openSettings("remoteAccess");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("remoteAccess");
  });

  test("openSettings falls back when remote access is unavailable", () => {
    remoteAccessEnabled = false;
    useAppStore.setState({
      desktopFeatureFlags: {
        remoteAccess: false,
        workspacePicker: true,
        workspaceLifecycle: true,
        a2ui: false,
      },
    });
    useAppStore.getState().openSettings("remoteAccess");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("providers");
  });

  test("openSettings keeps feature flags available in packaged builds", () => {
    useAppStore.setState({
      updateState: {
        ...useAppStore.getState().updateState,
        packaged: true,
      },
    });
    useAppStore.getState().openSettings("featureFlags");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsPage).toBe("featureFlags");
  });

  test("disabling remote access tears down an active relay and falls back from the remote access page", async () => {
    useAppStore.setState({
      settingsPage: "remoteAccess",
      desktopFeatureFlags: {
        remoteAccess: true,
        workspacePicker: true,
        workspaceLifecycle: true,
        a2ui: false,
      },
      desktopFeatureFlagOverrides: {},
    });

    await useAppStore.getState().setDesktopFeatureFlagOverride("remoteAccess", false);

    expect(useAppStore.getState().desktopFeatureFlags.remoteAccess).toBe(false);
    expect(useAppStore.getState().desktopFeatureFlagOverrides).toEqual({ remoteAccess: false });
    expect(useAppStore.getState().settingsPage).toBe("providers");
    expect(stopMobileRelayCalls).toBe(1);
  });

  test("setDesktopFeatureFlagOverride preserves supported flags in packaged builds", async () => {
    useAppStore.setState({
      updateState: {
        ...useAppStore.getState().updateState,
        packaged: true,
      },
      desktopFeatureFlags: {
        remoteAccess: false,
        workspacePicker: true,
        workspaceLifecycle: true,
        a2ui: false,
      },
      desktopFeatureFlagOverrides: {},
    });

    await useAppStore.getState().setDesktopFeatureFlagOverride("a2ui", true);

    expect(useAppStore.getState().desktopFeatureFlagOverrides).toEqual({ a2ui: true });
    expect(useAppStore.getState().desktopFeatureFlags.a2ui).toBe(true);
    expect(savedStates.length).toBeGreaterThan(0);
  });

  test("setDesktopFeatureFlagOverride keeps forced-off flags blocked in packaged builds", async () => {
    const priorSaved = savedStates.length;
    useAppStore.setState({
      updateState: {
        ...useAppStore.getState().updateState,
        packaged: true,
      },
      desktopFeatureFlags: {
        remoteAccess: false,
        workspacePicker: true,
        workspaceLifecycle: true,
        a2ui: false,
      },
      desktopFeatureFlagOverrides: { remoteAccess: false },
    });

    await useAppStore.getState().setDesktopFeatureFlagOverride("remoteAccess", true);

    expect(useAppStore.getState().desktopFeatureFlagOverrides).toEqual({ remoteAccess: false });
    expect(savedStates.length).toBe(priorSaved);
  });

  test("setDesktopFeatureFlagOverride blocks forced-off flags before updater state hydrates", async () => {
    const priorSaved = savedStates.length;
    packagedApp = true;
    useAppStore.setState({
      updateState: {
        ...useAppStore.getState().updateState,
        packaged: false,
      },
      desktopFeatureFlags: {
        remoteAccess: false,
        workspacePicker: true,
        workspaceLifecycle: true,
        a2ui: false,
      },
      desktopFeatureFlagOverrides: { remoteAccess: false },
    });

    await useAppStore.getState().setDesktopFeatureFlagOverride("remoteAccess", true);

    expect(useAppStore.getState().desktopFeatureFlagOverrides).toEqual({ remoteAccess: false });
    expect(savedStates.length).toBe(priorSaved);
  });

  test("setDeveloperMode updates developer mode state", () => {
    useAppStore.getState().setDeveloperMode(true);
    expect(useAppStore.getState().developerMode).toBe(true);
  });

  test("setQuickChatShortcutEnabled updates persisted desktop settings", () => {
    useAppStore.setState({
      desktopSettings: {
        quickChat: {
          shortcutEnabled: false,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
      },
    });

    useAppStore.getState().setQuickChatShortcutEnabled(true);

    expect(useAppStore.getState().desktopSettings.quickChat.shortcutEnabled).toBe(true);
    expect(savedStates.at(-1)?.desktopSettings?.quickChat?.shortcutEnabled).toBe(true);
  });

  test("setQuickChatShortcutAccelerator normalizes and persists the shortcut", () => {
    useAppStore.setState({
      desktopSettings: {
        quickChat: {
          shortcutEnabled: true,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
      },
    });

    useAppStore.getState().setQuickChatShortcutAccelerator(" alt + space ");

    expect(useAppStore.getState().desktopSettings.quickChat.shortcutAccelerator).toBe("Alt+Space");
    expect(savedStates.at(-1)?.desktopSettings?.quickChat?.shortcutAccelerator).toBe("Alt+Space");
  });

  test("openSkills shows guidance when no workspace is available", async () => {
    await useAppStore.getState().openSkills();
    expect(useAppStore.getState().view).toBe("chat");
    const last = useAppStore.getState().notifications.at(-1);
    expect(last?.title).toBe("Skills need a workspace");
  });

  test("openResearch switches to the research view before transport refresh completes", async () => {
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
        },
      },
    });

    RUNTIME.jsonRpcSockets.set("ws-1", {
      readyPromise: Promise.resolve(),
      request: (method: string) => {
        if (method === "research/list") {
          return Promise.resolve({ research: [] });
        }
        return Promise.resolve({});
      },
      respond: () => true,
      close: () => {},
    } as any);

    const openPromise = useAppStore.getState().openResearch();

    expect(useAppStore.getState().view).toBe("research");
    expect(useAppStore.getState().lastNonSettingsView).toBe("research");
    expect(useAppStore.getState().researchListLoading).toBe(true);

    await openPromise;
    expect(useAppStore.getState().researchListError).toBeNull();
  });

  test("newThread falls back to first workspace when none is selected", async () => {
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: null,
      threads: [],
    });

    await useAppStore.getState().newThread();
    const state = useAppStore.getState();

    expect(state.selectedWorkspaceId).toBe("ws-1");
    expect(state.threads.length).toBe(1);
    expect(state.threads[0]?.workspaceId).toBe("ws-1");
    expect(state.selectedThreadId).toBe(state.threads[0]?.id);
    expect(state.threads[0]?.draft).toBe(true);
    expect(savedStates.at(-1)?.threads).toEqual([]);
    expect(startWorkspaceServerCalls).toBe(0);
    expect(agentSocketConnectCalls).toBe(0);
  });

  test("cancelThread does not auto-reset busy state when socket is unavailable", () => {
    useAppStore.setState({
      threads: [
        {
          id: "t1",
          workspaceId: "ws-1",
          title: "Thread",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:00.000Z",
          status: "active",
        },
      ],
      threadRuntimeById: {
        t1: {
          wsUrl: "ws://mock",
          connected: true,
          sessionId: null,
          config: null,
          enableMcp: null,
          busy: true,
          busySince: "2024-01-01T00:00:00.000Z",
          feed: [],
          transcriptOnly: false,
        },
      },
      notifications: [],
    });

    useAppStore.getState().cancelThread("t1");
    const state = useAppStore.getState();
    expect(state.threadRuntimeById.t1?.busy).toBe(true);
    expect(state.threadRuntimeById.t1?.connected).toBe(true);
    expect(state.threads[0]?.status).toBe("active");
    expect(state.notifications.at(-1)?.title).toBe("Not connected");
  });
});
