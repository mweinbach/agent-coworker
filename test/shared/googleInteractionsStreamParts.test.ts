import { describe, expect, test } from "bun:test";

import {
  mapGoogleInteractionsEventToStreamParts,
  processGoogleInteractionsStreamEvent,
} from "../../src/shared/googleInteractionsStreamParts";

describe("googleInteractionsStreamParts", () => {
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

    expect(mapGoogleInteractionsEventToStreamParts(
      {
        event_type: "content.stop",
        index: 1,
      },
      contentBlocks,
      providerToolCallsById,
    )).toEqual([
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
