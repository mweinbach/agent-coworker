import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

export function createExplorerActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "refreshWorkspaceFiles" | "navigateWorkspaceFiles" | "navigateWorkspaceFilesUp" | "selectWorkspaceFile" | "openWorkspaceFile" | "revealWorkspaceFile" | "copyWorkspaceFilePath" | "createWorkspaceDirectory" | "renameWorkspacePath" | "trashWorkspacePath"> {
  return {
    refreshWorkspaceFiles: async (workspaceId: string) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const state = get();
      const currentExp = state.workspaceExplorerById[workspaceId];
      const targetPath = currentExp?.currentPath ?? ws.path;
      await get().navigateWorkspaceFiles(workspaceId, targetPath);
    },


    navigateWorkspaceFiles: async (workspaceId: string, targetPath: string) => {
      const state = get();
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;

      const requestId = Date.now();
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
          [workspaceId]: { ...prev, currentPath: targetPath, loading: true, error: null, requestId },
        },
      }));

      try {
        const entries = await listDirectory({ path: targetPath, includeHidden: get().showHiddenFiles });
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
      
      if (normalizedCurrent === normalizedRoot || normalizedCurrent.length < normalizedRoot.length) {
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
      await get().refreshWorkspaceFiles(workspaceId);
    },


    renameWorkspacePath: async (workspaceId: string, targetPath: string, newName: string) => {
      await renamePath({ path: targetPath, newName });
      await get().refreshWorkspaceFiles(workspaceId);
    },


    trashWorkspacePath: async (workspaceId: string, targetPath: string) => {
      await trashPath({ path: targetPath });
      await get().refreshWorkspaceFiles(workspaceId);
    },
  };
}
