import { describe, expect, test } from "bun:test";
import { jsonRpcTaskRequestSchemas } from "../src/server/jsonrpc/schema.tasks";

const s = jsonRpcTaskRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("task request schemas", () => {
  test("updateBrief requires at least one brief field and rejects blank identity", () => {
    rejectsAll(s["task/updateBrief"], [
      { taskId: "t1", expectedRevision: 0 },
      { taskId: " ", expectedRevision: 0, title: "Ship it" },
      { cwd: " ", taskId: "t1", expectedRevision: 0, title: "Ship it" },
      { taskId: "t1", expectedRevision: -1, title: "Ship it" },
      { taskId: "t1", expectedRevision: 1.5, title: "Ship it" },
      { taskId: "t1", expectedRevision: 0, title: "Ship it", extra: true },
    ]);
    expect(
      s["task/updateBrief"].parse({
        cwd: " /workspace ",
        taskId: " t1 ",
        expectedRevision: 0,
        title: " Ship it ",
      }),
    ).toEqual({ cwd: "/workspace", taskId: "t1", expectedRevision: 0, title: "Ship it" });
  });

  test("updateGraph and work-item mutations reject blank ids and unknown statuses", () => {
    rejectsAll(s["task/updateGraph"], [
      { taskId: "t1", expectedRevision: 0 },
      { taskId: "t1", expectedRevision: 0, workItems: [{ title: " " }] },
    ]);
    rejectsAll(s["task/workItem/claim"], [
      { taskId: "t1", expectedRevision: 0, workItemId: " ", taskThreadId: "thread-1" },
    ]);
    rejectsAll(s["task/workItem/mark"], [
      { taskId: "t1", expectedRevision: 0, workItemId: "w1", status: "complete" },
    ]);
    expect(
      s["task/workItem/mark"].parse({
        taskId: "t1",
        expectedRevision: 2,
        workItemId: " w1 ",
        status: "done",
        completionEvidence: " shipped ",
      }),
    ).toEqual({
      taskId: "t1",
      expectedRevision: 2,
      workItemId: "w1",
      status: "done",
      completionEvidence: "shipped",
    });
  });

  test("decision confidence is bounded and questions resolve is XOR optionId/text", () => {
    rejectsAll(s["task/decision/record"], [
      {
        taskId: "t1",
        expectedRevision: 0,
        question: "Which host?",
        resolution: "Use Linux",
        confidence: 1.1,
      },
      {
        taskId: "t1",
        expectedRevision: 0,
        question: "Which host?",
        resolution: "Use Linux",
        confidence: -0.1,
      },
    ]);
    rejectsAll(s["task/questions/resolve"], [
      { taskId: "t1", expectedRevision: 0, answers: [] },
      { taskId: "t1", expectedRevision: 0, answers: [{ questionId: "q1" }] },
      {
        taskId: "t1",
        expectedRevision: 0,
        answers: [{ questionId: "q1", optionId: "a", text: "both" }],
      },
      {
        taskId: "t1",
        expectedRevision: 0,
        answers: [
          { questionId: "q1", optionId: "a" },
          { questionId: "q2", optionId: "b" },
          { questionId: "q3", optionId: "c" },
          { questionId: "q4", optionId: "d" },
        ],
      },
    ]);
    expect(
      s["task/questions/resolve"].parse({
        taskId: " t1 ",
        expectedRevision: 0,
        answers: [{ questionId: " q1 ", text: " Linux " }],
      }),
    ).toEqual({
      taskId: "t1",
      expectedRevision: 0,
      answers: [{ questionId: "q1", text: "Linux" }],
    });
    expect(
      s["task/decision/record"].parse({
        taskId: "t1",
        expectedRevision: 0,
        question: " Which host? ",
        resolution: " Linux ",
        confidence: 0.5,
      }),
    ).toEqual({
      taskId: "t1",
      expectedRevision: 0,
      question: "Which host?",
      resolution: "Linux",
      source: "user",
      confidence: 0.5,
    });
  });

  test("artifact revision and completion mutations reject blanks and extras", () => {
    rejectsAll(s["task/artifact/revision/start"], [
      {
        taskId: "t1",
        artifactId: " ",
        baseVersionId: "v1",
        expectedRevision: 0,
        instruction: "fix",
      },
      {
        taskId: "t1",
        artifactId: "a1",
        baseVersionId: "v1",
        expectedRevision: 0,
        instruction: " ",
      },
    ]);
    rejectsAll(s["task/proposeCompletion"], [{ taskId: "t1", expectedRevision: 0, summary: " " }]);
    rejectsAll(s["task/accept"], [{ taskId: "t1" }]);
    rejectsAll(s["task/requestChanges"], [
      { taskId: "t1", expectedRevision: 0, feedback: "needs work", extra: true },
    ]);
    expect(s["task/accept"].parse({ taskId: " t1 ", expectedRevision: 3 })).toEqual({
      taskId: "t1",
      expectedRevision: 3,
    });
  });
});
