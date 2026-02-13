import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { registerDesktopIpc } from "./ipc";
import { PersistenceService } from "./services/persistence";
import { ServerManager } from "./services/serverManager";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverManager = new ServerManager();
const persistence = new PersistenceService();
let unregisterIpc = () => {};

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    title: "Cowork",
    width: 1240,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
    return;
  }

  await win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

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

app.on("before-quit", () => {
  unregisterIpc();
  void serverManager.stopAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
