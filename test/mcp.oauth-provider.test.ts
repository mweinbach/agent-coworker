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
  let tokenServer: Server;
  let tokenServerUrl: string;
  let tokenServerResource: string;
  let lastTokenRequest: { body: URLSearchParams } | undefined;
  let registrationCount = 0;
  let lastRegistrationRequest: Record<string, unknown> | undefined;

  beforeAll(async () => {
    tokenServer = createServer((req, res) => {
      // Serve RFC 9728 protected resource metadata.
      if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          resource: tokenServerUrl,
          authorization_servers: [tokenServerUrl],
        }));
        return;
      }
      // Serve RFC 8414 authorization server metadata.
      if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          issuer: tokenServerUrl,
          authorization_endpoint: `${tokenServerUrl}/authorize`,
          token_endpoint: `${tokenServerUrl}/token`,
          registration_endpoint: `${tokenServerUrl}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        }));
        return;
      }
      if (req.url === "/register" && req.method === "POST") {
        let rawBody = "";
        req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
        req.on("end", () => {
          registrationCount += 1;
          lastRegistrationRequest = JSON.parse(rawBody) as Record<string, unknown>;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            client_id: `registered-client-${registrationCount}`,
            client_secret: `registered-secret-${registrationCount}`,
            redirect_uris: (lastRegistrationRequest?.redirect_uris as string[] | undefined) ?? [],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }));
        });
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
    tokenServerResource = new URL(tokenServerUrl).href;
  });

  afterAll(() => {
    tokenServer.close();
  });

  test("authorizeMCPServerOAuth creates challenge and pending payload", async () => {
    registrationCount = 0;
    lastRegistrationRequest = undefined;
    const server = makeOAuthServer({
      transport: { type: "http", url: `${tokenServerUrl}/mcp` },
      auth: { type: "oauth", oauthMode: "code", scope: "tools.read" },
    });
    const result = await authorizeMCPServerOAuth(server);

    expect(result.challenge.method).toBe("code");
    expect(result.challenge.url).toBeDefined();
    const authUrl = new URL(result.challenge.url!);
    expect(authUrl.origin + authUrl.pathname).toBe(`${tokenServerUrl}/authorize`);
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("resource")).toBe(tokenServerResource);
    expect(authUrl.searchParams.get("client_id")).toBe("registered-client-1");
    expect(result.pending.state.length).toBeGreaterThan(0);
    expect(result.pending.codeVerifier.length).toBeGreaterThan(0);
    expect(result.pending.resource).toBe(tokenServerResource);
    expect(result.clientInformation?.redirectUris).toEqual(["urn:ietf:wg:oauth:2.0:oob"]);
  });

  test("auto oauth callback capture supports manual continue path", async () => {
    registrationCount = 0;
    lastRegistrationRequest = undefined;
    const server = makeOAuthServer({
      transport: { type: "http", url: `${tokenServerUrl}/mcp` },
      auth: { type: "oauth", oauthMode: "auto", scope: "tools.read" },
    });
    let openedUrl = "";
    const result = await authorizeMCPServerOAuth(server, undefined, {
      openUrl: async (url) => {
        openedUrl = url;
        return true;
      },
    });

    expect(result.challenge.method).toBe("auto");
    expect(result.openedBrowser).toBe(true);
    expect(openedUrl).toBe(result.challenge.url);
    expect(lastRegistrationRequest?.redirect_uris).toEqual([result.pending.redirectUri]);

    const callbackUrl = new URL(result.pending.redirectUri);
    callbackUrl.searchParams.set("state", result.pending.state);
    callbackUrl.searchParams.set("code", "captured-code");

    const response = await fetch(callbackUrl.toString());
    expect(response.status).toBe(200);

    const consumed = await consumeCapturedOAuthCode(result.pending.challengeId);
    expect(consumed).toBe("captured-code");
  });

  test("authorizeMCPServerOAuth re-registers when stored client redirect URIs do not match the current auto callback", async () => {
    registrationCount = 0;
    lastRegistrationRequest = undefined;
    const server = makeOAuthServer({
      transport: { type: "http", url: `${tokenServerUrl}/mcp` },
      auth: { type: "oauth", oauthMode: "auto", scope: "tools.read" },
    });

    const result = await authorizeMCPServerOAuth(server, {
      clientId: "stale-client",
      clientSecret: "stale-secret",
      redirectUris: ["http://127.0.0.1:1455/oauth/callback"],
      updatedAt: new Date().toISOString(),
    }, {
      openUrl: async () => true,
    });

    const authUrl = new URL(result.challenge.url!);
    expect(authUrl.searchParams.get("client_id")).toBe("registered-client-1");
    expect(lastRegistrationRequest?.redirect_uris).toEqual([result.pending.redirectUri]);
    expect(result.clientInformation?.redirectUris).toEqual([result.pending.redirectUri]);
  });

  test("authorizeMCPServerOAuth reuses stored client info when redirect URIs still match", async () => {
    registrationCount = 0;
    lastRegistrationRequest = undefined;
    const server = makeOAuthServer({
      transport: { type: "http", url: `${tokenServerUrl}/mcp` },
      auth: { type: "oauth", oauthMode: "code", scope: "tools.read" },
    });

    const result = await authorizeMCPServerOAuth(server, {
      clientId: "stored-client",
      clientSecret: "stored-secret",
      redirectUris: ["urn:ietf:wg:oauth:2.0:oob"],
      updatedAt: new Date().toISOString(),
    });

    const authUrl = new URL(result.challenge.url!);
    expect(authUrl.searchParams.get("client_id")).toBe("stored-client");
    expect(registrationCount).toBe(0);
    expect(lastRegistrationRequest).toBeUndefined();
    expect(result.clientInformation).toBeUndefined();
  });

  describe("exchangeMCPServerOAuthCode", () => {

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
        authorizationServerUrl: tokenServerUrl,
      };

      lastTokenRequest = undefined;
      const result = await exchangeMCPServerOAuthCode({
        server,
        code: "auth-code-123",
        pending,
      });

      // Verify the token endpoint received correct parameters.
      expect(lastTokenRequest).toBeDefined();
      expect(lastTokenRequest!.body.get("grant_type")).toBe("authorization_code");
      expect(lastTokenRequest!.body.get("code")).toBe("auth-code-123");
      // The SDK sends the client_id (fallback or registered).
      expect(lastTokenRequest!.body.get("client_id")).toBe("agent-coworker-desktop");
      expect(lastTokenRequest!.body.get("redirect_uri")).toBe("http://127.0.0.1:9999/oauth/callback");
      expect(lastTokenRequest!.body.get("code_verifier")).toBe("test-verifier");
      expect(lastTokenRequest!.body.get("resource")).toBe("urn:example:resource");

      // Verify returned tokens come from the token endpoint response.
      expect(result.tokens.accessToken).toBe("real-access-token");
      expect(result.tokens.tokenType).toBe("Bearer");
      expect(result.tokens.refreshToken).toBe("real-refresh-token");
      expect(result.tokens.scope).toBe("tools.read");
      expect(result.tokens.expiresAt).toBeDefined();
      expect(result.tokens.resource).toBe("urn:example:resource");
      expect(result.message).toContain("successful");
    });

    test("discovers and reuses protected resource metadata when config omits resource", async () => {
      const server = makeOAuthServer({
        transport: { type: "http", url: `${tokenServerUrl}/mcp` },
        auth: { type: "oauth", oauthMode: "code", scope: "tools.read" },
      });
      const pending = {
        challengeId: "challenge",
        state: "state",
        codeVerifier: "test-verifier",
        redirectUri: "http://127.0.0.1:9999/oauth/callback",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authorizationServerUrl: tokenServerUrl,
      };

      lastTokenRequest = undefined;
      const result = await exchangeMCPServerOAuthCode({
        server,
        code: "auth-code-789",
        pending,
      });

      expect(lastTokenRequest).toBeDefined();
      expect(lastTokenRequest!.body.get("resource")).toBe(tokenServerResource);
      expect(result.tokens.resource).toBe(tokenServerResource);
    });

    test("uses stored client information when provided", async () => {
      const server = makeOAuthServer({
        transport: { type: "http", url: `${tokenServerUrl}/mcp` },
        auth: { type: "oauth", oauthMode: "code", scope: "tools.read" },
      });
      const pending = {
        challengeId: "challenge",
        state: "state",
        codeVerifier: "test-verifier",
        redirectUri: "http://127.0.0.1:9999/oauth/callback",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authorizationServerUrl: tokenServerUrl,
      };

      lastTokenRequest = undefined;
      await exchangeMCPServerOAuthCode({
        server,
        code: "auth-code-456",
        pending,
        storedClientInfo: {
          clientId: "registered-client-123",
          clientSecret: "secret-456",
          updatedAt: new Date().toISOString(),
        },
      });

      expect(lastTokenRequest).toBeDefined();
      expect(lastTokenRequest!.body.get("client_id")).toBe("registered-client-123");
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
          authorizationServerUrl: errorUrl,
        };

        await expect(
          exchangeMCPServerOAuthCode({ server, code: "bad-code", pending }),
        ).rejects.toThrow();
      } finally {
        errorServer.close();
      }
    });
  });
});
