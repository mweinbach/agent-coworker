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
        type: "search",
        query: "native web search",
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
});
