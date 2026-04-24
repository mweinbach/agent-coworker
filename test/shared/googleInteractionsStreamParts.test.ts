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
