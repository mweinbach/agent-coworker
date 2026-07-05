import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../../src/connect";
import {
  createAnthropicModelDiscoveryAdapter,
  createCodexAppServerModelDiscoveryAdapter,
  createGoogleModelDiscoveryAdapter,
  createLmStudioModelDiscoveryAdapter,
  discoverBedrockModels,
  discoverOpenAiCompatibleModels,
  discoverStaticProviderModels,
} from "../../src/providers/modelDiscoveryAdapters";
import {
  isModelDiscoveryCacheFresh,
  modelDiscoveryCachePath,
  readModelDiscoveryCache,
  readModelDiscoveryCacheSync,
  writeModelDiscoveryCache,
} from "../../src/providers/modelDiscoveryCache";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function tmpPaths(prefix: string) {
  return getAiCoworkerPaths({ homedir: await fs.mkdtemp(path.join(os.tmpdir(), prefix)) });
}

describe("providers/modelDiscoveryCache", () => {
  test("writes provider caches under .cowork/cache/models with TTL metadata", async () => {
    const paths = await tmpPaths("model-cache-");
    const now = new Date("2026-07-01T12:00:00.000Z");

    const written = await writeModelDiscoveryCache(
      paths,
      "codex-cli",
      {
        provider: "codex-cli",
        source: "app-server",
        models: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex" }],
      },
      { now, ttlMs: 1_000 },
    );

    expect(modelDiscoveryCachePath(paths, "codex-cli")).toBe(
      path.join(paths.rootDir, "cache", "models", "codex-cli.json"),
    );
    expect(written.updatedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(written.expiresAt).toBe("2026-07-01T12:00:01.000Z");
    expect(isModelDiscoveryCacheFresh(written, Date.parse("2026-07-01T12:00:00.500Z"))).toBe(true);
    expect(isModelDiscoveryCacheFresh(written, Date.parse("2026-07-01T12:00:01.500Z"))).toBe(false);
    expect(await readModelDiscoveryCache(paths, "codex-cli")).toEqual(written);
  });

  test("atomically replaces cache contents and strips secrets from runtime metadata", async () => {
    const paths = await tmpPaths("model-cache-sanitize-");

    await writeModelDiscoveryCache(paths, "openai", {
      provider: "openai",
      source: "api",
      models: [{ id: "old-model", displayName: "Old Model" }],
    });
    await writeModelDiscoveryCache(paths, "openai", {
      provider: "openai",
      source: "api",
      models: [
        {
          id: "new-model",
          displayName: "New Model",
          runtimeOptions: {
            maxOutputTokens: 4096,
            apiKey: "sk-secret",
            nested: {
              authorization: "Bearer secret",
              keep: "safe",
            },
            array: [{ token: "secret" }, { visible: true }],
          },
          runtimeOverrides: {
            webSearchMode: "cached",
            credential: "secret",
          },
        },
      ],
    });

    const raw = JSON.parse(await fs.readFile(modelDiscoveryCachePath(paths, "openai"), "utf-8"));
    expect(JSON.stringify(raw)).not.toContain("sk-secret");
    expect(JSON.stringify(raw)).not.toContain("Bearer secret");
    expect(JSON.stringify(raw)).not.toContain("credential");
    expect(await readModelDiscoveryCache(paths, "openai")).toMatchObject({
      provider: "openai",
      models: [
        {
          id: "new-model",
          runtimeOptions: {
            maxOutputTokens: 4096,
            nested: { keep: "safe" },
            array: [{}, { visible: true }],
          },
          runtimeOverrides: {
            webSearchMode: "cached",
          },
        },
      ],
    });
  });

  test("ignores invalid cache files", async () => {
    const paths = await tmpPaths("model-cache-invalid-");
    await fs.mkdir(path.dirname(modelDiscoveryCachePath(paths, "openai")), { recursive: true });
    await fs.writeFile(modelDiscoveryCachePath(paths, "openai"), "{ invalid json", "utf-8");
    expect(await readModelDiscoveryCache(paths, "openai")).toBeNull();
  });

  test("readModelDiscoveryCacheSync mirrors the async reader", async () => {
    const paths = await tmpPaths("model-cache-sync-");
    // Missing cache reads as null.
    expect(readModelDiscoveryCacheSync(paths, "openai")).toBeNull();

    const written = await writeModelDiscoveryCache(paths, "openai", {
      provider: "openai",
      source: "api",
      models: [{ id: "discovered-1", displayName: "Discovered 1" }],
    });
    expect(readModelDiscoveryCacheSync(paths, "openai")).toEqual(written);
    expect(readModelDiscoveryCacheSync(paths, "openai")).toEqual(
      await readModelDiscoveryCache(paths, "openai"),
    );
  });

  test("readModelDiscoveryCacheSync ignores invalid cache files", async () => {
    const paths = await tmpPaths("model-cache-sync-invalid-");
    await fs.mkdir(path.dirname(modelDiscoveryCachePath(paths, "openai")), { recursive: true });
    await fs.writeFile(modelDiscoveryCachePath(paths, "openai"), "{ invalid json", "utf-8");
    expect(readModelDiscoveryCacheSync(paths, "openai")).toBeNull();
  });
});

describe("providers/modelDiscoveryAdapters", () => {
  test("Codex app-server adapter carries descriptions, reasoning, and runtime options", async () => {
    const adapter = createCodexAppServerModelDiscoveryAdapter({
      listCodexAppServerModelsImpl: async () => [
        {
          id: "future-model",
          model: "future-model",
          displayName: "Future Model",
          description: "Newest Codex model.",
          supportsImageInput: true,
          reasoningEfforts: ["low", "medium", "high"],
          reasoningDefaultEffort: "medium",
          runtimeOptions: { webSearchMode: "cached", apiKey: "secret" },
          runtimeOverrides: { reasoningSummary: "concise" },
          isDefault: true,
        },
      ],
    });

    const result = await adapter.discover({ reason: "test" });
    expect(result.source).toBe("app-server");
    expect(result.models).toEqual([
      {
        id: "future-model",
        model: "future-model",
        displayName: "Future Model",
        description: "Newest Codex model.",
        supportsImageInput: true,
        isDefault: true,
        reasoning: {
          defaultEffort: "medium",
          availableEfforts: ["low", "medium", "high"],
        },
        runtimeOptions: { webSearchMode: "cached", apiKey: "secret" },
        runtimeOverrides: { reasoningSummary: "concise" },
      },
    ]);
  });

  test("LM Studio adapter reads local HTTP models", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({
        models: [
          {
            type: "llm",
            publisher: "local",
            key: "local/alpha",
            display_name: "Local Alpha",
            description: "Local test model.",
            loaded_instances: [{ id: "loaded", config: { context_length: 8192 } }],
            max_context_length: 32768,
            capabilities: { vision: true, trained_for_tool_use: true },
            size_bytes: 1,
            architecture: "llama",
            format: "gguf",
          },
          {
            type: "embedding",
            publisher: "local",
            key: "local/embed",
            loaded_instances: [],
            max_context_length: 4096,
            size_bytes: 1,
          },
        ],
      }),
    );
    const adapter = createLmStudioModelDiscoveryAdapter({
      baseUrl: "http://localhost:1234",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.discover({ reason: "test" });

    expect(result.source).toBe("local-http");
    expect(result.models).toMatchObject([
      {
        id: "local/alpha",
        displayName: "Local Alpha",
        description: "Local test model.",
        supportsImageInput: true,
        isDefault: true,
        runtimeOptions: {
          maxContextLength: 32768,
          effectiveContextLength: 8192,
          trainedForToolUse: true,
          architecture: "llama",
          format: "gguf",
        },
      },
    ]);
  });

  test("OpenAI-compatible adapter parses model lists and filters non-generation models", async () => {
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/models");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "gpt-5.4",
            object: "model",
            created: 1780000000,
            owned_by: "openai",
          },
          {
            id: "gpt-5.6-experimental",
            object: "model",
            created: 1780000001,
            owned_by: "openai",
          },
          {
            id: "text-embedding-3-large",
            object: "model",
            created: 1780000002,
            owned_by: "openai",
          },
        ],
      });
    });

    const result = await discoverOpenAiCompatibleModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.source).toBe("api");
    expect(result.models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.6-experimental"]);
    expect(result.models[0]).toMatchObject({
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      isDefault: true,
      runtimeOptions: {
        source: "models-api",
        created: 1780000000,
        ownedBy: "openai",
      },
    });
    expect(result.models[1]).toMatchObject({
      id: "gpt-5.6-experimental",
      displayName: "GPT 5.6 Experimental",
      reasoning: {
        defaultEffort: "high",
        availableEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      },
    });
  });

  test("Google adapter keeps Gemini generateContent models and filters embeddings/media", async () => {
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain("gemini-secret");
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-secret");
      const parsed = new URL(String(url));
      if (!parsed.searchParams.get("pageToken")) {
        return jsonResponse({
          models: [
            {
              name: "models/gemini-3.5-flash",
              displayName: "Gemini 3.5 Flash",
              description: "Fast multimodal generation model.",
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ["generateContent", "countTokens"],
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
            {
              name: "models/imagen-3",
              displayName: "Imagen 3",
              supportedGenerationMethods: ["generateImages"],
            },
          ],
          nextPageToken: "page-2",
        });
      }
      return jsonResponse({
        models: [
          {
            name: "models/gemini-3.1-pro-preview",
            displayName: "Gemini 3.1 Pro Preview",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          },
        ],
      });
    });
    const adapter = createGoogleModelDiscoveryAdapter({
      apiKey: "gemini-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.discover({ reason: "test" });

    expect(result.models.map((model) => model.id)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
    ]);
    expect(result.models[0]).toMatchObject({
      displayName: "Gemini 3.5 Flash",
      description: "Fast multimodal generation model.",
      supportsImageInput: true,
      reasoning: {
        defaultEffort: "dynamic",
        availableEfforts: ["dynamic", "minimal", "low", "medium", "high"],
      },
      runtimeOptions: {
        source: "models-api",
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ["generateContent", "countTokens"],
      },
    });
  });

  test("Anthropic adapter parses paginated Claude model lists", async () => {
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("anthropic-secret");
      expect((init?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
      const parsed = new URL(String(url));
      if (!parsed.searchParams.get("after_id")) {
        return jsonResponse({
          data: [
            {
              id: "claude-opus-4-8",
              display_name: "Claude Opus 4.8",
              created_at: "2026-06-01T00:00:00Z",
              type: "model",
            },
            {
              id: "not-claude-model",
              display_name: "Not Claude",
            },
          ],
          has_more: true,
          last_id: "claude-opus-4-8",
        });
      }
      return jsonResponse({
        data: [
          {
            id: "claude-future-5",
            display_name: "Claude Future 5",
          },
        ],
        has_more: false,
      });
    });
    const adapter = createAnthropicModelDiscoveryAdapter({
      apiKey: "anthropic-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.discover({ reason: "test" });

    expect(result.source).toBe("api");
    expect(result.models.map((model) => model.id)).toEqual(["claude-opus-4-8", "claude-future-5"]);
    expect(result.models[0]).toMatchObject({
      displayName: "Claude Opus 4.8",
      runtimeOptions: {
        source: "models-api",
        createdAt: "2026-06-01T00:00:00Z",
        sourceType: "model",
      },
    });
  });

  test("Bedrock adapter emits static fallback when credentials are unavailable", async () => {
    const paths = await tmpPaths("model-cache-bedrock-");
    const result = await discoverBedrockModels({
      paths,
      env: {} as NodeJS.ProcessEnv,
      force: true,
    });

    expect(result.provider).toBe("bedrock");
    expect(result.source).toBe("static");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.message).toContain("not configured");
  });

  test("static adapter emits bundled registry data", () => {
    const result = discoverStaticProviderModels("openai");
    expect(result.source).toBe("static");
    expect(result.models.some((model) => model.isDefault)).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });
});
