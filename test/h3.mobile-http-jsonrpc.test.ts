import { describe, expect, spyOn, test } from "bun:test";
import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import type { H3TrustedDeviceRecord } from "../src/server/transport/h3/pairing";
import { __internal } from "../src/server/transport/h3/server";

function trustedDevice(
  permissions: Partial<H3TrustedDeviceRecord["permissions"]> = {},
): H3TrustedDeviceRecord {
  return {
    deviceId: "phone-1",
    identityPub: "phone-identity",
    displayName: "Work Phone",
    fingerprint: "fingerprint",
    sessionTokenHash: "session-token-hash",
    lastPairedAt: "2026-05-26T00:00:00.000Z",
    lastConnectedAt: null,
    permissions: {
      ...__internal.DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
      ...permissions,
    },
  };
}

describe("H3 mobile HTTP JSON-RPC connection", () => {
  test("keeps initialization state across dispatched HTTP requests", async () => {
    let initialized = false;
    const closedConnectionIds: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        connection: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if (message.method === "initialize" && "id" in message) {
          connection.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          return;
        }
        if (message.method === "initialized") {
          initialized = true;
          return;
        }
        if ("id" in message) {
          connection.send(
            JSON.stringify(
              initialized
                ? { jsonrpc: "2.0", id: message.id, result: { ok: true } }
                : {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: -32002, message: "Not initialized" },
                  },
            ),
          );
        }
      },
      closeConnection(connection: { data: { connectionId: string } }) {
        closedConnectionIds.push(connection.data.connectionId);
      },
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    expect(connection.data.protocolMode).toBe("h3");
    expect(connection.data.selectedSubprotocol).toBe("cowork.jsonrpc.v1");

    await expect(
      connection.dispatch({ id: 1, method: "initialize", params: {} }),
    ).resolves.toMatchObject({ id: 1, result: {} });
    await expect(connection.dispatch({ method: "initialized" })).resolves.toBeNull();
    await expect(connection.dispatch({ id: 2, method: "thread/list" })).resolves.toMatchObject({
      id: 2,
      result: { ok: true },
    });

    connection.close();
    expect(closedConnectionIds).toEqual([connection.data.connectionId]);
  });

  test("accepts client responses from HTTP RPC without waiting for a reply", async () => {
    const handled: Array<JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse> =
      [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        _connection: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
      ) {
        handled.push(message);
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    await expect(
      connection.dispatch({ id: "server-request-1", result: { approved: true } }),
    ).resolves.toBeNull();

    expect(handled).toEqual([{ id: "server-request-1", result: { approved: true } }]);
    connection.close();
  });

  test("keeps server requests separate from HTTP responses with the same id", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const events: string[] = [];
    const decoder = new TextDecoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection.addEventSink(controller);
      },
    });
    const reader = stream.getReader();
    await reader.read();
    const response = connection.dispatch({ id: "shared-id", method: "thread/resume" });
    const received = reader.read().then(({ value }) => {
      if (value) events.push(decoder.decode(value));
    });

    try {
      connection.send(
        JSON.stringify({
          id: "shared-id",
          method: "item/commandExecution/requestApproval",
          params: { command: "echo hello" },
        }),
      );
      connection.send(JSON.stringify({ id: "shared-id", result: { threadId: "thread-1" } }));

      await expect(response).resolves.toEqual({
        id: "shared-id",
        result: { threadId: "thread-1" },
      });
      await received;
      expect(events[0]).toContain("item/commandExecution/requestApproval");
    } finally {
      connection.close();
      await received;
    }
  });

  test("rejects duplicate in-flight HTTP request ids without dispatching or replacing the first", async () => {
    const handled: JsonRpcLiteRequest[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(_connection: unknown, message: JsonRpcLiteRequest) {
        handled.push(message);
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const schedule = spyOn(globalThis, "setTimeout");
    const first = connection.dispatch({ id: 7, method: "thread/read", params: { threadId: "A" } });
    const duplicate = connection.dispatch({
      id: 7,
      method: "thread/read",
      params: { threadId: "B" },
    });
    const outcomes = Promise.allSettled([first, duplicate]);

    try {
      expect(handled).toEqual([{ id: 7, method: "thread/read", params: { threadId: "A" } }]);
      connection.send(JSON.stringify({ id: 7, result: { threadId: "A" } }));

      await expect(first).resolves.toEqual({ id: 7, result: { threadId: "A" } });
      await expect(duplicate).rejects.toThrow("already pending");
    } finally {
      connection.close();
      // Drive a leaked deadline if this regression fails before the waiter is cleaned up.
      for (const [callback, delay] of schedule.mock.calls) {
        if (delay === 30_000 && typeof callback === "function") callback();
      }
      await outcomes;
      schedule.mockRestore();
    }
  });

  test("does not remove a reused request id while finishing the previous HTTP response", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const schedule = spyOn(globalThis, "setTimeout");
    const first = connection.dispatch({ id: "reused", method: "thread/read" });
    connection.send(JSON.stringify({ id: "reused", result: "first" }));
    const next = connection.dispatch({ id: "reused", method: "thread/read" });
    const outcomes = Promise.allSettled([first, next]);

    try {
      await first;
      connection.send(JSON.stringify({ id: "reused", result: "next" }));
      connection.close();
      for (const [callback, delay] of schedule.mock.calls) {
        if (delay === 30_000 && typeof callback === "function") callback();
      }
      await expect(next).resolves.toEqual({ id: "reused", result: "next" });
    } finally {
      connection.close();
      for (const [callback, delay] of schedule.mock.calls) {
        if (delay === 30_000 && typeof callback === "function") callback();
      }
      await outcomes;
      schedule.mockRestore();
    }
  });

  test("returns an empty transport ack for notifications", async () => {
    const handled: Array<JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse> =
      [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        _connection: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
      ) {
        handled.push(message);
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { method: "initialized" },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
    expect(handled).toEqual([{ method: "initialized" }]);
    connection.close();
  });

  test("records workspace-control event access from current trusted device permissions", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    expect(connection.data.workspaceControlEventsAllowed).toBe(false);

    const defaultResponse = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "initialize", params: { cwd: "/tmp" } },
      connection,
      trustedDevice(),
    );
    expect(defaultResponse.status).toBe(200);
    expect(connection.data.workspaceControlEventsAllowed).toBe(false);

    const allowedResponse = await __internal.dispatchHttpRpcPayload(
      { id: 2, method: "initialize", params: { cwd: "/tmp" } },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );
    expect(allowedResponse.status).toBe(200);
    expect(connection.data.workspaceControlEventsAllowed).toBe(true);

    connection.close();
  });

  test("records task read/mutation flags from current trusted device permissions", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    expect(connection.data.taskReadAllowed).toBeUndefined();
    expect(connection.data.taskMutationAllowed).toBeUndefined();

    await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "initialize", params: {} },
      connection,
      trustedDevice(),
    );
    expect(connection.data.taskReadAllowed).toBe(false);
    expect(connection.data.taskMutationAllowed).toBe(false);

    await __internal.dispatchHttpRpcPayload(
      { id: 2, method: "initialize", params: {} },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(connection.data.taskReadAllowed).toBe(true);
    expect(connection.data.taskMutationAllowed).toBe(false);

    await __internal.dispatchHttpRpcPayload(
      { id: 3, method: "initialize", params: {} },
      connection,
      trustedDevice({ conversations: true, turns: true }),
    );
    expect(connection.data.taskReadAllowed).toBe(true);
    expect(connection.data.taskMutationAllowed).toBe(true);

    // Turns without conversations is not enough to mutate tasks.
    await __internal.dispatchHttpRpcPayload(
      { id: 4, method: "initialize", params: {} },
      connection,
      trustedDevice({ turns: true }),
    );
    expect(connection.data.taskReadAllowed).toBe(false);
    expect(connection.data.taskMutationAllowed).toBe(false);
    connection.close();
  });

  test("requires workspace settings permission for plugin deletion", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("plugin delete must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/plugins/delete",
        params: { pluginId: "figma-toolkit", scope: "user" },
      },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/plugins/delete",
        params: { pluginId: "figma-toolkit" },
      }),
    ).toBe("workspaceSettings");
    connection.close();
  });

  test("blocks MCP server config reads for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("mcp servers read must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/mcp/servers/read", params: { workspaceId: "ws-1" } },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    // The read is never an always-allowed default; it requires workspaceSettings.
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/mcp/servers/read",
        params: {},
      }),
    ).toBe("workspaceSettings");
    connection.close();
  });

  test("allows MCP server config reads for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { event: { type: "mcp_servers", servers: [] } },
            }),
          );
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/mcp/servers/read", params: { workspaceId: "ws-1" } },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      result: { event: { type: "mcp_servers" } },
    });
    expect(dispatchedMethods).toContain("cowork/mcp/servers/read");
    connection.close();
  });

  test("blocks MCP server validation (stdio spawn) for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("mcp validate must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/mcp/server/validate", params: { workspaceId: "ws-1", name: "fs" } },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    // Validation starts the configured stdio MCP command, so it must never be an
    // always-allowed default; it requires workspaceSettings.
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/mcp/server/validate",
        params: { name: "fs" },
      }),
    ).toBe("workspaceSettings");
    connection.close();
  });

  test("allows MCP server validation for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { event: { type: "mcp_server_validation", name: "fs", ok: true } },
            }),
          );
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/mcp/server/validate", params: { workspaceId: "ws-1", name: "fs" } },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      result: { event: { type: "mcp_server_validation", name: "fs" } },
    });
    expect(dispatchedMethods).toContain("cowork/mcp/server/validate");
    connection.close();
  });

  test.each(["cowork/mcp/server/auth/setApiKey", "cowork/mcp/server/auth/callback"])(
    "requires auth and workspace permissions before %s can dispatch implicit validation",
    async (method) => {
      const dispatchedMethods: string[] = [];
      const runtime = {
        openHttpConnection() {},
        handleDecodedMessage(
          connection: { send(message: string): number },
          request: JsonRpcLiteRequest,
        ) {
          dispatchedMethods.push(request.method);
          connection.send(JSON.stringify({ id: request.id, result: { ok: true } }));
        },
        closeConnection() {},
      };
      const connection = __internal.createHttpJsonRpcConnection(runtime as never);
      const request = {
        id: 1,
        method,
        params: {
          name: "configured-command",
          ...(method.endsWith("setApiKey") ? { apiKey: "test-key" } : { code: "test-code" }),
        },
      };
      try {
        const authOnly = await __internal.dispatchHttpRpcPayload(
          request,
          connection,
          trustedDevice({ mcpAuth: true }),
        );
        expect(authOnly.status).toBe(403);
        await expect(authOnly.json()).resolves.toMatchObject({ permission: "workspaceSettings" });
        expect(dispatchedMethods).toEqual([]);

        const settingsOnly = await __internal.dispatchHttpRpcPayload(
          request,
          connection,
          trustedDevice({ workspaceSettings: true }),
        );
        expect(settingsOnly.status).toBe(403);
        await expect(settingsOnly.json()).resolves.toMatchObject({ permission: "mcpAuth" });
        expect(dispatchedMethods).toEqual([]);

        const allowed = await __internal.dispatchHttpRpcPayload(
          request,
          connection,
          trustedDevice({ mcpAuth: true, workspaceSettings: true }),
        );
        expect(allowed.status).toBe(200);
        expect(dispatchedMethods).toEqual([method]);
      } finally {
        connection.close();
      }
    },
  );

  test("blocks memory reads for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("memory list must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/memory/list", params: { workspaceId: "ws-1", scope: "user" } },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    // Memory holds long-lived private content, so it is never an always-allowed
    // default read; it requires workspaceSettings.
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/memory/list",
        params: { scope: "user" },
      }),
    ).toBe("workspaceSettings");
    // Advanced memory reads cross the same boundary.
    expect(
      __internal.getRequiredH3Permission({
        id: 3,
        method: "cowork/memory/advanced/list",
        params: {},
      }),
    ).toBe("workspaceSettings");
    connection.close();
  });

  test("allows memory reads for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { event: { type: "memory_list", entries: [] } },
            }),
          );
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/memory/list", params: { workspaceId: "ws-1" } },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      result: { event: { type: "memory_list" } },
    });
    expect(dispatchedMethods).toContain("cowork/memory/list");
    connection.close();
  });

  test("blocks plugin install preview for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("plugin install preview must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/plugins/install/preview",
        params: { workspaceId: "ws-1", sourceInput: "/etc", targetScope: "workspace" },
      },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    // Preview materializes an attacker-selectable source, so it requires
    // workspaceSettings and is never an always-allowed default.
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/plugins/install/preview",
        params: { sourceInput: "/etc" },
      }),
    ).toBe("workspaceSettings");
    // Passive plugin catalog/detail reads remain always-allowed (null permission).
    expect(
      __internal.getRequiredH3Permission({ id: 3, method: "cowork/plugins/read", params: {} }),
    ).toBeNull();
    expect(
      __internal.getRequiredH3Permission({
        id: 4,
        method: "cowork/plugins/catalog/read",
        params: {},
      }),
    ).toBeNull();
    connection.close();
  });

  test("allows plugin install preview for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { event: { type: "plugin_install_preview", candidates: [] } },
            }),
          );
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/plugins/install/preview",
        params: { workspaceId: "ws-1", sourceInput: "owner/repo", targetScope: "workspace" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      result: { event: { type: "plugin_install_preview" } },
    });
    expect(dispatchedMethods).toContain("cowork/plugins/install/preview");
    connection.close();
  });

  test("blocks presentation preview (slide-module execution) for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("presentation preview must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/workspace/presentation/preview",
        params: { workspaceId: "ws-1", path: "slide-1.mjs" },
      },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    // Preview executes a workspace slide module on the host, so it requires
    // workspaceSettings and is never an always-allowed default.
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/workspace/presentation/preview",
        params: { path: "slide-1.mjs" },
      }),
    ).toBe("workspaceSettings");
    // Listing workspaces stays always-allowed (the gate is targeted, not the
    // whole workspace surface).
    expect(
      __internal.getRequiredH3Permission({ id: 3, method: "workspace/list", params: {} }),
    ).toBeNull();
    connection.close();
  });

  test("allows presentation preview for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { slides: [] } }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/workspace/presentation/preview",
        params: { workspaceId: "ws-1", path: "slide-1.mjs" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 1, result: { slides: [] } });
    expect(dispatchedMethods).toContain("cowork/workspace/presentation/preview");
    connection.close();
  });

  test("blocks skill install preview for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("skill install preview must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/skills/install/preview",
        params: { workspaceId: "ws-1", sourceInput: "/etc", targetScope: "project" },
      },
      connection,
      trustedDevice(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    // Preview materializes an attacker-selectable source, so it requires
    // workspaceSettings and is never an always-allowed default.
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/skills/install/preview",
        params: { sourceInput: "/etc" },
      }),
    ).toBe("workspaceSettings");
    // Passive skill catalog/list/detail/installation reads remain always-allowed.
    for (const passive of [
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "cowork/skills/read",
      "cowork/skills/installation/read",
    ]) {
      expect(__internal.getRequiredH3Permission({ id: 3, method: passive, params: {} })).toBeNull();
    }
    connection.close();
  });

  test("allows skill install preview for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { event: { type: "skill_install_preview", candidates: [] } },
            }),
          );
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/skills/install/preview",
        params: { workspaceId: "ws-1", sourceInput: "owner/repo", targetScope: "project" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      result: { event: { type: "skill_install_preview" } },
    });
    expect(dispatchedMethods).toContain("cowork/skills/install/preview");
    connection.close();
  });

  test("blocks spreadsheet reads (caller-selected cwd) for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("spreadsheet read must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    for (const method of [
      "cowork/workspace/spreadsheet/workbook",
      "cowork/workspace/spreadsheet/version",
    ]) {
      const response = await __internal.dispatchHttpRpcPayload(
        { id: 1, method, params: { cwd: "/", path: "secret.csv" } },
        connection,
        trustedDevice(),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Mobile device permission required: workspaceSettings.",
        permission: "workspaceSettings",
      });
      expect(__internal.getRequiredH3Permission({ id: 2, method, params: { cwd: "/" } })).toBe(
        "workspaceSettings",
      );
    }

    // Listing workspaces stays always-allowed (the gate is targeted, not the
    // whole workspace surface).
    expect(
      __internal.getRequiredH3Permission({ id: 3, method: "workspace/list", params: {} }),
    ).toBeNull();
    connection.close();
  });

  test("allows spreadsheet reads for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sheets: [] } }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/workspace/spreadsheet/workbook",
        params: { workspaceId: "ws-1", path: "data.xlsx" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 1, result: { sheets: [] } });
    expect(dispatchedMethods).toContain("cowork/workspace/spreadsheet/workbook");
    connection.close();
  });

  test("blocks canvas document RPCs for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("document RPC must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    for (const method of [
      "cowork/workspace/document/open",
      "cowork/workspace/document/revision",
      "cowork/workspace/document/save",
      "cowork/workspace/document/saveAs",
      "cowork/workspace/document/close",
    ]) {
      const response = await __internal.dispatchHttpRpcPayload(
        { id: 1, method, params: { path: "secret.txt" } },
        connection,
        trustedDevice(),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Mobile device permission required: workspaceSettings.",
        permission: "workspaceSettings",
      });
      expect(
        __internal.getRequiredH3Permission({ id: 2, method, params: { path: "secret.txt" } }),
      ).toBe("workspaceSettings");
    }

    expect(
      __internal.getRequiredH3Permission({ id: 3, method: "workspace/list", params: {} }),
    ).toBeNull();
    connection.close();
  });

  test("allows canvas document RPCs for devices granted workspaceSettings", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/workspace/document/open",
        params: { workspaceId: "ws-1", path: "notes.md" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 1, result: { ok: true } });
    expect(dispatchedMethods).toContain("cowork/workspace/document/open");
    connection.close();
  });

  test("blocks thread history reads for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("thread reads must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    for (const method of ["thread/list", "thread/read", "thread/hydrate", "thread/resume"]) {
      const response = await __internal.dispatchHttpRpcPayload(
        { id: 1, method, params: { threadId: "t-1" } },
        connection,
        trustedDevice(),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Mobile device permission required: conversations.",
        permission: "conversations",
      });
      expect(__internal.getRequiredH3Permission({ id: 2, method, params: {} })).toBe(
        "conversations",
      );
    }

    // Subscription teardown returns no content and stays always-allowed.
    expect(
      __internal.getRequiredH3Permission({ id: 3, method: "thread/unsubscribe", params: {} }),
    ).toBeNull();
    connection.close();
  });

  test("requires conversation and turn permissions for thread metadata setters", async () => {
    for (const method of ["thread/pinned/set", "thread/archived/set"]) {
      expect(__internal.getRequiredH3Permission({ id: 1, method, params: {} })).toEqual([
        "conversations",
        "turns",
      ]);
    }
  });

  test("allows thread history reads for devices granted conversations", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { threads: [], total: 0 } }),
          );
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "thread/list", params: {} },
      connection,
      trustedDevice({ conversations: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 1, result: { total: 0 } });
    expect(dispatchedMethods).toContain("thread/list");
    connection.close();
  });

  test("splits task reads from task mutations for mobile permissions", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("method" in message) {
          dispatchedMethods.push(message.method);
        }
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const defaultRead = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "task/list", params: {} },
      connection,
      trustedDevice(),
    );
    expect(defaultRead.status).toBe(403);
    await expect(defaultRead.json()).resolves.toEqual({
      error: "Mobile device permission required: conversations.",
      permission: "conversations",
    });

    const readOnly = await __internal.dispatchHttpRpcPayload(
      { id: 2, method: "task/read", params: { taskId: "task-1" } },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(readOnly.status).toBe(200);
    await expect(readOnly.json()).resolves.toMatchObject({ id: 2, result: { ok: true } });

    const deniedMutation = await __internal.dispatchHttpRpcPayload(
      {
        id: 3,
        method: "task/updateBrief",
        params: { taskId: "task-1", expectedRevision: 1, title: "Updated" },
      },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(deniedMutation.status).toBe(403);
    await expect(deniedMutation.json()).resolves.toEqual({
      error: "Mobile device permission required: turns.",
      permission: "turns",
    });

    const artifactRead = await __internal.dispatchHttpRpcPayload(
      {
        id: 4,
        method: "task/artifact/read",
        params: { taskId: "task-1", artifactId: "artifact-1" },
      },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(artifactRead.status).toBe(403);
    await expect(artifactRead.json()).resolves.toEqual({
      error: "Mobile device permission required: turns.",
      permission: "turns",
    });

    const allowedMutation = await __internal.dispatchHttpRpcPayload(
      {
        id: 5,
        method: "task/updateBrief",
        params: { taskId: "task-1", expectedRevision: 1, title: "Updated" },
      },
      connection,
      trustedDevice({ conversations: true, turns: true }),
    );
    expect(allowedMutation.status).toBe(200);
    await expect(allowedMutation.json()).resolves.toMatchObject({ id: 5, result: { ok: true } });
    expect(dispatchedMethods).toEqual(["task/read", "task/updateBrief"]);
    expect(__internal.getRequiredH3Permission({ id: 6, method: "task/list", params: {} })).toBe(
      "conversations",
    );
    expect(
      __internal.getRequiredH3Permission({
        id: 7,
        method: "task/artifact/read",
        params: {},
      }),
    ).toEqual(["conversations", "turns"]);
    expect(
      __internal.getRequiredH3Permission({
        id: 8,
        method: "task/updateBrief",
        params: {},
      }),
    ).toEqual(["conversations", "turns"]);
    connection.close();
  });

  test("blocks workspace state/config reads for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("workspace state read must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/session/state/read", params: { cwd: "/tmp" } },
      connection,
      trustedDevice(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/session/state/read",
        params: {},
      }),
    ).toBe("workspaceSettings");
    connection.close();
  });

  test("workspace bootstrap requires both workspaceSettings and conversations", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { threads: [] } }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    // bootstrap returns workspace config AND thread summaries, so it requires both.
    expect(
      __internal.getRequiredH3Permission({
        id: 1,
        method: "cowork/workspace/bootstrap",
        params: {},
      }),
    ).toEqual(["workspaceSettings", "conversations"]);

    // Missing workspaceSettings -> 403 on the first missing permission.
    const noSettings = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/workspace/bootstrap", params: { cwd: "/tmp" } },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(noSettings.status).toBe(403);
    await expect(noSettings.json()).resolves.toMatchObject({ permission: "workspaceSettings" });

    // Has workspaceSettings but missing conversations -> 403 on conversations.
    const noConversations = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/workspace/bootstrap", params: { cwd: "/tmp" } },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );
    expect(noConversations.status).toBe(403);
    await expect(noConversations.json()).resolves.toMatchObject({ permission: "conversations" });

    // Both granted -> reaches the runtime.
    const allowed = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "cowork/workspace/bootstrap", params: { cwd: "/tmp" } },
      connection,
      trustedDevice({ workspaceSettings: true, conversations: true }),
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ id: 1, result: { threads: [] } });
    connection.close();
  });

  test("emits periodic SSE keepalive comments while event sinks are open", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never, {
      keepaliveIntervalMs: 20,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection.addEventSink(controller);
      },
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toContain(": cowork events");

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const keepalive = await reader.read();
    expect(keepalive.done).toBe(false);
    expect(decoder.decode(keepalive.value)).toContain(": keepalive");

    connection.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test("closes active event streams when the HTTP JSON-RPC connection closes", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection.addEventSink(controller);
      },
    });
    const reader = stream.getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    connection.close();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test("rejects pending RPC requests when the HTTP JSON-RPC connection closes", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const pending = __internal.dispatchHttpRpcPayload(
      { id: 1, method: "thread/list" },
      connection,
      // thread/list now requires the conversations permission; grant it so the
      // request reaches dispatch and we can exercise the connection-close path.
      trustedDevice({ conversations: true }),
    );

    connection.close();

    const response = await pending;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "HTTP JSON-RPC connection closed.",
    });
  });

  test("returns 400 for malformed HTTP RPC payloads before dispatch", async () => {
    let handledMessages = 0;
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        handledMessages += 1;
        throw new Error("malformed payloads must not reach the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const malformedPayloadCases: Array<{
      name: string;
      raw: unknown;
      expectedError: string;
    }> = [
      {
        name: "null payload",
        raw: null,
        expectedError: "JSON-RPC payload must be an object.",
      },
      {
        name: "array payload",
        raw: [],
        expectedError: "JSON-RPC payload must be an object.",
      },
      {
        name: "missing method and id",
        raw: {},
        expectedError: "JSON-RPC method is required.",
      },
      {
        name: "blank method",
        raw: { method: "   " },
        expectedError: "JSON-RPC method is required.",
      },
      {
        name: "non-string method",
        raw: { method: 42 },
        expectedError: "JSON-RPC method is required.",
      },
      {
        name: "request with boolean id",
        raw: { id: true, method: "thread/list" },
        expectedError: "JSON-RPC id must be a string or number.",
      },
      {
        name: "response with null id",
        raw: { id: null, result: { ok: true } },
        expectedError: "JSON-RPC response id must be a string or number.",
      },
    ];

    for (const { name, raw, expectedError } of malformedPayloadCases) {
      const response = await __internal.dispatchHttpRpcPayload(raw, connection, trustedDevice());

      expect(response.status, name).toBe(400);
      await expect(response.json(), name).resolves.toEqual({ error: expectedError });
    }

    expect(handledMessages).toBe(0);
    connection.close();
  });

  test("rejects malformed pairing ticket payloads without throwing", () => {
    expect(__internal.decodePairingTicketForRequest("not-a-ticket")).toBeNull();
  });

  test("requires the admin bearer token before serving pairing tickets", async () => {
    const unauthorized = __internal.requireAdminToken(
      new Request("https://127.0.0.1:9443/ticket"),
      "admin-token",
    );
    expect(unauthorized?.status).toBe(401);
    await expect(unauthorized?.json()).resolves.toEqual({ error: "Unauthorized." });

    const authorized = __internal.requireAdminToken(
      new Request("https://127.0.0.1:9443/ticket", {
        headers: { authorization: "Bearer admin-token" },
      }),
      "admin-token",
    );
    expect(authorized).toBeNull();
  });

  test("brackets IPv6 host hints for advertised mobile H3 URLs", () => {
    expect(__internal.formatUrlHost("::1")).toBe("[::1]");
    expect(__internal.formatUrlHost("2001:db8::1")).toBe("[2001:db8::1]");
    expect(__internal.formatUrlHost("[2001:db8::1]")).toBe("[2001:db8::1]");
    expect(__internal.formatUrlHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
