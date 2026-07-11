import type { DesktopApi } from "../../src/lib/desktopApi";
import { DESKTOP_API_OVERRIDE_KEY } from "../../src/lib/desktopApiOverride";
import type * as DesktopCommands from "../../src/lib/desktopCommands";

type DesktopCommandsModule = typeof DesktopCommands;

export const DEFAULT_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseDarkColorsForSystemIntegratedUI: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
} satisfies Awaited<ReturnType<typeof import("../../src/lib/desktopCommands").getSystemAppearance>>;

export const DEFAULT_UPDATE_STATE = {
  phase: "idle",
  packaged: false,
  currentVersion: "0.1.0",
  lastCheckStartedAt: null,
  lastCheckedAt: null,
  downloadedAt: null,
  message: null,
  error: null,
  progress: null,
  release: null,
} satisfies Awaited<ReturnType<typeof import("../../src/lib/desktopCommands").getUpdateState>>;

const DEFAULT_MOBILE_RELAY_STATE = {
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
  trustedPhoneDevices: [],
  directUrl: null,
  ticketUrl: null,
  certSha256: null,
  spkiSha256: null,
  hostHints: [],
  lastError: null,
} satisfies Awaited<ReturnType<typeof import("../../src/lib/desktopCommands").getMobileRelayState>>;

const DEFAULT_PLATFORM_CHROME = {
  platform: "linux",
  titlebarHeight: 0,
  dragStripHeight: 8,
  leftNativeReserve: 0,
  rightNativeReserve: 136,
  captionButtonReserve: 136,
  collapsedLeftRailWidth: 84,
  topbarToolbarGap: 6,
  sidebarTitlebandMode: "native",
  topbarControlPlacement: "left-rail",
  usesNativeGlass: false,
  disableCssBlur: false,
} satisfies Awaited<ReturnType<typeof import("../../src/lib/desktopCommands").getPlatformChrome>>;

export const DEFAULT_TELEMETRY_STATUS = {
  globalKillSwitchActive: false,
  crashReports: {
    label: "Not configured",
    status: "not_configured",
    configured: false,
    enabled: false,
  },
  productAnalytics: {
    label: "Disabled",
    status: "disabled",
    configured: false,
    enabled: false,
  },
  aiTraces: {
    label: "Disabled",
    status: "disabled",
    configured: false,
    enabled: false,
  },
  diagnosticsUpload: {
    label: "Disabled",
    status: "disabled",
    configured: false,
    enabled: false,
  },
  cloudSync: {
    label: "Disabled",
    status: "disabled",
    configured: false,
    enabled: false,
  },
} satisfies Awaited<ReturnType<typeof import("../../src/lib/desktopCommands").getTelemetryStatus>>;

