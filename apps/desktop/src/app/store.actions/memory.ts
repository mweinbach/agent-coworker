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
  | "requestSkillImprovementStatus"
  | "runSkillImprovement"
  | "restoreSkillImprovement"
  | "setWorkspaceSkillImprovementEnabled"
  | "setWorkspaceSkillImprovementModel"
  | "setWorkspaceSkillImprovementScope"
  | "setWorkspaceSkillImprovementExcludedSkills"
> {
  const resolveMemoryCwd = (workspaceId: string, opts?: { cwd?: string }) => {
    const explicit = opts?.cwd?.trim();
    if (explicit) return explicit;
    return get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
  };

  const normalizeExcludedSkills = (skills: string[]) =>
    [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right),
    );

  const requestSkillImprovementStatusImpl = async (
    workspaceId: string,
    opts?: { cwd?: string },
  ): Promise<void> => {
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          skillImprovementLoading: true,
        },
      },
    }));

    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      "cowork/skills/improvement/status",
      { cwd: resolveMemoryCwd(workspaceId, opts) },
    );
    if (!ok) {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillImprovementLoading: false,
          },
        },
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to request skill improvement status.",
        }),
      }));
    }
  };

  const setSkillImprovementPending = (workspaceId: string, key: string, pending: boolean) => {
    set((s) => {
      const runtime = s.workspaceRuntimeById[workspaceId];
      const current = runtime?.skillImprovementPendingActionKeys ?? {};
      const next = { ...current };
      if (pending) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return {
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...runtime,
            skillImprovementPendingActionKeys: next,
          },
        },
      };
    });
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

    requestSkillImprovementStatus: requestSkillImprovementStatusImpl,

    runSkillImprovement: async (workspaceId, skillName, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const key = skillName ? `run:${skillName}` : "run:queued";
      setSkillImprovementPending(workspaceId, key, true);
      // Snapshot the known history so the toast only reflects entries this
      // request produced — never a background run that happened to finish
      // around the same time.
      const priorStatus = get().workspaceRuntimeById[workspaceId]?.skillImprovementStatus;
      const historyIdsBefore = priorStatus
        ? new Set(priorStatus.runHistory.map((entry) => entry.id))
        : null;
      const requestedAt = Date.now();

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/improvement/run",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          ...(skillName ? { skillName } : {}),
        },
      );
      // The action owns its pending key: status events no longer clear it, so
      // unrelated background broadcasts cannot re-enable the button mid-run.
      setSkillImprovementPending(workspaceId, key, false);
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Unable to improve skill",
            detail: "The skill improvement run could not be started.",
          }),
        }));
        return false;
      }
      // The run result already refreshed skillImprovementStatus in the store,
      // so report what actually happened instead of assuming success.
      const outcome = latestRunOutcome(get, workspaceId, historyIdsBefore, requestedAt, skillName);
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: outcome?.status === "failed" ? "error" : "info",
          title: !outcome
            ? "No skill improvements were due"
            : outcome.status === "failed"
              ? "Skill improvement failed"
              : outcome.status === "skipped"
                ? "Skill improvement finished without changes"
                : "Skill improvement complete",
          detail: outcome
            ? `${outcome.skillName}: ${outcome.message}`
            : "No queued skill improvement jobs were due.",
        }),
      }));
      return true;
    },

    restoreSkillImprovement: async (workspaceId, skillName, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const key = `restore:${skillName}`;
      setSkillImprovementPending(workspaceId, key, true);
      const errorDetail: { message?: string } = {};

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/improvement/restore",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          skillName,
        },
        errorDetail,
      );
      setSkillImprovementPending(workspaceId, key, false);
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Unable to restore skill",
            detail: errorDetail.message ?? `${skillName} could not be restored from backup.`,
          }),
        }));
        return false;
      }
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Skill restored",
          detail: `${skillName} was restored from backup.`,
        }),
      }));
      return true;
    },

    setWorkspaceSkillImprovementEnabled: async (workspaceId, enabled, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const restore = applyOptimisticMemoryConfig(get, set, workspaceId, {
        record: { defaultSkillImprovementEnabled: enabled },
        sessionConfig: { skillImprovementEnabled: enabled },
      });

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: { skillImprovementEnabled: enabled },
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
            detail: "Unable to update skill improvement setting.",
          }),
        }));
        return;
      }
      await syncAdvancedMemoryDefaultsAcrossThreads(get);
      await requestSkillImprovementStatusImpl(workspaceId, opts);
    },

    setWorkspaceSkillImprovementModel: async (workspaceId, model, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const modelOverride = model.trim() || undefined;

      const restore = applyOptimisticMemoryConfig(get, set, workspaceId, {
        record: { defaultSkillImprovementModel: modelOverride },
        sessionConfig: { skillImprovementModel: modelOverride },
      });

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: modelOverride
            ? { skillImprovementModel: modelOverride }
            : { clearSkillImprovementModel: true },
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
            detail: "Unable to update skill improvement model.",
          }),
        }));
        return;
      }
      await syncAdvancedMemoryDefaultsAcrossThreads(get);
      await requestSkillImprovementStatusImpl(workspaceId, opts);
    },

    setWorkspaceSkillImprovementScope: async (workspaceId, scope, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const restore = applyOptimisticMemoryConfig(get, set, workspaceId, {
        record: { defaultSkillImprovementScope: scope },
        sessionConfig: { skillImprovementScope: scope },
      });

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: { skillImprovementScope: scope },
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
            detail: "Unable to update skill improvement scope.",
          }),
        }));
        return;
      }
      await syncAdvancedMemoryDefaultsAcrossThreads(get);
      await requestSkillImprovementStatusImpl(workspaceId, opts);
    },

    setWorkspaceSkillImprovementExcludedSkills: async (workspaceId, excludedSkills, opts) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const normalized = normalizeExcludedSkills(excludedSkills);

      const restore = applyOptimisticMemoryConfig(get, set, workspaceId, {
        record: { defaultSkillImprovementExcludedSkills: normalized },
        sessionConfig: { skillImprovementExcludedSkills: normalized },
      });

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/session/defaults/apply",
        {
          cwd: resolveMemoryCwd(workspaceId, opts),
          config: { skillImprovementExcludedSkills: normalized },
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
            detail: "Unable to update excluded skills.",
          }),
        }));
        return;
      }
      await syncAdvancedMemoryDefaultsAcrossThreads(get);
      await requestSkillImprovementStatusImpl(workspaceId, opts);
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
      defaultSkillImprovementEnabled: boolean;
      defaultSkillImprovementModel: string | undefined;
      defaultSkillImprovementScope: "user" | "all";
      defaultSkillImprovementExcludedSkills: string[];
    }>;
    sessionConfig: Partial<{
      advancedMemory: boolean;
      memoryGenerationModel: string | undefined;
      skillImprovementEnabled: boolean;
      skillImprovementModel: string | undefined;
      skillImprovementScope: "user" | "all";
      skillImprovementExcludedSkills: string[];
    }>;
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

