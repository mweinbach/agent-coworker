import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths, writeConnectionStore } from "../src/connect";
import { getProviderStatuses } from "../src/providerStatus";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-provider-status-test-"));
}

describe("getProviderStatuses", () => {
  test("treats legacy-shaped connection store as empty instead of throwing", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(
      paths.connectionsFile,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          connections: {
            openai: {
              mode: "api_key",
              apiKey: "legacy-key",
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const statuses = await getProviderStatuses({ paths });
    const openai = statuses.find((s) => s.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.authorized).toBe(false);
    expect(openai?.mode).toBe("missing");
  });

  test("includes masked provider/tool API keys in google status", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        google: {
          service: "google",
          mode: "api_key",
          apiKey: "goog-secret-1234",
          updatedAt: new Date().toISOString(),
        },
      },
      toolApiKeys: {
        exa: "exa-secret-5678",
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const google = statuses.find((s) => s.provider === "google");
    expect(google).toBeDefined();
    expect(google?.savedApiKeyMasks?.api_key).toBe("goog...1234");
    expect(google?.savedApiKeyMasks?.exa_api_key).toBe("exa-...5678");
  });

  test("includes opencode-go api key masks in provider status", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "opencode-go": {
          service: "opencode-go",
          mode: "api_key",
          apiKey: "opencode-secret-1234",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const opencode = statuses.find((s) => s.provider === "opencode-go");
    expect(opencode).toBeDefined();
    expect(opencode?.authorized).toBe(true);
    expect(opencode?.mode).toBe("api_key");
    expect(opencode?.savedApiKeyMasks?.api_key).toBe("open...1234");
  });

  test("includes opencode-zen api key masks in provider status", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        "opencode-zen": {
          service: "opencode-zen",
          mode: "api_key",
          apiKey: "opencode-zen-secret-1234",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const opencodeZen = statuses.find((s) => s.provider === "opencode-zen");
    expect(opencodeZen).toBeDefined();
    expect(opencodeZen?.authorized).toBe(true);
    expect(opencodeZen?.mode).toBe("api_key");
    expect(opencodeZen?.savedApiKeyMasks?.api_key).toBe("open...1234");
  });

  test("includes masked Exa key even when google provider key is not connected", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {},
      toolApiKeys: {
        exa: "exa-secret-5678",
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const google = statuses.find((s) => s.provider === "google");
    expect(google).toBeDefined();
    expect(google?.authorized).toBe(false);
    expect(google?.mode).toBe("missing");
    expect(google?.savedApiKeyMasks?.api_key).toBeUndefined();
    expect(google?.savedApiKeyMasks?.exa_api_key).toBe("exa-...5678");
  });

  test("codex-cli: verified via Codex usage endpoint and exposes usage snapshots", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const idToken = makeJwt({ iss: "https://auth.example.com", email: "jwt@example.com", chatgpt_account_id: "acct-123" });
    const accessToken = "access-token";

    const codexAuth = {
      version: 1,
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: accessToken },
    };
    const codexAuthPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fs.writeFile(codexAuthPath, JSON.stringify(codexAuth), "utf-8");

    const runner = async ({ command }: { command: string }) => {
      if (command === "claude") return { exitCode: 1, signal: null, stdout: "", stderr: "not logged in" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "unknown" };
    };

    const fetchImpl = async (url: any, init?: any) => {
      const u = String(url);
      if (u === "https://chatgpt.com/backend-api/wham/usage") {
        expect(init?.headers?.authorization).toBe(`Bearer ${accessToken}`);
        expect(init?.headers?.["chatgpt-account-id"]).toBe("acct-123");
        return new Response(JSON.stringify({
          account_id: "acct-123",
          email: "backend@example.com",
          plan_type: "pro",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 4,
              limit_window_seconds: 18_000,
              reset_after_seconds: 13097,
              reset_at: 1_773_038_084,
            },
            secondary_window: {
              used_percent: 31,
              limit_window_seconds: 604_800,
              reset_after_seconds: 506_488,
              reset_at: 1_773_531_475,
            },
          },
          code_review_rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 604_800,
              reset_after_seconds: 435_167,
              reset_at: 1_773_460_153,
            },
            secondary_window: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: {
                  used_percent: 0,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                  reset_at: 1_773_042_987,
                },
                secondary_window: null,
              },
            },
          ],
          credits: {
            has_credits: false,
            unlimited: false,
            balance: "0",
          },
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const statuses = await getProviderStatuses({ paths, fetchImpl: fetchImpl as any });
    const codex = statuses.find((s) => s.provider === "codex-cli");
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(true);
    expect(codex?.mode).toBe("oauth");
    expect(codex?.account?.email).toBe("backend@example.com");
    expect(codex?.account?.name).toBeUndefined();
    expect(codex?.message).toContain("Verified via Codex usage endpoint");
    expect(codex?.usage).toEqual({
      accountId: "acct-123",
      email: "backend@example.com",
      planType: "pro",
      rateLimits: [
        {
          limitId: "codex",
          allowed: true,
          limitReached: false,
          primaryWindow: {
            usedPercent: 4,
            windowSeconds: 18_000,
            resetAfterSeconds: 13097,
            resetAt: "2026-03-09T06:34:44.000Z",
          },
          secondaryWindow: {
            usedPercent: 31,
            windowSeconds: 604_800,
            resetAfterSeconds: 506_488,
            resetAt: "2026-03-14T23:37:55.000Z",
          },
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
        },
        {
          limitId: "code_review",
          limitName: "Code Review",
          allowed: true,
          limitReached: false,
          primaryWindow: {
            usedPercent: 5,
            windowSeconds: 604_800,
            resetAfterSeconds: 435_167,
            resetAt: "2026-03-14T03:49:13.000Z",
          },
          secondaryWindow: null,
        },
        {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          allowed: true,
          limitReached: false,
          primaryWindow: {
            usedPercent: 0,
            windowSeconds: 18_000,
            resetAfterSeconds: 18_000,
            resetAt: "2026-03-09T07:56:27.000Z",
          },
          secondaryWindow: null,
        },
      ],
    });
  });

  test("codex-cli: imports legacy .codex auth path into Cowork auth when cowork auth is missing", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const iss = "https://auth.example.com";
    const idToken = makeJwt({
      iss,
      email: "legacy@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-legacy" },
    });
    const accessToken = "legacy-access-token";
    const legacyPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: accessToken } }),
      "utf-8"
    );

    const statuses = await getProviderStatuses({ paths, fetchImpl: async () => new Response("not found", { status: 404 }) });
    const codex = statuses.find((s) => s.provider === "codex-cli");
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(false);
    expect(codex?.mode).toBe("oauth");
    expect(codex?.account?.email).toBe("legacy@example.com");
    expect(codex?.message).toContain("verification failed");

    const imported = JSON.parse(
      await fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8"),
    ) as any;
    expect(imported?.tokens?.access_token).toBe(accessToken);
    expect(imported?.tokens?.id_token).toBe(idToken);
  });

  test("codex-cli: usage verification failure keeps credentials authorized but unverified", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const idToken = makeJwt({ iss: "https://auth.example.com", email: "jwt@example.com", chatgpt_account_id: "acct-123" });
    const accessToken = "access-token";
    const codexAuthPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fs.writeFile(
      codexAuthPath,
      JSON.stringify({ version: 1, auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: accessToken } }),
      "utf-8"
    );

    const fetchImpl = async () => new Response("boom", { status: 500 });

    const statuses = await getProviderStatuses({ paths, fetchImpl: fetchImpl as any });
    const codex = statuses.find((s) => s.provider === "codex-cli");
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(false);
    expect(codex?.account?.email).toBe("jwt@example.com");
    expect(codex?.message).toContain("verification failed");
  });

  test("codex-cli: malformed usage payload keeps credentials authorized but unverified", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const idToken = makeJwt({ iss: "https://auth.example.com", email: "jwt@example.com", chatgpt_account_id: "acct-123" });
    const accessToken = "access-token";
    const codexAuthPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fs.writeFile(
      codexAuthPath,
      JSON.stringify({ version: 1, auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: accessToken } }),
      "utf-8"
    );

    const statuses = await getProviderStatuses({
      paths,
      fetchImpl: async () => new Response(JSON.stringify({
        credits: {
          has_credits: "nope",
          unlimited: false,
        },
      }), { status: 200 }),
    });
    const codex = statuses.find((s) => s.provider === "codex-cli");

    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(true);
    expect(codex?.verified).toBe(false);
    expect(codex?.account?.email).toBe("jwt@example.com");
    expect(codex?.message).toContain("Codex usage endpoint returned an invalid payload.");
    expect(codex?.usage).toBeUndefined();
  });

  test("codex-cli: expired token with refresh token stays recoverable when refresh fails during startup", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });

    const expiredAccessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 3600,
      email: "jwt@example.com",
      chatgpt_account_id: "acct-recoverable",
    });
    const codexAuthPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fs.writeFile(
      codexAuthPath,
      JSON.stringify({
        version: 1,
        auth_mode: "chatgpt",
        tokens: {
          access_token: expiredAccessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf-8"
    );

    let refreshCalls = 0;
    const fetchImpl = async (url: any) => {
      if (String(url) === "https://auth.openai.com/oauth/token") {
        refreshCalls += 1;
        return new Response("temporary outage", { status: 503 });
      }
      throw new Error(`Unexpected fetch during recoverable-refresh test: ${String(url)}`);
    };

    const statuses = await getProviderStatuses({ paths, fetchImpl: fetchImpl as any });
    const codex = statuses.find((s) => s.provider === "codex-cli");

    expect(refreshCalls).toBe(3);
    expect(codex).toBeDefined();
    expect(codex?.authorized).toBe(false);
    expect(codex?.verified).toBe(false);
    expect(codex?.mode).toBe("oauth");
    expect(codex?.tokenRecoverable).toBe(true);
    expect(codex?.message).toContain("Codex token expired.");
  });

});
