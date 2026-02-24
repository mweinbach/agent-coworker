import { describe, expect, test } from "bun:test";

import { safeJsonParse, safeParseServerEvent, safeParseServerEventDetailed } from "../src/client/agentSocket";

describe("agent socket parser", () => {
  test("safeJsonParse returns null for invalid JSON", () => {
    expect(safeJsonParse("{not json")).toBeNull();
  });

  test("safeParseServerEvent rejects events without required envelope fields", () => {
    const missingSession = JSON.stringify({
      type: "server_hello",
      config: { provider: "google", model: "gemini", workingDirectory: "/" },
    });
    expect(safeParseServerEvent(missingSession)).toBeNull();

    const unknownType = JSON.stringify({ type: "unknown_event", sessionId: "s-1" });
    expect(safeParseServerEvent(unknownType)).toBeNull();
  });

  test("safeParseServerEvent accepts known server event envelope", () => {
    const raw = JSON.stringify({
      type: "server_hello",
      sessionId: "s-1",
      config: { provider: "google", model: "gemini", workingDirectory: "/" },
    });

    const parsed = safeParseServerEvent(raw);
    expect(parsed?.type).toBe("server_hello");
    expect(parsed?.sessionId).toBe("s-1");
  });

  test("safeParseServerEvent accepts representative protocol events", () => {
    const fixtures = [
      {
        type: "provider_auth_result",
        sessionId: "s-1",
        provider: "openai",
        methodId: "api_key",
        ok: true,
        message: "ok",
      },
      {
        type: "mcp_servers",
        sessionId: "s-1",
        servers: [],
        legacy: {
          workspace: { path: "/workspace/.agent/mcp-servers.json", exists: true },
          user: { path: "/Users/me/.agent/mcp-servers.json", exists: false },
        },
        files: [],
      },
      {
        type: "model_stream_chunk",
        sessionId: "s-1",
        turnId: "turn-1",
        index: 0,
        provider: "openai",
        model: "gpt-5.2",
        partType: "text_delta",
        part: { text: "hello" },
      },
      {
        type: "error",
        sessionId: "s-1",
        message: "boom",
        code: "internal_error",
        source: "session",
      },
    ];

    for (const fixture of fixtures) {
      const parsed = safeParseServerEvent(JSON.stringify(fixture));
      expect(parsed?.type).toBe(fixture.type);
      expect(parsed?.sessionId).toBe("s-1");
    }
  });

  test("safeParseServerEvent rejects known event types with missing required fields", () => {
    const raw = JSON.stringify({
      type: "mcp_servers",
      sessionId: "s-1",
      servers: [],
      legacy: {
        workspace: { path: "/workspace/.agent/mcp-servers.json", exists: true },
        user: { path: "/Users/me/.agent/mcp-servers.json", exists: false },
      },
    });

    expect(safeParseServerEvent(raw)).toBeNull();
  });

  test("safeParseServerEvent tolerates model_stream_chunk partial metadata and non-object part", () => {
    const raw = JSON.stringify({
      type: "model_stream_chunk",
      sessionId: "s-1",
      partType: "raw",
      part: "payload",
    });

    const parsed = safeParseServerEvent(raw);
    expect(parsed?.type).toBe("model_stream_chunk");
    if (parsed?.type !== "model_stream_chunk") return;
    expect(parsed.turnId).toBe("unknown-turn");
    expect(parsed.index).toBe(-1);
    expect(parsed.provider).toBe("unknown");
    expect(parsed.model).toBe("unknown");
    expect(parsed.part).toEqual({ value: "payload" });
  });

  test("safeParseServerEventDetailed reports unknown event types", () => {
    const raw = JSON.stringify({ type: "future_event", sessionId: "s-1" });
    const parsed = safeParseServerEventDetailed(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("unknown_type");
    expect(parsed.eventType).toBe("future_event");
  });

  test("safeParseServerEventDetailed accepts object input", () => {
    const parsed = safeParseServerEventDetailed({
      type: "pong",
      sessionId: "s-1",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.type).toBe("pong");
  });
});
