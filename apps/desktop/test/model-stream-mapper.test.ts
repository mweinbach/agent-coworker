import { describe, expect, test } from "bun:test";

import { mapModelStreamChunk } from "../src/app/modelStream";

describe("desktop model stream mapper", () => {
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

  test("maps boundary and lifecycle parts", () => {
    expect(mapModelStreamChunk(chunk("start", {}, 0))).toEqual({ kind: "turn_start", turnId: "t1" });
    expect(mapModelStreamChunk(chunk("finish", { finishReason: "stop" }, 1))).toEqual({
      kind: "turn_finish",
      turnId: "t1",
      finishReason: "stop",
      rawFinishReason: undefined,
      totalUsage: undefined,
    });
    expect(mapModelStreamChunk(chunk("start_step", { request: { id: "rq1" } }, 2))).toEqual({
      kind: "step_start",
      turnId: "t1",
      request: { id: "rq1" },
      warnings: undefined,
    });
    expect(mapModelStreamChunk(chunk("finish_step", { response: { id: "rs1" } }, 3))).toEqual({
      kind: "step_finish",
      turnId: "t1",
      response: { id: "rs1" },
      usage: undefined,
      finishReason: undefined,
      rawFinishReason: undefined,
      providerMetadata: undefined,
    });
    expect(mapModelStreamChunk(chunk("abort", { reason: "cancelled" }, 4))).toEqual({
      kind: "turn_abort",
      turnId: "t1",
      reason: "cancelled",
    });
    expect(mapModelStreamChunk(chunk("error", { error: "boom" }, 5))).toEqual({
      kind: "turn_error",
      turnId: "t1",
      error: "boom",
    });
  });

  test("maps text and reasoning stream parts", () => {
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

    expect(mapModelStreamChunk(chunk("reasoning_start", { id: "r1", mode: "summary" }, 3))).toEqual({
      kind: "reasoning_start",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
    });
    expect(mapModelStreamChunk(chunk("reasoning_delta", { id: "r1", mode: "summary", text: "thinking" }, 4))).toEqual({
      kind: "reasoning_delta",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
      text: "thinking",
    });
    expect(mapModelStreamChunk(chunk("reasoning_end", { id: "r1", mode: "summary" }, 5))).toEqual({
      kind: "reasoning_end",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
    });
  });

  test("maps tool, source/file, and unknown parts", () => {
    expect(mapModelStreamChunk(chunk("tool_input_start", { id: "tool_1", toolName: "read" }, 0))).toEqual({
      kind: "tool_input_start",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      args: { id: "tool_1", toolName: "read" },
    });
    expect(mapModelStreamChunk(chunk("tool_input_delta", { id: "tool_1", delta: "abc" }, 1))).toEqual({
      kind: "tool_input_delta",
      turnId: "t1",
      key: "tool_1",
      delta: "abc",
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
    expect(mapModelStreamChunk(chunk("tool_result", { toolCallId: "tool_1", toolName: "read", output: { chars: 42 } }, 4))).toEqual({
      kind: "tool_result",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      result: { chars: 42 },
    });
    expect(mapModelStreamChunk(chunk("tool_error", { toolCallId: "tool_1", toolName: "read", error: "nope" }, 5))).toEqual({
      kind: "tool_error",
      turnId: "t1",
      key: "tool_1",
      name: "read",
      error: "nope",
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
    expect(mapModelStreamChunk(chunk("source", { source: { kind: "url", value: "https://example.com" } }, 8))).toEqual({
      kind: "source",
      turnId: "t1",
      source: { kind: "url", value: "https://example.com" },
    });
    expect(mapModelStreamChunk(chunk("file", { file: { path: "/tmp/a.txt" } }, 9))).toEqual({
      kind: "file",
      turnId: "t1",
      file: { path: "/tmp/a.txt" },
    });
    expect(mapModelStreamChunk(chunk("raw", { raw: { hello: "world" } }, 10))).toEqual({
      kind: "raw",
      turnId: "t1",
      raw: { hello: "world" },
    });

    expect(mapModelStreamChunk(chunk("raw", { raw: { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "arg" } }, 11))).toEqual({
      kind: "tool_input_delta",
      turnId: "t1",
      key: "fc_1",
      delta: "arg",
    });

    expect(mapModelStreamChunk(chunk("raw", { raw: { type: "response.output_text.delta", item_id: "txt_9", delta: "hello" } }, 11))).toEqual({
      kind: "assistant_delta",
      turnId: "t1",
      streamId: "txt_9",
      text: "hello",
    });

    expect(mapModelStreamChunk(chunk("unknown", {
      sdkType: "response.reasoning_summary_text.delta",
      raw: { item_id: "r1", delta: "think" },
    }, 12))).toEqual({
      kind: "reasoning_delta",
      turnId: "t1",
      streamId: "r1",
      mode: "summary",
      text: "think",
    });

    expect(mapModelStreamChunk(chunk("unknown", {
      sdkType: "response.completed",
      raw: { response: { status: "completed" } },
    }, 12))).toEqual({
      kind: "turn_finish",
      turnId: "t1",
      finishReason: "completed",
      rawFinishReason: undefined,
      totalUsage: undefined,
    });

    expect(mapModelStreamChunk(chunk("unknown", { sdkType: "mystery" }, 13))).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "unknown",
      payload: { sdkType: "mystery" },
    });
    expect(mapModelStreamChunk(chunk("future_part_type", { experimental: true }, 14) as any)).toEqual({
      kind: "unknown",
      turnId: "t1",
      partType: "future_part_type",
      payload: { experimental: true },
    });
  });
});
