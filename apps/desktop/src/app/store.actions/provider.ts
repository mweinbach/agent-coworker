import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  requestJsonRpcControlEvent,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
  waitForControlSession,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

type RefreshProviderStatusHelperOverrides = {
  makeId?: typeof makeId;
  nowIso?: typeof nowIso;
  pushNotification?: typeof pushNotification;
  requestJsonRpcControlEvent?: typeof requestJsonRpcControlEvent;
};

export async function refreshProviderStatusForWorkspace(
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  path: string | undefined,
  overrides: RefreshProviderStatusHelperOverrides = {},
): Promise<void> {
  const createId = overrides.makeId ?? makeId;
  const getNowIso = overrides.nowIso ?? nowIso;
  const addNotification = overrides.pushNotification ?? pushNotification;
  const sendControlEvent = overrides.requestJsonRpcControlEvent ?? requestJsonRpcControlEvent;
  const refreshGeneration = ++RUNTIME.providerStatusRefreshGeneration;
  set({ providerStatusRefreshing: true });
  const results = await Promise.allSettled([
    sendControlEvent(get, set, workspaceId, "cowork/provider/status/refresh", { cwd: path }),
    sendControlEvent(get, set, workspaceId, "cowork/provider/catalog/read", { cwd: path }),
    sendControlEvent(get, set, workspaceId, "cowork/provider/authMethods/read", { cwd: path }),
  ]);
  const allSucceeded = results.every((result) => result.status === "fulfilled" && result.value);
  set((s) => ({
    ...(refreshGeneration === RUNTIME.providerStatusRefreshGeneration ? { providerStatusRefreshing: false } : {}),
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

export function createProviderActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "connectProvider" | "setProviderApiKey" | "copyProviderApiKey" | "authorizeProviderAuth" | "logoutProviderAuth" | "callbackProviderAuth" | "requestProviderCatalog" | "requestProviderAuthMethods" | "refreshProviderStatus" | "setLmStudioEnabled" | "setLmStudioModelVisible"> {
  const resolveProviderWorkspaceId = (): string | null =>
    get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;

  const notifyProviderControlUnavailable = (detail: string) => {
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "Not connected",
        detail,
      }),
    }));
  };

  const ensureProviderControlReady = async (opts?: { notifyDetail?: string }): Promise<string | null> => {
    const workspaceId = resolveProviderWorkspaceId();
    if (!workspaceId) {
      if (opts?.notifyDetail) notifyProviderControlUnavailable(opts.notifyDetail);
      return null;
    }

    await ensureServerRunning(get, set, workspaceId);
    const socket = ensureControlSocket(get, set, workspaceId);
    if (!socket || !get().workspaceRuntimeById[workspaceId]?.controlSessionId) {
      return null;
    }

    return workspaceId;
  };

  return {
    connectProvider: async (provider, apiKey) => {
      if (provider === "lmstudio") {
        await get().setLmStudioEnabled(true);
        return;
      }

      const methods = providerAuthMethodsFor(get(), provider);
      const normalizedKey = (apiKey ?? "").trim();
  
      if (normalizedKey) {
        const apiMethod = methods.find((method) => method.type === "api") ?? { id: "api_key", type: "api", label: "API key" };
        await get().setProviderApiKey(provider, apiMethod.id, normalizedKey);
        return;
      }
  
      const oauthMethod = methods.find((method) => method.type === "oauth");
      if (oauthMethod) {
        set(() => ({
          providerLastAuthChallenge: null,
          providerLastAuthResult: null,
        }));
        await get().authorizeProviderAuth(provider, oauthMethod.id);
        if (oauthMethod.oauthMode !== "code") {
          await get().callbackProviderAuth(provider, oauthMethod.id);
        }
        return;
      }
  
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "API key required",
          detail: `Enter an API key to connect ${provider}.`,
        }),
      }));
    },
  

    setProviderApiKey: async (provider, methodId, apiKey) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      const trimmedKey = apiKey.trim();
      if (!trimmedKey) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing API key",
            detail: "Enter an API key before saving.",
          }),
        }));
        return;
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/auth/setApiKey", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        provider,
        methodId: methodId.trim() || "api_key",
        apiKey: trimmedKey,
      });
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to send provider_auth_set_api_key." }),
        }));
      }
    },

    copyProviderApiKey: async (provider, sourceProvider) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/auth/copyApiKey", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        provider,
        sourceProvider,
      });
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_copy_api_key.",
          }),
        }));
      }
    },
  

    authorizeProviderAuth: async (provider, methodId) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const normalizedMethodId = methodId.trim();
      if (!normalizedMethodId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing auth method",
            detail: "Choose an auth method before continuing.",
          }),
        }));
        return;
      }

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/auth/authorize", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        provider,
        methodId: normalizedMethodId,
      });
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_authorize.",
          }),
        }));
      }
    },

    logoutProviderAuth: async (provider) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/auth/logout", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        provider,
      });
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_logout.",
          }),
        }));
      }
    },
  

    callbackProviderAuth: async (provider, methodId, code) => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Workspace required",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const normalizedMethodId = methodId.trim();
      if (!normalizedMethodId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Missing auth method",
            detail: "Choose an auth method before continuing.",
          }),
        }));
        return;
      }

      set(() => ({
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
      }));

      const normalizedCode = code?.trim();

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/auth/callback", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        provider,
        methodId: normalizedMethodId,
        code: normalizedCode || undefined,
      });
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to send provider_auth_callback.",
          }),
        }));
      }
    },
  

    requestProviderCatalog: async () => {
      const workspaceId = await ensureProviderControlReady();
      if (!workspaceId) return;

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/catalog/read", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
      });
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

      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/provider/authMethods/read", {
        cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
      });
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

    requestUserConfig: async () => {
      const workspaceId = await ensureProviderControlReady();
      if (!workspaceId) return;

      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "user_config_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request global user config.",
          }),
        }));
      }
    },

  
    refreshProviderStatus: async () => {
      const workspaceId = await ensureProviderControlReady({
        notifyDetail: "Unable to refresh provider status.",
      });
      if (!workspaceId) return;

      const path = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      await refreshProviderStatusForWorkspace(get, set, workspaceId, path);
    },

    setGlobalOpenAiProxyBaseUrl: async (baseUrl) => {
      const workspaceId = await ensureProviderControlReady({
        notifyDetail: "Unable to update global user config.",
      });
      if (!workspaceId) return;

      const normalizedBaseUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
      set(() => ({
        pendingUserConfigSave: true,
        userConfigLastResult: null,
      }));

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "user_config_set",
        sessionId,
        config: {
          awsBedrockProxyBaseUrl: normalizedBaseUrl ? normalizedBaseUrl : null,
        },
      }));
      if (!ok) {
        const sessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId ?? "";
        set((s) => ({
          pendingUserConfigSave: false,
          userConfigLastResult: {
            type: "user_config_result",
            sessionId,
            ok: false,
            message: "Unable to update global user config.",
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to update global user config.",
          }),
        }));
      }
    },

    setLmStudioEnabled: async (enabled) => {
      const previousEnabled = get().providerUiState.lmstudio.enabled;
      set((s) => ({
        providerUiState: {
          ...s.providerUiState,
          lmstudio: {
            ...s.providerUiState.lmstudio,
            enabled,
          },
        },
      }));
      try {
        await persistNow(get);
      } catch (error) {
        console.error("Failed to persist LM Studio enabled state", error);
        set((s) => ({
          providerUiState: {
            ...s.providerUiState,
            lmstudio: {
              ...s.providerUiState.lmstudio,
              enabled: previousEnabled,
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Save failed",
            detail: "Unable to save LM Studio settings.",
          }),
        }));
        return;
      }
      if (enabled) {
        await get().refreshProviderStatus();
      }
    },

    setLmStudioModelVisible: async (modelId, visible) => {
      const normalizedModelId = modelId.trim();
      if (!normalizedModelId) return;
      const previousHiddenModels = get().providerUiState.lmstudio.hiddenModels;
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
      try {
        await persistNow(get);
      } catch (error) {
        console.error("Failed to persist LM Studio model visibility", error);
        set((s) => ({
          providerUiState: {
            ...s.providerUiState,
            lmstudio: {
              ...s.providerUiState.lmstudio,
              hiddenModels: previousHiddenModels,
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Save failed",
            detail: "Unable to save LM Studio model visibility.",
          }),
        }));
      }
    },
  
  };
}
