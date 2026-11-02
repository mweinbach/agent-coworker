import { describe, expect, test } from "bun:test";
import https from "node:https";

import { startRustTestServer } from "./helpers/rustServerHarness";

function httpsJsonRequest(
  urlStr: string,
  opts: {
    method: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; body: any }> {
  const url = new URL(urlStr);
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        rejectUnauthorized: false,
        headers: {
          ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("Rust cowork-server --mobile-h3 TLS pairing, permissions, and revocation", () => {
  test("pairs mobile device once, enforces zero-trust permissions on /rpc, grants permissions, and revokes", async () => {
    const srv = await startRustTestServer({
      mobileH3: true,
      env: { COWORK_OPENTUNNEL_DISABLE: "1" },
    });
    try {
      const mobileInfo = srv.listening.mobileH3;
      expect(mobileInfo).toBeDefined();
      const baseTlsUrl = `https://127.0.0.1:${mobileInfo!.port}`;

      const health = await httpsJsonRequest(`${baseTlsUrl}/health`, { method: "GET" });
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);

      const deviceId = "ios-test-device-1";
      const pairPayload = {
        ticket: mobileInfo!.ticket,
        nonce: mobileInfo!.nonce,
        deviceId,
        identityPub: "MCowBQYDK2VwAyEA0123456789abcdef0123456789abcdef",
        displayName: "Test iPhone",
      };

      const paired = await httpsJsonRequest(`${baseTlsUrl}/pair`, {
        method: "POST",
        body: pairPayload,
      });
      expect(paired.status).toBe(200);
      expect(typeof paired.body.sessionToken).toBe("string");
      const sessionToken = paired.body.sessionToken as string;

      // Single-use pairing nonce: replay must fail with 401
      const replayed = await httpsJsonRequest(`${baseTlsUrl}/pair`, {
        method: "POST",
        body: pairPayload,
      });
      expect(replayed.status).toBe(401);

      const mobileHeaders = {
        Authorization: `Bearer ${sessionToken}`,
        "x-cowork-mobile-device-id": deviceId,
      };

      // Initialize mobile JSON-RPC session
      const initRes = await httpsJsonRequest(`${baseTlsUrl}/rpc`, {
        method: "POST",
        headers: mobileHeaders,
        body: {
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "cowork-mobile-test", version: "1.0.0" } },
        },
      });
      expect(initRes.status).toBe(200);
      expect(initRes.body.result.protocolVersion).toBe("0.1");

      const initedRes = await httpsJsonRequest(`${baseTlsUrl}/rpc`, {
        method: "POST",
        headers: mobileHeaders,
        body: { method: "initialized", params: {} },
      });
      expect(initedRes.status).toBe(202);

      // Newly paired devices default to zero permissions -> thread/list returns 403
      const initialDenied = await httpsJsonRequest(`${baseTlsUrl}/rpc`, {
        method: "POST",
        headers: mobileHeaders,
        body: { id: 2, method: "thread/list", params: { cwd: srv.workspaceDir } },
      });
      expect(initialDenied.status).toBe(403);
      expect(initialDenied.body.permission).toBe("conversations");

      // Desktop admin route grants conversations permission -> thread/list succeeds with 200
      const grantRes = await fetch(
        `${srv.httpBaseUrl}/mobile-h3/trusted/${encodeURIComponent(deviceId)}/permissions`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mobileInfo!.adminToken}`,
          },
          body: JSON.stringify({ permissions: { conversations: true } }),
        },
      );
      expect(grantRes.status).toBe(200);

      const listRes = await httpsJsonRequest(`${baseTlsUrl}/rpc`, {
        method: "POST",
        headers: mobileHeaders,
        body: { id: 3, method: "thread/list", params: { cwd: srv.workspaceDir } },
      });
      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body.result.threads)).toBe(true);

      // Provider auth mutation still requires providerAuth permission -> 403
      const forbiddenRes = await httpsJsonRequest(`${baseTlsUrl}/rpc`, {
        method: "POST",
        headers: mobileHeaders,
        body: {
          id: 4,
          method: "cowork/provider/auth/logout",
          params: { cwd: srv.workspaceDir, provider: "openai" },
        },
      });
      expect(forbiddenRes.status).toBe(403);
      expect(forbiddenRes.body.permission).toBe("providerAuth");

      // Revoke device -> subsequent /rpc returns 401
      const revokeRes = await fetch(
        `${srv.httpBaseUrl}/mobile-h3/trusted/${encodeURIComponent(deviceId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${mobileInfo!.adminToken}` },
        },
      );
      expect(revokeRes.status).toBe(200);

      const afterRevoke = await httpsJsonRequest(`${baseTlsUrl}/rpc`, {
        method: "POST",
        headers: mobileHeaders,
        body: { id: 5, method: "initialize", params: {} },
      });
      expect(afterRevoke.status).toBe(401);
    } finally {
      await srv.stop();
    }
  }, 30_000);
});
