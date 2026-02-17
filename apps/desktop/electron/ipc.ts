import { BrowserWindow, dialog, ipcMain, Menu } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

import { DESKTOP_IPC_CHANNELS, type StartWorkspaceServerInput, type StopWorkspaceServerInput, type DeleteTranscriptInput, type ReadTranscriptInput, type TranscriptBatchInput, type ShowContextMenuInput, type ListDirectoryInput } from "../src/lib/desktopApi";
import type { PersistedState } from "../src/app/types";

import { PersistenceService } from "./services/persistence";
import { ServerManager } from "./services/serverManager";

type DesktopIpcDeps = {
  persistence: PersistenceService;
  serverManager: ServerManager;
};

function toIpcError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function registerDesktopIpc(deps: DesktopIpcDeps): () => void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.startWorkspaceServer, async (_event, args: StartWorkspaceServerInput) => {
    try {
      return await deps.serverManager.startWorkspaceServer(args);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, async (_event, args: StopWorkspaceServerInput) => {
    try {
      await deps.serverManager.stopWorkspaceServer(args.workspaceId);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.loadState, async () => {
    try {
      return await deps.persistence.loadState();
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.saveState, async (_event, state: PersistedState) => {
    try {
      await deps.persistence.saveState(state);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.readTranscript, async (_event, args: ReadTranscriptInput) => {
    try {
      return await deps.persistence.readTranscript(args.threadId);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, async (_event, args: TranscriptBatchInput) => {
    try {
      await deps.persistence.appendTranscriptEvent(args);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, async (_event, args: TranscriptBatchInput[]) => {
    try {
      await deps.persistence.appendTranscriptBatch(args);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.deleteTranscript, async (_event, args: DeleteTranscriptInput) => {
    try {
      await deps.persistence.deleteTranscript(args.threadId);
    } catch (error) {
      throw toIpcError(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory, async (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: "Select a workspace directory",
      properties: ["openDirectory"],
    });

    if (result.canceled) {
      return null;
    }

    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.showContextMenu, async (event, args: ShowContextMenuInput) => {
    return new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        args.items.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled !== false,
          click: () => resolve(item.id),
        }))
      );

      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
      if (!ownerWindow) {
        resolve(null);
        return;
      }

      menu.popup({ window: ownerWindow, callback: () => resolve(null) });
    });
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowMinimize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowClose, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.getPlatform, () => {
    return process.platform;
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.listDirectory, async (_event, args: ListDirectoryInput) => {
    try {
      const entries = await fs.readdir(args.path, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch (error) {
      throw toIpcError(error);
    }
  });

  return () => {
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
