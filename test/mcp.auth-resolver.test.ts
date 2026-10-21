import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { readMCPAuthFiles, resolveMCPServerAuthState } from "../src/mcp/authStore";
import type {
  MCPAuthFileState,
  MCPServerCredentialRecord,
  MCPServerOAuthPending,
  MCPServerOAuthTokens,
} from "../src/mcp/authStore/types";
import type { MCPRegistryServer } from "../src/mcp/configRegistry";
import { scratchRoots } from "../src/platform/sandbox";
import type { AgentConfig, MCPServerAuthConfig } from "../src/types";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const API_KEY = "sk-live-secret-1234";

const CONFIG = {
  provider: "google",
  model: "gemini-3-flash-preview",
  preferredChildModel: "gemini-3-flash-preview",
  workingDirectory: "/workspace",
  userName: "tester",
  knowledgeCutoff: "unknown",
  projectCoworkDir: "/workspace/.cowork",
  userCoworkDir: "/home/.cowork",
  builtInDir: "/built-in",
  builtInConfigDir: "/built-in/config",
  skillsDirs: [],
  memoryDirs: [],
  configDirs: [],
} as AgentConfig;

function registryServer(name: string, auth?: MCPServerAuthConfig): MCPRegistryServer {
  return {
    name,
    source: "workspace",
    inherited: false,
    transport: { type: "http", url: "https://mcp.example.com" },
    ...(auth ? { auth } : {}),
  };
}

function authSnapshot(servers: Record<string, MCPServerCredentialRecord>): {
  workspace: MCPAuthFileState;
  user: MCPAuthFileState;
} {
  const empty = { version: 1 as const, updatedAt: UPDATED_AT, servers: {} };
  return {
    workspace: {
      scope: "workspace",
      filePath: "workspace-auth.json",
      doc: { ...empty, servers },
    },
    user: {
      scope: "user",
      filePath: "user-auth.json",
      doc: empty,
    },
  };
}

function pending(expiresAt: string): MCPServerOAuthPending {
  return {
    challengeId: "challenge-1",
    state: "state-1",
    codeVerifier: "verifier-1",
    redirectUri: "http://127.0.0.1/callback",
    createdAt: UPDATED_AT,
    expiresAt,
  };
}

function tokens(
  overrides: Partial<MCPServerOAuthTokens> & Pick<MCPServerOAuthTokens, "accessToken">,
): MCPServerOAuthTokens {
  return { updatedAt: UPDATED_AT, ...overrides };
}

async function resolve(
  auth: MCPServerAuthConfig | undefined,
  record: MCPServerCredentialRecord | undefined,
  name = "docs",
) {
  const files = authSnapshot(record ? { [name]: record } : {});
  return resolveMCPServerAuthState(CONFIG, registryServer(name, auth), files);
}

