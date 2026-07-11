import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type * as Electron from "electron";
import { hostPlatform } from "../../../src/platform/host";
import { CloudSyncService } from "../../../src/sync/service";
import type { PersistedState } from "../src/app/types";
import {
  getCanvasCaptionSymbolTone,
  getCanvasNativeBackgroundColor,
} from "../src/lib/canvasAppearance";
import {
  DESKTOP_EVENT_CHANNELS,
  type DesktopMenuCommand,
  type ShowCanvasWindowInput,
  type ShowQuickChatWindowInput,
  type SystemAppearance,
  type UpdaterState,
} from "../src/lib/desktopApi";
import { registerDesktopIpc } from "./ipc";
import { WorkspaceRootsController } from "./ipc/workspaceRoots";
import {
  applySystemAppearanceToWindow,
  getInitialWindowAppearanceOptions,
  getSystemAppearanceSnapshot,
  registerSystemAppearanceListener,
  registerWindowAppearanceProfile,
  syncWindowAppearance,
} from "./services/appearance";
import {
  captureCrashReportingError,
  initElectronMainCrashReporting,
} from "./services/crashReporting";
import { runDesktopSmokePromptLoadCheck } from "./services/desktopSmoke";
import { DiagnosticsService } from "./services/diagnostics";
import { logError, logInfo, logWarn } from "./services/localLogs";
import {
  registerDesktopMediaProtocolHandler,
  registerDesktopMediaSchemePrivileges,
} from "./services/mediaProtocol";
import { installDesktopApplicationMenu } from "./services/menu";
import { createMenuCommandDispatcher } from "./services/menuCommandDispatcher";
import { MobileRelayBridge } from "./services/mobileRelayBridge";
import { isPathEqualOrInside } from "./services/pathBoundary";
import { PersistenceService } from "./services/persistence";
import { DesktopProductAnalyticsService } from "./services/productAnalytics";
import { applyPublicTelemetryEnv } from "./services/publicTelemetryEnv";
import { QuickChatController } from "./services/quickChatController";
import { resolveElectronRemoteDebugConfig } from "./services/remoteDebug";
import { resolveDesktopRendererUrl } from "./services/rendererUrl";
import { ServerManager } from "./services/serverManager";
import { createBeforeQuitHandler } from "./services/shutdown";
import { resolveTrayIconPath } from "./services/trayIcon";
import { DesktopUpdaterService } from "./services/updater";
import { applyElectronUserDataDirOverride } from "./services/userDataOverride";
import { revealAndActivateWindow } from "./services/windowActivation";
import {
  type NativeCloseWindow,
  NativeWindowCloseCoordinator,
} from "./services/windowCloseCoordinator";
import {
  applyPlatformWindowCreated,
  getPlatformBrowserWindowOptions,
  shouldUseMacosNativeGlass,
} from "./services/windowEnhancements";
import { loadMainWindowBounds, trackMainWindowBounds } from "./services/windowState";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, Notification, net, protocol, screen, shell } =
  require("electron") as typeof Electron;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGED_RENDERER_DIR = path.resolve(path.join(__dirname, "../renderer"));
const DESKTOP_SMOKE_WORKSPACE_ENV = "COWORK_DESKTOP_SMOKE_WORKSPACE";
const DESKTOP_SMOKE_OUTPUT_ENV = "COWORK_DESKTOP_SMOKE_OUTPUT";
const DESKTOP_APP_NAME = "Cowork";
const WINDOWS_APP_USER_MODEL_ID = "com.cowork.desktop";

// App identity must be established before any service resolves `userData`.
app.setName(DESKTOP_APP_NAME);
const electronUserDataDirOverride = applyElectronUserDataDirOverride(app, process.env);

