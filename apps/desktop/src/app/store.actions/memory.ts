import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  operationKey,
  pushNotification,
  requestJsonRpcControlEvent,
  runAcknowledgedOperation,
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
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "save", workspaceId),
        label: "Save memory",
        errorTitle: "Memory not saved",
        errorMessage: "Unable to save memory.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const rpcError: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/memory/upsert",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              scope,
              ...(id ? { id } : {}),
              content,
            },
            rpcError,
          );
          if (!ok) {
            throw new Error(rpcError.message?.trim() || "Unable to save memory.");
          }
        },
      });
    },

    deleteWorkspaceMemory: async (workspaceId, scope, id, opts) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "delete", workspaceId, scope, id),
        label: "Delete memory",
        errorTitle: "Memory not deleted",
        errorMessage: "Unable to delete memory.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const rpcError: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/memory/delete",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              scope,
              id,
            },
            rpcError,
          );
          if (!ok) {
            throw new Error(rpcError.message?.trim() || "Unable to delete memory.");
          }
        },
      });
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
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "advanced-save", workspaceId),
        label: "Save advanced memory",
        errorTitle: "Memory not saved",
        errorMessage: "Unable to save memory.",
        repairAction: "Review the memory fields and retry.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const rpcError: { message?: string } = {};
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
            rpcError,
          );
          if (!ok) {
            throw new Error(rpcError.message?.trim() || "Unable to save memory.");
          }
        },
      });
    },

    deleteAdvancedMemory: async (workspaceId, folder, slug, opts) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "advanced-delete", workspaceId, folder, slug),
        label: "Delete advanced memory",
        errorTitle: "Memory not deleted",
        errorMessage: "Unable to delete memory.",
        repairAction: "Confirm the memory still exists and retry.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const rpcError: { message?: string } = {};
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
            rpcError,
          );
          if (!ok) {
            throw new Error(rpcError.message?.trim() || "Unable to delete memory.");
          }
        },
      });
    },

    generateAdvancedMemoryForThread: async (workspaceId, threadId, opts) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "advanced-generate", workspaceId, opts?.folder, threadId),
        label: "Generate advanced memory",
        errorTitle: "Unable to generate memory",
        errorMessage: "The conversation could not be processed.",
        repairAction: "Confirm the conversation is available and retry.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const errorDetail: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            opts?.folder
              ? "cowork/memory/advanced/folder/generate"
              : "cowork/memory/advanced/generate",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              ...(opts?.folder ? { folder: opts.folder } : {}),
              threadId,
            },
            errorDetail,
          );
          if (!ok) {
            throw new Error(
              errorDetail.message?.trim() || "The conversation could not be processed.",
            );
          }
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "info",
              title: "Memory generated",
              detail: "The conversation was processed for advanced memory.",
              audience: "foreground",
            }),
          }));
        },
      });
    },

    setWorkspaceAdvancedMemory: async (workspaceId, advancedMemory, opts) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "advanced", workspaceId),
        label: "Update advanced memory",
        errorTitle: "Advanced memory not updated",
        errorMessage: "Unable to update advanced memory setting.",
        optimistic: () =>
          applyOptimisticMemoryConfig(get, set, workspaceId, {
            record: { defaultAdvancedMemory: advancedMemory },
            sessionConfig: { advancedMemory },
          }),
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const rpcError: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/session/defaults/apply",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              config: { advancedMemory },
            },
            rpcError,
          );
          if (!ok) {
            throw new Error(
              rpcError.message?.trim() || "Unable to update advanced memory setting.",
            );
          }
          await syncAdvancedMemoryDefaultsAcrossThreads(get);
        },
      });
    },

    setWorkspaceMemoryGenerationModel: async (workspaceId, model, opts) => {
      const modelOverride = model.trim() || undefined;
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("memory", "model", workspaceId),
        label: "Update memory model",
        errorTitle: "Memory model not updated",
        errorMessage: "Unable to update memory generation model.",
        optimistic: () =>
          applyOptimisticMemoryConfig(get, set, workspaceId, {
            record: { defaultMemoryGenerationModel: modelOverride },
            sessionConfig: { memoryGenerationModel: modelOverride },
          }),
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const rpcError: { message?: string } = {};
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
            rpcError,
          );
          if (!ok) {
            throw new Error(
              rpcError.message?.trim() || "Unable to update memory generation model.",
            );
          }
          await syncAdvancedMemoryDefaultsAcrossThreads(get);
        },
      });
    },

    requestSkillImprovementStatus: requestSkillImprovementStatusImpl,

    runSkillImprovement: async (workspaceId, skillName, opts) => {
      const key = skillName ? `run:${skillName}` : "run:queued";
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill-improvement", "run", workspaceId, skillName ?? "queued"),
        label: skillName ? `Improve ${skillName}` : "Run queued skill improvements",
        errorTitle: "Unable to improve skill",
        errorMessage: "The skill improvement run could not be started.",
        repairAction: "Confirm the selected model is available and retry.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          setSkillImprovementPending(workspaceId, key, true);
          // Snapshot known history so this operation never claims a background
          // outcome that happened to arrive around the same time.
          const priorStatus = get().workspaceRuntimeById[workspaceId]?.skillImprovementStatus;
          const historyIdsBefore = priorStatus
            ? new Set(priorStatus.runHistory.map((entry) => entry.id))
            : null;
          const requestedAt = Date.now();
          const errorDetail: { message?: string } = {};
          try {
            const ok = await requestJsonRpcControlEvent(
              get,
              set,
              workspaceId,
              "cowork/skills/improvement/run",
              {
                cwd: resolveMemoryCwd(workspaceId, opts),
                ...(skillName ? { skillName } : {}),
              },
              errorDetail,
            );
            if (!ok) {
              throw new Error(
                errorDetail.message?.trim() || "The skill improvement run could not be started.",
              );
            }
            const outcome = latestRunOutcome(
              get,
              workspaceId,
              historyIdsBefore,
              requestedAt,
              skillName,
            );
            if (outcome?.status === "failed") {
              throw new Error(`${outcome.skillName}: ${outcome.message}`);
            }
            set((s) => ({
              notifications: pushNotification(s.notifications, {
                id: makeId(),
                ts: nowIso(),
                kind: "info",
                title: !outcome
                  ? "No skill improvements were due"
                  : outcome.status === "skipped"
                    ? "Skill improvement finished without changes"
                    : "Skill improvement complete",
                detail: outcome
                  ? `${outcome.skillName}: ${outcome.message}`
                  : "No queued skill improvement jobs were due.",
                audience: "foreground",
              }),
            }));
          } finally {
            // This request owns its pending key; unrelated status events cannot
            // re-enable the action while it remains in flight.
            setSkillImprovementPending(workspaceId, key, false);
          }
        },
      });
    },

    restoreSkillImprovement: async (workspaceId, skillName, opts) => {
      const key = `restore:${skillName}`;
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill-improvement", "restore", workspaceId, skillName),
        label: `Restore ${skillName}`,
        errorTitle: "Unable to restore skill",
        errorMessage: `${skillName} could not be restored from backup.`,
        repairAction: "Confirm a backup exists for this skill and retry.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          setSkillImprovementPending(workspaceId, key, true);
          const errorDetail: { message?: string } = {};
          try {
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
            if (!ok) {
              throw new Error(
                errorDetail.message?.trim() || `${skillName} could not be restored from backup.`,
              );
            }
            set((s) => ({
              notifications: pushNotification(s.notifications, {
                id: makeId(),
                ts: nowIso(),
                kind: "info",
                title: "Skill restored",
                detail: `${skillName} was restored from backup.`,
                audience: "foreground",
              }),
            }));
          } finally {
            setSkillImprovementPending(workspaceId, key, false);
          }
        },
      });
    },

    setWorkspaceSkillImprovementEnabled: async (workspaceId, enabled, opts) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill-improvement", "enabled", workspaceId),
        label: "Update skill improvement",
        errorTitle: "Skill improvement setting not updated",
        errorMessage: "Unable to update skill improvement setting.",
        optimistic: () =>
          applyOptimisticMemoryConfig(get, set, workspaceId, {
            record: { defaultSkillImprovementEnabled: enabled },
            sessionConfig: { skillImprovementEnabled: enabled },
          }),
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const errorDetail: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/session/defaults/apply",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              config: { skillImprovementEnabled: enabled },
            },
            errorDetail,
          );
          if (!ok) {
            throw new Error(
              errorDetail.message?.trim() || "Unable to update skill improvement setting.",
            );
          }
          await syncAdvancedMemoryDefaultsAcrossThreads(get);
          await requestSkillImprovementStatusImpl(workspaceId, opts);
        },
      });
    },

    setWorkspaceSkillImprovementModel: async (workspaceId, model, opts) => {
      const modelOverride = model.trim() || undefined;
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill-improvement", "model", workspaceId),
        label: "Update skill improvement model",
        errorTitle: "Skill improvement model not updated",
        errorMessage: "Unable to update skill improvement model.",
        optimistic: () =>
          applyOptimisticMemoryConfig(get, set, workspaceId, {
            record: { defaultSkillImprovementModel: modelOverride },
            sessionConfig: { skillImprovementModel: modelOverride },
          }),
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const errorDetail: { message?: string } = {};
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
            errorDetail,
          );
          if (!ok) {
            throw new Error(
              errorDetail.message?.trim() || "Unable to update skill improvement model.",
            );
          }
          await syncAdvancedMemoryDefaultsAcrossThreads(get);
          await requestSkillImprovementStatusImpl(workspaceId, opts);
        },
      });
    },

    setWorkspaceSkillImprovementScope: async (workspaceId, scope, opts) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill-improvement", "scope", workspaceId),
        label: "Update skill improvement scope",
        errorTitle: "Skill improvement scope not updated",
        errorMessage: "Unable to update skill improvement scope.",
        optimistic: () =>
          applyOptimisticMemoryConfig(get, set, workspaceId, {
            record: { defaultSkillImprovementScope: scope },
            sessionConfig: { skillImprovementScope: scope },
          }),
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const errorDetail: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/session/defaults/apply",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              config: { skillImprovementScope: scope },
            },
            errorDetail,
          );
          if (!ok) {
            throw new Error(
              errorDetail.message?.trim() || "Unable to update skill improvement scope.",
            );
          }
          await syncAdvancedMemoryDefaultsAcrossThreads(get);
          await requestSkillImprovementStatusImpl(workspaceId, opts);
        },
      });
    },

    setWorkspaceSkillImprovementExcludedSkills: async (workspaceId, excludedSkills, opts) => {
      const normalized = normalizeExcludedSkills(excludedSkills);
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill-improvement", "excluded-skills", workspaceId),
        label: "Update included skills",
        errorTitle: "Included skills not updated",
        errorMessage: "Unable to update included skills.",
        optimistic: () =>
          applyOptimisticMemoryConfig(get, set, workspaceId, {
            record: { defaultSkillImprovementExcludedSkills: normalized },
            sessionConfig: { skillImprovementExcludedSkills: normalized },
          }),
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const errorDetail: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/session/defaults/apply",
            {
              cwd: resolveMemoryCwd(workspaceId, opts),
              config: { skillImprovementExcludedSkills: normalized },
            },
            errorDetail,
          );
          if (!ok) {
            throw new Error(errorDetail.message?.trim() || "Unable to update included skills.");
          }
          await syncAdvancedMemoryDefaultsAcrossThreads(get);
          await requestSkillImprovementStatusImpl(workspaceId, opts);
        },
      });
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
