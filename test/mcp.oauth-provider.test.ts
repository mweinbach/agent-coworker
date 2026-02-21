import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import type { MCPRegistryServer } from "../src/mcp/configRegistry";
import {
  authorizeMCPServerOAuth,
  consumeCapturedOAuthCode,
  exchangeMCPServerOAuthCode,
} from "../src/mcp/oauthProvider";

function makeOAuthServer(overrides: Partial<MCPRegistryServer> = {}): MCPRegistryServer {
  return {
    name: "oauth-server",
    source: "workspace",
    inherited: false,
    transport: { type: "http", url: "https://mcp.oauth.example.com" },
    auth: { type: "oauth", oauthMode: "auto", scope: "tools.read" },
    ...overrides,
  };
}

describe("mcp oauth provider", () => {
  test("authorizeMCPServerOAuth creates challenge and pending payload", async () => {
    const server = makeOAuthServer({ auth: { type: "oauth", oauthMode: "code", scope: "tools.read" } });
    const result = await authorizeMCPServerOAuth(server);

    expect(result.challenge.method).toBe("code");
    expect(result.challenge.url).toContain("response_type=code");
    expect(result.pending.state.length).toBeGreaterThan(0);
    expect(result.pending.codeVerifier.length).toBeGreaterThan(0);
  });

  test("auto oauth callback capture supports manual continue path", async () => {
    const server = makeOAuthServer({ auth: { type: "oauth", oauthMode: "auto", scope: "tools.read" } });
    const result = await authorizeMCPServerOAuth(server);

    expect(result.challenge.method).toBe("auto");

    const callbackUrl = new URL(result.pending.redirectUri);
    callbackUrl.searchParams.set("state", result.pending.state);
    callbackUrl.searchParams.set("code", "captured-code");

    const response = await fetch(callbackUrl.toString());
    expect(response.status).toBe(200);

    const consumed = await consumeCapturedOAuthCode(result.pending.challengeId);
    expect(consumed).toBe("captured-code");
  });

  describe("exchangeMCPServerOAuthCode", () => {
    let tokenServer: Server;
    let tokenServerUrl: string;
    let lastTokenRequest: { body: URLSearchParams } | undefined;

    beforeAll(async () => {
      tokenServer = createServer((req, res) => {
        if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ token_endpoint: `${tokenServerUrl}/token` }));
          return;
        }
        if (req.url === "/token" && req.method === "POST") {
          let rawBody = "";
          req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
          req.on("end", () => {
            lastTokenRequest = { body: new URLSearchParams(rawBody) };
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({
              access_token: "real-access-token",
              token_type: "Bearer",
              refresh_token: "real-refresh-token",
              expires_in: 3600,
              scope: "tools.read",
            }));
          });
          return;
        }
        res.statusCode = 404;
        res.end("Not found");
      });

      await new Promise<void>((resolve) => {
        tokenServer.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = tokenServer.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind token server");
      tokenServerUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(() => {
      tokenServer.close();
    });

    test("exchanges authorization code at token endpoint", async () => {
      const server = makeOAuthServer({
        transport: { type: "http", url: `${tokenServerUrl}/mcp` },
        auth: { type: "oauth", oauthMode: "code", scope: "tools.read", resource: "urn:example:resource" } as any,
      });
      const pending = {
        challengeId: "challenge",
        state: "state",
        codeVerifier: "test-verifier",
        redirectUri: "http://127.0.0.1:9999/oauth/callback",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };

      lastTokenRequest = undefined;
      const result = await exchangeMCPServerOAuthCode({
        server,
        code: "auth-code-123",
        pending,
      });

      // Verify the token endpoint received correct parameters
      expect(lastTokenRequest).toBeDefined();
      expect(lastTokenRequest!.body.get("grant_type")).toBe("authorization_code");
      expect(lastTokenRequest!.body.get("code")).toBe("auth-code-123");
      expect(lastTokenRequest!.body.get("client_id")).toBe("agent-coworker-desktop");
      expect(lastTokenRequest!.body.get("redirect_uri")).toBe("http://127.0.0.1:9999/oauth/callback");
      expect(lastTokenRequest!.body.get("code_verifier")).toBe("test-verifier");

      // Verify returned tokens come from the token endpoint response
      expect(result.tokens.accessToken).toBe("real-access-token");
      expect(result.tokens.tokenType).toBe("Bearer");
      expect(result.tokens.refreshToken).toBe("real-refresh-token");
      expect(result.tokens.scope).toBe("tools.read");
      expect(result.tokens.expiresAt).toBeDefined();
      expect(result.message).toContain("successful");
    });

    test("rejects when token endpoint returns error", async () => {
      const errorServer = createServer((_req, res) => {
        if (_req.url?.startsWith("/.well-known")) {
          res.statusCode = 404;
          res.end("");
          return;
        }
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid_grant" }));
      });
      await new Promise<void>((resolve) => {
        errorServer.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = errorServer.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind");
      const errorUrl = `http://127.0.0.1:${(addr as any).port}`;

      try {
        const server = makeOAuthServer({
          transport: { type: "http", url: `${errorUrl}/mcp` },
          auth: { type: "oauth", oauthMode: "code" },
        });
        const pending = {
          challengeId: "c",
          state: "s",
          codeVerifier: "v",
          redirectUri: "http://127.0.0.1/cb",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };

        await expect(
          exchangeMCPServerOAuthCode({ server, code: "bad-code", pending }),
        ).rejects.toThrow(/Token exchange failed/);
      } finally {
        errorServer.close();
      }
    });
  });
});
