import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { z } from "zod";
import {
  type DesktopFeatureFlagOverrides,
  normalizeDesktopFeatureFlagOverrides,
  resolveDesktopFeatureFlags,
} from "../../../src/shared/featureFlags";
import {
  type CrashReportingEnvironment,
  resolveCrashReportingConfig,
} from "../../../src/telemetry/crashReporting";
import { resolveProductAnalyticsConfig } from "../../../src/telemetry/productAnalytics";
import type { PersistedState } from "../src/app/types";
import {
  type CaptureProductEventInput,
  type ConfirmActionInput,
  type CopyFileToWorkspaceUploadsInput,
  type CopyPathInput,
  type CreateDirectoryInput,
  type CreateOneOffChatWorkspaceInput,
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type DeleteTranscriptInput,
  type DesktopApi,
  type DesktopCrashReportingConfig,
  type DesktopMenuCommand,
  type DesktopNotificationInput,
  type DesktopProductAnalyticsConfig,
  type DiagnosticsBundlePathInput,
  type ListDirectoryInput,
  type MobileRelayBridgeState,
  type MobileRelayForgetTrustedPhoneInput,
  type MobileRelayStartInput,
  type MobileRelayUpdateTrustedPhonePermissionsInput,
  type OpenExternalUrlInput,
  type OpenPathInput,
  type PickDirectoryInput,
  type PlatformChromeInfo,
  type PreferredFileAppInput,
  type PreviewOSFileInput,
  type ReadFileForPreviewInput,
  type ReadFileInput,
  type ReadTranscriptInput,
  type RenamePathInput,
  type RevealPathInput,
  type SaveExportedFileInput,
  type SetWindowAppearanceInput,
  type ShowCanvasWindowInput,
  type ShowContextMenuInput,
  type ShowQuickChatWindowInput,
  type StartWorkspaceServerInput,
  type StopWorkspaceServerInput,
  type SystemAppearance,
  type TelemetryStatusInput,
  type TelemetryStatusSnapshot,
  type TranscriptBatchInput,
  type TrashPathInput,
  type UpdaterState,
  type UploadDiagnosticsBundleInput,
  type WindowDragPointInput,
  type WriteFileInput,
} from "../src/lib/desktopApi";
import {
  captureProductEventInputSchema,
  confirmActionInputSchema,
  copyFileToWorkspaceUploadsInputSchema,
  copyPathInputSchema,
  copyTextInputSchema,
  createDirectoryInputSchema,
  createOneOffChatWorkspaceInputSchema,
  deleteTranscriptInputSchema,
  desktopMenuCommandSchema,
  desktopNotificationInputSchema,
  diagnosticsBundlePathInputSchema,
  listDirectoryInputSchema,
  mobileRelayBridgeStateSchema,
  mobileRelayForgetTrustedPhoneInputSchema,
  mobileRelayStartInputSchema,
  mobileRelayUpdateTrustedPhonePermissionsInputSchema,
  openExternalUrlInputSchema,
  openPathInputSchema,
  persistedStateInputSchema,
  pickDirectoryInputSchema,
  platformChromeInfoSchema,
  preferredFileAppInputSchema,
  previewOSFileInputSchema,
  readFileForPreviewInputSchema,
  readFileInputSchema,
  readTranscriptInputSchema,
  renamePathInputSchema,
  revealPathInputSchema,
  saveExportedFileInputSchema,
  setWindowAppearanceInputSchema,
  showCanvasWindowInputSchema,
  showContextMenuInputSchema,
  showQuickChatWindowInputSchema,
  startWorkspaceServerInputSchema,
  stopWorkspaceServerInputSchema,
  systemAppearanceSchema,
  telemetryStatusInputSchema,
  telemetryStatusSnapshotSchema,
  transcriptBatchInputSchema,
  trashPathInputSchema,
  updaterStateSchema,
  uploadDiagnosticsBundleInputSchema,
  windowDragPointInputSchema,
  writeFileInputSchema,
} from "../src/lib/desktopSchemas";
import type { PublicTelemetryEnv } from "./services/publicTelemetryEnv";
import { resolveDesktopTelemetryStatus } from "./services/telemetryStatus";

declare global {
  // Defined by electron-vite for safe public build-time telemetry values only.
  var __COWORK_PUBLIC_TELEMETRY_ENV__: PublicTelemetryEnv | undefined;
}

