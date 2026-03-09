import { describe, expect, test } from "bun:test";

import type { TranscriptEvent } from "../src/app/types";
import { mapTranscriptToFeed } from "../src/app/store.feedMapping";

describe("desktop transcript feed mapping", () => {
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

  test("preserves transcript event order instead of sorting by timestamps", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:10.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "Start" },
      },
      {
        ts: "2024-01-01T00:00:30.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning_summary", text: "Inspecting files." },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Done." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);
    expect(feed[0]?.kind).toBe("message");
    expect(feed[1]?.kind).toBe("reasoning");
    expect(feed[2]?.kind).toBe("message");
  });
});
