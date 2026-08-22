import { describe, expect, test } from "bun:test";

import {
  detectMalformedToolCallFailure,
  extractAssistantTextFromResponseMessages,
  normalizePreviewText,
} from "../../src/server/session/turnExecution/turnResponseParsing";

function toolResult(opts: { toolName: string; isError?: boolean; message?: string }) {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: opts.toolName,
        isError: opts.isError ?? true,
        output: { value: opts.message ?? "tool failed" },
      },
    ],
  };
}

describe("turn response parsing", () => {
  test("normalizePreviewText trims, drops blanks, and ellipsizes at the cap", () => {
    expect(normalizePreviewText("   ")).toBeUndefined();
    expect(normalizePreviewText("  short preview  ")).toBe("short preview");
    expect(normalizePreviewText("x".repeat(800))).toBe("x".repeat(800));
    expect(normalizePreviewText("x".repeat(801))).toBe(`${"x".repeat(799)}…`);
  });

  test("extractAssistantTextFromResponseMessages skips commentary and joins assistants", () => {
    expect(
      extractAssistantTextFromResponseMessages([
        { role: "user", content: "ignore" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Visible" },
            { type: "text", text: "aside", phase: "commentary" },
            { type: "output_text", text: "answer" },
          ],
        },
        { role: "assistant", content: "Second turn" },
      ]),
    ).toBe("Visibleanswer\n\nSecond turn");
  });

  test("detectMalformedToolCallFailure requires repeated failures without any success", () => {
    expect(detectMalformedToolCallFailure([], "")).toBeNull();
    expect(
      detectMalformedToolCallFailure(
        [
          toolResult({ toolName: "bash", message: "tool bash not found" }),
          toolResult({ toolName: "bash", message: "tool bash not found" }),
        ],
        "function call format is wrong",
      ),
    ).toBeNull();

    expect(
      detectMalformedToolCallFailure(
        [
          toolResult({ toolName: "bash", message: "tool bash not found" }),
          toolResult({ toolName: "grep", message: "tool grep not found" }),
          toolResult({ toolName: "glob", isError: false, message: "ok" }),
        ],
        "function call format is wrong",
      ),
    ).toBeNull();

    const formattingFailure = detectMalformedToolCallFailure(
      [
        toolResult({ toolName: "bash", message: "tool bash not found" }),
        toolResult({ toolName: "grep", message: "invalid input" }),
        toolResult({ toolName: "glob", message: "expected string received number" }),
      ],
      "The function call format was invalid.",
    );
    expect(formattingFailure).toContain(
      "Model failed to produce valid tool calls after repeated attempts:",
    );
    expect(formattingFailure).toContain("tool bash not found");

    const repeatedUnknown = detectMalformedToolCallFailure(
      [
        toolResult({ toolName: "tool<", message: "tool tool< not found" }),
        toolResult({ toolName: "tool foo", message: "tool foo not found" }),
        toolResult({ toolName: "tool", message: "tool  not found" }),
      ],
      "",
    );
    expect(repeatedUnknown).toContain(
      "Model failed to produce valid tool calls after repeated attempts:",
    );
  });
});
