import { BrowserWindow, dialog, ipcMain } from "electron";

import { DESKTOP_IPC_CHANNELS, type StartWorkspaceServerInput, type StopWorkspaceServerInput, type DeleteTranscriptInput, type ReadTranscriptInput, type TranscriptBatchInput } from "../src/lib/desktopApi";
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

  return () => {
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
