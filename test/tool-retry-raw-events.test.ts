import { describe, expect, test } from "bun:test";

import type { ModelStreamRawEvent } from "../src/shared/modelStream";
import { digestToolInput } from "../src/shared/toolInputDigestHasher";
import { createToolRetryAttemptTracker } from "../src/shared/toolRetryAttempts";
import { createRawToolRetryEventTracker } from "../src/shared/toolRetryRawEvents";

function rawEvent(
  format: ModelStreamRawEvent["format"],
  index: number,
  event: Record<string, unknown>,
): ModelStreamRawEvent {
  return {
    type: "model_stream_raw",
    sessionId: "session",
    turnId: "turn",
    index,
    provider: format === "google-interactions-v1" ? "google" : "openai",
    model: format === "google-interactions-v1" ? "gemini-3.5-pro" : "gpt-5.4",
    format,
    normalizerVersion: 1,
    event,
  };
}

describe("raw provider tool retry tracking", () => {
  test("matches complete OpenAI raw arguments without using truncated normalized input", () => {
    const sharedPrefix = "x".repeat(64_000);
    const args = { path: "report.txt", content: `${sharedPrefix}expected` };
    const inputDigest = digestToolInput("write", args);
    if (!inputDigest) throw new Error("expected input digest");
    const tracker = createRawToolRetryEventTracker(
      createToolRetryAttemptTracker({
        targets: [{ itemId: "failed-write", inputDigest }],
      }),
    );
    const toolKey = "call_1|item_1";

    expect(
      tracker.track(
        rawEvent("openai-responses-v1", 0, {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "write",
            arguments: "",
          },
        }),
      ).metadata,
    ).toEqual([]);
    tracker.track(
      rawEvent("openai-responses-v1", 1, {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: JSON.stringify(args),
      }),
    );
    const done = tracker.track(
      rawEvent("openai-responses-v1", 2, {
        type: "response.function_call_arguments.done",
        item_id: "item_1",
        arguments: JSON.stringify(args),
      }),
    );

    expect(done.metadata).toEqual([
      {
        toolKey,
        toolName: "write",
        inputDigest,
        retryOf: "failed-write",
      },
    ]);
  });

  test("does not match a large OpenAI argument that differs after a shared prefix", () => {
    const sharedPrefix = "x".repeat(64_000);
    const expected = { content: `${sharedPrefix}a` };
    const actual = { content: `${sharedPrefix}b` };
    const inputDigest = digestToolInput("write", expected);
    if (!inputDigest) throw new Error("expected input digest");
    const tracker = createRawToolRetryEventTracker(
      createToolRetryAttemptTracker({
        targets: [{ itemId: "failed-write", inputDigest }],
      }),
    );

    tracker.track(
      rawEvent("openai-responses-v1", 0, {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: "write",
          arguments: "",
        },
      }),
    );
    const done = tracker.track(
      rawEvent("openai-responses-v1", 1, {
        type: "response.function_call_arguments.done",
        item_id: "item_1",
        arguments: JSON.stringify(actual),
      }),
    );

    expect(done.metadata[0]).toMatchObject({
      toolKey: "call_1|item_1",
      toolName: "write",
      inputDigest: digestToolInput("write", actual),
    });
    expect(done.metadata[0]).not.toHaveProperty("retryOf");
  });

  test("matches a complete OpenAI output item without relying on incremental chunks", () => {
    const args = { command: "bun test" };
    const inputDigest = digestToolInput("bash", args);
    if (!inputDigest) throw new Error("expected input digest");
    const tracker = createRawToolRetryEventTracker(
      createToolRetryAttemptTracker({
        targets: [{ itemId: "failed-command", inputDigest }],
      }),
    );

    expect(
      tracker.track(
        rawEvent("openai-responses-v1", 0, {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_complete",
            call_id: "call_complete",
            name: "bash",
            arguments: JSON.stringify(args),
          },
        }),
      ).metadata,
    ).toEqual([
      {
        toolKey: "call_complete|item_complete",
        toolName: "bash",
        inputDigest,
        retryOf: "failed-command",
      },
    ]);
  });

  test("consumes an OpenAI native tool target only after its successful raw result", () => {
    const args = {
      action: {
        type: "search",
        query: "current OpenAI release",
      },
    };
    const inputDigest = digestToolInput("nativeWebSearch", args);
    if (!inputDigest) throw new Error("expected input digest");
    const tracker = createRawToolRetryEventTracker(
      createToolRetryAttemptTracker({
        targets: [{ itemId: "failed-search", inputDigest }],
      }),
    );
    const start = (index: number, id: string) =>
      tracker.track(
        rawEvent("openai-responses-v1", index, {
          type: "response.output_item.added",
          item: {
            type: "web_search_call",
            id,
            status: "in_progress",
            action: args.action,
          },
        }),
      );

    expect(start(0, "search-1").metadata).toEqual([
      {
        toolKey: "search-1",
        toolName: "nativeWebSearch",
        inputDigest,
        retryOf: "failed-search",
      },
    ]);
    tracker.track(
      rawEvent("openai-responses-v1", 1, {
        type: "response.output_item.done",
        item: {
          type: "web_search_call",
          id: "search-1",
          status: "completed",
          action: args.action,
        },
      }),
    );
    expect(start(2, "search-2").metadata[0]).not.toHaveProperty("retryOf");
  });

  test("matches Google custom tool arguments assembled by the raw replay adapter", () => {
    const args = { url: "https://example.com/report" };
    const inputDigest = digestToolInput("webFetch", args);
    if (!inputDigest) throw new Error("expected input digest");
    const tracker = createRawToolRetryEventTracker(
      createToolRetryAttemptTracker({
        targets: [{ itemId: "failed-fetch", inputDigest }],
      }),
    );

    tracker.track(
      rawEvent("google-interactions-v1", 0, {
        event_type: "content.delta",
        index: 3,
        delta: {
          type: "function_call",
          id: "fetch-1",
          name: "webFetch",
          arguments: args,
        },
      }),
    );
    expect(
      tracker.track(
        rawEvent("google-interactions-v1", 1, {
          event_type: "content.stop",
          index: 3,
        }),
      ).metadata,
    ).toEqual([
      {
        toolKey: "fetch-1",
        toolName: "webFetch",
        inputDigest,
        retryOf: "failed-fetch",
      },
    ]);
  });

  test("keeps Google provider-executed targets retryable until a successful result", () => {
    const args = { queries: ["current Gemini release"] };
    const inputDigest = digestToolInput("nativeWebSearch", args);
    if (!inputDigest) throw new Error("expected input digest");
    const attempts = createToolRetryAttemptTracker({
      targets: [{ itemId: "failed-search", inputDigest }],
    });
    const tracker = createRawToolRetryEventTracker(attempts);

    const startAttempt = (interaction: string, index: number) => {
      tracker.track(
        rawEvent("google-interactions-v1", index, {
          event_type: "interaction.created",
          interaction: { id: interaction },
        }),
      );
      tracker.track(
        rawEvent("google-interactions-v1", index + 1, {
          event_type: "content.start",
          index: 0,
          content: {
            type: "google_search_call",
            id: `search-${interaction}`,
            arguments: args,
          },
        }),
      );
      return tracker.track(
        rawEvent("google-interactions-v1", index + 2, {
          event_type: "content.stop",
          index: 0,
        }),
      );
    };

    const failedAttempt = startAttempt("failed-attempt", 0);
    expect(failedAttempt.metadata).toEqual([
      {
        toolKey: "search-failed-attempt",
        toolName: "nativeWebSearch",
        inputDigest,
        retryOf: "failed-search",
      },
    ]);
    tracker.track(
      rawEvent("google-interactions-v1", 3, {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "search-failed-attempt",
          result: { error: "provider failed" },
          is_error: true,
        },
      }),
    );
    tracker.track(
      rawEvent("google-interactions-v1", 4, {
        event_type: "content.stop",
        index: 1,
      }),
    );

    expect(startAttempt("successful-attempt", 5).metadata).toEqual([
      {
        toolKey: "search-successful-attempt",
        toolName: "nativeWebSearch",
        inputDigest,
        retryOf: "failed-search",
      },
    ]);
    tracker.track(
      rawEvent("google-interactions-v1", 8, {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "search-successful-attempt",
          result: { results: [{ title: "Gemini" }] },
        },
      }),
    );
    tracker.track(
      rawEvent("google-interactions-v1", 9, {
        event_type: "content.stop",
        index: 1,
      }),
    );

    expect(startAttempt("after-success", 10).metadata[0]).not.toHaveProperty("retryOf");
  });

  test("tracks Google native URL context input sequences", () => {
    const args = { urls: ["https://example.com/docs"] };
    const inputDigest = digestToolInput("nativeUrlContext", args);
    if (!inputDigest) throw new Error("expected input digest");
    const tracker = createRawToolRetryEventTracker(
      createToolRetryAttemptTracker({
        targets: [{ itemId: "failed-url-context", inputDigest }],
      }),
    );

    tracker.track(
      rawEvent("google-interactions-v1", 0, {
        event_type: "content.start",
        index: 2,
        content: {
          type: "url_context_call",
          id: "url-context-1",
          arguments: {},
        },
      }),
    );
    tracker.track(
      rawEvent("google-interactions-v1", 1, {
        event_type: "content.delta",
        index: 2,
        delta: {
          type: "arguments_delta",
          arguments: '{"urls":["https://example.com/',
        },
      }),
    );
    tracker.track(
      rawEvent("google-interactions-v1", 2, {
        event_type: "content.delta",
        index: 2,
        delta: {
          type: "arguments_delta",
          arguments: 'docs"]}',
        },
      }),
    );
    expect(
      tracker.track(
        rawEvent("google-interactions-v1", 3, {
          event_type: "content.stop",
          index: 2,
        }),
      ).metadata,
    ).toEqual([
      {
        toolKey: "url-context-1",
        toolName: "nativeUrlContext",
        inputDigest,
        retryOf: "failed-url-context",
      },
    ]);
  });
});
