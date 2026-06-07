import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type * as Electron from "electron";

import { MAX_ATTACHMENT_UPLOAD_BYTE_SIZE } from "../../../../src/shared/attachments";
import { isPathInside, resolvePathInsideRootForBoundaryCheck } from "../../../../src/utils/paths";
import {
  type AuthorizeUploadSourceInput,
  type CopyFileToWorkspaceUploadsInput,
  type CopyFileToWorkspaceUploadsOutput,
  type CopyPathInput,
  type CreateDirectoryInput,
  DESKTOP_IPC_CHANNELS,
  type ListDirectoryInput,
  type OpenPathInput,
  type PickDirectoryInput,
  type PreferredFileAppInput,
  type PreviewOSFileInput,
  type ReadFileForPreviewInput,
  type ReadFileInput,
  type RenamePathInput,
  type RevealPathInput,
  type SaveExportedFileInput,
  type TrashPathInput,
  type WriteFileInput,
} from "../../src/lib/desktopApi";
import {
  authorizeUploadSourceInputSchema,
  copyFileToWorkspaceUploadsInputSchema,
  copyPathInputSchema,
  copyTextInputSchema,
  createDirectoryInputSchema,
  listDirectoryInputSchema,
  openPathInputSchema,
  pickDirectoryInputSchema,
  preferredFileAppInputSchema,
  previewOSFileInputSchema,
  readFileForPreviewInputSchema,
  readFileInputSchema,
  renamePathInputSchema,
  revealPathInputSchema,
  saveExportedFileInputSchema,
  trashPathInputSchema,
  writeFileInputSchema,
} from "../../src/lib/desktopSchemas";
import { resolveDesktopBuiltinSkillRootsForReveal } from "../services/desktopBuiltinPaths";
import { isExplorerEntryHidden } from "../services/explorerVisibility";
import { DEFAULT_PREVIEW_MAX_BYTES, readCappedFilePreview } from "../services/filePreviewRead";
import {
  resolveAllowedDirectoryPath,
  resolveAllowedPath,
  resolveAllowedRevealPath,
  resolveAllowedSaveExportSourcePath,
} from "../services/ipcSecurity";
import type { DesktopIpcModuleContext } from "./types";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, clipboard, dialog, shell } = require("electron") as typeof Electron;

export const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_WORKSPACE_UPLOADS_DIR_NAME = "User Uploads";
const MAX_AUTHORIZED_UPLOAD_SOURCES_PER_SENDER = 64;

type UploadAuthorizationOwnerKey = string;
type AuthorizedUploadSource = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};
type AuthorizedUploadSources = Map<
  UploadAuthorizationOwnerKey,
  Map<string, AuthorizedUploadSource>
>;

function uploadAuthorizationOwnerKey(
  event: Electron.IpcMainInvokeEvent,
): UploadAuthorizationOwnerKey {
  const webContentsId = typeof event.sender?.id === "number" ? event.sender.id : "unknown";
  const processId = typeof event.processId === "number" ? event.processId : "unknown";
  const frameId = typeof event.frameId === "number" ? event.frameId : "unknown";
  return `${webContentsId}:${processId}:${frameId}`;
}

function consumeAuthorizedUploadSource(
  authorizedUploadSources: AuthorizedUploadSources,
  ownerKey: UploadAuthorizationOwnerKey,
  sourcePath: string,
): AuthorizedUploadSource | null {
  const ownerSources = authorizedUploadSources.get(ownerKey);
  const source = ownerSources?.get(sourcePath);
  if (!ownerSources || !source) {
    return null;
  }

  ownerSources.delete(sourcePath);
  if (ownerSources.size === 0) {
    authorizedUploadSources.delete(ownerKey);
  }

  return source;
}

