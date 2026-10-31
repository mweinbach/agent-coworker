import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { connectRustJsonRpc, startRustTestServer } from "./helpers/rustServerHarness";

describe("Rust cowork-server HTTP security, filesystem routes, and sticky loopback RPC", () => {
  test("serves /cowork/health and enforces browser Origin gate on loopback", async () => {
    const srv = await startRustTestServer();
    try {
      const healthRes = await fetch(`${srv.httpBaseUrl}/cowork/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as {
        status?: string;
        cwd?: string;
        db?: Record<string, unknown>;
        journal?: { healthy?: boolean };
      };
      expect(health.cwd).toBe(srv.workspaceDir);
      expect(health.db).toBeDefined();
      expect(health.journal?.healthy).toBe(true);

      // Untrusted web origin is rejected with 403 even before token checks
      const blocked = await fetch(`${srv.httpBaseUrl}/cowork/health`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(blocked.status).toBe(403);

      // Browser Origin without X-Cowork-Browser-Token is rejected with 401 when token is absent/unmatched
      const unauthLoopbackOrigin = await fetch(`${srv.httpBaseUrl}/cowork/health`, {
        headers: { Origin: "http://127.0.0.1:14330" },
      });
      expect([401, 403]).toContain(unauthLoopbackOrigin.status);
    } finally {
      await srv.stop();
    }
  });

  test("enforces X-Cowork-Browser-Token when bound to non-loopback 0.0.0.0", async () => {
    const srv = await startRustTestServer({ host: "0.0.0.0" });
    try {
      const token = srv.listening.browserAccessToken;
      expect(typeof token).toBe("string");
      expect(token!.length).toBeGreaterThan(16);

      const unauth = await fetch(`${srv.httpBaseUrl}/cowork/health`);
      expect(unauth.status).toBe(401);

      const authed = await fetch(`${srv.httpBaseUrl}/cowork/health`, {
        headers: { "X-Cowork-Browser-Token": token! },
      });
      expect(authed.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  test("serves /cowork/fs/* workspace directory and file operations while rejecting traversal", async () => {
    const srv = await startRustTestServer();
    try {
      const helloPath = path.join(srv.workspaceDir, "hello.txt");
      await fs.writeFile(helloPath, "hello rust server\n", "utf8");

      const listRes = await fetch(
        `${srv.httpBaseUrl}/cowork/fs/list?path=${encodeURIComponent(srv.workspaceDir)}`,
      );
      expect(listRes.status).toBe(200);
      const entries = (await listRes.json()) as Array<{ name: string }>;
      expect(entries.some((e) => e.name === "hello.txt")).toBe(true);

      const readRes = await fetch(
        `${srv.httpBaseUrl}/cowork/fs/read?path=${encodeURIComponent(helloPath)}`,
      );
      expect(readRes.status).toBe(200);
      const readBody = (await readRes.json()) as { content: string };
      expect(readBody.content).toContain("hello rust server");

      const mkdirRes = await fetch(`${srv.httpBaseUrl}/cowork/fs/create-directory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: srv.workspaceDir, name: "nested-dir" }),
      });
      expect(mkdirRes.status).toBe(204);
      const stat = await fs.stat(path.join(srv.workspaceDir, "nested-dir"));
      expect(stat.isDirectory()).toBe(true);

      // Path outside workspace root must fail
      const escapeRes = await fetch(
        `${srv.httpBaseUrl}/cowork/fs/read?path=${encodeURIComponent("/etc/hosts")}`,
      );
      expect(escapeRes.status).toBeGreaterThanOrEqual(400);
    } finally {
      await srv.stop();
    }
  });

  test("enforces WebSocket subprotocol and JSON-RPC lite envelope strictness", async () => {
    const srv = await startRustTestServer();
    try {
      // ?protocol= query param rejected with 400
      const legacyQuery = await fetch(`${srv.httpBaseUrl}/ws?protocol=v1`);
      expect(legacyQuery.status).toBe(400);

      // Pre-initialize request rejected with -32002
      const rawRpc = await connectRustJsonRpc(srv.wsUrl, { skipInitialize: true });
      const preInit = await rawRpc.requestRaw("thread/list", { cwd: srv.workspaceDir });
      expect(preInit.error?.code).toBe(-32002);

      // Envelope with "jsonrpc": "2.0" rejected with -32600
      const invalidEnvelopePromise = new Promise<any>((resolve) => {
        rawRpc.ws.addEventListener(
          "message",
          (ev) => resolve(JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data))),
          { once: true },
        );
      });
      rawRpc.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: {} }));
      const invalidEnvelope = await invalidEnvelopePromise;
      expect(invalidEnvelope.error?.code).toBe(-32600);
      rawRpc.close();
    } finally {
      await srv.stop();
    }
  });

  test("supports sticky loopback POST /rpc sessions with x-cowork-client-id", async () => {
    const srv = await startRustTestServer();
    try {
      const clientId = `sticky-client-${crypto.randomUUID()}`;
      const postRpc = async (body: unknown) => {
        const res = await fetch(srv.rpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-cowork-client-id": clientId,
          },
          body: JSON.stringify(body),
        });
        return {
          status: res.status,
          text: await res.text(),
        };
      };

      // Missing x-cowork-client-id rejected
      const missingHeader = await fetch(srv.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, method: "initialize", params: {} }),
      });
      expect(missingHeader.status).toBe(400);

      const initRes = await postRpc({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "http-rpc-test", version: "1.0.0" } },
      });
      expect(initRes.status).toBe(200);
      expect(JSON.parse(initRes.text).result.protocolVersion).toBe("0.1");

      const initializedRes = await postRpc({ method: "initialized", params: {} });
      expect([200, 202, 204]).toContain(initializedRes.status);

      const startedRes = await postRpc({
        id: 2,
        method: "thread/start",
        params: { cwd: srv.workspaceDir },
      });
      expect(startedRes.status).toBe(200);
      const threadId = JSON.parse(startedRes.text).result.thread.id;
      expect(typeof threadId).toBe("string");

      const readRes = await postRpc({
        id: 3,
        method: "thread/read",
        params: { threadId },
      });
      expect(readRes.status).toBe(200);
      expect(JSON.parse(readRes.text).result.thread.id).toBe(threadId);
    } finally {
      await srv.stop();
    }
  });
});
