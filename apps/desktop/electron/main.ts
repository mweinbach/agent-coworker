import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, Notification, shell } from "electron";

import { DESKTOP_EVENT_CHANNELS, type DesktopMenuCommand, type UpdaterState } from "../src/lib/desktopApi";
import { registerDesktopIpc } from "./ipc";
import {
  applySystemAppearanceToWindow,
  getInitialWindowAppearanceOptions,
  getSystemAppearanceSnapshot,
  registerSystemAppearanceListener,
  syncWindowAppearance,
} from "./services/appearance";
import { installDesktopApplicationMenu } from "./services/menu";
import { PersistenceService } from "./services/persistence";
import { resolveDesktopRendererUrl } from "./services/rendererUrl";
import { ServerManager } from "./services/serverManager";
import { createBeforeQuitHandler } from "./services/shutdown";
import { DesktopUpdaterService } from "./services/updater";
import {
  applyPlatformWindowCreated,
  getPlatformBrowserWindowOptions,
  shouldUseMacosNativeGlass,
} from "./services/windowEnhancements";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGED_RENDERER_DIR = path.resolve(path.join(__dirname, "../renderer"));
const DESKTOP_SMOKE_WORKSPACE_ENV = "COWORK_DESKTOP_SMOKE_WORKSPACE";
const DESKTOP_SMOKE_OUTPUT_ENV = "COWORK_DESKTOP_SMOKE_OUTPUT";

const serverManager = new ServerManager();
const persistence = new PersistenceService();
const updater = new DesktopUpdaterService({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  onStateChange: (state) => {
    emitDesktopEvent(DESKTOP_EVENT_CHANNELS.updateStateChanged, state);
  },
  notifyUpdateReady: (state) => {
    showUpdateReadyNotification(state);
  },
});
let unregisterIpc = () => {};
let unregisterAppearanceListener = () => {};
let mainWindow: BrowserWindow | null = null;
const WINDOW_SHOW_FALLBACK_TIMEOUT_MS = 2_000;

app.setName("Cowork");

if (!app.isPackaged && process.env.COWORK_ELECTRON_REMOTE_DEBUG === "1") {
  const port = process.env.COWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() || "9222";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

if (process.platform === "win32") {
  app.setAppUserModelId("com.cowork.desktop");
}

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
    body: version ? `Cowork ${version} is ready. Restart to install.` : "Cowork update is ready. Restart to install.",
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
      sendMenuCommand("openUpdates");
    }
  });

  notification.show();
}

function sendMenuCommand(command: DesktopMenuCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!target || target.isDestroyed()) {
    return;
  }
  target.webContents.send(DESKTOP_EVENT_CHANNELS.menuCommand, command);
}

function isExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
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
      const relative = path.relative(PACKAGED_RENDERER_DIR, resolvedPath);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    } catch {
      return false;
    }
  }

  const { url } = resolveDesktopRendererUrl(
    process.env.ELECTRON_RENDERER_URL,
    process.env.COWORK_DESKTOP_RENDERER_PORT
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

function applyWindowSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, navigationUrl) => {
    if (isTrustedRendererNavigation(navigationUrl)) {
      return;
    }

    event.preventDefault();
    if (isExternalUrl(navigationUrl)) {
      void shell.openExternal(navigationUrl);
    }
  });

  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function resolveDesktopSmokeConfig(): { workspacePath: string; outputPath: string } | null {
  const workspacePath = process.env[DESKTOP_SMOKE_WORKSPACE_ENV]?.trim();
  const outputPath = process.env[DESKTOP_SMOKE_OUTPUT_ENV]?.trim();
  if (!workspacePath || !outputPath) {
    return null;
  }
  return { workspacePath, outputPath };
}

async function maybeRunPackagedSmoke(): Promise<boolean> {
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
    });

    await fs.mkdir(path.dirname(smokeConfig.outputPath), { recursive: true });
    await fs.writeFile(
      smokeConfig.outputPath,
      `${JSON.stringify({
        ok: true,
        type: "server_listening",
        url: listening.url,
        platform: process.platform,
        arch: process.arch,
      }, null, 2)}\n`,
      "utf8"
    );
    await serverManager.stopWorkspaceServer(workspaceId);
    app.exit(0);
    return true;
  } catch (error) {
    await fs.mkdir(path.dirname(smokeConfig.outputPath), { recursive: true });
    await fs.writeFile(
      smokeConfig.outputPath,
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        platform: process.platform,
        arch: process.arch,
      }, null, 2)}\n`,
      "utf8"
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

async function createWindow(): Promise<void> {
  const useMacosNativeGlass = shouldUseMacosNativeGlass(process.platform, process.env, {
    prefersReducedTransparency: getSystemAppearanceSnapshot().prefersReducedTransparency,
  });
  const useDarkColors = getSystemAppearanceSnapshot().shouldUseDarkColors;

  const win = new BrowserWindow({
    title: "Cowork",
    width: 1240,
    height: 820,
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
  mainWindow = win;
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

  win.webContents.on("context-menu", (_event, params) => {
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
      menuItems.push(
        { role: "copy" },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else {
      menuItems.push({ role: "selectAll" });
    }

    Menu.buildFromTemplate(menuItems).popup();
  });

  win.on("closed", () => {
    clearTimeout(readyToShowTimeout);
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.webContents.once("did-finish-load", () => {
    emitSystemAppearance();
  });

  if (!app.isPackaged) {
    const { url, warning } = resolveDesktopRendererUrl(
      process.env.ELECTRON_RENDERER_URL,
      process.env.COWORK_DESKTOP_RENDERER_PORT
    );
    if (warning) {
      console.warn(`[desktop] ${warning}`);
    }
    await win.loadURL(url);
  } else {
    await win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (await maybeRunPackagedSmoke()) {
      return;
    }

    unregisterIpc = registerDesktopIpc({
      persistence,
      serverManager,
      updater,
    });
    unregisterAppearanceListener = registerSystemAppearanceListener((appearance) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) {
          continue;
        }
        applySystemAppearanceToWindow(win, appearance);
      }
      emitDesktopEvent(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, appearance);
    });

    installDesktopApplicationMenu({
      includeDevTools: !app.isPackaged,
      openExternal: (url) => {
        void shell.openExternal(url);
      },
      sendCommand: (command) => sendMenuCommand(command),
    });

    updater.start();
    void createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });

  app.on(
    "before-quit",
    createBeforeQuitHandler({
      unregisterIpc: () => unregisterIpc(),
      unregisterAppearanceListener: () => unregisterAppearanceListener(),
      stopUpdater: () => updater.dispose(),
      stopAllServers: () => serverManager.stopAll(),
      quit: () => app.quit(),
      onError: (error) => {
        console.error(`[desktop] Failed to stop workspace servers during shutdown: ${String(error)}`);
      },
    })
  );

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