function getPreloadEnv(): NodeJS.ProcessEnv {
  return {
    ...(globalThis.__COWORK_PUBLIC_TELEMETRY_ENV__ ?? {}),
    ...process.env,
  };
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const detail = issue?.message ?? "is invalid";
  throw new Error(`${label} ${detail}`);
}

function assertStartWorkspaceServerInput(opts: StartWorkspaceServerInput): void {
  parseWithSchema(startWorkspaceServerInputSchema, opts, "startWorkspaceServer options");
}

function assertCreateOneOffChatWorkspaceInput(opts: CreateOneOffChatWorkspaceInput): void {
  parseWithSchema(createOneOffChatWorkspaceInputSchema, opts, "createOneOffChatWorkspace options");
}

function assertStopWorkspaceServerInput(opts: StopWorkspaceServerInput): void {
  parseWithSchema(stopWorkspaceServerInputSchema, opts, "stopWorkspaceServer options");
}

function assertReadTranscriptInput(opts: ReadTranscriptInput): void {
  parseWithSchema(readTranscriptInputSchema, opts, "readTranscript options");
}

function assertDeleteTranscriptInput(opts: DeleteTranscriptInput): void {
  parseWithSchema(deleteTranscriptInputSchema, opts, "deleteTranscript options");
}

function assertTranscriptBatchInput(opts: TranscriptBatchInput): void {
  parseWithSchema(transcriptBatchInputSchema, opts, "transcript event");
}

function assertShowContextMenuInput(opts: ShowContextMenuInput): void {
  parseWithSchema(showContextMenuInputSchema, opts, "showContextMenu options");
}

function assertWindowDragPointInput(opts: WindowDragPointInput): void {
  parseWithSchema(windowDragPointInputSchema, opts, "window drag options");
}

function assertListDirectoryInput(opts: ListDirectoryInput): void {
  parseWithSchema(listDirectoryInputSchema, opts, "listDirectory options");
}

function assertReadFileInput(opts: ReadFileInput): void {
  parseWithSchema(readFileInputSchema, opts, "readFile options");
}

function assertWriteFileInput(opts: WriteFileInput): void {
  parseWithSchema(writeFileInputSchema, opts, "writeFile options");
}

function assertReadFileForPreviewInput(opts: ReadFileForPreviewInput): void {
  parseWithSchema(readFileForPreviewInputSchema, opts, "readFileForPreview options");
}

function assertPreviewOSFileInput(opts: PreviewOSFileInput): void {
  parseWithSchema(previewOSFileInputSchema, opts, "previewOSFile options");
}

function assertOpenPathInput(opts: OpenPathInput): void {
  parseWithSchema(openPathInputSchema, opts, "openPath options");
}

function assertSaveExportedFileInput(opts: SaveExportedFileInput): void {
  parseWithSchema(saveExportedFileInputSchema, opts, "saveExportedFile options");
}

function assertPreferredFileAppInput(opts: PreferredFileAppInput): void {
  parseWithSchema(preferredFileAppInputSchema, opts, "getPreferredFileApp options");
}

function assertOpenExternalUrlInput(opts: OpenExternalUrlInput): void {
  parseWithSchema(openExternalUrlInputSchema, opts, "openExternalUrl options");
}

function assertRevealPathInput(opts: RevealPathInput): void {
  parseWithSchema(revealPathInputSchema, opts, "revealPath options");
}

function assertCopyPathInput(opts: CopyPathInput): void {
  parseWithSchema(copyPathInputSchema, opts, "copyPath options");
}

function assertCopyTextInput(text: unknown): void {
  parseWithSchema(copyTextInputSchema, text, "copyText text");
}

function assertCopyFileToWorkspaceUploadsInput(opts: CopyFileToWorkspaceUploadsInput): void {
  parseWithSchema(
    copyFileToWorkspaceUploadsInputSchema,
    opts,
    "copyFileToWorkspaceUploads options",
  );
}

function assertCreateDirectoryInput(opts: CreateDirectoryInput): void {
  parseWithSchema(createDirectoryInputSchema, opts, "createDirectory options");
}

function assertRenamePathInput(opts: RenamePathInput): void {
  parseWithSchema(renamePathInputSchema, opts, "renamePath options");
}

function assertTrashPathInput(opts: TrashPathInput): void {
  parseWithSchema(trashPathInputSchema, opts, "trashPath options");
}

