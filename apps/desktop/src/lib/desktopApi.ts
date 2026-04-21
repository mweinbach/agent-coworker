import desktopPackage from "../../package.json";

import type { HydratedTranscriptSnapshot, PersistedState, TranscriptEvent } from "../app/types";
import type { DesktopFeatureFlagOverrides, DesktopFeatureFlags } from "../../../../src/shared/featureFlags";

export type StartWorkspaceServerInput = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
};

export type StopWorkspaceServerInput = {
  workspaceId: string;
};

export type MobileRelayStartInput = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
};

export type MobileRelayBridgeState = {
  status: "idle" | "starting" | "pairing" | "connected" | "reconnecting" | "error";
  workspaceId: string | null;
  workspacePath: string | null;
  relaySource: "remodex" | "managed" | "override" | "unavailable";
  relaySourceMessage: string | null;
  relayServiceStatus: "unknown" | "running" | "not-running" | "disconnected" | "unavailable";
  relayServiceMessage: string | null;
  relayServiceUpdatedAt: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  pairingPayload: {
    v: number;
    relay: string;
    sessionId: string;
    macDeviceId: string;
    macIdentityPublicKey: string;
    pairingSecret: string;
    expiresAt: number;
  } | null;
  trustedPhoneDeviceId: string | null;
  trustedPhoneFingerprint: string | null;
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

export type ListDirectoryInput = {
  path: string;
  includeHidden?: boolean;
};

export type OpenPathInput = {
  path: string;
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

export type ReadFileOutput = {
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
  | "openSkills"
  | "openUpdates";

export type ThemeSource = "system" | "light" | "dark";

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

export type UpdaterPhase =
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

export function createDefaultUpdaterState(currentVersion = desktopAppVersion, packaged = false): UpdaterState {
  return {
    phase: packaged ? "idle" : "disabled",
    packaged,
    currentVersion,
    lastCheckStartedAt: null,
    lastCheckedAt: null,
    downloadedAt: null,
    message: packaged ? "Updates are ready to check." : "Updates are only available in packaged builds.",
    error: null,
    progress: null,
    release: null,
  };
}

export type SetWindowAppearanceInput = {
  themeSource?: ThemeSource;
  backgroundMaterial?: WindowsBackgroundMaterial;
};

export interface DesktopApi {
  readonly features: DesktopFeatureFlags;
  resolveDesktopFeatureFlags(overrides?: DesktopFeatureFlagOverrides): DesktopFeatureFlags;
  startWorkspaceServer(opts: StartWorkspaceServerInput): Promise<{ url: string }>;
  stopWorkspaceServer(opts: StopWorkspaceServerInput): Promise<void>;
  startMobileRelay(opts: MobileRelayStartInput): Promise<MobileRelayBridgeState>;
  stopMobileRelay(): Promise<MobileRelayBridgeState>;
  getMobileRelayState(): Promise<MobileRelayBridgeState>;
  rotateMobileRelaySession(): Promise<MobileRelayBridgeState>;
  forgetMobileRelayTrustedPhone(): Promise<MobileRelayBridgeState>;
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  readTranscript(opts: ReadTranscriptInput): Promise<TranscriptEvent[]>;
  hydrateTranscript(opts: ReadTranscriptInput): Promise<HydratedTranscriptSnapshot>;
  appendTranscriptEvent(opts: TranscriptBatchInput): Promise<void>;
  appendTranscriptBatch(events: TranscriptBatchInput[]): Promise<void>;
  deleteTranscript(opts: DeleteTranscriptInput): Promise<void>;
  pickWorkspaceDirectory(): Promise<string | null>;
  showContextMenu(opts: ShowContextMenuInput): Promise<string | null>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  windowDragStart(opts: WindowDragPointInput): Promise<void>;
  windowDragMove(opts: WindowDragPointInput): Promise<void>;
  windowDragEnd(): Promise<void>;
  getPlatform(): Promise<string>;
  listDirectory(opts: ListDirectoryInput): Promise<ExplorerEntry[]>;
  readFile(opts: ReadFileInput): Promise<ReadFileOutput>;
  readFileForPreview(opts: ReadFileForPreviewInput): Promise<ReadFileForPreviewOutput>;
  getPreferredFileApp(opts: PreferredFileAppInput): Promise<string | null>;
  previewOSFile(opts: PreviewOSFileInput): Promise<void>;
  openPath(opts: OpenPathInput): Promise<void>;
  openExternalUrl(opts: OpenExternalUrlInput): Promise<void>;
  revealPath(opts: RevealPathInput): Promise<void>;
  copyPath(opts: CopyPathInput): Promise<void>;
  createDirectory(opts: CreateDirectoryInput): Promise<void>;
  renamePath(opts: RenamePathInput): Promise<void>;
  trashPath(opts: TrashPathInput): Promise<void>;
  confirmAction(opts: ConfirmActionInput): Promise<boolean>;
  showNotification(opts: DesktopNotificationInput): Promise<boolean>;
  getUpdateState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<void>;
  quitAndInstallUpdate(): Promise<void>;
  getSystemAppearance(): Promise<SystemAppearance>;
  setWindowAppearance(opts: SetWindowAppearanceInput): Promise<SystemAppearance>;
  onUpdateStateChanged(listener: (state: UpdaterState) => void): () => void;
  onSystemAppearanceChanged(listener: (appearance: SystemAppearance) => void): () => void;
  onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void;
  onMobileRelayStateChanged(listener: (state: MobileRelayBridgeState) => void): () => void;
}

export const DESKTOP_IPC_CHANNELS = {
  startWorkspaceServer: "desktop:startWorkspaceServer",
  stopWorkspaceServer: "desktop:stopWorkspaceServer",
  mobileRelayStart: "desktop:mobileRelayStart",
  mobileRelayStop: "desktop:mobileRelayStop",
  mobileRelayGetState: "desktop:mobileRelayGetState",
  mobileRelayRotateSession: "desktop:mobileRelayRotateSession",
  mobileRelayForgetTrustedPhone: "desktop:mobileRelayForgetTrustedPhone",
  loadState: "desktop:loadState",
  saveState: "desktop:saveState",
  readTranscript: "desktop:readTranscript",
  hydrateTranscript: "desktop:hydrateTranscript",
  appendTranscriptEvent: "desktop:appendTranscriptEvent",
  appendTranscriptBatch: "desktop:appendTranscriptBatch",
  deleteTranscript: "desktop:deleteTranscript",
  pickWorkspaceDirectory: "desktop:pickWorkspaceDirectory",
  showContextMenu: "desktop:showContextMenu",
  windowMinimize: "desktop:windowMinimize",
  windowMaximize: "desktop:windowMaximize",
  windowClose: "desktop:windowClose",
  windowDragStart: "desktop:windowDragStart",
  windowDragMove: "desktop:windowDragMove",
  windowDragEnd: "desktop:windowDragEnd",
  getPlatform: "desktop:getPlatform",
  listDirectory: "desktop:listDirectory",
  readFile: "desktop:readFile",
  readFileForPreview: "desktop:readFileForPreview",
  getPreferredFileApp: "desktop:getPreferredFileApp",
  previewOSFile: "desktop:previewOSFile",
  openPath: "desktop:openPath",
  openExternalUrl: "desktop:openExternalUrl",
  revealPath: "desktop:revealPath",
  copyPath: "desktop:copyPath",
  createDirectory: "desktop:createDirectory",
  renamePath: "desktop:renamePath",
  trashPath: "desktop:trashPath",
  confirmAction: "desktop:confirmAction",
  showNotification: "desktop:showNotification",
  getUpdateState: "desktop:getUpdateState",
  checkForUpdates: "desktop:checkForUpdates",
  quitAndInstallUpdate: "desktop:quitAndInstallUpdate",
  getSystemAppearance: "desktop:getSystemAppearance",
  setWindowAppearance: "desktop:setWindowAppearance",
} as const;

export const DESKTOP_EVENT_CHANNELS = {
  menuCommand: "desktop:event:menuCommand",
  updateStateChanged: "desktop:event:updateState",
  systemAppearanceChanged: "desktop:event:systemAppearanceChanged",
  mobileRelayStateChanged: "desktop:event:mobileRelayStateChanged",
} as const;
