import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, nativeTheme, shell, clipboard, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  DESKTOP_IPC_CHANNELS,
  type ConfirmActionInput,
  type CopyPathInput,
  type CreateDirectoryInput,
  type DeleteTranscriptInput,
  type DesktopNotificationInput,
  type ListDirectoryInput,
  type OpenPathInput,
  type ReadTranscriptInput,
  type RenamePathInput,
  type RevealPathInput,
  type SetWindowAppearanceInput,
  type ShowContextMenuInput,
  type StartWorkspaceServerInput,
  type StopWorkspaceServerInput,
  type TranscriptBatchInput,
  type TrashPathInput,
} from "../src/lib/desktopApi";
import type { PersistedState } from "../src/app/types";
import {
  confirmActionInputSchema,
  copyPathInputSchema,
  createDirectoryInputSchema,
  deleteTranscriptInputSchema,
  desktopNotificationInputSchema,
  listDirectoryInputSchema,
  openPathInputSchema,
  persistedStateInputSchema,
  readTranscriptInputSchema,
  renamePathInputSchema,
  revealPathInputSchema,
  setWindowAppearanceInputSchema,
  showContextMenuInputSchema,
  startWorkspaceServerInputSchema,
  stopWorkspaceServerInputSchema,
  transcriptBatchInputSchema,
  trashPathInputSchema,
} from "../src/lib/desktopSchemas";

import { isTrustedDesktopSenderUrl, resolveAllowedDirectoryPath, resolveAllowedPath } from "./services/ipcSecurity";
import { applyWindowAppearance, getSystemAppearanceSnapshot } from "./services/appearance";
import { buildConfirmDialog } from "./services/dialogs";
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

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const detail = issue?.message ?? "is invalid";
  throw new Error(`${label} ${detail}`);
}

function assertListDirectoryPath(args: ListDirectoryInput): string {
  return parseWithSchema(listDirectoryInputSchema, args, "listDirectory options").path;
}

function assertConfirmActionInput(args: ConfirmActionInput): ConfirmActionInput {
  return parseWithSchema(confirmActionInputSchema, args, "confirmAction options");
}

function assertDesktopNotificationInput(args: DesktopNotificationInput): DesktopNotificationInput {
  return parseWithSchema(desktopNotificationInputSchema, args, "showNotification options");
}

