import { describe, expect, test } from "bun:test";

import { mapModelStreamChunk } from "../apps/TUI/context/modelStream";

describe("TUI model stream mapper", () => {
  const base = {
    type: "model_stream_chunk" as const,
    sessionId: "s1",
    turnId: "t1",
    provider: "openai" as const,
    model: "gpt-5.2",
  };

  function chunk(partType: any, part: Record<string, unknown>, index = 0) {
    return { ...base, index, partType, part };
  }

  test("maps turn boundaries and step parts", () => {
    expect(mapModelStreamChunk(chunk("start", {}, 0))).toEqual({
      kind: "turn_start",
      turnId: "t1",
    });

    expect(mapModelStreamChunk(chunk("finish", { finishReason: "stop", totalUsage: { tokens: 1 } }, 1))).toEqual({
      kind: "turn_finish",
      turnId: "t1",
      finishReason: "stop",
      rawFinishReason: undefined,
      totalUsage: { tokens: 1 },
    });

    expect(mapModelStreamChunk(chunk("abort", { reason: "user_cancelled" }, 2))).toEqual({
      kind: "turn_abort",
      turnId: "t1",
      reason: "user_cancelled",
    });

    expect(mapModelStreamChunk(chunk("error", { error: { code: "bad" } }, 3))).toEqual({
      kind: "turn_error",
      turnId: "t1",
      error: { code: "bad" },
    });

    expect(mapModelStreamChunk(chunk("start_step", { stepNumber: 1, request: { id: "rq" }, warnings: ["slow"] }, 4))).toEqual({
      kind: "step_start",
      turnId: "t1",
      stepNumber: 1,
      request: { id: "rq" },
      warnings: ["slow"],
    });

    expect(mapModelStreamChunk(chunk("finish_step", { stepNumber: 1, response: { id: "rs" }, usage: { in: 1 } }, 5))).toEqual({
      kind: "step_finish",
      turnId: "t1",
      stepNumber: 1,
      response: { id: "rs" },
      usage: { in: 1 },
      finishReason: undefined,
      rawFinishReason: undefined,
      providerMetadata: undefined,
    });
  });

  test("maps assistant text stream lifecycle", () => {
    expect(mapModelStreamChunk(chunk("text_start", { id: "txt_1" }, 0))).toEqual({
      kind: "assistant_text_start",
      turnId: "t1",
      streamId: "txt_1",
    });

    expect(mapModelStreamChunk(chunk("text_delta", { id: "txt_1", text: "hello" }, 1))).toEqual({
      kind: "assistant_delta",
      turnId: "t1",
      streamId: "txt_1",
      text: "hello",
    });

    expect(mapModelStreamChunk(chunk("text_end", { id: "txt_1" }, 2))).toEqual({
      kind: "assistant_text_end",
      turnId: "t1",
      streamId: "txt_1",
    });
  });

  test("maps reasoning lifecycle with mode", () => {
    expect(mapModelStreamChunk(chunk("reasoning_start", { id: "r1", mode: "summary" }, 0))).toEqual({
      kind: "reasoning_start",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
    });

    expect(mapModelStreamChunk(chunk("reasoning_delta", { id: "r1", mode: "summary", text: "thinking" }, 1))).toEqual({
      kind: "reasoning_delta",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
      text: "thinking",
    });

    expect(mapModelStreamChunk(chunk("reasoning_end", { id: "r1", mode: "summary" }, 2))).toEqual({
      kind: "reasoning_end",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
    });
  });

  test("maps tool lifecycle events to structured tool updates", () => {
    expect(mapModelStreamChunk(chunk("tool_input_start", { id: "tool_1", toolName: "read", path: "README.md" }, 0))).toEqual({
      kind: "tool_input_start",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      args: { id: "tool_1", toolName: "read", path: "README.md" },
    });

    expect(mapModelStreamChunk(chunk("tool_input_delta", { id: "tool_1", delta: "{\"path\":\"README.md\"}" }, 1))).toEqual({
      kind: "tool_input_delta",
      turnId: "t1",
      key: "tool_1",
      delta: "{\"path\":\"README.md\"}",
    });

    expect(mapModelStreamChunk(chunk("tool_input_end", { id: "tool_1", toolName: "read" }, 2))).toEqual({
      kind: "tool_input_end",
      turnId: "t1",
      key: "tool_1",
      name: "read",
    });

    expect(mapModelStreamChunk(chunk("tool_call", { toolCallId: "tool_1", toolName: "read", input: { path: "README.md" } }, 3))).toEqual({
      kind: "tool_call",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      args: { path: "README.md" },
    });

    expect(mapModelStreamChunk(chunk("tool_call", { toolCallId: 123, toolName: "read", input: {} }, 3))).toEqual({
      kind: "tool_call",
      turnId: "t1",
      key: "123",
      name: "read",
      args: {},
    });

    expect(mapModelStreamChunk(chunk("tool_call", { toolName: "read", input: {} }, 9))).toEqual({
      kind: "tool_call",
      turnId: "t1",
      key: "tool:t1:9",
      name: "read",
      args: {},
    });

    expect(mapModelStreamChunk(chunk("tool_result", { toolCallId: "tool_1", toolName: "read", output: { chars: 120 } }, 4))).toEqual({
      kind: "tool_result",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      result: { chars: 120 },
    });

    expect(mapModelStreamChunk(chunk("tool_error", { toolCallId: "tool_1", toolName: "read", error: "boom" }, 5))).toEqual({
      kind: "tool_error",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      error: "boom",
    });

    expect(mapModelStreamChunk(chunk("tool_output_denied", { toolCallId: "tool_1", toolName: "read", reason: "blocked" }, 6))).toEqual({
      kind: "tool_output_denied",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      reason: "blocked",
    });

    expect(mapModelStreamChunk(chunk("tool_approval_request", { approvalId: "ap-1", toolCall: { toolName: "bash" } }, 7))).toEqual({
      kind: "tool_approval_request",
      turnId: "t1",
      approvalId: "ap-1",
      toolCall: { toolName: "bash" },
    });
  });

  test("maps source, file, raw, and unknown stream parts", () => {
    expect(mapModelStreamChunk(chunk("source", { source: { type: "url", url: "https://example.com" } }, 0))).toEqual({
      kind: "source",
      turnId: "t1",
      source: { type: "url", url: "https://example.com" },
    });

    expect(mapModelStreamChunk(chunk("file", { file: { path: "/tmp/a.txt" } }, 1))).toEqual({
      kind: "file",
      turnId: "t1",
      file: { path: "/tmp/a.txt" },
    });

    expect(mapModelStreamChunk(chunk("raw", { raw: { hello: "world" } }, 2))).toEqual({
      kind: "raw",
      turnId: "t1",
      raw: { hello: "world" },
    });

    expect(mapModelStreamChunk(chunk("raw", { raw: { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "arg" } }, 3))).toEqual({
      kind: "tool_input_delta",
      turnId: "t1",
      key: "fc_1",
      delta: "arg",
    });

    expect(mapModelStreamChunk(chunk("raw", { raw: { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: { a: 1 } } }, 3))).toEqual({
      kind: "tool_input_delta",
      turnId: "t1",
      key: "fc_2",
      delta: '{"a":1}',
    });

    expect(mapModelStreamChunk(chunk("raw", { raw: { type: "response.output_text.delta", item_id: "txt_9", delta: "hello" } }, 3))).toEqual({
      kind: "assistant_delta",
      turnId: "t1",
      streamId: "txt_9",
      text: "hello",
    });

    expect(mapModelStreamChunk(chunk("unknown", {
      sdkType: "response.reasoning_summary_text.delta",
      raw: { item_id: "r1", delta: "think" },
    }, 4))).toEqual({
      kind: "reasoning_delta",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
      text: "think",
    });

    expect(mapModelStreamChunk(chunk("unknown", {
      sdkType: "response.completed",
      raw: { response: { status: "completed" } },
    }, 4))).toEqual({
      kind: "turn_finish",
      turnId: "t1",
      finishReason: "completed",
      rawFinishReason: undefined,
      totalUsage: undefined,
    });

    expect(mapModelStreamChunk(chunk("unknown", { sdkType: "mystery" }, 5))).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "unknown",
      payload: { sdkType: "mystery" },
    });

    expect(mapModelStreamChunk({
      ...chunk("unknown", { sdkType: "response.output_text.delta" }, 7),
      rawPart: { type: "response.output_text.delta", item_id: "txt-raw", delta: "from-rawpart" },
    })).toEqual({
      kind: "assistant_delta",
      turnId: "t1",
      streamId: "txt-raw",
      text: "from-rawpart",
    });

    expect(mapModelStreamChunk(chunk("future_part_type", { next: true }, 6) as any)).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "future_part_type",
      payload: { next: true },
    });
  });

  test("maps malformed known deltas to unknown instead of dropping", () => {
    expect(mapModelStreamChunk(chunk("text_delta", { id: "txt_1" }, 0))).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "text_delta",
      payload: { id: "txt_1" },
    });

    expect(mapModelStreamChunk(chunk("reasoning_delta", { id: "r1", mode: "summary" }, 1))).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "reasoning_delta",
      payload: { id: "r1", mode: "summary" },
    });

    expect(mapModelStreamChunk(chunk("tool_input_delta", { id: "tool_1" }, 2))).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "tool_input_delta",
      payload: { id: "tool_1" },
    });
  });
});
