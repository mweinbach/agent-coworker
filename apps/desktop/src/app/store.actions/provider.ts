import type { CodexAppServerInstallStatus } from "../../lib/wsProtocol";
import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  operationKey,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  RUNTIME,
  requestJsonRpcControl,
  requestJsonRpcControlEvent,
  runAcknowledgedOperation,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";

type RefreshProviderStatusHelperOverrides = {
  makeId?: typeof makeId;
  nowIso?: typeof nowIso;
  pushNotification?: typeof pushNotification;
  requestJsonRpcControlEvent?: typeof requestJsonRpcControlEvent;
};

type RefreshProviderStatusOptions = {
  refreshBedrockDiscovery?: boolean;
  workspaceId?: string;
};

function isRefreshProviderStatusHelperOverrides(
  value: RefreshProviderStatusOptions | RefreshProviderStatusHelperOverrides,
): value is RefreshProviderStatusHelperOverrides {
  return (
    "makeId" in value ||
    "nowIso" in value ||
    "pushNotification" in value ||
    "requestJsonRpcControlEvent" in value
  );
}

export async function refreshProviderStatusForWorkspace(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  path: string | undefined,
  optsOrOverrides: RefreshProviderStatusOptions | RefreshProviderStatusHelperOverrides = {},
  overridesArg: RefreshProviderStatusHelperOverrides = {},
): Promise<void> {
  const opts = isRefreshProviderStatusHelperOverrides(optsOrOverrides) ? {} : optsOrOverrides;
  const overrides = isRefreshProviderStatusHelperOverrides(optsOrOverrides)
    ? optsOrOverrides
    : overridesArg;
  const createId = overrides.makeId ?? makeId;
  const getNowIso = overrides.nowIso ?? nowIso;
  const addNotification = overrides.pushNotification ?? pushNotification;
  const sendControlEvent = overrides.requestJsonRpcControlEvent ?? requestJsonRpcControlEvent;
  const refreshGeneration = ++RUNTIME.providerStatusRefreshGeneration;
  set({ providerStatusRefreshing: true });
  const statusRefreshPromise = sendControlEvent(
    get,
    set,
    workspaceId,
    "cowork/provider/status/refresh",
    {
      cwd: path,
      ...(opts.refreshBedrockDiscovery ? { refreshBedrockDiscovery: true } : {}),
    },
  );
  const catalogPromise = opts.refreshBedrockDiscovery
    ? statusRefreshPromise.then(() =>
        sendControlEvent(get, set, workspaceId, "cowork/provider/catalog/read", {
          cwd: path,
          refresh: true,
        }),
      )
    : sendControlEvent(get, set, workspaceId, "cowork/provider/catalog/read", {
        cwd: path,
        refresh: true,
      });
  const authMethodsPromise = sendControlEvent(
    get,
    set,
    workspaceId,
    "cowork/provider/authMethods/read",
    { cwd: path },
  );
  const results = await Promise.allSettled([
    statusRefreshPromise,
    catalogPromise,
    authMethodsPromise,
  ]);
  const allSucceeded = results.every((result) => result.status === "fulfilled" && result.value);
  set((s) => ({
    ...(refreshGeneration === RUNTIME.providerStatusRefreshGeneration
      ? { providerStatusRefreshing: false }
      : {}),
    ...(!allSucceeded
      ? {
          notifications: addNotification(s.notifications, {
            id: createId(),
            ts: getNowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to refresh provider status.",
          }),
        }
      : {}),
  }));
}

export function createProviderActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "connectProvider"
  | "setProviderApiKey"
  | "setProviderConfig"
  | "copyProviderApiKey"
  | "authorizeProviderAuth"
  | "logoutProviderAuth"
  | "callbackProviderAuth"
  | "requestProviderCatalog"
  | "requestProviderAuthMethods"
  | "addCustomProviderModel"
  | "deleteCustomProviderModel"
  | "setProviderModelsEnabled"
  | "resetProviderModelPreferences"
  | "refreshProviderStatus"
  | "checkCodexAppServerStatus"
  | "updateCodexAppServer"
  | "setLmStudioEnabled"
  | "setLmStudioModelVisible"
