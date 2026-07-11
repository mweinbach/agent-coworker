import type { CoworkRuntimeBootstrapProgress } from "../../../../src/coworkRuntime/types";
import type {
  DesktopFeatureFlagOverrides,
  DesktopFeatureFlags,
} from "../../../../src/shared/featureFlags";
import type {
  ProductAnalyticsEnvironment,
  ProductAnalyticsEventName,
  ProductAnalyticsProperties,
} from "../../../../src/telemetry/productAnalytics";
import desktopPackage from "../../package.json";
import type {
  HydratedTranscriptSnapshot,
  PersistedPrivacyTelemetrySettings,
  PersistedState,
  TranscriptEvent,
} from "../app/types";

export type StartWorkspaceServerInput = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  forceRestart?: boolean;
  preserveMobileRelay?: boolean;
  featureFlags?: DesktopFeatureFlagOverrides;
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings;
};

export type WorkspaceServerStartupProgress = {
  workspaceId: string;
  progress: CoworkRuntimeBootstrapProgress;
};

export type WorkspaceServerStatusReason =
  | "running"
  | "starting"
  | "not_found"
  | "exited"
  | "health_failed";

export type WorkspaceServerStatus = {
  workspaceId: string;
  running: boolean;
  url: string | null;
  reason: WorkspaceServerStatusReason;
  error?: string;
};

export type WorkspaceServerExitedEvent = {
  workspaceId: string;
  url: string | null;
  code: number | null;
  signal: string | null;
};

export type CreateOneOffChatWorkspaceInput = {
  titleHint?: string;
};

export type CreateOneOffChatWorkspaceOutput = {
  name: string;
  path: string;
};

export type StopWorkspaceServerInput = {
  workspaceId: string;
};

export type RendererLogInput = {
  level?: "info" | "warn" | "error";
  category: string;
  message: string;
  meta?: Record<string, string | number | boolean | null>;
};

export type MobileRelayStartInput = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  featureFlags?: DesktopFeatureFlagOverrides;
};

const MOBILE_RELAY_TRUSTED_DEVICE_PERMISSION_KEYS = [
  "turns",
  "serverRequests",
  "providerAuth",
  "mcpAuth",
  "workspaceSettings",
  "backups",
  "conversations",
] as const;

export type MobileRelayTrustedDevicePermissionKey =
  (typeof MOBILE_RELAY_TRUSTED_DEVICE_PERMISSION_KEYS)[number];

type MobileRelayTrustedDevicePermissions = Record<MobileRelayTrustedDevicePermissionKey, boolean>;

export type MobileRelayTrustedPhoneDevice = {
  deviceId: string;
  fingerprint: string;
  displayName: string | null;
  lastPairedAt: string | null;
  lastConnectedAt: string | null;
  permissions: MobileRelayTrustedDevicePermissions;
};

export type MobileRelayForgetTrustedPhoneInput = {
  deviceId?: string;
};

export type MobileRelayUpdateTrustedPhonePermissionsInput = {
  deviceId: string;
  permissions: Partial<Record<MobileRelayTrustedDevicePermissionKey, boolean>>;
};

export type MobileRelayBridgeState = {
  status: "idle" | "starting" | "pairing" | "connected" | "reconnecting" | "error";
  workspaceId: string | null;
  workspacePath: string | null;
  relaySource: "direct" | "managed" | "remodex" | "override" | "unavailable";
  relaySourceMessage: string | null;
  relayServiceStatus: "unknown" | "running" | "not-running" | "unavailable";
  relayServiceMessage: string | null;
  relayServiceUpdatedAt: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  pairingPayload: {
    v: 1;
    scheme: "h3";
    hosts: string[];
    port: number;
    certSha256: string;
    spkiSha256: string;
    identityPub: string;
    nonce: string;
    expiresAt: number;
  } | null;
  trustedPhoneDeviceId: string | null;
  trustedPhoneFingerprint: string | null;
  trustedPhoneDevices: MobileRelayTrustedPhoneDevice[];
  directUrl: string | null;
  ticketUrl: string | null;
  certSha256: string | null;
  spkiSha256: string | null;
  hostHints: string[];
  lastError: string | null;
};

