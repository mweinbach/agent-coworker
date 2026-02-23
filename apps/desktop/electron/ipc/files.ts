import fs from "node:fs/promises";
import path from "node:path";

import { clipboard, shell } from "electron";

import {
  DESKTOP_IPC_CHANNELS,
  type CopyPathInput,
  type CreateDirectoryInput,
  type ListDirectoryInput,
  type OpenPathInput,
  type RenamePathInput,
  type RevealPathInput,
  type TrashPathInput,
} from "../../src/lib/desktopApi";
import {
  copyPathInputSchema,
  createDirectoryInputSchema,
  listDirectoryInputSchema,
  openPathInputSchema,
  renamePathInputSchema,
  revealPathInputSchema,
  trashPathInputSchema,
} from "../../src/lib/desktopSchemas";
import { resolveAllowedDirectoryPath, resolveAllowedPath } from "../services/ipcSecurity";
import type { DesktopIpcModuleContext } from "./types";

export function registerFilesIpc(context: DesktopIpcModuleContext): void {
  const { handleDesktopInvoke, parseWithSchema, workspaceRoots } = context;

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.listDirectory, async (_event, args: ListDirectoryInput) => {
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const input = parseWithSchema(listDirectoryInputSchema, args, "listDirectory options");
    const approvedRoots = workspaceRoots.getApprovedWorkspaceRoots();
    if (approvedRoots.length === 0) {
      throw new Error("No workspace roots available for directory listing");
    }
    const safePath = resolveAllowedDirectoryPath(approvedRoots, input.path);

    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const isHidden = entry.name.startsWith(".");
        if (!input.includeHidden && isHidden) {
          return null;
        }

        let sizeBytes: number | null = null;
        let modifiedAtMs: number | null = null;
        try {
          const stat = await fs.stat(path.join(safePath, entry.name));
          sizeBytes = stat.size;
          modifiedAtMs = stat.mtimeMs;
        } catch {
          // Ignore stat errors for broken symlinks etc.
        }

        return {
          name: entry.name,
          path: path.join(safePath, entry.name),
          isDirectory: entry.isDirectory(),
          isHidden,
          sizeBytes,
          modifiedAtMs,
        };
      })
    );

    return results
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.openPath, async (_event, args: OpenPathInput) => {
    const input = parseWithSchema(openPathInputSchema, args, "openPath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
    const errString = await shell.openPath(safePath);
    if (errString) {
      throw new Error(errString);
    }
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.revealPath, async (_event, args: RevealPathInput) => {
    const input = parseWithSchema(revealPathInputSchema, args, "revealPath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
    shell.showItemInFolder(safePath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.copyPath, async (_event, args: CopyPathInput) => {
    const input = parseWithSchema(copyPathInputSchema, args, "copyPath options");
    clipboard.writeText(input.path);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.createDirectory, async (_event, args: CreateDirectoryInput) => {
    const input = parseWithSchema(createDirectoryInputSchema, args, "createDirectory options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const roots = workspaceRoots.getApprovedWorkspaceRoots();
    const safeParent = resolveAllowedDirectoryPath(roots, input.parentPath);
    const targetPath = path.join(safeParent, input.name);
    resolveAllowedPath(roots, targetPath);
    await fs.mkdir(targetPath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.renamePath, async (_event, args: RenamePathInput) => {
    const input = parseWithSchema(renamePathInputSchema, args, "renamePath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const roots = workspaceRoots.getApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(roots, input.path);
    const targetPath = path.join(path.dirname(safePath), input.newName);
    resolveAllowedPath(roots, targetPath);
    await fs.rename(safePath, targetPath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.trashPath, async (_event, args: TrashPathInput) => {
    const input = parseWithSchema(trashPathInputSchema, args, "trashPath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
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
}
