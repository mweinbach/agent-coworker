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

export function createWorkspaceMcpActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "requestWorkspaceMcpServers" | "upsertWorkspaceMcpServer" | "deleteWorkspaceMcpServer" | "validateWorkspaceMcpServer" | "authorizeWorkspaceMcpServerAuth" | "callbackWorkspaceMcpServerAuth" | "setWorkspaceMcpServerApiKey" | "migrateWorkspaceMcpLegacy"> {
  return {
    requestWorkspaceMcpServers: async (workspaceId: string) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "mcp_servers_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request MCP servers.",
          }),
        }));
      }
    },


    upsertWorkspaceMcpServer: async (workspaceId, server, previousName) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_upsert",
        sessionId,
        server,
        previousName,
      }));
      if (ok) return;

      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to save MCP server.",
        }),
      }));
    },


    deleteWorkspaceMcpServer: async (workspaceId, name) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_delete",
        sessionId,
        name,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to delete MCP server.",
        }),
      }));
    },


    validateWorkspaceMcpServer: async (workspaceId, name) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_validate",
        sessionId,
        name,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to validate MCP server.",
        }),
      }));
    },


    authorizeWorkspaceMcpServerAuth: async (workspaceId, name) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_auth_authorize",
        sessionId,
        name,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to start MCP auth flow.",
        }),
      }));
    },


    callbackWorkspaceMcpServerAuth: async (workspaceId, name, code) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_server_auth_callback",
        sessionId,
        name,
        code: code?.trim() ? code.trim() : undefined,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to complete MCP auth callback.",
        }),
      }));
    },


    setWorkspaceMcpServerApiKey: async (workspaceId, name, apiKey) => {
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
        type: "mcp_server_auth_set_api_key",
        sessionId,
        name,
        apiKey: trimmedKey,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to save MCP API key.",
        }),
      }));
    },


    migrateWorkspaceMcpLegacy: async (workspaceId, scope) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "mcp_servers_migrate_legacy",
        sessionId,
        scope,
      }));
      if (ok) return;
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to migrate legacy MCP servers.",
        }),
      }));
    },
  
  };
}
