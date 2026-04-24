import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OAUTH_LOOPBACK_HOST } from "../src/auth/oauth-server";
import { __internal as connectInternal } from "../src/connect";
import { parseConnectionStoreJson } from "../src/store/connections";

const mockedAuthorizeUrl = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=${encodeURIComponent(`http://${OAUTH_LOOPBACK_HOST}:1455/auth/callback`)}&scope=openid%20profile%20email%20offline_access&code_challenge=mock-challenge&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=mock-state&originator=codex_cli_rs`;

function buildMockCodexMaterial(
  paths: { authDir: string },
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    file: path.join(paths.authDir, "codex-cli", "auth.json"),
    issuer: "https://auth.openai.com",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    expiresAtMs: Date.now() + 3_600_000,
    accountId: "acc_mock",
    ...overrides,
  };
}

const runCodexLoginMock = mock(async (opts: any) => {
  await opts.openUrl?.(mockedAuthorizeUrl);
  return buildMockCodexMaterial(opts.paths);
});

const { connectProvider, getAiCoworkerPaths, isOauthCliProvider, maskApiKey, readConnectionStore } =
  await import("../src/connect");

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-connect-test-"));
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

describe("connect helpers", () => {
  test("maskApiKey masks long keys", () => {
    expect(maskApiKey("sk-1234567890abcdef")).toBe("sk-1...cdef");
  });

  test("maskApiKey masks short keys with stars", () => {
    expect(maskApiKey("abc")).toBe("****");
    expect(maskApiKey("abcd")).toBe("****");
  });

  test("isOauthCliProvider returns true for oauth cli providers", () => {
    expect(isOauthCliProvider("codex-cli")).toBe(true);
  });

  test("isOauthCliProvider returns false for non-oauth providers", () => {
    expect(isOauthCliProvider("openai")).toBe(false);
    expect(isOauthCliProvider("google")).toBe(false);
    expect(isOauthCliProvider("anthropic")).toBe(false);
    expect(isOauthCliProvider("opencode-go")).toBe(false);
    expect(isOauthCliProvider("opencode-zen")).toBe(false);
  });
});

describe("connectProvider", () => {
  beforeEach(() => {
    connectInternal.setOauthDepsForTests({
      isOauthCliProvider: (provider: string) => provider === "codex-cli",
      runCodexLogin: runCodexLoginMock,
    });
    runCodexLoginMock.mockReset();
    runCodexLoginMock.mockImplementation(async (opts: any) => {
      await opts.openUrl?.(mockedAuthorizeUrl);
      return buildMockCodexMaterial(opts.paths);
    });
  });

  afterEach(() => {
    connectInternal.resetOauthDepsForTests();
  });

  test("readConnectionStore ignores legacy path and only uses cowork auth store", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const legacyPath = path.join(home, ".ai-coworker", "config", "connections.json");
    const legacyStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        openai: {
          service: "openai",
          mode: "api_key",
          apiKey: "sk-legacy-openai",
          updatedAt: new Date().toISOString(),
        },
      },
    };

    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify(legacyStore, null, 2), "utf-8");

    const store = await readConnectionStore(paths);
    expect(store.services.openai?.apiKey).toBeUndefined();

    await expect(fs.readFile(paths.connectionsFile, "utf-8")).rejects.toThrow();
  });

  test("recovers from malformed connection store JSON when saving a provider key", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(paths.connectionsFile, "{not-valid-json", "utf-8");

    const result = await connectProvider({
      provider: "openai",
      apiKey: "sk-openai-test-5678",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("api_key");

    const store = await readConnectionStore(paths);
    expect(store.services.openai?.mode).toBe("api_key");
    expect(store.services.openai?.apiKey).toBe("sk-openai-test-5678");
  });

  test("stores api key mode when key is provided", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "openai",
      apiKey: "sk-openai-test-1234",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("api_key");
    expect(result.maskedApiKey).toBe("sk-o...1234");

    const store = await readConnectionStore(paths);
    const entry = store.services.openai;
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("api_key");
    expect(entry?.apiKey).toBe("sk-openai-test-1234");
  });

  test("stores oauth_pending for non-oauth provider when key is missing", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "google",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth_pending");

    const store = await readConnectionStore(paths);
    const entry = store.services.google;
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("oauth_pending");
    expect(entry?.apiKey).toBeUndefined();
  });

  test("stores api key for opencode-go when key is provided", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "opencode-go",
      apiKey: "opencode-test-key-1234",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("api_key");
    expect(result.maskedApiKey).toBe("open...1234");

    const store = await readConnectionStore(paths);
    const entry = store.services["opencode-go"];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("api_key");
    expect(entry?.apiKey).toBe("opencode-test-key-1234");
  });

  test("stores api key for opencode-zen when key is provided", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "opencode-zen",
      apiKey: "opencode-zen-test-key-5678",
      paths,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("api_key");
    expect(result.maskedApiKey).toBe("open...5678");

    const store = await readConnectionStore(paths);
    const entry = store.services["opencode-zen"];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("api_key");
    expect(entry?.apiKey).toBe("opencode-zen-test-key-5678");
  });

  test("codex-cli Cowork-owned oauth succeeds and stores oauth mode", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const openedUrls: string[] = [];
    const result = await connectProvider({
      provider: "codex-cli",
      paths,
      openUrl: async (url) => {
        openedUrls.push(url);
        return true;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(openedUrls).toEqual([mockedAuthorizeUrl]);
    expect(runCodexLoginMock).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8"),
    ) as any;
    expect(persisted?.tokens?.access_token).toBe("mock-access-token");
    expect(persisted?.tokens?.refresh_token).toBe("mock-refresh-token");
    expect(persisted?.account?.account_id).toBe("acc_mock");

    const store = await readConnectionStore(paths);
    const entry = store.services["codex-cli"];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("oauth");
  });

  test("codex-cli ignores legacy external auth and runs Cowork-owned oauth", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3_600 });
    const legacyPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          issuer: "https://auth.openai.com",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          tokens: {
            access_token: accessToken,
            refresh_token: "legacy-refresh-token",
            id_token: makeJwt({
              iss: "https://auth.openai.com",
              email: "legacy@example.com",
              "https://api.openai.com/auth": { chatgpt_account_id: "acc_legacy" },
            }),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await connectProvider({
      provider: "codex-cli",
      paths,
      openUrl: async (url) => url === mockedAuthorizeUrl,
      fetchImpl: async () => {
        throw new Error("Unexpected network call during fresh Codex OAuth login.");
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(result.message).toContain("Codex OAuth sign-in completed.");
    expect(result.oauthCredentialsFile).toBe(
      path.join(home, ".cowork", "auth", "codex-cli", "auth.json"),
    );
    expect(runCodexLoginMock).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8"),
    ) as any;
    expect(persisted?.tokens?.access_token).toBe("mock-access-token");
    expect(persisted?.tokens?.refresh_token).toBe("mock-refresh-token");
    expect(persisted?.account?.account_id).toBe("acc_mock");
  });

  test("codex-cli stale credentials trigger new oauth flow", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const authFile = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(
      authFile,
      JSON.stringify(
        {
          version: 1,
          auth_mode: "chatgpt",
          issuer: "https://auth.openai.com",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          tokens: {
            access_token: "expired-access-token",
            expires_at: Date.now() - 60_000,
          },
        },
        null,
        2,
      ),
    );

    const openedUrls: string[] = [];
    runCodexLoginMock.mockImplementationOnce(async (opts: any) => {
      await opts.openUrl?.(mockedAuthorizeUrl);
      return buildMockCodexMaterial(opts.paths, {
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
        accountId: "acc_789",
      });
    });

    const result = await connectProvider({
      provider: "codex-cli",
      paths,
      openUrl: async (url) => {
        openedUrls.push(url);
        return true;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(result.message).toContain("Codex OAuth sign-in completed");
    expect(openedUrls).toEqual([mockedAuthorizeUrl]);

    const persisted = JSON.parse(await fs.readFile(authFile, "utf-8")) as any;
    expect(persisted?.tokens?.access_token).toBe("fresh-access-token");
  });

  test("codex-cli rewrites oauth credentials into Cowork auth.json even if helper returns a different file path", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const nonCoworkFile = path.join(home, "tmp", "codex-auth.json");

    runCodexLoginMock.mockImplementationOnce(async (opts: any) => {
      await opts.openUrl?.(mockedAuthorizeUrl);
      return buildMockCodexMaterial(opts.paths, {
        file: nonCoworkFile,
        accessToken: "rewritten-access-token",
        refreshToken: "rewritten-refresh-token",
        accountId: "acc_rewritten",
      });
    });

    const result = await connectProvider({
      provider: "codex-cli",
      paths,
      openUrl: async () => true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.oauthCredentialsFile).toBe(
      path.join(home, ".cowork", "auth", "codex-cli", "auth.json"),
    );

    await expect(fs.readFile(nonCoworkFile, "utf-8")).rejects.toThrow();

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8"),
    ) as any;
    expect(persisted?.tokens?.access_token).toBe("rewritten-access-token");
    expect(persisted?.tokens?.refresh_token).toBe("rewritten-refresh-token");
    expect(persisted?.account?.account_id).toBe("acc_rewritten");
  });

  test("codex-cli rejects pasted authorization codes because Cowork owns the browser handoff", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "codex-cli",
      code: "manual-auth-code",
      paths,
    });

    expect(result.ok).toBe(false);
    expect(runCodexLoginMock).not.toHaveBeenCalled();
    expect(result.message).toContain("browser-managed by Cowork");
    await expect(
      fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8"),
    ).rejects.toThrow();
  });
});

describe("connection store parsing", () => {
  const baseStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    services: {},
  };

  test("ignores unknown service keys instead of failing", () => {
    const raw = JSON.stringify({
      ...baseStore,
      services: {
        "not-a-provider": {
          service: "not-a-provider",
          mode: "api_key",
          apiKey: "irrelevant",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const parsed = parseConnectionStoreJson(raw, "/tmp/connections.json");
    expect(parsed.services).toEqual({});
  });

  test("throws when a service entry claims the wrong service name", () => {
    const raw = JSON.stringify({
      ...baseStore,
      services: {
        openai: {
          service: "google",
          mode: "api_key",
          apiKey: "sk-bad",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    expect(() => parseConnectionStoreJson(raw, "/tmp/connections.json")).toThrow(
      "Invalid connection store schema",
    );
  });

  test("enforces string tool API keys", () => {
    const raw = JSON.stringify({
      ...baseStore,
      toolApiKeys: {
        exa: 123,
      },
    });

    expect(() => parseConnectionStoreJson(raw, "/tmp/connections.json")).toThrow(
      "Invalid connection store schema",
    );
  });
});
