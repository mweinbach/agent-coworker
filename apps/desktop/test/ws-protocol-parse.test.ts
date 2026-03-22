import { describe, expect, test } from "bun:test";

import { safeJsonParse, safeParseServerEvent } from "../src/lib/wsProtocol";

describe("desktop ws protocol parser", () => {
  test("safeJsonParse returns null for invalid JSON", () => {
    expect(safeJsonParse("{invalid")).toBeNull();
  });

  test("safeParseServerEvent rejects malformed envelopes", () => {
    expect(
      safeParseServerEvent(JSON.stringify({ type: "server_hello" })),
    ).toBeNull();
    expect(
      safeParseServerEvent(JSON.stringify({ type: "totally_unknown", sessionId: "s-1" })),
    ).toBeNull();
  });

  test("safeParseServerEvent accepts known server event envelope", () => {
    const parsed = safeParseServerEvent(
      JSON.stringify({
        type: "server_hello",
        sessionId: "desktop-s1",
        config: {
          provider: "google",
          model: "gemini",
          workingDirectory: "/workspace",
        },
      }),
    );

    expect(parsed?.type).toBe("server_hello");
    expect(parsed?.sessionId).toBe("desktop-s1");
  });

  test("safeParseServerEvent accepts representative protocol events", () => {
    const fixtures = [
      {
        type: "provider_auth_result",
        sessionId: "desktop-s1",
        provider: "openai",
        methodId: "api_key",
        ok: true,
        message: "ok",
      },
      {
        type: "mcp_servers",
        sessionId: "desktop-s1",
        servers: [],
        legacy: {
          workspace: { path: "/workspace/.agent/mcp-servers.json", exists: true },
          user: { path: "/Users/me/.agent/mcp-servers.json", exists: false },
        },
        files: [],
      },
      {
        type: "model_stream_chunk",
        sessionId: "desktop-s1",
        turnId: "turn-1",
        index: 0,
        provider: "openai",
        model: "gpt-5.2",
        partType: "text_delta",
        part: { text: "hello" },
      },
      {
        type: "model_stream_raw",
        sessionId: "desktop-s1",
        turnId: "turn-1",
        index: 1,
        provider: "openai",
        model: "gpt-5.2",
        format: "openai-responses-v1",
        normalizerVersion: 1,
        event: { type: "response.output_item.added", item: { type: "reasoning" } },
      },
      {
        type: "steer_accepted",
        sessionId: "desktop-s1",
        turnId: "turn-1",
        text: "tighten the answer",
        clientMessageId: "steer-1",
      },
      {
        type: "error",
        sessionId: "desktop-s1",
        message: "boom",
        code: "internal_error",
        source: "session",
      },
      {
        type: "user_config",
        sessionId: "desktop-s1",
        config: {
          awsBedrockProxyBaseUrl: "https://proxy.example.com/v1",
        },
      },
      {
        type: "user_config_result",
        sessionId: "desktop-s1",
        ok: true,
        message: "Saved globally",
        config: {
          awsBedrockProxyBaseUrl: "https://proxy.example.com/v1",
        },
      },
    ];

    for (const fixture of fixtures) {
      const parsed = safeParseServerEvent(JSON.stringify(fixture));
      expect(parsed?.type).toBe(fixture.type);
      expect(parsed?.sessionId).toBe("desktop-s1");
    }
  });

  test("safeParseServerEvent normalizes legacy openaiProxyBaseUrl payloads", () => {
    const parsed = safeParseServerEvent(
      JSON.stringify({
        type: "user_config",
        sessionId: "desktop-s1",
        config: {
          openaiProxyBaseUrl: "https://legacy.proxy.example.com/v1/",
        },
      }),
    );

    expect(parsed?.type).toBe("user_config");
    if (parsed?.type === "user_config") {
      expect(parsed.config.awsBedrockProxyBaseUrl).toBe("https://legacy.proxy.example.com/v1/");
      expect((parsed.config as any).openaiProxyBaseUrl).toBeUndefined();
    }
  });

  test("safeParseServerEvent rejects known event types with missing required fields", () => {
    const parsed = safeParseServerEvent(
      JSON.stringify({
        type: "mcp_servers",
        sessionId: "desktop-s1",
        servers: [],
        legacy: {
          workspace: { path: "/workspace/.agent/mcp-servers.json", exists: true },
          user: { path: "/Users/me/.agent/mcp-servers.json", exists: false },
        },
      }),
    );

    expect(parsed).toBeNull();
  });
});
