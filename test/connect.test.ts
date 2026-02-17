import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  connectProvider,
  getAiCoworkerPaths,
  isOauthCliProvider,
  maskApiKey,
  readConnectionStore,
} from "../src/connect";

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
    expect(isOauthCliProvider("claude-code")).toBe(true);
  });

  test("isOauthCliProvider returns false for non-oauth providers", () => {
    expect(isOauthCliProvider("openai")).toBe(false);
    expect(isOauthCliProvider("google")).toBe(false);
    expect(isOauthCliProvider("anthropic")).toBe(false);
  });
});

describe("connectProvider", () => {
  test("readConnectionStore falls back to legacy path and migrates", async () => {
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
    expect(store.services.openai?.apiKey).toBe("sk-legacy-openai");

    const migrated = JSON.parse(await fs.readFile(paths.connectionsFile, "utf-8")) as any;
    expect(migrated?.services?.openai?.apiKey).toBe("sk-legacy-openai");
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

  test("codex-cli browser oauth succeeds and stores oauth mode", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const openedUrls: string[] = [];
    const blocker = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("occupied");
    });
    let blockerListening = false;
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(1455, "127.0.0.1", () => {
          blockerListening = true;
          resolve();
        });
      });
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== "EADDRINUSE") throw err;
    }

    try {
      const result = await connectProvider({
        provider: "codex-cli",
        paths,
        openUrl: async (url) => {
          openedUrls.push(url);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state");
          const redirectUri = parsed.searchParams.get("redirect_uri");
          expect(state).toBeTruthy();
          expect(redirectUri).toBeTruthy();
          if (!state || !redirectUri) return false;

          const cb = new URL(redirectUri);
          setTimeout(() => {
            void fetch(`http://127.0.0.1:${cb.port}${cb.pathname}?code=test-auth-code&state=${state}`);
          }, 10);
          return true;
        },
        fetchImpl: async (url, init) => {
          const u = String(url);
          if (u === "https://auth.openai.com/oauth/token") {
            expect(init?.method).toBe("POST");
            return new Response(
              JSON.stringify({
                access_token: "codex-access-token",
                refresh_token: "codex-refresh-token",
                id_token: makeJwt({
                  iss: "https://auth.openai.com",
                  email: "user@example.com",
                  chatgpt_account_id: "acc_123",
                }),
                expires_in: 3600,
              }),
              { status: 200 }
            );
          }
          return new Response("not found", { status: 404 });
        },
        oauthTimeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mode).toBe("oauth");
      expect(result.message).toContain("Codex OAuth sign-in completed");
      expect(openedUrls).toHaveLength(1);
      expect(result.oauthCredentialsFile).toBe(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"));

      const persisted = JSON.parse(
        await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8")
      ) as any;
      expect(persisted?.tokens?.access_token).toBe("codex-access-token");

      const store = await readConnectionStore(paths);
      const entry = store.services["codex-cli"];
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe("oauth");
    } finally {
      if (blockerListening) {
        await new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        });
      } else {
        try {
          blocker.close();
        } catch {
          // ignore
        }
      }
    }
  });

  test("codex-cli device oauth succeeds and stores oauth mode", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    const openedUrls: string[] = [];

    const result = await connectProvider({
      provider: "codex-cli",
      methodId: "oauth_device",
      paths,
      openUrl: async (url) => {
        openedUrls.push(url);
        return true;
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.endsWith("/api/accounts/deviceauth/usercode")) {
          expect(init?.method).toBe("POST");
          return new Response(JSON.stringify({ device_auth_id: "dev_123", user_code: "ABCD-EFGH", interval: 1 }), {
            status: 200,
          });
        }
        if (u.endsWith("/api/accounts/deviceauth/token")) {
          expect(init?.method).toBe("POST");
          return new Response(JSON.stringify({ authorization_code: "auth_code_123", code_verifier: "verifier_123" }), {
            status: 200,
          });
        }
        if (u === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              access_token: "codex-device-access-token",
              refresh_token: "codex-device-refresh-token",
              id_token: makeJwt({
                iss: "https://auth.openai.com",
                email: "device@example.com",
                chatgpt_account_id: "acc_456",
              }),
              expires_in: 3600,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      },
      oauthTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(openedUrls).toEqual(["https://auth.openai.com/codex/device"]);

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8")
    ) as any;
    expect(persisted?.tokens?.access_token).toBe("codex-device-access-token");
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
    const result = await connectProvider({
      provider: "codex-cli",
      methodId: "oauth_device",
      paths,
      openUrl: async (url) => {
        openedUrls.push(url);
        return true;
      },
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/api/accounts/deviceauth/usercode")) {
          return new Response(JSON.stringify({ device_auth_id: "dev_stale", user_code: "WXYZ-1234", interval: 1 }), {
            status: 200,
          });
        }
        if (u.endsWith("/api/accounts/deviceauth/token")) {
          return new Response(JSON.stringify({ authorization_code: "fresh_code_1", code_verifier: "fresh_verifier_1" }), {
            status: 200,
          });
        }
        if (u === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              access_token: "fresh-access-token",
              refresh_token: "fresh-refresh-token",
              id_token: makeJwt({
                iss: "https://auth.openai.com",
                email: "fresh@example.com",
                chatgpt_account_id: "acc_789",
              }),
              expires_in: 3600,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      },
      oauthTimeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth");
    expect(result.message).toContain("Codex OAuth sign-in completed");
    expect(openedUrls).toEqual(["https://auth.openai.com/codex/device"]);

    const persisted = JSON.parse(await fs.readFile(authFile, "utf-8")) as any;
    expect(persisted?.tokens?.access_token).toBe("fresh-access-token");
  });

  test("oauth failure returns error and does not store connection", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const result = await connectProvider({
      provider: "claude-code",
      paths,
      oauthRunner: async () => ({ exitCode: 2, signal: null }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("oauth_pending");
    expect(result.message).toContain("requires a terminal TTY");

    const store = await readConnectionStore(paths);
    expect(store.services["claude-code"]).toBeDefined();
    expect(store.services["claude-code"]?.mode).toBe("oauth_pending");
  });
});
