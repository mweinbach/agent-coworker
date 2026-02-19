import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

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

async function normalizeWorkspacePath(workspacePath: string): Promise<string> {
  if (!workspacePath.trim()) {
    throw new Error("workspacePath must be a non-empty string");
  }

  const resolved = path.resolve(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`workspacePath is not a directory: ${workspacePath}`);
  }
  return await fs.realpath(resolved);
}

export function registerDesktopIpc(deps: DesktopIpcDeps): () => void {
  const approvedWorkspaceRoots = new Set<string>();
  let approvedWorkspaceRootsInitialized = false;

  function resetApprovedWorkspaceRoots(paths: Iterable<string>): void {
    approvedWorkspaceRoots.clear();
    for (const workspacePath of paths) {
      approvedWorkspaceRoots.add(workspacePath);
    }
    approvedWorkspaceRootsInitialized = true;
  }

  async function ensureApprovedWorkspaceRoots(): Promise<void> {
    if (approvedWorkspaceRootsInitialized) {
      return;
    }

    const state = await deps.persistence.loadState();
    const roots: string[] = [];
    for (const workspace of state.workspaces) {
      try {
        roots.push(await normalizeWorkspacePath(workspace.path));
      } catch {
        // Ignore invalid paths from persisted state.
      }
    }
    resetApprovedWorkspaceRoots(roots);
  }

  async function assertApprovedWorkspacePath(workspacePath: string): Promise<string> {
    await ensureApprovedWorkspaceRoots();
    const normalized = await normalizeWorkspacePath(workspacePath);
    if (!approvedWorkspaceRoots.has(normalized)) {
      throw new Error("Workspace path is not approved. Use the workspace picker before saving or starting.");
    }
    return normalized;
  }

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
    async (_event, args: StartWorkspaceServerInput) => {
      const workspacePath = await assertApprovedWorkspacePath(args.workspacePath);
      return await deps.serverManager.startWorkspaceServer({
        ...args,
        workspacePath,
      });
    }
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, async (_event, args: StopWorkspaceServerInput) => {
    await deps.serverManager.stopWorkspaceServer(args.workspaceId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.loadState, async () => {
    const state = await deps.persistence.loadState();
    const normalizedRoots: string[] = [];
    for (const workspace of state.workspaces) {
      try {
        normalizedRoots.push(await normalizeWorkspacePath(workspace.path));
      } catch {
        // Ignore invalid paths from persisted state.
      }
    }
    resetApprovedWorkspaceRoots(normalizedRoots);
    return state;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.saveState, async (_event, state: PersistedState) => {
    const workspaces = await Promise.all(
      state.workspaces.map(async (workspace) => ({
        ...workspace,
        path: await assertApprovedWorkspacePath(workspace.path),
      }))
    );
    const nextState: PersistedState = {
      ...state,
      workspaces,
    };
    await deps.persistence.saveState(nextState);
    resetApprovedWorkspaceRoots(workspaces.map((workspace) => workspace.path));
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

    const selectedPath = result.filePaths[0];
    if (!selectedPath) {
      return null;
    }

    const normalized = await normalizeWorkspacePath(selectedPath);
    approvedWorkspaceRoots.add(normalized);
    approvedWorkspaceRootsInitialized = true;
    return normalized;
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
    await ensureApprovedWorkspaceRoots();
    const requestedPath = assertListDirectoryPath(args);
    const workspaceRoots = Array.from(approvedWorkspaceRoots.values());
    if (workspaceRoots.length === 0) {
      throw new Error("No workspace roots available for directory listing");
    }
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
