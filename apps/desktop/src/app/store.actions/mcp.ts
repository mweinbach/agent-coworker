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

export function createWorkspaceMcpActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "requestWorkspaceMcpServers"
  | "upsertWorkspaceMcpServer"
  | "deleteWorkspaceMcpServer"
  | "validateWorkspaceMcpServer"
  | "authorizeWorkspaceMcpServerAuth"
  | "callbackWorkspaceMcpServerAuth"
  | "setWorkspaceMcpServerApiKey"
  | "migrateWorkspaceMcpLegacy"
> {
  return {
    requestWorkspaceMcpServers: async (workspaceId: string) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/servers/read",
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
            detail: "Unable to request MCP servers.",
          }),
        }));
      }
    },

    upsertWorkspaceMcpServer: async (workspaceId, server, previousName) => {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/server/upsert",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          server,
          previousName,
        },
      );
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
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/server/delete",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          name,
        },
      );
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
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/server/validate",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          name,
        },
      );
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
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/server/auth/authorize",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          name,
        },
      );
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
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/server/auth/callback",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          name,
          code: code?.trim() ? code.trim() : undefined,
        },
      );
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
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/server/auth/setApiKey",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          name,
          apiKey: trimmedKey,
        },
      );
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
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/mcp/legacy/migrate",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          scope,
        },
      );
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
