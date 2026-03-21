import { describe, expect, mock, test } from "bun:test";

import { discoverAwsBedrockProxyModelsDetailed } from "../../src/providers/awsBedrockProxyShared";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("aws-bedrock-proxy discovery", () => {
  test("preserves usable model ids from an OpenAI-style /models payload and ignores wildcard placeholders", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      object: "list",
      data: [
        { id: "*", object: "model" },
        { id: "openai.gpt-oss-120b-1:0", object: "model" },
        { id: "router", object: "model" },
        { id: "router1", object: "model" },
        { id: "us.anthropic.claude-sonnet-4-6", object: "model", modalities: ["text", "image"] },
        { id: "openai.gpt-oss-120b-1:0", object: "model", input_modalities: ["text", "image"] },
      ],
    }));

    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.example.com",
      apiKey: "test-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.models.map((model) => model.id)).toEqual([
      "openai.gpt-oss-120b-1:0",
      "router",
      "router1",
      "us.anthropic.claude-sonnet-4-6",
    ]);
    expect(result.models.find((model) => model.id === "openai.gpt-oss-120b-1:0")?.supportsImageInput).toBe(true);
    expect(result.models.find((model) => model.id === "us.anthropic.claude-sonnet-4-6")?.supportsImageInput).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("returns no_models when the payload only contains wildcard ids", async () => {
    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.example.com",
      fetchImpl: (async () => jsonResponse({
        object: "list",
        data: [{ id: "*", object: "model" }],
      })) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      code: "no_models",
      message: "The /models response included no usable model ids.",
    });
  });

  test("returns unauthorized when /models rejects the token", async () => {
    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.example.com",
      apiKey: "bad-token",
      fetchImpl: (async () => new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      code: "unauthorized",
      status: 403,
      message: "forbidden",
    });
  });

  test("returns invalid_payload when /models is not OpenAI-style JSON", async () => {
    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.example.com",
      fetchImpl: (async () => jsonResponse({ models: [{ id: "router" }] })) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_payload",
      message: "The /models response did not match the expected schema.",
    });
  });

  test("returns timeout when the request aborts", async () => {
    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.example.com",
      timeoutMs: 1,
      fetchImpl: (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      code: "timeout",
      message: "The /models request timed out.",
    });
  });
});