function assertPersistedState(state: PersistedState): void {
  parseWithSchema(persistedStateInputSchema, state, "state");
}

function assertCaptureProductEventInput(input: CaptureProductEventInput): void {
  parseWithSchema(captureProductEventInputSchema, input, "product analytics event");
}

function assertPickDirectoryInput(opts: PickDirectoryInput): void {
  parseWithSchema(pickDirectoryInputSchema, opts, "pickDirectory options");
}

function assertConfirmActionInput(opts: ConfirmActionInput): void {
  parseWithSchema(confirmActionInputSchema, opts, "confirmAction options");
}

function assertDesktopNotificationInput(opts: DesktopNotificationInput): void {
  parseWithSchema(desktopNotificationInputSchema, opts, "showNotification options");
}

function assertDiagnosticsBundlePathInput(opts: DiagnosticsBundlePathInput): void {
  parseWithSchema(diagnosticsBundlePathInputSchema, opts, "diagnostics bundle path options");
}

function assertUploadDiagnosticsBundleInput(opts: UploadDiagnosticsBundleInput): void {
  parseWithSchema(uploadDiagnosticsBundleInputSchema, opts, "uploadDiagnosticsBundle options");
}

function assertSetWindowAppearanceInput(opts: SetWindowAppearanceInput): void {
  parseWithSchema(setWindowAppearanceInputSchema, opts, "setWindowAppearance options");
}

function assertUpdaterState(value: unknown): asserts value is UpdaterState {
  parseWithSchema(updaterStateSchema, value, "update state");
}

function assertDesktopMenuCommand(value: unknown): asserts value is DesktopMenuCommand {
  parseWithSchema(desktopMenuCommandSchema, value, "menu command");
}

function assertMobileRelayStartInput(opts: MobileRelayStartInput): void {
  parseWithSchema(mobileRelayStartInputSchema, opts, "mobileRelay.start options");
}

function assertMobileRelayForgetTrustedPhoneInput(opts?: MobileRelayForgetTrustedPhoneInput): void {
  parseWithSchema(
    mobileRelayForgetTrustedPhoneInputSchema,
    opts,
    "mobileRelay.forgetTrustedPhone options",
  );
}

function assertMobileRelayUpdateTrustedPhonePermissionsInput(
  opts: MobileRelayUpdateTrustedPhonePermissionsInput,
): void {
  parseWithSchema(
    mobileRelayUpdateTrustedPhonePermissionsInputSchema,
    opts,
    "mobileRelay.updateTrustedPhonePermissions options",
  );
}

function assertMobileRelayBridgeState(value: unknown): asserts value is MobileRelayBridgeState {
  parseWithSchema(mobileRelayBridgeStateSchema, value, "mobile relay state");
}

function assertSystemAppearance(value: unknown): asserts value is SystemAppearance {
  parseWithSchema(systemAppearanceSchema, value, "system appearance");
}

function assertPlatformChromeInfo(value: unknown): asserts value is PlatformChromeInfo {
  parseWithSchema(platformChromeInfoSchema, value, "platform chrome");
}

function assertTelemetryStatusSnapshot(value: unknown): asserts value is TelemetryStatusSnapshot {
  parseWithSchema(telemetryStatusSnapshotSchema, value, "telemetry status");
}

function assertTelemetryStatusInput(opts: TelemetryStatusInput): void {
  parseWithSchema(telemetryStatusInputSchema, opts, "telemetry status options");
}

function resolvePreloadDesktopFeatureFlags(overrides?: DesktopFeatureFlagOverrides) {
  return resolveDesktopFeatureFlags({
    isPackaged: process.env.COWORK_IS_PACKAGED === "true",
    env: getPreloadEnv(),
    ...(overrides ? { overrides } : {}),
  });
}

function resolvePreloadCrashReportingConfig(): DesktopCrashReportingConfig {
  const env = getPreloadEnv();
  const appVersion = env.COWORK_RELEASE?.trim() || "unknown";
  const config = resolveCrashReportingConfig({
    component: "electron-renderer",
    enabled: env.COWORK_CRASH_REPORTS_ENABLED === "true",
    env,
    fallbackRelease: appVersion,
    appVersion,
    environment: env.COWORK_SENTRY_ENVIRONMENT as CrashReportingEnvironment | undefined,
    isPackaged: env.COWORK_IS_PACKAGED === "true",
    platform: process.platform,
    arch: process.arch,
  });

  return {
    enabled: config.enabled,
    dsnConfigured: config.dsnConfigured,
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    appVersion,
    platform: process.platform,
    arch: process.arch,
    packaged: env.COWORK_IS_PACKAGED === "true",
  };
}

