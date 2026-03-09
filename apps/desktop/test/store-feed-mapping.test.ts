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

  test("replays raw model stream events and ignores stale normalized reasoning chunks", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 0,
          provider: "openai",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1", summary: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 1,
          provider: "openai",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.reasoning_summary_part.added",
            part: { text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 2,
          provider: "openai",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.reasoning_summary_text.delta",
            delta: "raw reasoning",
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
          turnId: "turn-raw",
          index: 3,
          provider: "openai",
          model: "gpt-5.2",
          partType: "reasoning_delta",
          part: { id: "r1", mode: "summary", text: "stale reasoning" },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("raw reasoning");
  });

  test("keeps separate assistant text streams within one turn", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-2",
          index: 0,
          provider: "openai",
          model: "gpt-5.2",
          partType: "text_delta",
          part: { id: "txt_1", text: "First note." },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-2",
          index: 1,
          provider: "openai",
          model: "gpt-5.2",
          partType: "text_delta",
          part: { id: "txt_2", text: "Second note." },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant.map((item) => item.text)).toEqual(["First note.", "Second note."]);
  });

  test("prefers raw final-answer text over a stale merged assistant_message on raw-backed turns", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_commentary", phase: "commentary", content: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.content_part.added",
            item_id: "msg_commentary",
            part: { type: "output_text", text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 2,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_text.delta",
            item_id: "msg_commentary",
            delta: "progress note",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 3,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "msg_commentary",
              type: "message",
              phase: "commentary",
              status: "completed",
              content: [{ type: "output_text", text: "progress note" }],
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 4,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_final", phase: "final_answer", content: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 5,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.content_part.added",
            item_id: "msg_final",
            part: { type: "output_text", text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 6,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_text.delta",
            item_id: "msg_final",
            delta: "final answer",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 7,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "msg_final",
              type: "message",
              phase: "final_answer",
              status: "completed",
              content: [{ type: "output_text", text: "final answer" }],
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "assistant_message",
          text: "progress note\n\nfinal answer",
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("final answer");
  });

  test("inserts a late legacy reasoning summary before the raw-backed final assistant message", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_final", phase: "final_answer", content: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.content_part.added",
            item_id: "msg_final",
            part: { type: "output_text", text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 2,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_text.delta",
            item_id: "msg_final",
            delta: "final answer",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "summary", text: "late summary" },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "final answer" },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "message"]);
    expect(feed[0]?.kind).toBe("reasoning");
    expect(feed[1]?.kind).toBe("message");
    if (feed[0]?.kind !== "reasoning") throw new Error("Expected reasoning item first");
    if (feed[1]?.kind !== "message") throw new Error("Expected assistant message second");
    expect(feed[0].text).toBe("late summary");
    expect(feed[1].role).toBe("assistant");
    expect(feed[1].text).toBe("final answer");
  });
});
