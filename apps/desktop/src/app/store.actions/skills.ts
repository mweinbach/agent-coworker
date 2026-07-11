import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  operationKey,
  pushNotification,
  RUNTIME,
  requestJsonRpcControlEvent,
  runAcknowledgedOperation,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";
import { isOneOffChatWorkspace } from "../types";
import {
  clearFailedMutationSend,
  dismissMutationError,
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
  | "dismissSkillMutationError"
> {
  const workspacePath = (workspaceId: string): string | undefined =>
    workspacePathFor(get, workspaceId);
  const managementWorkspaceId = (): string | null => managementWorkspaceIdFor(get);
  const hasProjectWorkspace = (): boolean =>
    get().workspaces.some((workspace) => !isOneOffChatWorkspace(workspace));
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
  const requestSkillMutation = async (options: {
    action: string;
    label: string;
    errorMessage: string;
    subjectId: string;
    method: string;
    params: (cwd: string | undefined) => Record<string, unknown>;
    shouldRefreshShared?: (workspaceId: string) => boolean;
  }) =>
    await runAcknowledgedOperation(get, set, {
      key: operationKey("skill", options.action, options.subjectId),
      label: options.label,
      errorTitle: `${options.label} failed`,
      errorMessage: options.errorMessage,
      execute: async () => {
        const workspaceId = managementWorkspaceId();
        if (!workspaceId) throw new Error("Select a workspace first.");
        const cwd = workspacePath(workspaceId);
        const key = mutationPendingKey(options.action, options.subjectId);
        const refreshSharedAfterSuccess = options.shouldRefreshShared?.(workspaceId) ?? false;
        setMutationPending(set, workspaceId, "skill", key);
        const rpcError: { message?: string } = {};
        const ok = await requestJsonRpcControlEvent(
          get,
          set,
          workspaceId,
          options.method,
          options.params(cwd),
          rpcError,
        );
        if (!ok) {
          const detail = rpcError.message?.trim() || options.errorMessage;
          clearFailedMutationSend(
            set,
            workspaceId,
            key,
            detail,
            {
              skillMutationError: detail,
            },
            "skill",
            false,
          );
          throw new Error(detail);
        }
        if (refreshSharedAfterSuccess) {
          await refreshSharedWorkspaceState(workspaceId);
        }
      },
    });

  return {
    openSkills: async () => {
      let workspaceId = managementWorkspaceId();
      if (!workspaceId && !hasProjectWorkspace()) {
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
        workspaceId = managementWorkspaceId();
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

      get().openSettings("toolAccess");
    },

    refreshSkillsCatalog: async (targetWorkspaceId?: string) => {
      const workspaceId = targetWorkspaceId ?? managementWorkspaceId();
      if (!workspaceId) return;
      ensureWorkspaceRuntime(get, set, workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillCatalogLoading: true,
            skillCatalogError: null,
            skillMutationError: null,
          },
        },
      }));
      await ensureServerRunning(get, set, workspaceId);
      const readyRuntime = get().workspaceRuntimeById[workspaceId];
      if (!readyRuntime?.serverUrl || readyRuntime.error) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              skillCatalogLoading: false,
              skillCatalogError: "Unable to refresh skills catalog.",
            },
          },
        }));
        return;
      }
      ensureControlSocket(get, set, workspaceId);
      const cwd = workspacePath(workspaceId);
      const [catalogResult, listResult] = await Promise.allSettled([
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/catalog/read", { cwd }),
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/list", { cwd }),
      ]);
      const okCatalog = catalogResult.status === "fulfilled" && catalogResult.value;
      const okList = listResult.status === "fulfilled" && listResult.value;
      const missingCatalogEvent = get().workspaceRuntimeById[workspaceId]?.skillCatalogLoading;
      if (!(okCatalog && okList) || missingCatalogEvent) {
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
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/install/preview",
        { cwd, sourceInput, targetScope },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to preview skill install.";
        clearFailedMutationSend(set, workspaceId, key, detail, { skillMutationError: detail });
      }
    },

    installSkills: async (sourceInput: string, targetScope: "project" | "global") => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("skill", "install"),
        label: "Install skill",
        errorTitle: "Skill not installed",
        errorMessage: "Unable to install skill.",
        repairAction: "Check the skill source and target, then retry.",
        execute: async () => {
          const normalizedSource = sourceInput.trim();
          if (!normalizedSource) throw new Error("Enter a skill source.");
          const workspaceId = managementWorkspaceId();
          if (!workspaceId) throw new Error("Select a workspace first.");
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

          const rpcError: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/skills/install",
            {
              cwd,
              sourceInput: normalizedSource,
              targetScope,
            },
            rpcError,
          );
          if (!ok) {
            const detail = rpcError.message?.trim() || "Unable to install skills.";
            if (existing) {
              RUNTIME.skillInstallWaiters.set(workspaceId, existing);
            } else {
              RUNTIME.skillInstallWaiters.delete(workspaceId);
            }
            clearFailedMutationSend(
              set,
              workspaceId,
              key,
              detail,
              {
                skillMutationError: detail,
              },
              "skill",
              false,
            );
            installPromise.reject(new Error(detail));
          } else if (existing) {
            existing.reject(new Error("Another skill install was started"));
          }

          await installPromise.promise;
          if (targetScope === "global") {
            await refreshSharedWorkspaceState(workspaceId);
          }
        },
      });
    },

    disableSkill: async (skillName: string) => {
      return await requestSkillMutation({
        action: "disable",
        label: "Disable skill",
        errorMessage: "Unable to disable skill.",
        subjectId: skillName,
        method: "cowork/skills/disable",
        params: (cwd) => ({ cwd, skillName }),
      });
    },

    enableSkill: async (skillName: string) => {
      return await requestSkillMutation({
        action: "enable",
        label: "Enable skill",
        errorMessage: "Unable to enable skill.",
        subjectId: skillName,
        method: "cowork/skills/enable",
        params: (cwd) => ({ cwd, skillName }),
      });
    },

    deleteSkill: async (skillName: string) => {
      return await requestSkillMutation({
        action: "delete",
        label: "Delete skill",
        errorMessage: "Unable to delete skill.",
        subjectId: skillName,
        method: "cowork/skills/delete",
        params: (cwd) => ({ cwd, skillName }),
      });
    },

    disableSkillInstallation: async (installationId: string) => {
      return await requestSkillMutation({
        action: "disable",
        label: "Disable skill",
        errorMessage: "Unable to disable skill installation.",
        subjectId: installationId,
        method: "cowork/skills/installation/disable",
        params: (cwd) => ({ cwd, installationId }),
        shouldRefreshShared: (workspaceId) =>
          resolveInstallationScopeForMutation(workspaceId, installationId) === "global",
      });
    },

    enableSkillInstallation: async (installationId: string) => {
      return await requestSkillMutation({
        action: "enable",
        label: "Enable skill",
        errorMessage: "Unable to enable skill installation.",
        subjectId: installationId,
        method: "cowork/skills/installation/enable",
        params: (cwd) => ({ cwd, installationId }),
        shouldRefreshShared: (workspaceId) =>
          resolveInstallationScopeForMutation(workspaceId, installationId) === "global",
      });
    },

    deleteSkillInstallation: async (installationId: string) => {
      return await requestSkillMutation({
        action: "delete",
        label: "Delete skill",
        errorMessage: "Unable to delete skill installation.",
        subjectId: installationId,
        method: "cowork/skills/installation/delete",
        params: (cwd) => ({ cwd, installationId }),
        shouldRefreshShared: (workspaceId) =>
          resolveInstallationScopeForMutation(workspaceId, installationId) === "global",
      });
    },

    copySkillInstallation: async (installationId: string, targetScope: "project" | "global") => {
      return await requestSkillMutation({
        action: `copy:${targetScope}`,
        label: "Copy skill",
        errorMessage: "Unable to copy skill installation.",
        subjectId: installationId,
        method: "cowork/skills/installation/copy",
        params: (cwd) => ({ cwd, installationId, targetScope }),
        shouldRefreshShared: () => targetScope === "global",
      });
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

    dismissSkillMutationError: (targetWorkspaceId?: string) => {
      dismissMutationError(get, set, "skill", targetWorkspaceId);
    },

    updateSkillInstallation: async (installationId: string) => {
      return await requestSkillMutation({
        action: "update",
        label: "Update skill",
        errorMessage: "Unable to update skill installation.",
        subjectId: installationId,
        method: "cowork/skills/installation/update",
        params: (cwd) => ({ cwd, installationId }),
        shouldRefreshShared: (workspaceId) =>
          resolveInstallationScopeForMutation(workspaceId, installationId) === "global",
      });
    },
  };
}