function uploadSourceIdentityFromStat(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): AuthorizedUploadSource {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function uploadSourceIdentityMatches(
  expected: AuthorizedUploadSource,
  actual: AuthorizedUploadSource,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

async function readUploadSourceIdentity(sourcePath: string): Promise<AuthorizedUploadSource> {
  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error("Upload source path must not be a symbolic link.");
  }
  if (!sourceStat.isFile()) {
    throw new Error("Upload source path must be a file.");
  }
  return uploadSourceIdentityFromStat(sourceStat);
}

export function registerFilesIpc(context: DesktopIpcModuleContext): void {
  const { handleDesktopInvoke, parseWithSchema, workspaceRoots } = context;

  // Source paths a trusted-renderer file picker (webUtils.getPathForFile) has
  // resolved from a real user-selected File. Authorizations are scoped to the
  // sender frame and consumed on copy so another renderer cannot reuse them.
  const authorizedUploadSources: AuthorizedUploadSources = new Map();
  const rememberAuthorizedUploadSource = async (
    ownerKey: UploadAuthorizationOwnerKey,
    sourcePath: string,
  ): Promise<void> => {
    const resolved = path.resolve(sourcePath);
    const sourceIdentity = await readUploadSourceIdentity(resolved);
    let ownerSources = authorizedUploadSources.get(ownerKey);
    if (!ownerSources) {
      ownerSources = new Map();
      authorizedUploadSources.set(ownerKey, ownerSources);
    }

    ownerSources.delete(resolved);
    ownerSources.set(resolved, sourceIdentity);
    while (ownerSources.size > MAX_AUTHORIZED_UPLOAD_SOURCES_PER_SENDER) {
      const oldest = ownerSources.keys().next().value;
      if (oldest === undefined) break;
      ownerSources.delete(oldest);
    }
  };

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.listDirectory,
    async (_event, args: ListDirectoryInput) => {
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const input = parseWithSchema(listDirectoryInputSchema, args, "listDirectory options");
      // resolveAllowedDirectoryPath also allows the app-managed one-off chats
      // root, so global chat sessions list correctly even with no project roots.
      const safePath = resolveAllowedDirectoryPath(
        workspaceRoots.getApprovedWorkspaceRoots(),
        input.path,
      );

      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const results = await Promise.all(
        entries.map(async (entry) => {
          const isHidden = isExplorerEntryHidden(entry.name);
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
        }),
      );

      return results
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.readFile, async (_event, args: ReadFileInput) => {
    const input = parseWithSchema(readFileInputSchema, args, "readFile options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
    const stat = await fs.stat(safePath);
    if (!stat.isFile()) {
      throw new Error("Path is not a file");
    }
    if (stat.size > MAX_READ_FILE_BYTES) {
      throw new Error(
        `File is too large to read fully (${stat.size} bytes exceeds ${MAX_READ_FILE_BYTES} bytes).`,
      );
    }
    return { content: await fs.readFile(safePath, "utf8") };
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.writeFile, async (_event, args: WriteFileInput) => {
    const input = parseWithSchema(writeFileInputSchema, args, "writeFile options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
    await fs.writeFile(safePath, input.content, "utf8");
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.readFileForPreview,
    async (_event, args: ReadFileForPreviewInput) => {
      const input = parseWithSchema(
        readFileForPreviewInputSchema,
        args,
        "readFileForPreview options",
      );
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
      return await readCappedFilePreview(safePath, input.maxBytes ?? DEFAULT_PREVIEW_MAX_BYTES);
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.getPreferredFileApp,
    async (_event, args: PreferredFileAppInput) => {
      const input = parseWithSchema(
        preferredFileAppInputSchema,
        args,
        "getPreferredFileApp options",
      );
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
      return await resolvePreferredFileAppLabel(safePath);
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.previewOSFile,
    async (event, args: PreviewOSFileInput) => {
      const input = parseWithSchema(previewOSFileInputSchema, args, "previewOSFile options");
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.previewFile(safePath);
      }
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.openPath, async (_event, args: OpenPathInput) => {
    const input = parseWithSchema(openPathInputSchema, args, "openPath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
    const errString = await shell.openPath(safePath);
    if (errString) {
      throw new Error(errString);
    }
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.saveExportedFile,
    async (event, args: SaveExportedFileInput) => {
      const input = parseWithSchema(saveExportedFileInputSchema, args, "saveExportedFile options");
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const safeSourcePath = resolveAllowedSaveExportSourcePath(
        workspaceRoots.getApprovedWorkspaceRoots(),
        input.sourcePath,
      );
      const downloadsPath = (() => {
        try {
          return app.getPath("downloads");
        } catch {
          return os.homedir();
        }
      })();
      const defaultPath = path.join(downloadsPath || os.homedir(), input.defaultFileName);
      const ownerWindow =
        BrowserWindow.fromWebContents(event.sender) ??
        BrowserWindow.getFocusedWindow() ??
        undefined;
      const result = ownerWindow
        ? await dialog.showSaveDialog(ownerWindow, {
            title: "Save research export",
            defaultPath,
          })
        : await dialog.showSaveDialog({
            title: "Save research export",
            defaultPath,
          });

      if (result.canceled || !result.filePath) {
        return null;
      }

      await fs.copyFile(safeSourcePath, result.filePath);
      return result.filePath;
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.pickDirectory,
    async (event, args: PickDirectoryInput) => {
      const input = parseWithSchema(pickDirectoryInputSchema, args ?? {}, "pickDirectory options");
      const ownerWindow =
        BrowserWindow.fromWebContents(event.sender) ??
        BrowserWindow.getFocusedWindow() ??
        undefined;
      const dialogOptions = {
        title: input.title ?? "Select a directory",
        properties: ["openDirectory"] as Array<"openDirectory">,
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled) {
        return null;
      }
      return result.filePaths[0] ?? null;
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.revealPath, async (_event, args: RevealPathInput) => {
    const input = parseWithSchema(revealPathInputSchema, args, "revealPath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const builtinSkillRoots = resolveDesktopBuiltinSkillRootsForReveal();
    const safePath = resolveAllowedRevealPath(
      workspaceRoots.getApprovedWorkspaceRoots(),
      input.path,
      builtinSkillRoots,
    );
    shell.showItemInFolder(safePath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.copyPath, async (_event, args: CopyPathInput) => {
    const input = parseWithSchema(copyPathInputSchema, args, "copyPath options");
    await workspaceRoots.ensureApprovedWorkspaceRoots();
    const safePath = resolveAllowedPath(workspaceRoots.getApprovedWorkspaceRoots(), input.path);
    clipboard.writeText(safePath);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.copyText, async (_event, text: string) => {
    const input = parseWithSchema(copyTextInputSchema, text, "copyText text");
    clipboard.writeText(input);
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.authorizeUploadSource,
    async (event, args: AuthorizeUploadSourceInput) => {
      const input = parseWithSchema(
        authorizeUploadSourceInputSchema,
        args,
        "authorizeUploadSource options",
      );
      await rememberAuthorizedUploadSource(uploadAuthorizationOwnerKey(event), input.sourcePath);
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads,
    async (event, args: CopyFileToWorkspaceUploadsInput) => {
      const input = parseWithSchema(
        copyFileToWorkspaceUploadsInputSchema,
        args,
        "copyFileToWorkspaceUploads options",
      );
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      return await copyFileToWorkspaceUploads(
        workspaceRoots.getApprovedWorkspaceRoots(),
        input,
        authorizedUploadSources,
        uploadAuthorizationOwnerKey(event),
      );
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.createDirectory,
    async (_event, args: CreateDirectoryInput) => {
      const input = parseWithSchema(createDirectoryInputSchema, args, "createDirectory options");
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const roots = workspaceRoots.getApprovedWorkspaceRoots();
      const safeParent = resolveAllowedDirectoryPath(roots, input.parentPath);
      const targetPath = path.join(safeParent, input.name);
      resolveAllowedPath(roots, targetPath);
      await fs.mkdir(targetPath);
    },
  );

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
    } catch (trashError) {
      const trashDetail = trashError instanceof Error ? trashError.message : String(trashError);
      throw new Error(`Unable to move to Trash: ${trashDetail}`);
    }
  });
}

async function copyFileToWorkspaceUploads(
  workspaceRoots: string[],
  input: CopyFileToWorkspaceUploadsInput,
  authorizedUploadSources: AuthorizedUploadSources,
  uploadAuthorizationOwnerKey: UploadAuthorizationOwnerKey,
): Promise<CopyFileToWorkspaceUploadsOutput> {
  const safeWorkspacePath = resolveAllowedDirectoryPath(workspaceRoots, input.workspacePath);
  const sourcePath = path.resolve(input.sourcePath);
  // Fail closed before touching the source: only paths the renderer picker
  // authorized via getPathForFile may be copied. Otherwise an arbitrary path
  // could be read into the workspace and exfiltrated as an attachment.
  const authorizedSource = consumeAuthorizedUploadSource(
    authorizedUploadSources,
    uploadAuthorizationOwnerKey,
    sourcePath,
  );
  if (!authorizedSource) {
    throw new Error(
      "Upload source path is not authorized. Select the file through the desktop file picker.",
    );
  }
  const sourceHandle = await openAuthorizedUploadSource(sourcePath, authorizedSource);
  try {
    const sourceStat = await sourceHandle.stat();
    if (sourceStat.size > MAX_ATTACHMENT_UPLOAD_BYTE_SIZE) {
      throw new Error("File too large to upload (max 100MB)");
    }

    const safeName = path.basename(input.filename);
    if (!safeName || safeName === "." || safeName === "..") {
      throw new Error("Invalid filename");
    }

    const requestedUploadsDir = input.uploadsDirectory
      ? path.resolve(safeWorkspacePath, input.uploadsDirectory)
      : path.resolve(safeWorkspacePath, DEFAULT_WORKSPACE_UPLOADS_DIR_NAME);
    let resolvedUploadsDir: string;
    try {
      resolvedUploadsDir = await resolvePathInsideRootForBoundaryCheck(
        safeWorkspacePath,
        requestedUploadsDir,
      );
    } catch {
      throw new Error("Uploads directory resolves outside the workspace.");
    }

    await fs.mkdir(resolvedUploadsDir, { recursive: true });
    try {
      resolvedUploadsDir = await resolvePathInsideRootForBoundaryCheck(
        safeWorkspacePath,
        resolvedUploadsDir,
      );
    } catch {
      throw new Error("Uploads directory resolves outside the workspace.");
    }

    const ext = path.extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);
    let targetPath = path.resolve(resolvedUploadsDir, safeName);
    if (!isPathInside(resolvedUploadsDir, targetPath)) {
      throw new Error("Invalid filename (path traversal)");
    }

    let counter = 1;
    while (await fileExists(targetPath)) {
      targetPath = path.resolve(resolvedUploadsDir, `${base}_${counter}${ext}`);
      if (!isPathInside(resolvedUploadsDir, targetPath)) {
        throw new Error("Invalid filename (path traversal)");
      }
      counter += 1;
    }

    await fs.writeFile(targetPath, await sourceHandle.readFile(), { flag: "wx" });
    return { filename: path.basename(targetPath), path: targetPath };
  } finally {
    await sourceHandle.close();
  }
}

async function openAuthorizedUploadSource(
  sourcePath: string,
  authorizedSource: AuthorizedUploadSource,
): Promise<FileHandle> {
  const sourceStat = await fs.lstat(sourcePath).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read source file: ${detail}`);
  });
  if (sourceStat.isSymbolicLink()) {
    throw new Error("Upload source path must not be a symbolic link.");
  }
  if (!sourceStat.isFile()) {
    throw new Error("Source path is not a file");
  }
  const currentIdentity = uploadSourceIdentityFromStat(sourceStat);
  if (!uploadSourceIdentityMatches(authorizedSource, currentIdentity)) {
    throw new Error("Upload source file changed after authorization. Select the file again.");
  }

  const sourceHandle = await fs.open(
    sourcePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const openedStat = await sourceHandle.stat();
  if (!openedStat.isFile()) {
    await sourceHandle.close();
    throw new Error("Source path is not a file");
  }
  if (!uploadSourceIdentityMatches(authorizedSource, uploadSourceIdentityFromStat(openedStat))) {
    await sourceHandle.close();
    throw new Error("Upload source file changed after authorization. Select the file again.");
  }
  return sourceHandle;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

type AppCandidate = {
  label: string;
  bundleId: string;
  knownPaths: string[];
};

async function resolvePreferredFileAppLabel(filePath: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;

  const ext = path.extname(filePath).toLowerCase();
  const candidates =
    ext === ".docx" || ext === ".doc"
      ? [
          {
            label: "Word",
            bundleId: "com.microsoft.Word",
            knownPaths: ["/Applications/Microsoft Word.app"],
          },
          {
            label: "Pages",
            bundleId: "com.apple.iWork.Pages",
            knownPaths: ["/Applications/Pages.app"],
          },
        ]
      : ext === ".xlsx" || ext === ".xls"
        ? [
            {
              label: "Excel",
              bundleId: "com.microsoft.Excel",
              knownPaths: ["/Applications/Microsoft Excel.app"],
            },
          ]
        : [];

  for (const candidate of candidates) {
    if (await appCandidateExists(candidate)) return candidate.label;
  }

  return null;
}

async function appCandidateExists(candidate: AppCandidate): Promise<boolean> {
  for (const knownPath of candidate.knownPaths) {
    try {
      await fs.access(knownPath);
      return true;
    } catch {
      // Keep checking.
    }
  }

  try {
    const { stdout } = await execFile("mdfind", [
      `kMDItemCFBundleIdentifier == "${candidate.bundleId}"`,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
