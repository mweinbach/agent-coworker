import { describe, expect, test } from "bun:test";

import {
  fingerprintTaskReviewMaterial,
  getPendingTaskReview,
  getPendingTaskReviewForContext,
  getPendingTaskReviewFromRecords,
  getTaskReviewRounds,
  stableStringify,
  type TaskReviewMaterialSnapshot,
} from "../../src/server/tasks/taskReviewPolicy";
import type { TaskActivity, TaskReviewRecord } from "../../src/shared/tasks";

function activity(
  overrides: Pick<TaskActivity, "id" | "seq" | "kind"> & Partial<TaskActivity>,
): TaskActivity {
  return {
    taskId: "task-1",
    threadId: "thread-1",
    workItemId: null,
    summary: overrides.kind,
    detail: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function completedDetail(overrides: {
  round: number;
  verdict: "pass" | "partial" | "fail";
  feedback?: string;
}): string {
  return JSON.stringify({
    round: overrides.round,
    verdict: overrides.verdict,
    feedback: overrides.feedback ?? "needs work",
    reviewerAgentId: "reviewer-1",
    reviewerProvider: "openai",
    reviewerModel: "gpt-5.4",
  });
}

function reviewRecord(
  overrides: Partial<TaskReviewRecord> & Pick<TaskReviewRecord, "id" | "round" | "verdict">,
): TaskReviewRecord {
  return {
    taskId: "task-1",
    feedback: "needs work",
    reviewerAgentId: "reviewer-1",
    reviewerProvider: "openai",
    reviewerModel: "gpt-5.4",
    taskRevision: 1,
    materialFingerprint: "fp",
    materialSnapshot: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    addressedAt: null,
    implementationSummary: null,
    ...overrides,
  };
}

describe("task review policy", () => {
  test("pairs completed and addressed activity by review id and ignores malformed detail", () => {
    const rounds = getTaskReviewRounds([
      activity({
        id: "review-fail",
        seq: 2,
        kind: "review_completed",
        detail: completedDetail({ round: 1, verdict: "fail" }),
      }),
      activity({
        id: "review-pass",
        seq: 1,
        kind: "review_completed",
        detail: completedDetail({ round: 1, verdict: "pass", feedback: "looks good" }),
      }),
      activity({
        id: "bad-json",
        seq: 3,
        kind: "review_completed",
        detail: "{",
      }),
      activity({
        id: "address-fail",
        seq: 4,
        kind: "review_addressed",
        detail: JSON.stringify({
          reviewId: "review-fail",
          implementationSummary: "fixed the failing path",
        }),
      }),
      activity({
        id: "address-again",
        seq: 5,
        kind: "review_addressed",
        detail: JSON.stringify({
          reviewId: "review-fail",
          implementationSummary: "duplicate should be ignored",
        }),
      }),
    ]);

    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({
      reviewId: "review-pass",
      verdict: "pass",
      addressedAt: null,
    });
    expect(rounds[1]).toMatchObject({
      reviewId: "review-fail",
      verdict: "fail",
      addressedAt: "2026-08-01T00:00:00.000Z",
      implementationSummary: "fixed the failing path",
    });
  });

  test("treats unaddressed fail or partial reviews as pending and ignores unaddressed passes", () => {
    const pending = getPendingTaskReview([
      activity({
        id: "review-pass",
        seq: 1,
        kind: "review_completed",
        detail: completedDetail({ round: 1, verdict: "pass", feedback: "ok" }),
      }),
      activity({
        id: "review-fail",
        seq: 2,
        kind: "review_completed",
        detail: completedDetail({ round: 2, verdict: "fail" }),
      }),
    ]);

    expect(pending?.reviewId).toBe("review-fail");
    expect(
      getPendingTaskReview([
        activity({
          id: "review-fail",
          seq: 1,
          kind: "review_completed",
          detail: completedDetail({ round: 1, verdict: "fail" }),
        }),
        activity({
          id: "address-fail",
          seq: 2,
          kind: "review_addressed",
          detail: JSON.stringify({
            reviewId: "review-fail",
            implementationSummary: "done",
          }),
        }),
      ]),
    ).toBeNull();
  });

  test("prefers persisted review records over activity when both are present", () => {
    const records = [reviewRecord({ id: "record-partial", round: 1, verdict: "partial" })];
    const activityStream = [
      activity({
        id: "activity-fail",
        seq: 1,
        kind: "review_completed",
        detail: completedDetail({ round: 1, verdict: "fail" }),
      }),
    ];

    expect(getPendingTaskReviewFromRecords(records)?.reviewId).toBe("record-partial");
    expect(
      getPendingTaskReviewForContext({ reviews: records, activity: activityStream })?.reviewId,
    ).toBe("record-partial");
    expect(getPendingTaskReviewForContext({ activity: activityStream })?.reviewId).toBe(
      "activity-fail",
    );
  });

  test("fingerprints review material independently of object key order", () => {
    const left: TaskReviewMaterialSnapshot = {
      schemaVersion: 1,
      objective: "Ship the report",
      context: "Use the current filing set",
      requirements: [
        { kind: "requirement", text: "Cite sources", permanence: "fixed", source: "user" },
        { kind: "constraint", text: "No PII", permanence: "fixed", source: "policy" },
      ],
      workItems: [],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
    };
    const right: TaskReviewMaterialSnapshot = {
      artifacts: [],
      blockers: [],
      context: "Use the current filing set",
      decisions: [],
      objective: "Ship the report",
      questions: [],
      requirements: [
        { source: "user", permanence: "fixed", text: "Cite sources", kind: "requirement" },
        { source: "policy", permanence: "fixed", text: "No PII", kind: "constraint" },
      ],
      schemaVersion: 1,
      workItems: [],
    };

    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(fingerprintTaskReviewMaterial(left)).toBe(fingerprintTaskReviewMaterial(right));
    expect(fingerprintTaskReviewMaterial(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
