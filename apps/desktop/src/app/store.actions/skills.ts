import type { PluginCatalogEntry } from "../../lib/wsProtocol";
import {
  resolvePluginCatalogWorkspaceSelection,
  resolvePluginManagementWorkspaceId,
} from "../pluginManagement";
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
import type { WorkspaceRuntime } from "../types";

type PluginSelection = Pick<PluginCatalogEntry, "id" | "scope">;

function skillPendingKey(action: string, id?: string): string {
  return id ? `${action}:${id}` : action;
}

function pluginPendingKey(action: string, selection?: PluginSelection): string {
  return selection ? `plugin:${action}:${selection.scope}:${selection.id}` : `plugin:${action}`;
}

function clearFailedMutationSend(
  set: StoreSet,
  workspaceId: string,
  key: string,
  detail: string,
  overrides?: Partial<WorkspaceRuntime>,
): void {
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        skillMutationPendingKeys: (() => {
          const pendingKeys = { ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys };
          delete pendingKeys[key];
          return pendingKeys;
        })(),
        ...(overrides ?? {}),
      },
    },
    notifications: pushNotification(s.notifications, {
      id: makeId(),
      ts: nowIso(),
      kind: "error",
      title: "Not connected",
      detail,
    }),
  }));
}

export function createSkillActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "openSkills"
  | "refreshSkillsCatalog"
  | "refreshPluginsCatalog"
  | "selectPlugin"
  | "setPluginManagementWorkspace"
  | "previewPluginInstall"
  | "installPlugins"
  | "setPluginViewMode"
  | "enablePlugin"
  | "disablePlugin"
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
    ((get() as { workspaces?: Array<{ id: string; path: string }> }).workspaces ?? []).find(
      (workspace) => workspace.id === workspaceId,
    )?.path;
  const managementWorkspaceId = (): string | null => {
    const state = get();
    return resolvePluginCatalogWorkspaceSelection({
      workspaces: state.workspaces ?? [],
      selectedWorkspaceId: state.selectedWorkspaceId,
      pluginManagementWorkspaceId: state.pluginManagementWorkspaceId,
      pluginManagementMode: state.pluginManagementMode,
    }).catalogWorkspaceId;
  };
  const resolvePluginScopeForMutation = (
    workspaceId: string,
    pluginId: string,
    scope?: PluginSelection["scope"],
  ): PluginSelection["scope"] | null => {
    if (scope) {
      return scope;
    }
    const catalog = get().workspaceRuntimeById[workspaceId]?.pluginsCatalog;
    const matches = catalog?.plugins.filter((plugin) => plugin.id === pluginId) ?? [];
    if (matches.length !== 1) {
      return null;
    }
    return matches[0]?.scope ?? null;
  };
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
  const refreshSharedWorkspaceState = async (sourceWorkspaceId: string) => {
    const targetWorkspaceIds = (get().workspaces ?? [])
      .map((workspace) => workspace.id)
      .filter((workspaceId) => {
        if (workspaceId === sourceWorkspaceId) {
          return false;
        }
        const runtime = get().workspaceRuntimeById[workspaceId];
        return !!runtime?.serverUrl && !runtime.error;
      });

    await Promise.allSettled(
      targetWorkspaceIds.map(async (workspaceId) => {
        const cwd = workspacePath(workspaceId);
        if (!cwd) {
          return;
        }
        ensureWorkspaceRuntime(get, set, workspaceId);
        await ensureServerRunning(get, set, workspaceId);
        ensureControlSocket(get, set, workspaceId);
        await Promise.allSettled([
          requestJsonRpcControlEvent(get, set, workspaceId, "cowork/plugins/catalog/read", { cwd }),
          requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/catalog/read", { cwd }),
          requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/list", { cwd }),
          requestJsonRpcControlEvent(get, set, workspaceId, "cowork/mcp/servers/read", { cwd }),
        ]);
      }),
    );
  };

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

    refreshPluginsCatalog: async () => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            pluginsLoading: true,
            pluginsError: null,
          },
        },
      }));
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/plugins/catalog/read",
        { cwd },
      );
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              pluginsLoading: false,
              pluginsError: "Unable to refresh plugins catalog.",
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to refresh plugins catalog.",
          }),
        }));
      }
    },

    selectPlugin: async (pluginId: string | null, scope?: PluginSelection["scope"] | null) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      if (pluginId === null) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              selectedPluginId: null,
              selectedPluginScope: null,
              selectedPlugin: null,
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
            selectedPluginId: pluginId,
            selectedPluginScope: scope ?? null,
            selectedPlugin: null,
            pluginsLoading: true,
            pluginsError: null,
          },
        },
      }));
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/plugins/read", {
        cwd,
        pluginId,
        ...(scope ? { scope } : {}),
      });
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              pluginsLoading: false,
              pluginsError: "Unable to load plugin details.",
            },
          },
        }));
      }
    },

    setPluginManagementWorkspace: async (workspaceId: string | null) => {
      set({
        pluginManagementWorkspaceId: resolvePluginManagementWorkspaceId(
          get().workspaces ?? [],
          workspaceId,
        ),
        pluginManagementMode: workspaceId === null ? "global" : "workspace",
      });
      syncDesktopStateCache(get);
      const targetWorkspaceId = managementWorkspaceId();
      if (!targetWorkspaceId) {
        return;
      }
      ensureWorkspaceRuntime(get, set, targetWorkspaceId);
      await ensureServerRunning(get, set, targetWorkspaceId);
      ensureControlSocket(get, set, targetWorkspaceId);
      await Promise.all([get().refreshPluginsCatalog(), get().refreshSkillsCatalog()]);
    },

    previewPluginInstall: async (sourceInput: string, targetScope: "workspace" | "user") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const key = pluginPendingKey("preview");
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            pluginsLoading: true,
            pluginsError: null,
            skillMutationError: null,
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/plugins/install/preview",
        {
          cwd,
          sourceInput,
          targetScope,
        },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to preview plugin install.";
        clearFailedMutationSend(set, workspaceId, key, detail, {
          pluginsLoading: false,
          pluginsError: detail,
          skillMutationError: detail,
        });
      }
    },

    installPlugins: async (sourceInput: string, targetScope: "workspace" | "user") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }
      const cwd = workspacePath(workspaceId);
      const key = pluginPendingKey(`install:${targetScope}`);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            pluginsLoading: true,
            pluginsError: null,
            skillMutationError: null,
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      const existing = RUNTIME.pluginInstallWaiters.get(workspaceId);
      const installPromise = Promise.withResolvers<void>();
      RUNTIME.pluginInstallWaiters.set(workspaceId, {
        pendingKey: key,
        resolve: installPromise.resolve,
        reject: installPromise.reject,
      });

      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/plugins/install",
        {
          cwd,
          sourceInput,
          targetScope,
        },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to install plugins.";
        if (existing) {
          RUNTIME.pluginInstallWaiters.set(workspaceId, existing);
        } else {
          RUNTIME.pluginInstallWaiters.delete(workspaceId);
        }
        clearFailedMutationSend(set, workspaceId, key, detail, {
          pluginsLoading: false,
          pluginsError: detail,
          skillMutationError: detail,
        });
        installPromise.reject(new Error(detail));
      } else if (existing) {
        existing.reject(new Error("Another install was started"));
      }

      const result = await installPromise.promise;
      if (targetScope === "user") {
        await refreshSharedWorkspaceState(workspaceId);
      }
      return result;
    },

    setPluginViewMode: async (mode: "plugins" | "skills") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            pluginViewMode: mode,
          },
        },
      }));
    },

    enablePlugin: async (pluginId: string, scope?: PluginSelection["scope"]) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const pluginScope = resolvePluginScopeForMutation(workspaceId, pluginId, scope);
      const selection = scope ? { id: pluginId, scope } : undefined;
      const key = pluginPendingKey("enable", selection);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/plugins/enable",
        {
          cwd,
          pluginId,
          ...(scope ? { scope } : {}),
        },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to enable plugin.";
        clearFailedMutationSend(set, workspaceId, key, detail, {
          pluginsLoading: false,
          pluginsError: detail,
          skillMutationError: detail,
        });
      } else {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              skillMutationPendingKeys: (() => {
                const pendingKeys = {
                  ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
                };
                delete pendingKeys[key];
                return pendingKeys;
              })(),
            },
          },
        }));
        if (pluginScope === "user") {
          await refreshSharedWorkspaceState(workspaceId);
        }
      }
    },

    disablePlugin: async (pluginId: string, scope?: PluginSelection["scope"]) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const pluginScope = resolvePluginScopeForMutation(workspaceId, pluginId, scope);
      const selection = scope ? { id: pluginId, scope } : undefined;
      const key = pluginPendingKey("disable", selection);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/plugins/disable",
        {
          cwd,
          pluginId,
          ...(scope ? { scope } : {}),
        },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to disable plugin.";
        clearFailedMutationSend(set, workspaceId, key, detail, {
          pluginsLoading: false,
          pluginsError: detail,
          skillMutationError: detail,
        });
      } else {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              skillMutationPendingKeys: (() => {
                const pendingKeys = {
                  ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
                };
                delete pendingKeys[key];
                return pendingKeys;
              })(),
            },
          },
        }));
        if (pluginScope === "user") {
          await refreshSharedWorkspaceState(workspaceId);
        }
      }
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
      const key = skillPendingKey("preview");
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationError: null,
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/skills/install/preview",
        { cwd, sourceInput, targetScope },
      );
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              skillMutationPendingKeys: (() => {
                const pendingKeys = {
                  ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
                };
                delete pendingKeys[key];
                return pendingKeys;
              })(),
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to preview skill install.",
          }),
        }));
      }
    },

    installSkills: async (sourceInput: string, targetScope: "project" | "global") => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }
      const cwd = workspacePath(workspaceId);
      const key = skillPendingKey(`install:${targetScope}`);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationError: null,
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
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
        if (existing) {
          RUNTIME.skillInstallWaiters.set(workspaceId, existing);
        } else {
          RUNTIME.skillInstallWaiters.delete(workspaceId);
        }
        clearFailedMutationSend(set, workspaceId, key, "Unable to install skills.");
        installPromise.reject(new Error("Unable to install skills."));
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
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to disable skill.",
          }),
        }));
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
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to enable skill.",
          }),
        }));
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
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to delete skill.",
          }),
        }));
      }
    },

    disableSkillInstallation: async (installationId: string) => {
      const workspaceId = managementWorkspaceId();
      if (!workspaceId) return;
      const cwd = workspacePath(workspaceId);
      const installationScope = resolveInstallationScopeForMutation(workspaceId, installationId);
      const key = skillPendingKey("disable", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
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
      const key = skillPendingKey("enable", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
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
      const key = skillPendingKey("delete", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
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
      const key = skillPendingKey(`copy:${targetScope}`, installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
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
      const key = skillPendingKey("update", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
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
