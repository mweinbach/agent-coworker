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
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

export function createProviderActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "connectProvider" | "setProviderApiKey" | "authorizeProviderAuth" | "callbackProviderAuth" | "requestProviderCatalog" | "requestProviderAuthMethods" | "refreshProviderStatus"> {
  return {
    connectProvider: async (provider, apiKey) => {
      const methods = providerAuthMethodsFor(get(), provider);
      const normalizedKey = (apiKey ?? "").trim();
  
      if (normalizedKey) {
        const apiMethod = methods.find((method) => method.type === "api") ?? { id: "api_key", type: "api", label: "API key" };
        await get().setProviderApiKey(provider, apiMethod.id, normalizedKey);
        return;
      }
  
      const oauthMethod = methods.find((method) => method.type === "oauth");
      if (oauthMethod) {
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
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_set_api_key",
        sessionId,
        provider,
        methodId: methodId.trim() || "api_key",
        apiKey: trimmedKey,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to send provider_auth_set_api_key." }),
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
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_authorize",
        sessionId,
        provider,
        methodId: normalizedMethodId,
      }));
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
  
      const normalizedCode = code?.trim();
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "provider_auth_callback",
        sessionId,
        provider,
        methodId: normalizedMethodId,
        code: normalizedCode || undefined,
      }));
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
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_catalog_get", sessionId }));
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
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_auth_methods_get", sessionId }));
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
  

    refreshProviderStatus: async () => {
      const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
  
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      set({ providerStatusRefreshing: true });
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      const sock = RUNTIME.controlSockets.get(workspaceId);
      if (!sid || !sock) {
        set({ providerStatusRefreshing: false });
        return;
      }
  
      try {
        sock.send({ type: "refresh_provider_status", sessionId: sid });
        sock.send({ type: "provider_catalog_get", sessionId: sid });
        sock.send({ type: "provider_auth_methods_get", sessionId: sid });
      } catch {
        set((s) => ({
          providerStatusRefreshing: false,
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to refresh provider status." }),
        }));
      }
    },
  
  };
}
