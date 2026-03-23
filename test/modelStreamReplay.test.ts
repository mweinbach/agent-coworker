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

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([]);

    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
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
    })).toBe(false);
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
    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
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
    })).toBe(true);
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
    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
      type: "model_stream_chunk",
      sessionId: "session-1",
      turnId,
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: { id: "reasoning-3", mode: "summary", text: "post-clear chunk" },
    })).toBe(false);
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

    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
      type: "model_stream_chunk",
      sessionId: "session-2",
      turnId,
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "finish",
      part: { id: "finish-1" },
    })).toBe(false);
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

    expect(updates).toEqual([{
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
    }]);
    expect(runtime.rawBackedTurns.has(turnId)).toBe(false);
    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
      type: "model_stream_chunk",
      sessionId: "session-3",
      turnId,
      index: 1,
      provider: "codex-cli",
      model: "gpt-5.4",
      partType: "tool_result",
      part: { toolCallId: "tool-1", toolName: "read", output: { ok: true } },
    })).toBe(false);
  });

  test("replays google interactions raw reasoning and tool activity from persisted chunks", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-google-raw";

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "reasoning_start",
      turnId,
      streamId: "s0",
      mode: "reasoning",
    }]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "reasoning_delta",
      turnId,
      streamId: "s0",
      mode: "reasoning",
      text: "Inspecting the trailer.",
    }]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "reasoning_end",
      turnId,
      streamId: "s0",
      mode: "reasoning",
    }]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "tool_input_delta",
      turnId,
      key: "call_1",
      delta: "{\"url\":\"https://example.com/trailer\"}",
    }]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([
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

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "tool_input_delta",
      turnId,
      key: "native_1",
      delta: "{\"queries\":[\"Spider-Man trailer screenshots\"]}",
    }]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
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
    }]);

    expect(runtime.rawBackedTurns.has(turnId)).toBe(true);
    expect(shouldIgnoreNormalizedChunkForRawBackedTurn(runtime, {
      type: "model_stream_chunk",
      sessionId: "session-4",
      turnId,
      index: 8,
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      partType: "tool_call",
      part: { toolCallId: "call_1", toolName: "webFetch", input: { url: "stale" } },
    })).toBe(true);
  });

  test("treats repeated google interaction.start events as step boundaries within the same turn", () => {
    const runtime = createModelStreamReplayRuntime();
    const turnId = "turn-google-loop";

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "turn_start",
      turnId,
    }]);

    expect(replayModelStreamRawEvent(runtime, {
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
    })).toEqual([{
      kind: "turn_start",
      turnId,
    }]);
  });
});
