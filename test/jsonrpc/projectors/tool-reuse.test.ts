import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { sessionId, streamChunk, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("projectors keep completed tools terminal when stale input chunks arrive later", () => {
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
        streamChunk("tool_input_start", { id: "todo-final", toolName: "todoWrite" }),
      );
      projector.handle(
        streamChunk("tool_call", {
          toolCallId: "todo-final",
          toolName: "todoWrite",
          input: { todos: [{ content: "Verify", status: "completed" }] },
        }),
      );
      projector.handle(
        streamChunk("tool_result", {
          toolCallId: "todo-final",
          toolName: "todoWrite",
          output: "Todo list updated",
        }),
      );
      projector.handle(streamChunk("tool_input_end", { id: "todo-final", toolName: "tool" }));
      projector.handle(
        streamChunk("tool_call", {
          toolCallId: "todo-final",
          toolName: "tool",
          input: { id: "todo-final", toolName: "todoWrite" },
        }),
      );
    }

    const liveToolStates = outbound
      .filter((message) => message.method === "item/completed")
      .map((message) => message.params?.item)
      .filter((item) => item?.type === "toolCall" && item.id === `toolCall:${turnId}:todo-final`)
      .map((item) => ({ name: item.toolName, state: item.state, result: item.result }));
    expect(liveToolStates.at(-1)).toEqual({
      name: "todoWrite",
      state: "output-available",
      result: "Todo list updated",
    });

    const journalToolStates = emissions
      .filter((event) => event.eventType === "item/completed")
      .map((event) => event.payload?.item)
      .filter((item) => item?.type === "toolCall" && item.id === `toolCall:${turnId}:todo-final`)
      .map((item) => ({ name: item.toolName, state: item.state, result: item.result }));
    expect(journalToolStates.at(-1)).toEqual({
      name: "todoWrite",
      state: "output-available",
      result: "Todo list updated",
    });
  });

  test("projectors do not reuse completed tool items for later same-name calls", () => {
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

    for (const [id, query] of [
      ["call-1", "first"],
      ["call-2", "second"],
    ] as const) {
      projector.handle(streamChunk("tool_input_start", { id, toolName: "webSearch" }));
      projector.handle(
        streamChunk("tool_call", {
          toolCallId: id,
          toolName: "webSearch",
          input: { query },
        }),
      );
      projector.handle(
        streamChunk("tool_result", {
          toolCallId: id,
          toolName: "webSearch",
          output: { result: query },
        }),
      );
    }

    const toolStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "toolCall");
    const toolCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "toolCall");
    const toolOutputAvailable = toolCompleted.filter(
      (event) => event.payload?.item?.state === "output-available",
    );

    expect(toolStarted.map((event) => event.payload?.item?.id)).toEqual([
      `toolCall:${turnId}:call-1`,
      `toolCall:${turnId}:call-2`,
    ]);
    expect(toolOutputAvailable.map((event) => event.payload?.item?.id)).toEqual([
      `toolCall:${turnId}:call-1`,
      `toolCall:${turnId}:call-2`,
    ]);
    expect(toolOutputAvailable.map((event) => event.payload?.item?.args)).toEqual([
      { query: "first" },
      { query: "second" },
    ]);
    expect(new Set(toolOutputAvailable.map((event) => event.payload?.item?.id)).size).toBe(2);
  });

  test("projectors preserve the first terminal state for one call id", () => {
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
      streamChunk("tool_error", {
        toolCallId: "same-call",
        toolName: "bash",
        error: "failed",
      }),
    );
    projector.handle(
      streamChunk("tool_result", {
        toolCallId: "same-call",
        toolName: "bash",
        output: { exitCode: 0 },
      }),
    );

    const terminalItems = emissions
      .filter((event) => event.eventType === "item/completed")
      .map((event) => event.payload?.item)
      .filter((item) => item?.id === `toolCall:${turnId}:same-call`);

    expect(terminalItems).toHaveLength(1);
    expect(terminalItems[0]).toMatchObject({
      state: "output-error",
      result: { error: "failed" },
    });
  });

  test("projectors translate explicit retry call ids into projected item lineage", () => {
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
      streamChunk("tool_error", {
        toolCallId: "call-failed",
        toolName: "bash",
        error: "failed",
      }),
    );
    projector.handle(
      streamChunk("tool_result", {
        toolCallId: "call-retry",
        toolName: "bash",
        retryOf: "call-failed",
        output: { exitCode: 0 },
      }),
    );

    const retry = emissions
      .filter((event) => event.eventType === "item/completed")
      .map((event) => event.payload?.item)
      .find((item) => item?.id === `toolCall:${turnId}:call-retry`);

    expect(retry).toMatchObject({
      id: `toolCall:${turnId}:call-retry`,
      type: "toolCall",
      state: "output-available",
      retryOf: `toolCall:${turnId}:call-failed`,
    });
  });
});
