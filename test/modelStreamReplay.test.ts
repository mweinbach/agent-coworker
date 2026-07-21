import { describe, expect, test } from "bun:test";

import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
} from "../src/client/modelStreamReplay";

describe("modelStreamReplay", () => {
  test("keeps normalized chunks when a raw event produces no replay updates", () => {
    const runtime = createModelStreamReplayRuntime();

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-1",
        turnId: "turn-1",
        index: 0,
        provider: "openai",
        model: "gpt-5.2",
        format: "openai-responses-v1",
        normalizerVersion: 1,
        event: {
          type: "response.unknown_future_event",
        },
      }),
    ).toEqual([]);

    expect(
      shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
        type: "model_stream_chunk",
        sessionId: "session-1",
        turnId: "turn-1",
        index: 1,
        provider: "openai",
        model: "gpt-5.2",
        partType: "reasoning_delta",
        part: {
          id: "reasoning-1",
          mode: "summary",
          text: "normalized reasoning still needed",
        },
      }),
    ).toBe(false);
  });

  test("marks turns raw-backed after replayable raw output is produced", () => {
    const runtime = createModelStreamReplayRuntime();

    const updates = replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-1",
      turnId: "turn-raw",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "reasoning", id: "rs_live", summary: [] },
      },
    });

    expect(updates).not.toHaveLength(0);
    expect(
      shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
        type: "model_stream_chunk",
        sessionId: "session-1",
        turnId: "turn-raw",
        index: 1,
        provider: "openai",
        model: "gpt-5.2",
        partType: "reasoning_delta",
        part: {
          id: "reasoning-2",
          mode: "summary",
          text: "stale normalized reasoning",
        },
      }),
    ).toBe(true);
  });

  test("clearing runtime resets raw-backed tracking", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-clear";
    replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-1",
      turnId,
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "reasoning", id: "rs_clear", summary: [] },
      },
    });

    expect(runtime.rawBackedTurns.has(turnId)).toBe(true);
    expect(runtime.projectorByTurn.has(turnId)).toBe(true);

    clearModelStreamReplayRuntime(runtime);

    expect(runtime.rawBackedTurns.size).toBe(0);
    expect(runtime.projectorByTurn.size).toBe(0);
    expect(
      shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
        type: "model_stream_chunk",
        sessionId: "session-1",
        turnId,
        index: 1,
        provider: "openai",
        model: "gpt-5.2",
        partType: "reasoning_delta",
        part: { id: "reasoning-3", mode: "summary", text: "post-clear chunk" },
      }),
    ).toBe(false);
  });

  test("reuses projector instances across multiple raw events for the same turn", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-reuse";
    const event = {
      type: "model_stream_raw" as const,
      sessionId: "session-1",
      turnId,
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "reasoning", id: "rs_reuse", summary: [] },
      },
    };

    replayModelStreamRawEvent(runtime, event);
    const firstProjector = runtime.projectorByTurn.get(turnId);
    expect(firstProjector).toBeDefined();
    replayModelStreamRawEvent(runtime, {
      ...event,
      event: {
        type: "response.output_item.added",
        item: { type: "finish", id: "finish-1", text: "done" },
      },
    });
    const secondProjector = runtime.projectorByTurn.get(turnId);
    expect(secondProjector).toBe(firstProjector);
    expect(runtime.projectorByTurn.size).toBe(1);
  });

  test("only ignores normalized chunks for the configured part types", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-selective";
    replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-2",
      turnId,
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "reasoning", id: "rs_selective", summary: [] },
      },
    });

    expect(
      shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
        type: "model_stream_chunk",
        sessionId: "session-2",
        turnId,
        index: 1,
        provider: "openai",
        model: "gpt-5.2",
        partType: "finish",
        part: { id: "finish-1" },
      }),
    ).toBe(false);
  });

  test("replays native web search raw events without marking the turn as raw-backed", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-native-web";

    const updates = replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-3",
      turnId,
      index: 0,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: {
          id: "ws_1",
          type: "web_search_call",
          action: {
            type: "search",
            query: "native web search",
          },
        },
      },
    });

    expect(updates).toEqual([
      {
        kind: "tool_input_start",
        turnId,
        key: "ws_1",
        name: "nativeWebSearch",
        args: {
          action: {
            type: "search",
            query: "native web search",
          },
        },
      },
    ]);
    expect(runtime.rawBackedTurns.has(turnId)).toBe(false);
    expect(
      shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
        type: "model_stream_chunk",
        sessionId: "session-3",
        turnId,
        index: 1,
        provider: "codex-cli",
        model: "gpt-5.4",
        partType: "tool_result",
        part: { toolCallId: "tool-1", toolName: "read", output: { ok: true } },
      }),
    ).toBe(false);
  });

  test("replays Codex app-server native web search raw response items", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-codex-app-server-native-web";

    const updates = replayModelStreamRawEvent(runtime, {
      type: "model_stream_raw",
      sessionId: "session-codex",
      turnId,
      index: 105,
      provider: "codex-cli",
      model: "gpt-5.5",
      format: "codex-app-server-v2",
      normalizerVersion: 1,
      event: {
        direction: "server_notification",
        message: {
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-codex",
            turnId: "turn-codex-runtime",
            item: {
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "Apple WWDC 2026 dates announcement June 2026 official Apple Newsroom",
                queries: [
                  "Apple WWDC 2026 dates announcement June 2026 official Apple Newsroom",
                  "site:developer.apple.com wwdc26 Apple WWDC 2026",
                ],
              },
            },
          },
        },
      },
    });

    expect(updates).toEqual([
      {
        kind: "tool_result",
        turnId,
        key: `native-web-search:${turnId}:105`,
        name: "nativeWebSearch",
        result: {
          status: "completed",
          action: {
            type: "search",
            query: "Apple WWDC 2026 dates announcement June 2026 official Apple Newsroom",
            queries: [
              "Apple WWDC 2026 dates announcement June 2026 official Apple Newsroom",
              "site:developer.apple.com wwdc26 Apple WWDC 2026",
            ],
          },
          sources: undefined,
          raw: {
            type: "web_search_call",
            status: "completed",
            action: {
              type: "search",
              query: "Apple WWDC 2026 dates announcement June 2026 official Apple Newsroom",
              queries: [
                "Apple WWDC 2026 dates announcement June 2026 official Apple Newsroom",
                "site:developer.apple.com wwdc26 Apple WWDC 2026",
              ],
            },
          },
        },
      },
    ]);
    expect(runtime.rawBackedTurns.has(turnId)).toBe(false);
  });

  test("replays google interactions raw reasoning and tool activity from persisted chunks", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-google-raw";

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 0,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.start",
          index: 0,
          content: { type: "thought" },
        },
      }),
    ).toEqual([
      {
        kind: "reasoning_start",
        turnId,
        streamId: "s0",
        mode: "reasoning",
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 1,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.delta",
          index: 0,
          delta: {
            type: "thought_summary",
            content: { type: "text", text: "Inspecting the trailer." },
          },
        },
      }),
    ).toEqual([
      {
        kind: "reasoning_delta",
        turnId,
        streamId: "s0",
        mode: "reasoning",
        text: "Inspecting the trailer.",
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 2,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.stop",
          index: 0,
        },
      }),
    ).toEqual([
      {
        kind: "reasoning_end",
        turnId,
        streamId: "s0",
        mode: "reasoning",
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 3,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.delta",
          index: 1,
          delta: {
            type: "function_call",
            id: "call_1",
            name: "webFetch",
            arguments: { url: "https://example.com/trailer" },
          },
        },
      }),
    ).toEqual([
      {
        kind: "tool_input_delta",
        turnId,
        key: "call_1",
        delta: '{"url":"https://example.com/trailer"}',
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 4,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.stop",
          index: 1,
        },
      }),
    ).toEqual([
      {
        kind: "tool_input_end",
        turnId,
        key: "call_1",
        name: "tool",
      },
      {
        kind: "tool_call",
        turnId,
        key: "call_1",
        name: "webFetch",
        args: { url: "https://example.com/trailer" },
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 5,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.delta",
          index: 2,
          delta: {
            type: "google_search_call",
            id: "native_1",
            arguments: { queries: ["Spider-Man trailer screenshots"] },
          },
        },
      }),
    ).toEqual([
      {
        kind: "tool_input_delta",
        turnId,
        key: "native_1",
        delta: '{"queries":["Spider-Man trailer screenshots"]}',
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 6,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.delta",
          index: 3,
          delta: {
            type: "google_search_result",
            call_id: "native_1",
            result: {
              sources: [{ url: "https://example.com/source" }],
              results: [{ title: "Spider-Man" }],
            },
          },
        },
      }),
    ).toEqual([]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-4",
        turnId,
        index: 7,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "content.stop",
          index: 3,
        },
      }),
    ).toEqual([
      {
        kind: "tool_result",
        turnId,
        key: "native_1",
        name: "nativeWebSearch",
        result: {
          provider: "google",
          status: "completed",
          callId: "native_1",
          queries: ["Spider-Man trailer screenshots"],
          results: [{ title: "Spider-Man" }],
          sources: [{ url: "https://example.com/source" }],
          raw: {
            sources: [{ url: "https://example.com/source" }],
            results: [{ title: "Spider-Man" }],
          },
        },
      },
    ]);

    expect(runtime.rawBackedTurns.has(turnId)).toBe(true);
    expect(
      shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
        type: "model_stream_chunk",
        sessionId: "session-4",
        turnId,
        index: 8,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        partType: "tool_call",
        part: { toolCallId: "call_1", toolName: "webFetch", input: { url: "stale" } },
      }),
    ).toBe(true);
  });

  test("does not replay a completed Google tool when the next interaction reuses a step index", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-google-index-reuse";
    const base = {
      type: "model_stream_raw" as const,
      sessionId: "session-6",
      turnId,
      provider: "google" as const,
      model: "gemini-3.5-flash",
      format: "google-interactions-v1" as const,
      normalizerVersion: 1,
    };

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 0,
        event: {
          event_type: "interaction.status_update",
          interaction_id: "interaction-tools",
          status: "in_progress",
        },
      }),
    ).toEqual([]);

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 1,
        event: {
          event_type: "step.start",
          index: 1,
          step: {
            type: "function_call",
            id: "todo-final",
            name: "todoWrite",
            arguments: { todos: [{ content: "Verify", status: "completed" }] },
          },
        },
      }),
    ).toEqual([
      {
        kind: "tool_input_start",
        turnId,
        key: "todo-final",
        name: "todoWrite",
      },
      {
        kind: "tool_input_delta",
        turnId,
        key: "todo-final",
        delta: '{"todos":[{"content":"Verify","status":"completed"}]}',
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 2,
        event: { event_type: "step.stop", index: 1 },
      }),
    ).toEqual([
      { kind: "tool_input_end", turnId, key: "todo-final", name: "tool" },
      {
        kind: "tool_call",
        turnId,
        key: "todo-final",
        name: "todoWrite",
        args: { todos: [{ content: "Verify", status: "completed" }] },
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 3,
        event: {
          event_type: "interaction.status_update",
          interaction_id: "interaction-final",
          status: "in_progress",
        },
      }),
    ).toEqual([]);

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 4,
        event: {
          event_type: "step.start",
          index: 1,
          step: { type: "model_output" },
        },
      }),
    ).toEqual([{ kind: "assistant_text_start", turnId, streamId: "s1" }]);

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 5,
        event: {
          event_type: "step.delta",
          index: 1,
          delta: { type: "text", text: "Done." },
        },
      }),
    ).toEqual([{ kind: "assistant_delta", turnId, streamId: "s1", text: "Done." }]);

    expect(
      replayModelStreamRawEvent(runtime, {
        ...base,
        index: 6,
        event: { event_type: "step.stop", index: 1 },
      }),
    ).toEqual([{ kind: "assistant_text_end", turnId, streamId: "s1" }]);
  });

  test("treats repeated google interaction.start events as step boundaries within the same turn", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-google-loop";

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-5",
        turnId,
        index: 0,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "interaction.start",
        },
      }),
    ).toEqual([
      {
        kind: "turn_start",
        turnId,
      },
    ]);

    expect(
      replayModelStreamRawEvent(runtime, {
        type: "model_stream_raw",
        sessionId: "session-5",
        turnId,
        index: 1,
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        format: "google-interactions-v1",
        normalizerVersion: 1,
        event: {
          event_type: "interaction.start",
        },
      }),
    ).toEqual([
      {
        kind: "turn_start",
        turnId,
      },
    ]);
  });
});
