import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TASK_REVIEW_ROUNDS,
  MAX_TASK_REVIEW_ROUNDS,
  parseTaskCreationToolInput,
  taskCreationToolInputSchema,
} from "../../src/shared/tasks";

function validToolInput() {
  return {
    idempotencyKey: "create-task-1",
    title: "Cover task creation",
    objective: "Prove fail-closed task creation input",
    context: "Daily coverage automation",
    requirements: [
      { kind: "acceptance_criterion" as const, text: "At least one acceptance criterion" },
    ],
    workItems: [
      {
        key: "write-tests",
        title: "Write the tests",
        expectedOutputs: ["test/shared/task-creation-tool-input.test.ts"],
      },
    ],
  };
}

describe("parseTaskCreationToolInput", () => {
  test("normalizes nullable tool fields to creation defaults", () => {
    const parsed = parseTaskCreationToolInput({
      ...validToolInput(),
      requirements: [
        {
          kind: "acceptance_criterion",
          text: "  Must stay fail-closed  ",
          permanence: null,
        },
      ],
      workItems: [
        {
          key: "write-tests",
          title: "Write the tests",
          description: null,
          dependsOn: null,
          expectedOutputs: ["coverage report"],
        },
      ],
      decisions: null,
      reviewRequired: null,
      reviewRounds: null,
    });

    expect(parsed.requirements[0]).toEqual({
      kind: "acceptance_criterion",
      text: "Must stay fail-closed",
      permanence: "fixed",
    });
    expect(parsed.workItems[0]).toEqual({
      key: "write-tests",
      title: "Write the tests",
      description: "",
      dependsOn: [],
      expectedOutputs: ["coverage report"],
    });
    expect(parsed.decisions).toEqual([]);
    expect(parsed.reviewRequired).toBe(true);
    expect(parsed.reviewRounds).toBe(DEFAULT_TASK_REVIEW_ROUNDS);
  });

  test("rejects extra top-level keys and blank required strings", () => {
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        title: "   ",
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        title: "x".repeat(161),
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        idempotencyKey: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  test("rejects reviewRounds outside 0..MAX_TASK_REVIEW_ROUNDS", () => {
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        reviewRounds: MAX_TASK_REVIEW_ROUNDS + 1,
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        reviewRounds: -1,
      }).success,
    ).toBe(false);
    expect(
      taskCreationToolInputSchema.safeParse({
        ...validToolInput(),
        reviewRounds: 1.5,
      }).success,
    ).toBe(false);
    expect(
      parseTaskCreationToolInput({
        ...validToolInput(),
        reviewRounds: MAX_TASK_REVIEW_ROUNDS,
      }).reviewRounds,
    ).toBe(MAX_TASK_REVIEW_ROUNDS);
  });

  test("requires an acceptance criterion and at least one expected output", () => {
    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput(),
        requirements: [{ kind: "requirement", text: "Nice to have" }],
      }),
    ).toThrow("At least one acceptance criterion is required");

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput(),
        workItems: [{ key: "write-tests", title: "Write the tests", expectedOutputs: [] }],
      }),
    ).toThrow("At least one expected output is required");
  });

  test("rejects duplicate, self, unknown, and cyclic work-item dependencies", () => {
    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput(),
        workItems: [
          { key: "write-tests", title: "First", expectedOutputs: ["a"] },
          { key: "write-tests", title: "Second", expectedOutputs: ["b"] },
        ],
      }),
    ).toThrow("Duplicate work item key: write-tests");

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput(),
        workItems: [
          {
            key: "write-tests",
            title: "Write the tests",
            dependsOn: ["write-tests"],
            expectedOutputs: ["a"],
          },
        ],
      }),
    ).toThrow("Work item write-tests cannot depend on itself");

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput(),
        workItems: [
          {
            key: "write-tests",
            title: "Write the tests",
            dependsOn: ["missing"],
            expectedOutputs: ["a"],
          },
        ],
      }),
    ).toThrow("Unknown work item dependency: missing");

    expect(() =>
      parseTaskCreationToolInput({
        ...validToolInput(),
        workItems: [
          { key: "a", title: "A", dependsOn: ["b"], expectedOutputs: ["a"] },
          { key: "b", title: "B", dependsOn: ["a"], expectedOutputs: ["b"] },
        ],
      }),
    ).toThrow("Work item dependencies contain a cycle");
  });

  test("accepts a valid acyclic dependency graph", () => {
    const parsed = parseTaskCreationToolInput({
      ...validToolInput(),
      workItems: [
        { key: "plan", title: "Plan", expectedOutputs: ["plan.md"] },
        {
          key: "implement",
          title: "Implement",
          dependsOn: ["plan"],
          expectedOutputs: ["tests"],
        },
      ],
      decisions: [{ question: "Scope?", resolution: "Parser only", confidence: 0.8 }],
    });

    expect(parsed.workItems.map((item) => item.key)).toEqual(["plan", "implement"]);
    expect(parsed.decisions).toEqual([
      { question: "Scope?", resolution: "Parser only", confidence: 0.8 },
    ]);
  });
});
