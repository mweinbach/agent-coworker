import { describe, expect, test } from "bun:test";

import { jsonRpcSessionRequestSchemas } from "../src/server/jsonrpc/schema.session";

const harnessContext = {
  runId: "run-1",
  objective: "Ship the coverage tests",
  acceptanceCriteria: ["tests pass"],
  constraints: ["no production changes"],
};

describe("session request schemas", () => {
  test("harnessContext/set accepts a canonical payload and trims required strings", () => {
    expect(
      jsonRpcSessionRequestSchemas["cowork/session/harnessContext/set"].parse({
        threadId: "  thread-1  ",
        context: {
          ...harnessContext,
          taskId: "  task-9  ",
          metadata: { owner: "coverage" },
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      context: {
        ...harnessContext,
        taskId: "task-9",
        metadata: { owner: "coverage" },
      },
    });
  });

  test("harnessContext/set fails closed on extra keys, blank ids, and invalid nested types", () => {
    const schema = jsonRpcSessionRequestSchemas["cowork/session/harnessContext/set"];
    expect(schema.safeParse({ threadId: "t", context: harnessContext, extra: true }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        threadId: "t",
        context: { ...harnessContext, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "   ",
        context: harnessContext,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "t",
        context: { ...harnessContext, runId: "" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "t",
        context: { ...harnessContext, taskId: "  " },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "t",
        context: { ...harnessContext, metadata: { owner: 1 } },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ threadId: "t" }).success).toBe(false);
  });

  test("usageBudget/set accepts null limits and rejects extras or non-numbers", () => {
    const schema = jsonRpcSessionRequestSchemas["cowork/session/usageBudget/set"];
    expect(
      schema.parse({
        threadId: " thread-2 ",
        warnAtUsd: 1.5,
        stopAtUsd: null,
      }),
    ).toEqual({
      threadId: "thread-2",
      warnAtUsd: 1.5,
      stopAtUsd: null,
    });
    expect(schema.safeParse({ threadId: "t", warnAtUsd: "1" }).success).toBe(false);
    expect(schema.safeParse({ threadId: "t", stopAtUsd: Number.NaN }).success).toBe(false);
    expect(schema.safeParse({ threadId: "t", extra: true }).success).toBe(false);
    expect(schema.safeParse({ threadId: "" }).success).toBe(false);
  });

  test("title/set, model/set, file/upload, and delete reject blank required fields and extras", () => {
    expect(
      jsonRpcSessionRequestSchemas["cowork/session/title/set"].safeParse({
        threadId: "t",
        title: "ok",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      jsonRpcSessionRequestSchemas["cowork/session/model/set"].safeParse({
        threadId: "t",
        model: "  ",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcSessionRequestSchemas["cowork/session/file/upload"].safeParse({
        filename: "note.txt",
        contentBase64: "",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcSessionRequestSchemas["cowork/session/delete"].safeParse({
        targetSessionId: "  ",
      }).success,
    ).toBe(false);
    expect(
      jsonRpcSessionRequestSchemas["cowork/session/harnessContext/get"].safeParse({
        threadId: "t",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
