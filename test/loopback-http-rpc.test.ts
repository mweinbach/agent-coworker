import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { startAgentServer } from "../src/server/startServer";
import {
  assertLoopbackRpcRemote,
  LOOPBACK_CLIENT_ID_HEADER,
} from "../src/server/transport/loopbackHttpRpc";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

async function postRpc(
  baseHttpUrl: string,
  clientId: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return await fetch(`${baseHttpUrl}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LOOPBACK_CLIENT_ID_HEADER]: clientId,
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

describe("loopback desktop HTTP JSON-RPC", () => {
  test("rejects a non-loopback remote address before RPC dispatch", async () => {
    const request = new Request("http://127.0.0.1:7337/rpc", { method: "POST" });

    const denied = assertLoopbackRpcRemote(request, {
      requestIP: () => ({ address: "192.168.1.50" }),
    });

    expect(denied?.status).toBe(403);
    await expect(denied?.json()).resolves.toEqual({
      error: "Loopback HTTP RPC is restricted to local clients.",
    });
    expect(
      assertLoopbackRpcRemote(request, {
        requestIP: () => ({ address: "::ffff:127.0.0.1" }),
      }),
    ).toBeNull();
  });

  test("initialize → initialized → thread/list over POST /rpc", async () => {
    const tmpDir = await makeTmpProject("agent-loopback-rpc-");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const httpBase = url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    const clientId = "native-poc-1";

    try {
      const initializeResponse = await postRpc(httpBase, clientId, {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "agent-coworker-native",
            title: "Agent Coworker Native",
            version: "0.1.0",
          },
        },
      });
      expect(initializeResponse.status).toBe(200);
      const initializeBody = (await initializeResponse.json()) as {
        id: number;
        result: {
          transport: { type: string; protocolMode: string };
        };
      };
      expect(initializeBody.id).toBe(1);
      expect(initializeBody.result.transport).toEqual({
        type: "http",
        protocolMode: "jsonrpc",
      });

      const initializedResponse = await postRpc(httpBase, clientId, {
        method: "initialized",
      });
      expect(initializedResponse.status).toBe(202);

      const listResponse = await postRpc(httpBase, clientId, {
        id: 2,
        method: "thread/list",
        params: {},
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        id: number;
        result: { threads: unknown[]; total: number };
      };
      expect(listBody.id).toBe(2);
      expect(Array.isArray(listBody.result.threads)).toBe(true);
      expect(listBody.result.total).toBe(listBody.result.threads.length);
    } finally {
      await stopTestServer(server);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects thread/list before initialize handshake", async () => {
    const tmpDir = await makeTmpProject("agent-loopback-rpc-uninit-");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const httpBase = url.replace(/^ws:/, "http:").replace(/\/ws$/, "");

    try {
      const response = await postRpc(httpBase, "native-poc-2", {
        id: 1,
        method: "thread/list",
        params: {},
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(body.id).toBe(1);
      expect(body.error.code).toBe(-32002);
      expect(body.error.message).toBe("Not initialized");
    } finally {
      await stopTestServer(server);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("requires sticky client id header", async () => {
    const tmpDir = await makeTmpProject("agent-loopback-rpc-header-");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const httpBase = url.replace(/^ws:/, "http:").replace(/\/ws$/, "");

    try {
      const response = await fetch(`${httpBase}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "x" } },
        }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain(LOOPBACK_CLIENT_ID_HEADER);
    } finally {
      await stopTestServer(server);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps handshake state across requests for one client id", async () => {
    const tmpDir = await makeTmpProject("agent-loopback-rpc-sticky-");
    await fs.writeFile(path.join(tmpDir, "README.md"), "# workspace\n", "utf8");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const httpBase = url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    const clientId = "sticky-client";

    try {
      await postRpc(httpBase, clientId, {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agent-coworker-native" } },
      });
      await postRpc(httpBase, clientId, { method: "initialized" });
      const listResponse = await postRpc(httpBase, clientId, {
        id: 2,
        method: "thread/list",
        params: {},
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        result?: { total: number };
        error?: unknown;
      };
      expect(listBody.error).toBeUndefined();
      expect(typeof listBody.result?.total).toBe("number");
    } finally {
      await stopTestServer(server);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