> {
  const resolveProviderWorkspaceId = (workspaceId?: string | null): string | null => {
    if (workspaceId && get().workspaces.some((workspace) => workspace.id === workspaceId)) {
      return workspaceId;
    }
    return get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
  };

  const ensureProviderControlReady = async (
    workspaceIdOverride?: string | null,
  ): Promise<string | null> => {
    const workspaceId = resolveProviderWorkspaceId(workspaceIdOverride);
    if (!workspaceId) return null;

    await ensureServerRunning(get, set, workspaceId);
    const socket = ensureControlSocket(get, set, workspaceId);
    if (!socket || !get().workspaceRuntimeById[workspaceId]?.controlSessionId) {
      return null;
    }

    return workspaceId;
  };

  const requestProviderMutation = async (options: {
    provider: string;
    action: string;
    label: string;
    errorTitle: string;
    errorMessage: string;
    method: string;
    params: (workspaceId: string) => Record<string, unknown>;
    prepare?: () => void;
  }) =>
    await runAcknowledgedOperation(get, set, {
      key: operationKey("provider", options.action, options.provider),
      label: options.label,
      errorTitle: options.errorTitle,
      errorMessage: options.errorMessage,
      execute: async () => {
        const workspaceId = resolveProviderWorkspaceId();
        if (!workspaceId) {
          throw new Error("Add or select a workspace first.");
        }
        await ensureServerRunning(get, set, workspaceId);
        ensureControlSocket(get, set, workspaceId);
        options.prepare?.();
        const rpcError: { message?: string } = {};
        const ok = await requestJsonRpcControlEvent(
          get,
          set,
          workspaceId,
          options.method,
          {
            cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
            ...options.params(workspaceId),
          },
          rpcError,
        );
        if (!ok) {
          throw new Error(rpcError.message?.trim() || options.errorMessage);
        }
      },
    });

  return {
    connectProvider: async (provider, apiKey) => {
      if (provider === "lmstudio") {
        return await get().setLmStudioEnabled(true);
      }

      const methods = providerAuthMethodsFor(get(), provider);
      const normalizedKey = (apiKey ?? "").trim();

      if (normalizedKey) {
        const apiMethod = methods.find((method) => method.type === "api") ?? {
          id: "api_key",
          type: "api",
          label: "API key",
        };
        return await get().setProviderApiKey(provider, apiMethod.id, normalizedKey);
      }

      const oauthMethod = methods.find((method) => method.type === "oauth");
      if (oauthMethod) {
        set(() => ({
          providerLastAuthChallenge: null,
          providerLastAuthResult: null,
        }));
        const authorized = await get().authorizeProviderAuth(provider, oauthMethod.id);
        if (!authorized.ok) {
          return authorized;
        }
        if (oauthMethod.oauthMode !== "code") {
          return await get().callbackProviderAuth(provider, oauthMethod.id);
        }
        return authorized;
      }

      return await runAcknowledgedOperation(get, set, {
        key: operationKey("provider", "connect", provider),
        label: "Connect provider",
        errorTitle: "API key required",
        errorMessage: `Enter an API key to connect ${provider}.`,
        repairAction: "Enter an API key and retry.",
        execute: async () => {
          throw new Error(`Enter an API key to connect ${provider}.`);
        },
      });
    },

    setProviderApiKey: async (provider, methodId, apiKey) => {
      const trimmedKey = apiKey.trim();
      return await requestProviderMutation({
        provider,
        action: `api-key:${methodId.trim() || "api_key"}`,
        label: "Save provider API key",
        errorTitle: trimmedKey ? "API key not saved" : "Missing API key",
        errorMessage: trimmedKey
          ? "Unable to save the provider API key."
          : "Enter an API key before saving.",
        method: "cowork/provider/auth/setApiKey",
        params: () => {
          if (!trimmedKey) {
            throw new Error("Enter an API key before saving.");
          }
          return {
            provider,
            methodId: methodId.trim() || "api_key",
            apiKey: trimmedKey,
          };
        },
      });
    },

    setProviderConfig: async (provider, methodId, values) => {
      return await requestProviderMutation({
        provider,
        action: `config:${methodId.trim()}`,
        label: "Save provider credentials",
        errorTitle: "Credentials not saved",
        errorMessage: "Unable to save the provider credentials.",
        method: "cowork/provider/auth/setConfig",
        params: () => ({
          provider,
          methodId: methodId.trim(),
          values,
        }),
      });
    },

    copyProviderApiKey: async (provider, sourceProvider) => {
      return await requestProviderMutation({
        provider,
        action: `copy-api-key:${sourceProvider}`,
        label: "Copy provider API key",
        errorTitle: "API key not copied",
        errorMessage: "Unable to copy the provider API key.",
        method: "cowork/provider/auth/copyApiKey",
        params: () => ({
          provider,
          sourceProvider,
        }),
        prepare: () =>
          set({
            providerLastAuthChallenge: null,
            providerLastAuthResult: null,
          }),
      });
    },

    authorizeProviderAuth: async (provider, methodId) => {
      const normalizedMethodId = methodId.trim();
      return await requestProviderMutation({
        provider,
        action: `authorize:${normalizedMethodId || "missing"}`,
        label: "Start provider sign-in",
        errorTitle: normalizedMethodId ? "Sign-in not started" : "Missing auth method",
        errorMessage: normalizedMethodId
          ? "Unable to start provider sign-in."
          : "Choose an auth method before continuing.",
        method: "cowork/provider/auth/authorize",
        params: () => {
          if (!normalizedMethodId) {
            throw new Error("Choose an auth method before continuing.");
          }
          return {
            provider,
            methodId: normalizedMethodId,
          };
        },
        prepare: () =>
          set({
            providerLastAuthChallenge: null,
            providerLastAuthResult: null,
          }),
      });
    },

    logoutProviderAuth: async (provider) => {
      return await requestProviderMutation({
        provider,
        action: "logout",
        label: "Disconnect provider",
        errorTitle: "Provider not disconnected",
        errorMessage: "Unable to disconnect the provider.",
        method: "cowork/provider/auth/logout",
        params: () => ({
          provider,
        }),
        prepare: () =>
          set({
            providerLastAuthChallenge: null,
            providerLastAuthResult: null,
          }),
      });
    },

    callbackProviderAuth: async (provider, methodId, code) => {
      const normalizedMethodId = methodId.trim();
      const normalizedCode = code?.trim();
      return await requestProviderMutation({
        provider,
        action: `callback:${normalizedMethodId || "missing"}`,
        label: "Complete provider sign-in",
        errorTitle: normalizedMethodId ? "Sign-in not completed" : "Missing auth method",
        errorMessage: normalizedMethodId
          ? "Unable to complete provider sign-in."
          : "Choose an auth method before continuing.",
        method: "cowork/provider/auth/callback",
        params: () => {
          if (!normalizedMethodId) {
            throw new Error("Choose an auth method before continuing.");
          }
          return {
            provider,
            methodId: normalizedMethodId,
            code: normalizedCode || undefined,
          };
        },
        prepare: () =>
          set({
            providerLastAuthChallenge: null,
            providerLastAuthResult: null,
          }),
      });
    },

    requestProviderCatalog: async () => {
      const workspaceId = await ensureProviderControlReady();
      if (!workspaceId) return;

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/provider/catalog/read",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          refresh: true,
        },
      );
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request provider catalog.",
          }),
        }));
      }
    },

    requestProviderAuthMethods: async () => {
      const workspaceId = await ensureProviderControlReady();
      if (!workspaceId) return;

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/provider/authMethods/read",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        },
      );
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request provider auth methods.",
          }),
        }));
      }
    },

    addCustomProviderModel: async (provider, modelId) => {
      const normalizedModelId = modelId.trim();
      return await requestProviderMutation({
        provider,
        action: `model-add:${normalizedModelId || "missing"}`,
        label: "Add custom provider model",
        errorTitle: normalizedModelId ? "Model not added" : "Missing model ID",
        errorMessage: normalizedModelId
          ? "Unable to add custom provider model."
          : "Enter a model ID before adding it.",
        method: "cowork/provider/customModel/add",
        params: () => {
          if (!normalizedModelId) {
            throw new Error("Enter a model ID before adding it.");
          }
          return {
            provider,
            modelId: normalizedModelId,
          };
        },
      });
    },

    deleteCustomProviderModel: async (provider, modelId) => {
      const normalizedModelId = modelId.trim();
      return await requestProviderMutation({
        provider,
        action: `model-delete:${normalizedModelId || "missing"}`,
        label: "Remove custom provider model",
        errorTitle: "Model not removed",
        errorMessage: normalizedModelId
          ? "Unable to remove custom provider model."
          : "Choose a custom provider model to remove.",
        method: "cowork/provider/customModel/delete",
        params: () => {
          if (!normalizedModelId) {
            throw new Error("Choose a custom provider model to remove.");
          }
          return {
            provider,
            modelId: normalizedModelId,
          };
        },
      });
    },

    setProviderModelsEnabled: async (provider, models) => {
      const normalizedModels = models
        .map((model) => ({ id: model.id.trim(), enabled: model.enabled }))
        .filter((model) => model.id);
      const subject = normalizedModels
        .map((model) => `${model.id}=${model.enabled}`)
        .sort((left, right) => left.localeCompare(right))
        .join(",");
      return await requestProviderMutation({
        provider,
        action: `models-enabled:${subject || "missing"}`,
        label: "Update provider models",
        errorTitle: "Models not updated",
        errorMessage:
          normalizedModels.length > 0
            ? "Unable to update provider model preferences."
            : "Choose at least one provider model to update.",
        method: "cowork/provider/model/setEnabled",
        params: () => {
          if (normalizedModels.length === 0) {
            throw new Error("Choose at least one provider model to update.");
          }
          return {
            provider,
            models: normalizedModels,
          };
        },
      });
    },

    resetProviderModelPreferences: async (provider) => {
      return await requestProviderMutation({
        provider,
        action: "models-reset",
        label: "Reset provider models",
        errorTitle: "Models not reset",
        errorMessage: "Unable to reset provider model preferences.",
        method: "cowork/provider/model/resetEnabled",
        params: () => ({
          provider,
        }),
      });
    },

    refreshProviderStatus: async (opts) => {
      const workspaceId = await ensureProviderControlReady(opts?.workspaceId);
      if (!workspaceId) return;

      const path = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      await refreshProviderStatusForWorkspace(get, set, workspaceId, path, opts);
    },

    checkCodexAppServerStatus: async (opts) => {
      const workspaceId = await ensureProviderControlReady();
      if (!workspaceId) return;
      const path = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      set({ codexAppServerChecking: true });
      try {
        const result = (await requestJsonRpcControl(
          get,
          set,
          workspaceId,
          "cowork/provider/codexAppServer/status",
          {
            cwd: path,
            ...(opts?.checkLatest ? { checkLatest: true } : {}),
          },
        )) as { status?: unknown };
        const status = result.status;
        if (status && typeof status === "object") {
          set({ codexAppServerStatus: status as CodexAppServerInstallStatus });
        }
      } catch (error) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Codex app-server",
            detail: error instanceof Error ? error.message : "Unable to read Codex app-server.",
          }),
        }));
      } finally {
        set({ codexAppServerChecking: false });
      }
    },

    updateCodexAppServer: async (opts) => {
      const workspaceId = await ensureProviderControlReady();
      if (!workspaceId) return;
      const path = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      set({ codexAppServerUpdating: true });
      try {
        const result = (await requestJsonRpcControl(
          get,
          set,
          workspaceId,
          "cowork/provider/codexAppServer/update",
          {
            cwd: path,
            ...(opts?.force !== undefined ? { force: opts.force } : {}),
          },
        )) as { status?: unknown };
        const status = result.status;
        if (status && typeof status === "object") {
          set((s) => ({
            codexAppServerStatus: status as CodexAppServerInstallStatus,
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "info",
              title: "Codex app-server updated",
              detail:
                typeof (status as { message?: unknown }).message === "string"
                  ? (status as { message: string }).message
                  : "Installed the latest Cowork-managed Codex runtime.",
            }),
          }));
        }
        await get().refreshProviderStatus();
      } catch (error) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Codex app-server update failed",
            detail: error instanceof Error ? error.message : "Unable to update Codex app-server.",
          }),
        }));
      } finally {
        set({ codexAppServerUpdating: false });
      }
    },

    setLmStudioEnabled: async (enabled) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("provider", "lmstudio-enabled"),
        label: enabled ? "Enable LM Studio" : "Disable LM Studio",
        errorTitle: "LM Studio setting not saved",
        errorMessage: "Unable to save the LM Studio setting.",
        optimistic: () => {
          const previous = get().providerUiState.lmstudio.enabled;
          set((s) => ({
            providerUiState: {
              ...s.providerUiState,
              lmstudio: {
                ...s.providerUiState.lmstudio,
                enabled,
              },
            },
          }));
          return () => {
            set((s) => ({
              providerUiState: {
                ...s.providerUiState,
                lmstudio: {
                  ...s.providerUiState.lmstudio,
                  enabled: previous,
                },
              },
            }));
          };
        },
        execute: async () => {
          await persistNow(get);
          if (enabled) {
            await get().refreshProviderStatus();
          }
        },
      });
    },

    setLmStudioModelVisible: async (modelId, visible) => {
      const normalizedModelId = modelId.trim();
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("provider", "lmstudio-model-visible", normalizedModelId || "missing"),
        label: "Update LM Studio model visibility",
        errorTitle: "LM Studio model setting not saved",
        errorMessage: normalizedModelId
          ? "Unable to save the LM Studio model setting."
          : "Choose an LM Studio model to update.",
        optimistic: normalizedModelId
          ? () => {
              const previous = get().providerUiState.lmstudio.hiddenModels;
              set((s) => {
                const hiddenModels = new Set(s.providerUiState.lmstudio.hiddenModels);
                if (visible) {
                  hiddenModels.delete(normalizedModelId);
                } else {
                  hiddenModels.add(normalizedModelId);
                }
                return {
                  providerUiState: {
                    ...s.providerUiState,
                    lmstudio: {
                      ...s.providerUiState.lmstudio,
                      hiddenModels: [...hiddenModels].sort((a, b) => a.localeCompare(b)),
                    },
                  },
                };
              });
              return () => {
                set((s) => ({
                  providerUiState: {
                    ...s.providerUiState,
                    lmstudio: {
                      ...s.providerUiState.lmstudio,
                      hiddenModels: previous,
                    },
                  },
                }));
              };
            }
          : undefined,
        execute: async () => {
          if (!normalizedModelId) {
            throw new Error("Choose an LM Studio model to update.");
          }
          await persistNow(get);
        },
      });
    },
  };
}