export type ReadTranscriptInput = {
  threadId: string;
};

export type DeleteTranscriptInput = {
  threadId: string;
};

export type TranscriptBatchInput = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
};

export type TranscriptCaptureResult =
  | {
      accepted: true;
      batchId: string;
      pendingEvents: number;
      pendingBytes: number;
    }
  | {
      accepted: false;
      recoveryId: string;
      reason: "overflow" | "batch_too_large" | "capability_absent" | "persistence" | "closed";
      pendingEvents: number;
      pendingBytes: number;
    };

export type TranscriptDeliveryFailure = {
  batchId: string | null;
  recoveryId: string | null;
  reason:
    | "permanent"
    | "retries_exhausted"
    | "persistence"
    | "overflow"
    | "capability_absent"
    | "malformed";
  pendingEvents: number;
  pendingBytes: number;
  limits: {
    maxBatches: number;
    maxEvents: number;
    maxBytes: number;
    maxBatchEvents: number;
    maxBatchBytes: number;
  };
  canRetry: boolean;
  canDiscard: boolean;
  message: string;
};

export type ContextMenuItem = {
  id: string;
  label: string;
  enabled?: boolean;
};

export type ShowContextMenuInput = {
  items: ContextMenuItem[];
};

export type WindowDragPointInput = {
  screenX: number;
  screenY: number;
};

export type WindowCloseRequest = {
  requestId: string;
};

export type WindowCloseResponseInput = WindowCloseRequest & {
  canClose: boolean;
};

export type ShowCanvasWindowInput = {
  path: string;
};

export type ShowQuickChatWindowInput = {
  threadId?: string;
  newThread?: boolean;
};

export type ListDirectoryInput = {
  path: string;
  includeHidden?: boolean;
};

export type OpenPathInput = {
  path: string;
};

export type SaveExportedFileInput = {
  sourcePath: string;
  defaultFileName: string;
};

export type PickCanvasSavePathInput = {
  sourcePath: string;
};

export type PickDirectoryInput = {
  title?: string;
};

export type PreferredFileAppInput = {
  path: string;
};

export type OpenExternalUrlInput = {
  url: string;
};

export type PreviewOSFileInput = {
  path: string;
};

export type RevealPathInput = {
  path: string;
};

export type ReadFileInput = {
  path: string;
};

type ReadFileOutput = {
  content: string;
};

export type WriteFileInput = {
  path: string;
  content: string;
};

export type ReadFileForPreviewInput = {
  path: string;
  maxBytes?: number;
};

export type ReadFileForPreviewOutput = {
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
};

export type CopyPathInput = {
  path: string;
};

export type CopyFileToWorkspaceUploadsInput = {
  workspacePath: string;
  sourcePath: string;
  filename: string;
  uploadsDirectory?: string;
};

export type CopyFileToWorkspaceUploadsOutput = {
  filename: string;
  path: string;
};

export type AuthorizeUploadSourceInput = {
  sourcePath: string;
};

export type CreateDirectoryInput = {
  parentPath: string;
  name: string;
};

export type RenamePathInput = {
  path: string;
  newName: string;
};

export type TrashPathInput = {
  path: string;
};

export type ExplorerEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
};

export type DesktopMenuCommand =
  | "newThread"
  | "toggleSidebar"
  | "openSettings"
  | "openWorkspacesSettings"
  | "openResearch"
  | "openSkills"
  | "openUpdates"
  | "openCommandPalette";

type ThemeSource = "system" | "light" | "dark";

export type WindowsBackgroundMaterial = "auto" | "none" | "mica" | "acrylic" | "tabbed";

