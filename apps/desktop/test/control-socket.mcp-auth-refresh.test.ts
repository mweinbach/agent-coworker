import { describe, expect, test } from "bun:test";
import {
  createControlSocketHelpers,
  createState,
  deps,
  flushAsyncWork,
  installFakeSocket,
  RUNTIME,
  registerControlSocketLifecycleHooks,
} from "./control-socket.harness";

describe("control socket MCP OAuth refresh", () => {
  registerControlSocketLifecycleHooks();

  test("MCP auth negative acknowledgments return the domain failure", async () => {
    const workspaceId = "ws-mcp-auth-rejected";
    const { state, get, set } = createState(workspaceId);
    installFakeSocket(workspaceId, async (method) => {
      if (method !== "cowork/mcp/server/auth/callback") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        event: {
          type: "mcp_server_auth_result",
          sessionId: "jsonrpc-control",
          name: "DS Dev MCP",
          ok: false,
          mode: "error",
          message: "The authorization code was rejected.",
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const errorDetail: { message?: string } = {};
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/mcp/server/auth/callback",
      {
        cwd: "/tmp/workspace",
        name: "DS Dev MCP",
        source: "user",
        code: "invalid-code",
      },
      errorDetail,
    );

    expect(ok).toBe(false);
    expect(errorDetail.message).toBe("The authorization code was rejected.");
    expect(state.workspaceRuntimeById[workspaceId].mcpLastAuthResult).toMatchObject({
      type: "mcp_server_auth_result",
      ok: false,
    });
  });

  test("auto auth challenge starts polling MCP servers until OAuth completes", async () => {
    const workspaceId = "ws-mcp-oauth-poll";
    const { state, get, set } = createState(workspaceId);
    let readCalls = 0;

    installFakeSocket(workspaceId, async (method) => {
      if (method === "cowork/mcp/server/auth/authorize") {
        return {
          event: {
            type: "mcp_server_auth_challenge",
            sessionId: "jsonrpc-control",
            name: "DS Dev MCP",
            challenge: {
              method: "auto",
              instructions: "Complete sign-in in your browser.",
              url: "https://example.com/oauth",
            },
          },
        };
      }
      if (method === "cowork/mcp/servers/read") {
        readCalls += 1;
        return {
          event: {
            type: "mcp_servers",
            sessionId: "jsonrpc-control",
            servers: [
              {
                name: "DS Dev MCP",
                source: "user",
                enabled: true,
                transport: { type: "http", url: "https://example.com/mcp" },
                auth: { type: "oauth", oauthMode: "auto" },
                authMode: readCalls >= 2 ? "oauth" : "oauth_pending",
                authMessage:
                  readCalls >= 2 ? "OAuth token available." : "OAuth flow is waiting for callback.",
                tools: [],
              },
            ],
            files: [],
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/mcp/server/auth/authorize",
      {
        cwd: "/tmp/workspace",
        name: "DS Dev MCP",
        source: "user",
      },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].mcpLastAuthChallenge?.type).toBe(
      "mcp_server_auth_challenge",
    );

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flushAsyncWork();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flushAsyncWork();

    expect(readCalls).toBeGreaterThanOrEqual(2);
    expect(
      state.workspaceRuntimeById[workspaceId].mcpServers.find(
        (server) => server.name === "DS Dev MCP",
      )?.authMode,
    ).toBe("oauth");
    expect(RUNTIME.mcpOAuthRefreshPollGenerations.has(`${workspaceId}:DS Dev MCP`)).toBe(false);
  });

  test("successful MCP auth result refreshes MCP servers and stops polling", async () => {
    const workspaceId = "ws-mcp-oauth-result";
    const { state, get, set } = createState(workspaceId);
    state.workspaceRuntimeById[workspaceId].mcpServers = [
      {
        name: "DS Dev MCP",
        source: "user",
        enabled: true,
        transport: { type: "http", url: "https://example.com/mcp" },
        auth: { type: "oauth", oauthMode: "code" },
        authMode: "oauth_pending",
        authMessage: "OAuth flow is waiting for callback.",
        tools: [],
      },
    ] as any;
    const calls: string[] = [];
    installFakeSocket(workspaceId, async (method) => {
      calls.push(method);
      if (method === "cowork/mcp/server/auth/callback") {
        return {
          event: {
            type: "mcp_server_auth_result",
            sessionId: "jsonrpc-control",
            name: "DS Dev MCP",
            ok: true,
            mode: "oauth",
            message: "OAuth token exchange successful.",
          },
        };
      }
      if (method === "cowork/mcp/servers/read") {
        return {
          event: {
            type: "mcp_servers",
            sessionId: "jsonrpc-control",
            servers: [
              {
                name: "DS Dev MCP",
                source: "user",
                enabled: true,
                transport: { type: "http", url: "https://example.com/mcp" },
                auth: { type: "oauth", oauthMode: "code" },
                authMode: "oauth",
                authMessage: "OAuth token available.",
                tools: [],
              },
            ],
            files: [],
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    RUNTIME.mcpOAuthRefreshPollGenerations.set(`${workspaceId}:DS Dev MCP`, 1);

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/mcp/server/auth/callback",
      {
        cwd: "/tmp/workspace",
        name: "DS Dev MCP",
        source: "user",
        code: "oauth-code",
      },
    );
    await flushAsyncWork();

    expect(ok).toBe(true);
    expect(calls).toEqual(["cowork/mcp/server/auth/callback", "cowork/mcp/servers/read"]);
    expect(
      state.workspaceRuntimeById[workspaceId].mcpServers.find(
        (server) => server.name === "DS Dev MCP",
      )?.authMode,
    ).toBe("oauth");
    expect(RUNTIME.mcpOAuthRefreshPollGenerations.has(`${workspaceId}:DS Dev MCP`)).toBe(false);
  });
});
