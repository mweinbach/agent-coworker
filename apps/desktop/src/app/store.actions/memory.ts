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
  | "requestWorkspaceMemories"
  | "upsertWorkspaceMemory"
  | "deleteWorkspaceMemory"
  | "requestAdvancedMemories"
  | "upsertAdvancedMemory"
  | "deleteAdvancedMemory"
  | "setWorkspaceAdvancedMemory"
  | "setWorkspaceMemoryGenerationModel"
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

    requestAdvancedMemories: async (workspaceId, opts) => {
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
            advancedMemoriesLoading: true,
          },
        },
      }));

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/memory/advanced/list",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          ...(opts?.folder ? { folder: opts.folder } : {}),
        },
      );
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              advancedMemoriesLoading: false,
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

    upsertAdvancedMemory: async (workspaceId, input, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/memory/advanced/upsert",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          ...(input.folder ? { folder: input.folder } : {}),
          ...(input.slug ? { slug: input.slug } : {}),
          name: input.name,
          description: input.description,
          ...(input.type ? { type: input.type } : {}),
          body: input.body,
        },
      );
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

    deleteAdvancedMemory: async (workspaceId, folder, slug, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/memory/advanced/delete",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          ...(folder ? { folder } : {}),
          slug,
        },
      );
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

    setWorkspaceAdvancedMemory: async (workspaceId, advancedMemory, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      // Capture the prior value so a failed apply can be rolled back. The server
      // is the source of truth; a successful apply re-syncs via session_config.
      const previous = get().workspaces.find((w) => w.id === workspaceId)?.defaultAdvancedMemory;

      // Optimistic update so the toggle reflects immediately.
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, defaultAdvancedMemory: advancedMemory } : w,
        ),
      }));

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: { advancedMemory },
        },
      );
      if (!ok) {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, defaultAdvancedMemory: previous } : w,
          ),
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to update advanced memory setting.",
          }),
        }));
      }
    },

    setWorkspaceMemoryGenerationModel: async (workspaceId, model, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const previous = get().workspaces.find(
        (w) => w.id === workspaceId,
      )?.defaultMemoryGenerationModel;

      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, defaultMemoryGenerationModel: model } : w,
        ),
      }));

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: { memoryGenerationModel: model },
        },
      );
      if (!ok) {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, defaultMemoryGenerationModel: previous } : w,
          ),
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to update memory generation model.",
          }),
        }));
      }
    },
  };
}