export function createDesktopCommandsMock(
  overrides: Partial<DesktopCommandsModule> = {},
): DesktopCommandsModule {
  const resolveFlags = (featureOverrides?: {
    menuBar?: boolean;
    remoteAccess?: boolean;
    workspacePicker?: boolean;
    workspaceLifecycle?: boolean;
    openAiNativeConnectors?: boolean;
    canvas?: boolean;
    tasks?: boolean;
  }) => ({
    menuBar: typeof featureOverrides?.menuBar === "boolean" ? featureOverrides.menuBar : true,
    remoteAccess:
      typeof featureOverrides?.remoteAccess === "boolean" ? featureOverrides.remoteAccess : true,
    workspacePicker:
      typeof featureOverrides?.workspacePicker === "boolean"
        ? featureOverrides.workspacePicker
        : true,
    workspaceLifecycle:
      typeof featureOverrides?.workspaceLifecycle === "boolean"
        ? featureOverrides.workspaceLifecycle
        : true,
    openAiNativeConnectors:
      typeof featureOverrides?.openAiNativeConnectors === "boolean"
        ? featureOverrides.openAiNativeConnectors
        : false,
    canvas: typeof featureOverrides?.canvas === "boolean" ? featureOverrides.canvas : false,
    tasks: typeof featureOverrides?.tasks === "boolean" ? featureOverrides.tasks : false,
  });

  return {
    getDesktopFeatureFlags: (featureOverrides) => resolveFlags(featureOverrides),
    isPackagedDesktopApp: () => false,
    isDesktopDemoMode: () => false,
    createOneOffChatWorkspace: async () => ({ name: "New chat", path: "/tmp/cowork-chat" }),
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
    getWorkspaceServerStatus: async ({ workspaceId }) => ({
      workspaceId,
      running: true,
      url: "ws://mock",
      reason: "running",
    }),
    stopWorkspaceServer: async () => {},
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
    captureProductEvent: async () => {},
    readTranscript: async () => [],
    hydrateTranscript: async () => ({
      feed: [],
      agents: [],
      sessionUsage: null,
      lastTurnUsage: null,
    }),
    appendTranscriptEvent: async () => {},
    appendTranscriptBatch: async () => {},
    captureTranscriptEvent: () => null,
    onTranscriptDeliveryFailure: () => () => {},
    retryTranscriptDelivery: async () => {},
    discardTranscriptBatch: async () => {},
    deleteTranscript: async () => {},
    pickWorkspaceDirectory: async () => null,
    pickDirectory: async () => null,
    showContextMenu: async () => null,
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    resolveWindowCloseRequest: async () => {},
    windowDragStart: async () => {},
    windowDragMove: async () => {},
    windowDragEnd: async () => {},
    getPlatform: async () => "linux",
    getPlatformChrome: async () => DEFAULT_PLATFORM_CHROME,
    showMainWindow: async () => {},
    showCanvasWindow: async () => {},
    showQuickChatWindow: async (_opts?: { threadId?: string; newThread?: boolean }) => {},
    listDirectory: async () => [],
    readFile: async () => "",
    writeFile: async () => {},
    readFileForPreview: async ({ path }) => ({
      path,
      bytes: new Uint8Array(),
      byteLength: 0,
      truncated: false,
      version: {
        modifiedAtMs: 0,
        changeTimeMs: 0,
        size: 0,
        fingerprint: "test:empty",
      },
    }),
    getPreferredFileApp: async () => null,
    previewOSFile: async () => {},
    openPath: async () => {},
    saveExportedFile: async () => null,
    pickCanvasSavePath: async () => null,
    openExternalUrl: async () => {},
    revealPath: async () => {},
    copyPath: async () => {},
    copyText: async () => {},
    createDirectory: async () => {},
    renamePath: async () => {},
    trashPath: async () => {},
    confirmAction: async () => true,
    showNotification: async () => true,
    writeRendererLog: async () => {},
    createDiagnosticsBundle: async () => ({
      path: "/tmp/cowork-diagnostics.json",
      createdAt: "2026-06-01T00:00:00.000Z",
      summary: "Cowork diagnostics bundle",
      uploadConfigured: false,
      uploadEnabled: false,
    }),
    revealDiagnosticsBundle: async () => {},
    openLogsFolder: async () => {},
    uploadDiagnosticsBundle: async () => ({
      uploaded: false,
      path: "/tmp/cowork-diagnostics.json",
      diagnosticId: null,
      url: null,
      message: "No diagnostics upload endpoint is configured. The local bundle is ready.",
    }),
    getTelemetryStatus: async () => DEFAULT_TELEMETRY_STATUS,
    getUpdateState: async () => DEFAULT_UPDATE_STATE,
    checkForUpdates: async () => {},
    quitAndInstallUpdate: async () => {},
    getSystemAppearance: async () => DEFAULT_SYSTEM_APPEARANCE,
    setWindowAppearance: async () => DEFAULT_SYSTEM_APPEARANCE,
    startMobileRelay: async () => DEFAULT_MOBILE_RELAY_STATE,
    stopMobileRelay: async () => DEFAULT_MOBILE_RELAY_STATE,
    getMobileRelayState: async () => DEFAULT_MOBILE_RELAY_STATE,
    refreshMobileRelayTrustedPhones: async () => DEFAULT_MOBILE_RELAY_STATE,
    rotateMobileRelaySession: async () => DEFAULT_MOBILE_RELAY_STATE,
    forgetMobileRelayTrustedPhone: async () => DEFAULT_MOBILE_RELAY_STATE,
    updateMobileRelayTrustedPhonePermissions: async () => DEFAULT_MOBILE_RELAY_STATE,
    onSystemAppearanceChanged: () => () => {},
    onUpdateStateChanged: () => () => {},
    onWorkspaceServerStartupProgress: () => () => {},
    onWorkspaceServerExited: () => () => {},
    onWindowCloseRequested: () => () => {},
    onMenuCommand: () => () => {},
    onMobileRelayStateChanged: () => () => {},
    ...overrides,
  };
}

export function createDesktopApiMock(overrides: Partial<DesktopCommandsModule> = {}): DesktopApi {
  const commands = createDesktopCommandsMock(overrides);
  return {
    ...commands,
    features: commands.getDesktopFeatureFlags(),
    isPackaged: commands.isPackagedDesktopApp(),
    demoMode: commands.isDesktopDemoMode(),
    resolveDesktopFeatureFlags: commands.getDesktopFeatureFlags,
    readFile: async (opts) => ({ content: await commands.readFile(opts) }),
    showContextMenu: async ({ items }) => await commands.showContextMenu(items),
  } as DesktopApi;
}

export function createDesktopCommandsBridgeMock(): DesktopCommandsModule {
  const fallback = createDesktopCommandsMock();
  const getActiveDesktopApi = (): DesktopApi | undefined =>
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] as DesktopApi | undefined;

  return createDesktopCommandsMock({
    createOneOffChatWorkspace: async (options) =>
      await (getActiveDesktopApi()?.createOneOffChatWorkspace(options) ??
        fallback.createOneOffChatWorkspace(options)),
    startWorkspaceServer: async (options) =>
      await (getActiveDesktopApi()?.startWorkspaceServer(options) ??
        fallback.startWorkspaceServer(options)),
    getWorkspaceServerStatus: async (options) =>
      await (getActiveDesktopApi()?.getWorkspaceServerStatus(options) ??
        fallback.getWorkspaceServerStatus(options)),
    stopWorkspaceServer: async (options) =>
      await (getActiveDesktopApi()?.stopWorkspaceServer(options) ??
        fallback.stopWorkspaceServer(options)),
    loadState: async () => await (getActiveDesktopApi()?.loadState() ?? fallback.loadState()),
    saveState: async (state) =>
      await (getActiveDesktopApi()?.saveState(state) ?? fallback.saveState(state)),
    deleteTranscript: async (options) =>
      await (getActiveDesktopApi()?.deleteTranscript(options) ??
        fallback.deleteTranscript(options)),
    getUpdateState: async () =>
      await (getActiveDesktopApi()?.getUpdateState() ?? fallback.getUpdateState()),
    onWorkspaceServerExited: (listener) =>
      getActiveDesktopApi()?.onWorkspaceServerExited(listener) ??
      fallback.onWorkspaceServerExited(listener),
  });
}
