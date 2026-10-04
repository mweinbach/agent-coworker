import { describe, expect, spyOn, test } from "bun:test";
import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import type { H3TrustedDeviceRecord } from "../src/server/transport/h3/pairing";
import { __internal } from "../src/server/transport/h3/server";

type RpcMessage = JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse;

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

function createConnection(
  handleDecodedMessage: (
    connection: { send(message: string): number },
    message: any,
  ) => void = () => {},
  opts?: { keepaliveIntervalMs?: number; onClose?: (id: string) => void },
) {
  return __internal.createHttpJsonRpcConnection(
    {
      openHttpConnection() {},
      handleDecodedMessage,
      closeConnection(conn: { data: { connectionId: string } }) {
        opts?.onClose?.(conn.data.connectionId);
      },
    } as never,
    opts?.keepaliveIntervalMs ? { keepaliveIntervalMs: opts.keepaliveIntervalMs } : undefined,
  );
}

function createBlockedConnection(label: string) {
  return createConnection(() => {
    throw new Error(`${label} must be blocked before reaching the runtime`);
  });
}

function createEchoConnection(
  resultFor: (message: JsonRpcLiteRequest) => unknown = () => ({ ok: true }),
) {
  const dispatchedMethods: string[] = [];
  const connection = createConnection((conn, message: RpcMessage) => {
    if ("method" in message) dispatchedMethods.push(message.method);
    if ("id" in message && "method" in message) {
      conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message) }));
    }
  });
  return { connection, dispatchedMethods };
}

function flushTimeoutWaiters(schedule: ReturnType<typeof spyOn>) {
  for (const [callback, delay] of schedule.mock.calls) {
    if (delay === 30_000 && typeof callback === "function") callback();
  }
}

