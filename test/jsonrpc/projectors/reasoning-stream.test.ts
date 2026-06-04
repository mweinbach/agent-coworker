import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { sessionId, streamChunk, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("notification projector routes commentary deltas into reasoning items from live chunks", () => {
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
    projector.handle(
      streamChunk("text_delta", { id: "text-1", phase: "commentary", text: "Internal commentary" }),
    );
    projector.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    projector.handle(
      streamChunk("reasoning_delta", {
        id: "reasoning-1",
        mode: "summary",
        text: "Inspecting the reports.",
      }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "reasoning-1", mode: "summary" }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Inspecting the reports.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Here is the result.",
    });

    const assistantDeltas = outbound
      .filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => String(message.params?.delta ?? ""));
    expect(assistantDeltas).toEqual(["Here is the result."]);

    const reasoningStarted = outbound
      .filter((message) => message.method === "item/started")
      .filter((message) => message.params?.item?.type === "reasoning");
    const reasoningDeltas = outbound.filter((message) => message.method === "item/reasoning/delta");
    const reasoningCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning");

    expect(reasoningStarted).toHaveLength(2);
    expect(reasoningDeltas).toHaveLength(2);
    expect(reasoningCompleted).toHaveLength(2);

    expect(reasoningStarted[0]?.params?.item).toMatchObject({
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(reasoningDeltas[0]?.params).toMatchObject({
      threadId: sessionId,
      turnId,
      mode: "summary",
      delta: "Internal commentary",
    });
    expect(reasoningDeltas[0]?.params?.itemId).toBe(reasoningStarted[0]?.params?.item?.id);
    expect(reasoningDeltas[1]?.params).toMatchObject({
      threadId: sessionId,
      turnId,
      mode: "summary",
      delta: "Inspecting the reports.",
    });
    expect(reasoningDeltas[1]?.params?.itemId).toBe(reasoningStarted[1]?.params?.item?.id);
    expect(reasoningCompleted.map((message) => message.params?.item?.text).sort()).toEqual([
      "Inspecting the reports.",
      "Internal commentary",
    ]);
    expect(
      reasoningCompleted.find((message) => message.params?.item?.text === "Internal commentary")
        ?.params?.item,
    ).toMatchObject({
      id: reasoningStarted[0]?.params?.item?.id,
      type: "reasoning",
      mode: "summary",
      text: "Internal commentary",
    });

    const reasoningStartedIndex = outbound.findIndex((message) => message === reasoningStarted[0]);
    const reasoningDeltaIndex = outbound.findIndex((message) => message === reasoningDeltas[0]);
    const commentaryCompletedIndex = outbound.findIndex(
      (message) =>
        message.method === "item/completed" &&
        message.params?.item?.type === "reasoning" &&
        message.params?.item?.text === "Internal commentary",
    );
    const assistantDeltaIndex = outbound.findIndex(
      (message) =>
        message.method === "item/agentMessage/delta" &&
        message.params?.delta === "Here is the result.",
    );
    expect(reasoningStartedIndex).toBeLessThan(reasoningDeltaIndex);
    expect(reasoningDeltaIndex).toBeLessThan(commentaryCompletedIndex);
    expect(commentaryCompletedIndex).toBeLessThan(assistantDeltaIndex);
  });

  test("notification projector strips think-tagged text from assistant deltas", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s1", text: "<thi" }));
    projector.handle(streamChunk("text_delta", { id: "s1", text: "nk>\nPlanning" }));
    projector.handle(
      streamChunk("reasoning_delta", { id: "s1", mode: "reasoning", text: "Planning" }),
    );
    projector.handle(streamChunk("text_delta", { id: "s1", text: " the work" }));
    projector.handle(
      streamChunk("reasoning_delta", { id: "s1", mode: "reasoning", text: " the work" }),
    );
    projector.handle(streamChunk("text_delta", { id: "s1", text: "\n</think>\n\nVisible answer" }));
    projector.handle(streamChunk("text_end", { id: "s1" }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "<think>\nPlanning the work\n</think>\n\nVisible answer",
    });
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: false,
      turnId,
      outcome: "success",
    });

    const assistantDeltas = outbound
      .filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => String(message.params?.delta ?? ""));
    expect(assistantDeltas).toEqual(["\n\nVisible answer"]);

    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");
    expect(assistantCompleted.map((message) => message.params?.item?.text)).toEqual([
      "\n\nVisible answer",
    ]);

    const reasoningDeltas = outbound
      .filter((message) => message.method === "item/reasoning/delta")
      .map((message) => String(message.params?.delta ?? ""));
    expect(reasoningDeltas).toEqual(["Planning", " the work"]);
  });

  test("notification projector splits same-id reasoning when a tool lands between deltas", () => {
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
    projector.handle(
      streamChunk("reasoning_delta", { id: "r0", mode: "reasoning", text: "First step." }),
    );
    projector.handle(
      streamChunk("tool_call", {
        toolCallId: "call-1",
        toolName: "webSearch",
        input: { query: "first" },
      }),
    );
    projector.handle(
      streamChunk("tool_result", {
        toolCallId: "call-1",
        toolName: "webSearch",
        output: { result: "first" },
      }),
    );
    projector.handle(
      streamChunk("reasoning_delta", { id: "r0", mode: "reasoning", text: "Second step." }),
    );
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: false,
      turnId,
      outcome: "success",
    });

    const visibleOrder = outbound
      .filter(
        (message) =>
          message.method === "item/started" &&
          (message.params?.item?.type === "reasoning" || message.params?.item?.type === "toolCall"),
      )
      .map((message) => message.params?.item?.type);
    expect(visibleOrder).toEqual(["reasoning", "toolCall", "reasoning"]);

    const reasoningCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning");
    expect(reasoningCompleted.map((message) => message.params?.item?.id)).toEqual([
      `reasoning:${turnId}:r0`,
      `reasoning:${turnId}:r0:2`,
    ]);
    expect(reasoningCompleted.map((message) => message.params?.item?.text)).toEqual([
      "First step.",
      "Second step.",
    ]);
  });

  test("notification projector closes blank reasoning placeholders when a turn completes", () => {
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
    projector.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    projector.handle(streamChunk("text_delta", { id: "text-1", text: "Final answer" }));
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: false,
      turnId,
      outcome: "completed",
    });

    const reasoningStarted = outbound.find(
      (message) => message.method === "item/started" && message.params?.item?.type === "reasoning",
    );
    const reasoningCompleted = outbound.find(
      (message) =>
        message.method === "item/completed" && message.params?.item?.type === "reasoning",
    );
    const assistantCompleted = outbound.find(
      (message) =>
        message.method === "item/completed" && message.params?.item?.type === "agentMessage",
    );
    const turnCompleted = outbound.find((message) => message.method === "turn/completed");

    expect(reasoningStarted?.params?.item).toMatchObject({
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(reasoningCompleted?.params?.item).toMatchObject({
      id: reasoningStarted?.params?.item?.id,
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(assistantCompleted?.params?.item).toMatchObject({
      type: "agentMessage",
      text: "Final answer",
    });
    expect(outbound.findIndex((message) => message === reasoningCompleted)).toBeLessThan(
      outbound.findIndex((message) => message === turnCompleted),
    );
  });

  test("journal projector routes commentary deltas into streamed reasoning events from live chunks", () => {
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
    projector.handle(
      streamChunk("text_delta", { id: "text-1", phase: "commentary", text: "Internal commentary" }),
    );
    projector.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    projector.handle(
      streamChunk("reasoning_delta", {
        id: "reasoning-1",
        mode: "summary",
        text: "Inspecting the reports.",
      }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "reasoning-1", mode: "summary" }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Inspecting the reports.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Here is the result.",
    });

    const assistantDeltas = emissions
      .filter((event) => event.eventType === "item/agentMessage/delta")
      .map((event) => String(event.payload?.delta ?? ""));
    expect(assistantDeltas).toEqual(["Here is the result."]);

    const reasoningStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "reasoning");
    const reasoningDeltas = emissions.filter((event) => event.eventType === "item/reasoning/delta");
    const reasoningCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "reasoning");

    expect(reasoningStarted).toHaveLength(2);
    expect(reasoningDeltas).toHaveLength(2);
    expect(reasoningCompleted).toHaveLength(2);

    expect(reasoningStarted[0]?.payload?.item).toMatchObject({
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(reasoningDeltas[0]?.payload).toMatchObject({
      threadId: sessionId,
      turnId,
      mode: "summary",
      delta: "Internal commentary",
    });
    expect(reasoningDeltas[0]?.payload?.itemId).toBe(reasoningStarted[0]?.payload?.item?.id);
    expect(reasoningDeltas[1]?.payload).toMatchObject({
      threadId: sessionId,
      turnId,
      mode: "summary",
      delta: "Inspecting the reports.",
    });
    expect(reasoningDeltas[1]?.payload?.itemId).toBe(reasoningStarted[1]?.payload?.item?.id);
    expect(reasoningCompleted.map((event) => event.payload?.item?.text).sort()).toEqual([
      "Inspecting the reports.",
      "Internal commentary",
    ]);
    expect(
      reasoningCompleted.find((event) => event.payload?.item?.text === "Internal commentary")
        ?.payload?.item,
    ).toMatchObject({
      id: reasoningStarted[0]?.payload?.item?.id,
      type: "reasoning",
      mode: "summary",
      text: "Internal commentary",
    });
  });
});
