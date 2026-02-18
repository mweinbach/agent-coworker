import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, shell } from "electron";

import { registerDesktopIpc } from "./ipc";
import { PersistenceService } from "./services/persistence";
import { resolveDesktopRendererUrl } from "./services/rendererUrl";
import { ServerManager } from "./services/serverManager";
import { createBeforeQuitHandler } from "./services/shutdown";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGED_RENDERER_DIR = path.resolve(path.join(__dirname, "../renderer"));

const serverManager = new ServerManager();
const persistence = new PersistenceService();
let unregisterIpc = () => {};
let mainWindow: BrowserWindow | null = null;

if (!app.isPackaged && process.env.COWORK_ELECTRON_REMOTE_DEBUG === "1") {
  const port = process.env.COWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() || "9222";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
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

async function createWindow(): Promise<void> {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    title: "Cowork",
    width: 1240,
    height: 820,
    titleBarStyle: isMac ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  applyWindowSecurity(win);

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
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
    return;
  }

  await win.loadFile(path.join(__dirname, "../renderer/index.html"));
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

  app.whenReady().then(() => {
    unregisterIpc = registerDesktopIpc({
      persistence,
      serverManager,
    });

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