describe("H3 mobile HTTP JSON-RPC connection", () => {
  test("keeps initialization state across dispatched HTTP requests", async () => {
    let initialized = false;
    const closedConnectionIds: string[] = [];
    const connection = createConnection(
      (conn, message: JsonRpcLiteRequest | JsonRpcLiteNotification) => {
        if (message.method === "initialize" && "id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          return;
        }
        if (message.method === "initialized") {
          initialized = true;
          return;
        }
        if ("id" in message) {
          conn.send(
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
      { onClose: (id) => closedConnectionIds.push(id) },
    );

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
    const handled: RpcMessage[] = [];
    const connection = createConnection((_conn, message: RpcMessage) => handled.push(message));

    await expect(
      connection.dispatch({ id: "server-request-1", result: { approved: true } }),
    ).resolves.toBeNull();

    expect(handled).toEqual([{ id: "server-request-1", result: { approved: true } }]);
    connection.close();
  });

  test("keeps server requests separate from HTTP responses with the same id", async () => {
    const connection = createConnection();
    const events: string[] = [];
    const decoder = new TextDecoder();
    const reader = new ReadableStream<Uint8Array>({
      start: (controller) => void connection.addEventSink(controller),
    }).getReader();
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
    const connection = createConnection((_conn, msg: JsonRpcLiteRequest) => handled.push(msg));
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
      flushTimeoutWaiters(schedule);
      await outcomes;
      schedule.mockRestore();
    }
  });

  test("does not remove a reused request id while finishing the previous HTTP response", async () => {
    const connection = createConnection();
    const schedule = spyOn(globalThis, "setTimeout");
    const first = connection.dispatch({ id: "reused", method: "thread/read" });
    connection.send(JSON.stringify({ id: "reused", result: "first" }));
    const next = connection.dispatch({ id: "reused", method: "thread/read" });
    const outcomes = Promise.allSettled([first, next]);

    try {
      await first;
      connection.send(JSON.stringify({ id: "reused", result: "next" }));
      connection.close();
      flushTimeoutWaiters(schedule);
      await expect(next).resolves.toEqual({ id: "reused", result: "next" });
    } finally {
      connection.close();
      flushTimeoutWaiters(schedule);
      await outcomes;
      schedule.mockRestore();
    }
  });

  test("returns an empty transport ack for notifications", async () => {
    const handled: RpcMessage[] = [];
    const connection = createConnection((_conn, msg: RpcMessage) => handled.push(msg));

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
    const { connection } = createEchoConnection(() => ({}));
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
    const { connection } = createEchoConnection(() => ({}));
    expect(connection.data.taskReadAllowed).toBeUndefined();
    expect(connection.data.taskMutationAllowed).toBeUndefined();

    for (const [id, perms, expectedRead, expectedMutate] of [
      [1, {}, false, false],
      [2, { conversations: true }, true, false],
      [3, { conversations: true, turns: true }, true, true],
      [4, { turns: true }, false, false],
    ] as const) {
      await __internal.dispatchHttpRpcPayload(
        { id, method: "initialize", params: {} },
        connection,
        trustedDevice(perms),
      );
      expect(connection.data.taskReadAllowed).toBe(expectedRead);
      expect(connection.data.taskMutationAllowed).toBe(expectedMutate);
    }
    connection.close();
  });

  test.each([
    {
      name: "plugin deletion",
      methods: ["cowork/plugins/delete"],
      params: { pluginId: "figma-toolkit", scope: "user" },
      permission: "workspaceSettings" as const,
    },
    {
      name: "MCP server config reads",
      methods: ["cowork/mcp/servers/read"],
      params: { workspaceId: "ws-1" },
      permission: "workspaceSettings" as const,
      allowResult: { event: { type: "mcp_servers", servers: [] } },
      expectedMatch: { event: { type: "mcp_servers" } },
    },
    {
      name: "MCP server validation (stdio spawn)",
      methods: ["cowork/mcp/server/validate"],
      params: { workspaceId: "ws-1", name: "fs" },
      permission: "workspaceSettings" as const,
      allowResult: { event: { type: "mcp_server_validation", name: "fs", ok: true } },
      expectedMatch: { event: { type: "mcp_server_validation", name: "fs" } },
    },
    {
      name: "memory reads",
      methods: ["cowork/memory/list"],
      params: { workspaceId: "ws-1", scope: "user" },
      permission: "workspaceSettings" as const,
      extraRequiredChecks: ["cowork/memory/advanced/list"],
      allowResult: { event: { type: "memory_list", entries: [] } },
      expectedMatch: { event: { type: "memory_list" } },
    },
    {
      name: "plugin install preview",
      methods: ["cowork/plugins/install/preview"],
      params: { workspaceId: "ws-1", sourceInput: "/etc", targetScope: "workspace" },
      permission: "workspaceSettings" as const,
      passiveNullMethods: ["cowork/plugins/read", "cowork/plugins/catalog/read"],
      allowResult: { event: { type: "plugin_install_preview", candidates: [] } },
      expectedMatch: { event: { type: "plugin_install_preview" } },
    },
    {
      name: "presentation preview (slide-module execution)",
      methods: ["cowork/workspace/presentation/preview"],
      params: { workspaceId: "ws-1", path: "slide-1.mjs" },
      permission: "workspaceSettings" as const,
      passiveNullMethods: ["workspace/list"],
      allowResult: { slides: [] },
      expectedMatch: { slides: [] },
    },
    {
      name: "skill install preview",
      methods: ["cowork/skills/install/preview"],
      params: { workspaceId: "ws-1", sourceInput: "/etc", targetScope: "project" },
      permission: "workspaceSettings" as const,
      passiveNullMethods: [
        "cowork/skills/catalog/read",
        "cowork/skills/list",
        "cowork/skills/read",
        "cowork/skills/installation/read",
      ],
      allowResult: { event: { type: "skill_install_preview", candidates: [] } },
      expectedMatch: { event: { type: "skill_install_preview" } },
    },
    {
      name: "spreadsheet reads (caller-selected cwd)",
      methods: ["cowork/workspace/spreadsheet/workbook", "cowork/workspace/spreadsheet/version"],
      params: { cwd: "/", path: "secret.csv" },
      permission: "workspaceSettings" as const,
      passiveNullMethods: ["workspace/list"],
      allowResult: { sheets: [] },
      expectedMatch: { sheets: [] },
    },
    {
      name: "canvas document RPCs",
      methods: [
        "cowork/workspace/document/open",
        "cowork/workspace/document/revision",
        "cowork/workspace/document/save",
        "cowork/workspace/document/saveAs",
        "cowork/workspace/document/close",
      ],
      params: { path: "secret.txt" },
      permission: "workspaceSettings" as const,
      passiveNullMethods: ["workspace/list"],
      allowResult: { ok: true },
      expectedMatch: { ok: true },
    },
    {
      name: "thread history reads",
      methods: ["thread/list", "thread/read", "thread/hydrate", "thread/resume"],
      params: { threadId: "t-1" },
      permission: "conversations" as const,
      passiveNullMethods: ["thread/unsubscribe"],
      allowResult: { threads: [], total: 0 },
      expectedMatch: { total: 0 },
    },
    {
      name: "workspace state/config reads",
      methods: ["cowork/session/state/read"],
      params: { cwd: "/tmp" },
      permission: "workspaceSettings" as const,
    },
  ])("enforces mobile permission gate for $name", async (spec) => {
    const blocked = createBlockedConnection(spec.name);
    try {
      for (const method of spec.methods) {
        const response = await __internal.dispatchHttpRpcPayload(
          { id: 1, method, params: spec.params },
          blocked,
          trustedDevice(),
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: `Mobile device permission required: ${spec.permission}.`,
          permission: spec.permission,
        });
        expect(__internal.getRequiredH3Permission({ id: 2, method, params: spec.params })).toBe(
          spec.permission,
        );
      }
      for (const extra of spec.extraRequiredChecks ?? []) {
        expect(__internal.getRequiredH3Permission({ id: 3, method: extra, params: {} })).toBe(
          spec.permission,
        );
      }
      for (const passive of spec.passiveNullMethods ?? []) {
        expect(
          __internal.getRequiredH3Permission({ id: 4, method: passive, params: {} }),
        ).toBeNull();
      }
    } finally {
      blocked.close();
    }

    if (spec.allowResult) {
      const { connection, dispatchedMethods } = createEchoConnection(() => spec.allowResult);
      const method = spec.methods[0]!;
      try {
        const response = await __internal.dispatchHttpRpcPayload(
          { id: 1, method, params: spec.params },
          connection,
          trustedDevice({ [spec.permission]: true }),
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          id: 1,
          result: spec.expectedMatch,
        });
        expect(dispatchedMethods).toContain(method);
      } finally {
        connection.close();
      }
    }
  });

  test.each(["cowork/mcp/server/auth/setApiKey", "cowork/mcp/server/auth/callback"])(
    "requires auth and workspace permissions before %s can dispatch implicit validation",
    async (method) => {
      const { connection, dispatchedMethods } = createEchoConnection();
      const request = {
        id: 1,
        method,
        params: {
          name: "configured-command",
          ...(method.endsWith("setApiKey") ? { apiKey: "test-key" } : { code: "test-code" }),
        },
      };
      try {
        for (const [perms, missingPermission] of [
          [{ mcpAuth: true }, "workspaceSettings"],
          [{ workspaceSettings: true }, "mcpAuth"],
        ] as const) {
          const denied = await __internal.dispatchHttpRpcPayload(
            request,
            connection,
            trustedDevice(perms),
          );
          expect(denied.status).toBe(403);
          await expect(denied.json()).resolves.toMatchObject({ permission: missingPermission });
          expect(dispatchedMethods).toEqual([]);
        }

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

  test("requires conversation and turn permissions for thread metadata setters", () => {
    for (const method of ["thread/pinned/set", "thread/archived/set"]) {
      expect(__internal.getRequiredH3Permission({ id: 1, method, params: {} })).toEqual([
        "conversations",
        "turns",
      ]);
    }
  });

  test("splits task reads from task mutations for mobile permissions", async () => {
    const { connection, dispatchedMethods } = createEchoConnection();

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

    for (const [id, method, params] of [
      [3, "task/updateBrief", { taskId: "task-1", expectedRevision: 1, title: "Updated" }],
      [4, "task/artifact/read", { taskId: "task-1", artifactId: "artifact-1" }],
    ] as const) {
      const denied = await __internal.dispatchHttpRpcPayload(
        { id, method, params },
        connection,
        trustedDevice({ conversations: true }),
      );
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({
        error: "Mobile device permission required: turns.",
        permission: "turns",
      });
    }

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
    for (const [id, method] of [
      [7, "task/artifact/read"],
      [8, "task/updateBrief"],
    ] as const) {
      expect(__internal.getRequiredH3Permission({ id, method, params: {} })).toEqual([
        "conversations",
        "turns",
      ]);
    }
    connection.close();
  });

  test("workspace bootstrap requires both workspaceSettings and conversations", async () => {
    const { connection } = createEchoConnection(() => ({ threads: [] }));
    const req = { id: 1, method: "cowork/workspace/bootstrap", params: { cwd: "/tmp" } };

    expect(__internal.getRequiredH3Permission({ id: 1, method: req.method, params: {} })).toEqual([
      "workspaceSettings",
      "conversations",
    ]);

    for (const [perms, missingPermission] of [
      [{ conversations: true }, "workspaceSettings"],
      [{ workspaceSettings: true }, "conversations"],
    ] as const) {
      const denied = await __internal.dispatchHttpRpcPayload(req, connection, trustedDevice(perms));
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ permission: missingPermission });
    }

    const allowed = await __internal.dispatchHttpRpcPayload(
      req,
      connection,
      trustedDevice({ workspaceSettings: true, conversations: true }),
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ id: 1, result: { threads: [] } });
    connection.close();
  });

  test("emits periodic SSE keepalive comments while event sinks are open", async () => {
    const connection = createConnection(undefined, { keepaliveIntervalMs: 20 });
    const reader = new ReadableStream<Uint8Array>({
      start: (controller) => void connection.addEventSink(controller),
    }).getReader();
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
    const connection = createConnection();
    const reader = new ReadableStream<Uint8Array>({
      start: (controller) => void connection.addEventSink(controller),
    }).getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    connection.close();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test("rejects pending RPC requests when the HTTP JSON-RPC connection closes", async () => {
    const connection = createConnection();
    const pending = __internal.dispatchHttpRpcPayload(
      { id: 1, method: "thread/list" },
      connection,
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
    const connection = createConnection(() => {
      handledMessages += 1;
      throw new Error("malformed payloads must not reach the runtime");
    });

    for (const [name, raw, expectedError] of [
      ["null payload", null, "JSON-RPC payload must be an object."],
      ["array payload", [], "JSON-RPC payload must be an object."],
      ["missing method and id", {}, "JSON-RPC method is required."],
      ["blank method", { method: "   " }, "JSON-RPC method is required."],
      ["non-string method", { method: 42 }, "JSON-RPC method is required."],
      [
        "request with boolean id",
        { id: true, method: "thread/list" },
        "JSON-RPC id must be a string or number.",
      ],
      [
        "response with null id",
        { id: null, result: { ok: true } },
        "JSON-RPC response id must be a string or number.",
      ],
    ] as const) {
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

    expect(
      __internal.requireAdminToken(
        new Request("https://127.0.0.1:9443/ticket", {
          headers: { authorization: "Bearer admin-token" },
        }),
        "admin-token",
      ),
    ).toBeNull();
  });

  test("brackets IPv6 host hints for advertised mobile H3 URLs", () => {
    for (const [input, expected] of [
      ["::1", "[::1]"],
      ["2001:db8::1", "[2001:db8::1]"],
      ["[2001:db8::1]", "[2001:db8::1]"],
      ["127.0.0.1", "127.0.0.1"],
    ] as const) {
      expect(__internal.formatUrlHost(input)).toBe(expected);
    }
  });
});