if (process.platform === "win32") {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

// Keep packaged-mode feature resolution consistent across main and preload.
process.env.COWORK_IS_PACKAGED = String(app.isPackaged);
applyPublicTelemetryEnv(process.env);

// Must run before app ready so cowork-media images load in renderer <img> tags.
registerDesktopMediaSchemePrivileges(protocol);

const productAnalytics = new DesktopProductAnalyticsService();
const cloudSync = new CloudSyncService({
  env: process.env,
  log: (level, message, meta) => {
    if (level === "error") {
      logError("cloud-sync", message, meta);
      return;
    }
    if (level === "warn") {
      logWarn("cloud-sync", message, meta);
      return;
    }
    logInfo("cloud-sync", message, meta);
  },
});
const serverManager = new ServerManager({
  getProductAnalyticsState: () => productAnalytics.getPersistedState(),
  onWorkspaceServerExited: (event) => {
    emitDesktopEvent(DESKTOP_EVENT_CHANNELS.workspaceServerExited, event);
  },
});
const mobileRelayBridge = new MobileRelayBridge({ serverManager });
const persistence = new PersistenceService();
// Shared between the cowork-media protocol handler and desktop IPC so both
// enforce (and observe approvals against) the same workspace-root boundary.
const workspaceRoots = new WorkspaceRootsController(persistence);
const updater = new DesktopUpdaterService({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  onStateChange: (state) => {
    emitDesktopEvent(DESKTOP_EVENT_CHANNELS.updateStateChanged, state);
  },
  notifyUpdateReady: (state) => {
    showUpdateReadyNotification(state);
  },
  captureError: (error, context) => {
    captureCrashReportingError(error, {
      tags: {
        operation: context.operation,
      },
    });
  },
});
const diagnostics = new DiagnosticsService({
  persistence,
  updater,
  serverDiagnostics: () => serverManager.getDiagnostics(),
});
const windowCloseCoordinator = new NativeWindowCloseCoordinator();
let unregisterAppearanceListener = () => {};
let mainWindow: Electron.BrowserWindow | null = null;
let quickChatController: QuickChatController | null = null;
const menuCommandDispatcher = createMenuCommandDispatcher();
const WINDOW_SHOW_FALLBACK_TIMEOUT_MS = 2_000;

const electronRemoteDebug = resolveElectronRemoteDebugConfig({
  isPackaged: app.isPackaged,
  env: process.env,
});

if (electronRemoteDebug.enabled) {
  app.commandLine.appendSwitch("remote-debugging-port", electronRemoteDebug.port);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

logInfo("main", "desktop process starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  ...(electronUserDataDirOverride.applied
    ? { userDataDirOverride: electronUserDataDirOverride.path }
    : {}),
});

function emitDesktopEvent(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send(channel, payload);
  }
}

function emitSystemAppearance(): void {
  emitDesktopEvent(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, getSystemAppearanceSnapshot());
}

function showUpdateReadyNotification(state: UpdaterState): void {
  if (!Notification.isSupported()) {
    return;
  }
  const version = state.release?.version;
  const isWindows = process.platform === "win32";
  const notification = new Notification({
    title: "Update ready",
    body: version
      ? `Cowork ${version} is ready. Restart to install.`
      : "Cowork update is ready. Restart to install.",
    silent: false,
    ...(isWindows
      ? {
          actions: [
            { type: "button" as const, text: "Restart Now" },
            { type: "button" as const, text: "Later" },
          ],
        }
      : {}),
  });

  if (isWindows) {
    notification.on("action", (_event: Electron.Event, index: number) => {
      if (index === 0) {
        updater.quitAndInstall();
      }
    });
  }

  notification.on("click", () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      void sendMenuCommand("openUpdates");
    }
  });

  notification.show();
}

async function sendMenuCommand(command: DesktopMenuCommand): Promise<void> {
  const existingMainWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const target = await ensureMainWindow();
  menuCommandDispatcher.dispatch(
    command,
    existingMainWindow
      ? {
          send(nextCommand) {
            target.webContents.send(DESKTOP_EVENT_CHANNELS.menuCommand, nextCommand);
          },
        }
      : null,
  );
}

function isExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function isTrustedRendererNavigation(rawUrl: string): boolean {
  if (app.isPackaged) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "file:") {
        return false;
      }
      const resolvedPath = path.resolve(fileURLToPath(parsed));
      return isPathEqualOrInside(PACKAGED_RENDERER_DIR, resolvedPath);
    } catch {
      return false;
    }
  }

  const { url } = resolveDesktopRendererUrl(
    process.env.ELECTRON_RENDERER_URL,
    process.env.COWORK_DESKTOP_RENDERER_PORT,
  );

  try {
    const trusted = new URL(url);
    const parsed = new URL(rawUrl);
    return (
      trusted.protocol === parsed.protocol &&
      trusted.hostname === parsed.hostname &&
      trusted.port === parsed.port
    );
  } catch {
    return false;
  }
}

