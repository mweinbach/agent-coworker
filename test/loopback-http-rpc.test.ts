import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { startAgentServer } from "../src/server/startServer";
import {
  assertLoopbackRpcRemote,
  handleLoopbackHttpRpc,
  LOOPBACK_CLIENT_ID_HEADER,
  type LoopbackHttpRpcSession,
} from "../src/server/transport/loopbackHttpRpc";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

const RPC_URL = "http://127.0.0.1:7337/rpc";
const RETRYABLE_TMP_CLEANUP_CODES = new Set(["EBUSY", "EFAULT", "ENOTEMPTY", "EPERM"]);

function unusedLoopbackSession(): LoopbackHttpRpcSession {
  return {
    getOrCreate() {
      throw new Error("loopback RPC session must not be opened for rejected requests");
    },
    close() {},
    closeAll() {},
  };
}

async function removeTmpDir(tmpDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (!RETRYABLE_TMP_CLEANUP_CODES.has(code) || attempt === 4) throw error;
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}

async function postRpc(
  baseHttpUrl: string,
  clientId: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseHttpUrl}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LOOPBACK_CLIENT_ID_HEADER]: clientId,
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

async function withLoopbackServer(
  opts: Parameters<typeof serverOpts>[1],
  fn: (ctx: {
    tmpDir: string;
    httpBase: string;
    browserAccessToken: string | undefined;
  }) => Promise<void>,
) {
  const tmpDir = await makeTmpProject("agent-loopback-rpc-");
  const { server, url, browserAccessToken } = await startAgentServer(serverOpts(tmpDir, opts));
  const httpBase =
    opts?.hostname === "0.0.0.0"
      ? `http://127.0.0.1:${server.port}`
      : url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  try {
    await fn({ tmpDir, httpBase, browserAccessToken });
  } finally {
    await stopTestServer(server);
    await removeTmpDir(tmpDir);
  }
}

describe("loopback desktop HTTP JSON-RPC", () => {
  test("rejects requests from a reported non-loopback remote", async () => {
    const response = assertLoopbackRpcRemote(new Request(RPC_URL, { method: "POST" }), {
      requestIP: () => ({ address: "192.168.1.50" }),
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Loopback HTTP RPC is restricted to local clients.",
    });
  });

  test.each(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"])(
    "allows the loopback remote address %s",
    (address) => {
      expect(
        assertLoopbackRpcRemote(new Request(RPC_URL, { method: "POST" }), {
          requestIP: () => ({ address }),
        }),
      ).toBeNull();
    },
  );

  test("allows requests when the runtime cannot report a remote address", () => {
    const request = new Request(RPC_URL, { method: "POST" });
    expect(assertLoopbackRpcRemote(request, {})).toBeNull();
    expect(assertLoopbackRpcRemote(request, { requestIP: () => null })).toBeNull();
  });

  test("rejects non-POST methods, missing client ids, and invalid JSON before opening a session", async () => {
    const session = unusedLoopbackSession();

    for (const [req, status, error] of [
      [new Request(RPC_URL, { method: "GET" }), 405, "Method not allowed."],
      [
        new Request(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: 1, method: "initialize", params: {} }),
        }),
        400,
        `Missing ${LOOPBACK_CLIENT_ID_HEADER} header.`,
      ],
      [
        new Request(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json", [LOOPBACK_CLIENT_ID_HEADER]: "desktop-1" },
          body: "{not-json",
        }),
        400,
        "Invalid JSON body.",
      ],
    ] as const) {
      const res = await handleLoopbackHttpRpc(req, session);
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({ error });
    }
  });

  test("initialize → initialized → thread/list over POST /rpc", async () => {
    await withLoopbackServer(undefined, async ({ httpBase }) => {
      const clientId = "native-poc-1";
      const initRes = await postRpc(httpBase, clientId, {
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
      expect(initRes.status).toBe(200);
      await expect(initRes.json()).resolves.toMatchObject({
        id: 1,
        result: { transport: { type: "http", protocolMode: "jsonrpc" } },
      });

      const ackRes = await postRpc(httpBase, clientId, { method: "initialized" });
      expect(ackRes.status).toBe(202);

      const listRes = await postRpc(httpBase, clientId, {
        id: 2,
        method: "thread/list",
        params: {},
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        id: number;
        result: { threads: unknown[]; total: number };
      };
      expect(listBody.id).toBe(2);
      expect(Array.isArray(listBody.result.threads)).toBe(true);
      expect(listBody.result.total).toBe(listBody.result.threads.length);
    });
  });

  test("rejects thread/list before initialize handshake", async () => {
    await withLoopbackServer(undefined, async ({ httpBase }) => {
      const response = await postRpc(httpBase, "native-poc-2", {
        id: 1,
        method: "thread/list",
        params: {},
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: 1,
        error: { code: -32002, message: "Not initialized" },
      });
    });
  });

  test("requires sticky client id header", async () => {
    await withLoopbackServer(undefined, async ({ httpBase }) => {
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
    });
  });

  test("keeps handshake state across requests and isolates state between client ids", async () => {
    await withLoopbackServer(undefined, async ({ tmpDir, httpBase }) => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# workspace\n", "utf8");

      const initRes = await postRpc(httpBase, "initialized-client", {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agent-coworker-native" } },
      });
      expect(initRes.status).toBe(200);
      const ackRes = await postRpc(httpBase, "initialized-client", { method: "initialized" });
      expect(ackRes.status).toBe(202);

      const uninitRes = await postRpc(httpBase, "fresh-client", {
        id: 2,
        method: "thread/list",
        params: {},
      });
      await expect(uninitRes.json()).resolves.toMatchObject({
        error: { code: -32002, message: "Not initialized" },
      });

      const listRes = await postRpc(httpBase, "initialized-client", {
        id: 3,
        method: "thread/list",
        params: {},
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        result?: { total: number };
        error?: unknown;
      };
      expect(listBody.error).toBeUndefined();
      expect(typeof listBody.result?.total).toBe("number");
    });
  });

  test.each([
    [
      "origin-bearing RPC requests",
      { env: { COWORK_WEB_DESKTOP_SERVICE: "1" } },
      "browser-client",
      { Origin: "http://localhost:5173" },
      "Unauthorized browser access",
    ],
    [
      "no-origin RPC on network-exposed listeners",
      { hostname: "0.0.0.0" },
      "network-client",
      {},
      "Unauthorized server access",
    ],
  ] as const)(
    "requires the browser access token for %s",
    async (_label, opts, clientId, baseHeaders, expectedUnauthorizedText) => {
      await withLoopbackServer(opts, async ({ httpBase, browserAccessToken }) => {
        const body = { id: 1, method: "initialize", params: { clientInfo: { name: clientId } } };
        expect(typeof browserAccessToken).toBe("string");

        const unauthorized = await postRpc(httpBase, clientId, body, baseHeaders);
        expect(unauthorized.status).toBe(401);
        expect(await unauthorized.text()).toBe(expectedUnauthorizedText);

        const authorized = await postRpc(httpBase, clientId, body, {
          ...baseHeaders,
          "X-Cowork-Browser-Token": browserAccessToken ?? "",
        });
        expect(authorized.status).toBe(200);
        await expect(authorized.json()).resolves.toMatchObject({
          result: { transport: { type: "http", protocolMode: "jsonrpc" } },
        });
      });
    },
  );
});