export type SystemAppearance = {
  platform: string;
  themeSource: ThemeSource;
  shouldUseDarkColors: boolean;
  shouldUseDarkColorsForSystemIntegratedUI: boolean;
  shouldUseHighContrastColors: boolean;
  shouldUseInvertedColorScheme: boolean;
  prefersReducedTransparency: boolean;
  inForcedColorsMode: boolean;
};

export type ConfirmActionInput = {
  title: string;
  message: string;
  detail?: string;
  kind?: "none" | "info" | "warning" | "error";
  confirmLabel?: string;
  cancelLabel?: string;
  defaultAction?: "confirm" | "cancel";
};

export type DesktopNotificationInput = {
  title: string;
  body?: string;
  silent?: boolean;
};

type UpdaterPhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error";

export type UpdaterProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdaterReleaseInfo = {
  version: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  releasePageUrl?: string;
};

export type UpdaterState = {
  phase: UpdaterPhase;
  packaged: boolean;
  currentVersion: string;
  lastCheckStartedAt: string | null;
  lastCheckedAt: string | null;
  downloadedAt: string | null;
  message: string | null;
  error: string | null;
  progress: UpdaterProgress | null;
  release: UpdaterReleaseInfo | null;
};

const desktopAppVersion = desktopPackage.version;

export type DesktopCrashReportingConfig = {
  enabled: boolean;
  dsnConfigured: boolean;
  dsn: string | null;
  release: string | null;
  environment: "development" | "packaged" | "beta" | "production";
  appVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
};

export type DesktopProductAnalyticsConfig = {
  enabled: boolean;
  keyConfigured: boolean;
  host: string;
  environment: ProductAnalyticsEnvironment;
  appVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
};

export type TelemetryStatusLabel =
  | "Disabled"
  | "Not configured"
  | "Enabled"
  | "Metadata only"
  | "Full payload"
  | "Local only"
  | "Upload configured"
  | "Connected"
  | "Error";

export type TelemetryStatusEntry = {
  label: TelemetryStatusLabel;
  status:
    | "disabled"
    | "not_configured"
    | "enabled"
    | "metadata_only"
    | "full_payload"
    | "local_only"
    | "upload_configured"
    | "connected"
    | "error";
  configured: boolean;
  enabled: boolean;
  message?: string;
};

export type TelemetryStatusSnapshot = {
  globalKillSwitchActive: boolean;
  crashReports: TelemetryStatusEntry;
  productAnalytics: TelemetryStatusEntry;
  aiTraces: TelemetryStatusEntry;
  diagnosticsUpload: TelemetryStatusEntry;
  cloudSync: TelemetryStatusEntry;
};

export type CaptureProductEventInput = {
  name: ProductAnalyticsEventName;
  properties?: ProductAnalyticsProperties;
};

export type DiagnosticsBundlePathInput = {
  path: string;
};

export type UploadDiagnosticsBundleInput = DiagnosticsBundlePathInput & {
  confirmed: boolean;
};

export type TelemetryStatusInput = {
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings;
};

export type CreateDiagnosticsBundleOutput = {
  path: string;
  createdAt: string;
  summary: string;
  uploadConfigured: boolean;
  uploadEnabled: boolean;
};

export type UploadDiagnosticsBundleOutput = {
  uploaded: boolean;
  path: string;
  diagnosticId: string | null;
  url: string | null;
  message: string;
};

export function createDefaultUpdaterState(
  currentVersion = desktopAppVersion,
  packaged = false,
): UpdaterState {
  return {
    phase: packaged ? "idle" : "disabled",
    packaged,
    currentVersion,
    lastCheckStartedAt: null,
    lastCheckedAt: null,
    downloadedAt: null,
    message: packaged
      ? "Updates are ready to check."
      : "Updates are only available in packaged builds.",
    error: null,
    progress: null,
    release: null,
  };
}

export type SetWindowAppearanceInput = {
  themeSource?: ThemeSource;
  backgroundMaterial?: WindowsBackgroundMaterial;
};