function parseTrustedCanvasWindowUrl(rawUrl: string): ShowCanvasWindowInput | null {
  if (!isTrustedRendererNavigation(rawUrl)) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.get("window") !== "canvas") {
      return null;
    }
    const targetPath = parsed.searchParams.get("path");
    if (!targetPath) {
      return null;
    }
    return { path: targetPath };
  } catch {
    return null;
  }
}

function applyWindowSecurity(win: Electron.BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const canvasWindow = parseTrustedCanvasWindowUrl(url);
    if (canvasWindow) {
      void createCanvasWindow(canvasWindow);
    } else if (isExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event: Electron.Event, navigationUrl: string) => {
    if (isTrustedRendererNavigation(navigationUrl)) {
      return;
    }

    event.preventDefault();
    if (isExternalUrl(navigationUrl)) {
      void shell.openExternal(navigationUrl);
    }
  });

  win.webContents.on("will-attach-webview", (event: Electron.Event) => {
    event.preventDefault();
  });

  win.webContents.session.setPermissionRequestHandler(
    (
      _webContents: Electron.WebContents,
      _permission: string,
      callback: (permissionGranted: boolean) => void,
    ) => {
      callback(false);
    },
  );
}

function resolveDesktopSmokeConfig(): { workspacePath: string; outputPath: string } | null {
  const workspacePath = process.env[DESKTOP_SMOKE_WORKSPACE_ENV]?.trim();
  const outputPath = process.env[DESKTOP_SMOKE_OUTPUT_ENV]?.trim();
  if (!workspacePath || !outputPath) {
    return null;
  }
  return { workspacePath, outputPath };
}

