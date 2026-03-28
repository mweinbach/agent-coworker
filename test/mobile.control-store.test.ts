import { beforeEach, describe, expect, mock, test } from "bun:test";

import { useBackupStore } from "../apps/mobile/src/features/cowork/backupStore";
import { useMcpStore } from "../apps/mobile/src/features/cowork/mcpStore";
import { useProviderStore } from "../apps/mobile/src/features/cowork/providerStore";
import { setActiveCoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/runtimeClient";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

function createFakeClient(resolver: (method: string, params: unknown) => unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = mock(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    return resolver(method, params);
  });
  const resetTransportSession = mock(() => {});
  return {
    client: { call, resetTransportSession } as any,
    calls,
    resetTransportSession,
  };
}

const workspaceCwd = "/tmp/mobile-workspace";

function controlStateResult() {
  return {
    events: [
      {
        type: "config_updated",
        sessionId: "control-session",
        config: {
          provider: "google",
          model: "gemini-2.5-flash",
          workingDirectory: workspaceCwd,
        },
      },
      {
        type: "session_settings",
        sessionId: "control-session",
        enableMcp: true,
        enableMemory: true,
        memoryRequireApproval: false,
      },
      {
        type: "session_config",
        sessionId: "control-session",
        config: {
          backupsEnabled: true,
          providerOptions: {
            google: {
              nativeWebSearch: true,
            },
          },
        },
      },
    ],
  };
}

function workspaceBackupsEvent() {
  return {
    event: {
      type: "workspace_backups",
      sessionId: "control-session",
      workspacePath: workspaceCwd,
      backups: [],
    },
  };
}

beforeEach(() => {
  setActiveCoworkJsonRpcClient(null);
  useWorkspaceStore.getState().clear();
  useProviderStore.getState().clear();
  useBackupStore.getState().clear();
  useMcpStore.getState().clear();
  useWorkspaceStore.setState({ activeWorkspaceCwd: workspaceCwd });
});

