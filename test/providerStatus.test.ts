import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bedrock } from "@aws-sdk/client-bedrock";

import { getAiCoworkerPaths, writeConnectionStore } from "../src/connect";
import { refreshBedrockDiscoveryCache } from "../src/providers/bedrockShared";
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

function mockBedrockDiscovery(modelId = "custom.bedrock-model-v1") {
  const originalListFoundationModels = Bedrock.prototype.listFoundationModels;
  const originalListInferenceProfiles = Bedrock.prototype.listInferenceProfiles;
  const originalListCustomModelDeployments = Bedrock.prototype.listCustomModelDeployments;
  const originalListProvisionedModelThroughputs = Bedrock.prototype.listProvisionedModelThroughputs;
  const originalListImportedModels = Bedrock.prototype.listImportedModels;
  let listFoundationModelsCalls = 0;

  Bedrock.prototype.listFoundationModels = async () => {
    listFoundationModelsCalls += 1;
    return {
      modelSummaries: [
        {
          modelId,
          modelName: "Custom Bedrock Model",
          responseStreamingSupported: true,
          inputModalities: ["TEXT"],
        } as any,
      ],
    } as any;
  };
  Bedrock.prototype.listInferenceProfiles = async () => ({ inferenceProfileSummaries: [] }) as any;
  Bedrock.prototype.listCustomModelDeployments = async () => ({ modelDeploymentSummaries: [] }) as any;
  Bedrock.prototype.listProvisionedModelThroughputs = async () => ({ provisionedModelSummaries: [] }) as any;
  Bedrock.prototype.listImportedModels = async () => ({ modelSummaries: [] }) as any;

  return {
    getListFoundationModelsCalls: () => listFoundationModelsCalls,
    resetCalls: () => {
      listFoundationModelsCalls = 0;
    },
    restore: () => {
      Bedrock.prototype.listFoundationModels = originalListFoundationModels;
      Bedrock.prototype.listInferenceProfiles = originalListInferenceProfiles;
      Bedrock.prototype.listCustomModelDeployments = originalListCustomModelDeployments;
      Bedrock.prototype.listProvisionedModelThroughputs = originalListProvisionedModelThroughputs;
      Bedrock.prototype.listImportedModels = originalListImportedModels;
    },
  };
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

  test("reads cached Bedrock snapshot by default without live discovery", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        bedrock: {
          service: "bedrock",
          mode: "credentials",
          methodId: "aws_default",
          values: {},
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const mockedDiscovery = mockBedrockDiscovery();
    try {
      await refreshBedrockDiscoveryCache({ paths, env: {} as NodeJS.ProcessEnv });
      mockedDiscovery.resetCalls();

      const statuses = await getProviderStatuses({ paths, env: {} as NodeJS.ProcessEnv });
      const bedrock = statuses.find((s) => s.provider === "bedrock");

      expect(mockedDiscovery.getListFoundationModelsCalls()).toBe(0);
      expect(bedrock?.authorized).toBe(true);
      expect(bedrock?.verified).toBe(false);
      expect(bedrock?.mode).toBe("credentials");
      expect(bedrock?.message).toBe("Credentials saved.");
    } finally {
      mockedDiscovery.restore();
    }
  });

  test("runs live Bedrock discovery only when explicitly requested", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        bedrock: {
          service: "bedrock",
          mode: "credentials",
          methodId: "aws_default",
          values: {},
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const mockedDiscovery = mockBedrockDiscovery();
    try {
      const statuses = await getProviderStatuses({
        paths,
        env: {} as NodeJS.ProcessEnv,
        refreshBedrockDiscovery: true,
      });
      const bedrock = statuses.find((s) => s.provider === "bedrock");

      expect(mockedDiscovery.getListFoundationModelsCalls()).toBe(1);
      expect(bedrock?.authorized).toBe(true);
      expect(bedrock?.verified).toBe(true);
      expect(bedrock?.mode).toBe("credentials");
      expect(bedrock?.message).toBe("Amazon Bedrock credentials verified.");
    } finally {
      mockedDiscovery.restore();
    }
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

  test("codex-cli: ignores legacy external auth when Cowork auth is missing", async () => {
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
    expect(codex?.authorized).toBe(false);
    expect(codex?.verified).toBe(false);
    expect(codex?.mode).toBe("missing");
    expect(codex?.account).toBeNull();
    expect(codex?.message).toContain("Not logged in to Codex");
    await expect(fs.readFile(path.join(home, ".cowork", "auth", "codex-cli", "auth.json"), "utf-8")).rejects.toThrow();
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
