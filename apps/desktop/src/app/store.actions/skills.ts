import { resolvePluginManagementWorkspaceId } from "../pluginManagement";
import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  pushNotification,
  RUNTIME,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
  syncDesktopStateCache,
} from "../store.helpers";
import {
  clearFailedMutationSend,
  managementWorkspaceIdFor,
  mutationPendingKey,
  refreshSharedWorkspaceState as refreshSharedWorkspaceStateFor,
  setMutationPending,
  workspacePathFor,
} from "./skillPluginHelpers";

export function createSkillActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "openSkills"
  | "refreshSkillsCatalog"
  | "selectSkill"
  | "selectSkillInstallation"
  | "previewSkillInstall"
  | "installSkills"
  | "disableSkill"
  | "enableSkill"
  | "deleteSkill"
  | "disableSkillInstallation"
  | "enableSkillInstallation"
  | "deleteSkillInstallation"
  | "copySkillInstallation"
  | "checkSkillInstallationUpdate"
  | "updateSkillInstallation"
> {
  const workspacePath = (workspaceId: string): string | undefined =>
    workspacePathFor(get, workspaceId);
  const managementWorkspaceId = (): string | null => managementWorkspaceIdFor(get);
  const resolveInstallationScopeForMutation = (
    workspaceId: string,
    installationId: string,
  ): string | null => {
    const catalog = get().workspaceRuntimeById[workspaceId]?.skillsCatalog;
    return (
      catalog?.installations.find((installation) => installation.installationId === installationId)
        ?.scope ?? null
    );
  };
  const refreshSharedWorkspaceState = async (sourceWorkspaceId: string) =>
    await refreshSharedWorkspaceStateFor(get, set, sourceWorkspaceId);

  return {
    openSkills: async () => {
      let workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        if (get().desktopFeatureFlags.workspaceLifecycle === false) {
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "info",
              title: "Workspace management is disabled",
              detail:
                "Enable Workspace lifecycle actions in Settings -> Feature Flags to add a workspace.",
            }),
          }));
          return;
        }
        await get().addWorkspace();
        workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
        if (!workspaceId) {
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "info",
              title: "Skills need a workspace",
              detail: "Add or select a workspace first.",
            }),
          }));
          return;
        }
      }

      const targetWorkspaceId =
        resolvePluginManagementWorkspaceId(
          get().workspaces ?? [],
          get().pluginManagementWorkspaceId,
        ) ?? workspaceId;

      set({ view: "skills", selectedWorkspaceId: workspaceId });
      syncDesktopStateCache(get);
      ensureWorkspaceRuntime(get, set, targetWorkspaceId);
      await ensureServerRunning(get, set, targetWorkspaceId);
      ensureControlSocket(get, set, targetWorkspaceId);
      await Promise.all([get().refreshPluginsCatalog(), get().refreshSkillsCatalog()]);
    },

    refreshSkillsCatalog: async () => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillCatalogLoading: true,
            skillCatalogError: null,
          },
        },
      }));
      const [catalogResult, listResult] = await Promise.allSettled([
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/catalog/read", { cwd }),
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/list", { cwd }),
      ]);
      const okCatalog = catalogResult.status === "fulfilled" && catalogResult.value;
      const okList = listResult.status === "fulfilled" && listResult.value;
      if (!(okCatalog && okList)) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              skillCatalogLoading: false,
              skillCatalogError: "Unable to refresh skills catalog.",
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to refresh skills catalog.",
          }),
        }));
      }
    },

    selectSkill: async (skillName: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedSkillName: skillName,
            selectedSkillContent: null,
            selectedSkillInstallationId: null,
            selectedSkillInstallation: null,
            selectedSkillPreview: null,
          },
        },
      }));
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/read", {
        cwd,
        skillName,
      });
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              selectedSkillName: null,
            },
          },
        }));
      }
    },

    selectSkillInstallation: async (installationId: string | null) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      if (installationId === null) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              selectedSkillInstallationId: null,
              selectedSkillInstallation: null,
              selectedSkillName: null,
              selectedSkillContent: null,
              selectedSkillPreview: null,
            },
          },
        }));
        return;
      }
      const cwd = workspacePath(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedSkillInstallationId: installationId,
            selectedSkillInstallation: null,
            selectedSkillName: null,
            selectedSkillContent: null,
            selectedSkillPreview: null,
          },
        },
      }));
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/read",
        { cwd, installationId },
      );
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              selectedSkillInstallationId: null,
            },
          },
        }));
      }
    },

    previewSkillInstall: async (sourceInput: string, targetScope: "project" | "global") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const key = mutationPendingKey("preview");
      setMutationPending(set, workspaceId, "skill", key);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/install/preview",
        { cwd, sourceInput, targetScope },
      );
      if (!ok) {
        const detail = "Unable to preview skill install.";
        clearFailedMutationSend(set, workspaceId, key, detail, { skillMutationError: detail });
      }
    },

    installSkills: async (sourceInput: string, targetScope: "project" | "global") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }
      const cwd = workspacePath(workspaceId);
      const key = mutationPendingKey(`install:${targetScope}`);
      setMutationPending(set, workspaceId, "skill", key);
      const existing = RUNTIME.skillInstallWaiters.get(workspaceId);
      const installPromise = Promise.withResolvers<void>();
      RUNTIME.skillInstallWaiters.set(workspaceId, {
        pendingKey: key,
        resolve: installPromise.resolve,
        reject: installPromise.reject,
      });

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/install", {
        cwd,
        sourceInput,
        targetScope,
      });
      if (!ok) {
        const detail = "Unable to install skills.";
        if (existing) {
          RUNTIME.skillInstallWaiters.set(workspaceId, existing);
        } else {
          RUNTIME.skillInstallWaiters.delete(workspaceId);
        }
        clearFailedMutationSend(set, workspaceId, key, detail, { skillMutationError: detail });
        installPromise.reject(new Error(detail));
      } else if (existing) {
        existing.reject(new Error("Another skill install was started"));
      }

      const result = await installPromise.promise;
      if (targetScope === "global") {
        await refreshSharedWorkspaceState(workspaceId);
      }
      return result;
    },

    disableSkill: async (skillName: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/disable", {
        cwd,
        skillName,
      });
      if (!ok) {
        const detail = "Unable to disable skill.";
        clearFailedMutationSend(
          set,
          workspaceId,
          mutationPendingKey("disable", skillName),
          detail,
          {
            skillMutationError: detail,
          },
        );
      }
    },

    enableSkill: async (skillName: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/enable", {
        cwd,
        skillName,
      });
      if (!ok) {
        const detail = "Unable to enable skill.";
        clearFailedMutationSend(set, workspaceId, mutationPendingKey("enable", skillName), detail, {
          skillMutationError: detail,
        });
      }
    },

    deleteSkill: async (skillName: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/delete", {
        cwd,
        skillName,
      });
      if (!ok) {
        const detail = "Unable to delete skill.";
        clearFailedMutationSend(set, workspaceId, mutationPendingKey("delete", skillName), detail, {
          skillMutationError: detail,
        });
      }
    },

    disableSkillInstallation: async (installationId: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const installationScope = resolveInstallationScopeForMutation(workspaceId, installationId);
      const key = mutationPendingKey("disable", installationId);
      setMutationPending(set, workspaceId, "skill", key);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/disable",
        { cwd, installationId },
      );
      if (!ok) {
        clearFailedMutationSend(set, workspaceId, key, "Unable to disable skill installation.");
      } else if (installationScope === "global") {
        await refreshSharedWorkspaceState(workspaceId);
      }
    },

    enableSkillInstallation: async (installationId: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const installationScope = resolveInstallationScopeForMutation(workspaceId, installationId);
      const key = mutationPendingKey("enable", installationId);
      setMutationPending(set, workspaceId, "skill", key);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/enable",
        { cwd, installationId },
      );
      if (!ok) {
        clearFailedMutationSend(set, workspaceId, key, "Unable to enable skill installation.");
      } else if (installationScope === "global") {
        await refreshSharedWorkspaceState(workspaceId);
      }
    },

    deleteSkillInstallation: async (installationId: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const installationScope = resolveInstallationScopeForMutation(workspaceId, installationId);
      const key = mutationPendingKey("delete", installationId);
      setMutationPending(set, workspaceId, "skill", key);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/delete",
        { cwd, installationId },
      );
      if (!ok) {
        clearFailedMutationSend(set, workspaceId, key, "Unable to delete skill installation.");
      } else if (installationScope === "global") {
        await refreshSharedWorkspaceState(workspaceId);
      }
    },

    copySkillInstallation: async (installationId: string, targetScope: "project" | "global") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const key = mutationPendingKey(`copy:${targetScope}`, installationId);
      setMutationPending(set, workspaceId, "skill", key);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/copy",
        { cwd, installationId, targetScope },
      );
      if (!ok) {
        clearFailedMutationSend(set, workspaceId, key, "Unable to copy skill installation.");
      } else if (targetScope === "global") {
        await refreshSharedWorkspaceState(workspaceId);
      }
    },

    checkSkillInstallationUpdate: async (installationId: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/checkUpdate",
        { cwd, installationId },
      );
      if (!ok) return;
    },

    updateSkillInstallation: async (installationId: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const installationScope = resolveInstallationScopeForMutation(workspaceId, installationId);
      const key = mutationPendingKey("update", installationId);
      setMutationPending(set, workspaceId, "skill", key);
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/installation/update",
        { cwd, installationId },
      );
      if (!ok) {
        clearFailedMutationSend(set, workspaceId, key, "Unable to update skill installation.");
      } else if (installationScope === "global") {
        await refreshSharedWorkspaceState(workspaceId);
      }
    },
  };
}
