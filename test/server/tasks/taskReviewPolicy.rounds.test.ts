import { describe, expect, test } from "bun:test";

import { getTaskReviewRoundsForContext } from "../../../src/server/tasks/taskReviewPolicy";
import type { TaskActivity, TaskReviewRecord } from "../../../src/shared/tasks";

const activityRound: TaskActivity = {
  id: "activity-1",
  seq: 1,
  taskId: "task-1",
  threadId: null,
  workItemId: null,
  kind: "review_completed",
  createdAt: "2026-09-06T00:00:00.000Z",
  summary: "activity review",
  detail: JSON.stringify({
    round: 1,
    verdict: "fail",
    feedback: "from activity",
    reviewerAgentId: "activity-agent",
    reviewerProvider: "google",
    reviewerModel: "gemini-2.5-flash",
  }),
};

const reviewRecord: TaskReviewRecord = {
  id: "review-1",
  taskId: "task-1",
  round: 2,
  verdict: "pass",
  feedback: "from reviews table",
  reviewerAgentId: "record-agent",
  reviewerProvider: "openai",
  reviewerModel: "gpt-5.4",
  taskRevision: 4,
  materialFingerprint: "abc",
  materialSnapshot: { schemaVersion: 1 },
  createdAt: "2026-09-06T00:01:00.000Z",
  addressedAt: null,
  implementationSummary: null,
};

describe("getTaskReviewRoundsForContext", () => {
  test("prefers persisted reviews over activity-derived rounds", () => {
    const rounds = getTaskReviewRoundsForContext({
      activity: [activityRound],
      reviews: [reviewRecord],
    });

    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      reviewId: "review-1",
      round: 2,
      verdict: "pass",
      feedback: "from reviews table",
      reviewerAgentId: "record-agent",
      materialFingerprint: "abc",
    });
  });

  test("falls back to activity when reviews are absent", () => {
    const rounds = getTaskReviewRoundsForContext({
      activity: [activityRound],
    });

    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      round: 1,
      verdict: "fail",
      feedback: "from activity",
      reviewerAgentId: "activity-agent",
    });
  });
});
