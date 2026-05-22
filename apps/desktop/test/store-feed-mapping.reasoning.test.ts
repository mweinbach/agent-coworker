import { describe, expect, test } from "bun:test";
import {
  createThreadModelStreamRuntime,
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  mapTranscriptToFeed,
  reasoningInsertBeforeAssistantAfterStreamReplay,
} from "../src/app/store.feedMapping";
import type { TranscriptEvent } from "../src/app/types";

describe("desktop transcript feed mapping", () => {

  test("anchors late final reasoning before streamed assistant output", () => {
    const runtime = createThreadModelStreamRuntime();
    runtime.lastAssistantTurnId = "turn-live";
    runtime.lastAssistantStreamKeyByTurn.set("turn-live", "assistant:turn-live");
    runtime.assistantItemIdByStream.set("assistant:turn-live", "assistant-item-1");

    expect(reasoningInsertBeforeAssistantAfterStreamReplay(runtime)).toBe("assistant-item-1");
  });

  test("inserts late-arriving streamed reasoning before the active assistant message in the same turn", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "summarize the result" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 0,
          provider: "google",
          model: "gemini-3.5-flash",
          partType: "text_delta",
          part: { id: "s0", text: "Here is the answer." },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 1,
          provider: "google",
          model: "gemini-3.5-flash",
          partType: "reasoning_delta",
          part: { id: "r0", mode: "reasoning", text: "I weighed the options first." },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);

    const reasoning = feed.find((item) => item.kind === "reasoning");
    expect(reasoning?.kind).toBe("reasoning");
    if (reasoning?.kind === "reasoning") {
      expect(reasoning.text).toBe("I weighed the options first.");
    }
  });

  test("dedupes streamed reasoning against legacy reasoning finals while preserving trace order", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-1",
          index: 0,
          provider: "openai",
          model: "gpt-5.2",
          partType: "reasoning_delta",
          part: { id: "r1", mode: "summary", text: "thinking" },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-1",
          index: 1,
          provider: "openai",
          model: "gpt-5.2",
          partType: "tool_call",
          part: { toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-1",
          index: 2,
          provider: "openai",
          model: "gpt-5.2",
          partType: "tool_result",
          part: { toolCallId: "tool-1", toolName: "read", output: { chars: 42 } },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning_summary", text: "thinking" },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Done." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "tool", "message"]);

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("thinking");

    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("read");
    expect(tool.state).toBe("output-available");
  });

  test("dedupes final reasoning against streamed reasoning from the latest step in the same turn", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "tell me about gtc this year" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "Searching for the latest GTC details." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_call",
          part: {
            toolCallId: "tool-1",
            toolName: "webSearch",
            input: { query: "NVIDIA GTC 2026" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 3,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_result",
          part: { toolCallId: "tool-1", toolName: "webSearch", output: "result" },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 4,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:05.500Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 5,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s1", mode: "reasoning", text: "Verifying the final conference details." },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 6,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_call",
          part: {
            toolCallId: "tool-2",
            toolName: "webSearch",
            input: { query: "NVIDIA GTC 2027" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 7,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_result",
          part: { toolCallId: "tool-2", toolName: "webSearch", output: "result-2" },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "reasoning",
          kind: "reasoning",
          text: "Searching for the latest GTC details.",
        },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the summary." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");
    const tools = feed.filter((item) => item.kind === "tool");

    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((item) => item.text)).toEqual([
      "Searching for the latest GTC details.",
      "Verifying the final conference details.",
    ]);
    if (tools[0]?.kind !== "tool" || tools[1]?.kind !== "tool")
      throw new Error("Expected tool feed items");
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.args)).toEqual([
      { query: "NVIDIA GTC 2026" },
      { query: "NVIDIA GTC 2027" },
    ]);
    expect(tools.map((tool) => tool.result)).toEqual(["result", "result-2"]);
    expect(feed.map((item) => item.kind)).toEqual([
      "message",
      "reasoning",
      "tool",
      "reasoning",
      "tool",
      "message",
    ]);
  });

  test("dedupes aggregate final reasoning across streamed steps on normalized turns", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "what changed?" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 0,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 1,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "First check." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 2,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 3,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "reasoning_delta",
          part: { id: "s1", mode: "reasoning", text: "Second check." },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 4,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "text_delta",
          part: { id: "a0", text: "Final answer." },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "reasoning", text: "First check.\n\nSecond check." },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Final answer." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning.map((item) => item.text)).toEqual(["First check.", "Second check."]);
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "reasoning", "message"]);
  });

  test("allows final reasoning after a repeated start when the latest step had no streamed reasoning", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "tell me about gtc this year" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-2",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-2",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "Initial research pass." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-2",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "reasoning",
          kind: "reasoning",
          text: "Final synthesis after the second step.",
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the summary." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((item) => item.text)).toEqual([
      "Initial research pass.",
      "Final synthesis after the second step.",
    ]);
  });

  test("dedupes repeated-start legacy reasoning when it matches an earlier streamed step", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "tell me about gtc this year" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-3",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-3",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "Searching for the latest GTC details." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-3",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "reasoning",
          kind: "reasoning",
          text: "Searching for the latest GTC details.",
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the summary." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("Searching for the latest GTC details.");
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);
  });

});
