import type {
  DesktopFeatureFlagId,
  DesktopFeatureFlagOverrides,
  DesktopFeatureFlags,
} from "../../../../src/shared/featureFlags";
import { resolveFeatureFlags } from "../../../../src/shared/featureFlags";
import type {
  HydratedTranscriptSnapshot,
  PersistedPrivacyTelemetrySettings,
  PersistedState,
  TranscriptEvent,
} from "../app/types";
import type {
  CaptureProductEventInput,
  ConfirmActionInput,
  CreateDiagnosticsBundleOutput,
  CreateOneOffChatWorkspaceInput,
  CreateOneOffChatWorkspaceOutput,
  DesktopApi,
  DesktopMenuCommand,
  DesktopNotificationInput,
  ExplorerEntry,
  PlatformChromeInfo,
  ReadFileForPreviewOutput,
  SetWindowAppearanceInput,
  ShowQuickChatWindowInput,
  SystemAppearance,
  TelemetryStatusInput,
  TelemetryStatusSnapshot,
  UpdaterState,
  UploadDiagnosticsBundleOutput,
  WorkspaceServerExitedEvent,
  WorkspaceServerStartupProgress,
  WorkspaceServerStatus,
} from "./desktopApi";
import { DESKTOP_API_OVERRIDE_KEY } from "./desktopApiOverride";