describe("mobile control stores", () => {
  test("workspace store reads parsed control state and applies workspace defaults through the shared endpoints", async () => {
    const { client, calls } = createFakeClient((method) => {
      if (method === "cowork/session/state/read") {
        return controlStateResult();
      }
      if (method === "cowork/session/defaults/apply") {
        return {
          event: {
            type: "session_config",
            sessionId: "control-session",
            config: {
              backupsEnabled: false,
            },
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    setActiveCoworkJsonRpcClient(client);

    await useWorkspaceStore.getState().fetchControlState();
    expect(useWorkspaceStore.getState().controlSnapshot?.config?.provider).toBe("google");

    await useWorkspaceStore.getState().applyWorkspaceDefaults({
      config: {
        backupsEnabled: false,
      },
    });

    expect(calls.map((entry) => entry.method)).toEqual([
      "cowork/session/state/read",
      "cowork/session/defaults/apply",
      "cowork/session/state/read",
    ]);
    expect(calls[1]?.params).toEqual({
      cwd: workspaceCwd,
      config: {
        backupsEnabled: false,
      },
    });
  });

  test("workspace store resets the JSON-RPC session after switching workspaces", async () => {
    const { client, calls, resetTransportSession } = createFakeClient((method) => {
      if (method === "workspace/switch") {
        return {
          workspaceId: "ws_2",
          name: "Workspace Two",
          path: "/tmp/workspace-two",
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    setActiveCoworkJsonRpcClient(client);
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace One",
          path: workspaceCwd,
          createdAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
          yolo: false,
        },
        {
          id: "ws_2",
          name: "Workspace Two",
          path: "/tmp/workspace-two",
          createdAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
          yolo: false,
        },
      ],
      activeWorkspaceId: "ws_1",
      activeWorkspaceName: "Workspace One",
      activeWorkspaceCwd: workspaceCwd,
    });

    await useWorkspaceStore.getState().switchWorkspace("ws_2");

    expect(calls).toEqual([{
      method: "workspace/switch",
      params: { workspaceId: "ws_2" },
    }]);
    expect(resetTransportSession).toHaveBeenCalledWith("Workspace switched.");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws_2");
    expect(useWorkspaceStore.getState().activeWorkspaceCwd).toBe("/tmp/workspace-two");
  });

  test("workspace store rethrows switch failures after recording the error", async () => {
    const { client, resetTransportSession } = createFakeClient((method) => {
      if (method === "workspace/switch") {
        throw new Error("Workspace switch failed");
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    setActiveCoworkJsonRpcClient(client);
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws_1",
        name: "Workspace One",
        path: workspaceCwd,
        createdAt: new Date(0).toISOString(),
        lastOpenedAt: new Date(0).toISOString(),
        yolo: false,
      }],
      activeWorkspaceId: "ws_1",
      activeWorkspaceName: "Workspace One",
      activeWorkspaceCwd: workspaceCwd,
    });

    await expect(useWorkspaceStore.getState().switchWorkspace("ws_1")).rejects.toThrow("Workspace switch failed");
    expect(useWorkspaceStore.getState().error).toBe("Workspace switch failed");
    expect(resetTransportSession).not.toHaveBeenCalled();
  });

  test("provider store uses status refresh and API key auth methods", async () => {
    const { client, calls } = createFakeClient((method) => {
      switch (method) {
        case "cowork/provider/status/refresh":
          return {
            event: {
              type: "provider_status",
              sessionId: "control-session",
              providers: [{
                provider: "google",
                authorized: false,
                verified: false,
                mode: "missing",
                account: null,
                message: "Missing credentials",
                checkedAt: new Date(0).toISOString(),
              }],
            },
          };
        case "cowork/provider/catalog/read":
          return {
            event: {
              type: "provider_catalog",
              sessionId: "control-session",
              all: [{
                id: "google",
                name: "Google",
                models: [{
                  id: "gemini-2.5-flash",
                  displayName: "Gemini 2.5 Flash",
                  knowledgeCutoff: "Unknown",
                  supportsImageInput: true,
                }],
                defaultModel: "gemini-2.5-flash",
              }],
              default: {
                google: "gemini-2.5-flash",
              },
              connected: [],
            },
          };
        case "cowork/provider/authMethods/read":
          return {
            event: {
              type: "provider_auth_methods",
              sessionId: "control-session",
              methods: {
                google: [{
                  id: "api-key",
                  type: "api",
                  label: "API key",
                }],
              },
            },
          };
        case "cowork/provider/auth/setApiKey":
          return {
            event: {
              type: "provider_auth_result",
              sessionId: "control-session",
              provider: "google",
              methodId: "api-key",
              ok: true,
              mode: "api_key",
              message: "Saved",
            },
          };
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    });
    setActiveCoworkJsonRpcClient(client);

    await useProviderStore.getState().fetchStatus();
    await useProviderStore.getState().setApiKey("google", "api-key", "secret-key");

    expect(calls[0]?.method).toBe("cowork/provider/status/refresh");
    expect(calls[1]?.method).toBe("cowork/provider/auth/setApiKey");
    expect(calls.slice(2).map((entry) => entry.method).sort()).toEqual([
      "cowork/provider/authMethods/read",
      "cowork/provider/catalog/read",
      "cowork/provider/status/refresh",
    ]);
  });

  test("backup store uses workspace backup endpoints for read and mutations", async () => {
    const { client, calls } = createFakeClient((method) => {
      if (
        method === "cowork/backups/workspace/read"
        || method === "cowork/backups/workspace/checkpoint"
        || method === "cowork/backups/workspace/restore"
        || method === "cowork/backups/workspace/deleteCheckpoint"
        || method === "cowork/backups/workspace/deleteEntry"
      ) {
        return workspaceBackupsEvent();
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    setActiveCoworkJsonRpcClient(client);

    await useBackupStore.getState().fetchBackups();
    await useBackupStore.getState().createCheckpoint("session-1");
    await useBackupStore.getState().restoreBackup("session-1", "cp-1");
    await useBackupStore.getState().deleteCheckpoint("session-1", "cp-1");
    await useBackupStore.getState().deleteEntry("session-1");

    expect(calls.map((entry) => entry.method)).toEqual([
      "cowork/backups/workspace/read",
      "cowork/backups/workspace/checkpoint",
      "cowork/backups/workspace/restore",
      "cowork/backups/workspace/deleteCheckpoint",
      "cowork/backups/workspace/deleteEntry",
    ]);
  });

  test("MCP store reads and validates servers through the control endpoints", async () => {
    const { client, calls } = createFakeClient((method) => {
      if (method === "cowork/mcp/servers/read") {
        return {
          event: {
            type: "mcp_servers",
            sessionId: "control-session",
            servers: [{
              name: "docs",
              transport: {
                type: "stdio",
                command: "uvx",
              },
              source: "workspace",
              inherited: false,
              authMode: "none",
              authScope: "workspace",
              authMessage: "Ready",
            }],
            legacy: {
              workspace: {
                path: `${workspaceCwd}/.cowork/mcp-legacy.json`,
                exists: false,
              },
              user: {
                path: "/tmp/user/.cowork/mcp-legacy.json",
                exists: false,
              },
            },
            files: [],
          },
        };
      }
      if (method === "cowork/mcp/server/validate") {
        return {
          event: {
            type: "mcp_server_validation",
            sessionId: "control-session",
            name: "docs",
            ok: true,
            mode: "none",
            message: "Validated",
            toolCount: 3,
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    setActiveCoworkJsonRpcClient(client);

    await useMcpStore.getState().fetchServers();
    await useMcpStore.getState().validateServer("docs");

    expect(calls.map((entry) => entry.method)).toEqual([
      "cowork/mcp/servers/read",
      "cowork/mcp/server/validate",
    ]);
    expect(useMcpStore.getState().validationByName.docs?.toolCount).toBe(3);
  });
});