export type PlatformChromeInfo = {
  platform: string;
  titlebarHeight: number;
  dragStripHeight: number;
  leftNativeReserve: number;
  rightNativeReserve: number;
  captionButtonReserve: number;
  collapsedLeftRailWidth: number;
  topbarToolbarGap: number;
  sidebarTitlebandMode: "native" | "topbar";
  topbarControlPlacement: "left-rail" | "sidebar" | "inline";
  usesNativeGlass: boolean;
  disableCssBlur: boolean;
};

export interface DesktopApi {
  readonly features: DesktopFeatureFlags;
  readonly isPackaged?: boolean;
  readonly demoMode?: boolean;
  readonly crashReporting?: DesktopCrashReportingConfig;
  readonly productAnalytics?: DesktopProductAnalyticsConfig;
  readonly telemetryStatus?: TelemetryStatusSnapshot;
  resolveDesktopFeatureFlags(overrides?: DesktopFeatureFlagOverrides): DesktopFeatureFlags;
  createOneOffChatWorkspace(
    opts?: CreateOneOffChatWorkspaceInput,
  ): Promise<CreateOneOffChatWorkspaceOutput>;
  startWorkspaceServer(opts: StartWorkspaceServerInput): Promise<{ url: string }>;
  getWorkspaceServerStatus(opts: StopWorkspaceServerInput): Promise<WorkspaceServerStatus>;
  stopWorkspaceServer(opts: StopWorkspaceServerInput): Promise<void>;
  startMobileRelay(opts: MobileRelayStartInput): Promise<MobileRelayBridgeState>;
  stopMobileRelay(): Promise<MobileRelayBridgeState>;
  getMobileRelayState(): Promise<MobileRelayBridgeState>;
  refreshMobileRelayTrustedPhones(): Promise<MobileRelayBridgeState>;
  rotateMobileRelaySession(): Promise<MobileRelayBridgeState>;
  forgetMobileRelayTrustedPhone(
    opts?: MobileRelayForgetTrustedPhoneInput,
  ): Promise<MobileRelayBridgeState>;
  updateMobileRelayTrustedPhonePermissions(
    opts: MobileRelayUpdateTrustedPhonePermissionsInput,
  ): Promise<MobileRelayBridgeState>;
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  captureProductEvent(input: CaptureProductEventInput): Promise<void>;
  readTranscript(opts: ReadTranscriptInput): Promise<TranscriptEvent[]>;
  hydrateTranscript(opts: ReadTranscriptInput): Promise<HydratedTranscriptSnapshot>;
  appendTranscriptEvent(opts: TranscriptBatchInput): Promise<void>;
  captureTranscriptEvent?(event: TranscriptBatchInput): Promise<TranscriptCaptureResult>;
  appendTranscriptBatch(events: TranscriptBatchInput[]): Promise<void>;
  onTranscriptDeliveryFailure?(listener: (failure: TranscriptDeliveryFailure) => void): () => void;
  retryTranscriptDelivery?(batchId?: string): Promise<void>;
  discardTranscriptBatch?(batchId: string): Promise<void>;
  deleteTranscript(opts: DeleteTranscriptInput): Promise<void>;
  pickWorkspaceDirectory(): Promise<string | null>;
  pickDirectory(opts?: PickDirectoryInput): Promise<string | null>;
  showContextMenu(opts: ShowContextMenuInput): Promise<string | null>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  resolveWindowCloseRequest?(input: WindowCloseResponseInput): Promise<void>;
  windowDragStart(opts: WindowDragPointInput): Promise<void>;
  windowDragMove(opts: WindowDragPointInput): Promise<void>;
  windowDragEnd(): Promise<void>;
  getPlatform(): Promise<string>;
  showMainWindow(): Promise<void>;
  showQuickChatWindow(opts?: ShowQuickChatWindowInput): Promise<void>;
  showCanvasWindow(opts: ShowCanvasWindowInput): Promise<void>;

