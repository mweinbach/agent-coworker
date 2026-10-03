import { describe, expect, test } from "bun:test";

import {
  applyProjectedAgentMessageDelta,
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
  applyProjectedReasoningDelta,
  projectedItemSchema,
  projectedTodosFromItem,
} from "../../src/shared/projectedItems";
import type { SessionFeedItem } from "../../src/shared/sessionSnapshot";

function rejects(value: unknown) {
  expect(projectedItemSchema.safeParse(value).success).toBe(false);
}

describe("projectedItemSchema", () => {
  test("accepts a minimal valid item of each type", () => {
    expect(
      projectedItemSchema.parse({
        id: " user-1 ",
        type: "userMessage",
        content: [{ type: "text", text: "hello" }],
      }),
    ).toEqual({
      id: "user-1",
      type: "userMessage",
      content: [{ type: "text", text: "hello" }],
    });
    expect(
      projectedItemSchema.parse({
        id: "tool-1",
        type: "toolCall",
        toolName: "bash",
        state: "output-denied",
      }),
    ).toMatchObject({ state: "output-denied" });
    expect(
      projectedItemSchema.parse({
        id: "err-1",
        type: "error",
        message: "blocked",
        code: "permission_denied",
        source: "permissions",
      }),
    ).toMatchObject({ code: "permission_denied", source: "permissions" });
  });

  test("rejects blank ids, extras, unknown types, and invalid enums", () => {
    rejects({ id: "   ", type: "agentMessage", text: "hi" });
    rejects({ id: "a1", type: "agentMessage", text: "hi", extra: true });
    rejects({ id: "a1", type: "comment", text: "hi" });
    rejects({
      id: "tool-1",
      type: "toolCall",
      toolName: "bash",
      state: "running",
    });
    rejects({
      id: "err-1",
      type: "error",
      message: "blocked",
      code: "not_a_code",
      source: "permissions",
    });
    rejects({
      id: "todo-1",
      type: "todos",
      todos: [{ content: "x", status: "done", activeForm: "doing" }],
    });
  });
});

describe("applyProjectedItemStarted / completed", () => {
  test("completed empty reasoning drops the item instead of leaving a blank card", () => {
    const started = applyProjectedItemStarted(
      [],
      { id: "r1", type: "reasoning", mode: "summary", text: "thinking" },
      "2026-01-01T00:00:00.000Z",
    );
    expect(started).toHaveLength(1);

    const completed = applyProjectedItemCompleted(
      started,
      { id: "r1", type: "reasoning", mode: "summary", text: "   " },
      "2026-01-01T00:00:01.000Z",
    );
    expect(completed).toEqual([]);
  });

  test("userMessage clientMessageId upserts the optimistic bubble", () => {
    const feed: SessionFeedItem[] = [
      {
        id: "client-1",
        kind: "message",
        role: "user",
        ts: "2026-01-01T00:00:00.000Z",
        text: "draft",
      },
    ];

    const next = applyProjectedItemStarted(
      feed,
      {
        id: "item-1",
        type: "userMessage",
        clientMessageId: "client-1",
        content: [{ type: "text", text: "final" }],
      },
      "2026-01-01T00:00:01.000Z",
    );

    expect(next).toEqual([
      {
        id: "item-1",
        kind: "message",
        role: "user",
        ts: "2026-01-01T00:00:00.000Z",
        text: "final",
      },
    ]);
  });

  test("a later non-terminal tool start cannot unwind a completed tool", () => {
    const completed = applyProjectedItemCompleted(
      [],
      {
        id: "tool-1",
        type: "toolCall",
        toolName: "bash",
        state: "output-available",
        args: { command: "ls" },
        result: { exitCode: 0 },
      },
      "2026-01-01T00:00:01.000Z",
    );

    const restarted = applyProjectedItemStarted(
      completed,
      {
        id: "tool-1",
        type: "toolCall",
        toolName: "write",
        state: "input-streaming",
        args: { command: "rm -rf /" },
      },
      "2026-01-01T00:00:02.000Z",
    );

    expect(restarted).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "bash",
        state: "output-available",
        args: { command: "ls" },
        result: { exitCode: 0 },
      }),
    ]);
  });
});

describe("projected deltas", () => {
  test("agent and reasoning deltas append, and mismatched kinds stay unchanged", () => {
    const withMessage = applyProjectedAgentMessageDelta(
      [],
      "a1",
      "Hello",
      "2026-01-01T00:00:00.000Z",
    );
    const appended = applyProjectedAgentMessageDelta(
      withMessage,
      "a1",
      " world",
      "2026-01-01T00:00:01.000Z",
    );
    expect(appended).toEqual([
      {
        id: "a1",
        kind: "message",
        role: "assistant",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Hello world",
      },
    ]);

    const ignored = applyProjectedAgentMessageDelta(
      [
        {
          id: "a1",
          kind: "reasoning",
          mode: "summary",
          ts: "2026-01-01T00:00:00.000Z",
          text: "think",
        },
      ],
      "a1",
      " extra",
      "2026-01-01T00:00:01.000Z",
    );
    expect(ignored[0]).toMatchObject({ kind: "reasoning", text: "think" });

    const withReasoning = applyProjectedReasoningDelta(
      [],
      "r1",
      "reasoning",
      "step",
      "2026-01-01T00:00:00.000Z",
    );
    expect(
      applyProjectedReasoningDelta(
        withReasoning,
        "r1",
        "summary",
        " two",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toEqual([
      {
        id: "r1",
        kind: "reasoning",
        mode: "summary",
        ts: "2026-01-01T00:00:00.000Z",
        text: "step two",
      },
    ]);
  });

  test("projectedTodosFromItem returns todos only for todo items", () => {
    const todos = [{ content: "x", status: "pending" as const, activeForm: "doing" }];
    expect(projectedTodosFromItem({ id: "t1", type: "todos", todos })).toEqual(todos);
    expect(projectedTodosFromItem({ id: "a1", type: "agentMessage", text: "hi" })).toBeNull();
  });
});
