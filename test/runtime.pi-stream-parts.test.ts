import { describe, expect, test } from "bun:test";
import { createPiEventRawPartMapper, mapPiEventToRawParts } from "../src/runtime/piStreamParts";

describe("mapPiEventToRawParts", () => {
  test("maps text, thinking, start, and finish events with provider reasoning mode", () => {
    for (const [event, provider, expected] of [
      [{ type: "start" }, "anthropic", [{ type: "start" }]],
      [
        { type: "text_start", contentIndex: 2, phase: "commentary" },
        "openai",
        [{ type: "text-start", id: "s2", phase: "commentary" }],
      ],
      [{ type: "text_delta", delta: 12 }, "openai", [{ type: "text-delta", id: "s0", text: "12" }]],
      [
        { type: "text_end", annotations: [{ url: "https://example.com" }], phase: "final" },
        "openai",
        [
          {
            type: "text-end",
            id: "s0",
            annotations: [{ url: "https://example.com" }],
            phase: "final",
          },
        ],
      ],
      [
        { type: "thinking_start" },
        "openai",
        [{ type: "reasoning-start", id: "s0", mode: "summary" }],
      ],
      [
        { type: "thinking_delta", delta: "plan" },
        "anthropic",
        [{ type: "reasoning-delta", id: "s0", mode: "reasoning", text: "plan" }],
      ],
      [
        { type: "thinking_end" },
        "codex-cli",
        [{ type: "reasoning-end", id: "s0", mode: "summary" }],
      ],
      [
        { type: "done", reason: "stop", message: { usage: { input: 3, output: 5 } } },
        "openai",
        [
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
          },
        ],
      ],
    ] as const) {
      expect(mapPiEventToRawParts(event, provider, false)).toEqual([...expected]);
    }
  });

  test("resolves tool-call ids from content, toolCall, or contentIndex fallback", () => {
    for (const [event, expected] of [
      [
        {
          type: "toolcall_start",
          contentIndex: 1,
          partial: { content: [{}, { id: " call-1 ", name: " bash ", arguments: { cmd: "ls" } }] },
        },
        [{ type: "tool-input-start", id: "call-1", toolName: "bash" }],
      ],
      [
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: { nested: true },
          toolCall: { id: " from-event " },
          partial: { content: [{}] },
        },
        [{ type: "tool-input-delta", id: "from-event", delta: "[object Object]" }],
      ],
      [
        { type: "toolcall_end", contentIndex: 4, partial: { content: [] } },
        [
          { type: "tool-input-end", id: "tool_call_4" },
          { type: "tool-call", toolCallId: "tool_call_4", toolName: "tool", input: {} },
        ],
      ],
    ] as const) {
      expect(mapPiEventToRawParts(event, "anthropic", false)).toEqual([...expected]);
    }
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
    for (const [id, args, expectedInput] of [
      ["c1", { path: "a.ts" }, { path: "a.ts" }],
      ["c2", ["not", "object"], {}],
    ] as const) {
      expect(
        mapPiEventToRawParts(
          {
            type: "toolcall_end",
            contentIndex: 0,
            partial: { content: [{ id, name: "read", arguments: args }] },
          },
          "anthropic",
          false,
        ),
      ).toEqual([
        { type: "tool-input-end", id },
        { type: "tool-call", toolCallId: id, toolName: "read", input: expectedInput },
      ]);
    }
  });

  test("maps stream errors and unknown events fail-closed unless opted in", () => {
    for (const [event, emitUnknown, expected] of [
      [
        { type: "error", error: { errorMessage: "  boom  " } },
        false,
        [{ type: "error", error: "boom" }],
      ],
      [{ type: "error", error: "raw failure" }, false, [{ type: "error", error: "raw failure" }]],
      [{ type: "error" }, false, [{ type: "error", error: "PI stream error" }]],
      [{ type: "mystery" }, false, []],
      [
        { type: "mystery" },
        true,
        [{ type: "unknown", sdkType: "mystery", raw: { type: "mystery" } }],
      ],
      ["not-an-event", true, [{ type: "unknown", sdkType: "unknown", raw: "not-an-event" }]],
      ["not-an-event", false, []],
    ] as const) {
      expect(mapPiEventToRawParts(event, "openai", emitUnknown)).toEqual([...expected]);
    }
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
