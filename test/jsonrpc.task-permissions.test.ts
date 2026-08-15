import { describe, expect, test } from "bun:test";
import type { JsonRpcLiteNotification, JsonRpcLiteRequest } from "../src/server/jsonrpc/protocol";
import { jsonRpcTaskRequestSchemas } from "../src/server/jsonrpc/schema.tasks";
import { getTaskRpcRequiredPermissions } from "../src/server/jsonrpc/taskPermissions";
import type { H3TrustedDeviceRecord } from "../src/server/transport/h3/pairing";
import { __internal } from "../src/server/transport/h3/server";

const TASK_READ_METHODS = new Set([
  "task/list",
  "task/read",
  "task/artifact/version/compare",
  "task/artifact/version/preview",
]);

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

describe("task JSON-RPC permission table", () => {
  test("classifies every registered task request method", () => {
    const methods = Object.keys(jsonRpcTaskRequestSchemas);
    expect(methods.length).toBeGreaterThan(0);

    for (const method of methods) {
      const expected = TASK_READ_METHODS.has(method)
        ? ["conversations"]
        : ["conversations", "turns"];
      expect(getTaskRpcRequiredPermissions(method), method).toEqual(expected);
    }
  });

  test("ignores non-task methods and keeps the read-only allowlist exact", () => {
    expect(getTaskRpcRequiredPermissions("thread/list")).toEqual([]);
    expect(getTaskRpcRequiredPermissions("cowork/backups/workspace/restore")).toEqual([]);
    expect(getTaskRpcRequiredPermissions("task")).toEqual([]);

    const registeredReadMethods = Object.keys(jsonRpcTaskRequestSchemas).filter((method) =>
      TASK_READ_METHODS.has(method),
    );
    expect(registeredReadMethods.sort()).toEqual([...TASK_READ_METHODS].sort());
  });

  test("H3 allows artifact version compare with conversations only", async () => {
    const dispatchedMethods: string[] = [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(
        conn: { send(message: string): number },
        message: JsonRpcLiteRequest | JsonRpcLiteNotification,
      ) {
        dispatchedMethods.push(message.method);
        if ("id" in message) {
          conn.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
        }
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    expect(
      __internal.getRequiredH3Permission({
        id: 1,
        method: "task/artifact/version/compare",
        params: {},
      }),
    ).toBe("conversations");
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "task/artifact/version/preview",
        params: {},
      }),
    ).toBe("conversations");
    expect(
      __internal.getRequiredH3Permission({
        id: 3,
        method: "task/artifact/version/restore",
        params: {},
      }),
    ).toEqual(["conversations", "turns"]);

    const denied = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "task/artifact/version/compare",
        params: { taskId: "task-1", artifactId: "artifact-1" },
      },
      connection,
      trustedDevice(),
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "Mobile device permission required: conversations.",
      permission: "conversations",
    });

    const restoreDenied = await __internal.dispatchHttpRpcPayload(
      {
        id: 2,
        method: "task/artifact/version/restore",
        params: { taskId: "task-1", artifactId: "artifact-1" },
      },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(restoreDenied.status).toBe(403);
    await expect(restoreDenied.json()).resolves.toEqual({
      error: "Mobile device permission required: turns.",
      permission: "turns",
    });

    const allowed = await __internal.dispatchHttpRpcPayload(
      {
        id: 3,
        method: "task/artifact/version/compare",
        params: { taskId: "task-1", artifactId: "artifact-1" },
      },
      connection,
      trustedDevice({ conversations: true }),
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ id: 3, result: { ok: true } });
    expect(dispatchedMethods).toEqual(["task/artifact/version/compare"]);
    connection.close();
  });
});
