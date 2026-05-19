import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bedrock } from "@aws-sdk/client-bedrock";

import { getAiCoworkerPaths, writeConnectionStore } from "../src/connect";
import { getProviderStatuses } from "../src/providerStatus";
import { refreshBedrockDiscoveryCache } from "../src/providers/bedrockShared";
import { __internal as codexAppServerAuthInternal } from "../src/providers/codexAppServerAuth";

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
  Bedrock.prototype.listCustomModelDeployments = async () =>
    ({ modelDeploymentSummaries: [] }) as any;
  Bedrock.prototype.listProvisionedModelThroughputs = async () =>
    ({ provisionedModelSummaries: [] }) as any;
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
        2,
      ),
      "utf-8",
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

  test("includes masked Parallel key in google status", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {},
      toolApiKeys: {
        parallel: "parallel-secret-5678",
      },
    });

    const statuses = await getProviderStatuses({ paths });
    const google = statuses.find((s) => s.provider === "google");
    expect(google).toBeDefined();
    expect(google?.authorized).toBe(false);
    expect(google?.mode).toBe("missing");
    expect(google?.savedApiKeyMasks?.parallel_api_key).toBe("para...5678");
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

  test("codex-cli: verified via codex app-server account and exposes usage snapshots", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    codexAppServerAuthInternal.setAuthOverridesForTests({
      readAccount: async () => ({
        account: { type: "chatgpt", email: "backend.com", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
      readRateLimits: async () => ({
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_773_038_084 },
        secondary: { usedPercent: 31, windowDurationMins: 10_080, resetsAt: 1_773_531_475 },
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      }),
    });
    try {
      const statuses = await getProviderStatuses({ paths });
      const codex = statuses.find((s) => s.provider === "codex-cli");
      expect(codex).toBeDefined();
      expect(codex?.authorized).toBe(true);
      expect(codex?.verified).toBe(true);
      expect(codex?.mode).toBe("oauth");
      expect(codex?.account?.email).toBe("backend.com");
      expect(codex?.message).toContain("Verified via codex app-server ChatGPT account");
      expect(codex?.usage).toEqual({
        email: "backend.com",
        planType: "pro",
        rateLimits: [
          {
            limitId: "codex",
            primaryWindow: {
              usedPercent: 4,
              windowSeconds: 18_000,
              resetAt: "2026-03-09T06:34:44.000Z",
            },
            secondaryWindow: {
              usedPercent: 31,
              windowSeconds: 604_800,
              resetAt: "2026-03-14T23:37:55.000Z",
            },
            credits: { hasCredits: false, unlimited: false, balance: "0" },
          },
        ],
      });
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });

  test("codex-cli: reports missing when app-server has no account", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    codexAppServerAuthInternal.setAuthOverridesForTests({
      readAccount: async () => ({ account: null, requiresOpenaiAuth: true }),
    });
    try {
      const statuses = await getProviderStatuses({ paths });
      const codex = statuses.find((s) => s.provider === "codex-cli");
      expect(codex).toBeDefined();
      expect(codex?.authorized).toBe(false);
      expect(codex?.verified).toBe(false);
      expect(codex?.mode).toBe("missing");
      expect(codex?.account).toBeNull();
      expect(codex?.message).toContain("Not logged in to Codex");
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });

  test("codex-cli: reports missing when cached account token is expired", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    codexAppServerAuthInternal.setAuthOverridesForTests({
      readAccount: async () => ({
        account: { type: "chatgpt", email: "backend.com", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
      readRateLimits: async () => {
        throw new Error(
          "failed to fetch codex rate limits: 401 Unauthorized token_expired. Please sign in again.",
        );
      },
    });
    try {
      const statuses = await getProviderStatuses({ paths });
      const codex = statuses.find((s) => s.provider === "codex-cli");
      expect(codex).toBeDefined();
      expect(codex?.authorized).toBe(false);
      expect(codex?.verified).toBe(false);
      expect(codex?.mode).toBe("missing");
      expect(codex?.account).toBeNull();
      expect(codex?.message).toContain("auth expired");
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });

  test("codex-cli: app-server status errors surface as provider errors", async () => {
    const home = await makeTmpHome();
    const paths = getAiCoworkerPaths({ homedir: home });
    codexAppServerAuthInternal.setAuthOverridesForTests({
      readAccount: async () => {
        throw new Error("temporary outage");
      },
    });
    try {
      const statuses = await getProviderStatuses({ paths });
      const codex = statuses.find((s) => s.provider === "codex-cli");
      expect(codex).toBeDefined();
      expect(codex?.authorized).toBe(false);
      expect(codex?.verified).toBe(false);
      expect(codex?.mode).toBe("error");
      expect(codex?.message).toContain("Codex app-server status failed: Error: temporary outage");
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });
});
