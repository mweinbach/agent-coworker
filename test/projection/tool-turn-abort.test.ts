import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../src/server/jsonrpc/notificationProjector";
import { isTerminalProjectedToolState } from "../../src/shared/projectionPolicy";
import { sessionId, streamChunk, turnId } from "../jsonrpc/projectors/fixtures";

function collectToolCompletions(outbound: Array<{ method: string; params?: any }>) {
  return outbound
    .filter((message) => message.method === "item/completed")
    .map((message) => message.params?.item)
    .filter((item) => item?.type === "toolCall");
}

describe("projection tool turn abort", () => {
  test("isTerminalProjectedToolState covers completed tool rows only", () => {
    expect(isTerminalProjectedToolState("output-available")).toBe(true);
    expect(isTerminalProjectedToolState("output-error")).toBe(true);
    expect(isTerminalProjectedToolState("output-denied")).toBe(true);
    expect(isTerminalProjectedToolState("input-streaming")).toBe(false);
    expect(isTerminalProjectedToolState("input-available")).toBe(false);
    expect(isTerminalProjectedToolState("approval-requested")).toBe(false);
  });

  test("cancelled turns fail in-flight tools with parsed args preserved", () => {
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
    projector.handle(streamChunk("tool_input_start", { id: "bash-1", toolName: "bash" }));
    projector.handle(
      streamChunk("tool_input_delta", {
        id: "bash-1",
        toolName: "bash",
        delta: '{"command":"ls"}',
      }),
    );
    projector.handle({
      type: "session_busy",
      sessionId,
      busy: false,
      turnId,
      outcome: "cancelled",
    });

    const tools = collectToolCompletions(outbound);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "toolCall",
      toolName: "bash",
      state: "output-error",
      args: { command: "ls" },
      result: { error: "Turn failed before the tool call completed." },
    });
    expect(outbound.some((message) => message.method === "turn/completed")).toBe(true);
    expect(
      outbound.find((message) => message.method === "turn/completed")?.params?.turn,
    ).toMatchObject({ id: turnId, status: "interrupted" });
  });

  test("error events fail in-flight tools with the provider message and leave completed tools alone", () => {
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
        toolCallId: "done-1",
        toolName: "read",
        input: { path: "README.md" },
      }),
    );
    projector.handle(
      streamChunk("tool_result", {
        toolCallId: "done-1",
        toolName: "read",
        output: "ok",
      }),
    );
    projector.handle(streamChunk("tool_input_start", { id: "pending-1", toolName: "bash" }));
    projector.handle({
      type: "error",
      sessionId,
      message: "Provider exploded.",
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

    const tools = collectToolCompletions(outbound);
    expect(tools.filter((item) => item.id === `toolCall:${turnId}:done-1`).at(-1)).toMatchObject({
      toolName: "read",
      state: "output-available",
      result: "ok",
    });
    expect(tools.filter((item) => item.id === `toolCall:${turnId}:pending-1`).at(-1)).toMatchObject(
      {
        toolName: "bash",
        state: "output-error",
        result: { error: "Provider exploded." },
      },
    );
  });

  test("late deltas after a failed in-flight tool stay ignored while the turn is still active", () => {
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
    projector.handle(streamChunk("tool_input_start", { id: "bash-1", toolName: "bash" }));
    projector.handle({
      type: "error",
      sessionId,
      message: "Provider exploded.",
      code: "provider_error",
      source: "provider",
    });

    const completedAfterError = collectToolCompletions(outbound).filter(
      (item) => item.id === `toolCall:${turnId}:bash-1`,
    ).length;
    projector.handle(
      streamChunk("tool_input_delta", {
        id: "bash-1",
        toolName: "bash",
        delta: '{"command":"echo late"}',
      }),
    );
    projector.handle(
      streamChunk("tool_call", {
        toolCallId: "bash-1",
        toolName: "bash",
        input: { command: "echo late" },
      }),
    );

    const tools = collectToolCompletions(outbound).filter(
      (item) => item.id === `toolCall:${turnId}:bash-1`,
    );
    expect(tools).toHaveLength(completedAfterError);
    expect(tools.at(-1)).toMatchObject({
      state: "output-error",
      result: { error: "Provider exploded." },
    });
    expect(tools.some((item) => item.state === "input-available")).toBe(false);
  });
});
