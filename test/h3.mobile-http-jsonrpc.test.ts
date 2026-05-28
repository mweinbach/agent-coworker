import { describe, expect, test } from "bun:test";
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
      trustedDevice(),
    );

    connection.close();

    const response = await pending;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "H3 JSON-RPC connection closed.",
    });
  });

  test("returns 400 for malformed HTTP RPC payloads", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("malformed payloads must not reach the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(null, connection, trustedDevice());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "JSON-RPC payload must be an object.",
    });
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
