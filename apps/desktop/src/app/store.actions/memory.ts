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
  | "generateAdvancedMemoryForThread"
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
        opts?.folder ? "cowork/memory/advanced/folder/list" : "cowork/memory/advanced/list",
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
        input.folder ? "cowork/memory/advanced/folder/upsert" : "cowork/memory/advanced/upsert",
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
      if (ok) return true;

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to save memory.",
        }),
      }));
      return false;
    },

    deleteAdvancedMemory: async (workspaceId, folder, slug, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        folder ? "cowork/memory/advanced/folder/delete" : "cowork/memory/advanced/delete",
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

    generateAdvancedMemoryForThread: async (workspaceId, threadId, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        opts?.folder ? "cowork/memory/advanced/folder/generate" : "cowork/memory/advanced/generate",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          ...(opts?.folder ? { folder: opts.folder } : {}),
          threadId,
        },
      );

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: ok ? "info" : "error",
          title: ok ? "Memory generated" : "Unable to generate memory",
          detail: ok
            ? "The conversation was processed for advanced memory."
            : "The conversation could not be processed.",
        }),
      }));
      return ok;
    },

    setWorkspaceAdvancedMemory: async (workspaceId, advancedMemory, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      // The settings UI reads the live `controlSessionConfig` first (server's
      // effective value), then falls back to the persisted workspace records.
      // Advanced memory defaults are global, so mirror BOTH everywhere
      // optimistically and capture prior values for rollback. The server
      // re-syncs via the subsequent `session_config` event.
      const restore = applyOptimisticMemoryConfig(get, set, workspaceId, {
        record: { defaultAdvancedMemory: advancedMemory },
        sessionConfig: { advancedMemory },
      });

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
        restore();
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to update advanced memory setting.",
          }),
        }));
        return;
      }
      await syncAdvancedMemoryDefaultsAcrossThreads(get);
    },

    setWorkspaceMemoryGenerationModel: async (workspaceId, model, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const modelOverride = model.trim() || undefined;

      const restore = applyOptimisticMemoryConfig(get, set, workspaceId, {
        record: { defaultMemoryGenerationModel: modelOverride },
        sessionConfig: { memoryGenerationModel: modelOverride },
      });

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: modelOverride
            ? { memoryGenerationModel: modelOverride }
            : { clearMemoryGenerationModel: true },
        },
      );
      if (!ok) {
        restore();
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to update memory generation model.",
          }),
        }));
        return;
      }
      await syncAdvancedMemoryDefaultsAcrossThreads(get);
    },
  };
}

/**
 * Optimistically patch the workspace record and the live control-session config
 * (when present) for memory settings, returning a `restore()` that rolls both
 * back to their prior values on failure.
 */
function applyOptimisticMemoryConfig(
  get: StoreGet,
  set: StoreSet,
  _workspaceId: string,
  patch: {
    record: Partial<{
      defaultAdvancedMemory: boolean;
      defaultMemoryGenerationModel: string | undefined;
    }>;
    sessionConfig: Partial<{ advancedMemory: boolean; memoryGenerationModel: string | undefined }>;
  },
): () => void {
  const state = get();
  const recordKeys = Object.keys(patch.record);
  const prevRecordsByWorkspaceId = new Map<string, Record<string, unknown>>();
  for (const workspace of state.workspaces) {
    const prevRecord: Record<string, unknown> = {};
    for (const key of recordKeys) {
      prevRecord[key] = (workspace as Record<string, unknown>)[key];
    }
    prevRecordsByWorkspaceId.set(workspace.id, prevRecord);
  }
  const prevSessionConfigByWorkspaceId = new Map<string, unknown>();
  for (const [runtimeWorkspaceId, runtime] of Object.entries(state.workspaceRuntimeById)) {
    prevSessionConfigByWorkspaceId.set(runtimeWorkspaceId, runtime?.controlSessionConfig ?? null);
  }

  set((s) => ({
    workspaces: s.workspaces.map((w) => ({ ...w, ...patch.record })),
    workspaceRuntimeById: Object.fromEntries(
      Object.entries(s.workspaceRuntimeById).map(([runtimeWorkspaceId, runtime]) => [
        runtimeWorkspaceId,
        {
          ...runtime,
          controlSessionConfig: runtime?.controlSessionConfig
            ? applySessionConfigMemoryPatch(runtime.controlSessionConfig, patch.sessionConfig)
            : (runtime?.controlSessionConfig ?? null),
        },
      ]),
    ) as typeof s.workspaceRuntimeById,
  }));

  return () => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        ...(prevRecordsByWorkspaceId.get(w.id) ?? {}),
      })),
      workspaceRuntimeById: Object.fromEntries(
        Object.entries(s.workspaceRuntimeById).map(([runtimeWorkspaceId, runtime]) => [
          runtimeWorkspaceId,
          {
            ...runtime,
            controlSessionConfig:
              prevSessionConfigByWorkspaceId.get(runtimeWorkspaceId) ??
              runtime?.controlSessionConfig ??
              null,
          },
        ]),
      ) as typeof s.workspaceRuntimeById,
    }));
  };
}

async function syncAdvancedMemoryDefaultsAcrossThreads(get: StoreGet): Promise<void> {
  const state = get();
  const threadIds = state.threads.map((thread) => thread.id);
  for (const threadId of threadIds) {
    await state.applyWorkspaceDefaultsToThread(threadId, "explicit");
  }
}

function applySessionConfigMemoryPatch<
  T extends { advancedMemory?: boolean; memoryGenerationModel?: string },
>(
  current: T,
  patch: Partial<{ advancedMemory: boolean; memoryGenerationModel: string | undefined }>,
): T {
  const next = { ...current, ...patch };
  if (Object.hasOwn(patch, "memoryGenerationModel") && patch.memoryGenerationModel === undefined) {
    delete next.memoryGenerationModel;
  }
  return next;
}
