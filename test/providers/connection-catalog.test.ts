import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAiCoworkerPaths } from "../../src/connect";
import {
  getProviderCatalog,
  listProviderCatalogEntries,
} from "../../src/providers/connectionCatalog";
import { upsertCustomModel } from "../../src/providers/customModels";
import { writeModelDiscoveryCache } from "../../src/providers/modelDiscoveryCache";
import { setModelPreferences } from "../../src/providers/modelPreferences";
import { PROVIDER_NAMES } from "../../src/types";

const noCodexAccount = async () => ({
  account: null,
  requiresOpenaiAuth: true,
});

function emptyConnectionStore() {
  return {
    version: 1 as const,
    updatedAt: "2026-02-17T00:00:00.000Z",
    services: {},
  };
}

async function staticCatalogTestOptions(prefix: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = getAiCoworkerPaths({ homedir: home });
  const store = emptyConnectionStore();
  return {
    paths,
    store,
    env: {} as NodeJS.ProcessEnv,
    readCodexAppServerAccountImpl: noCodexAccount,
    readStore: async () => store,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("providers/connectionCatalog", () => {
  test("marks models with selector-ready reasoning effort metadata", async () => {
    const entries = await listProviderCatalogEntries({ platform: "linux" });
    const openAiModel = entries
      .find((entry) => entry.id === "openai")
      ?.models.find((model) => model.id === "gpt-5.4");
    const googleModel = entries
      .find((entry) => entry.id === "google")
      ?.models.find((model) => model.id === "gemini-3.1-pro-preview");
    const anthropicModel = entries
      .find((entry) => entry.id === "anthropic")
      ?.models.find((model) => model.id === "claude-opus-4-8");

    expect(openAiModel?.reasoning).toEqual({
      defaultEffort: "high",
      availableEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    });
    expect(googleModel?.reasoning).toEqual({
      defaultEffort: "dynamic",
      availableEfforts: ["dynamic", "low", "medium", "high"],
    });
    expect(anthropicModel?.reasoning).toBeUndefined();
  });

  test("catalog entries stay aligned with provider names and default-model map", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-align-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      platform: "linux",
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    const entryIds = payload.all.map((entry) => entry.id);
    expect(entryIds).toEqual(PROVIDER_NAMES);
    expect(payload.all).toEqual(
      await listProviderCatalogEntries({
        paths: staticOpts.paths,
        store: staticOpts.store,
        env: staticOpts.env,
        platform: "linux",
      }),
    );
    expect(Object.keys(payload.default)).toEqual(PROVIDER_NAMES);
    for (const entry of payload.all) {
      expect(payload.default[entry.id]).toBe(entry.defaultModel);
    }
  });

  test("omits Antigravity from the Windows catalog", async () => {
    const payload = await getProviderCatalog({
      platform: "win32",
      readCodexAppServerAccountImpl: noCodexAccount,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {
          antigravity: {
            service: "antigravity",
            mode: "api_key",
            apiKey: "anti-secret-key-123",
            updatedAt: "2026-02-17T00:00:00.000Z",
          },
        },
      }),
    });

    expect(payload.all.some((candidate) => candidate.id === "antigravity")).toBe(false);
    expect(payload.default).not.toHaveProperty("antigravity");
    expect(payload.connected).not.toContain("antigravity");
  });

  test("lists OpenCode providers in the provider catalog with the expected model sets", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-opencode-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    expect(payload.default["opencode-go"]).toBe("glm-5");
    expect(payload.all).toContainEqual({
      id: "opencode-go",
      name: "OpenCode Go",
      models: [
        {
          id: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
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
          id: "glm-5.1",
          displayName: "GLM-5.1",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "hy3-preview",
          displayName: "Hy3 Preview",
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
          id: "kimi-k2.6",
          displayName: "Kimi K2.6",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "mimo-v2-omni",
          displayName: "MiMo V2 Omni",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "mimo-v2-pro",
          displayName: "MiMo V2 Pro",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "mimo-v2.5",
          displayName: "MiMo V2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "mimo-v2.5-pro",
          displayName: "MiMo V2.5 Pro",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "minimax-m2.5",
          displayName: "MiniMax M2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "minimax-m2.7",
          displayName: "MiniMax M2.7",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "minimax-m3",
          displayName: "MiniMax M3",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "qwen3.5-plus",
          displayName: "Qwen3.5 Plus",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "qwen3.6-plus",
          displayName: "Qwen3.6 Plus",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "qwen3.7-max",
          displayName: "Qwen3.7 Max",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "qwen3.7-plus",
          displayName: "Qwen3.7 Plus",
          knowledgeCutoff: "Unknown",
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
          id: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-opus-4-1",
          displayName: "Claude Opus 4.1",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-opus-4-5",
          displayName: "Claude Opus 4.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-opus-4-7",
          displayName: "Claude Opus 4.7",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-opus-4-8",
          displayName: "Claude Opus 4.8",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-sonnet-4",
          displayName: "Claude Sonnet 4",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-sonnet-4-5",
          displayName: "Claude Sonnet 4.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "deepseek-v4-flash-free",
          displayName: "DeepSeek V4 Flash Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "gemini-3-flash",
          displayName: "Gemini 3 Flash",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gemini-3.1-pro",
          displayName: "Gemini 3.1 Pro Preview",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gemini-3.5-flash",
          displayName: "Gemini 3.5 Flash",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "glm-5",
          displayName: "GLM-5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "glm-5.1",
          displayName: "GLM-5.1",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "gpt-5",
          displayName: "GPT-5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5-codex",
          displayName: "GPT-5 Codex",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5-nano",
          displayName: "GPT-5 Nano",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.1",
          displayName: "GPT-5.1",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.1-codex",
          displayName: "GPT-5.1 Codex",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.1-codex-max",
          displayName: "GPT-5.1 Codex Max",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.1-codex-mini",
          displayName: "GPT-5.1 Codex Mini",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.2",
          displayName: "GPT-5.2",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.2-codex",
          displayName: "GPT-5.2 Codex",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.3-codex",
          displayName: "GPT-5.3 Codex",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.4-nano",
          displayName: "GPT-5.4 Nano",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.4-pro",
          displayName: "GPT-5.4 Pro",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "gpt-5.5-pro",
          displayName: "GPT-5.5 Pro",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "grok-build-0.1",
          displayName: "Grok Build 0.1",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "kimi-k2.5",
          displayName: "Kimi K2.5",
          knowledgeCutoff: "April 2024",
          supportsImageInput: true,
        },
        {
          id: "kimi-k2.6",
          displayName: "Kimi K2.6",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "mimo-v2.5-free",
          displayName: "MiMo V2.5 Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "minimax-m2.5",
          displayName: "MiniMax M2.5",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "minimax-m2.7",
          displayName: "MiniMax M2.7",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "minimax-m3-free",
          displayName: "MiniMax M3 Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "nemotron-3-ultra-free",
          displayName: "Nemotron 3 Ultra Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "north-mini-code-free",
          displayName: "North Mini Code Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: false,
        },
        {
          id: "qwen3.5-plus",
          displayName: "Qwen3.5 Plus",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "qwen3.6-plus",
          displayName: "Qwen3.6 Plus",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
        {
          id: "qwen3.6-plus-free",
          displayName: "Qwen3.6 Plus Free",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
      ],
      defaultModel: "glm-5",
    });
  });

  test("lists Baseten in the provider catalog with the expected model set", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-baseten-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
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
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-together-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
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
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-fireworks-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    expect(payload.default.fireworks).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(payload.all).toContainEqual({
      id: "fireworks",
      name: "Fireworks AI",
      models: [
        {
          id: "accounts/fireworks/models/deepseek-v4-pro",
          displayName: "DeepSeek-V4-Pro",
          knowledgeCutoff: "May 2025",
          supportsImageInput: false,
        },
        {
          id: "accounts/fireworks/models/glm-5p1",
          displayName: "GLM 5.1",
          knowledgeCutoff: "Mid 2025",
          supportsImageInput: false,
        },
        {
          id: "accounts/fireworks/models/kimi-k2p6",
          displayName: "Kimi K2.6",
          knowledgeCutoff: "April 2025",
          supportsImageInput: true,
        },
        {
          id: "accounts/fireworks/models/minimax-m2p7",
          displayName: "MiniMax M2.7",
          knowledgeCutoff: "March 2025",
          supportsImageInput: false,
        },
        {
          id: "accounts/fireworks/models/qwen3p6-plus",
          displayName: "Qwen3.6 Plus",
          knowledgeCutoff: "Mid 2025",
          supportsImageInput: true,
        },
      ],
      defaultModel: "accounts/fireworks/models/kimi-k2p6",
    });
  });

  test("lists Fire Pass in the provider catalog with the expected model set", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-firepass-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    expect(payload.default.firepass).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
    expect(payload.all).toContainEqual({
      id: "firepass",
      name: "Fire Pass",
      models: [
        {
          id: "accounts/fireworks/routers/kimi-k2p6-turbo",
          displayName: "Kimi K2.6 Turbo",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
      ],
      defaultModel: "accounts/fireworks/routers/kimi-k2p6-turbo",
    });
  });

  test("lists NVIDIA in the provider catalog with the expected model set", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-nvidia-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
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

  test("merges configured custom model IDs into provider catalogs", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-custom-models-");
    await upsertCustomModel(staticOpts.paths, "nvidia", "nvidia/custom-nemotron-preview");
    await upsertCustomModel(staticOpts.paths, "anthropic", "claude-custom-20260704");

    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    const nvidia = payload.all.find((entry) => entry.id === "nvidia");
    const anthropic = payload.all.find((entry) => entry.id === "anthropic");
    expect(payload.default.nvidia).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(nvidia?.models).toContainEqual({
      id: "nvidia/custom-nemotron-preview",
      displayName: "nvidia/custom-nemotron-preview",
      description: "Custom model ID",
      knowledgeCutoff: "Unknown",
      supportsImageInput: false,
      runtimeOptions: { source: "custom" },
    });
    expect(anthropic?.models).toContainEqual({
      id: "claude-custom-20260704",
      displayName: "claude-custom-20260704",
      description: "Custom model ID",
      knowledgeCutoff: "Unknown",
      supportsImageInput: false,
      runtimeOptions: { source: "custom" },
    });
  });

  test("marks discovered non-curated models as disabled by default", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-prefs-default-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    await upsertCustomModel(paths, "openai", "my-custom-model");
    const fetchImpl = mock(async (url: string | URL | Request) => {
      if (String(url) === "https://api.openai.com/v1/models") {
        return jsonResponse({
          object: "list",
          data: [
            { id: "gpt-5.4", object: "model", owned_by: "openai" },
            { id: "gpt-5.6-experimental", object: "model", owned_by: "openai" },
          ],
        });
      }
      throw new Error(`unexpected model list URL: ${String(url)}`);
    });

    const payload = await getProviderCatalog({
      paths,
      refresh: true,
      env: {} as NodeJS.ProcessEnv,
      modelDiscoveryFetchImpl: fetchImpl as unknown as typeof fetch,
      readCodexAppServerAccountImpl: noCodexAccount,
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
        },
      }),
    });

    const openai = payload.all.find((entry) => entry.id === "openai");
    const byId = new Map(openai?.models.map((model) => [model.id, model] as const));
    expect(byId.get("gpt-5.4")?.enabled).toBeUndefined();
    expect(byId.get("gpt-5.6-experimental")?.enabled).toBe(false);
    expect(byId.get("my-custom-model")?.enabled).toBeUndefined();
  });

  test("model preference overrides flip enabled state and repair the default model", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-prefs-override-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    await setModelPreferences(paths, "openai", [
      { id: "gpt-5.4", enabled: false },
      { id: "gpt-5.6-experimental", enabled: true },
    ]);
    const fetchImpl = mock(async (url: string | URL | Request) => {
      if (String(url) === "https://api.openai.com/v1/models") {
        return jsonResponse({
          object: "list",
          data: [
            { id: "gpt-5.4", object: "model", owned_by: "openai" },
            { id: "gpt-5.6-experimental", object: "model", owned_by: "openai" },
          ],
        });
      }
      throw new Error(`unexpected model list URL: ${String(url)}`);
    });

    const payload = await getProviderCatalog({
      paths,
      refresh: true,
      env: {} as NodeJS.ProcessEnv,
      modelDiscoveryFetchImpl: fetchImpl as unknown as typeof fetch,
      readCodexAppServerAccountImpl: noCodexAccount,
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
        },
      }),
    });

    const openai = payload.all.find((entry) => entry.id === "openai");
    const byId = new Map(openai?.models.map((model) => [model.id, model] as const));
    expect(byId.get("gpt-5.4")?.enabled).toBe(false);
    expect(byId.get("gpt-5.6-experimental")?.enabled).toBeUndefined();
    expect(openai?.defaultModel).toBe("gpt-5.6-experimental");
    expect(payload.default.openai).toBe("gpt-5.6-experimental");
  });

  test("keeps every model enabled when curation misses discovery and no overrides exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-prefs-failopen-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const fetchImpl = mock(async (url: string | URL | Request) => {
      if (String(url) === "https://api.openai.com/v1/models") {
        return jsonResponse({
          object: "list",
          data: [
            { id: "gpt-totally-unknown-alpha", object: "model", owned_by: "openai" },
            { id: "gpt-totally-unknown-beta", object: "model", owned_by: "openai" },
          ],
        });
      }
      throw new Error(`unexpected model list URL: ${String(url)}`);
    });

    const payload = await getProviderCatalog({
      paths,
      refresh: true,
      env: {} as NodeJS.ProcessEnv,
      modelDiscoveryFetchImpl: fetchImpl as unknown as typeof fetch,
      readCodexAppServerAccountImpl: noCodexAccount,
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
        },
      }),
    });

    const openai = payload.all.find((entry) => entry.id === "openai");
    expect(openai?.models.length).toBe(2);
    expect(openai?.models.every((model) => model.enabled === undefined)).toBe(true);
  });

  test("static catalogs keep curated models enabled without preference flags", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-prefs-static-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      platform: "linux",
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    for (const entry of payload.all) {
      for (const model of entry.models) {
        expect(model.enabled).toBeUndefined();
      }
    }
  });

  test("lists MiniMax in the provider catalog with the expected model set", async () => {
    const staticOpts = await staticCatalogTestOptions("connection-catalog-static-minimax-");
    const payload = await getProviderCatalog({
      paths: staticOpts.paths,
      env: staticOpts.env,
      readCodexAppServerAccountImpl: staticOpts.readCodexAppServerAccountImpl,
      readStore: staticOpts.readStore,
    });

    expect(payload.default.minimax).toBe("MiniMax-M3");
    expect(payload.all).toContainEqual({
      id: "minimax",
      name: "MiniMax",
      models: [
        {
          id: "MiniMax-M3",
          displayName: "MiniMax M3",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
      ],
      defaultModel: "MiniMax-M3",
    });
  });

  test("connected providers exclude oauth_pending entries", async () => {
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
      // Pin env so ambient provider API keys can't mark providers connected.
      env: {},
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

  test("connected providers include codex-cli when app-server account exists even if connections.json is empty", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-cowork-"));
    const paths = getAiCoworkerPaths({ homedir: home });

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
      readCodexAppServerAccountImpl: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: false,
      }),
      listCodexAppServerModelsImpl: async () => [],
    });

    expect(payload.connected).toContain("codex-cli");
  });

  test("refreshes live API model catalogs and keeps unknown discovered model IDs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-api-models-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.openai.com/v1/models") {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
        return jsonResponse({
          object: "list",
          data: [
            { id: "gpt-5.4", object: "model", created: 1780000000, owned_by: "openai" },
            { id: "gpt-5.6-experimental", object: "model", owned_by: "openai" },
            { id: "text-embedding-3-small", object: "model", owned_by: "openai" },
          ],
        });
      }
      if (href === "https://opencode.ai/zen/go/v1/models") {
        return jsonResponse({
          object: "list",
          data: [
            { id: "glm-5", object: "model", owned_by: "opencode" },
            { id: "kimi-k2.7-code", object: "model", owned_by: "opencode" },
          ],
        });
      }
      if (href === "https://opencode.ai/zen/v1/models") {
        return jsonResponse({
          object: "list",
          data: [
            { id: "glm-5", object: "model", owned_by: "opencode" },
            { id: "claude-fable-5", object: "model", owned_by: "opencode" },
          ],
        });
      }
      throw new Error(`unexpected model list URL: ${href}`);
    });

    const payload = await getProviderCatalog({
      paths,
      refresh: true,
      env: {} as NodeJS.ProcessEnv,
      modelDiscoveryFetchImpl: fetchImpl as unknown as typeof fetch,
      readCodexAppServerAccountImpl: noCodexAccount,
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
        },
      }),
    });

    const openai = payload.all.find((entry) => entry.id === "openai");
    expect(openai?.state).toBe("ready");
    expect(openai?.defaultModel).toBe("gpt-5.4");
    expect(openai?.models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.6-experimental"]);
    expect(openai?.models.find((model) => model.id === "gpt-5.6-experimental")).toMatchObject({
      displayName: "GPT 5.6 Experimental",
      knowledgeCutoff: "Unknown",
      supportsImageInput: false,
      reasoning: {
        defaultEffort: "high",
        availableEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      },
    });
    expect(payload.connected).toContain("openai");
    expect(
      payload.all.find((entry) => entry.id === "opencode-go")?.models.map((model) => model.id),
    ).toEqual(["glm-5", "kimi-k2.7-code"]);
    expect(
      payload.all.find((entry) => entry.id === "opencode-zen")?.models.map((model) => model.id),
    ).toEqual(["glm-5", "claude-fable-5"]);
  });

  test("codex-cli catalog uses app-server available models when account exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-codex-models-"));
    const paths = getAiCoworkerPaths({ homedir: home });

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
      readCodexAppServerAccountImpl: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: false,
      }),
      listCodexAppServerModelsImpl: async () => [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5 from app-server",
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          isDefault: true,
        },
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4 from app-server",
          isDefault: false,
        },
        {
          id: "gpt-5.4-duplicate",
          model: "gpt-5.4",
          displayName: "Duplicate GPT-5.4",
          isDefault: false,
        },
        {
          id: "gpt-5.4-mini",
          model: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini from app-server",
          isDefault: false,
        },
        {
          id: "gpt-5.3-codex-spark",
          model: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark from app-server",
          isDefault: false,
        },
        {
          id: "gpt-5.3-codex",
          model: "gpt-5.3-codex",
          displayName: "Unsupported alias",
          isDefault: false,
        },
        {
          id: "future-model",
          model: "future-model",
          displayName: "Future Model",
          description: "Future model from live discovery.",
          supportsImageInput: true,
          reasoningEfforts: ["low", "medium", "high"],
          reasoningDefaultEffort: "medium",
          runtimeOptions: {
            webSearchMode: "cached",
            apiKey: "secret",
          },
          runtimeOverrides: {
            reasoningSummary: "concise",
          },
          isDefault: false,
        },
      ],
    });

    const codex = payload.all.find((entry) => entry.id === "codex-cli");
    expect(codex?.defaultModel).toBe("gpt-5.5");
    expect(codex?.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "gpt-5.3-codex",
      "future-model",
    ]);
    expect(codex?.models.map((model) => model.displayName)).toEqual([
      "GPT-5.5 from app-server",
      "GPT-5.4 from app-server",
      "GPT-5.4 Mini from app-server",
      "GPT-5.3 Codex Spark from app-server",
      "Unsupported alias",
      "Future Model",
    ]);
    expect(codex?.models.find((model) => model.id === "gpt-5.4")).toMatchObject({
      knowledgeCutoff: "August 31, 2025",
      supportsImageInput: true,
      reasoning: {
        defaultEffort: "high",
        availableEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      },
    });
    expect(codex?.models.find((model) => model.id === "gpt-5.5")?.reasoning).toEqual({
      defaultEffort: "high",
      availableEfforts: ["none", "low", "medium", "high", "xhigh"],
    });
    expect(codex?.models.find((model) => model.id === "future-model")).toEqual({
      id: "future-model",
      displayName: "Future Model",
      description: "Future model from live discovery.",
      knowledgeCutoff: "Unknown",
      supportsImageInput: true,
      reasoning: {
        defaultEffort: "medium",
        availableEfforts: ["low", "medium", "high"],
      },
      runtimeOptions: {
        webSearchMode: "cached",
      },
      runtimeOverrides: {
        reasoningSummary: "concise",
      },
    });
    expect(payload.connected).toContain("codex-cli");
  });

  test("codex-cli catalog serves stale cached models when app-server discovery fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-codex-stale-"));
    const paths = getAiCoworkerPaths({ homedir: home });
    await writeModelDiscoveryCache(
      paths,
      "codex-cli",
      {
        provider: "codex-cli",
        source: "app-server",
        updatedAt: "2026-07-01T12:00:00.000Z",
        models: [
          {
            id: "cached-model",
            model: "cached-model",
            displayName: "Cached Model",
            description: "Cached description.",
            supportsImageInput: false,
            isDefault: true,
            reasoning: {
              defaultEffort: "high",
              availableEfforts: ["low", "medium", "high"],
            },
            runtimeOptions: {
              webSearchMode: "cached",
            },
          },
        ],
      },
      { ttlMs: -1 },
    );

    const payload = await getProviderCatalog({
      paths,
      refresh: true,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
      readCodexAppServerAccountImpl: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: false,
      }),
      listCodexAppServerModelsImpl: async () => {
        throw new Error("model/list failed");
      },
    });

    const codex = payload.all.find((entry) => entry.id === "codex-cli");
    expect(codex?.models).toEqual([
      {
        id: "cached-model",
        displayName: "Cached Model",
        description: "Cached description.",
        knowledgeCutoff: "Unknown",
        supportsImageInput: false,
        reasoning: {
          defaultEffort: "high",
          availableEfforts: ["low", "medium", "high"],
        },
        runtimeOptions: {
          webSearchMode: "cached",
        },
      },
    ]);
    expect(codex?.defaultModel).toBe("cached-model");
    expect(codex?.state).toBe("unreachable");
    expect(codex?.message).toContain("model/list failed");
    expect(codex?.message).toContain("Using cached model catalog from 2026-07-01T12:00:00.000Z");
    expect(payload.connected).toContain("codex-cli");
  });

  test("codex-cli catalog does not fall back to hardcoded models for app-server failures", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-codex-failure-"));
    const paths = getAiCoworkerPaths({ homedir: home });

    const payload = await getProviderCatalog({
      paths,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
      readCodexAppServerAccountImpl: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: false,
      }),
      listCodexAppServerModelsImpl: async () => {
        throw new Error("model/list failed");
      },
    });

    const codex = payload.all.find((entry) => entry.id === "codex-cli");
    expect(codex?.models).toEqual([]);
    expect(codex?.defaultModel).toBe("");
    expect(codex?.state).toBe("unreachable");
    expect(codex?.message).toBe("model/list failed");
    expect(payload.connected).toContain("codex-cli");
  });

  test("codex-cli only appears once in connected when both store oauth and app-server account exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connection-catalog-codex-dedupe-"));
    const paths = getAiCoworkerPaths({ homedir: home });

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
      readCodexAppServerAccountImpl: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: false,
      }),
      listCodexAppServerModelsImpl: async () => [],
    });

    expect(payload.connected.filter((provider) => provider === "codex-cli")).toEqual(["codex-cli"]);
  });
});
