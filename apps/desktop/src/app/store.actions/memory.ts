import type { MemoryScope } from "../../../../../src/memoryStore";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  pushNotification,
  requestJsonRpcControlEvent,
} from "../store.helpers";

export function createWorkspaceMemoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, "requestWorkspaceMemories" | "upsertWorkspaceMemory" | "deleteWorkspaceMemory"> {
  return {
    requestWorkspaceMemories: async (workspaceId: string) => {
      await ensureServerRunning(get, set, workspaceId);
      const socket = ensureControlSocket(get, set, workspaceId);

      const waitingForInitialControlSession =
        Boolean(socket)
        && !get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      if (waitingForInitialControlSession) {
        return;
      }

      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            memoriesLoading: true,
          },
        },
      }));

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/memory/list", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
      });
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              memoriesLoading: false,
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request memories.",
          }),
        }));
      }
    },

    upsertWorkspaceMemory: async (workspaceId, scope, id, content) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/memory/upsert", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        scope,
        ...(id ? { id } : {}),
        content,
      });
      if (ok) return;

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to save memory.",
        }),
      }));
    },

    deleteWorkspaceMemory: async (workspaceId, scope, id) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/memory/delete", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        scope,
        id,
      });
      if (ok) return;

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to delete memory.",
        }),
      }));
    },
  };
}
