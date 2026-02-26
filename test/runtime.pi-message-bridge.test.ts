import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "../src/types";

import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "../src/runtime/piMessageBridge";

describe("pi message bridge", () => {
  test("converts model messages into pi messages for user/assistant/tool results", () => {
    const modelMessages = [
      { role: "user", content: [{ type: "text", text: "summarize this file" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          { type: "reasoning", text: "Need to inspect file first." },
          { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "/tmp/a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ] as ModelMessage[];

    const piMessages = modelMessagesToPiMessages(modelMessages);
    expect(piMessages.map((m: any) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect((piMessages[0] as any).content).toContain("summarize this file");
    expect((piMessages[1] as any).content.some((part: any) => part.type === "toolCall")).toBe(true);
    expect((piMessages[2] as any).toolCallId).toBe("call-1");
  });

  test("converts pi turn messages back to model messages", () => {
    const piTurnMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Done." },
          { type: "thinking", thinking: "I verified all requirements." },
          { type: "toolCall", id: "call-2", name: "write", arguments: { path: "/tmp/a.ts", content: "ok" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "write",
        content: [{ type: "text", text: "{\"written\":true}" }],
        isError: false,
      },
    ] as any[];

    const modelMessages = piTurnMessagesToModelMessages(piTurnMessages as any);
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[0].role).toBe("assistant");
    expect((modelMessages[0] as any).content.some((part: any) => part.type === "reasoning")).toBe(true);
    expect(modelMessages[1].role).toBe("tool");
    expect((modelMessages[1] as any).content[0].type).toBe("tool-result");
  });

  test("extracts assistant text and reasoning from pi messages", () => {
    const piMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "thinking", thinking: "thinking-1" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "second" },
          { type: "thinking", thinking: "thinking-2" },
        ],
      },
    ] as any[];

    expect(extractPiAssistantText(piMessages as any)).toBe("first\n\nsecond");
    expect(extractPiReasoningText(piMessages as any)).toBe("thinking-1\n\nthinking-2");
  });

  test("merges pi usage records into runtime usage totals", () => {
    const usage1 = mergePiUsage(undefined, { input: 10, output: 2, totalTokens: 12 });
    const usage2 = mergePiUsage(usage1, { input: 3, output: 7, totalTokens: 10 });

    expect(usage2).toEqual({
      promptTokens: 13,
      completionTokens: 9,
      totalTokens: 22,
    });
  });
});