function getDesktopApi(): DesktopApi | undefined {
  const override = (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
  if (override) return override as DesktopApi;
  return typeof window === "undefined" ? undefined : window.cowork;
}

function requireDesktopApi(): DesktopApi {
  const api = getDesktopApi();
  if (!api) {
    throw new Error("Desktop bridge unavailable. Start the app via Electron.");
  }
  return api;
}

function noopUnsubscribe(): void {}

function getDefaultDesktopFeatureFlags(): DesktopFeatureFlags {
  return resolveFeatureFlags({ isPackaged: false });
}

export function getDesktopFeatureFlags(
  overrides?: DesktopFeatureFlagOverrides,
): DesktopFeatureFlags {
  const api = getDesktopApi();
  if (!api) {
    return getDefaultDesktopFeatureFlags();
  }

  if (typeof api.resolveDesktopFeatureFlags === "function") {
    return api.resolveDesktopFeatureFlags(overrides);
  }

  const base = api.features ?? getDefaultDesktopFeatureFlags();
  if (!overrides) {
    return base;
  }

  const next: DesktopFeatureFlags = { ...base };
  for (const key of Object.keys(overrides) as DesktopFeatureFlagId[]) {
    if (typeof overrides[key] === "boolean") {
      next[key] = overrides[key];
    }
  }
  return next;
}

export function isPackagedDesktopApp(): boolean {
  const api = getDesktopApi();
  return api?.isPackaged === true;
}

export function isDesktopDemoMode(): boolean {
  const api = getDesktopApi();
  return api?.demoMode === true;
}

export async function startWorkspaceServer(opts: {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  forceRestart?: boolean;
  preserveMobileRelay?: boolean;
  featureFlags?: DesktopFeatureFlagOverrides;
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings;
}): Promise<{ url: string }> {
  return await requireDesktopApi().startWorkspaceServer(opts);
}

export async function stopWorkspaceServer(opts: { workspaceId: string }): Promise<void> {
  await requireDesktopApi().stopWorkspaceServer(opts);
}

export async function getWorkspaceServerStatus(opts: {
  workspaceId: string;
}): Promise<WorkspaceServerStatus> {
  const api = getDesktopApi();
  if (!api) {
    return {
      workspaceId: opts.workspaceId,
      running: true,
      url: null,
      reason: "running",
    };
  }
  return await api.getWorkspaceServerStatus(opts);
}

export async function createOneOffChatWorkspace(
  opts?: CreateOneOffChatWorkspaceInput,
): Promise<CreateOneOffChatWorkspaceOutput> {
  return await requireDesktopApi().createOneOffChatWorkspace(opts);
}

export async function loadState(): Promise<PersistedState> {
  return await requireDesktopApi().loadState();
}

export async function saveState(state: PersistedState): Promise<void> {
  await requireDesktopApi().saveState(state);
}

export async function captureProductEvent(input: CaptureProductEventInput): Promise<void> {
  await requireDesktopApi().captureProductEvent(input);
}

export async function readTranscript(opts: { threadId: string }): Promise<TranscriptEvent[]> {
  return await requireDesktopApi().readTranscript(opts);
}

export async function hydrateTranscript(opts: {
  threadId: string;
}): Promise<HydratedTranscriptSnapshot> {
  return await requireDesktopApi().hydrateTranscript(opts);
}

export async function appendTranscriptBatch(
  events: {
    ts: string;
    threadId: string;
    direction: "server" | "client";
    payload: unknown;
  }[],
): Promise<void> {
  await requireDesktopApi().appendTranscriptBatch(events);
}

export async function deleteTranscript(opts: { threadId: string }): Promise<void> {
  await requireDesktopApi().deleteTranscript(opts);
}

export async function pickWorkspaceDirectory(): Promise<string | null> {
  return await requireDesktopApi().pickWorkspaceDirectory();
}

export async function pickDirectory(opts?: { title?: string }): Promise<string | null> {
  return await requireDesktopApi().pickDirectory(opts);
}

export async function showContextMenu(
  items: { id: string; label: string; enabled?: boolean }[],
): Promise<string | null> {
  return await requireDesktopApi().showContextMenu({ items });
}

export async function windowClose(): Promise<void> {
  await requireDesktopApi().windowClose();
}

export async function showMainWindow(): Promise<void> {
  await requireDesktopApi().showMainWindow();
}

export async function showCanvasWindow(opts: { path: string }): Promise<void> {
  await requireDesktopApi().showCanvasWindow(opts);
}

export async function showQuickChatWindow(opts?: ShowQuickChatWindowInput): Promise<void> {
  await requireDesktopApi().showQuickChatWindow(opts);
}

export async function listDirectory(opts: {
  path: string;
  includeHidden?: boolean;
}): Promise<ExplorerEntry[]> {
  if (typeof window === "undefined") {
    return [];
  }
  const api = window.cowork;
  if (!api || typeof api.listDirectory !== "function") {
    console.warn("listDirectory not implemented in desktop bridge");
    return [];
  }
  return await api.listDirectory(opts);
}

export async function readFile(opts: { path: string }): Promise<string> {
  const result = await requireDesktopApi().readFile(opts);
  return result.content;
}

export async function writeFile(opts: { path: string; content: string }): Promise<void> {
  await requireDesktopApi().writeFile(opts);
}

export async function readFileForPreview(opts: {
  path: string;
  maxBytes?: number;
}): Promise<ReadFileForPreviewOutput> {
  return await requireDesktopApi().readFileForPreview(opts);
}

export async function getPreferredFileApp(opts: { path: string }): Promise<string | null> {
  return await requireDesktopApi().getPreferredFileApp(opts);
}

export async function openPath(opts: { path: string }): Promise<void> {
  await requireDesktopApi().openPath(opts);
}

export async function saveExportedFile(opts: {
  sourcePath: string;
  defaultFileName: string;
}): Promise<string | null> {
  return await requireDesktopApi().saveExportedFile(opts);
}

export async function openExternalUrl(opts: { url: string }): Promise<void> {
  await requireDesktopApi().openExternalUrl(opts);
}

export async function revealPath(opts: { path: string }): Promise<void> {
  await requireDesktopApi().revealPath(opts);
}

export async function copyPath(opts: { path: string }): Promise<void> {
  await requireDesktopApi().copyPath(opts);
}

export async function copyText(text: string): Promise<void> {
  await requireDesktopApi().copyText(text);
}

export async function createDirectory(opts: { parentPath: string; name: string }): Promise<void> {
  await requireDesktopApi().createDirectory(opts);
}

export async function renamePath(opts: { path: string; newName: string }): Promise<void> {
  await requireDesktopApi().renamePath(opts);
}

export async function trashPath(opts: { path: string }): Promise<void> {
  await requireDesktopApi().trashPath(opts);
}

export async function confirmAction(opts: ConfirmActionInput): Promise<boolean> {
  return await requireDesktopApi().confirmAction(opts);
}

export async function showNotification(opts: DesktopNotificationInput): Promise<boolean> {
  return await requireDesktopApi().showNotification(opts);
}

export async function createDiagnosticsBundle(): Promise<CreateDiagnosticsBundleOutput> {
  return await requireDesktopApi().createDiagnosticsBundle();
}

export async function revealDiagnosticsBundle(opts: { path: string }): Promise<void> {
  await requireDesktopApi().revealDiagnosticsBundle(opts);
}

export async function openLogsFolder(): Promise<void> {
  await requireDesktopApi().openLogsFolder();
}

export async function uploadDiagnosticsBundle(opts: {
  path: string;
  confirmed: boolean;
}): Promise<UploadDiagnosticsBundleOutput> {
  return await requireDesktopApi().uploadDiagnosticsBundle(opts);
}

export async function getTelemetryStatus(
  opts?: TelemetryStatusInput,
): Promise<TelemetryStatusSnapshot> {
  return await requireDesktopApi().getTelemetryStatus(opts);
}

export async function getUpdateState(): Promise<UpdaterState> {
  return await requireDesktopApi().getUpdateState();
}

export async function checkForUpdates(): Promise<void> {
  await requireDesktopApi().checkForUpdates();
}

export async function quitAndInstallUpdate(): Promise<void> {
  await requireDesktopApi().quitAndInstallUpdate();
}

export async function getSystemAppearance(): Promise<SystemAppearance> {
  return await requireDesktopApi().getSystemAppearance();
}

export async function getPlatformChrome(): Promise<PlatformChromeInfo> {
  return await requireDesktopApi().getPlatformChrome();
}

export async function setWindowAppearance(
  opts: SetWindowAppearanceInput,
): Promise<SystemAppearance> {
  return await requireDesktopApi().setWindowAppearance(opts);
}

export async function startMobileRelay(opts: {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  featureFlags?: import("./desktopApi").MobileRelayStartInput["featureFlags"];
}): Promise<import("./desktopApi").MobileRelayBridgeState> {
  return await requireDesktopApi().startMobileRelay(opts);
}

export async function stopMobileRelay(): Promise<import("./desktopApi").MobileRelayBridgeState> {
  return await requireDesktopApi().stopMobileRelay();
}

export async function getMobileRelayState(): Promise<
  import("./desktopApi").MobileRelayBridgeState
> {
  return await requireDesktopApi().getMobileRelayState();
}

export async function refreshMobileRelayTrustedPhones(): Promise<
  import("./desktopApi").MobileRelayBridgeState
> {
  return await requireDesktopApi().refreshMobileRelayTrustedPhones();
}

export async function rotateMobileRelaySession(): Promise<
  import("./desktopApi").MobileRelayBridgeState
> {
  return await requireDesktopApi().rotateMobileRelaySession();
}

export async function forgetMobileRelayTrustedPhone(
  opts?: import("./desktopApi").MobileRelayForgetTrustedPhoneInput,
): Promise<import("./desktopApi").MobileRelayBridgeState> {
  return await requireDesktopApi().forgetMobileRelayTrustedPhone(opts);
}

export async function updateMobileRelayTrustedPhonePermissions(
  opts: import("./desktopApi").MobileRelayUpdateTrustedPhonePermissionsInput,
): Promise<import("./desktopApi").MobileRelayBridgeState> {
  return await requireDesktopApi().updateMobileRelayTrustedPhonePermissions(opts);
}

export function onSystemAppearanceChanged(
  listener: (appearance: SystemAppearance) => void,
): () => void {
  return getDesktopApi()?.onSystemAppearanceChanged(listener) ?? noopUnsubscribe;
}

export function onUpdateStateChanged(listener: (state: UpdaterState) => void): () => void {
  return getDesktopApi()?.onUpdateStateChanged(listener) ?? noopUnsubscribe;
}

export function onWorkspaceServerStartupProgress(
  listener: (event: WorkspaceServerStartupProgress) => void,
): () => void {
  return getDesktopApi()?.onWorkspaceServerStartupProgress(listener) ?? noopUnsubscribe;
}

export function onWorkspaceServerExited(
  listener: (event: WorkspaceServerExitedEvent) => void,
): () => void {
  return getDesktopApi()?.onWorkspaceServerExited(listener) ?? noopUnsubscribe;
}

export async function writeRendererLog(
  opts: import("./desktopApi").RendererLogInput,
): Promise<void> {
  await getDesktopApi()?.writeRendererLog(opts);
}

export function onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void {
  return getDesktopApi()?.onMenuCommand(listener) ?? noopUnsubscribe;
}

export function onMobileRelayStateChanged(
  listener: (state: import("./desktopApi").MobileRelayBridgeState) => void,
): () => void {
  return getDesktopApi()?.onMobileRelayStateChanged(listener) ?? noopUnsubscribe;
}
