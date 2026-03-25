import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __clearAwsBedrockProxyDiscoveryCacheForTests,
  discoverAwsBedrockProxyModels,
  discoverAwsBedrockProxyModelsDetailed,
  resolveAwsBedrockProxyApiKey,
  resolveAwsBedrockProxyBaseUrl,
} from "../../src/providers/awsBedrockProxyShared";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("aws-bedrock-proxy discovery", () => {
  beforeEach(() => {
    __clearAwsBedrockProxyDiscoveryCacheForTests();
  });

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

  test("caches successful /models responses so identical discovery reuses one network call", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      object: "list",
      data: [{ id: "router", object: "model" }],
    }));

    const opts = {
      baseUrl: "https://proxy.example.com",
      apiKey: "same-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const first = await discoverAwsBedrockProxyModelsDetailed(opts);
    const second = await discoverAwsBedrockProxyModelsDetailed(opts);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
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

  test("discoverAwsBedrockProxyModels warns before flattening detailed failures", async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const result = await discoverAwsBedrockProxyModels({
        baseUrl: "https://proxy.example.com",
        fetchImpl: (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
      });

      expect(result).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("discoverAwsBedrockProxyModels returning [] after unauthorized");
      expect(warnings[0]).toContain("forbidden");
    } finally {
      console.warn = realWarn;
    }
  });
});

describe("aws-bedrock-proxy shared option resolution", () => {
  test("resolveAwsBedrockProxyApiKey prefers saved key, then AWS env, then legacy env", () => {
    expect(resolveAwsBedrockProxyApiKey({
      savedKey: " saved-token ",
      env: {
        AWS_BEDROCK_PROXY_API_KEY: "aws-env-token",
        OPENAI_PROXY_API_KEY: "legacy-env-token",
      } as NodeJS.ProcessEnv,
    })).toBe("saved-token");

    expect(resolveAwsBedrockProxyApiKey({
      env: {
        AWS_BEDROCK_PROXY_API_KEY: "aws-env-token",
        OPENAI_PROXY_API_KEY: "legacy-env-token",
      } as NodeJS.ProcessEnv,
    })).toBe("aws-env-token");

    expect(resolveAwsBedrockProxyApiKey({
      env: {
        OPENAI_PROXY_API_KEY: "legacy-env-token",
      } as NodeJS.ProcessEnv,
    })).toBe("legacy-env-token");
  });

  test("resolveAwsBedrockProxyBaseUrl enforces precedence and rejects invalid URLs", () => {
    expect(resolveAwsBedrockProxyBaseUrl({
      baseUrl: "https://proxy.explicit.example.com/v1/",
      providerOptions: {
        "aws-bedrock-proxy": { baseUrl: "https://proxy.provider-options.example.com/v1" },
      },
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1",
      } as NodeJS.ProcessEnv,
    })).toBe("https://proxy.explicit.example.com/v1");

    expect(resolveAwsBedrockProxyBaseUrl({
      providerOptions: {
        "aws-bedrock-proxy": { baseUrl: "https://proxy.provider-options.example.com/v1/" },
      },
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1",
      } as NodeJS.ProcessEnv,
    })).toBe("https://proxy.provider-options.example.com/v1");

    expect(resolveAwsBedrockProxyBaseUrl({
      providerOptions: {
        "aws-bedrock-proxy": { baseUrl: "htps://bad-url" },
      },
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1/",
      } as NodeJS.ProcessEnv,
    })).toBe("https://proxy.env.example.com/v1");

    expect(resolveAwsBedrockProxyBaseUrl({
      baseUrl: "javascript:alert(1)",
      env: {} as NodeJS.ProcessEnv,
    })).toBeUndefined();

    expect(resolveAwsBedrockProxyBaseUrl({
      baseUrl: "https://proxy.explicit.example.com/v1?tenant=a",
      providerOptions: {
        "aws-bedrock-proxy": { baseUrl: "https://proxy.provider-options.example.com/v1" },
      },
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1",
      } as NodeJS.ProcessEnv,
    })).toBe("https://proxy.provider-options.example.com/v1");

    expect(resolveAwsBedrockProxyBaseUrl({
      providerOptions: {
        "aws-bedrock-proxy": { baseUrl: "https://proxy.provider-options.example.com/v1#frag" },
      },
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1/",
      } as NodeJS.ProcessEnv,
    })).toBe("https://proxy.env.example.com/v1");

    expect(resolveAwsBedrockProxyBaseUrl({
      config: {
        provider: "aws-bedrock-proxy",
        model: "router",
        providerOptions: {
          "aws-bedrock-proxy": { baseUrl: "https://proxy.provider-options.example.com/v1" },
        },
        awsBedrockProxyBaseUrl: "https://proxy.config.example.com/v1?tenant=a",
      } as any,
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1/",
      } as NodeJS.ProcessEnv,
    })).toBe("https://proxy.provider-options.example.com/v1");

    expect(resolveAwsBedrockProxyBaseUrl({
      env: {
        AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env.example.com/v1#frag",
      } as NodeJS.ProcessEnv,
    })).toBeUndefined();
  });
});
