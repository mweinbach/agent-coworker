import { describe, expect, test } from "bun:test";
import type { JsonRpcLiteNotification, JsonRpcLiteRequest } from "../src/server/jsonrpc/protocol";
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

function createDispatchRuntime(dispatchedMethods: string[]) {
  return {
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
}

describe("H3 MCP auth vs workspace-settings isolation", () => {
  test("mcpAuth does not unlock MCP config reads, upserts, or validation", async () => {
    const dispatchedMethods: string[] = [];
    const connection = __internal.createHttpJsonRpcConnection(
      createDispatchRuntime(dispatchedMethods) as never,
    );
    const device = trustedDevice({ mcpAuth: true });

    const blocked = [
      { method: "cowork/mcp/servers/read", params: {} },
      {
        method: "cowork/mcp/server/upsert",
        params: {
          server: { name: "docs", transport: { type: "stdio", command: "echo" } },
        },
      },
      { method: "cowork/mcp/server/validate", params: { name: "docs" } },
      { method: "cowork/mcp/server/delete", params: { name: "docs" } },
    ] as const;

    try {
      for (const [index, payload] of blocked.entries()) {
        const response = await __internal.dispatchHttpRpcPayload(
          { id: index + 1, ...payload },
          connection,
          device,
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Mobile device permission required: workspaceSettings.",
          permission: "workspaceSettings",
        });
        expect(__internal.getRequiredH3Permission({ id: index + 10, ...payload })).toBe(
          "workspaceSettings",
        );
      }
      expect(dispatchedMethods).toEqual([]);
    } finally {
      connection.close();
    }
  });

  test("workspaceSettings does not unlock MCP OAuth authorize or callback", async () => {
    const dispatchedMethods: string[] = [];
    const connection = __internal.createHttpJsonRpcConnection(
      createDispatchRuntime(dispatchedMethods) as never,
    );
    const device = trustedDevice({ workspaceSettings: true });

    const blocked = [
      { method: "cowork/mcp/server/auth/authorize", params: { name: "docs" } },
      { method: "cowork/mcp/server/auth/callback", params: { name: "docs", code: "1234" } },
      { method: "cowork/mcp/server/auth/setApiKey", params: { name: "docs", apiKey: "secret" } },
    ] as const;

    try {
      for (const [index, payload] of blocked.entries()) {
        const response = await __internal.dispatchHttpRpcPayload(
          { id: index + 1, ...payload },
          connection,
          device,
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Mobile device permission required: mcpAuth.",
          permission: "mcpAuth",
        });
        expect(__internal.getRequiredH3Permission({ id: index + 10, ...payload })).toBe("mcpAuth");
      }
      expect(dispatchedMethods).toEqual([]);
    } finally {
      connection.close();
    }
  });

  test("mcpAuth-only authorize dispatches, and workspaceSettings-only upsert dispatches", async () => {
    const dispatchedMethods: string[] = [];
    const connection = __internal.createHttpJsonRpcConnection(
      createDispatchRuntime(dispatchedMethods) as never,
    );

    try {
      const authorize = await __internal.dispatchHttpRpcPayload(
        {
          id: 1,
          method: "cowork/mcp/server/auth/authorize",
          params: { name: "docs" },
        },
        connection,
        trustedDevice({ mcpAuth: true }),
      );
      expect(authorize.status).toBe(200);

      const upsert = await __internal.dispatchHttpRpcPayload(
        {
          id: 2,
          method: "cowork/mcp/server/upsert",
          params: {
            server: { name: "docs", transport: { type: "stdio", command: "echo" } },
          },
        },
        connection,
        trustedDevice({ workspaceSettings: true }),
      );
      expect(upsert.status).toBe(200);

      expect(dispatchedMethods).toEqual([
        "cowork/mcp/server/auth/authorize",
        "cowork/mcp/server/upsert",
      ]);
    } finally {
      connection.close();
    }
  });

  test("mcpAuth does not unlock memory reads or writes", async () => {
    const dispatchedMethods: string[] = [];
    const connection = __internal.createHttpJsonRpcConnection(
      createDispatchRuntime(dispatchedMethods) as never,
    );
    const device = trustedDevice({ mcpAuth: true });

    try {
      for (const [index, method] of [
        "cowork/memory/list",
        "cowork/memory/upsert",
        "cowork/memory/advanced/list",
      ].entries()) {
        const response = await __internal.dispatchHttpRpcPayload(
          { id: index + 1, method, params: { scope: "workspace", content: "x" } },
          connection,
          device,
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Mobile device permission required: workspaceSettings.",
          permission: "workspaceSettings",
        });
      }
      expect(dispatchedMethods).toEqual([]);
    } finally {
      connection.close();
    }
  });
});
