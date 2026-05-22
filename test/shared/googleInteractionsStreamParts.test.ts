import { describe, expect, test } from "bun:test";

import {
  mapGoogleInteractionsEventToStreamParts,
  processGoogleInteractionsStreamEvent,
} from "../../src/shared/googleInteractionsStreamParts";

describe("googleInteractionsStreamParts", () => {
  test("preserves thought summaries that arrive before thought start", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "Buffered reasoning." } },
      },
      contentBlocks,
      providerToolCallsById,
    );
    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_signature", signature: "sig_buffered" },
      },
      contentBlocks,
      providerToolCallsById,
    );
    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "thought" },
      },
      contentBlocks,
      providerToolCallsById,
    );

    expect(contentBlocks.get(0)).toEqual({
      type: "thinking",
      thinking: "Buffered reasoning.",
      thinkingSignature: "sig_buffered",
    });
  });

  test("preserves SDK text_annotation deltas on final text-end parts", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "text" },
      },
      contentBlocks,
      providerToolCallsById,
    );
    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: "Cited answer" },
      },
      contentBlocks,
      providerToolCallsById,
    );
    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "text_annotation",
          annotations: [{ type: "url_citation", url: "https://example.com" }],
        },
      },
      contentBlocks,
      providerToolCallsById,
    );

    expect(contentBlocks.get(0)).toEqual({
      type: "text",
      text: "Cited answer",
      annotations: [{ type: "url_citation", url: "https://example.com" }],
    });
    expect(
      mapGoogleInteractionsEventToStreamParts(
        { event_type: "content.stop", index: 0 },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "text-end",
        id: "s0",
        annotations: [{ type: "url_citation", url: "https://example.com" }],
      },
    ]);
  });

  test("treats SDK v2 model_output blocks as assistant text", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "step.start",
      index: 1,
      step: { type: "model_output" },
    };
    processGoogleInteractionsStreamEvent(startEvent, contentBlocks, providerToolCallsById);
    expect(
      mapGoogleInteractionsEventToStreamParts(startEvent, contentBlocks, providerToolCallsById),
    ).toEqual([{ type: "text-start", id: "s1" }]);

    const deltaEvent = {
      event_type: "step.delta",
      index: 1,
      delta: { type: "text", text: "Final answer." },
    };
    processGoogleInteractionsStreamEvent(deltaEvent, contentBlocks, providerToolCallsById);

    expect(contentBlocks.get(1)).toEqual({ type: "text", text: "Final answer." });
    expect(
      mapGoogleInteractionsEventToStreamParts(deltaEvent, contentBlocks, providerToolCallsById),
    ).toEqual([{ type: "text-delta", id: "s1", text: "Final answer." }]);
    expect(
      mapGoogleInteractionsEventToStreamParts(
        { event_type: "step.stop", index: 1 },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([{ type: "text-end", id: "s1" }]);
  });

  test("emits thought summaries included on SDK content.start blocks", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();
    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "thought",
        signature: "sig_start",
        summary: [{ type: "text", text: "Initial reasoning." }],
      },
    };

    processGoogleInteractionsStreamEvent(startEvent, contentBlocks, providerToolCallsById);

    expect(contentBlocks.get(0)).toEqual({
      type: "thinking",
      thinking: "Initial reasoning.",
      thinkingSignature: "sig_start",
    });
    expect(
      mapGoogleInteractionsEventToStreamParts(startEvent, contentBlocks, providerToolCallsById),
    ).toEqual([
      { type: "reasoning-start", id: "s0" },
      { type: "reasoning-delta", id: "s0", text: "Initial reasoning." },
    ]);
  });

  test("maps SDK v2 step events and arguments deltas", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "step.start",
      index: 0,
      step: {
        type: "function_call",
        id: "call_v2",
        name: "bash",
        arguments: {},
      },
    };
    processGoogleInteractionsStreamEvent(startEvent, contentBlocks, providerToolCallsById);
    expect(
      mapGoogleInteractionsEventToStreamParts(startEvent, contentBlocks, providerToolCallsById),
    ).toEqual([{ type: "tool-input-start", id: "call_v2", toolName: "bash" }]);

    const deltaEvent = {
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: '{"command":"pwd"}' },
    };
    processGoogleInteractionsStreamEvent(deltaEvent, contentBlocks, providerToolCallsById);
    expect(contentBlocks.get(0)).toEqual({
      type: "toolCall",
      id: "call_v2",
      name: "bash",
      arguments: { command: "pwd" },
    });
    expect(
      mapGoogleInteractionsEventToStreamParts(deltaEvent, contentBlocks, providerToolCallsById),
    ).toEqual([{ type: "tool-input-delta", id: "call_v2", delta: '{"command":"pwd"}' }]);
    expect(
      mapGoogleInteractionsEventToStreamParts(
        { event_type: "step.stop", index: 0 },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "call_v2" },
      { type: "tool-call", toolCallId: "call_v2", toolName: "bash", input: { command: "pwd" } },
    ]);
  });

  test("keeps the first emitted function_call id stable during replay projection", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "function_call",
        name: "bash",
      },
    };
    processGoogleInteractionsStreamEvent(startEvent, contentBlocks, providerToolCallsById);

    const startBlock = contentBlocks.get(0);
    expect(startBlock).toBeDefined();
    expect(startBlock.type).toBe("toolCall");
    const fallbackId = startBlock.id;

    expect(
      mapGoogleInteractionsEventToStreamParts(startEvent, contentBlocks, providerToolCallsById),
    ).toEqual([{ type: "tool-input-start", id: fallbackId, toolName: "bash" }]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "function_call",
        id: "call_real",
        arguments: { command: "ls" },
      },
    };
    processGoogleInteractionsStreamEvent(deltaEvent, contentBlocks, providerToolCallsById);

    const block = contentBlocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe(fallbackId);
    expect(block.arguments).toEqual({ command: "ls" });

    expect(
      mapGoogleInteractionsEventToStreamParts(deltaEvent, contentBlocks, providerToolCallsById),
    ).toEqual([{ type: "tool-input-delta", id: fallbackId, delta: '{"command":"ls"}' }]);

    expect(
      mapGoogleInteractionsEventToStreamParts(
        { event_type: "content.stop", index: 0 },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([
      { type: "tool-input-end", id: fallbackId },
      { type: "tool-call", toolCallId: fallbackId, toolName: "bash", input: { command: "ls" } },
    ]);
  });

  test("keeps the first emitted native provider tool id stable during replay projection", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "google_search_call",
      },
    };
    processGoogleInteractionsStreamEvent(startEvent, contentBlocks, providerToolCallsById);

    const startBlock = contentBlocks.get(0);
    expect(startBlock).toBeDefined();
    expect(startBlock.type).toBe("providerToolCall");
    const fallbackId = startBlock.id;

    expect(
      mapGoogleInteractionsEventToStreamParts(startEvent, contentBlocks, providerToolCallsById),
    ).toEqual([
      {
        type: "tool-input-start",
        id: fallbackId,
        toolName: "nativeWebSearch",
        providerExecuted: true,
      },
    ]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "google_search_call",
        id: "gs_real",
        arguments: { queries: ["latest Gemini announcements"] },
      },
    };
    processGoogleInteractionsStreamEvent(deltaEvent, contentBlocks, providerToolCallsById);

    const block = contentBlocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("providerToolCall");
    expect(block.id).toBe(fallbackId);
    expect(block.arguments).toEqual({ queries: ["latest Gemini announcements"] });

    expect(
      mapGoogleInteractionsEventToStreamParts(deltaEvent, contentBlocks, providerToolCallsById),
    ).toEqual([
      {
        type: "tool-input-delta",
        id: fallbackId,
        delta: '{"queries":["latest Gemini announcements"]}',
      },
    ]);

    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_real",
          result: [{ search_suggestions: "Latest Gemini announcements" }],
        },
      },
      contentBlocks,
      providerToolCallsById,
    );

    expect(
      mapGoogleInteractionsEventToStreamParts(
        { event_type: "content.stop", index: 1 },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: fallbackId,
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: fallbackId,
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          raw: [{ search_suggestions: "Latest Gemini announcements" }],
        },
        providerExecuted: true,
      },
    ]);
  });

  test("replay ignores native code execution blocks", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "code_execution_call",
      },
    };
    processGoogleInteractionsStreamEvent(startEvent, contentBlocks, providerToolCallsById);

    expect(contentBlocks.get(0)).toBeUndefined();
    expect(
      mapGoogleInteractionsEventToStreamParts(startEvent, contentBlocks, providerToolCallsById),
    ).toEqual([]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "code_execution_call",
        id: "code_real",
        arguments: { code: "print(6 * 7)", language: "python" },
      },
    };
    processGoogleInteractionsStreamEvent(deltaEvent, contentBlocks, providerToolCallsById);

    expect(contentBlocks.get(0)).toBeUndefined();
    expect(
      mapGoogleInteractionsEventToStreamParts(deltaEvent, contentBlocks, providerToolCallsById),
    ).toEqual([]);

    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "code_execution_result",
          call_id: "code_real",
          result: "42\n",
        },
      },
      contentBlocks,
      providerToolCallsById,
    );

    expect(
      mapGoogleInteractionsEventToStreamParts(
        { event_type: "content.stop", index: 1 },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([]);
  });

  test("preserves singleton native URL context result objects", () => {
    const contentBlocks = new Map();
    const providerToolCallsById = new Map();

    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "url_context_call",
          id: "uc_shared_1",
          arguments: { urls: ["https://example.com"] },
        },
      },
      contentBlocks,
      providerToolCallsById,
    );

    processGoogleInteractionsStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "url_context_result",
          call_id: "uc_shared_1",
          result: { url: "https://example.com", status: "ok" },
        },
      },
      contentBlocks,
      providerToolCallsById,
    );

    expect(
      mapGoogleInteractionsEventToStreamParts(
        {
          event_type: "content.stop",
          index: 1,
        },
        contentBlocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "uc_shared_1",
        toolName: "nativeUrlContext",
        output: {
          provider: "google",
          status: "completed",
          callId: "uc_shared_1",
          urls: ["https://example.com"],
          results: [{ url: "https://example.com", status: "ok" }],
          raw: { url: "https://example.com", status: "ok" },
        },
        providerExecuted: true,
      },
    ]);
  });
});
