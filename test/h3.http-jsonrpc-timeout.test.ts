import { describe, expect, test } from "bun:test";

import type { H3TrustedDeviceRecord } from "../src/server/transport/h3/pairing";
import { __internal } from "../src/server/transport/h3/server";

function trustedDevice(
  permissions: Partial<H3TrustedDeviceRecord["permissions"]> = {},
): H3TrustedDeviceRecord {
  return {
    deviceId: "phone-timeout",
    identityPub: "phone-identity",
    displayName: "Timeout Phone",
    fingerprint: "fingerprint",
    sessionTokenHash: "session-token-hash",
    lastPairedAt: "2026-08-12T00:00:00.000Z",
    lastConnectedAt: null,
    permissions: {
      ...__internal.DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
      ...permissions,
    },
  };
}

describe("H3 HTTP JSON-RPC response timeout", () => {
  test("returns 503 and clears pending waiters when a request never answers", async () => {
    let handled = 0;
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {
        handled += 1;
        // Intentionally never send a response — exercise the timeout fail-closed path.
      },
      closeConnection() {},
    };
    const connection = __internal.createHttpJsonRpcConnection(runtime as never, {
      responseTimeoutMs: 20,
    });

    const response = await __internal.dispatchHttpRpcPayload(
      { id: 1, method: "thread/list" },
      connection,
      trustedDevice({ conversations: true }),
    );

    expect(handled).toBe(1);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Timed out waiting for JSON-RPC response.",
    });

    // A later request must not leak the timed-out waiter into a successful reply.
    const lateResponsePromise = __internal.dispatchHttpRpcPayload(
      { id: 1, method: "thread/list" },
      connection,
      trustedDevice({ conversations: true }),
    );
    connection.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { threads: [] } }));
    const lateResponse = await lateResponsePromise;
    expect(lateResponse.status).toBe(200);
    await expect(lateResponse.json()).resolves.toMatchObject({
      id: 1,
      result: { threads: [] },
    });

    connection.close();
  });
});