function assertSetWindowAppearanceInput(args: SetWindowAppearanceInput): SetWindowAppearanceInput {
  return parseWithSchema(setWindowAppearanceInputSchema, args, "setWindowAppearance options");
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
      const input = parseWithSchema(startWorkspaceServerInputSchema, args, "startWorkspaceServer options");
      const workspacePath = await assertApprovedWorkspacePath(input.workspacePath);
      return await deps.serverManager.startWorkspaceServer({
        ...input,
        workspacePath,
      });
    }
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, async (_event, args: StopWorkspaceServerInput) => {
    const input = parseWithSchema(stopWorkspaceServerInputSchema, args, "stopWorkspaceServer options");
    await deps.serverManager.stopWorkspaceServer(input.workspaceId);
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
    const input = parseWithSchema(persistedStateInputSchema, state, "state");
    const workspaces = await Promise.all(
      input.workspaces.map(async (workspace) => ({
        ...workspace,
        path: await assertApprovedWorkspacePath(workspace.path),
      }))
    );
    const nextState: PersistedState = {
      ...input,
      workspaces,
    };
    await deps.persistence.saveState(nextState);
    resetApprovedWorkspaceRoots(workspaces.map((workspace) => workspace.path));
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.readTranscript, async (_event, args: ReadTranscriptInput) => {
    const input = parseWithSchema(readTranscriptInputSchema, args, "readTranscript options");
    return await deps.persistence.readTranscript(input.threadId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, async (_event, args: TranscriptBatchInput) => {
    const input = parseWithSchema(transcriptBatchInputSchema, args, "transcript event");
    await deps.persistence.appendTranscriptEvent(input);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, async (_event, args: TranscriptBatchInput[]) => {
    const input = parseWithSchema(z.array(transcriptBatchInputSchema), args, "transcript batch");
    await deps.persistence.appendTranscriptBatch(input);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.deleteTranscript, async (_event, args: DeleteTranscriptInput) => {
    const input = parseWithSchema(deleteTranscriptInputSchema, args, "deleteTranscript options");
    await deps.persistence.deleteTranscript(input.threadId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory, async (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const dialogOptions = {
      title: "Select a workspace directory",
      properties: ["openDirectory"] as const,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

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
    const input = parseWithSchema(showContextMenuInputSchema, args, "showContextMenu options");
    return new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        input.items.map((item) => ({
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
    
    const results = await Promise.all(
      entries.map(async (e) => {
        const isHidden = e.name.startsWith(".");
        if (!args.includeHidden && isHidden) return null;
        
        let sizeBytes: number | null = null;
        let modifiedAtMs: number | null = null;
        try {
          const stat = await fs.stat(path.join(safePath, e.name));
          sizeBytes = stat.size;
          modifiedAtMs = stat.mtimeMs;
        } catch {
          // Ignore stat errors for broken symlinks etc.
        }

        return {
          name: e.name,
          path: path.join(safePath, e.name),
          isDirectory: e.isDirectory(),
          isHidden,
          sizeBytes,
          modifiedAtMs,
        };
      })
    );

    return results
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.openPath, async (_event, args: OpenPathInput) => {
    const input = parseWithSchema(openPathInputSchema, args, "openPath options");
    await ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(Array.from(approvedWorkspaceRoots.values()), input.path);
    const errString = await shell.openPath(safePath);
    if (errString) throw new Error(errString);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.revealPath, async (_event, args: RevealPathInput) => {
    const input = parseWithSchema(revealPathInputSchema, args, "revealPath options");
    await ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(Array.from(approvedWorkspaceRoots.values()), input.path);
    shell.showItemInFolder(safePath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.copyPath, async (_event, args: CopyPathInput) => {
    const input = parseWithSchema(copyPathInputSchema, args, "copyPath options");
    clipboard.writeText(input.path);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.createDirectory, async (_event, args: CreateDirectoryInput) => {
    const input = parseWithSchema(createDirectoryInputSchema, args, "createDirectory options");
    await ensureApprovedWorkspaceRoots();
    const safeParent = resolveAllowedDirectoryPath(Array.from(approvedWorkspaceRoots.values()), input.parentPath);
    const targetPath = path.join(safeParent, input.name);
    // ensure the new path is also within roots
    resolveAllowedPath(Array.from(approvedWorkspaceRoots.values()), targetPath);
    await fs.mkdir(targetPath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.renamePath, async (_event, args: RenamePathInput) => {
    const input = parseWithSchema(renamePathInputSchema, args, "renamePath options");
    await ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(Array.from(approvedWorkspaceRoots.values()), input.path);
    const targetPath = path.join(path.dirname(safePath), input.newName);
    resolveAllowedPath(Array.from(approvedWorkspaceRoots.values()), targetPath);
    await fs.rename(safePath, targetPath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.trashPath, async (_event, args: TrashPathInput) => {
    const input = parseWithSchema(trashPathInputSchema, args, "trashPath options");
    await ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(Array.from(approvedWorkspaceRoots.values()), input.path);
    try {
      await shell.trashItem(safePath);
      return;
    } catch (trashError) {
      try {
        // Fallback for environments where OS trash integration is unavailable for directories.
        await fs.rm(safePath, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
        return;
      } catch (deleteError) {
        const trashDetail = trashError instanceof Error ? trashError.message : String(trashError);
        const deleteDetail = deleteError instanceof Error ? deleteError.message : String(deleteError);
        throw new Error(`Unable to move to Trash (${trashDetail}) and permanent delete failed (${deleteDetail})`);
      }
    }
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.confirmAction, async (event, args: ConfirmActionInput) => {
    const input = assertConfirmActionInput(args);
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const built = buildConfirmDialog(input);

    const response = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, built.options)
      : await dialog.showMessageBox(built.options);
    return response.response === built.confirmButtonIndex;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.showNotification, async (_event, args: DesktopNotificationInput) => {
    const input = assertDesktopNotificationInput(args);
    if (!Notification.isSupported()) {
      return false;
    }
    const notification = new Notification({
      title: input.title.trim(),
      body: input.body?.trim(),
      silent: input.silent,
    });
    notification.show();
    return true;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getSystemAppearance, async () => {
    return getSystemAppearanceSnapshot();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.setWindowAppearance, async (event, args: SetWindowAppearanceInput) => {
    const input = assertSetWindowAppearanceInput(args);
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!ownerWindow) {
      if (input.themeSource) {
        nativeTheme.themeSource = input.themeSource;
      }
      return getSystemAppearanceSnapshot();
    }
    return applyWindowAppearance(ownerWindow, input);
  });

  return () => {
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
