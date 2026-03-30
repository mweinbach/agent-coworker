import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getProviderCatalog, listProviderCatalogEntries } from "../../src/providers/connectionCatalog";
import { __clearAwsBedrockProxyDiscoveryCacheForTests } from "../../src/providers/awsBedrockProxyShared";
import { getAiCoworkerPaths } from "../../src/connect";
import { PROVIDER_NAMES } from "../../src/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("providers/connectionCatalog", () => {
  beforeEach(() => {
    __clearAwsBedrockProxyDiscoveryCacheForTests();
  });

  test("catalog entries stay aligned with provider names and default-model map", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    const entryIds = payload.all.map((entry) => entry.id);
    expect(entryIds).toEqual(PROVIDER_NAMES);
    const staticEntries = await listProviderCatalogEntries();
    const payloadWithoutAws = payload.all.filter((entry) => entry.id !== "aws-bedrock-proxy");
    const staticWithoutAws = staticEntries.filter((entry) => entry.id !== "aws-bedrock-proxy");
    expect(payloadWithoutAws).toEqual(staticWithoutAws);
    const awsEntry = payload.all.find((entry) => entry.id === "aws-bedrock-proxy");
    expect(awsEntry?.state).toBe("unreachable");
    expect(awsEntry?.message).toBe("Set the AWS Bedrock Proxy URL before saving a proxy token.");
    expect(Object.keys(payload.default)).toEqual(PROVIDER_NAMES);
    for (const entry of payload.all) {
      expect(payload.default[entry.id]).toBe(entry.defaultModel);
    }
  });

  test("lists OpenCode providers in the provider catalog with the expected model sets", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.default["opencode-go"]).toBe("glm-5");
    expect(payload.all).toContainEqual({
      id: "opencode-go",
      name: "OpenCode Go",
      models: [
        {
          id: "glm-5",
          displayName: "GLM-5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "kimi-k2.5",
          displayName: "Kimi K2.5",
          knowledgeCutoff: "April 2024",
          supportsImageInput: true,
        },
      ],
      defaultModel: "glm-5",
    });
    expect(payload.default["opencode-zen"]).toBe("glm-5");
    expect(payload.all).toContainEqual({
      id: "opencode-zen",
      name: "OpenCode Zen",
      models: [
        {
          id: "big-pickle",
          displayName: "Big Pickle",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "glm-5",
          displayName: "GLM-5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "kimi-k2.5",
          displayName: "Kimi K2.5",
          knowledgeCutoff: "April 2024",
          supportsImageInput: true,
        },
        {
          id: "mimo-v2-flash-free",
          displayName: "Mimo V2 Flash Free",
          knowledgeCutoff: "December 2024",
          supportsImageInput: false,
        },
        {
          id: "minimax-m2.5",
          displayName: "MiniMax M2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "minimax-m2.5-free",
          displayName: "MiniMax M2.5 Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "nemotron-3-super-free",
          displayName: "Nemotron 3 Super Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
      ],
      defaultModel: "glm-5",
    });
  });

  test("lists Baseten in the provider catalog with the expected model set", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.default.baseten).toBe("moonshotai/Kimi-K2.5");
    expect(payload.all).toContainEqual({
      id: "baseten",
      name: "Baseten",
      models: [
        {
          id: "moonshotai/Kimi-K2.5",
          displayName: "Kimi K2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "nvidia/Nemotron-120B-A12B",
          displayName: "Nemotron 120B A12B",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "zai-org/GLM-5",
          displayName: "GLM-5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
      ],
      defaultModel: "moonshotai/Kimi-K2.5",
    });
  });

  test("lists Together AI in the provider catalog with the expected model set", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.default.together).toBe("moonshotai/Kimi-K2.5");
    expect(payload.all).toContainEqual({
      id: "together",
      name: "Together AI",
      models: [
        {
          id: "moonshotai/Kimi-K2.5",
          displayName: "Kimi K2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "Qwen/Qwen3.5-397B-A17B",
          displayName: "Qwen 3.5 397B A17B",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "zai-org/GLM-5",
          displayName: "GLM-5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
      ],
      defaultModel: "moonshotai/Kimi-K2.5",
    });
  });

  test("lists Fireworks AI in the provider catalog with the expected model set", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.default.fireworks).toBe("accounts/fireworks/models/glm-5");
    expect(payload.all).toContainEqual({
      id: "fireworks",
      name: "Fireworks AI",
      models: [
        {
          id: "accounts/fireworks/models/glm-5",
          displayName: "GLM 5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "accounts/fireworks/models/kimi-k2p5",
          displayName: "Kimi K2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "accounts/fireworks/models/minimax-m2p5",
          displayName: "MiniMax M2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "accounts/fireworks/routers/kimi-k2p5-turbo",
          displayName: "Kimi K2.5 Turbo",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
      ],
      defaultModel: "accounts/fireworks/models/glm-5",
    });
  });

  test("lists NVIDIA in the provider catalog with the expected model set", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.default.nvidia).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(payload.all).toContainEqual({
      id: "nvidia",
      name: "NVIDIA",
      models: [
        {
          id: "nvidia/nemotron-3-super-120b-a12b",
          displayName: "Nemotron 3 Super 120B A12B",
          knowledgeCutoff: "February 2026",
          supportsImageInput: false,
        },
      ],
      defaultModel: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  test("uses discovered AWS Bedrock Proxy models and ignores wildcard placeholders", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      object: "list",
      data: [
        { id: "*", object: "model" },
        { id: "openai.gpt-oss-120b-1:0", object: "model" },
        { id: "router", object: "model" },
        { id: "router1", object: "model" },
        { id: "us.anthropic.claude-sonnet-4-6", object: "model" },
      ],
    }));

    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "aws-bedrock-proxy": {
            service: "aws-bedrock-proxy",
            mode: "api_key",
            apiKey: "proxy-token",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com",
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const entry = payload.all.find((provider) => provider.id === "aws-bedrock-proxy");
    expect(entry?.models.map((model) => model.id)).toEqual([
      "openai.gpt-oss-120b-1:0",
      "router",
      "router1",
      "us.anthropic.claude-sonnet-4-6",
    ]);
    expect(entry?.defaultModel).toBe("openai.gpt-oss-120b-1:0");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("retains the active AWS Bedrock Proxy model when discovery omits it", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "aws-bedrock-proxy": {
            service: "aws-bedrock-proxy",
            mode: "api_key",
            apiKey: "proxy-token",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com",
        },
      },
      activeProvider: "aws-bedrock-proxy",
      activeModel: "router-shadow",
      fetchImpl: (async () => jsonResponse({
        object: "list",
        data: [
          { id: "router", object: "model" },
          { id: "us.anthropic.claude-sonnet-4-6", object: "model" },
        ],
      })) as unknown as typeof fetch,
    });

    const entry = payload.all.find((provider) => provider.id === "aws-bedrock-proxy");
    expect(entry?.models.map((model) => model.id)).toEqual([
      "router-shadow",
      "router",
      "us.anthropic.claude-sonnet-4-6",
    ]);
    expect(entry?.defaultModel).toBe("router-shadow");
  });

  test("AWS Bedrock Proxy discovery honors workspace providerOptions baseUrl over global config", async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://proxy.workspace.example.com/v1/models")) {
        return jsonResponse({
          object: "list",
          data: [{ id: "workspace-router", object: "model" }],
        });
      }
      if (url.startsWith("https://proxy.global.example.com/v1/models")) {
        return jsonResponse({
          object: "list",
          data: [{ id: "global-router", object: "model" }],
        });
      }
      return new Response("unexpected url", { status: 500 });
    });

    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "aws-bedrock-proxy": {
            service: "aws-bedrock-proxy",
            mode: "api_key",
            apiKey: "proxy-token",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
      config: {
        provider: "aws-bedrock-proxy",
        model: "workspace-router",
        preferredChildModel: "workspace-router",
        workingDirectory: "/tmp/workspace",
        projectAgentDir: "/tmp/workspace/.agent",
        userAgentDir: "/tmp/workspace/.agent-user",
        builtInDir: "/tmp/built-in",
        builtInConfigDir: "/tmp/built-in/config",
        skillsDirs: [],
        memoryDirs: [],
        configDirs: [],
        userName: "",
        knowledgeCutoff: "Unknown",
        awsBedrockProxyBaseUrl: "https://proxy.global.example.com/v1",
        providerOptions: {
          "aws-bedrock-proxy": {
            baseUrl: "https://proxy.workspace.example.com/v1",
          },
        },
      } as any,
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.workspace.example.com/v1",
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const entry = payload.all.find((provider) => provider.id === "aws-bedrock-proxy");
    expect(entry?.models.map((model) => model.id)).toEqual(["workspace-router"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://proxy.workspace.example.com/v1/models");
  });

  test("AWS Bedrock Proxy discovery falls back to global config baseUrl when no workspace override exists", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      object: "list",
      data: [{ id: "global-router", object: "model" }],
    }));

    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "aws-bedrock-proxy": {
            service: "aws-bedrock-proxy",
            mode: "api_key",
            apiKey: "proxy-token",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
      config: {
        provider: "aws-bedrock-proxy",
        model: "global-router",
        preferredChildModel: "global-router",
        workingDirectory: "/tmp/workspace",
        projectAgentDir: "/tmp/workspace/.agent",
        userAgentDir: "/tmp/workspace/.agent-user",
        builtInDir: "/tmp/built-in",
        builtInConfigDir: "/tmp/built-in/config",
        skillsDirs: [],
        memoryDirs: [],
        configDirs: [],
        userName: "",
        knowledgeCutoff: "Unknown",
        awsBedrockProxyBaseUrl: "https://proxy.global.example.com/v1/",
      } as any,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const entry = payload.all.find((provider) => provider.id === "aws-bedrock-proxy");
    expect(entry?.models.map((model) => model.id)).toEqual(["global-router"]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://proxy.global.example.com/v1/models");
  });

  test("marks AWS Bedrock Proxy as unreachable when discovery fails", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "aws-bedrock-proxy": {
            service: "aws-bedrock-proxy",
            mode: "api_key",
            apiKey: "proxy-token",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com",
        },
      },
      fetchImpl: (async () => new Response("temporary outage", { status: 503 })) as unknown as typeof fetch,
    });

    const entry = payload.all.find((provider) => provider.id === "aws-bedrock-proxy");
    expect(entry?.models).toEqual([]);
    expect(entry?.defaultModel).toBe("");
    expect(entry?.state).toBe("unreachable");
    expect(entry?.message).toBe("Proxy /models request failed (503): temporary outage");
  });

  test("retains active AWS Bedrock Proxy model when discovery fails", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "aws-bedrock-proxy": {
            service: "aws-bedrock-proxy",
            mode: "api_key",
            apiKey: "proxy-token",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com",
        },
      },
      activeProvider: "aws-bedrock-proxy",
      activeModel: "router-shadow",
      fetchImpl: (async () => new Response("temporary outage", { status: 503 })) as unknown as typeof fetch,
    });

    const entry = payload.all.find((provider) => provider.id === "aws-bedrock-proxy");
    expect(entry?.models.map((model) => model.id)).toEqual(["router-shadow"]);
    expect(entry?.defaultModel).toBe("router-shadow");
    expect(entry?.state).toBe("unreachable");
    expect(entry?.message).toBe("Proxy /models request failed (503): temporary outage");
  });

  test("connected providers exclude oauth_pending entries", async () => {
    const payload = await getProviderCatalog({
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          openai: {
            service: "openai",
            mode: "api_key",
            apiKey: "sk-test",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
          anthropic: {
            service: "anthropic",
            mode: "oauth_pending",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
          "codex-cli": {
            service: "codex-cli",
            mode: "oauth",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
    });

    expect(payload.connected).toContain("openai");
    expect(payload.connected).toContain("codex-cli");
    expect(payload.connected).not.toContain("anthropic");
  });

  test("connected providers include codex-cli when Cowork auth exists even if connections.json is empty", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-cowork-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const authPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        version: 1,
        auth_mode: "chatgpt",
        issuer: "https://auth.openai.com",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        tokens: {
          access_token: "cowork-access-token",
          refresh_token: "cowork-refresh-token",
        },
      }),
      "utf-8",
    );

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    expect(payload.connected).toContain("codex-cli");
  });

  test("codex-cli only appears once in connected when both store oauth and cowork auth exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-codex-dedupe-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const authPath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        version: 1,
        auth_mode: "chatgpt",
        issuer: "https://auth.openai.com",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        tokens: {
          access_token: "cowork-access-token",
          refresh_token: "cowork-refresh-token",
        },
      }),
      "utf-8",
    );

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          "codex-cli": {
            service: "codex-cli",
            mode: "oauth",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
    });

    expect(payload.connected.filter((provider) => provider === "codex-cli")).toEqual(["codex-cli"]);
  });
});
