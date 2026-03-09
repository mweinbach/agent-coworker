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
      sessionKind: "subagent",
      parentSessionId: "root-1",
      agentType: "general",
    });

    const parsed = safeParseServerEvent(raw);
    expect(parsed?.type).toBe("server_hello");
    expect(parsed?.sessionId).toBe("s-1");
    if (parsed?.type !== "server_hello") return;
    expect(parsed.sessionKind).toBe("subagent");
    expect(parsed.parentSessionId).toBe("root-1");
    expect(parsed.agentType).toBe("general");
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
        type: "model_stream_raw",
        sessionId: "s-1",
        turnId: "turn-1",
        index: 1,
        provider: "openai",
        model: "gpt-5.2",
        format: "openai-responses-v1",
        normalizerVersion: 1,
        event: { type: "response.output_item.added", item: { type: "reasoning" } },
      },
      {
        type: "session_config",
        sessionId: "s-1",
        config: {
          yolo: false,
          observabilityEnabled: true,
          subAgentModel: "gpt-5.4",
          maxSteps: 100,
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
              textVerbosity: "medium",
            },
            "codex-cli": {
              reasoningEffort: "xhigh",
              reasoningSummary: "concise",
              textVerbosity: "low",
            },
          },
        },
      },
      {
        type: "error",
        sessionId: "s-1",
        message: "boom",
        code: "internal_error",
        source: "session",
      },
      {
        type: "subagent_created",
        sessionId: "s-1",
        subagent: {
          sessionId: "child-1",
          parentSessionId: "s-1",
          agentType: "general",
          title: "Child Session",
          provider: "openai",
          model: "gpt-5.2",
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:01.000Z",
          status: "active",
          busy: true,
        },
      },
      {
        type: "session_usage",
        sessionId: "s-1",
        usage: null,
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

  test("safeParseServerEvent accepts nullable session_usage payloads", () => {
    const raw = JSON.stringify({
      type: "session_usage",
      sessionId: "s-1",
      usage: null,
    });

    const parsed = safeParseServerEvent(raw);
    expect(parsed?.type).toBe("session_usage");
    if (parsed?.type !== "session_usage") return;
    expect(parsed.usage).toBeNull();
  });
});
