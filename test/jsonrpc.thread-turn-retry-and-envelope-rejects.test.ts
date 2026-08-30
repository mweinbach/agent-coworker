import { describe, expect, test } from "bun:test";

import {
  jsonRpcThreadTurnNotificationSchemas,
  jsonRpcThreadTurnRequestSchemas,
  jsonRpcThreadTurnResultSchemas,
  jsonRpcThreadTurnServerRequestSchemas,
} from "../src/server/jsonrpc/schema.threadTurn";
import { MAX_TOOL_RETRY_TARGETS } from "../src/shared/toolRetry";

const start = jsonRpcThreadTurnRequestSchemas["turn/start"];
const steer = jsonRpcThreadTurnRequestSchemas["turn/steer"];
const list = jsonRpcThreadTurnRequestSchemas["thread/list"];
const resume = jsonRpcThreadTurnRequestSchemas["thread/resume"];
const hydrate = jsonRpcThreadTurnRequestSchemas["thread/hydrate"];

describe("thread/turn retry and envelope schema rejects", () => {
  test("turn/start retry requires 1..16 non-blank tool item ids and rejects extras", () => {
    expect(
      start.parse({
        threadId: "thread-1",
        input: "retry",
        retry: { toolItemIds: [" tool-1 "] },
      }),
    ).toEqual({
      threadId: "thread-1",
      input: "retry",
      retry: { toolItemIds: ["tool-1"] },
    });
    expect(
      start.safeParse({
        threadId: "thread-1",
        input: "retry",
        retry: { toolItemIds: [] },
      }).success,
    ).toBe(false);
    expect(
      start.safeParse({
        threadId: "thread-1",
        input: "retry",
        retry: {
          toolItemIds: Array.from({ length: MAX_TOOL_RETRY_TARGETS + 1 }, (_, i) => `t-${i}`),
        },
      }).success,
    ).toBe(false);
    expect(
      start.safeParse({
        threadId: "thread-1",
        input: "retry",
        retry: { toolItemIds: ["   "] },
      }).success,
    ).toBe(false);
    expect(
      start.safeParse({
        threadId: "thread-1",
        input: "retry",
        retry: { toolItemIds: ["tool-1"], extra: true },
      }).success,
    ).toBe(false);
    expect(
      start.safeParse({
        threadId: "thread-1",
        input: "retry",
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("turn/steer and thread pagination reject extras, blank ids, and invalid offsets", () => {
    expect(
      steer.parse({
        threadId: " thread-1 ",
        input: "steer",
      }),
    ).toEqual({
      threadId: "thread-1",
      input: "steer",
    });
    expect(steer.safeParse({ threadId: "thread-1", input: "steer", extra: true }).success).toBe(
      false,
    );
    expect(steer.safeParse({ threadId: "   ", input: "steer" }).success).toBe(false);
    expect(list.parse({ limit: 1, offset: 0 })).toEqual({ limit: 1, offset: 0 });
    expect(list.safeParse({ limit: 0 }).success).toBe(false);
    expect(list.safeParse({ offset: -1 }).success).toBe(false);
    expect(list.safeParse({ extra: true }).success).toBe(false);
    expect(resume.safeParse({ threadId: "thread-1", afterSeq: -1 }).success).toBe(false);
    expect(hydrate.safeParse({ threadId: "thread-1", afterSeq: 1.5 }).success).toBe(false);
  });

  test("resume/read envelopes reject unknown replay reasons and unsubscribe statuses", () => {
    const thread = {
      id: "thread-1",
      title: "T",
      preview: "",
      modelProvider: "openai",
      model: "gpt-5.5",
      cwd: "/tmp",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      lastEventSeq: 0,
      status: { type: "idle" },
    };
    const replayHealth = {
      trusted: true,
      snapshotRequired: false,
      reason: "ok" as const,
      tailSeq: 0,
      failedWriteCount: 0,
      droppedEventCount: 0,
    };
    expect(
      jsonRpcThreadTurnResultSchemas["thread/resume"].parse({
        thread,
        replayHealth,
      }),
    ).toEqual({ thread, replayHealth });
    expect(
      jsonRpcThreadTurnResultSchemas["thread/resume"].safeParse({
        thread,
        replayHealth: { ...replayHealth, reason: "corrupt" },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcThreadTurnResultSchemas["thread/resume"].safeParse({
        thread,
        replayHealth: { ...replayHealth, failedWriteCount: -1 },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcThreadTurnResultSchemas["thread/unsubscribe"].parse({ status: "unsubscribed" }),
    ).toEqual({
      status: "unsubscribed",
    });
    expect(
      jsonRpcThreadTurnResultSchemas["thread/unsubscribe"].safeParse({ status: "error" }).success,
    ).toBe(false);
    expect(
      jsonRpcThreadTurnResultSchemas["turn/steer"].safeParse({
        turnId: "turn-1",
        steerRequestId: "steer-1",
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("reasoning deltas and approval requests reject unknown modes and categories", () => {
    expect(
      jsonRpcThreadTurnNotificationSchemas["item/reasoning/delta"].parse({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        mode: "summary",
        delta: "ok",
      }),
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      mode: "summary",
      delta: "ok",
    });
    expect(
      jsonRpcThreadTurnNotificationSchemas["item/reasoning/delta"].safeParse({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        mode: "thinking",
        delta: "ok",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcThreadTurnServerRequestSchemas["item/commandExecution/requestApproval"].parse({
        threadId: "thread-1",
        requestId: "req-1",
        itemId: "item-1",
        command: "ls",
        dangerous: false,
        reason: "sandbox",
        category: "filesystem",
      }),
    ).toMatchObject({ category: "filesystem" });
    expect(
      jsonRpcThreadTurnServerRequestSchemas["item/commandExecution/requestApproval"].safeParse({
        threadId: "thread-1",
        requestId: "req-1",
        itemId: "item-1",
        command: "ls",
        dangerous: false,
        reason: "sandbox",
        category: "shell",
      }).success,
    ).toBe(false);
  });
});