async function maybeRunPackagedSmoke(initialState: PersistedState | null): Promise<boolean> {
  const smokeConfig = resolveDesktopSmokeConfig();
  if (!smokeConfig) {
    return false;
  }

  const workspaceId = "__desktop_smoke__";

  try {
    const listening = await serverManager.startWorkspaceServer({
      workspaceId,
      workspacePath: smokeConfig.workspacePath,
      yolo: true,
      privacyTelemetrySettings: initialState?.privacyTelemetrySettings,
    });
    await runDesktopSmokePromptLoadCheck({
      url: listening.url,
      workspacePath: smokeConfig.workspacePath,
      clientVersion: app.getVersion(),
    });

    await fs.mkdir(path.dirname(smokeConfig.outputPath), { recursive: true });
    await fs.writeFile(
      smokeConfig.outputPath,
      `${JSON.stringify(
        {
          ok: true,
          type: "server_listening",
          promptLoaded: true,
          turnCompleted: true,
          url: listening.url,
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await serverManager.stopWorkspaceServer(workspaceId);
    app.exit(0);
    return true;
  } catch (error) {
    captureCrashReportingError(error, {
      tags: { operation: "desktop_smoke" },
    });
    await fs.mkdir(path.dirname(smokeConfig.outputPath), { recursive: true });
    await fs.writeFile(
      smokeConfig.outputPath,
      `${JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    try {
      await serverManager.stopWorkspaceServer(workspaceId);
    } catch {
      // Ignore cleanup failures in smoke mode.
    }
    app.exit(1);
    return true;
  }
}

async function loadRendererWindow(
  win: Electron.BrowserWindow,
  windowMode: "main" | "quick-chat" | "utility" | "canvas",
  query: Record<string, string> = {},
): Promise<void> {
  if (!app.isPackaged) {
    const { url, warning } = resolveDesktopRendererUrl(
      process.env.ELECTRON_RENDERER_URL,
      process.env.COWORK_DESKTOP_RENDERER_PORT,
    );
    if (warning) {
      logWarn("renderer", "renderer URL warning", { warning });
      console.warn(`[desktop] ${warning}`);
    }
    const target = new URL(url);
    if (windowMode !== "main") {
      target.searchParams.set("window", windowMode);
    }
    for (const [key, value] of Object.entries(query)) {
      target.searchParams.set(key, value);
    }
    await win.loadURL(target.toString());
    return;
  }

  await win.loadFile(
    path.join(__dirname, "../renderer/index.html"),
    windowMode === "main" ? undefined : { query: { window: windowMode, ...query } },
  );
}

async function createMainWindow(): Promise<Electron.BrowserWindow> {
  const useMacosNativeGlass = shouldUseMacosNativeGlass(process.platform, process.env, {
    prefersReducedTransparency: getSystemAppearanceSnapshot().prefersReducedTransparency,
  });
  const useDarkColors = getSystemAppearanceSnapshot().shouldUseDarkColors;

  // Restore last-saved window bounds (clamped to a visible display) so the
  // window reopens where the user left it. Falls back to defaults on first
  // launch or if the saved state is unusable.
  const savedBounds = await loadMainWindowBounds(app, screen);

  const win = new BrowserWindow({
    title: "Cowork",
    width: savedBounds?.width ?? 1240,
    height: savedBounds?.height ?? 820,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    ...getInitialWindowAppearanceOptions({ useDarkColors, useMacosNativeGlass }),
    ...getPlatformBrowserWindowOptions(process.platform, { useDarkColors, useMacosNativeGlass }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });
  if (savedBounds?.isMaximized) {
    win.maximize();
  }
  mainWindow = win;
  windowCloseCoordinator.track(win as unknown as NativeCloseWindow);
  // Persist bounds on resize/move so the next launch restores them.
  const stopTrackingBounds = trackMainWindowBounds(app, win);
  applyPlatformWindowCreated(win, process.platform);
  applyWindowSecurity(win);
  syncWindowAppearance(win, {
    platform: process.platform,
    useDarkColors,
    useMacosNativeGlass,
  });
  const showWindow = () => {
    if (win.isDestroyed()) {
      return;
    }
    win.show();
  };
  const readyToShowTimeout = setTimeout(showWindow, WINDOW_SHOW_FALLBACK_TIMEOUT_MS);

  win.once("ready-to-show", () => {
    clearTimeout(readyToShowTimeout);
    showWindow();
  });

  win.webContents.on(
    "context-menu",
    (_event: Electron.Event, params: Electron.ContextMenuParams) => {
      const hasSelection = params.selectionText.trim().length > 0;
      const isEditable = params.isEditable;

      const menuItems: Electron.MenuItemConstructorOptions[] = [];

      if (isEditable) {
        menuItems.push(
          { role: "cut", enabled: hasSelection },
          { role: "copy", enabled: hasSelection },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        );
      } else if (hasSelection) {
        menuItems.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
      } else {
        menuItems.push({ role: "selectAll" });
      }

      Menu.buildFromTemplate(menuItems).popup();
    },
  );

  win.on("closed", () => {
    clearTimeout(readyToShowTimeout);
    // Flush final bounds to disk before the window reference is dropped.
    stopTrackingBounds();
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.webContents.once("did-finish-load", () => {
    emitSystemAppearance();
  });

  await loadRendererWindow(win, "main");
  return win;
}

async function createQuickChatWindow(
  opts?: ShowQuickChatWindowInput,
): Promise<Electron.BrowserWindow> {
  const useMacosNativeGlass = shouldUseMacosNativeGlass(process.platform, process.env, {
    prefersReducedTransparency: getSystemAppearanceSnapshot().prefersReducedTransparency,
  });
  const useDarkColors = getSystemAppearanceSnapshot().shouldUseDarkColors;
  const isDarwin = process.platform === "darwin";

  const win = new BrowserWindow({
    title: "Cowork Quick Chat",
    width: 337,
    height: 552,
    minWidth: 275,
    minHeight: 449,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    // Let the native window clip the transparent host instead of drawing a
    // second CSS radius at the renderer edge.
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: useDarkColors ? "#1f1d1a" : "#f5f0e5",
    ...getInitialWindowAppearanceOptions({ useDarkColors, useMacosNativeGlass }),
    ...(isDarwin ? { transparent: true, backgroundColor: "#00000000" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });

  applyPlatformWindowCreated(win, process.platform);
  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false);
  }
  applyWindowSecurity(win);
  syncWindowAppearance(win, {
    platform: process.platform,
    useDarkColors,
    useMacosNativeGlass,
  });
  if (isDarwin) {
    win.setBackgroundColor("#00000000");
  }
  win.setAlwaysOnTop(true, process.platform === "darwin" ? "pop-up-menu" : "normal");
  await loadRendererWindow(win, "quick-chat", quickChatWindowQuery(opts));
  return win;
}

async function retargetQuickChatWindow(
  win: Electron.BrowserWindow,
  opts?: ShowQuickChatWindowInput,
): Promise<void> {
  await loadRendererWindow(win, "quick-chat", quickChatWindowQuery(opts));
}

function quickChatWindowQuery(opts?: ShowQuickChatWindowInput): Record<string, string> {
  return {
    ...(opts?.threadId ? { threadId: opts.threadId } : {}),
    ...(opts?.newThread ? { newThread: "true" } : {}),
  };
}

async function createCanvasWindow(opts: ShowCanvasWindowInput): Promise<Electron.BrowserWindow> {
  const platform = hostPlatform();
  const useDarkColors = getSystemAppearanceSnapshot().shouldUseDarkColors;
  const useMacosNativeGlass = false;
  const backgroundColor = getCanvasNativeBackgroundColor(opts.path, useDarkColors);
  const appearanceOptions = {
    useDarkColors,
    useMacosNativeGlass,
    backgroundColor,
    captionSymbolTone: getCanvasCaptionSymbolTone(opts.path, useDarkColors),
    ...(platform === "win32" ? { backgroundMaterial: "none" as const } : {}),
  };

  const win = new BrowserWindow({
    title: "Cowork Canvas",
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 400,
    ...getInitialWindowAppearanceOptions(appearanceOptions),
    ...getPlatformBrowserWindowOptions(platform, appearanceOptions),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });

  registerWindowAppearanceProfile(win, {
    backgroundColor: (nextUseDarkColors) =>
      getCanvasNativeBackgroundColor(opts.path, nextUseDarkColors),
    captionSymbolTone: (nextUseDarkColors) =>
      getCanvasCaptionSymbolTone(opts.path, nextUseDarkColors),
    useMacosNativeGlass,
    ...(platform === "win32" ? { backgroundMaterial: "none" } : {}),
  });
  windowCloseCoordinator.track(win as unknown as NativeCloseWindow);
  applyPlatformWindowCreated(win, platform);
  applyWindowSecurity(win);
  syncWindowAppearance(win, {
    platform,
    ...appearanceOptions,
  });

  win.show();
  await loadRendererWindow(win, "canvas", { path: opts.path });
  return win;
}

async function createUtilityWindow(): Promise<Electron.BrowserWindow> {
  const useMacosNativeGlass = shouldUseMacosNativeGlass(process.platform, process.env, {
    prefersReducedTransparency: getSystemAppearanceSnapshot().prefersReducedTransparency,
  });
  const useDarkColors = getSystemAppearanceSnapshot().shouldUseDarkColors;
  const isDarwin = process.platform === "darwin";

  const win = new BrowserWindow({
    title: "Cowork Menu",
    width: 252,
    height: 400,
    minWidth: 252,
    minHeight: 300,
    maxWidth: 312,
    maxHeight: 560,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    // macOS: match the system rounded (menu-style) window shape so a transparent
    // frameless host does not show ragged/empty crescents; renderer draws edge-to-edge.
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: useDarkColors ? "#1f1d1a" : "#f5f0e5",
    ...getInitialWindowAppearanceOptions({ useDarkColors, useMacosNativeGlass }),
    ...(isDarwin ? { transparent: true, backgroundColor: "#00000000" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });

  applyPlatformWindowCreated(win, process.platform);
  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false);
  }
  applyWindowSecurity(win);
  syncWindowAppearance(win, {
    platform: process.platform,
    useDarkColors,
    useMacosNativeGlass,
  });
  if (isDarwin) {
    win.setBackgroundColor("#00000000");
  }
  win.setAlwaysOnTop(true, process.platform === "darwin" ? "pop-up-menu" : "normal");
  await loadRendererWindow(win, "utility");
  return win;
}

async function ensureMainWindow(): Promise<Electron.BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealAndActivateWindow(app, mainWindow);
    return mainWindow;
  }
  const win = await createMainWindow();
  revealAndActivateWindow(app, win);
  return win;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void quickChatController?.showMainWindow();
  });

  app
    .whenReady()
    .then(async () => {
      registerDesktopMediaProtocolHandler(protocol, net, workspaceRoots);
      const initialState: PersistedState | null = await persistence.loadState().catch(() => null);
      await initElectronMainCrashReporting(initialState?.privacyTelemetrySettings);
      let preparedInitialState = initialState;
      if (preparedInitialState) {
        const prepared = productAnalytics.preparePersistedState(preparedInitialState);
        preparedInitialState = prepared.state;
        if (prepared.changed) {
          await persistence.saveState(preparedInitialState);
        }
        await productAnalytics.applyPersistedState(preparedInitialState);
      } else {
        await productAnalytics.applyPersistedState({
          version: 2,
          workspaces: [],
          threads: [],
          privacyTelemetrySettings: undefined,
        });
      }

      if (await maybeRunPackagedSmoke(preparedInitialState)) {
        return;
      }

      quickChatController = new QuickChatController({
        appName: DESKTOP_APP_NAME,
        trayIconPath: resolveTrayIconPath(__dirname),
        getMainWindow: () => mainWindow,
        createMainWindow,
        createQuickChatWindow,
        retargetQuickChatWindow,
        createUtilityWindow,
      });
      if (preparedInitialState) {
        quickChatController.applyPersistedState(preparedInitialState);
      }
      quickChatController.initialize();

      registerDesktopIpc({
        mobileRelayBridge,
        persistence,
        workspaceRoots,
        productAnalytics,
        cloudSync,
        diagnostics,
        serverManager,
        updater,
        showMainWindow: () => quickChatController?.showMainWindow(),
        consumePendingMenuCommands: () => menuCommandDispatcher.drainPending(),
        showQuickChatWindow: (opts?: ShowQuickChatWindowInput) =>
          quickChatController?.showQuickChatWindow(opts),
        showCanvasWindow: (opts: ShowCanvasWindowInput) => {
          void createCanvasWindow(opts);
        },
        resolveWindowCloseRequest: (sender, response) => {
          windowCloseCoordinator.resolve(sender, response);
        },
        shouldKeepPopupWindowsAlive: () =>
          quickChatController?.shouldKeepPopupWindowsAlive() === true,
        applyPersistedState: (state: PersistedState) => {
          quickChatController?.applyPersistedState(state);
          void productAnalytics.applyPersistedState(state).then(async (prepared) => {
            if (prepared.changed) {
              await persistence.saveState(prepared.state);
            }
          });
        },
      });
      unregisterAppearanceListener = registerSystemAppearanceListener(
        (appearance: SystemAppearance) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed()) {
              continue;
            }
            applySystemAppearanceToWindow(win, appearance);
          }
          emitDesktopEvent(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, appearance);
        },
      );

      installDesktopApplicationMenu({
        includeDevTools: !app.isPackaged,
        openExternal: (url: string) => {
          void shell.openExternal(url);
        },
        openQuickChat: () => {
          void quickChatController?.showQuickChatWindow();
        },
        sendCommand: (command: DesktopMenuCommand) => {
          void sendMenuCommand(command);
        },
      });

      updater.start();
      void ensureMainWindow();

      app.on("activate", () => {
        void ensureMainWindow();
      });
    })
    .catch((error) => {
      logError("main", error, { operation: "desktop_startup" });
      captureCrashReportingError(error, {
        tags: { operation: "desktop_startup" },
      });
      console.error(error);
      app.exit(1);
    });

  app.on(
    "before-quit",
    createBeforeQuitHandler({
      unregisterAppearanceListener: () => unregisterAppearanceListener(),
      stopUpdater: () => updater.dispose(),
      stopMobileRelayBridge: async () => {
        mobileRelayBridge.stopForShutdown();
      },
      stopQuickChat: () => quickChatController?.dispose(),
      stopProductAnalytics: () => productAnalytics.shutdown(),
      stopCloudSync: () => cloudSync.shutdown(),
      stopAllServers: () => serverManager.stopAll(),
      quit: () => app.quit(),
      onError: (error) => {
        logError("shutdown", error, { operation: "stop_workspace_servers" });
        console.error(
          `[desktop] Failed to stop workspace servers during shutdown: ${String(error)}`,
        );
      },
    }),
  );

  app.on("window-all-closed", () => {
    if (
      process.platform === "linux" ||
      (process.platform === "win32" && !quickChatController?.hasTray())
    ) {
      app.quit();
    }
  });
}
