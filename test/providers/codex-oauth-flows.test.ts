import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../../src/connect";
import { OAUTH_LOOPBACK_HOST } from "../../src/auth/oauth-server";
import {
  buildCodexAuthorizeUrl,
  completeCodexBrowserOAuth,
  prepareCodexBrowserOAuth,
  runCodexBrowserOAuth,
} from "../../src/providers/codex-oauth-flows";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

describe("providers/codex-oauth-flows", () => {
  test("buildCodexAuthorizeUrl matches the official Codex browser login contract", () => {
    const url = new URL(buildCodexAuthorizeUrl(
      "http://localhost:1455/auth/callback",
      "challenge_123",
      "state_123",
    ));

    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("scope")).toBe(
      "openid profile email offline_access api.connectors.read api.connectors.invoke",
    );
    expect(url.searchParams.get("code_challenge")).toBe("challenge_123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("state")).toBe("state_123");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });

  test("runCodexBrowserOAuth uses the bound loopback host in the redirect URI", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-oauth-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const accessToken = makeJwt({
      email: "oauth@example.com",
      chatgpt_account_id: "acct-123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    let openedRedirectUri = "";

    const file = await runCodexBrowserOAuth({
      paths,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: accessToken,
        refresh_token: "refresh-token",
        expires_in: 3600,
      }), { status: 200 }),
      openUrl: async (authUrl) => {
        const parsed = new URL(authUrl);
        openedRedirectUri = parsed.searchParams.get("redirect_uri") ?? "";
        expect(openedRedirectUri).toMatch(new RegExp(`^http://${OAUTH_LOOPBACK_HOST.replace(/\./g, "\\.")}:\\d+/auth/callback$`));
        const state = parsed.searchParams.get("state");
        if (!state) throw new Error("Expected OAuth state");
        await fetch(`${openedRedirectUri}?code=browser-code&state=${state}`);
        return true;
      },
    });

    expect(file).toBe(path.join(paths.authDir, "codex-cli", "auth.json"));
    expect(openedRedirectUri.startsWith(`http://${OAUTH_LOOPBACK_HOST}:`)).toBe(true);
  });

  test("completeCodexBrowserOAuth exchanges a manually provided code with the prepared PKCE state", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-oauth-manual-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const accessToken = makeJwt({
      email: "manual@example.com",
      chatgpt_account_id: "acct-manual",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const pending = await prepareCodexBrowserOAuth();
    let requestBody = "";

    const file = await completeCodexBrowserOAuth({
      paths,
      pending,
      code: "manual-auth-code",
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: "manual-refresh-token",
          expires_in: 3600,
        }), { status: 200 });
      },
      openUrl: async () => {
        throw new Error("manual callback flow should not open a browser");
      },
    });

    const params = new URLSearchParams(requestBody);
    expect(params.get("code")).toBe("manual-auth-code");
    expect(params.get("redirect_uri")).toBe(pending.redirectUri);
    expect(params.get("code_verifier")).toBe(pending.codeVerifier);
    expect(file).toBe(path.join(paths.authDir, "codex-cli", "auth.json"));
  });
});