function latestRunOutcome(
  get: StoreGet,
  workspaceId: string,
  historyIdsBefore: Set<string> | null,
  requestedAtMs: number,
  skillName?: string,
): { skillName: string; status: "completed" | "failed" | "skipped"; message: string } | null {
  const history = get().workspaceRuntimeById[workspaceId]?.skillImprovementStatus?.runHistory ?? [];
  const entry = history.find((candidate) => {
    if (skillName && candidate.skillName !== skillName) return false;
    // With a pre-request snapshot, only entries this request added count — a
    // background run finishing just before the click must not be mislabeled
    // as the manual action. Without a snapshot, require the entry to have
    // finished after the request started (no backwards skew allowance).
    return historyIdsBefore
      ? !historyIdsBefore.has(candidate.id)
      : new Date(candidate.finishedAt).getTime() >= requestedAtMs;
  });
  return entry
    ? { skillName: entry.skillName, status: entry.status, message: entry.message }
    : null;
}

async function syncAdvancedMemoryDefaultsAcrossThreads(get: StoreGet): Promise<void> {
  const state = get();
  const threadIds = state.threads.map((thread) => thread.id);
  for (const threadId of threadIds) {
    await state.applyWorkspaceDefaultsToThread(threadId, "explicit");
  }
}

function applySessionConfigMemoryPatch<
  T extends {
    advancedMemory?: boolean;
    memoryGenerationModel?: string;
    skillImprovementEnabled?: boolean;
    skillImprovementModel?: string;
    skillImprovementScope?: "user" | "all";
    skillImprovementExcludedSkills?: string[];
  },
>(
  current: T,
  patch: Partial<{
    advancedMemory: boolean;
    memoryGenerationModel: string | undefined;
    skillImprovementEnabled: boolean;
    skillImprovementModel: string | undefined;
    skillImprovementScope: "user" | "all";
    skillImprovementExcludedSkills: string[];
  }>,
): T {
  const next = { ...current, ...patch };
  if (Object.hasOwn(patch, "memoryGenerationModel") && patch.memoryGenerationModel === undefined) {
    delete next.memoryGenerationModel;
  }
  if (Object.hasOwn(patch, "skillImprovementModel") && patch.skillImprovementModel === undefined) {
    delete next.skillImprovementModel;
  }
  return next;
}
