import { describe, expect, test } from "bun:test";

import {
  detectMalformedToolCallFailure,
  extractAssistantTextFromResponseMessages,
  normalizePreviewText,
} from "../../src/server/session/turnExecution/turnResponseParsing";

const toolMessage = (opts: { toolName?: string; isError?: boolean; value?: string }) => ({
  role: "tool",
  content: [
    {
      type: "tool-result" as const,
      toolName: opts.toolName ?? "read",
      isError: opts.isError ?? false,
      output: opts.value === undefined ? undefined : { value: opts.value },
    },
  ],
});

describe("turn response parsing", () => {
  test("extractAssistantTextFromResponseMessages and normalizePreviewText format output", () => {
    expect(
      extractAssistantTextFromResponseMessages([
        { role: "user", content: "ignore" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "visible" },
            { type: "text", text: "side note", phase: "commentary" },
            { type: "output_text", text: " next" },
            { type: "image", text: "not-text" },
          ],
        },
        { role: "assistant", content: "  trailing  " },
      ]),
    ).toBe("visible next\n\ntrailing");
    expect(extractAssistantTextFromResponseMessages([{ role: "assistant", content: [] }])).toBe("");

    expect(normalizePreviewText("   ")).toBeUndefined();
    expect(normalizePreviewText(" short ")).toBe("short");
    expect(normalizePreviewText("x".repeat(800))).toHaveLength(800);
    expect(normalizePreviewText("x".repeat(801))).toBe(`${"x".repeat(799)}…`);
  });

  test("detectMalformedToolCallFailure requires three systemic tool failures and deduplicates samples", () => {
    expect(detectMalformedToolCallFailure([], "tool call format is wrong")).toBeNull();
    expect(
      detectMalformedToolCallFailure(
        [
          toolMessage({ isError: true, value: "tool foo not found" }),
          toolMessage({ isError: true, value: "invalid input" }),
        ],
        "tool call format is wrong",
      ),
    ).toBeNull();
    expect(
      detectMalformedToolCallFailure(
        [
          toolMessage({ isError: true, value: "tool foo not found" }),
          toolMessage({ isError: true, value: "invalid input" }),
          toolMessage({ isError: true, value: "expected string received number" }),
          toolMessage({ isError: false, value: "ok" }),
        ],
        "tool call format is wrong",
      ),
    ).toBeNull();

    expect(
      detectMalformedToolCallFailure(
        [
          toolMessage({ toolName: "tool<", isError: true, value: "malformed name" }),
          toolMessage({ isError: true, value: "tool search not found" }),
          toolMessage({ isError: true, value: "invalid input: too small: 0" }),
        ],
        "continuing",
      ),
    ).toBe(
      "Model failed to produce valid tool calls after repeated attempts: malformed name; tool search not found",
    );

    expect(
      detectMalformedToolCallFailure(
        [
          toolMessage({ isError: true, value: "network timeout" }),
          toolMessage({ isError: true, value: "network timeout" }),
          toolMessage({ isError: true, value: "disk full" }),
        ],
        "The function call format was invalid.",
      ),
    ).toBe(
      "Model failed to produce valid tool calls after repeated attempts: network timeout; disk full",
    );
  });
});
