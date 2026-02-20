import { describe, expect, test } from "bun:test";

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

  test("exchangeMCPServerOAuthCode returns bearer token material", async () => {
    const server = makeOAuthServer({ auth: { type: "oauth", oauthMode: "code", scope: "tools.read" } });
    const pending = {
      challengeId: "challenge",
      state: "state",
      codeVerifier: "verifier",
      redirectUri: "urn:ietf:wg:oauth:2.0:oob",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const result = await exchangeMCPServerOAuthCode({
      server,
      code: "oauth-code",
      pending,
    });

    expect(result.tokens.accessToken).toBe("oauth-code");
    expect(result.tokens.tokenType).toBe("Bearer");
    expect(result.message).toContain("saved");
  });
});
