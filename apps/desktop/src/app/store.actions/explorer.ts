import { requestCanvasDocumentTransition } from "../../lib/canvasDocumentLifecycle";
import {
  copyPath,
  createDirectory,
  invalidateDirectoryListing,
  isStaleDirectoryListingError,
  listDirectory,
  openPath,
  renamePath,
  revealPath,
  trashPath,
} from "../../lib/desktopCommands";
import { isCanvasSupportedFile } from "../../lib/filePreviewKind";

import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";

let nextExplorerRequestId = 0;

export function createExplorerActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "refreshWorkspaceFiles"
  | "navigateWorkspaceFiles"
  | "navigateWorkspaceFilesUp"
  | "selectWorkspaceFile"
  | "openWorkspaceFile"
  | "revealWorkspaceFile"
  | "copyWorkspaceFilePath"
  | "createWorkspaceDirectory"
  | "renameWorkspacePath"
  | "trashWorkspacePath"
  | "openFilePreview"
  | "closeFilePreview"
  | "setCanvasActiveTab"
  | "setCanvasShowFormattingBar"
  | "setCanvasMaximized"
> {
  const bumpWorkspaceExplorerRefresh = (workspaceId: string) => {
    set((state) => ({
      workspaceExplorerRefreshById: {
        ...state.workspaceExplorerRefreshById,
        [workspaceId]: (state.workspaceExplorerRefreshById[workspaceId] ?? 0) + 1,
      },
    }));
  };

  return {
    openFilePreview: async (opts: { path: string }): Promise<boolean> => {
      const state = get();
      if (state.filePreview?.path === opts.path) {
        return true;
      }
      if (!(await requestCanvasDocumentTransition(opts.path))) {
        return false;
      }
      const canvasEnabled = state.desktopFeatureFlags?.canvas === true;
      const isCanvasSupported = isCanvasSupportedFile(opts.path);
      if (canvasEnabled && isCanvasSupported) {
        set({
          filePreview: { path: opts.path },
          contextSidebarCollapsed: false,
          canvasSidebarWidth: Math.max(state.canvasSidebarWidth, 500),
          isCanvasMaximized: false,
        });
      } else {
        set({ filePreview: { path: opts.path }, isCanvasMaximized: false });
      }
      return true;
    },

    closeFilePreview: async (): Promise<boolean> => {
      if (!(await requestCanvasDocumentTransition(null))) {
        return false;
      }
      set({ filePreview: null, isCanvasMaximized: false });
      return true;
    },

    setCanvasActiveTab: (tab: "preview" | "edit") => {
      set({ canvasActiveTab: tab });
    },

    setCanvasShowFormattingBar: (show: boolean) => {
      set({ canvasShowFormattingBar: show });
    },

    setCanvasMaximized: (maximized: boolean) => {
      set({ isCanvasMaximized: maximized });
    },

    refreshWorkspaceFiles: async (workspaceId: string) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const state = get();
      const currentExp = state.workspaceExplorerById[workspaceId];
      const targetPath = currentExp?.currentPath ?? ws.path;
      invalidateDirectoryListing({ workspaceId, path: targetPath });
      await get().navigateWorkspaceFiles(workspaceId, targetPath);
    },

    navigateWorkspaceFiles: async (workspaceId: string, targetPath: string) => {
      const state = get();
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;

      const requestId = ++nextExplorerRequestId;
      const prev = state.workspaceExplorerById[workspaceId] ?? {
        rootPath: ws.path,
        currentPath: ws.path,
        entries: [],
        selectedPath: null,
        loading: false,
        error: null,
        requestId: 0,
      };

      set((s) => ({
        workspaceExplorerById: {
          ...s.workspaceExplorerById,
          [workspaceId]: {
            ...prev,
            currentPath: targetPath,
            loading: true,
            error: null,
            requestId,
          },
        },
      }));

      try {
        const entries = await listDirectory({
          workspaceId,
          path: targetPath,
          includeHidden: get().showHiddenFiles,
        });
        const current = get().workspaceExplorerById[workspaceId];
        if (current?.requestId !== requestId) return; // Stale

        set((s) => ({
          workspaceExplorerById: {
            ...s.workspaceExplorerById,
            [workspaceId]: {
              ...current,
              entries,
              loading: false,
              selectedPath: null,
            },
          },
        }));
      } catch (err) {
        const current = get().workspaceExplorerById[workspaceId];
        if (current?.requestId !== requestId) return; // Stale
        if (isStaleDirectoryListingError(err)) {
          set((s) => ({
            workspaceExplorerById: {
              ...s.workspaceExplorerById,
              [workspaceId]: {
                ...current,
                loading: false,
                error: null,
              },
            },
          }));
          return;
        }

        set((s) => ({
          workspaceExplorerById: {
            ...s.workspaceExplorerById,
            [workspaceId]: {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        }));
      }
    },

    navigateWorkspaceFilesUp: async (workspaceId: string) => {
      const state = get();
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      const currentPath = state.workspaceExplorerById[workspaceId]?.currentPath;
      if (!ws || !currentPath) return;

      // don't navigate above workspace root
      const normalizedRoot = ws.path.replace(/\\/g, "/").replace(/\/$/, "");
      const normalizedCurrent = currentPath.replace(/\\/g, "/").replace(/\/$/, "");

      if (
        normalizedCurrent === normalizedRoot ||
        normalizedCurrent.length < normalizedRoot.length
      ) {
        return;
      }

      const parts = normalizedCurrent.split("/");
      parts.pop();
      const parent = parts.join("/") || "/";
      await get().navigateWorkspaceFiles(workspaceId, parent);
    },

    selectWorkspaceFile: (workspaceId: string, path: string | null) => {
      set((s) => {
        const current = s.workspaceExplorerById[workspaceId];
        if (!current) return {};
        return {
          workspaceExplorerById: {
            ...s.workspaceExplorerById,
            [workspaceId]: { ...current, selectedPath: path },
          },
        };
      });
    },

    openWorkspaceFile: async (workspaceId: string, targetPath: string, isDirectory: boolean) => {
      if (isDirectory) {
        await get().navigateWorkspaceFiles(workspaceId, targetPath);
      } else if (isCanvasSupportedFile(targetPath)) {
        await get().openFilePreview({ path: targetPath });
      } else {
        await openPath({ path: targetPath });
      }
    },

    revealWorkspaceFile: async (path: string) => {
      await revealPath({ path });
    },

    copyWorkspaceFilePath: async (path: string) => {
      await copyPath({ path });
    },

    createWorkspaceDirectory: async (workspaceId: string, parentPath: string, name: string) => {
      await createDirectory({ parentPath, name });
      invalidateDirectoryListing({ workspaceId, path: parentPath });
      await get().refreshWorkspaceFiles(workspaceId);
      bumpWorkspaceExplorerRefresh(workspaceId);
    },

    renameWorkspacePath: async (workspaceId: string, targetPath: string, newName: string) => {
      await renamePath({ path: targetPath, newName });
      const normalizedTargetPath = targetPath.replace(/\\/g, "/");
      const parentPath =
        normalizedTargetPath.slice(0, normalizedTargetPath.lastIndexOf("/")) || "/";
      const renamedPath = `${parentPath === "/" ? "" : parentPath}/${newName}`;
      invalidateDirectoryListing({ workspaceId, path: parentPath });
      invalidateDirectoryListing({ workspaceId, path: targetPath, recursive: true });
      invalidateDirectoryListing({ workspaceId, path: renamedPath, recursive: true });
      await get().refreshWorkspaceFiles(workspaceId);
      bumpWorkspaceExplorerRefresh(workspaceId);
    },

    trashWorkspacePath: async (workspaceId: string, targetPath: string) => {
      await trashPath({ path: targetPath });
      const normalizedTargetPath = targetPath.replace(/\\/g, "/");
      const parentPath =
        normalizedTargetPath.slice(0, normalizedTargetPath.lastIndexOf("/")) || "/";
      invalidateDirectoryListing({ workspaceId, path: parentPath });
      invalidateDirectoryListing({ workspaceId, path: targetPath, recursive: true });
      await get().refreshWorkspaceFiles(workspaceId);
      bumpWorkspaceExplorerRefresh(workspaceId);
    },
  };
}
