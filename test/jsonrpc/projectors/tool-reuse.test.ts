import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { digestToolInput } from "../../../src/shared/toolInputDigestHasher";
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

  test("projectors preserve confirmed retry lineage through authoritative completion", () => {
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
      streamChunk("tool_call", {
        toolCallId: "replacement",
        toolName: "bash",
        input: { command: "bun test" },
        retryOf: "toolCall:earlier-turn:failed",
      }),
    );
    projector.handle(
      streamChunk("tool_result", {
        toolCallId: "replacement",
        toolName: "bash",
        output: { exitCode: 0 },
      }),
    );

    const completed = outbound
      .filter((message) => message.method === "item/completed")
      .map((message) => message.params?.item)
      .find((item) => item?.state === "output-available");
    expect(completed).toMatchObject({
      id: `toolCall:${turnId}:replacement`,
      retryOf: "toolCall:earlier-turn:failed",
      result: { exitCode: 0 },
    });
  });

  test("raw-backed projection reads lineage from the canonical raw event", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });
    const args = { command: "bun test" };
    const inputDigest = digestToolInput("bash", args);
    if (!inputDigest) throw new Error("expected input digest");
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle({
      type: "model_stream_raw",
      sessionId,
      turnId,
      index: 0,
      provider: "openai",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: "bash",
          arguments: "",
        },
      },
    });
    projector.handle({
      type: "model_stream_raw",
      sessionId,
      turnId,
      index: 1,
      provider: "openai",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.function_call_arguments.done",
        item_id: "item_1",
        arguments: JSON.stringify(args),
      },
      toolCallMetadata: [
        {
          toolKey: "call_1|item_1",
          toolName: "bash",
          inputDigest,
          retryOf: "toolCall:earlier-turn:failed",
        },
      ],
    });
    projector.handle({
      type: "model_stream_raw",
      sessionId,
      turnId,
      index: 2,
      provider: "openai",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: "bash",
          arguments: JSON.stringify(args),
        },
      },
    });
    projector.handle(
      streamChunk("tool_result", {
        toolCallId: "call_1|item_1",
        toolName: "bash",
        output: { exitCode: 0 },
      }),
    );

    const completed = outbound
      .filter((message) => message.method === "item/completed")
      .map((message) => message.params?.item)
      .find((item) => item?.state === "output-available");
    expect(completed).toMatchObject({
      id: `toolCall:${turnId}:call_1|item_1`,
      inputDigest,
      retryOf: "toolCall:earlier-turn:failed",
      result: { exitCode: 0 },
    });
  });
});
