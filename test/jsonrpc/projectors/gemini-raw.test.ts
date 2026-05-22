import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { googleRaw, sessionId, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("notification projector replays raw Gemini search tool items and drops aggregate final reasoning duplicates", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle(googleRaw(0, { event_type: "interaction.start" }));
    projector.handle(
      googleRaw(1, { event_type: "content.start", index: 0, content: { type: "thought" } }),
    );
    projector.handle(
      googleRaw(2, {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "First pass." } },
      }),
    );
    projector.handle(googleRaw(3, { event_type: "content.stop", index: 0 }));
    projector.handle(
      googleRaw(4, {
        event_type: "content.start",
        index: 1,
        content: { type: "google_search_call", id: "search-call" },
      }),
    );
    projector.handle(
      googleRaw(5, {
        event_type: "content.delta",
        index: 1,
        delta: {
          type: "google_search_call",
          id: "search-call",
          arguments: { queries: ["Project Hail Mary movie reviews"] },
        },
      }),
    );
    projector.handle(googleRaw(6, { event_type: "content.stop", index: 1 }));
    projector.handle(
      googleRaw(7, {
        event_type: "content.start",
        index: 2,
        content: {
          type: "google_search_result",
          call_id: "search-call",
          result: {
            results: [{ title: "MovieWeb" }],
            sources: [{ url: "https://example.com/review" }],
          },
        },
      }),
    );
    projector.handle(googleRaw(8, { event_type: "content.stop", index: 2 }));
    projector.handle(
      googleRaw(9, { event_type: "content.start", index: 3, content: { type: "thought" } }),
    );
    projector.handle(
      googleRaw(10, {
        event_type: "content.delta",
        index: 3,
        delta: { type: "thought_summary", content: { type: "text", text: "Second pass." } },
      }),
    );
    projector.handle(googleRaw(11, { event_type: "content.stop", index: 3 }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "reasoning",
      text: "First pass.\n\nSecond pass.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const completedReasoning = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning")
      .map((message) => String(message.params?.item?.text ?? ""));
    expect(completedReasoning).toEqual(["First pass.", "Second pass."]);

    const toolStarted = outbound
      .filter((message) => message.method === "item/started")
      .filter((message) => message.params?.item?.type === "toolCall");
    const toolCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "toolCall");
    const toolOutputAvailable = toolCompleted.filter(
      (message) => message.params?.item?.state === "output-available",
    );

    expect(toolStarted).toHaveLength(1);
    expect(toolCompleted.map((message) => message.params?.item?.state)).toEqual([
      "input-available",
      "output-available",
    ]);
    expect(toolStarted[0]?.params?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "input-streaming",
    });
    expect(toolOutputAvailable).toHaveLength(1);
    expect(toolOutputAvailable[0]?.params?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Project Hail Mary movie reviews"] },
      result: {
        provider: "google",
        status: "completed",
        queries: ["Project Hail Mary movie reviews"],
        results: [{ title: "MovieWeb" }],
        sources: [{ url: "https://example.com/review" }],
      },
    });
  });

  test("journal projector replays raw Gemini search tool items and drops aggregate final reasoning duplicates", () => {
    const emissions: Array<{ eventType: string; payload: any }> = [];
    const projector = createThreadJournalNotificationProjector({
      threadId: sessionId,
      emit: (event) => emissions.push({ eventType: event.eventType, payload: event.payload }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle(googleRaw(0, { event_type: "interaction.start" }));
    projector.handle(
      googleRaw(1, { event_type: "content.start", index: 0, content: { type: "thought" } }),
    );
    projector.handle(
      googleRaw(2, {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "First pass." } },
      }),
    );
    projector.handle(googleRaw(3, { event_type: "content.stop", index: 0 }));
    projector.handle(
      googleRaw(4, {
        event_type: "content.start",
        index: 1,
        content: { type: "google_search_call", id: "search-call" },
      }),
    );
    projector.handle(
      googleRaw(5, {
        event_type: "content.delta",
        index: 1,
        delta: {
          type: "google_search_call",
          id: "search-call",
          arguments: { queries: ["Project Hail Mary movie reviews"] },
        },
      }),
    );
    projector.handle(googleRaw(6, { event_type: "content.stop", index: 1 }));
    projector.handle(
      googleRaw(7, {
        event_type: "content.start",
        index: 2,
        content: {
          type: "google_search_result",
          call_id: "search-call",
          result: {
            results: [{ title: "MovieWeb" }],
            sources: [{ url: "https://example.com/review" }],
          },
        },
      }),
    );
    projector.handle(googleRaw(8, { event_type: "content.stop", index: 2 }));
    projector.handle(
      googleRaw(9, { event_type: "content.start", index: 3, content: { type: "thought" } }),
    );
    projector.handle(
      googleRaw(10, {
        event_type: "content.delta",
        index: 3,
        delta: { type: "thought_summary", content: { type: "text", text: "Second pass." } },
      }),
    );
    projector.handle(googleRaw(11, { event_type: "content.stop", index: 3 }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "reasoning",
      text: "First pass.\n\nSecond pass.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const completedReasoning = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "reasoning")
      .map((event) => String(event.payload?.item?.text ?? ""));
    expect(completedReasoning).toEqual(["First pass.", "Second pass."]);

    const toolStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "toolCall");
    const toolCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "toolCall");
    const toolOutputAvailable = toolCompleted.filter(
      (event) => event.payload?.item?.state === "output-available",
    );

    expect(toolStarted).toHaveLength(1);
    expect(toolCompleted.map((event) => event.payload?.item?.state)).toEqual([
      "input-available",
      "output-available",
    ]);
    expect(toolStarted[0]?.payload?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "input-streaming",
    });
    expect(toolOutputAvailable).toHaveLength(1);
    expect(toolOutputAvailable[0]?.payload?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Project Hail Mary movie reviews"] },
      result: {
        provider: "google",
        status: "completed",
        queries: ["Project Hail Mary movie reviews"],
        results: [{ title: "MovieWeb" }],
        sources: [{ url: "https://example.com/review" }],
      },
    });
  });

  test("projectors fail unfinished raw Gemini tool inputs when a turn errors", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const emissions: Array<{ eventType: string; payload: any }> = [];
    const live = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });
    const journal = createThreadJournalNotificationProjector({
      threadId: sessionId,
      emit: (event) => emissions.push({ eventType: event.eventType, payload: event.payload }),
    });

    for (const projector of [live, journal] as const) {
      projector.handle({
        type: "session_busy",
        sessionId,
        busy: true,
        turnId,
        cause: "user_message",
      });
      projector.handle(
        googleRaw(0, {
          event_type: "step.start",
          index: 0,
          step: { type: "function_call", id: "call_read", name: "read" },
        }),
      );
      projector.handle(
        googleRaw(1, {
          event_type: "step.delta",
          index: 0,
          delta: {
            type: "arguments_delta",
            arguments: '{"path":"audio.mp3","limit":100}',
          },
        }),
      );
      projector.handle({
        type: "error",
        sessionId,
        message: "Gemini generated response exceeded the provider size limit.",
        code: "provider_error",
        source: "provider",
      });
      projector.handle({
        type: "session_busy",
        sessionId,
        busy: false,
        turnId,
        outcome: "error",
      });
    }

    const liveFailedTool = outbound
      .filter((message) => message.method === "item/completed")
      .find(
        (message) =>
          message.params?.item?.type === "toolCall" &&
          message.params?.item?.state === "output-error",
      );
    expect(liveFailedTool?.params?.item).toMatchObject({
      id: `toolCall:${turnId}:call_read`,
      type: "toolCall",
      toolName: "read",
      state: "output-error",
      args: { path: "audio.mp3", limit: 100 },
      result: { error: "Gemini generated response exceeded the provider size limit." },
    });

    const journalFailedTool = emissions
      .filter((event) => event.eventType === "item/completed")
      .find(
        (event) =>
          event.payload?.item?.type === "toolCall" && event.payload?.item?.state === "output-error",
      );
    expect(journalFailedTool?.payload?.item).toMatchObject({
      id: `toolCall:${turnId}:call_read`,
      type: "toolCall",
      toolName: "read",
      state: "output-error",
      args: { path: "audio.mp3", limit: 100 },
      result: { error: "Gemini generated response exceeded the provider size limit." },
    });
  });
});
