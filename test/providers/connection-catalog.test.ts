import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAiCoworkerPaths } from "../../src/connect";
import {
  getProviderCatalog,
  listProviderCatalogEntries,
} from "../../src/providers/connectionCatalog";
import { PROVIDER_NAMES } from "../../src/types";

const noCodexAccount = async () => ({
  account: null,
  requiresOpenaiAuth: true,
});

describe("providers/connectionCatalog", () => {
  test("catalog entries stay aligned with provider names and default-model map", async () => {
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
    });

    const entryIds = payload.all.map((entry) => entry.id);
    expect(entryIds).toEqual(PROVIDER_NAMES);
    expect(payload.all).toEqual(await listProviderCatalogEntries());
    expect(Object.keys(payload.default)).toEqual(PROVIDER_NAMES);
    for (const entry of payload.all) {
      expect(payload.default[entry.id]).toBe(entry.defaultModel);
    }
  });

  test("marks Antigravity unreachable on Windows", async () => {
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

    const entry = payload.all.find((candidate) => candidate.id === "antigravity");
    expect(entry).toEqual({
      id: "antigravity",
      name: "Antigravity",
      models: [],
      defaultModel: "",
      state: "unreachable",
      message: "Antigravity runtime is only supported on macOS and Linux for now.",
    });
    expect(payload.connected).not.toContain("antigravity");
  });

  test("lists OpenCode providers in the provider catalog with the expected model sets", async () => {
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
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
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
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
      readCodexAppServerAccountImpl: noCodexAccount,
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
      readCodexAppServerAccountImpl: noCodexAccount,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
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
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
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
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
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

  test("lists MiniMax in the provider catalog with the expected model set", async () => {
    const payload = await getProviderCatalog({
      readCodexAppServerAccountImpl: noCodexAccount,
      readStore: async () => ({
        version: 1,
        updatedAt: "2026-02-17T00:00:00.000Z",
        services: {},
      }),
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
          supportsImageInput: true,
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
    });
    expect(codex?.models.find((model) => model.id === "future-model")).toEqual({
      id: "future-model",
      displayName: "Future Model",
      knowledgeCutoff: "Unknown",
      supportsImageInput: true,
    });
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
