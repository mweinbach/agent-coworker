import { describe, expect, mock, test } from "bun:test";

import { getResolvedModelMetadataSync, resolveModelMetadata } from "../src/models/metadata";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("models/metadata", () => {
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