  listDirectory(opts: ListDirectoryInput): Promise<ExplorerEntry[]>;
  readFile(opts: ReadFileInput): Promise<ReadFileOutput>;
  writeFile(opts: WriteFileInput): Promise<void>;
  readFileForPreview(opts: ReadFileForPreviewInput): Promise<ReadFileForPreviewOutput>;
  getPreferredFileApp(opts: PreferredFileAppInput): Promise<string | null>;
  previewOSFile(opts: PreviewOSFileInput): Promise<void>;
  openPath(opts: OpenPathInput): Promise<void>;
  saveExportedFile(opts: SaveExportedFileInput): Promise<string | null>;
  pickCanvasSavePath(opts: PickCanvasSavePathInput): Promise<string | null>;
  openExternalUrl(opts: OpenExternalUrlInput): Promise<void>;
  revealPath(opts: RevealPathInput): Promise<void>;
  copyPath(opts: CopyPathInput): Promise<void>;
  copyText(text: string): Promise<void>;
  getPathForFile?(file: unknown): string | null | Promise<string | null>;
  copyFileToWorkspaceUploads?(
    opts: CopyFileToWorkspaceUploadsInput,
  ): Promise<CopyFileToWorkspaceUploadsOutput>;
  createDirectory(opts: CreateDirectoryInput): Promise<void>;
  renamePath(opts: RenamePathInput): Promise<void>;
  trashPath(opts: TrashPathInput): Promise<void>;
  confirmAction(opts: ConfirmActionInput): Promise<boolean>;
  showNotification(opts: DesktopNotificationInput): Promise<boolean>;
  writeRendererLog(opts: RendererLogInput): Promise<void>;
  createDiagnosticsBundle(): Promise<CreateDiagnosticsBundleOutput>;
  revealDiagnosticsBundle(opts: DiagnosticsBundlePathInput): Promise<void>;
  openLogsFolder(): Promise<void>;
  uploadDiagnosticsBundle(
    opts: UploadDiagnosticsBundleInput,
  ): Promise<UploadDiagnosticsBundleOutput>;
  getTelemetryStatus(opts?: TelemetryStatusInput): Promise<TelemetryStatusSnapshot>;
  getUpdateState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<void>;
  quitAndInstallUpdate(): Promise<void>;
  getSystemAppearance(): Promise<SystemAppearance>;
  getPlatformChrome(): Promise<PlatformChromeInfo>;
  setWindowAppearance(opts: SetWindowAppearanceInput): Promise<SystemAppearance>;
  onUpdateStateChanged(listener: (state: UpdaterState) => void): () => void;
  onWorkspaceServerStartupProgress(
    listener: (event: WorkspaceServerStartupProgress) => void,
  ): () => void;
  onWorkspaceServerExited(listener: (event: WorkspaceServerExitedEvent) => void): () => void;
  onWindowCloseRequested?(listener: (request: WindowCloseRequest) => void): () => void;
  onSystemAppearanceChanged(listener: (appearance: SystemAppearance) => void): () => void;
  onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void;
  onMobileRelayStateChanged(listener: (state: MobileRelayBridgeState) => void): () => void;
}

