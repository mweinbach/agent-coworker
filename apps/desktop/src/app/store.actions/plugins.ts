import type { PluginCatalogEntry } from "../../lib/wsProtocol";
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
  clearMutationPending,
  managementWorkspaceIdFor,
  mutationPendingKey,
  refreshSharedWorkspaceState,
  resolvePluginManagementWorkspace,
  setMutationPending,
  workspacePathFor,
} from "./skillPluginHelpers";

type PluginSelection = Pick<PluginCatalogEntry, "id" | "scope">;
type PluginMutationAction = "enable" | "disable" | "delete";

function pluginPendingKey(action: string, selection?: PluginSelection): string {
  return mutationPendingKey(
    `plugin:${action}`,
    selection ? `${selection.scope}:${selection.id}` : undefined,
  );
}

export function createPluginActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "refreshPluginsCatalog"
  | "selectPlugin"
  | "setPluginManagementWorkspace"
  | "previewPluginInstall"
  | "installPlugins"
  | "setPluginViewMode"
  | "enablePlugin"
  | "disablePlugin"
  | "deletePlugin"
> {
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

  const resolveCachedPluginSelection = (
    workspaceId: string,
    pluginId: string,
    scope?: PluginSelection["scope"] | null,
  ): PluginCatalogEntry | null => {
    const catalog = get().workspaceRuntimeById[workspaceId]?.pluginsCatalog;
    const plugins = [...(catalog?.plugins ?? []), ...(catalog?.availablePlugins ?? [])];
    const matches = plugins.filter(
      (plugin) =>
        plugin.id === pluginId && (scope === undefined || scope === null || plugin.scope === scope),
    );
    if (matches.length !== 1) {
      return null;
    }
    return matches[0] ?? null;
  };

  const clearPluginMutationPending = (
    workspaceId: string,
    key: string,
    opts: { clearSelection?: boolean } = {},
  ) => {
    clearMutationPending(
      set,
      workspaceId,
      "plugin",
      key,
      opts.clearSelection
        ? {
            selectedPlugin: null,
            selectedPluginId: null,
            selectedPluginScope: null,
          }
        : undefined,
    );
  };

  const runPluginMutation = async (
    action: PluginMutationAction,
    pluginId: string,
    scope?: PluginSelection["scope"],
  ) => {
    const workspaceId = managementWorkspaceIdFor(get);
    if (!workspaceId) return;
    const cwd = workspacePathFor(get, workspaceId);
    const pluginScope = resolvePluginScopeForMutation(workspaceId, pluginId, scope);
    const selection = pluginScope ? { id: pluginId, scope: pluginScope } : undefined;
    const key = pluginPendingKey(action, selection);
    setMutationPending(set, workspaceId, "plugin", key, { pluginsError: null });
    const rpcError: { message?: string } = {};
    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      `cowork/plugins/${action}`,
      {
        cwd,
        pluginId,
        ...(pluginScope ? { scope: pluginScope } : {}),
      },
      rpcError,
    );
    if (!ok) {
      const detail = rpcError.message?.trim() || `Unable to ${action} plugin.`;
      clearFailedMutationSend(
        set,
        workspaceId,
        key,
        detail,
        {
          pluginMutationError: detail,
        },
        "plugin",
      );
      return;
    }

    clearPluginMutationPending(workspaceId, key, { clearSelection: action === "delete" });
    if (pluginScope === "user") {
      await refreshSharedWorkspaceState(get, set, workspaceId);
    }
  };

  return {
    refreshPluginsCatalog: async () => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
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
      const workspaceId = managementWorkspaceIdFor(get);
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
      const cwd = workspacePathFor(get, workspaceId);
      const cachedPlugin = resolveCachedPluginSelection(workspaceId, pluginId, scope);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedPluginId: pluginId,
            selectedPluginScope: scope ?? cachedPlugin?.scope ?? null,
            selectedPlugin: cachedPlugin,
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
              pluginsError: cachedPlugin ? null : "Unable to load plugin details.",
            },
          },
        }));
      }
    },

    setPluginManagementWorkspace: async (workspaceId: string | null) => {
      set({
        pluginManagementWorkspaceId: resolvePluginManagementWorkspace(get, workspaceId),
        pluginManagementMode: workspaceId === null ? "global" : "workspace",
      });
      syncDesktopStateCache(get);
      const targetWorkspaceId = managementWorkspaceIdFor(get);
      if (!targetWorkspaceId) {
        return;
      }
      ensureWorkspaceRuntime(get, set, targetWorkspaceId);
      await ensureServerRunning(get, set, targetWorkspaceId);
      ensureControlSocket(get, set, targetWorkspaceId);
      await Promise.all([get().refreshPluginsCatalog(), get().refreshSkillsCatalog()]);
    },

    previewPluginInstall: async (sourceInput: string, targetScope: "workspace" | "user") => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      const key = pluginPendingKey("preview");
      setMutationPending(set, workspaceId, "plugin", key, {
        pluginsLoading: true,
        pluginsError: null,
      });
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
        clearFailedMutationSend(
          set,
          workspaceId,
          key,
          detail,
          {
            pluginsLoading: false,
            pluginMutationError: detail,
          },
          "plugin",
        );
      }
    },

    installPlugins: async (sourceInput: string, targetScope: "workspace" | "user") => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }
      const cwd = workspacePathFor(get, workspaceId);
      const key = pluginPendingKey(`install:${targetScope}`);
      setMutationPending(set, workspaceId, "plugin", key, {
        pluginsLoading: true,
        pluginsError: null,
      });
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
        clearFailedMutationSend(
          set,
          workspaceId,
          key,
          detail,
          {
            pluginsLoading: false,
            pluginMutationError: detail,
          },
          "plugin",
        );
        installPromise.reject(new Error(detail));
      } else if (existing) {
        existing.reject(new Error("Another install was started"));
      }

      const result = await installPromise.promise;
      if (targetScope === "user") {
        await refreshSharedWorkspaceState(get, set, workspaceId);
      }
      return result;
    },

    setPluginViewMode: async (mode: "plugins" | "skills") => {
      const workspaceId = managementWorkspaceIdFor(get);
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
      await runPluginMutation("enable", pluginId, scope);
    },

    disablePlugin: async (pluginId: string, scope?: PluginSelection["scope"]) => {
      await runPluginMutation("disable", pluginId, scope);
    },

    deletePlugin: async (pluginId: string, scope?: PluginSelection["scope"]) => {
      await runPluginMutation("delete", pluginId, scope);
    },
  };
}
