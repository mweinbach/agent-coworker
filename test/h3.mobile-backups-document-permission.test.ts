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

const WORKSPACE_BACKUP_METHODS = [
  "cowork/backups/workspace/read",
  "cowork/backups/workspace/delta/read",
  "cowork/backups/workspace/checkpoint",
  "cowork/backups/workspace/restore",
  "cowork/backups/workspace/deleteCheckpoint",
  "cowork/backups/workspace/deleteEntry",
] as const;

const CANVAS_DOCUMENT_METHODS = [
  "cowork/workspace/document/open",
  "cowork/workspace/document/revision",
  "cowork/workspace/document/save",
  "cowork/workspace/document/saveAs",
  "cowork/workspace/document/close",
] as const;

describe("H3 mobile workspace backup permissions", () => {
  test("maps every workspace backup method to the backups permission", () => {
    for (const method of WORKSPACE_BACKUP_METHODS) {
      expect(__internal.getRequiredH3Permission({ id: 1, method, params: {} }), method).toBe(
        "backups",
      );
    }
    expect(
      __internal.getRequiredH3Permission({
        id: 2,
        method: "cowork/backups/create",
        params: {},
      }),
    ).toBe("backups");
  });

  test("blocks workspace backup mutations for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("workspace backups must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    for (const method of WORKSPACE_BACKUP_METHODS) {
      const response = await __internal.dispatchHttpRpcPayload(
        { id: 1, method, params: { cwd: "/tmp", targetSessionId: "session-1" } },
        connection,
        trustedDevice(),
      );
      expect(response.status, method).toBe(403);
      await expect(response.json(), method).resolves.toEqual({
        error: "Mobile device permission required: backups.",
        permission: "backups",
      });
    }

    connection.close();
  });

  test("does not treat workspaceSettings as a substitute for backups", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("workspaceSettings must not unlock backup restore");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/backups/workspace/restore",
        params: { cwd: "/tmp", targetSessionId: "session-1" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: backups.",
      permission: "backups",
    });
    connection.close();
  });

  test("dispatches workspace backup restore when backups is granted", async () => {
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

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/backups/workspace/restore",
        params: { cwd: "/tmp", targetSessionId: "session-1" },
      },
      connection,
      trustedDevice({ backups: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 1, result: { ok: true } });
    expect(dispatchedMethods).toEqual(["cowork/backups/workspace/restore"]);
    connection.close();
  });
});

describe("H3 mobile canvas document permissions", () => {
  test("maps every canvas document method to workspaceSettings", () => {
    for (const method of CANVAS_DOCUMENT_METHODS) {
      expect(__internal.getRequiredH3Permission({ id: 1, method, params: {} }), method).toBe(
        "workspaceSettings",
      );
    }
  });

  test("blocks canvas document reads and writes for default-permission devices before dispatch", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("canvas document routes must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    for (const method of CANVAS_DOCUMENT_METHODS) {
      const response = await __internal.dispatchHttpRpcPayload(
        { id: 1, method, params: { cwd: "/tmp", path: "notes.md" } },
        connection,
        trustedDevice(),
      );
      expect(response.status, method).toBe(403);
      await expect(response.json(), method).resolves.toEqual({
        error: "Mobile device permission required: workspaceSettings.",
        permission: "workspaceSettings",
      });
    }

    connection.close();
  });

  test("does not treat backups as a substitute for canvas document access", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("backups must not unlock canvas document save");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/workspace/document/save",
        params: { cwd: "/tmp", path: "notes.md" },
      },
      connection,
      trustedDevice({ backups: true }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Mobile device permission required: workspaceSettings.",
      permission: "workspaceSettings",
    });
    connection.close();
  });

  test("dispatches canvas document save when workspaceSettings is granted", async () => {
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

    const response = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/workspace/document/save",
        params: { cwd: "/tmp", path: "notes.md" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 1, result: { ok: true } });
    expect(dispatchedMethods).toEqual(["cowork/workspace/document/save"]);
    connection.close();
  });
});