export const DESKTOP_IPC_CHANNELS = {
  createOneOffChatWorkspace: "desktop:createOneOffChatWorkspace",
  startWorkspaceServer: "desktop:startWorkspaceServer",
  getWorkspaceServerStatus: "desktop:getWorkspaceServerStatus",
  stopWorkspaceServer: "desktop:stopWorkspaceServer",
  mobileRelayStart: "desktop:mobileRelayStart",
  mobileRelayStop: "desktop:mobileRelayStop",
  mobileRelayGetState: "desktop:mobileRelayGetState",
  mobileRelayRefreshTrustedPhones: "desktop:mobileRelayRefreshTrustedPhones",
  mobileRelayRotateSession: "desktop:mobileRelayRotateSession",
  mobileRelayForgetTrustedPhone: "desktop:mobileRelayForgetTrustedPhone",
  mobileRelayUpdateTrustedPhonePermissions: "desktop:mobileRelayUpdateTrustedPhonePermissions",
  loadState: "desktop:loadState",
  saveState: "desktop:saveState",
  captureProductEvent: "desktop:captureProductEvent",
  readTranscript: "desktop:readTranscript",
  hydrateTranscript: "desktop:hydrateTranscript",
  appendTranscriptEvent: "desktop:appendTranscriptEvent",
  appendTranscriptBatch: "desktop:appendTranscriptBatch",
  deleteTranscript: "desktop:deleteTranscript",
  pickWorkspaceDirectory: "desktop:pickWorkspaceDirectory",
  pickDirectory: "desktop:pickDirectory",
  showContextMenu: "desktop:showContextMenu",
  windowMinimize: "desktop:windowMinimize",
  windowMaximize: "desktop:windowMaximize",
  windowClose: "desktop:windowClose",
  resolveWindowCloseRequest: "desktop:resolveWindowCloseRequest",
  windowDragStart: "desktop:windowDragStart",
  windowDragMove: "desktop:windowDragMove",
  windowDragEnd: "desktop:windowDragEnd",
  getPlatform: "desktop:getPlatform",
  showMainWindow: "desktop:showMainWindow",
  consumePendingMenuCommands: "desktop:consumePendingMenuCommands",
  showQuickChatWindow: "desktop:showQuickChatWindow",
  showCanvasWindow: "desktop:showCanvasWindow",

  listDirectory: "desktop:listDirectory",
  readFile: "desktop:readFile",
  writeFile: "desktop:writeFile",
  readFileForPreview: "desktop:readFileForPreview",
  getPreferredFileApp: "desktop:getPreferredFileApp",
  previewOSFile: "desktop:previewOSFile",
  openPath: "desktop:openPath",
  saveExportedFile: "desktop:saveExportedFile",
  pickCanvasSavePath: "desktop:pickCanvasSavePath",
  openExternalUrl: "desktop:openExternalUrl",
  revealPath: "desktop:revealPath",
  copyPath: "desktop:copyPath",
  copyText: "desktop:copyText",
  copyFileToWorkspaceUploads: "desktop:copyFileToWorkspaceUploads",
  authorizeUploadSource: "desktop:authorizeUploadSource",
  createDirectory: "desktop:createDirectory",
  renamePath: "desktop:renamePath",
  trashPath: "desktop:trashPath",
  confirmAction: "desktop:confirmAction",
  showNotification: "desktop:showNotification",
  writeRendererLog: "desktop:writeRendererLog",
  createDiagnosticsBundle: "desktop:createDiagnosticsBundle",
  revealDiagnosticsBundle: "desktop:revealDiagnosticsBundle",
  openLogsFolder: "desktop:openLogsFolder",
  uploadDiagnosticsBundle: "desktop:uploadDiagnosticsBundle",
  getTelemetryStatus: "desktop:getTelemetryStatus",
  getUpdateState: "desktop:getUpdateState",
  checkForUpdates: "desktop:checkForUpdates",
  quitAndInstallUpdate: "desktop:quitAndInstallUpdate",
  getSystemAppearance: "desktop:getSystemAppearance",
  getPlatformChrome: "desktop:getPlatformChrome",
  setWindowAppearance: "desktop:setWindowAppearance",
} as const;

export const DESKTOP_EVENT_CHANNELS = {
  menuCommand: "desktop:event:menuCommand",
  updateStateChanged: "desktop:event:updateState",
  workspaceServerStartupProgress: "desktop:event:workspaceServerStartupProgress",
  workspaceServerExited: "desktop:event:workspaceServerExited",
  windowCloseRequested: "desktop:event:windowCloseRequested",
  systemAppearanceChanged: "desktop:event:systemAppearanceChanged",
  mobileRelayStateChanged: "desktop:event:mobileRelayStateChanged",
} as const;
