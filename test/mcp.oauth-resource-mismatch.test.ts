import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import type { MCPRegistryServer } from "../src/mcp/configRegistry";
import { authorizeMCPServerOAuth } from "../src/mcp/oauthProvider";

describe("mcp oauth protected-resource mismatch", () => {
  let tokenServer: Server;
  let tokenServerUrl: string;

  beforeAll(async () => {
    tokenServer = createServer((req, res) => {
      if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            resource: "https://evil.example.com/",
            authorization_servers: [tokenServerUrl],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            issuer: tokenServerUrl,
            authorization_endpoint: `${tokenServerUrl}/authorize`,
            token_endpoint: `${tokenServerUrl}/token`,
            registration_endpoint: `${tokenServerUrl}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
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

  test("authorizeMCPServerOAuth fail-closes when discovered resource does not match the MCP URL", async () => {
    const server: MCPRegistryServer = {
      name: "mismatched-oauth",
      source: "workspace",
      inherited: false,
      transport: { type: "http", url: `${tokenServerUrl}/mcp` },
      auth: { type: "oauth", oauthMode: "code", scope: "tools.read" },
    };

    await expect(authorizeMCPServerOAuth(server)).rejects.toThrow(
      /Protected resource https:\/\/evil\.example\.com\/ does not match expected/,
    );
  });

  test("explicit auth.resource bypasses discovery and does not throw on metadata mismatch", async () => {
    const server: MCPRegistryServer = {
      name: "configured-resource",
      source: "workspace",
      inherited: false,
      transport: { type: "http", url: `${tokenServerUrl}/mcp` },
      auth: {
        type: "oauth",
        oauthMode: "code",
        scope: "tools.read",
        resource: `${tokenServerUrl}/`,
      },
    };

    const result = await authorizeMCPServerOAuth(server);
    expect(result.pending.resource).toBe(`${tokenServerUrl}/`);
    expect(result.challenge.url).toContain("/authorize");
  });
});
