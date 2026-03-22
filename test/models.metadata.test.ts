import { beforeEach, describe, expect, mock, test } from "bun:test";

import { __clearAwsBedrockProxyDiscoveryCacheForTests } from "../src/providers/awsBedrockProxyShared";
import { getResolvedModelMetadataSync, resolveModelMetadata } from "../src/models/metadata";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("models/metadata", () => {
  beforeEach(() => {
    __clearAwsBedrockProxyDiscoveryCacheForTests();
  });

  test("resolveModelMetadata preserves discovered AWS Bedrock Proxy image capability and fallback defaults", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      object: "list",
      data: [
        { id: "vision-router", object: "model", modalities: ["text", "image"] },
      ],
    }));

    const metadata = await resolveModelMetadata("aws-bedrock-proxy", "vision-router", {
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com/v1",
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(metadata).toMatchObject({
      id: "vision-router",
      provider: "aws-bedrock-proxy",
      displayName: "Vision Router",
      knowledgeCutoff: "Unknown",
      supportsImageInput: true,
      promptTemplate: "system-models/claude-sonnet-4-6.md",
      source: "dynamic",
    });
    expect(metadata.providerOptionsDefaults).toEqual({
      promptCaching: {
        enabled: true,
        ttl: "5m",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("resolveModelMetadata discovers AWS Bedrock Proxy using global config baseUrl when providerOptions omit baseUrl", async () => {
    const fetchImpl = mock(async () => jsonResponse({
      object: "list",
      data: [
        { id: "vision-router", object: "model", modalities: ["text", "image"] },
      ],
    }));

    const metadata = await resolveModelMetadata("aws-bedrock-proxy", "vision-router", {
      config: {
        awsBedrockProxyBaseUrl: "https://proxy.global.example.com/v1/",
        openaiProxyBaseUrl: "https://proxy.global.example.com/v1/",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(metadata).toMatchObject({
      id: "vision-router",
      provider: "aws-bedrock-proxy",
      displayName: "Vision Router",
      supportsImageInput: true,
      source: "dynamic",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://proxy.global.example.com/v1/models");
  });

  test("resolveModelMetadata uses saved AWS proxy API key for authenticated /models when env has no token", async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const auth = headers.get("authorization") ?? "";
      if (!auth.includes("Bearer saved-store-token")) {
        return new Response("unauthorized", { status: 401 });
      }
      return jsonResponse({
        object: "list",
        data: [{ id: "vision-router", object: "model", modalities: ["text", "image"] }],
      });
    });

    const baseOpts = {
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com/v1",
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {} as NodeJS.ProcessEnv,
    };

    const withoutSavedKey = await resolveModelMetadata("aws-bedrock-proxy", "vision-router", baseOpts);
    expect(withoutSavedKey.supportsImageInput).toBe(false);
    expect(withoutSavedKey.displayName).toBe("vision-router");

    const withSavedKey = await resolveModelMetadata("aws-bedrock-proxy", "vision-router", {
      ...baseOpts,
      awsBedrockProxySavedApiKey: "saved-store-token",
    });

    expect(withSavedKey.supportsImageInput).toBe(true);
    expect(withSavedKey.displayName).toBe("Vision Router");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("resolveModelMetadata falls back conservatively when AWS Bedrock Proxy discovery fails", async () => {
    const metadata = await resolveModelMetadata("aws-bedrock-proxy", "vision-router", {
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com/v1",
        },
      },
      fetchImpl: (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
    });

    expect(metadata).toMatchObject({
      id: "vision-router",
      provider: "aws-bedrock-proxy",
      displayName: "vision-router",
      knowledgeCutoff: "Unknown",
      supportsImageInput: false,
      promptTemplate: "system-models/claude-sonnet-4-6.md",
      source: "dynamic",
    });
  });

  test("getResolvedModelMetadataSync keeps AWS Bedrock Proxy capability resolution conservative", () => {
    const metadata = getResolvedModelMetadataSync("aws-bedrock-proxy", "vision-router");
    expect(metadata).toMatchObject({
      id: "vision-router",
      provider: "aws-bedrock-proxy",
      displayName: "vision-router",
      supportsImageInput: false,
      source: "dynamic",
    });
  });
});
