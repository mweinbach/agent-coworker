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

const WORKSPACE_SETTINGS_MUTATIONS = [
  "cowork/plugins/install",
  "cowork/plugins/enable",
  "cowork/plugins/update",
  "cowork/marketplaces/add",
  "cowork/marketplaces/remove",
  "cowork/marketplaces/read",
  "cowork/marketplaces/detail",
  "cowork/skills/install",
  "cowork/skills/enable",
  "cowork/skills/delete",
  "cowork/connectors/openai-native/setEnabled",
  "cowork/provider/customModel/add",
  "cowork/provider/customModel/delete",
  "cowork/provider/model/setEnabled",
  "cowork/provider/model/resetEnabled",
  "cowork/provider/codexAppServer/update",
  "cowork/provider/lmstudio/local/start",
] as const;

const PROVIDER_AUTH_METHODS = [
  "cowork/provider/auth/authorize",
  "cowork/provider/auth/setApiKey",
  "cowork/provider/auth/copyApiKey",
  "cowork/provider/auth/logout",
  "cowork/provider/auth/callback",
] as const;

const ALWAYS_ALLOWED_READS = [
  "cowork/plugins/catalog/read",
  "cowork/plugins/read",
  "cowork/skills/catalog/read",
  "cowork/skills/list",
  "cowork/connectors/openai-native/list",
  "cowork/connectors/openai-native/refresh",
  "cowork/provider/catalog/read",
] as const;

function requiredPermission(method: string) {
  return __internal.getRequiredH3Permission({ id: 1, method, params: {} });
}

describe("H3 install and provider permission isolation", () => {
  test("gates marketplace, install, connector, and provider-settings mutations on workspaceSettings", () => {
    for (const method of WORKSPACE_SETTINGS_MUTATIONS) {
      expect(requiredPermission(method), method).toBe("workspaceSettings");
    }
    for (const method of ALWAYS_ALLOWED_READS) {
      expect(requiredPermission(method), method).toBeNull();
    }
  });

  test("keeps providerAuth on the auth surface and off settings mutations", () => {
    for (const method of PROVIDER_AUTH_METHODS) {
      expect(requiredPermission(method), method).toBe("providerAuth");
    }
    expect(requiredPermission("cowork/provider/customModel/add")).toBe("workspaceSettings");
    expect(requiredPermission("cowork/provider/auth/copyApiKey")).toBe("providerAuth");
  });

  test("blocks install and marketplace mutations for default, providerAuth, and backups devices", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("mutation must be blocked before reaching the runtime");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);
    const deniedDevices = [
      trustedDevice(),
      trustedDevice({ providerAuth: true }),
      trustedDevice({ backups: true, conversations: true, turns: true }),
    ];

    for (const method of [
      "cowork/plugins/install",
      "cowork/marketplaces/add",
      "cowork/skills/install",
      "cowork/connectors/openai-native/setEnabled",
      "cowork/provider/customModel/add",
    ] as const) {
      for (const device of deniedDevices) {
        const response = await __internal.dispatchHttpRpcPayload(
          { id: 1, method, params: {} },
          connection,
          device,
        );
        expect(response.status, `${method}`).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Mobile device permission required: workspaceSettings.",
          permission: "workspaceSettings",
        });
      }
    }

    connection.close();
  });

  test("does not let workspaceSettings unlock provider API-key copy or authorize", async () => {
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        throw new Error("provider auth must stay gated on providerAuth");
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never);

    for (const method of ["cowork/provider/auth/copyApiKey", "cowork/provider/auth/setApiKey"]) {
      const response = await __internal.dispatchHttpRpcPayload(
        { id: 1, method, params: { provider: "openai" } },
        connection,
        trustedDevice({ workspaceSettings: true }),
      );
      expect(response.status, method).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Mobile device permission required: providerAuth.",
        permission: "providerAuth",
      });
    }

    connection.close();
  });

  test("dispatches install and provider-auth methods only with the matching permission", async () => {
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

    const install = await __internal.dispatchHttpRpcPayload(
      {
        id: 1,
        method: "cowork/plugins/install",
        params: { sourceInput: "owner/repo", targetScope: "workspace" },
      },
      connection,
      trustedDevice({ workspaceSettings: true }),
    );
    expect(install.status).toBe(200);

    const copyKey = await __internal.dispatchHttpRpcPayload(
      {
        id: 2,
        method: "cowork/provider/auth/copyApiKey",
        params: { provider: "openai", sourceProvider: "google" },
      },
      connection,
      trustedDevice({ providerAuth: true }),
    );
    expect(copyKey.status).toBe(200);

    expect(dispatchedMethods).toEqual([
      "cowork/plugins/install",
      "cowork/provider/auth/copyApiKey",
    ]);
    connection.close();
  });
});
