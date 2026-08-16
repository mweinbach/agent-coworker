import { describe, expect, test } from "bun:test";

import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";

const TASK_ID = "task-1";

describe("task JSON-RPC request schemas", () => {
  test("updateBrief requires at least one brief field", () => {
    expect(() =>
      jsonRpcRequestSchemas["task/updateBrief"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
      }),
    ).toThrow("At least one brief field is required");

    expect(
      jsonRpcRequestSchemas["task/updateBrief"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        title: "Updated brief",
      }),
    ).toEqual({
      taskId: TASK_ID,
      expectedRevision: 1,
      title: "Updated brief",
    });
  });

  test("updateBrief rejects blank fields, unknown keys, and invalid requirements", () => {
    expect(() =>
      jsonRpcRequestSchemas["task/updateBrief"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        title: "   ",
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["task/updateBrief"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        title: "Updated",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["task/updateBrief"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        requirements: [{ kind: "wish", text: "Be nice" }],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["task/updateBrief"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        requirements: [{ kind: "constraint", text: "   " }],
      }),
    ).toThrow();
  });

  test("mutation schemas reject non-integer and negative expectedRevision", () => {
    const invalidRevisions = [-1, 1.5, "1", Number.NaN] as const;
    for (const expectedRevision of invalidRevisions) {
      expect(() =>
        jsonRpcRequestSchemas["task/updateBrief"].parse({
          taskId: TASK_ID,
          expectedRevision,
          title: "Updated",
        }),
      ).toThrow();
      expect(() =>
        jsonRpcRequestSchemas["task/accept"].parse({
          taskId: TASK_ID,
          expectedRevision,
        }),
      ).toThrow();
    }
  });

  test("questions/resolve requires exactly one of optionId or text per answer", () => {
    expect(() =>
      jsonRpcRequestSchemas["task/questions/resolve"].parse({
        taskId: TASK_ID,
        expectedRevision: 2,
        answers: [],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["task/questions/resolve"].parse({
        taskId: TASK_ID,
        expectedRevision: 2,
        answers: [{ questionId: "q1" }],
      }),
    ).toThrow("Provide exactly one of optionId or text");
    expect(() =>
      jsonRpcRequestSchemas["task/questions/resolve"].parse({
        taskId: TASK_ID,
        expectedRevision: 2,
        answers: [{ questionId: "q1", optionId: "a", text: "both" }],
      }),
    ).toThrow("Provide exactly one of optionId or text");

    expect(
      jsonRpcRequestSchemas["task/questions/resolve"].parse({
        taskId: TASK_ID,
        expectedRevision: 2,
        answers: [{ questionId: "q1", optionId: "opt-1" }],
      }),
    ).toEqual({
      taskId: TASK_ID,
      expectedRevision: 2,
      answers: [{ questionId: "q1", optionId: "opt-1" }],
    });
  });

  test("identity and work-item schemas reject blank ids and unknown statuses", () => {
    expect(() => jsonRpcRequestSchemas["task/read"].parse({ taskId: "   " })).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["task/workItem/mark"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        workItemId: "item-1",
        status: "done-enough",
      }),
    ).toThrow();
    expect(
      jsonRpcRequestSchemas["task/workItem/mark"].parse({
        taskId: TASK_ID,
        expectedRevision: 1,
        workItemId: "item-1",
        status: "done",
      }),
    ).toEqual({
      taskId: TASK_ID,
      expectedRevision: 1,
      workItemId: "item-1",
      status: "done",
    });
  });
});
