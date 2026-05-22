import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { sessionId, streamChunk, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("notification projector splits assistant segments when reasoning resumes within the same turn", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "First answer." }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(
      streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Need one more step." }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nSecond answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "First answer.\n\nSecond answer.",
    });

    const assistantStarted = outbound
      .filter((message) => message.method === "item/started")
      .filter((message) => message.params?.item?.type === "agentMessage");
    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");
    const reasoningCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning");

    expect(assistantStarted).toHaveLength(2);
    expect(assistantCompleted).toHaveLength(2);
    expect(assistantStarted.map((message) => message.params?.item?.id)).toEqual([
      `agentMessage:${turnId}`,
      `agentMessage:${turnId}:2`,
    ]);
    expect(assistantCompleted.map((message) => String(message.params?.item?.text ?? ""))).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);

    const firstAssistantCompletedIndex = outbound.findIndex(
      (message) => message === assistantCompleted[0],
    );
    const reasoningCompletedIndex = outbound.findIndex(
      (message) => message === reasoningCompleted[0],
    );
    const secondAssistantStartedIndex = outbound.findIndex(
      (message) => message === assistantStarted[1],
    );
    expect(firstAssistantCompletedIndex).toBeLessThan(reasoningCompletedIndex);
    expect(reasoningCompletedIndex).toBeLessThan(secondAssistantStartedIndex);
  });

  test("journal projector splits assistant segments when reasoning resumes within the same turn", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "First answer." }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(
      streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Need one more step." }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nSecond answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "First answer.\n\nSecond answer.",
    });

    const assistantStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "agentMessage");
    const assistantCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "agentMessage");
    const reasoningCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "reasoning");

    expect(assistantStarted).toHaveLength(2);
    expect(assistantCompleted).toHaveLength(2);
    expect(assistantStarted.map((event) => event.payload?.item?.id)).toEqual([
      `agentMessage:${turnId}`,
      `agentMessage:${turnId}:2`,
    ]);
    expect(assistantCompleted.map((event) => String(event.payload?.item?.text ?? ""))).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);

    const firstAssistantCompletedIndex = emissions.findIndex(
      (event) => event === assistantCompleted[0],
    );
    const reasoningCompletedIndex = emissions.findIndex((event) => event === reasoningCompleted[0]);
    const secondAssistantStartedIndex = emissions.findIndex(
      (event) => event === assistantStarted[1],
    );
    expect(firstAssistantCompletedIndex).toBeLessThan(reasoningCompletedIndex);
    expect(reasoningCompletedIndex).toBeLessThan(secondAssistantStartedIndex);
  });

  test("notification projector drops a cumulative final assistant message when streamed output only differs by leading boundary whitespace", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\n" }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(
      streamChunk("reasoning_delta", {
        id: "r1",
        mode: "reasoning",
        text: "Checking the benchmarks.",
      }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nFinal answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");

    expect(assistantCompleted).toHaveLength(1);
    expect(String(assistantCompleted[0]?.params?.item?.text ?? "")).toBe("Final answer.");
  });

  test("journal projector drops a cumulative final assistant message when streamed output only differs by leading boundary whitespace", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\n" }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(
      streamChunk("reasoning_delta", {
        id: "r1",
        mode: "reasoning",
        text: "Checking the benchmarks.",
      }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nFinal answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const assistantCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "agentMessage");

    expect(assistantCompleted).toHaveLength(1);
    expect(String(assistantCompleted[0]?.payload?.item?.text ?? "")).toBe("Final answer.");
  });
});
