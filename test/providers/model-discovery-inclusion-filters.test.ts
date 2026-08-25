import { describe, expect, mock, test } from "bun:test";

import {
  discoverAnthropicModels,
  discoverGoogleModels,
  discoverOpenAiCompatibleModels,
} from "../../src/providers/modelDiscoveryAdapters";

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function fetchReturning(body: unknown, status = 200, statusText = "OK") {
  return mock(async () => jsonResponse(body, status, statusText));
}

describe("discoverOpenAiCompatibleModels inclusion filters", () => {
  test("keeps registry models even when the live type is non-generative", async () => {
    const result = await discoverOpenAiCompatibleModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl: fetchReturning({
        data: [{ id: "gpt-5.4", type: "embedding" }, { id: "text-embedding-3-large" }],
      }) as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });

  test("deny-list drops media, speech, and safety models even when they start with gpt-", async () => {
    const result = await discoverOpenAiCompatibleModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl: fetchReturning({
        data: [
          { id: "gpt-5.5" },
          { id: "gpt-4-whisper" },
          { id: "gpt-image-1" },
          { id: "gpt-4-tts" },
          { id: "omni-moderation-latest" },
        ],
      }) as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
  });

  test("OpenAI keeps gpt-* and o-series ids and rejects other chat-branded names", async () => {
    const result = await discoverOpenAiCompatibleModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl: fetchReturning({
        data: [
          { id: "gpt-4.1" },
          { id: "o1" },
          { id: "o3-mini" },
          { id: "chatgpt-4o" },
          { id: "davinci-002" },
          { id: "o2-preview" },
        ],
      }) as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual([
      "gpt-4.1",
      "o1",
      "o3-mini",
      "o2-preview",
    ]);
    expect(result.models.find((model) => model.id === "o1")?.reasoning).toMatchObject({
      defaultEffort: "high",
      availableEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    });
    expect(result.models.find((model) => model.id === "gpt-4.1")?.reasoning).toBeUndefined();
    expect(result.models.find((model) => model.id === "o2-preview")?.reasoning).toBeUndefined();
  });

  test("rejects live models whose source type is not a generation surface", async () => {
    const result = await discoverOpenAiCompatibleModels({
      provider: "together",
      baseUrl: "https://api.together.xyz/v1",
      fetchImpl: fetchReturning({
        data: [
          { id: "org/llama-instruct", type: "chat" },
          { id: "org/llama-instruct-embed", type: "embedding" },
          { id: "org/qwen-rerank", type: "rerank" },
        ],
      }) as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual(["org/llama-instruct"]);
  });

  test("enforces provider-specific id prefixes and Together-style generation keywords", async () => {
    const fireworks = await discoverOpenAiCompatibleModels({
      provider: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      fetchImpl: fetchReturning({
        data: [
          { id: "accounts/fireworks/models/kimi-k2" },
          { id: "accounts/fireworks/routers/kimi-turbo" },
          { id: "fireworks/glm-5" },
          { id: "other-org/kimi-k2" },
          { id: "accounts/fireworks/models/whisper-v3" },
        ],
      }) as unknown as typeof fetch,
    });
    const nvidia = await discoverOpenAiCompatibleModels({
      provider: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      fetchImpl: fetchReturning({
        data: [{ id: "nvidia/nemotron-3" }, { id: "meta/llama-3" }, { id: "nvidia/embed-qa" }],
      }) as unknown as typeof fetch,
    });
    const minimax = await discoverOpenAiCompatibleModels({
      provider: "minimax",
      baseUrl: "https://api.minimax.io/v1",
      fetchImpl: fetchReturning({
        data: [{ id: "minimax-m2.5" }, { id: "glm-5" }],
      }) as unknown as typeof fetch,
    });
    const together = await discoverOpenAiCompatibleModels({
      provider: "together",
      baseUrl: "https://api.together.xyz/v1",
      fetchImpl: fetchReturning({
        data: [
          { id: "moonshotai/Kimi-K2.5", type: "embedding" },
          { id: "some-org/other-chat-model" },
          { id: "acme/random-weights" },
        ],
      }) as unknown as typeof fetch,
    });
    const opencode = await discoverOpenAiCompatibleModels({
      provider: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      fetchImpl: fetchReturning({
        data: [{ id: "custom-local-model" }, { id: "custom-whisper" }],
      }) as unknown as typeof fetch,
    });

    expect(fireworks.models.map((model) => model.id)).toEqual([
      "accounts/fireworks/models/kimi-k2",
      "accounts/fireworks/routers/kimi-turbo",
      "fireworks/glm-5",
    ]);
    expect(nvidia.models.map((model) => model.id)).toEqual(["nvidia/nemotron-3"]);
    expect(minimax.models.map((model) => model.id)).toEqual(["minimax-m2.5"]);
    expect(together.models.map((model) => model.id)).toEqual([
      "moonshotai/Kimi-K2.5",
      "some-org/other-chat-model",
    ]);
    expect(opencode.models.map((model) => model.id)).toEqual(["custom-local-model"]);
  });

  test("reads id aliases, payload wrappers, and runtime-option field names", async () => {
    const result = await discoverOpenAiCompatibleModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/",
      fetchImpl: fetchReturning([
        { model: "gpt-4.1", ownedBy: "openai", contextLength: 128000 },
        { name: "  " },
        "skip-me",
        {
          id: "gpt-4.1-omni",
          display_name: "GPT 4.1 Omni",
          type: "chat",
          owned_by: "system",
          context_length: 32000,
        },
        { id: "gpt-4.1-vision-preview", type: "vision" },
      ]) as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual(["gpt-4.1", "gpt-4.1-omni"]);
    expect(result.models[0]).toMatchObject({
      displayName: "GPT 4.1",
      runtimeOptions: { ownedBy: "openai", contextLength: 128000 },
    });
    expect(result.models[1]).toMatchObject({
      displayName: "GPT 4.1 Omni",
      supportsImageInput: true,
      runtimeOptions: { ownedBy: "system", contextLength: 32000, sourceType: "chat" },
    });
    expect(result.models.some((model) => model.id === "gpt-4.1-vision-preview")).toBe(false);
  });

  test("fails closed on HTTP errors and honors an already-aborted signal", async () => {
    await expect(
      discoverOpenAiCompatibleModels({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        fetchImpl: fetchReturning(
          { error: { message: "nope" } },
          401,
          "Unauthorized",
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow('openai model list failed: 401 Unauthorized - {"error":{"message":"nope"}}');

    await expect(
      discoverOpenAiCompatibleModels({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        signal: AbortSignal.abort(),
        fetchImpl: fetchReturning({ data: [{ id: "gpt-5.4" }] }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});

describe("discoverGoogleModels inclusion filters", () => {
  test("requires Gemini generateContent methods and still applies the deny-list", async () => {
    const result = await discoverGoogleModels({
      apiKey: "gemini-secret",
      fetchImpl: fetchReturning({
        models: [
          {
            name: "models/gemini-2.0-flash",
            displayName: "Gemini 2.0 Flash",
            supportedGenerationMethods: ["streamGenerateContent"],
          },
          {
            name: "models/gemini-2.0-flash",
            baseModelId: "gemini-2.0-pro",
            supportedGenerationMethods: ["countTokens"],
          },
          {
            name: "models/gemini-embedding-001",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/llama-3",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            baseModelId: "gemini-2.0-lite",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }) as unknown as typeof fetch,
    });

    expect(result.models.map((model) => model.id)).toEqual(["gemini-2.0-flash", "gemini-2.0-lite"]);
  });

  test("stops paginating after the page cap when nextPageToken never ends", async () => {
    let pages = 0;
    const fetchImpl = mock(async () => {
      pages += 1;
      return jsonResponse({
        models: [
          {
            name: `models/gemini-page-${pages}`,
            supportedGenerationMethods: ["generateContent"],
          },
        ],
        nextPageToken: `page-${pages + 1}`,
      });
    });

    const result = await discoverGoogleModels({
      apiKey: "gemini-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(pages).toBe(20);
    expect(result.models).toHaveLength(20);
    expect(result.models[0]?.id).toBe("gemini-page-1");
    expect(result.models[19]?.id).toBe("gemini-page-20");
  });
});

describe("discoverAnthropicModels pagination bounds", () => {
  test("stops when has_more is true but last_id is missing", async () => {
    let pages = 0;
    const fetchImpl = mock(async () => {
      pages += 1;
      return jsonResponse({
        data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }],
        has_more: true,
      });
    });

    const result = await discoverAnthropicModels({
      apiKey: "anthropic-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(pages).toBe(1);
    expect(result.models.map((model) => model.id)).toEqual(["claude-opus-4-8"]);
  });
});
