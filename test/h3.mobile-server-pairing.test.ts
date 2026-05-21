import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import type { AgentServerRuntime } from "../src/server/runtime/ServerRuntime";
import { loadH3PairingStoreState } from "../src/server/transport/h3/pairing";
import { startH3MobileServer } from "../src/server/transport/h3/server";

const tempRoots: string[] = [];

type H3FetchInit = RequestInit & {
  tls: {
    rejectUnauthorized: false;
  };
};

type H3TestConnection = {
  send(message: string): number;
};

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-h3-mobile-server-"));
  tempRoots.push(root);
  return root;
}

function fetchH3(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    tls: { rejectUnauthorized: false },
  } as H3FetchInit);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("H3 mobile server pairing", () => {
  test("consumes pairing nonces once and gates HTTP RPC behind the paired session token", async () => {
    const storeRoot = await createTempRoot();
    const handled: Array<JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse> =
      [];
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage(connection: H3TestConnection, message) {
        handled.push(message);
        if ("method" in message && "id" in message) {
          connection.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { reachedRuntime: true },
            }),
          );
        }
      },
      closeConnection() {},
    } satisfies Partial<AgentServerRuntime>;
    const server = await startH3MobileServer({
      runtime: runtime as AgentServerRuntime,
      hostname: "127.0.0.1",
      hostHints: ["127.0.0.1"],
      storeRootPath: storeRoot,
      enableH3: false,
    });

    try {
      const pairBody = {
        ticket: server.ticketUrl,
        nonce: server.nonce,
        deviceId: "phone-1",
        identityPub: "phone-identity",
        displayName: "Work Phone",
      };
      const pairResponse = await fetchH3(`${server.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pairBody),
      });
      expect(pairResponse.status).toBe(200);
      const pairPayload = (await pairResponse.json()) as {
        sessionToken: string;
        trustedDevice: {
          deviceId: string;
          fingerprint: string;
          displayName: string | null;
        };
      };
      expect(pairPayload.sessionToken).toBeString();
      expect(pairPayload.sessionToken).not.toBe("");
      expect(pairPayload.trustedDevice).toMatchObject({
        deviceId: "phone-1",
        displayName: "Work Phone",
      });

      await expect(loadH3PairingStoreState(storeRoot)).resolves.toMatchObject({
        version: 1,
        trustedDevices: [
          {
            deviceId: "phone-1",
            identityPub: "phone-identity",
            displayName: "Work Phone",
          },
        ],
      });

      const replayResponse = await fetchH3(`${server.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pairBody),
      });
      expect(replayResponse.status).toBe(401);
      await expect(replayResponse.json()).resolves.toEqual({
        error: "Pairing session expired.",
      });

      const unauthenticatedRpc = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/list" }),
      });
      expect(unauthenticatedRpc.status).toBe(401);
      await expect(unauthenticatedRpc.json()).resolves.toEqual({ error: "Unauthorized." });
      expect(handled).toEqual([]);

      const authenticatedRpc = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" }),
      });
      expect(authenticatedRpc.status).toBe(200);
      await expect(authenticatedRpc.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { reachedRuntime: true },
      });
      expect(handled).toEqual([{ id: 2, method: "thread/list" }]);
    } finally {
      await server.stop();
    }
  });
});
