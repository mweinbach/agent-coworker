import { describe, expect, test } from "bun:test";

import { mapModelStreamChunk } from "../apps/TUI/context/modelStream";

describe("TUI model stream mapper", () => {
  test("maps text_delta to assistant_delta", () => {
    const update = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t1",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "hello" },
    });
    expect(update).toEqual({ kind: "assistant_delta", turnId: "t1", text: "hello" });
  });

  test("maps reasoning_delta to reasoning_delta update with mode", () => {
    const update = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t2",
      index: 2,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: { id: "r1", mode: "summary", text: "thinking..." },
    });
    expect(update).toEqual({
      kind: "reasoning_delta",
      turnId: "t2",
      streamId: "r1",
      mode: "summary",
      text: "thinking...",
    });
  });

  test("maps tool lifecycle events to structured tool updates", () => {
    const start = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t3",
      index: 3,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_input_start",
      part: { id: "tool_1", toolName: "read", path: "README.md" },
    });
    expect(start).toMatchObject({ kind: "tool_input_start", turnId: "t3", key: "tool_1", name: "read" });

    const call = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t3",
      index: 4,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_call",
      part: { toolCallId: "tool_1", toolName: "read", input: { path: "README.md" } },
    });
    expect(call).toEqual({
      kind: "tool_call",
      turnId: "t3",
      key: "tool_1",
      name: "read",
      args: { path: "README.md" },
    });

    const result = mapModelStreamChunk({
      type: "model_stream_chunk",
      sessionId: "s1",
      turnId: "t3",
      index: 5,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_result",
      part: { toolCallId: "tool_1", toolName: "read", output: { chars: 120 } },
    });
    expect(result).toEqual({
      kind: "tool_result",
      turnId: "t3",
      key: "tool_1",
      name: "read",
      result: { chars: 120 },
    });
  });
});
