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

export function createWorkspaceMcpActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "requestWorkspaceMcpServers"
  | "upsertWorkspaceMcpServer"
  | "deleteWorkspaceMcpServer"
  | "setWorkspaceMcpServerEnabled"
  | "validateWorkspaceMcpServer"
  | "authorizeWorkspaceMcpServerAuth"
  | "callbackWorkspaceMcpServerAuth"
  | "setWorkspaceMcpServerApiKey"
> {
  const workspaceCwd = (workspaceId: string) =>
    get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;

  const requestMcpOperation = async (options: {
    workspaceId: string;
    key: string;
    label: string;
    errorTitle: string;
    errorMessage: string;
    method: string;
    params: Record<string, unknown>;
    optimistic?: () => (() => void) | undefined;
  }) =>
    await runAcknowledgedOperation(get, set, {
      key: options.key,
      label: options.label,
      errorTitle: options.errorTitle,
      errorMessage: options.errorMessage,
      optimistic: options.optimistic,
      execute: async () => {
        await ensureServerRunning(get, set, options.workspaceId);
        ensureControlSocket(get, set, options.workspaceId);
        const rpcError: { message?: string } = {};
        const ok = await requestJsonRpcControlEvent(
          get,
          set,
          options.workspaceId,
          options.method,
          {
            cwd: workspaceCwd(options.workspaceId),
            ...options.params,
          },
          rpcError,
        );
        if (!ok) {
          throw new Error(rpcError.message?.trim() || options.errorMessage);
        }
      },
    });

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
          cwd: workspaceCwd(workspaceId),
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

    upsertWorkspaceMcpServer: async (workspaceId, server, previousName, source = "workspace") => {
      return await requestMcpOperation({
        workspaceId,
        key: operationKey("mcp", "save", workspaceId),
        label: "Save connector",
        errorTitle: "Connector not saved",
        errorMessage: "Unable to save MCP server.",
        method: "cowork/mcp/server/upsert",
        params: { source, server, previousName },
      });
    },

    deleteWorkspaceMcpServer: async (workspaceId, name, source = "workspace") => {
      return await requestMcpOperation({
        workspaceId,
        key: operationKey("mcp", "delete", workspaceId, source, name),
        label: "Remove connector",
        errorTitle: "Connector not removed",
        errorMessage: "Unable to delete MCP server.",
        method: "cowork/mcp/server/delete",
        params: { source, name },
      });
    },

    setWorkspaceMcpServerEnabled: async (workspaceId, server) => {
      const matchesServer = (candidate: {
        name: string;
        source: string;
        pluginId?: string;
        pluginScope?: string;
      }) =>
        candidate.name === server.name &&
        candidate.source === server.source &&
        candidate.pluginId === server.pluginId &&
        candidate.pluginScope === server.pluginScope;
      return await requestMcpOperation({
        workspaceId,
        key: operationKey(
          "mcp",
          "enabled",
          workspaceId,
          server.source,
          server.pluginScope,
          server.pluginId,
          server.name,
        ),
        label: "Update connector",
        errorTitle: "Connector not updated",
        errorMessage: "Unable to update MCP server.",
        method: "cowork/mcp/server/setEnabled",
        params: {
          name: server.name,
          source: server.source,
          enabled: server.enabled,
          ...(server.pluginId ? { pluginId: server.pluginId } : {}),
          ...(server.pluginScope ? { pluginScope: server.pluginScope } : {}),
        },
        optimistic: () => {
          const previous = get().workspaceRuntimeById[workspaceId]?.mcpServers.find(matchesServer);
          set((state) => ({
            workspaceRuntimeById: {
              ...state.workspaceRuntimeById,
              [workspaceId]: {
                ...state.workspaceRuntimeById[workspaceId],
                mcpServers:
                  state.workspaceRuntimeById[workspaceId]?.mcpServers.map((candidate) =>
                    matchesServer(candidate)
                      ? { ...candidate, enabled: server.enabled }
                      : candidate,
                  ) ?? [],
              },
            },
          }));
          return () => {
            set((state) => ({
              workspaceRuntimeById: {
                ...state.workspaceRuntimeById,
                [workspaceId]: {
                  ...state.workspaceRuntimeById[workspaceId],
                  mcpServers:
                    state.workspaceRuntimeById[workspaceId]?.mcpServers.map((candidate) =>
                      matchesServer(candidate)
                        ? { ...candidate, enabled: previous?.enabled !== false }
                        : candidate,
                    ) ?? [],
                },
              },
            }));
          };
        },
      });
    },

    validateWorkspaceMcpServer: async (workspaceId, name, source, plugin) => {
      return await requestMcpOperation({
        workspaceId,
        key: operationKey("mcp", "validate", workspaceId, source, plugin?.pluginId, name),
        label: "Test connector",
        errorTitle: "Connector test not started",
        errorMessage: "Unable to validate MCP server.",
        method: "cowork/mcp/server/validate",
        params: {
          name,
          ...(source ? { source } : {}),
          ...(plugin?.pluginId ? { pluginId: plugin.pluginId } : {}),
          ...(plugin?.pluginScope ? { pluginScope: plugin.pluginScope } : {}),
        },
      });
    },

    authorizeWorkspaceMcpServerAuth: async (workspaceId, name, source, plugin) => {
      return await requestMcpOperation({
        workspaceId,
        key: operationKey("mcp", "authorize", workspaceId, source, plugin?.pluginId, name),
        label: "Start connector sign-in",
        errorTitle: "Sign-in not started",
        errorMessage: "Unable to start MCP auth flow.",
        method: "cowork/mcp/server/auth/authorize",
        params: {
          name,
          ...(source ? { source } : {}),
          ...(plugin?.pluginId ? { pluginId: plugin.pluginId } : {}),
          ...(plugin?.pluginScope ? { pluginScope: plugin.pluginScope } : {}),
        },
      });
    },

    callbackWorkspaceMcpServerAuth: async (workspaceId, name, code, source, plugin) => {
      return await requestMcpOperation({
        workspaceId,
        key: operationKey("mcp", "callback", workspaceId, source, plugin?.pluginId, name),
        label: "Complete connector sign-in",
        errorTitle: "Sign-in not completed",
        errorMessage: "Unable to complete MCP auth callback.",
        method: "cowork/mcp/server/auth/callback",
        params: {
          name,
          ...(source ? { source } : {}),
          ...(plugin?.pluginId ? { pluginId: plugin.pluginId } : {}),
          ...(plugin?.pluginScope ? { pluginScope: plugin.pluginScope } : {}),
          code: code?.trim() ? code.trim() : undefined,
        },
      });
    },

    setWorkspaceMcpServerApiKey: async (workspaceId, name, apiKey, source, plugin) => {
      const trimmedKey = apiKey.trim();
      return await requestMcpOperation({
        workspaceId,
        key: operationKey("mcp", "api-key", workspaceId, source, plugin?.pluginId, name),
        label: "Save connector API key",
        errorTitle: trimmedKey ? "API key not saved" : "Missing API key",
        errorMessage: trimmedKey
          ? "Unable to save MCP API key."
          : "Enter an API key before saving.",
        method: "cowork/mcp/server/auth/setApiKey",
        params: {
          name,
          ...(source ? { source } : {}),
          ...(plugin?.pluginId ? { pluginId: plugin.pluginId } : {}),
          ...(plugin?.pluginScope ? { pluginScope: plugin.pluginScope } : {}),
          apiKey: trimmedKey,
        },
      });
    },
  };
}
