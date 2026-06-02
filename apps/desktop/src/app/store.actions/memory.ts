import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  pushNotification,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";

export function createWorkspaceMemoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  "requestWorkspaceMemories" | "upsertWorkspaceMemory" | "deleteWorkspaceMemory"
> {
  const resolveMemoryCwd = (workspaceId: string, opts?: { cwd?: string }) => {
    const explicit = opts?.cwd?.trim();
    if (explicit) return explicit;
    return get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
  };

  return {
    requestWorkspaceMemories: async (workspaceId: string, opts?: { cwd?: string }) => {
      await ensureServerRunning(get, set, workspaceId);
      const socket = ensureControlSocket(get, set, workspaceId);

      const waitingForInitialControlSession =
        Boolean(socket) && !get().workspaceRuntimeById[workspaceId]?.controlSessionId;
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
        cwd: resolveMemoryCwd(workspaceId, opts),
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

    upsertWorkspaceMemory: async (workspaceId, scope, id, content, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/memory/upsert", {
        cwd: resolveMemoryCwd(workspaceId, opts),
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

    deleteWorkspaceMemory: async (workspaceId, scope, id, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/memory/delete", {
        cwd: resolveMemoryCwd(workspaceId, opts),
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