function resolvePreloadProductAnalyticsConfig(): DesktopProductAnalyticsConfig {
  const env = getPreloadEnv();
  const appVersion = env.COWORK_RELEASE?.trim() || "unknown";
  const config = resolveProductAnalyticsConfig({
    enabled: env.COWORK_PRODUCT_ANALYTICS_ENABLED === "true",
    env,
    anonymousId: env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID,
    release: appVersion,
    appVersion,
    environment: env.COWORK_POSTHOG_ENVIRONMENT,
    eventSource: "renderer",
    packaged: env.COWORK_IS_PACKAGED === "true",
    platform: process.platform,
    arch: process.arch,
  });

  return {
    enabled: config.enabled,
    keyConfigured: config.keyConfigured,
    host: config.host,
    environment: config.environment,
    appVersion,
    platform: process.platform,
    arch: process.arch,
    packaged: env.COWORK_IS_PACKAGED === "true",
  };
}

function resolvePreloadTelemetryStatus(): TelemetryStatusSnapshot {
  const env = getPreloadEnv();
  const appVersion = env.COWORK_RELEASE?.trim() || "unknown";
  return resolveDesktopTelemetryStatus({
    env,
    isPackaged: env.COWORK_IS_PACKAGED === "true",
    appVersion,
  });
}

const desktopFeatures = Object.freeze(resolvePreloadDesktopFeatureFlags());
const crashReporting = Object.freeze(resolvePreloadCrashReportingConfig());
const productAnalytics = Object.freeze(resolvePreloadProductAnalyticsConfig());
const telemetryStatus = Object.freeze(resolvePreloadTelemetryStatus());

