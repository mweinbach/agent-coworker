import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TASK_REVIEW_ROUNDS,
  getTaskInputResumeFailure,
  MAX_TASK_REVIEW_ROUNDS,
  type TaskActivity,
  taskCreationToolInputSchema,
} from "../../src/shared/tasks";

const validToolInput = {
  idempotencyKey: "create-1",
  title: "Ship the parser",
  objective: "Cover task creation validation.",
  context: "Regression coverage for the shared parser.",
  requirements: [
    { kind: "acceptance_criterion" as const, text: "Parser rejects cycles." },
    { kind: "constraint" as const, text: "Stay inside the workspace." },
  ],
  workItems: [
    {
      key: "design",
      title: "Design the graph",
      expectedOutputs: ["plan.md"],
    },
    {
      key: "implement",
      title: "Implement the parser",
      dependsOn: ["design"],
    },
  ],
};

describe("getTaskInputResumeFailure", () => {
  const statusChanged = (seq: number, detail: string | null): TaskActivity => ({
    id: `activity-${seq}`,
    seq,
    taskId: "task-1",
    threadId: null,
    workItemId: null,
    kind: "status_changed",
    summary: "status changed",
    detail,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  test("returns the latest structured resume failure only for failed tasks", () => {
    expect(
      getTaskInputResumeFailure({
        status: "working",
        activity: [
          statusChanged(1, JSON.stringify({ kind: "input_resume_failed", message: "stale" })),
        ],
      }),
    ).toBeNull();

    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [
          statusChanged(1, JSON.stringify({ kind: "input_resume_failed", message: "older" })),
          statusChanged(3, JSON.stringify({ kind: "input_resume_failed", message: "latest" })),
          statusChanged(2, JSON.stringify({ kind: "input_resume_failed", message: "mid" })),
        ],
      }),
    ).toBe("latest");
  });

  test("fails closed on missing or malformed resume-failure details", () => {
    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [statusChanged(1, null)],
      }),
    ).toBeNull();
    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [statusChanged(1, "not-json")],
      }),
    ).toBeNull();
    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [statusChanged(1, JSON.stringify({ kind: "other", message: "nope" }))],
      }),
    ).toBeNull();
  });
});
