import { describe, expect, test } from "bun:test";

import { jsonRpcTaskRequestSchemas } from "../src/server/jsonrpc/schema.tasks";

const updateBrief = jsonRpcTaskRequestSchemas["task/updateBrief"];
const updateGraph = jsonRpcTaskRequestSchemas["task/updateGraph"];
const claim = jsonRpcTaskRequestSchemas["task/workItem/claim"];
const mark = jsonRpcTaskRequestSchemas["task/workItem/mark"];
const decision = jsonRpcTaskRequestSchemas["task/decision/record"];
const resolveQuestions = jsonRpcTaskRequestSchemas["task/questions/resolve"];
const startRevision = jsonRpcTaskRequestSchemas["task/artifact/revision/start"];
const proposeCompletion = jsonRpcTaskRequestSchemas["task/proposeCompletion"];
const accept = jsonRpcTaskRequestSchemas["task/accept"];
const requestChanges = jsonRpcTaskRequestSchemas["task/requestChanges"];

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("task request schemas", () => {
  test("updateBrief requires at least one brief field and rejects blank identity", () => {
    rejects(updateBrief, { taskId: "t1", expectedRevision: 0 });
    rejects(updateBrief, { taskId: " ", expectedRevision: 0, title: "Ship it" });
    rejects(updateBrief, { cwd: " ", taskId: "t1", expectedRevision: 0, title: "Ship it" });
    rejects(updateBrief, { taskId: "t1", expectedRevision: -1, title: "Ship it" });
    rejects(updateBrief, { taskId: "t1", expectedRevision: 1.5, title: "Ship it" });
    rejects(updateBrief, { taskId: "t1", expectedRevision: 0, title: "Ship it", extra: true });

    expect(
      updateBrief.parse({
        cwd: " /workspace ",
        taskId: " t1 ",
        expectedRevision: 0,
        title: " Ship it ",
      }),
    ).toEqual({
      cwd: "/workspace",
      taskId: "t1",
      expectedRevision: 0,
      title: "Ship it",
    });
  });

  test("updateGraph and work-item mutations reject blank ids and unknown statuses", () => {
    rejects(updateGraph, { taskId: "t1", expectedRevision: 0 });
    rejects(updateGraph, {
      taskId: "t1",
      expectedRevision: 0,
      workItems: [{ title: " " }],
    });
    rejects(claim, {
      taskId: "t1",
      expectedRevision: 0,
      workItemId: " ",
      taskThreadId: "thread-1",
    });
    rejects(mark, {
      taskId: "t1",
      expectedRevision: 0,
      workItemId: "w1",
      status: "complete",
    });

    expect(
      mark.parse({
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
    rejects(decision, {
      taskId: "t1",
      expectedRevision: 0,
      question: "Which host?",
      resolution: "Use Linux",
      confidence: 1.1,
    });
    rejects(decision, {
      taskId: "t1",
      expectedRevision: 0,
      question: "Which host?",
      resolution: "Use Linux",
      confidence: -0.1,
    });
    rejects(resolveQuestions, { taskId: "t1", expectedRevision: 0, answers: [] });
    rejects(resolveQuestions, {
      taskId: "t1",
      expectedRevision: 0,
      answers: [{ questionId: "q1" }],
    });
    rejects(resolveQuestions, {
      taskId: "t1",
      expectedRevision: 0,
      answers: [{ questionId: "q1", optionId: "a", text: "both" }],
    });
    rejects(resolveQuestions, {
      taskId: "t1",
      expectedRevision: 0,
      answers: [
        { questionId: "q1", optionId: "a" },
        { questionId: "q2", optionId: "b" },
        { questionId: "q3", optionId: "c" },
        { questionId: "q4", optionId: "d" },
      ],
    });

    expect(
      resolveQuestions.parse({
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
      decision.parse({
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
    rejects(startRevision, {
      taskId: "t1",
      artifactId: " ",
      baseVersionId: "v1",
      expectedRevision: 0,
      instruction: "fix",
    });
    rejects(startRevision, {
      taskId: "t1",
      artifactId: "a1",
      baseVersionId: "v1",
      expectedRevision: 0,
      instruction: " ",
    });
    rejects(proposeCompletion, {
      taskId: "t1",
      expectedRevision: 0,
      summary: " ",
    });
    rejects(accept, { taskId: "t1" });
    rejects(requestChanges, {
      taskId: "t1",
      expectedRevision: 0,
      feedback: "needs work",
      extra: true,
    });

    expect(
      accept.parse({
        taskId: " t1 ",
        expectedRevision: 3,
      }),
    ).toEqual({
      taskId: "t1",
      expectedRevision: 3,
    });
  });
});
