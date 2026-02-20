import { describe, expect, test } from "bun:test";

import {
  normalizeModelStreamPart,
  reasoningModeForProvider,
} from "../src/server/modelStream";

const defaultOpts = { provider: "google" as const };

describe("server model stream normalization", () => {
  test("keeps stepNumber on start-step and finish-step parts", () => {
    const start = normalizeModelStreamPart(
      { type: "start-step", stepNumber: 3, request: { id: "rq-1" }, warnings: ["slow"] },
      { provider: "google" }
    );
    expect(start).toEqual({
      partType: "start_step",
      part: {
        stepNumber: 3,
        request: { id: "rq-1" },
        warnings: ["slow"],
      },
    });

    const finish = normalizeModelStreamPart(
      {
        type: "finish-step",
        stepNumber: 3,
        response: { id: "rs-1" },
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "tool-calls",
      },
      { provider: "google" }
    );
    expect(finish).toEqual({
      partType: "finish_step",
      part: {
        stepNumber: 3,
        response: { id: "rs-1" },
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "tool-calls",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// reasoningModeForProvider
// ---------------------------------------------------------------------------
describe("reasoningModeForProvider", () => {
  test('returns "summary" for openai', () => {
    expect(reasoningModeForProvider("openai")).toBe("summary");
  });

  test('returns "summary" for codex-cli', () => {
    expect(reasoningModeForProvider("codex-cli")).toBe("summary");
  });

  test('returns "reasoning" for google', () => {
    expect(reasoningModeForProvider("google")).toBe("reasoning");
  });

  test('returns "reasoning" for anthropic', () => {
    expect(reasoningModeForProvider("anthropic")).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// normalizeModelStreamPart — all switch branches
// ---------------------------------------------------------------------------
describe("normalizeModelStreamPart branches", () => {
  // 1. start
  describe("start", () => {
    test("returns empty part", () => {
      const result = normalizeModelStreamPart({ type: "start" }, defaultOpts);
      expect(result).toEqual({ partType: "start", part: {} });
    });

    test("ignores extra fields", () => {
      const result = normalizeModelStreamPart(
        { type: "start", extra: "ignored" },
        defaultOpts
      );
      expect(result).toEqual({ partType: "start", part: {} });
    });
  });

  // 2. finish
  describe("finish", () => {
    test("extracts finishReason, rawFinishReason, and totalUsage", () => {
      const result = normalizeModelStreamPart(
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "end_turn",
          totalUsage: { inputTokens: 100, outputTokens: 50 },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "finish",
        part: {
          finishReason: "stop",
          rawFinishReason: "end_turn",
          totalUsage: { inputTokens: 100, outputTokens: 50 },
        },
      });
    });

    test('defaults finishReason to "unknown" when missing', () => {
      const result = normalizeModelStreamPart({ type: "finish" }, defaultOpts);
      expect(result.part.finishReason).toBe("unknown");
    });

    test("omits rawFinishReason and totalUsage when undefined", () => {
      const result = normalizeModelStreamPart({ type: "finish" }, defaultOpts);
      expect(result.part).not.toHaveProperty("rawFinishReason");
      expect(result.part).not.toHaveProperty("totalUsage");
    });
  });

  // 3. abort
  describe("abort", () => {
    test("extracts reason", () => {
      const result = normalizeModelStreamPart(
        { type: "abort", reason: "timeout" },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "abort",
        part: { reason: "timeout" },
      });
    });

    test("omits reason when not provided", () => {
      const result = normalizeModelStreamPart({ type: "abort" }, defaultOpts);
      expect(result).toEqual({ partType: "abort", part: {} });
    });
  });

  // 4. error
  describe("error", () => {
    test("extracts error field", () => {
      const result = normalizeModelStreamPart(
        { type: "error", error: "something broke" },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "error",
        part: { error: "something broke" },
      });
    });

    test("sanitizes Error objects", () => {
      const err = new Error("boom");
      const result = normalizeModelStreamPart(
        { type: "error", error: err },
        defaultOpts
      );
      expect(result.partType).toBe("error");
      expect((result.part.error as Record<string, unknown>).name).toBe("Error");
      expect((result.part.error as Record<string, unknown>).message).toBe("boom");
    });

    test("handles undefined error", () => {
      const result = normalizeModelStreamPart({ type: "error" }, defaultOpts);
      expect(result.partType).toBe("error");
      // error field should be undefined (sanitizeUnknown(undefined) returns undefined)
    });
  });

  // 5. text-start
  describe("text-start", () => {
    test("extracts id and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        { type: "text-start", id: "t-1", providerMetadata: { key: "val" } },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "text_start",
        part: { id: "t-1", providerMetadata: { key: "val" } },
      });
    });

    test("defaults id to empty string when missing", () => {
      const result = normalizeModelStreamPart(
        { type: "text-start" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
    });

    test("omits providerMetadata when absent", () => {
      const result = normalizeModelStreamPart(
        { type: "text-start", id: "t-1" },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("providerMetadata");
    });
  });

  // 6. text-delta (primary streaming event)
  describe("text-delta", () => {
    test("extracts id, text, and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        {
          type: "text-delta",
          id: "td-1",
          text: "Hello world",
          providerMetadata: { model: "gpt-4" },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "text_delta",
        part: {
          id: "td-1",
          text: "Hello world",
          providerMetadata: { model: "gpt-4" },
        },
      });
    });

    test("defaults id to empty string when missing", () => {
      const result = normalizeModelStreamPart(
        { type: "text-delta", text: "chunk" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
    });

    test("handles empty text", () => {
      const result = normalizeModelStreamPart(
        { type: "text-delta", id: "td-2", text: "" },
        defaultOpts
      );
      expect(result.part.text).toBe("");
    });

    test("converts non-string text to string via asSafeString", () => {
      const result = normalizeModelStreamPart(
        { type: "text-delta", id: "td-3", text: 42 },
        defaultOpts
      );
      expect(result.part.text).toBe("42");
    });

    test("converts object text to JSON string via asSafeString", () => {
      const result = normalizeModelStreamPart(
        { type: "text-delta", id: "td-4", text: { nested: true } },
        defaultOpts
      );
      expect(result.part.text).toBe('{"nested":true}');
    });

    test("handles undefined text as empty string", () => {
      const result = normalizeModelStreamPart(
        { type: "text-delta", id: "td-5" },
        defaultOpts
      );
      expect(result.part.text).toBe("");
    });

    test("omits providerMetadata when absent", () => {
      const result = normalizeModelStreamPart(
        { type: "text-delta", id: "td-6", text: "hi" },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("providerMetadata");
    });
  });

  // 7. text-end
  describe("text-end", () => {
    test("extracts id and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        { type: "text-end", id: "te-1", providerMetadata: { foo: 1 } },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "text_end",
        part: { id: "te-1", providerMetadata: { foo: 1 } },
      });
    });

    test("defaults id to empty string when missing", () => {
      const result = normalizeModelStreamPart(
        { type: "text-end" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
    });
  });

  // 8. reasoning-start
  describe("reasoning-start", () => {
    test("extracts id, mode, and providerMetadata for google (reasoning mode)", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-start", id: "rs-1", providerMetadata: { pm: true } },
        { provider: "google" }
      );
      expect(result).toEqual({
        partType: "reasoning_start",
        part: { id: "rs-1", mode: "reasoning", providerMetadata: { pm: true } },
      });
    });

    test("extracts id, mode, and providerMetadata for anthropic (reasoning mode)", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-start", id: "rs-2" },
        { provider: "anthropic" }
      );
      expect(result.part.mode).toBe("reasoning");
    });

    test("uses summary mode for openai", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-start", id: "rs-3" },
        { provider: "openai" }
      );
      expect(result.part.mode).toBe("summary");
    });

    test("uses summary mode for codex-cli", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-start", id: "rs-4" },
        { provider: "codex-cli" }
      );
      expect(result.part.mode).toBe("summary");
    });

    test("defaults id to empty string", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-start" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
    });
  });

  // 9. reasoning-delta
  describe("reasoning-delta", () => {
    test("extracts id, mode, text, and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        {
          type: "reasoning-delta",
          id: "rd-1",
          text: "thinking...",
          providerMetadata: { step: 1 },
        },
        { provider: "anthropic" }
      );
      expect(result).toEqual({
        partType: "reasoning_delta",
        part: {
          id: "rd-1",
          mode: "reasoning",
          text: "thinking...",
          providerMetadata: { step: 1 },
        },
      });
    });

    test("uses summary mode for openai", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-delta", id: "rd-2", text: "step" },
        { provider: "openai" }
      );
      expect(result.part.mode).toBe("summary");
    });

    test("converts non-string text via asSafeString", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-delta", id: "rd-3", text: 123 },
        defaultOpts
      );
      expect(result.part.text).toBe("123");
    });

    test("handles undefined text as empty string", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-delta", id: "rd-4" },
        defaultOpts
      );
      expect(result.part.text).toBe("");
    });
  });

  // 10. reasoning-end
  describe("reasoning-end", () => {
    test("extracts id, mode, and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-end", id: "re-1", providerMetadata: { done: true } },
        { provider: "google" }
      );
      expect(result).toEqual({
        partType: "reasoning_end",
        part: { id: "re-1", mode: "reasoning", providerMetadata: { done: true } },
      });
    });

    test("uses summary mode for codex-cli", () => {
      const result = normalizeModelStreamPart(
        { type: "reasoning-end", id: "re-2" },
        { provider: "codex-cli" }
      );
      expect(result.part.mode).toBe("summary");
    });
  });

  // 11. tool-input-start
  describe("tool-input-start", () => {
    test("extracts all fields", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-input-start",
          id: "tis-1",
          toolName: "bash",
          providerExecuted: true,
          dynamic: false,
          title: "Running command",
          providerMetadata: { k: "v" },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_input_start",
        part: {
          id: "tis-1",
          toolName: "bash",
          providerExecuted: true,
          dynamic: false,
          title: "Running command",
          providerMetadata: { k: "v" },
        },
      });
    });

    test("defaults id to empty string and toolName to 'tool'", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-start" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
      expect(result.part.toolName).toBe("tool");
    });

    test("omits optional booleans and title when not provided", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-start", id: "tis-2", toolName: "grep" },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("providerExecuted");
      expect(result.part).not.toHaveProperty("dynamic");
      expect(result.part).not.toHaveProperty("title");
    });

    test("ignores non-boolean providerExecuted", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-start", id: "tis-3", toolName: "read", providerExecuted: "yes" },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("providerExecuted");
    });
  });

  // 12. tool-input-delta
  describe("tool-input-delta", () => {
    test("extracts id, delta, and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-input-delta",
          id: "tid-1",
          delta: '{"file":',
          providerMetadata: { chunk: 1 },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_input_delta",
        part: {
          id: "tid-1",
          delta: '{"file":',
          providerMetadata: { chunk: 1 },
        },
      });
    });

    test("converts non-string delta via asSafeString", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-delta", id: "tid-2", delta: 42 },
        defaultOpts
      );
      expect(result.part.delta).toBe("42");
    });

    test("defaults id to empty string", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-delta", delta: "d" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
    });
  });

  // 13. tool-input-end
  describe("tool-input-end", () => {
    test("extracts id and providerMetadata", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-end", id: "tie-1", providerMetadata: { ok: true } },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_input_end",
        part: { id: "tie-1", providerMetadata: { ok: true } },
      });
    });

    test("defaults id to empty string", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-input-end" },
        defaultOpts
      );
      expect(result.part.id).toBe("");
    });
  });

  // 14. tool-call
  describe("tool-call", () => {
    test("extracts all fields with toolCallId", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "bash",
          input: { command: "ls" },
          dynamic: true,
          invalid: false,
          error: null,
          providerMetadata: { region: "us" },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_call",
        part: {
          toolCallId: "tc-1",
          toolName: "bash",
          input: { command: "ls" },
          dynamic: true,
          invalid: false,
          error: null,
          providerMetadata: { region: "us" },
        },
      });
    });

    test("falls back from toolCallId to id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", id: "fallback-id", toolName: "read", input: {} },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("fallback-id");
    });

    test("falls back to empty string when neither toolCallId nor id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", toolName: "read", input: {} },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("");
    });

    test("defaults toolName to 'tool' when missing", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", input: {} },
        defaultOpts
      );
      expect(result.part.toolName).toBe("tool");
    });

    test("defaults input to {} when undefined", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", toolCallId: "tc-2", toolName: "bash" },
        defaultOpts
      );
      expect(result.part.input).toEqual({});
    });

    test("sanitizes input values", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", toolCallId: "tc-3", toolName: "test", input: { a: 1, b: "str" } },
        defaultOpts
      );
      expect(result.part.input).toEqual({ a: 1, b: "str" });
    });

    test("omits optional boolean fields when not present", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", toolCallId: "tc-4", toolName: "test", input: {} },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("dynamic");
      expect(result.part).not.toHaveProperty("invalid");
    });

    test("omits error when undefined", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-call", toolCallId: "tc-5", toolName: "test", input: {} },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("error");
    });
  });

  // 15. tool-result
  describe("tool-result", () => {
    test("extracts all fields with toolCallId", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-result",
          toolCallId: "tr-1",
          toolName: "bash",
          output: "file.txt",
          dynamic: true,
          providerMetadata: { p: 1 },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_result",
        part: {
          toolCallId: "tr-1",
          toolName: "bash",
          output: "file.txt",
          dynamic: true,
          providerMetadata: { p: 1 },
        },
      });
    });

    test("falls back from toolCallId to id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-result", id: "id-1", toolName: "read", output: "ok" },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("id-1");
    });

    test("falls back to empty string when neither toolCallId nor id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-result", toolName: "read", output: "ok" },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("");
    });

    test("defaults output to null when undefined", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-result", toolCallId: "tr-2", toolName: "bash" },
        defaultOpts
      );
      expect(result.part.output).toBeNull();
    });

    test("sanitizes complex output", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-result",
          toolCallId: "tr-3",
          toolName: "test",
          output: { nested: { deep: true } },
        },
        defaultOpts
      );
      expect(result.part.output).toEqual({ nested: { deep: true } });
    });
  });

  // 16. tool-error
  describe("tool-error", () => {
    test("extracts all fields", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-error",
          toolCallId: "te-1",
          toolName: "bash",
          error: "command not found",
          dynamic: true,
          providerMetadata: { x: 1 },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_error",
        part: {
          toolCallId: "te-1",
          toolName: "bash",
          error: "command not found",
          dynamic: true,
          providerMetadata: { x: 1 },
        },
      });
    });

    test("falls back from toolCallId to id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-error", id: "id-err", toolName: "bash", error: "fail" },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("id-err");
    });

    test("falls back to empty string when neither toolCallId nor id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-error", toolName: "bash", error: "fail" },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("");
    });

    test('defaults error to "unknown_error" when undefined', () => {
      const result = normalizeModelStreamPart(
        { type: "tool-error", toolCallId: "te-2", toolName: "bash" },
        defaultOpts
      );
      expect(result.part.error).toBe("unknown_error");
    });

    test("sanitizes Error objects in error field", () => {
      const err = new Error("oops");
      const result = normalizeModelStreamPart(
        { type: "tool-error", toolCallId: "te-3", toolName: "test", error: err },
        defaultOpts
      );
      expect((result.part.error as Record<string, unknown>).name).toBe("Error");
      expect((result.part.error as Record<string, unknown>).message).toBe("oops");
    });
  });

  // 17. tool-output-denied
  describe("tool-output-denied", () => {
    test("extracts all fields with toolCallId", () => {
      const result = normalizeModelStreamPart(
        {
          type: "tool-output-denied",
          toolCallId: "tod-1",
          toolName: "bash",
          reason: "user declined",
          providerMetadata: { r: 1 },
        },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_output_denied",
        part: {
          toolCallId: "tod-1",
          toolName: "bash",
          reason: "user declined",
          providerMetadata: { r: 1 },
        },
      });
    });

    test("falls back from toolCallId to id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-output-denied", id: "id-d", toolName: "bash", reason: "no" },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("id-d");
    });

    test("falls back to empty string when neither toolCallId nor id", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-output-denied", toolName: "bash" },
        defaultOpts
      );
      expect(result.part.toolCallId).toBe("");
    });

    test("omits reason when not provided", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-output-denied", toolCallId: "tod-2", toolName: "bash" },
        defaultOpts
      );
      expect(result.part).not.toHaveProperty("reason");
    });
  });

  // 18. tool-approval-request
  describe("tool-approval-request", () => {
    test("extracts approvalId and toolCall", () => {
      const toolCall = { name: "bash", args: { cmd: "rm -rf /" } };
      const result = normalizeModelStreamPart(
        { type: "tool-approval-request", approvalId: "apr-1", toolCall },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "tool_approval_request",
        part: {
          approvalId: "apr-1",
          toolCall: { name: "bash", args: { cmd: "rm -rf /" } },
        },
      });
    });

    test("defaults approvalId to empty string when missing", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-approval-request", toolCall: { name: "test" } },
        defaultOpts
      );
      expect(result.part.approvalId).toBe("");
    });

    test("defaults toolCall to {} when undefined", () => {
      const result = normalizeModelStreamPart(
        { type: "tool-approval-request", approvalId: "apr-2" },
        defaultOpts
      );
      expect(result.part.toolCall).toEqual({});
    });
  });

  // 19. source
  describe("source", () => {
    test("extracts source payload minus type field", () => {
      const result = normalizeModelStreamPart(
        { type: "source", url: "https://example.com", title: "Example" },
        defaultOpts
      );
      expect(result.partType).toBe("source");
      const src = result.part.source as Record<string, unknown>;
      expect(src.url).toBe("https://example.com");
      expect(src.title).toBe("Example");
      // type should be stripped
      expect(src).not.toHaveProperty("type");
    });

    test("handles source with no extra fields", () => {
      const result = normalizeModelStreamPart(
        { type: "source" },
        defaultOpts
      );
      expect(result.partType).toBe("source");
      expect(result.part.source).toBeDefined();
    });
  });

  // 20. file
  describe("file", () => {
    test("extracts file payload", () => {
      const fileData = { name: "test.txt", content: "hello", mimeType: "text/plain" };
      const result = normalizeModelStreamPart(
        { type: "file", file: fileData },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "file",
        part: { file: { name: "test.txt", content: "hello", mimeType: "text/plain" } },
      });
    });

    test("defaults file to null when undefined", () => {
      const result = normalizeModelStreamPart(
        { type: "file" },
        defaultOpts
      );
      expect(result.part.file).toBeNull();
    });
  });

  // 21. raw
  describe("raw", () => {
    test("uses rawValue field when present", () => {
      const result = normalizeModelStreamPart(
        { type: "raw", rawValue: { data: "payload" } },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "raw",
        part: { raw: { data: "payload" } },
      });
    });

    test("falls back to raw field when rawValue not present", () => {
      const result = normalizeModelStreamPart(
        { type: "raw", raw: { fallback: true } },
        defaultOpts
      );
      expect(result).toEqual({
        partType: "raw",
        part: { raw: { fallback: true } },
      });
    });

    test("defaults to null when neither rawValue nor raw present", () => {
      const result = normalizeModelStreamPart(
        { type: "raw" },
        defaultOpts
      );
      expect(result.part.raw).toBeNull();
    });

    test("prefers rawValue over raw when both present", () => {
      const result = normalizeModelStreamPart(
        { type: "raw", rawValue: "primary", raw: "secondary" },
        defaultOpts
      );
      expect(result.part.raw).toBe("primary");
    });
  });

  // 22. default (unknown type)
  describe("default (unknown type)", () => {
    test("returns unknown partType with sdkType and raw", () => {
      const result = normalizeModelStreamPart(
        { type: "some-future-type", data: 42 },
        defaultOpts
      );
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("some-future-type");
      expect(result.part.raw).toBeDefined();
    });

    test("preserves the original type string as sdkType", () => {
      const result = normalizeModelStreamPart(
        { type: "new-feature" },
        defaultOpts
      );
      expect(result.part.sdkType).toBe("new-feature");
    });
  });

  // 23. Non-object input
  describe("non-object input", () => {
    test("returns unknown for string input", () => {
      const result = normalizeModelStreamPart("not an object" as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("string");
    });

    test("returns unknown for number input", () => {
      const result = normalizeModelStreamPart(42 as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("number");
    });

    test("returns unknown for null input", () => {
      const result = normalizeModelStreamPart(null as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      // typeof null === "object" but null !== null is false, so falls to typeof raw = "object"
      expect(result.part.sdkType).toBe("object");
    });

    test("returns unknown for undefined input", () => {
      const result = normalizeModelStreamPart(undefined as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("undefined");
    });

    test("returns unknown for boolean input", () => {
      const result = normalizeModelStreamPart(true as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("boolean");
    });

    test("returns unknown for array input (object without type)", () => {
      const result = normalizeModelStreamPart([1, 2, 3] as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      // Array is an object but typeof is "object"
      expect(result.part.sdkType).toBe("invalid");
    });

    test("returns unknown for object without type field", () => {
      const result = normalizeModelStreamPart({ foo: "bar" } as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("invalid");
    });

    test("returns unknown for object with non-string type field", () => {
      const result = normalizeModelStreamPart({ type: 42 } as any, defaultOpts);
      expect(result.partType).toBe("unknown");
      expect(result.part.sdkType).toBe("invalid");
    });
  });
});

// ---------------------------------------------------------------------------
// includeRawPart option
// ---------------------------------------------------------------------------
describe("includeRawPart option", () => {
  test("does not include rawPart when includeRawPart is false", () => {
    const result = normalizeModelStreamPart(
      { type: "start" },
      { provider: "google", includeRawPart: false }
    );
    expect(result).not.toHaveProperty("rawPart");
  });

  test("does not include rawPart when includeRawPart is omitted (defaults false)", () => {
    const result = normalizeModelStreamPart(
      { type: "start" },
      { provider: "google" }
    );
    expect(result).not.toHaveProperty("rawPart");
  });

  test("includes rawPart when includeRawPart is true on start", () => {
    const result = normalizeModelStreamPart(
      { type: "start" },
      { provider: "google", includeRawPart: true }
    );
    expect(result).toHaveProperty("rawPart");
    expect(result.rawPart).toEqual({ type: "start" });
  });

  test("includes rawPart when includeRawPart is true on text-delta", () => {
    const raw = { type: "text-delta", id: "t1", text: "hello" };
    const result = normalizeModelStreamPart(raw, {
      provider: "google",
      includeRawPart: true,
    });
    expect(result.rawPart).toEqual({ type: "text-delta", id: "t1", text: "hello" });
  });

  test("includes rawPart when includeRawPart is true on finish", () => {
    const raw = {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 10, outputTokens: 5 },
    };
    const result = normalizeModelStreamPart(raw, {
      provider: "google",
      includeRawPart: true,
    });
    expect(result.rawPart).toEqual({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  test("includes rawPart on non-object input when includeRawPart is true", () => {
    const result = normalizeModelStreamPart("raw_string" as any, {
      provider: "google",
      includeRawPart: true,
    });
    expect(result.rawPart).toBe("raw_string");
  });

  test("includes rawPart on unknown type when includeRawPart is true", () => {
    const raw = { type: "future-type", data: 123 };
    const result = normalizeModelStreamPart(raw, {
      provider: "google",
      includeRawPart: true,
    });
    expect(result.rawPart).toEqual({ type: "future-type", data: 123 });
  });
});

// ---------------------------------------------------------------------------
// sanitizeUnknown behavior (tested indirectly through normalizeModelStreamPart)
// ---------------------------------------------------------------------------
describe("sanitizeUnknown via normalizeModelStreamPart", () => {
  test("truncates long strings in input", () => {
    const longString = "x".repeat(5000);
    const result = normalizeModelStreamPart(
      { type: "tool-call", toolCallId: "tc-s1", toolName: "test", input: { data: longString } },
      defaultOpts
    );
    const input = result.part.input as Record<string, unknown>;
    const data = input.data as string;
    expect(data.length).toBeLessThan(5000);
    expect(data).toContain("[truncated");
  });

  test("handles circular references in input", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = normalizeModelStreamPart(
      { type: "tool-call", toolCallId: "tc-s2", toolName: "test", input: obj },
      defaultOpts
    );
    const input = result.part.input as Record<string, unknown>;
    expect(input.a).toBe(1);
    expect(input.self).toBe("[circular]");
  });

  test("handles Error objects in error field", () => {
    const err = new TypeError("type mismatch");
    const result = normalizeModelStreamPart(
      { type: "error", error: err },
      defaultOpts
    );
    const sanitizedErr = result.part.error as Record<string, unknown>;
    expect(sanitizedErr.name).toBe("TypeError");
    expect(sanitizedErr.message).toBe("type mismatch");
  });

  test("handles Date objects", () => {
    const date = new Date("2024-01-01T00:00:00.000Z");
    const result = normalizeModelStreamPart(
      { type: "tool-call", toolCallId: "tc-s3", toolName: "test", input: { ts: date } },
      defaultOpts
    );
    const input = result.part.input as Record<string, unknown>;
    expect(input.ts).toBe("2024-01-01T00:00:00.000Z");
  });

  test("handles non-finite numbers", () => {
    const result = normalizeModelStreamPart(
      {
        type: "tool-call",
        toolCallId: "tc-s4",
        toolName: "test",
        input: { inf: Infinity, nan: NaN, neg: -Infinity },
      },
      defaultOpts
    );
    const input = result.part.input as Record<string, unknown>;
    expect(input.inf).toBe("Infinity");
    expect(input.nan).toBe("NaN");
    expect(input.neg).toBe("-Infinity");
  });

  test("handles bigint values", () => {
    const result = normalizeModelStreamPart(
      {
        type: "tool-call",
        toolCallId: "tc-s5",
        toolName: "test",
        input: { big: BigInt(12345678901234) },
      },
      defaultOpts
    );
    const input = result.part.input as Record<string, unknown>;
    expect(input.big).toBe("12345678901234");
  });
});

// ---------------------------------------------------------------------------
// toolCallId fallback chain
// ---------------------------------------------------------------------------
describe("toolCallId fallback chain", () => {
  const toolTypes = ["tool-call", "tool-result", "tool-error", "tool-output-denied"] as const;

  for (const type of toolTypes) {
    describe(type, () => {
      test("prefers toolCallId over id", () => {
        const result = normalizeModelStreamPart(
          { type, toolCallId: "preferred", id: "fallback", toolName: "test", input: {}, output: "ok", error: "err", reason: "r" },
          defaultOpts
        );
        expect(result.part.toolCallId).toBe("preferred");
      });

      test("falls back to id when toolCallId is absent", () => {
        const result = normalizeModelStreamPart(
          { type, id: "only-id", toolName: "test", input: {}, output: "ok", error: "err", reason: "r" },
          defaultOpts
        );
        expect(result.part.toolCallId).toBe("only-id");
      });

      test("falls back to empty string when both are absent", () => {
        const result = normalizeModelStreamPart(
          { type, toolName: "test", input: {}, output: "ok", error: "err", reason: "r" },
          defaultOpts
        );
        expect(result.part.toolCallId).toBe("");
      });
    });
  }
});