describe("resolveMCPServerAuthState", () => {
  test("builds api-key headers from trimmed names and only defaults Bearer for Authorization", async () => {
    const record = { apiKey: { value: API_KEY, updatedAt: UPDATED_AT } };
    const cases: Array<{ auth: MCPServerAuthConfig; headers: Record<string, string> }> = [
      { auth: { type: "api_key" }, headers: { Authorization: `Bearer ${API_KEY}` } },
      {
        auth: { type: "api_key", headerName: "  " },
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
      {
        auth: { type: "api_key", headerName: " authorization " },
        headers: { authorization: `Bearer ${API_KEY}` },
      },
      {
        auth: { type: "api_key", headerName: "AUTHORIZATION" },
        headers: { AUTHORIZATION: `Bearer ${API_KEY}` },
      },
      { auth: { type: "api_key", headerName: "X-Api-Key" }, headers: { "X-Api-Key": API_KEY } },
      {
        auth: { type: "api_key", headerName: " X-Api-Key ", prefix: "  Token  " },
        headers: { "X-Api-Key": `Token ${API_KEY}` },
      },
      {
        auth: { type: "api_key", headerName: "Authorization", prefix: "   " },
        headers: { Authorization: API_KEY },
      },
      {
        auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    ];

    for (const item of cases) {
      const state = await resolve(item.auth, record);
      expect(state).toEqual({
        mode: "api_key",
        scope: "workspace",
        authType: "api_key",
        message: "API key available (sk-l...1234).",
        apiKey: API_KEY,
        headers: item.headers,
      });
    }

    const shortKey = await resolve(
      { type: "api_key", headerName: "X-Api-Key" },
      { apiKey: { value: "secret", updatedAt: UPDATED_AT } },
    );
    expect(shortKey).toEqual({
      mode: "api_key",
      scope: "workspace",
      authType: "api_key",
      message: "API key available (******).",
      apiKey: "secret",
      headers: { "X-Api-Key": "secret" },
    });

    const missing = await resolve(
      { type: "api_key", headerName: "X-Api-Key" },
      { apiKey: { value: "", updatedAt: UPDATED_AT } },
    );
    expect(missing).toEqual({
      mode: "missing",
      scope: "workspace",
      authType: "api_key",
      message: "API key required.",
    });
  });

  test("none auth does not attach a stored api key", async () => {
    const record = { apiKey: { value: API_KEY, updatedAt: UPDATED_AT } };
    for (const auth of [undefined, { type: "none" as const }]) {
      expect(await resolve(auth, record)).toEqual({
        mode: "none",
        scope: "workspace",
        authType: "none",
        message: "No authentication required.",
      });
    }
  });

  test("oauth token headers follow token type, expiry, and refresh whitespace", async () => {
    const live = tokens({ accessToken: "access-token" });
    expect(await resolve({ type: "oauth" }, { oauth: { tokens: live } })).toEqual({
      mode: "oauth",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth token available.",
      headers: { Authorization: "Bearer access-token" },
      oauthTokens: live,
    });

    const dpop = tokens({
      accessToken: "access-token",
      tokenType: "  DPoP  ",
      expiresAt: FUTURE,
    });
    expect(await resolve({ type: "oauth" }, { oauth: { tokens: dpop } })).toEqual({
      mode: "oauth",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth token available.",
      headers: { Authorization: "DPoP access-token" },
      oauthTokens: dpop,
    });

    const blankType = tokens({ accessToken: "access-token", tokenType: "   ", expiresAt: "" });
    expect(await resolve({ type: "oauth" }, { oauth: { tokens: blankType } })).toEqual({
      mode: "oauth",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth token available.",
      headers: { Authorization: "access-token" },
      oauthTokens: blankType,
    });

    const refreshable = tokens({
      accessToken: "expired-access",
      tokenType: "DPoP",
      refreshToken: "refresh-token",
      expiresAt: PAST,
    });
    const openPending = pending(FUTURE);
    expect(
      await resolve({ type: "oauth" }, { oauth: { tokens: refreshable, pending: openPending } }),
    ).toEqual({
      mode: "oauth",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth access token expired; refresh token available.",
      headers: { Authorization: "DPoP expired-access" },
      oauthTokens: refreshable,
      oauthPending: openPending,
    });

    const blankRefresh = tokens({
      accessToken: "expired-access",
      refreshToken: "   ",
      expiresAt: "not-a-date",
    });
    expect(await resolve({ type: "oauth" }, { oauth: { tokens: blankRefresh } })).toEqual({
      mode: "error",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth token expired. Re-authorize this server.",
      oauthTokens: blankRefresh,
    });
  });

  test("a live pending challenge outranks an expired access token and a dead challenge does not", async () => {
    const expired = tokens({ accessToken: "expired-access", expiresAt: PAST });
    const openPending = pending(FUTURE);
    expect(
      await resolve({ type: "oauth" }, { oauth: { tokens: expired, pending: openPending } }),
    ).toEqual({
      mode: "oauth_pending",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth flow is waiting for callback.",
      oauthPending: openPending,
    });

    const expiredPending = pending(PAST);
    expect(
      await resolve({ type: "oauth" }, { oauth: { tokens: expired, pending: expiredPending } }),
    ).toEqual({
      mode: "error",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth token expired. Re-authorize this server.",
      oauthTokens: expired,
      oauthPending: expiredPending,
    });

    const invalidPending = pending("not-a-date");
    expect(await resolve({ type: "oauth" }, { oauth: { pending: invalidPending } })).toEqual({
      mode: "error",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth authorization expired. Re-authorize this server.",
      oauthPending: invalidPending,
    });

    expect(await resolve({ type: "oauth" }, undefined)).toEqual({
      mode: "missing",
      scope: "workspace",
      authType: "oauth",
      message: "OAuth authorization required.",
    });
  });

  test("a credential file that fails schema validation authorizes nothing and stays on disk", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "mcp-auth-resolver-"));
    const projectCoworkDir = path.join(root, "project", ".cowork");
    const userCoworkDir = path.join(root, "home", ".cowork");
    const config = {
      ...CONFIG,
      workingDirectory: path.join(root, "project"),
      projectCoworkDir,
      userCoworkDir,
      builtInDir: path.join(root, "built-in"),
      builtInConfigDir: path.join(root, "built-in", "config"),
    } satisfies AgentConfig;
    const authFile = path.join(projectCoworkDir, "auth", "mcp-credentials.json");
    const raw = `${JSON.stringify(
      {
        version: 1,
        updatedAt: UPDATED_AT,
        servers: {
          sibling: { apiKey: { value: "sibling-secret", updatedAt: UPDATED_AT } },
          docs: {
            oauth: {
              tokens: {
                accessToken: "expired-access",
                refreshToken: "   ",
                expiresAt: PAST,
                updatedAt: UPDATED_AT,
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;

    try {
      await fs.mkdir(path.dirname(authFile), { recursive: true });
      await fs.writeFile(authFile, raw);

      const files = await readMCPAuthFiles(config);
      expect(files.workspace.doc.servers).toEqual({});
      expect(files.user.doc.servers).toEqual({});
      expect(await fs.readFile(authFile, "utf8")).toBe(raw);

      expect(
        await resolveMCPServerAuthState(config, registryServer("sibling", { type: "api_key" })),
      ).toEqual({
        mode: "missing",
        scope: "workspace",
        authType: "api_key",
        message: "API key required.",
      });
      expect(
        await resolveMCPServerAuthState(config, registryServer("docs", { type: "oauth" })),
      ).toEqual({
        mode: "missing",
        scope: "workspace",
        authType: "oauth",
        message: "OAuth authorization required.",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