const desktopApi = Object.freeze<DesktopApi>({
  features: desktopFeatures,
  isPackaged: getPreloadEnv().COWORK_IS_PACKAGED === "true",
  demoMode: getPreloadEnv().COWORK_DEMO_MODE === "1",
  crashReporting,
  productAnalytics,
  telemetryStatus,
  resolveDesktopFeatureFlags: (overrides) =>
    resolvePreloadDesktopFeatureFlags(normalizeDesktopFeatureFlagOverrides(overrides)),
  createOneOffChatWorkspace: (opts: CreateOneOffChatWorkspaceInput = {}) => {
    assertCreateOneOffChatWorkspaceInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createOneOffChatWorkspace, opts);
  },

  startWorkspaceServer: (opts: StartWorkspaceServerInput) => {
    assertStartWorkspaceServerInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.startWorkspaceServer, opts);
  },

  stopWorkspaceServer: (opts: StopWorkspaceServerInput) => {
    assertStopWorkspaceServerInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, opts);
  },

  startMobileRelay: async (opts: MobileRelayStartInput) => {
    assertMobileRelayStartInput(opts);
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayStart, opts);
    assertMobileRelayBridgeState(state);
    return state;
  },

  stopMobileRelay: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayStop);
    assertMobileRelayBridgeState(state);
    return state;
  },

  getMobileRelayState: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayGetState);
    assertMobileRelayBridgeState(state);
    return state;
  },

  refreshMobileRelayTrustedPhones: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayRefreshTrustedPhones);
    assertMobileRelayBridgeState(state);
    return state;
  },

  rotateMobileRelaySession: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mobileRelayRotateSession);
    assertMobileRelayBridgeState(state);
    return state;
  },

  forgetMobileRelayTrustedPhone: async (opts?: MobileRelayForgetTrustedPhoneInput) => {
    assertMobileRelayForgetTrustedPhoneInput(opts);
    const state = await ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone,
      opts,
    );
    assertMobileRelayBridgeState(state);
    return state;
  },

  updateMobileRelayTrustedPhonePermissions: async (
    opts: MobileRelayUpdateTrustedPhonePermissionsInput,
  ) => {
    assertMobileRelayUpdateTrustedPhonePermissionsInput(opts);
    const state = await ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.mobileRelayUpdateTrustedPhonePermissions,
      opts,
    );
    assertMobileRelayBridgeState(state);
    return state;
  },

  loadState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.loadState),

  saveState: (state: PersistedState) => {
    assertPersistedState(state);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.saveState, state);
  },

  captureProductEvent: (input: CaptureProductEventInput) => {
    assertCaptureProductEventInput(input);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.captureProductEvent, input);
  },

  readTranscript: (opts: ReadTranscriptInput) => {
    assertReadTranscriptInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readTranscript, opts);
  },

  hydrateTranscript: (opts: ReadTranscriptInput) => {
    assertReadTranscriptInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hydrateTranscript, opts);
  },

  appendTranscriptEvent: (opts: TranscriptBatchInput) => {
    assertTranscriptBatchInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, opts);
  },

  appendTranscriptBatch: (events: TranscriptBatchInput[]) => {
    events.forEach(assertTranscriptBatchInput);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, events);
  },

  deleteTranscript: (opts: DeleteTranscriptInput) => {
    assertDeleteTranscriptInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.deleteTranscript, opts);
  },

  pickWorkspaceDirectory: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory),

  pickDirectory: (opts?: PickDirectoryInput) => {
    if (opts !== undefined) {
      assertPickDirectoryInput(opts);
    }
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pickDirectory, opts);
  },

  showContextMenu: (opts: ShowContextMenuInput) => {
    assertShowContextMenuInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showContextMenu, opts);
  },

  windowMinimize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowMinimize),

  windowMaximize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowMaximize),

  windowClose: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowClose),

  windowDragStart: (opts: WindowDragPointInput) => {
    assertWindowDragPointInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowDragStart, opts);
  },

  windowDragMove: (opts: WindowDragPointInput) => {
    assertWindowDragPointInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowDragMove, opts);
  },

  windowDragEnd: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowDragEnd),

  getPlatform: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getPlatform),

  showMainWindow: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showMainWindow),

  showCanvasWindow: (opts: ShowCanvasWindowInput) => {
    parseWithSchema(showCanvasWindowInputSchema, opts, "showCanvasWindow options");
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showCanvasWindow, opts);
  },

  showQuickChatWindow: (opts?: ShowQuickChatWindowInput) => {
    if (opts !== undefined) {
      parseWithSchema(showQuickChatWindowInputSchema, opts, "showQuickChatWindow options");
    }
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showQuickChatWindow, opts);
  },

  listDirectory: (opts: ListDirectoryInput) => {
    assertListDirectoryInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listDirectory, opts);
  },

  readFile: (opts: ReadFileInput) => {
    assertReadFileInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readFile, opts);
  },

  writeFile: (opts: WriteFileInput) => {
    assertWriteFileInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.writeFile, opts);
  },

  readFileForPreview: (opts: ReadFileForPreviewInput) => {
    assertReadFileForPreviewInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readFileForPreview, opts);
  },

  getPreferredFileApp: (opts: PreferredFileAppInput) => {
    assertPreferredFileAppInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getPreferredFileApp, opts);
  },

  previewOSFile: (opts: PreviewOSFileInput) => {
    assertPreviewOSFileInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.previewOSFile, opts);
  },

  openPath: (opts: OpenPathInput) => {
    assertOpenPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openPath, opts);
  },

  saveExportedFile: (opts: SaveExportedFileInput) => {
    assertSaveExportedFileInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.saveExportedFile, opts);
  },

  openExternalUrl: (opts: OpenExternalUrlInput) => {
    assertOpenExternalUrlInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openExternalUrl, opts);
  },

  revealPath: (opts: RevealPathInput) => {
    assertRevealPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.revealPath, opts);
  },

  copyPath: (opts: CopyPathInput) => {
    assertCopyPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.copyPath, opts);
  },
  copyText: (text: string) => {
    assertCopyTextInput(text);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.copyText, text);
  },

  getPathForFile: async (file: unknown) => {
    // `webUtils.getPathForFile` only returns a real path for genuine OS-backed
    // File objects (drag-drop / file input); synthetic files yield "". That is
    // the capability that authorizes an upload source. We register the resolved
    // path with the main process so copyFileToWorkspaceUploads can refuse any
    // renderer-supplied path that was not selected through this picker flow.
    let sourcePath: string | null;
    try {
      sourcePath = webUtils.getPathForFile(file as File) || null;
    } catch {
      return null;
    }
    if (!sourcePath) {
      return null;
    }
    try {
      await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.authorizeUploadSource, { sourcePath });
    } catch {
      // Best-effort: if authorization fails the copy will be rejected and the
      // caller falls back to the server-side upload path.
    }
    return sourcePath;
  },

  copyFileToWorkspaceUploads: (opts: CopyFileToWorkspaceUploadsInput) => {
    assertCopyFileToWorkspaceUploadsInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads, opts);
  },

  createDirectory: (opts: CreateDirectoryInput) => {
    assertCreateDirectoryInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createDirectory, opts);
  },

  renamePath: (opts: RenamePathInput) => {
    assertRenamePathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.renamePath, opts);
  },

  trashPath: (opts: TrashPathInput) => {
    assertTrashPathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.trashPath, opts);
  },

  confirmAction: (opts: ConfirmActionInput) => {
    assertConfirmActionInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.confirmAction, opts);
  },

  showNotification: (opts: DesktopNotificationInput) => {
    assertDesktopNotificationInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showNotification, opts);
  },

  createDiagnosticsBundle: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createDiagnosticsBundle),

  revealDiagnosticsBundle: (opts: DiagnosticsBundlePathInput) => {
    assertDiagnosticsBundlePathInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.revealDiagnosticsBundle, opts);
  },

  openLogsFolder: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openLogsFolder),

  uploadDiagnosticsBundle: (opts: UploadDiagnosticsBundleInput) => {
    assertUploadDiagnosticsBundleInput(opts);
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.uploadDiagnosticsBundle, opts);
  },

  getTelemetryStatus: async (opts: TelemetryStatusInput = {}) => {
    assertTelemetryStatusInput(opts);
    const status = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getTelemetryStatus, opts);
    assertTelemetryStatusSnapshot(status);
    return status;
  },

  getUpdateState: async () => {
    const state = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getUpdateState);
    assertUpdaterState(state);
    return state;
  },

  checkForUpdates: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.checkForUpdates),

  quitAndInstallUpdate: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.quitAndInstallUpdate),

  getSystemAppearance: async () => {
    const appearance = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getSystemAppearance);
    assertSystemAppearance(appearance);
    return appearance;
  },

  getPlatformChrome: async () => {
    const chrome = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getPlatformChrome);
    assertPlatformChromeInfo(chrome);
    return chrome;
  },

  setWindowAppearance: async (opts: SetWindowAppearanceInput) => {
    assertSetWindowAppearanceInput(opts);
    const appearance = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setWindowAppearance, opts);
    assertSystemAppearance(appearance);
    return appearance;
  },

  onSystemAppearanceChanged: (listener: (appearance: SystemAppearance) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onSystemAppearanceChanged listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertSystemAppearance(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, wrapped);
    };
  },

  onUpdateStateChanged: (listener: (state: UpdaterState) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onUpdateStateChanged listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertUpdaterState(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.updateStateChanged, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.updateStateChanged, wrapped);
    };
  },

  onMenuCommand: (listener: (command: DesktopMenuCommand) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onMenuCommand listener must be a function");
    }
    let active = true;
    const wrapped = (_event: unknown, payload: unknown) => {
      assertDesktopMenuCommand(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.menuCommand, wrapped);
    void ipcRenderer
      .invoke(DESKTOP_IPC_CHANNELS.consumePendingMenuCommands)
      .then((payload: unknown) => {
        if (!active || !Array.isArray(payload)) {
          return;
        }
        for (const command of payload) {
          assertDesktopMenuCommand(command);
          listener(command);
        }
      })
      .catch(() => {
        // Keep live menu-command delivery even if pending startup commands are unavailable.
      });
    return () => {
      active = false;
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.menuCommand, wrapped);
    };
  },

  onMobileRelayStateChanged: (listener: (state: MobileRelayBridgeState) => void) => {
    if (typeof listener !== "function") {
      throw new Error("onMobileRelayStateChanged listener must be a function");
    }
    const wrapped = (_event: unknown, payload: unknown) => {
      assertMobileRelayBridgeState(payload);
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, wrapped);
    return () => {
      ipcRenderer.off(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, wrapped);
    };
  },
});

contextBridge.exposeInMainWorld("cowork", desktopApi);
