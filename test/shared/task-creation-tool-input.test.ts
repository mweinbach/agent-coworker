import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TASK_REVIEW_ROUNDS,
  getTaskInputResumeFailure,
  MAX_TASK_REVIEW_ROUNDS,
  parseTaskCreationToolInput,
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

describe("parseTaskCreationToolInput", () => {
  test("normalizes nullable tool fields to schema defaults", () => {
    const parsed = parseTaskCreationToolInput({
      ...validToolInput,
      requirements: [
        {
          kind: "acceptance_criterion",
          text: "Parser rejects cycles.",
          permanence: null,
        },
      ],
      workItems: [
        {
          key: "design",
          title: "Design the graph",
          description: null,
          dependsOn: null,
          expectedOutputs: ["plan.md"],
        },
      ],
      decisions: null,
      reviewRequired: null,
      reviewRounds: null,
    });

    expect(parsed.requirements[0]?.permanence).toBe("fixed");
    expect(parsed.workItems[0]).toMatchObject({
      description: "",
      dependsOn: [],
      expectedOutputs: ["plan.md"],
    });
    expect(parsed.decisions).toEqual([]);
    expect(parsed.reviewRequired).toBe(true);
    expect(parsed.reviewRounds).toBe(DEFAULT_TASK_REVIEW_ROUNDS);
  });

  test("rejects extra keys, blank fields, and overlong identifiers", () => {
    expect(taskCreationToolInputSchema.safeParse({ ...validToolInput, extra: true }).success).toBe(
      false,
    );
    expect(taskCreationToolInputSchema.safeParse({ ...validToolInput, title: "   " }).success).toBe(
      false,
    );
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput,
        title: "t".repeat(161),
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput,
        idempotencyKey: "k".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput,
        reviewRounds: MAX_TASK_REVIEW_ROUNDS + 1,
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput,
        reviewRounds: 1.5,
      }).success,
    ).toBe(false);
  });

  test("rejects missing acceptance criteria, outputs, duplicate keys, and bad dependencies", () => {
    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput,
        requirements: [{ kind: "requirement", text: "Do the work." }],
      }),
    ).toThrow(/acceptance criterion/i);

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput,
        workItems: [{ key: "design", title: "Design the graph" }],
      }),
    ).toThrow(/expected output/i);

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput,
        workItems: [
          { key: "design", title: "First", expectedOutputs: ["plan.md"] },
          { key: "design", title: "Duplicate" },
        ],
      }),
    ).toThrow(/Duplicate work item key/i);

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput,
        workItems: [
          {
            key: "design",
            title: "Design the graph",
            dependsOn: ["design"],
            expectedOutputs: ["plan.md"],
          },
        ],
      }),
    ).toThrow(/cannot depend on itself/i);

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput,
        workItems: [
          {
            key: "design",
            title: "Design the graph",
            dependsOn: ["missing"],
            expectedOutputs: ["plan.md"],
          },
        ],
      }),
    ).toThrow(/Unknown work item dependency/i);
  });

  test("rejects cyclic work-item graphs", () => {
    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput,
        workItems: [
          {
            key: "a",
            title: "A",
            dependsOn: ["b"],
            expectedOutputs: ["a.md"],
          },
          {
            key: "b",
            title: "B",
            dependsOn: ["a"],
          },
        ],
      }),
    ).toThrow(/cycle/i);
  });
});

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
