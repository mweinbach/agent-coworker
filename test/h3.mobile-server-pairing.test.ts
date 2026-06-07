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
import {
  type H3TrustedDevicePermissionKey,
  loadH3PairingStoreState,
} from "../src/server/transport/h3/pairing";
import { startH3MobileServer } from "../src/server/transport/h3/server";
import { type CoworkPairingTicket, encodeCoworkPairingTicket } from "../src/shared/coworkTicket";

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

function createNoopRuntime(): AgentServerRuntime {
  return {
    openHttpConnection() {},
    handleDecodedMessage() {},
    closeConnection() {},
  } as AgentServerRuntime;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("H3 mobile server pairing", () => {
  const ticketBindingCases: Array<{
    name: string;
    mutate(ticket: CoworkPairingTicket): CoworkPairingTicket;
  }> = [
    {
      name: "certificate fingerprint",
      mutate: (ticket) => ({ ...ticket, certSha256: "b".repeat(64) }),
    },
    {
      name: "SPKI fingerprint",
      mutate: (ticket) => ({ ...ticket, spkiSha256: "c".repeat(43) }),
    },
    {
      name: "desktop identity",
      mutate: (ticket) => ({ ...ticket, identityPub: "other-desktop-identity" }),
    },
    {
      name: "advertised hosts",
      mutate: (ticket) => ({ ...ticket, hosts: ["192.168.1.200"] }),
    },
    {
      name: "advertised port",
      mutate: (ticket) => ({ ...ticket, port: ticket.port === 65535 ? 1 : ticket.port + 1 }),
    },
    {
      name: "ticket expiry",
      mutate: (ticket) => ({ ...ticket, expiresAt: ticket.expiresAt - 1 }),
    },
  ];

  const permissionRouteCases: Array<{
    name: string;
    permission: H3TrustedDevicePermissionKey;
    payload: Record<string, unknown>;
    allowedStatus: number;
    expectedHandledMessage: Record<string, unknown>;
  }> = [
    {
      name: "turn requests",
      permission: "turns",
      payload: {
        jsonrpc: "2.0",
        id: "turn-request",
        method: "thread/start",
        params: { workspaceId: "workspace-1", input: "hello" },
      },
      allowedStatus: 200,
      expectedHandledMessage: {
        id: "turn-request",
        method: "thread/start",
        params: { workspaceId: "workspace-1", input: "hello" },
      },
    },
    {
      name: "provider auth requests",
      permission: "providerAuth",
      payload: {
        jsonrpc: "2.0",
        id: "provider-auth-request",
        method: "cowork/provider/auth/start",
        params: { provider: "openai" },
      },
      allowedStatus: 200,
      expectedHandledMessage: {
        id: "provider-auth-request",
        method: "cowork/provider/auth/start",
        params: { provider: "openai" },
      },
    },
    {
      name: "MCP auth requests",
      permission: "mcpAuth",
      payload: {
        jsonrpc: "2.0",
        id: "mcp-auth-request",
        method: "cowork/mcp/server/auth/start",
        params: { serverName: "github" },
      },
      allowedStatus: 200,
      expectedHandledMessage: {
        id: "mcp-auth-request",
        method: "cowork/mcp/server/auth/start",
        params: { serverName: "github" },
      },
    },
    {
      name: "backup requests",
      permission: "backups",
      payload: {
        jsonrpc: "2.0",
        id: "backup-request",
        method: "cowork/backups/create",
        params: { workspaceId: "workspace-1" },
      },
      allowedStatus: 200,
      expectedHandledMessage: {
        id: "backup-request",
        method: "cowork/backups/create",
        params: { workspaceId: "workspace-1" },
      },
    },
    {
      name: "plugin delete requests",
      permission: "workspaceSettings",
      payload: {
        jsonrpc: "2.0",
        id: "workspace-settings-request",
        method: "cowork/plugins/delete",
        params: { pluginId: "figma-toolkit", scope: "workspace" },
      },
      allowedStatus: 200,
      expectedHandledMessage: {
        id: "workspace-settings-request",
        method: "cowork/plugins/delete",
        params: { pluginId: "figma-toolkit", scope: "workspace" },
      },
    },
    {
      name: "server response forwarding",
      permission: "serverRequests",
      payload: {
        jsonrpc: "2.0",
        id: "server-response",
        result: { accepted: true },
      },
      allowedStatus: 202,
      expectedHandledMessage: {
        id: "server-response",
        result: { accepted: true },
      },
    },
  ];

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
            permissions: {
              turns: false,
              serverRequests: false,
              providerAuth: false,
              mcpAuth: false,
              workspaceSettings: false,
              backups: false,
            },
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

      const missingDeviceHeaderRpc = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" }),
      });
      expect(missingDeviceHeaderRpc.status).toBe(401);
      await expect(missingDeviceHeaderRpc.json()).resolves.toEqual({ error: "Unauthorized." });
      expect(handled).toEqual([]);

      const mismatchedDeviceHeaderRpc = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "content-type": "application/json",
          "x-cowork-mobile-device-id": "phone-2",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" }),
      });
      expect(mismatchedDeviceHeaderRpc.status).toBe(401);
      await expect(mismatchedDeviceHeaderRpc.json()).resolves.toEqual({ error: "Unauthorized." });
      expect(handled).toEqual([]);

      // thread/list now requires the conversations permission (newly paired
      // devices default to false); grant it so the valid-token path reaches the
      // runtime. The permission denial is covered by the deniedTurn case below.
      await server.updateTrustedDevicePermissions("phone-1", { conversations: true });

      const authenticatedRpc = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "x-cowork-mobile-device-id": "phone-1",
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

      const deniedTurn = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "x-cowork-mobile-device-id": "phone-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "turn/start",
          params: { threadId: "thread-1", input: "hello" },
        }),
      });
      expect(deniedTurn.status).toBe(403);
      await expect(deniedTurn.json()).resolves.toMatchObject({
        error: "Mobile device permission required: turns.",
        permission: "turns",
      });
      expect(handled).toEqual([{ id: 2, method: "thread/list" }]);

      await expect(
        server.updateTrustedDevicePermissions("phone-1", { turns: true }),
      ).resolves.toMatchObject({
        deviceId: "phone-1",
        permissions: { turns: true },
      });

      const allowedTurn = await fetchH3(`${server.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "x-cowork-mobile-device-id": "phone-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "turn/start",
          params: { threadId: "thread-1", input: "hello" },
        }),
      });
      expect(allowedTurn.status).toBe(200);
      await expect(allowedTurn.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 4,
        result: { reachedRuntime: true },
      });
      expect(handled).toEqual([
        { id: 2, method: "thread/list" },
        {
          id: 4,
          method: "turn/start",
          params: { threadId: "thread-1", input: "hello" },
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  test("closes active event streams when conversations permission is revoked", async () => {
    const storeRoot = await createTempRoot();
    let closedConnections = 0;
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {
        closedConnections += 1;
      },
    } satisfies Partial<AgentServerRuntime>;
    const server = await startH3MobileServer({
      runtime: runtime as AgentServerRuntime,
      hostname: "127.0.0.1",
      hostHints: ["127.0.0.1"],
      storeRootPath: storeRoot,
      enableH3: false,
    });

    try {
      const pairResponse = await fetchH3(`${server.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: server.ticketUrl,
          nonce: server.nonce,
          deviceId: "phone-1",
          identityPub: "phone-identity",
          displayName: "Work Phone",
        }),
      });
      expect(pairResponse.status).toBe(200);
      const pairPayload = (await pairResponse.json()) as { sessionToken: string };

      await server.updateTrustedDevicePermissions("phone-1", { conversations: true });

      const eventsResponse = await fetchH3(`${server.url}/events`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "x-cowork-mobile-device-id": "phone-1",
        },
      });
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body).not.toBeNull();
      const reader = eventsResponse.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();

      await server.updateTrustedDevicePermissions("phone-1", { conversations: false });

      const closedRead = await Promise.race([
        reader?.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for event stream close.")), 2_000),
        ),
      ]);
      expect(closedRead?.done).toBe(true);
      expect(closedConnections).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("closes active event streams when workspace settings permission is revoked", async () => {
    const storeRoot = await createTempRoot();
    let closedConnections = 0;
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
      closeConnection() {
        closedConnections += 1;
      },
    } satisfies Partial<AgentServerRuntime>;
    const server = await startH3MobileServer({
      runtime: runtime as AgentServerRuntime,
      hostname: "127.0.0.1",
      hostHints: ["127.0.0.1"],
      storeRootPath: storeRoot,
      enableH3: false,
    });

    try {
      const pairResponse = await fetchH3(`${server.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: server.ticketUrl,
          nonce: server.nonce,
          deviceId: "phone-1",
          identityPub: "phone-identity",
          displayName: "Work Phone",
        }),
      });
      expect(pairResponse.status).toBe(200);
      const pairPayload = (await pairResponse.json()) as { sessionToken: string };

      await server.updateTrustedDevicePermissions("phone-1", { workspaceSettings: true });

      const eventsResponse = await fetchH3(`${server.url}/events`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${pairPayload.sessionToken}`,
          "x-cowork-mobile-device-id": "phone-1",
        },
      });
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body).not.toBeNull();
      const reader = eventsResponse.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();

      await server.updateTrustedDevicePermissions("phone-1", { workspaceSettings: false });

      const closedRead = await Promise.race([
        reader?.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for event stream close.")), 2_000),
        ),
      ]);
      expect(closedRead?.done).toBe(true);
      expect(closedConnections).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("gates representative HTTP RPC methods behind matching mobile permissions", async () => {
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
              result: { reachedRuntime: true, method: message.method },
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
      const pairResponse = await fetchH3(`${server.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: server.ticketUrl,
          nonce: server.nonce,
          deviceId: "phone-1",
          identityPub: "phone-identity",
          displayName: "Work Phone",
        }),
      });
      expect(pairResponse.status).toBe(200);
      const pairPayload = (await pairResponse.json()) as { sessionToken: string };
      const authHeaders = {
        authorization: `Bearer ${pairPayload.sessionToken}`,
        "content-type": "application/json",
        "x-cowork-mobile-device-id": "phone-1",
      };

      for (const routeCase of permissionRouteCases) {
        const beforeDeniedCount = handled.length;
        const denied = await fetchH3(`${server.url}/rpc`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(routeCase.payload),
        });
        expect(denied.status).toBe(403);
        await expect(denied.json()).resolves.toEqual({
          error: `Mobile device permission required: ${routeCase.permission}.`,
          permission: routeCase.permission,
        });
        expect(handled).toHaveLength(beforeDeniedCount);

        await expect(
          server.updateTrustedDevicePermissions("phone-1", { [routeCase.permission]: true }),
        ).resolves.toMatchObject({
          deviceId: "phone-1",
          permissions: { [routeCase.permission]: true },
        });

        const allowed = await fetchH3(`${server.url}/rpc`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(routeCase.payload),
        });
        expect(allowed.status).toBe(routeCase.allowedStatus);
        if (routeCase.allowedStatus === 200 && "method" in routeCase.expectedHandledMessage) {
          await expect(allowed.json()).resolves.toEqual({
            jsonrpc: "2.0",
            id: routeCase.expectedHandledMessage.id,
            result: {
              reachedRuntime: true,
              method: routeCase.expectedHandledMessage.method,
            },
          });
        }
        expect(handled.at(-1)).toMatchObject(routeCase.expectedHandledMessage);
      }
    } finally {
      await server.stop();
    }
  });

  test("keeps desktop identity, trusted device permissions, and session auth across H3 restarts", async () => {
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

    let sessionToken = "";
    try {
      const pairResponse = await fetchH3(`${server.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: server.ticketUrl,
          nonce: server.nonce,
          deviceId: "phone-1",
          identityPub: "phone-identity",
          displayName: "Work Phone",
        }),
      });
      expect(pairResponse.status).toBe(200);
      const pairPayload = (await pairResponse.json()) as { sessionToken?: string };
      sessionToken = pairPayload.sessionToken ?? "";
      expect(sessionToken).not.toBe("");

      await expect(
        server.updateTrustedDevicePermissions("phone-1", {
          turns: true,
          providerAuth: true,
          mcpAuth: true,
        }),
      ).resolves.toMatchObject({
        deviceId: "phone-1",
        permissions: {
          turns: true,
          providerAuth: true,
          mcpAuth: true,
        },
      });
    } finally {
      await server.stop();
    }

    const restarted = await startH3MobileServer({
      runtime: runtime as AgentServerRuntime,
      hostname: "127.0.0.1",
      hostHints: ["127.0.0.1"],
      storeRootPath: storeRoot,
      enableH3: false,
    });

    try {
      expect(restarted.identityPub).toBe(server.identityPub);
      expect(restarted.certSha256).toBe(server.certSha256);
      expect(restarted.spkiSha256).toBe(server.spkiSha256);
      expect(restarted.port).toBe(server.port);
      expect(restarted.trustedDevices).toEqual([
        expect.objectContaining({
          deviceId: "phone-1",
          fingerprint: expect.any(String),
          permissions: expect.objectContaining({
            turns: true,
            providerAuth: true,
            mcpAuth: true,
          }),
        }),
      ]);

      const authenticatedTurn = await fetchH3(`${restarted.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "x-cowork-mobile-device-id": "phone-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "turn/start",
          params: { threadId: "thread-1", input: "hello after restart" },
        }),
      });

      expect(authenticatedTurn.status).toBe(200);
      await expect(authenticatedTurn.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 5,
        result: { reachedRuntime: true },
      });
      expect(handled.at(-1)).toEqual({
        id: 5,
        method: "turn/start",
        params: { threadId: "thread-1", input: "hello after restart" },
      });
    } finally {
      await restarted.stop();
    }
  });

  for (const bindingCase of ticketBindingCases) {
    test(`rejects pairing tickets with mismatched ${bindingCase.name}`, async () => {
      const storeRoot = await createTempRoot();
      const server = await startH3MobileServer({
        runtime: createNoopRuntime(),
        hostname: "127.0.0.1",
        hostHints: ["127.0.0.1"],
        storeRootPath: storeRoot,
        enableH3: false,
      });

      try {
        const tamperedTicket = encodeCoworkPairingTicket(bindingCase.mutate(server.ticket));
        const tamperedResponse = await fetchH3(`${server.url}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ticket: tamperedTicket,
            nonce: server.nonce,
            deviceId: "phone-1",
            identityPub: "phone-identity",
            displayName: "Work Phone",
          }),
        });

        expect(tamperedResponse.status).toBe(400);
        await expect(tamperedResponse.json()).resolves.toEqual({
          error: "Invalid pairing request.",
        });
        await expect(loadH3PairingStoreState(storeRoot)).resolves.toEqual({
          version: 1,
          trustedDevices: [],
        });

        const validResponse = await fetchH3(`${server.url}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ticket: server.ticketUrl,
            nonce: server.nonce,
            deviceId: "phone-1",
            identityPub: "phone-identity",
            displayName: "Work Phone",
          }),
        });
        expect(validResponse.status).toBe(200);
      } finally {
        await server.stop();
      }
    });
  }

  test("allows only one concurrent pairing request to consume a nonce", async () => {
    const storeRoot = await createTempRoot();
    const runtime = {
      openHttpConnection() {},
      handleDecodedMessage() {},
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
      const buildPairRequest = (deviceId: string) =>
        fetchH3(`${server.url}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ticket: server.ticketUrl,
            nonce: server.nonce,
            deviceId,
            identityPub: `${deviceId}-identity`,
            displayName: deviceId,
          }),
        });

      const responses = await Promise.all([
        buildPairRequest("phone-1"),
        buildPairRequest("phone-2"),
      ]);
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([200, 401]);
      await expect(loadH3PairingStoreState(storeRoot)).resolves.toMatchObject({
        version: 1,
        trustedDevices: [expect.objectContaining({ deviceId: expect.stringMatching(/^phone-/) })],
      });
      expect((await loadH3PairingStoreState(storeRoot)).trustedDevices).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});
