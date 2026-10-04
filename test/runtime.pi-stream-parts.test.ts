import { describe, expect, test } from "bun:test";

import { createPiEventRawPartMapper, mapPiEventToRawParts } from "../src/runtime/piStreamParts";

describe("mapPiEventToRawParts", () => {
  test("maps text, thinking, start, and finish events with provider reasoning mode", () => {
    expect(mapPiEventToRawParts({ type: "start" }, "anthropic", false)).toEqual([
      { type: "start" },
    ]);
    expect(
      mapPiEventToRawParts(
        { type: "text_start", contentIndex: 2, phase: "commentary" },
        "openai",
        false,
      ),
    ).toEqual([{ type: "text-start", id: "s2", phase: "commentary" }]);
    expect(mapPiEventToRawParts({ type: "text_delta", delta: 12 }, "openai", false)).toEqual([
      { type: "text-delta", id: "s0", text: "12" },
    ]);
    expect(
      mapPiEventToRawParts(
        { type: "text_end", annotations: [{ url: "https://example.com" }], phase: "final" },
        "openai",
        false,
      ),
    ).toEqual([
      {
        type: "text-end",
        id: "s0",
        annotations: [{ url: "https://example.com" }],
        phase: "final",
      },
    ]);

    expect(mapPiEventToRawParts({ type: "thinking_start" }, "openai", false)).toEqual([
      { type: "reasoning-start", id: "s0", mode: "summary" },
    ]);
    expect(
      mapPiEventToRawParts({ type: "thinking_delta", delta: "plan" }, "anthropic", false),
    ).toEqual([{ type: "reasoning-delta", id: "s0", mode: "reasoning", text: "plan" }]);
    expect(mapPiEventToRawParts({ type: "thinking_end" }, "codex-cli", false)).toEqual([
      { type: "reasoning-end", id: "s0", mode: "summary" },
    ]);

    expect(
      mapPiEventToRawParts(
        { type: "done", reason: "stop", message: { usage: { input: 3, output: 5 } } },
        "openai",
        false,
      ),
    ).toEqual([
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      },
    ]);
  });

  test("resolves tool-call ids from content, toolCall, or contentIndex fallback", () => {
    expect(
      mapPiEventToRawParts(
        {
          type: "toolcall_start",
          contentIndex: 1,
          partial: { content: [{}, { id: " call-1 ", name: " bash ", arguments: { cmd: "ls" } }] },
        },
        "anthropic",
        false,
      ),
    ).toEqual([{ type: "tool-input-start", id: "call-1", toolName: "bash" }]);

    expect(
      mapPiEventToRawParts(
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: { nested: true },
          toolCall: { id: " from-event " },
          partial: { content: [{}] },
        },
        "anthropic",
        false,
      ),
    ).toEqual([{ type: "tool-input-delta", id: "from-event", delta: "[object Object]" }]);

    expect(
      mapPiEventToRawParts(
        {
          type: "toolcall_end",
          contentIndex: 4,
          partial: { content: [] },
        },
        "anthropic",
        false,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "tool_call_4" },
      { type: "tool-call", toolCallId: "tool_call_4", toolName: "tool", input: {} },
    ]);
  });

  test("uses a timestamp fallback id when tool contentIndex is missing", () => {
    const now = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      expect(mapPiEventToRawParts({ type: "toolcall_start" }, "anthropic", false)).toEqual([
        { type: "tool-input-start", id: "tool_1700000000000", toolName: "tool" },
      ]);
    } finally {
      Date.now = now;
    }
  });

  test("keeps object tool arguments and drops non-object input on tool-call emit", () => {
    expect(
      mapPiEventToRawParts(
        {
          type: "toolcall_end",
          contentIndex: 0,
          partial: { content: [{ id: "c1", name: "read", arguments: { path: "a.ts" } }] },
        },
        "anthropic",
        false,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "c1" },
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } },
    ]);

    expect(
      mapPiEventToRawParts(
        {
          type: "toolcall_end",
          contentIndex: 0,
          partial: { content: [{ id: "c2", name: "read", arguments: ["not", "object"] }] },
        },
        "anthropic",
        false,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "c2" },
      { type: "tool-call", toolCallId: "c2", toolName: "read", input: {} },
    ]);
  });

  test("maps stream errors and unknown events fail-closed unless opted in", () => {
    expect(
      mapPiEventToRawParts({ type: "error", error: { errorMessage: "  boom  " } }, "openai", false),
    ).toEqual([{ type: "error", error: "boom" }]);
    expect(mapPiEventToRawParts({ type: "error", error: "raw failure" }, "openai", false)).toEqual([
      { type: "error", error: "raw failure" },
    ]);
    expect(mapPiEventToRawParts({ type: "error" }, "openai", false)).toEqual([
      { type: "error", error: "PI stream error" },
    ]);

    expect(mapPiEventToRawParts({ type: "mystery" }, "openai", false)).toEqual([]);
    expect(mapPiEventToRawParts({ type: "mystery" }, "openai", true)).toEqual([
      { type: "unknown", sdkType: "mystery", raw: { type: "mystery" } },
    ]);
    expect(mapPiEventToRawParts("not-an-event", "openai", true)).toEqual([
      { type: "unknown", sdkType: "unknown", raw: "not-an-event" },
    ]);
    expect(mapPiEventToRawParts("not-an-event", "openai", false)).toEqual([]);
  });
});

describe("createPiEventRawPartMapper", () => {
  test("splits MiniMax think tags across text-delta chunks and flushes on text-end", () => {
    const map = createPiEventRawPartMapper("minimax", false);

    expect(map({ type: "text_start", contentIndex: 0 })).toEqual([
      { type: "text-start", id: "s0" },
    ]);
    expect(map({ type: "text_delta", contentIndex: 0, delta: "Visible <thi" })).toEqual([
      { type: "text-delta", id: "s0", text: "Visible " },
    ]);
    expect(map({ type: "text_delta", contentIndex: 0, delta: "nk>hidden</thi" })).toEqual([
      { type: "reasoning-start", id: "s0:think", mode: "reasoning" },
      { type: "reasoning-delta", id: "s0:think", mode: "reasoning", text: "hidden" },
    ]);
    expect(map({ type: "text_delta", contentIndex: 0, delta: "nk> answer" })).toEqual([
      { type: "text-delta", id: "s0", text: " answer" },
    ]);
    expect(map({ type: "text_end", contentIndex: 0 })).toEqual([
      { type: "reasoning-end", id: "s0:think", mode: "reasoning" },
      { type: "text-end", id: "s0" },
    ]);
  });

  test("does not apply MiniMax think-tag splitting for other providers", () => {
    const map = createPiEventRawPartMapper("anthropic", false);
    expect(map({ type: "text_delta", delta: "Visible <think>hidden</think> answer" })).toEqual([
      { type: "text-delta", id: "s0", text: "Visible <think>hidden</think> answer" },
    ]);
  });
});
