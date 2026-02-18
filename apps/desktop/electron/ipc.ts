import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";

import {
  DESKTOP_IPC_CHANNELS,
  type DeleteTranscriptInput,
  type ListDirectoryInput,
  type ReadTranscriptInput,
  type ShowContextMenuInput,
  type StartWorkspaceServerInput,
  type StopWorkspaceServerInput,
  type TranscriptBatchInput,
} from "../src/lib/desktopApi";
import type { PersistedState } from "../src/app/types";

import { isTrustedDesktopSenderUrl, resolveAllowedDirectoryPath } from "./services/ipcSecurity";
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

function resolveSenderUrl(event: IpcMainInvokeEvent): string {
  const senderFrameUrl = event.senderFrame?.url?.trim();
  if (senderFrameUrl) {
    return senderFrameUrl;
  }
  return event.sender.getURL();
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const senderUrl = resolveSenderUrl(event);
  return isTrustedDesktopSenderUrl(senderUrl, {
    isPackaged: app.isPackaged,
    electronRendererUrl: process.env.ELECTRON_RENDERER_URL,
    desktopRendererPort: process.env.COWORK_DESKTOP_RENDERER_PORT,
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = resolveSenderUrl(event);
  if (!isTrustedSender(event)) {
    throw new Error(`Untrusted IPC sender: ${senderUrl || "unknown"}`);
  }
}

function assertListDirectoryPath(args: ListDirectoryInput): string {
  if (!args || typeof args.path !== "string") {
    throw new Error("path must be a string");
  }
  return args.path;
}

export function registerDesktopIpc(deps: DesktopIpcDeps): () => void {
  function handleDesktopInvoke<TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
  ): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertTrustedSender(event);
        return await handler(event, ...(args as TArgs));
      } catch (error) {
        throw toIpcError(error);
      }
    });
  }

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.startWorkspaceServer,
    async (_event, args: StartWorkspaceServerInput) => await deps.serverManager.startWorkspaceServer(args)
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, async (_event, args: StopWorkspaceServerInput) => {
    await deps.serverManager.stopWorkspaceServer(args.workspaceId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.loadState, async () => await deps.persistence.loadState());

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.saveState, async (_event, state: PersistedState) => {
    await deps.persistence.saveState(state);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.readTranscript, async (_event, args: ReadTranscriptInput) => {
    return await deps.persistence.readTranscript(args.threadId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, async (_event, args: TranscriptBatchInput) => {
    await deps.persistence.appendTranscriptEvent(args);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, async (_event, args: TranscriptBatchInput[]) => {
    await deps.persistence.appendTranscriptBatch(args);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.deleteTranscript, async (_event, args: DeleteTranscriptInput) => {
    await deps.persistence.deleteTranscript(args.threadId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory, async (event) => {
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
  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.showContextMenu, async (event, args: ShowContextMenuInput) => {
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

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowMinimize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.windowClose, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getPlatform, () => {
    return process.platform;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.listDirectory, async (_event, args: ListDirectoryInput) => {
    const requestedPath = assertListDirectoryPath(args);
    const state = await deps.persistence.loadState();
    const workspaceRoots = state.workspaces.map((workspace) => workspace.path);
    const safePath = resolveAllowedDirectoryPath(workspaceRoots, requestedPath);

    const entries = await fs.readdir(safePath, { withFileTypes: true });
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
  });

  return () => {
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
