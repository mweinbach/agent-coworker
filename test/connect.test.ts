import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const loginOpenAICodexMock = mock(async (options: any) => {
  options.onAuth({
    url: "https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&originator=pi",
    instructions: "A browser window should open. Complete login to finish.",
  });
  return {
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "acc_mock",
  };
});

mock.module("@mariozechner/pi-ai", () => ({
  loginOpenAICodex: loginOpenAICodexMock,
}));

const {
  connectProvider,
  getAiCoworkerPaths,
  isOauthCliProvider,
  maskApiKey,
  readConnectionStore,
} = await import("../src/connect");

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-connect-test-"));
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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
  });
});

describe("connectProvider", () => {
  beforeEach(() => {
    loginOpenAICodexMock.mockReset();
    loginOpenAICodexMock.mockImplementation(async (options: any) => {
      options.onAuth({
        url: "https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&originator=pi",
        instructions: "A browser window should open. Complete login to finish.",
      });
      return {
        access: "mock-access-token",
        refresh: "mock-refresh-token",
        expires: Date.now() + 3_600_000,
        accountId: "acc_mock",
      };
    });
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

  test("codex-cli PI-native oauth succeeds and stores oauth mode", async () => {
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
    expect(openedUrls).toEqual([
      "https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&originator=pi",
    ]);
    expect(loginOpenAICodexMock).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8")
    ) as any;
    expect(persisted?.tokens?.access_token).toBe("mock-access-token");
    expect(persisted?.tokens?.refresh_token).toBe("mock-refresh-token");
    expect(persisted?.account?.account_id).toBe("acc_mock");

    const store = await readConnectionStore(paths);
    const entry = store.services["codex-cli"];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("oauth");
  });

  test("codex-cli reuses and migrates legacy .codex credentials", async () => {
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
        2
      ),
      "utf-8"
    );

    const result = await connectProvider({
      provider: "codex-cli",
      paths,
      fetchImpl: async () => {
        throw new Error("Unexpected network call when legacy Codex credentials exist.");
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(result.message).toContain("Existing Codex OAuth credentials detected.");
    expect(result.oauthCredentialsFile).toBe(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"));

    const migrated = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8")
    ) as any;
    expect(migrated?.tokens?.access_token).toBe(accessToken);
    expect(migrated?.tokens?.refresh_token).toBe("legacy-refresh-token");
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
        2
      )
    );

    const openedUrls: string[] = [];
    loginOpenAICodexMock.mockImplementationOnce(async (options: any) => {
      options.onAuth({
        url: "https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&originator=pi",
        instructions: "A browser window should open. Complete login to finish.",
      });
      return {
        access: "fresh-access-token",
        refresh: "fresh-refresh-token",
        expires: Date.now() + 3_600_000,
        accountId: "acc_789",
      };
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
    expect(openedUrls).toEqual([
      "https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&originator=pi",
    ]);

    const persisted = JSON.parse(await fs.readFile(authFile, "utf-8")) as any;
    expect(persisted?.tokens?.access_token).toBe("fresh-access-token");
  });

});
