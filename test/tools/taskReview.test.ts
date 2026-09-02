import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  getPendingTaskReview,
  getTaskReviewRoundsForContext,
} from "../../src/server/tasks/taskReviewPolicy";
import type { AgentExecutionState, PersistentAgentSummary } from "../../src/shared/agents";
import type { TaskActivity, TaskReviewRecord } from "../../src/shared/tasks";
import { createTools } from "../../src/tools";
import { createTaskReviewTool } from "../../src/tools/taskReview";
import { makeConfig, makeCtx, tmpDir } from "./tools.harness";

function reviewRecord(round: number, overrides: Partial<TaskReviewRecord> = {}): TaskReviewRecord {
  return {
    id: `review-${round}`,
    taskId: "task-1",
    round,
    verdict: "pass",
    feedback: `Round ${round} passed.`,
    reviewerAgentId: `reviewer-${round}`,
    reviewerProvider: "openai",
    reviewerModel: "gpt-5.4",
    taskRevision: round,
    materialFingerprint: `fingerprint-${round}`,
    materialSnapshot: { round },
    createdAt: `2026-06-19T12:0${round}:00.000Z`,
    addressedAt: null,
    implementationSummary: null,
    ...overrides,
  };
}

describe("task review normalization", () => {
  test("orders durable records without mutation and selects the earliest unaddressed feedback", () => {
    const later = reviewRecord(2, {
      id: "later-review",
      verdict: "fail",
      createdAt: "2026-06-19T12:03:00.000Z",
    });
    const earlier = reviewRecord(2, { verdict: "partial" });
    const records = [later, reviewRecord(1), earlier];
    const context = { reviews: records, activity: [] };

    expect(getTaskReviewRoundsForContext(context)).toEqual(
      [records[1], earlier, later].map(({ id, taskId: _taskId, ...review }) => ({
        ...review,
        reviewId: id,
      })),
    );
    expect(records.map((review) => review.id)).toEqual(["later-review", "review-1", "review-2"]);
    expect(getPendingTaskReview(getTaskReviewRoundsForContext(context))?.reviewId).toBe("review-2");
    earlier.addressedAt = "2026-06-19T12:04:00.000Z";
    earlier.implementationSummary = "Fixed and verified the first findings.";
    expect(getPendingTaskReview(getTaskReviewRoundsForContext(context))?.reviewId).toBe(
      "later-review",
    );
    later.addressedAt = "2026-06-19T12:05:00.000Z";
    expect(getPendingTaskReview(getTaskReviewRoundsForContext(context))).toBeNull();
  });

  test("activity fallback follows sequence and ignores malformed or premature responses", () => {
    const completed: TaskActivity = {
      id: "review-1",
      seq: 2,
      taskId: "task-1",
      threadId: null,
      workItemId: null,
      kind: "review_completed",
      summary: "Review failed",
      detail: JSON.stringify({
        round: 1,
        verdict: "fail",
        feedback: "Fix the missing case.",
        reviewerAgentId: "reviewer-1",
        reviewerProvider: "openai",
        reviewerModel: "gpt-5.4",
      }),
      createdAt: "2026-06-19T12:02:00.000Z",
    };
    const response = (seq: number, implementationSummary: string): TaskActivity => ({
      ...completed,
      id: `response-${seq}`,
      seq,
      kind: "review_addressed",
      detail: JSON.stringify({ reviewId: completed.id, implementationSummary }),
      createdAt: `2026-06-19T12:0${seq}:00.000Z`,
    });
    const activity = [
      { ...completed, id: "malformed", seq: 3, detail: "not json" },
      completed,
      response(1, "Premature response"),
    ];
    expect(getPendingTaskReview(getTaskReviewRoundsForContext({ activity }))?.reviewId).toBe(
      completed.id,
    );
    activity.unshift(response(5, "Duplicate response"), response(4, "Verified implementation"));
    expect(getTaskReviewRoundsForContext({ activity })).toMatchObject([
      {
        reviewId: completed.id,
        addressedAt: "2026-06-19T12:04:00.000Z",
        implementationSummary: "Verified implementation",
      },
    ]);
    expect(getPendingTaskReview(getTaskReviewRoundsForContext({ activity }))).toBeNull();
    expect(getTaskReviewRoundsForContext({ activity, reviews: [] })).toEqual([]);
    expect(
      getPendingTaskReview(getTaskReviewRoundsForContext({ activity: [completed], reviews: [] })),
    ).toBeNull();
  });
});

describe("task review tool", () => {
  test.each([
    { executionState: "errored", feedback: "VERDICT: PASS", error: "did not complete" },
    { executionState: "closed", feedback: "VERDICT: PASS", error: "did not complete" },
    { executionState: "running", feedback: "VERDICT: PASS", error: "did not complete" },
    { executionState: "pending_init", feedback: "VERDICT: PASS", error: "did not complete" },
    { executionState: null, feedback: "VERDICT: PASS", error: "did not complete" },
    {
      executionState: "completed",
      feedback: "I finished the review, but the deliverable still needs corrections.",
      error: "valid PASS, PARTIAL, or FAIL verdict",
    },
  ] satisfies Array<{
    executionState: AgentExecutionState | null;
    feedback: string;
    error: string;
  }>)("rejects unverified reviewer result: $executionState / $feedback", async (scenario) => {
    const dir = await tmpDir();
    const reviewer: PersistentAgentSummary = {
      agentId: "reviewer-1",
      parentSessionId: "session-1",
      role: "reviewer",
      mode: "delegate",
      depth: 1,
      effectiveModel: "gpt-5.4",
      provider: "openai",
      title: "Task review",
      createdAt: "2026-06-19T12:00:00.000Z",
      updatedAt: "2026-06-19T12:01:00.000Z",
      lifecycleState: "active",
      executionState: "running",
      busy: true,
    };
    const applyTaskDirective = mock(async () => {
      throw new Error("An unverified review must not be recorded");
    });
    const close = mock(async () => ({
      ...reviewer,
      lifecycleState: "closed" as const,
      executionState: "closed" as const,
      busy: false,
    }));
    const ctx = makeCtx(dir, {
      taskContext: {
        id: "task-1",
        title: "Verify deliverable",
        objective: "Only accept complete independent reviews.",
        status: "working",
        revision: 2,
        reviewRequired: true,
        reviewRounds: 1,
        requirements: [],
        workItems: [],
        decisions: [],
        questions: [],
        blockers: [],
        artifacts: [],
        activity: [],
        activeThreadId: "task-thread-1",
      },
      getTaskReviewMaterial: async () => ({ fingerprint: "material" }),
      applyTaskDirective,
      agentControl: {
        spawn: async () => reviewer,
        wait: async () => ({
          timedOut: false,
          mode: "all",
          agents: scenario.executionState
            ? [{ ...reviewer, executionState: scenario.executionState, busy: false }]
            : [],
          readyAgentIds: [reviewer.agentId],
          erroredAgentIds: scenario.executionState === "errored" ? [reviewer.agentId] : [],
          inspections: [
            {
              agentId: reviewer.agentId,
              latestAssistantText: scenario.feedback,
              parsedReport: { status: "completed", summary: "The review ran." },
            },
          ],
        }),
        close,
        list: async () => [],
        sendInput: async () => {},
        inspect: async () => {
          throw new Error("not used");
        },
        resume: async () => reviewer,
      },
    });
    const tool = createTaskReviewTool(ctx);
    if (!tool) throw new Error("Expected reviewTask tool");

    await expect(tool.execute({ expectedRevision: 2 })).rejects.toThrow(scenario.error);
    expect(applyTaskDirective).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ agentId: reviewer.agentId });
  });

  test("runs a separate read-only reviewer and records its feedback", async () => {
    const dir = await tmpDir();
    const feedback = [
      "Findings",
      "- The downside case is missing.",
      "Verification",
      "- Read the report.",
      "Adversarial probe",
      "- Tested a revenue decline.",
      "Residual risks",
      "- Forecast sensitivity.",
      "VERDICT: FAIL",
      '<agent_report>{"status":"failed","summary":"Missing downside case"}</agent_report>',
    ].join("\n");
    const reviewer = {
      agentId: "reviewer-1",
      parentSessionId: "session-1",
      role: "reviewer" as const,
      mode: "delegate" as const,
      depth: 1,
      effectiveModel: "gpt-5.4",
      provider: "openai" as const,
      title: "Task review",
      createdAt: "2026-06-19T12:00:00.000Z",
      updatedAt: "2026-06-19T12:00:00.000Z",
      lifecycleState: "active" as const,
      executionState: "running" as const,
      busy: true,
    };
    const spawn = mock(async () => reviewer);
    const wait = mock(async () => ({
      timedOut: false,
      mode: "all" as const,
      agents: [{ ...reviewer, executionState: "completed" as const, busy: false }],
      readyAgentIds: ["reviewer-1"],
      erroredAgentIds: [],
      inspections: [
        {
          agentId: "reviewer-1",
          latestAssistantText: feedback,
          parsedReport: { status: "failed" as const, summary: "Missing downside case" },
        },
      ],
    }));
    const close = mock(async () => ({
      agentId: "reviewer-1",
      parentSessionId: "session-1",
      role: "reviewer" as const,
      mode: "delegate" as const,
      depth: 1,
      effectiveModel: "gpt-5.4",
      provider: "openai" as const,
      title: "Task review",
      createdAt: "2026-06-19T12:00:00.000Z",
      updatedAt: "2026-06-19T12:01:00.000Z",
      lifecycleState: "closed" as const,
      executionState: "closed" as const,
      busy: false,
    }));
    const applyTaskDirective = mock(async () => ({
      continuation: "continue" as const,
      task: {
        id: "task-1",
        workspacePath: dir,
        title: "Financial model",
        objective: "Build a rigorous model.",
        status: "working" as const,
        revision: 3,
        reviewRequired: true,
        reviewRounds: 3,
        createdAt: "2026-06-19T12:00:00.000Z",
        updatedAt: "2026-06-19T12:01:00.000Z",
        threadCount: 1,
        completedWorkItemCount: 1,
        totalWorkItemCount: 1,
        activeBlockerCount: 0,
        pendingQuestionCount: 0,
        blockingQuestionCount: 0,
        requirements: [],
        threads: [],
        workItems: [],
        decisions: [],
        questions: [],
        artifacts: [],
        blockers: [],
        activity: [],
        reviews: [
          {
            id: "review-1",
            taskId: "task-1",
            round: 1,
            verdict: "fail" as const,
            feedback,
            reviewerAgentId: "reviewer-1",
            reviewerProvider: "openai",
            reviewerModel: "gpt-5.4",
            taskRevision: 2,
            materialFingerprint: "review-fingerprint-1",
            materialSnapshot: { task: "snapshot" },
            createdAt: "2026-06-19T12:01:00.000Z",
            addressedAt: null,
            implementationSummary: null,
          },
        ],
        latestCheckpoint: null,
      },
    }));
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        provider: "google",
        model: "gemini-3.1-pro-preview",
        preferredChildModel: "gpt-5.4",
        preferredChildModelRef: "openai:gpt-5.4",
      }),
      sessionId: "session-1",
      getTaskReviewMaterial: async () => ({ fingerprint: "review-start-fingerprint-1" }),
      taskContext: {
        id: "task-1",
        title: "Financial model",
        objective: "Build a rigorous model.",
        status: "working",
        revision: 2,
        reviewRequired: true,
        reviewRounds: 3,
        requirements: [
          {
            id: "req-1",
            kind: "acceptance_criterion",
            text: "Includes downside scenarios.",
            source: "user",
            permanence: "fixed",
            status: "active",
            createdAt: "2026-06-19T12:00:00.000Z",
            supersedes: null,
          },
        ],
        workItems: [],
        decisions: [],
        questions: [],
        blockers: [],
        artifacts: [
          {
            id: "artifact-1",
            taskId: "task-1",
            workItemId: null,
            threadId: null,
            path: `${dir}/model.xlsx`,
            kind: "spreadsheet",
            title: "Model",
            createdBy: "session-1",
            provenance: {},
            createdAt: "2026-06-19T12:00:00.000Z",
          },
        ],
        activity: [],
        activeThreadId: "task-thread-1",
      },
      applyTaskDirective,
      agentControl: {
        spawn,
        wait,
        close,
        list: mock(async () => []),
        sendInput: mock(async () => {}),
        inspect: mock(async () => {
          throw new Error("not used");
        }),
        resume: mock(async () => {
          throw new Error("not used");
        }),
      },
    });
    const tool = createTools(ctx).reviewTask as
      | { execute: (input: unknown) => Promise<Record<string, unknown>> }
      | undefined;
    if (!tool) throw new Error("Expected reviewTask tool");

    const result = await tool.execute({
      expectedRevision: 2,
      focus: "Formula integrity and downside scenarios",
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "reviewer",
        model: "openai:gpt-5.4",
        taskType: "verify",
        contextMode: "brief",
        briefing: expect.stringContaining("Includes downside scenarios"),
      }),
    );
    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ["reviewer-1"], includeFinalMessage: true }),
    );
    expect(applyTaskDirective).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "record_review",
        expectedRevision: 2,
        expectedMaterialFingerprint: "review-start-fingerprint-1",
        reviewerAgentId: "reviewer-1",
        verdict: "fail",
        feedback,
      }),
    );
    expect(close).toHaveBeenCalledWith({ agentId: "reviewer-1" });
    expect(result).toMatchObject({
      reviewId: "review-1",
      round: 1,
      verdict: "fail",
      feedback,
      requiresImplementation: true,
      requiredRounds: 3,
    });
  });

  test.each(["activity", "records"] as const)(
    "reuses %s review rounds for an optional fourth-round briefing",
    async (source) => {
      const dir = await tmpDir();
      const priorRecords = [3, 1, 2].map((round) =>
        reviewRecord(
          round,
          round === 2
            ? {
                verdict: "partial",
                feedback: "Round 2 found a missing case.",
                addressedAt: "2026-06-19T12:03:00.000Z",
                implementationSummary: "Added and verified the missing case.",
              }
            : {},
        ),
      );
      const priorActivity: TaskActivity[] = priorRecords.map((review) => ({
        ...review,
        seq: review.round * 2,
        threadId: "task-thread-1",
        workItemId: null,
        kind: "review_completed",
        summary: `Independent review round ${review.round}: ${review.verdict}`,
        detail: JSON.stringify({
          round: review.round,
          verdict: review.verdict,
          feedback: review.feedback,
          reviewerAgentId: review.reviewerAgentId,
          reviewerProvider: review.reviewerProvider,
          reviewerModel: review.reviewerModel,
        }),
      }));
      priorActivity.unshift({
        id: "review-response-2",
        seq: 5,
        taskId: "task-1",
        threadId: "task-thread-1",
        workItemId: null,
        kind: "review_addressed",
        summary: "Addressed round 2",
        detail: JSON.stringify({
          reviewId: "review-2",
          implementationSummary: "Added and verified the missing case.",
        }),
        createdAt: "2026-06-19T12:03:00.000Z",
      });
      const fourthFeedback = "Optional final check found no issues.\nVERDICT: PASS";
      const fourthActivity = {
        id: "review-4",
        seq: 7,
        taskId: "task-1",
        threadId: "task-thread-1",
        workItemId: null,
        kind: "review_completed" as const,
        summary: "Independent review round 4: PASS",
        detail: JSON.stringify({
          round: 4,
          verdict: "pass",
          feedback: fourthFeedback,
          reviewerAgentId: "reviewer-4",
          reviewerProvider: "anthropic",
          reviewerModel: "claude-opus-4-6",
        }),
        createdAt: "2026-06-19T12:04:00.000Z",
      };
      const recordedActivity = [fourthActivity, ...priorActivity];
      const applyTaskDirective = mock(async () => ({
        continuation: "continue" as const,
        task: {
          id: "task-1",
          workspacePath: dir,
          title: "Reviewed task",
          objective: "Go beyond the minimum when useful.",
          status: "working" as const,
          revision: 5,
          reviewRequired: true,
          reviewRounds: 3,
          createdAt: "2026-06-19T12:00:00.000Z",
          updatedAt: "2026-06-19T12:04:00.000Z",
          threadCount: 1,
          completedWorkItemCount: 1,
          totalWorkItemCount: 1,
          activeBlockerCount: 0,
          pendingQuestionCount: 0,
          blockingQuestionCount: 0,
          requirements: [],
          threads: [],
          workItems: [],
          decisions: [],
          questions: [],
          artifacts: [],
          blockers: [],
          activity: recordedActivity,
          latestCheckpoint: null,
        },
      }));
      const reviewer = {
        agentId: "reviewer-4",
        parentSessionId: "session-1",
        role: "reviewer" as const,
        mode: "delegate" as const,
        depth: 1,
        effectiveModel: "claude-opus-4-6",
        provider: "anthropic" as const,
        title: "Task review",
        createdAt: "2026-06-19T12:04:00.000Z",
        updatedAt: "2026-06-19T12:04:00.000Z",
        lifecycleState: "active" as const,
        executionState: "running" as const,
        busy: true,
      };
      const spawn = mock(async () => reviewer);
      const ctx = makeCtx(dir, {
        sessionId: "session-1",
        getTaskReviewMaterial: async () => ({ fingerprint: "review-start-fingerprint-4" }),
        taskContext: {
          id: "task-1",
          title: "Reviewed task",
          objective: "Go beyond the minimum when useful.",
          status: "working",
          revision: 4,
          reviewRequired: true,
          reviewRounds: 3,
          requirements: [],
          workItems: [],
          decisions: [],
          questions: [],
          blockers: [],
          artifacts: [],
          activity: priorActivity,
          ...(source === "records" ? { reviews: priorRecords } : {}),
          activeThreadId: "task-thread-1",
        },
        applyTaskDirective,
        agentControl: {
          spawn,
          wait: mock(async () => ({
            timedOut: false,
            mode: "all" as const,
            agents: [{ ...reviewer, executionState: "completed" as const, busy: false }],
            readyAgentIds: ["reviewer-4"],
            erroredAgentIds: [],
            inspections: [{ agentId: "reviewer-4", latestAssistantText: fourthFeedback }],
          })),
          close: mock(async () => ({
            ...(await spawn()),
            lifecycleState: "closed" as const,
            executionState: "closed" as const,
            busy: false,
          })),
          list: mock(async () => []),
          sendInput: mock(async () => {}),
          inspect: mock(async () => {
            throw new Error("not used");
          }),
          resume: mock(async () => {
            throw new Error("not used");
          }),
        },
      });
      const tool = createTools(ctx).reviewTask as
        | { execute: (input: unknown) => Promise<Record<string, unknown>> }
        | undefined;
      if (!tool) throw new Error("Expected reviewTask tool");

      const iterate = spyOn(source === "records" ? priorRecords : priorActivity, Symbol.iterator);
      try {
        const result = await tool.execute({ expectedRevision: 4 });

        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            nickname: "task-review-4",
            briefing: expect.stringContaining(
              [
                "- Round 1 PASS: Round 1 passed.",
                "- Round 2 PARTIAL: Round 2 found a missing case.",
                "  Implemented response: Added and verified the missing case.",
                "- Round 3 PASS: Round 3 passed.",
              ].join("\n"),
            ),
          }),
        );
        expect(applyTaskDirective).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "record_review",
            expectedRevision: 4,
            expectedMaterialFingerprint: "review-start-fingerprint-4",
          }),
        );
        expect(result).toMatchObject({ round: 4, requiredRounds: 3, verdict: "pass" });
        expect(iterate).toHaveBeenCalledTimes(1);
        iterate.mockClear();
        if (source === "records") {
          const secondReview = priorRecords.find((review) => review.round === 2);
          if (!secondReview) throw new Error("Expected second review");
          secondReview.addressedAt = null;
        } else {
          priorActivity.shift();
        }
        const spawnCount = spawn.mock.calls.length;
        await expect(tool.execute({ expectedRevision: 4 })).rejects.toThrow(
          "Review round 2 feedback must be implemented and addressed first",
        );
        expect(spawn).toHaveBeenCalledTimes(spawnCount);
        expect(applyTaskDirective).toHaveBeenCalledTimes(1);
        expect(iterate).toHaveBeenCalledTimes(1);
      } finally {
        iterate.mockRestore();
      }
    },
  );

  test("checks the mutation gate before spawning a reviewer", async () => {
    const dir = await tmpDir();
    const spawn = mock(async () => {
      throw new Error("reviewer should not spawn");
    });
    const applyTaskDirective = mock(async () => {
      throw new Error("review should not record");
    });
    const assertCanMutate = mock(async () => {
      throw new Error("task locked");
    });
    const ctx = makeCtx(dir, {
      sessionId: "session-1",
      getTaskReviewMaterial: async () => ({ fingerprint: "review-start-fingerprint-locked" }),
      taskContext: {
        id: "task-1",
        title: "Locked task",
        objective: "Do not spawn reviewers after terminal locks.",
        status: "working",
        revision: 2,
        reviewRequired: true,
        reviewRounds: 1,
        requirements: [],
        workItems: [],
        decisions: [],
        questions: [],
        blockers: [],
        artifacts: [],
        activity: [],
        activeThreadId: "task-thread-1",
      },
      applyTaskDirective,
      assertCanMutate,
      agentControl: {
        spawn,
        wait: mock(async () => ({
          timedOut: false,
          mode: "all" as const,
          agents: [],
          readyAgentIds: [],
        })),
        close: mock(async () => ({
          agentId: "reviewer-1",
          parentSessionId: "session-1",
          role: "reviewer" as const,
          mode: "delegate" as const,
          depth: 1,
          effectiveModel: "gpt-5.4",
          provider: "openai" as const,
          title: "Task review",
          createdAt: "2026-06-19T12:00:00.000Z",
          updatedAt: "2026-06-19T12:00:00.000Z",
          lifecycleState: "closed" as const,
          executionState: "closed" as const,
          busy: false,
        })),
        list: mock(async () => []),
        sendInput: mock(async () => {}),
        inspect: mock(async () => {
          throw new Error("not used");
        }),
        resume: mock(async () => {
          throw new Error("not used");
        }),
      },
    });
    const tool = createTools(ctx).reviewTask as
      | { execute: (input: unknown) => Promise<Record<string, unknown>> }
      | undefined;
    if (!tool) throw new Error("Expected reviewTask tool");

    await expect(tool.execute({ expectedRevision: 2 })).rejects.toThrow("task locked");
    expect(assertCanMutate).toHaveBeenCalledWith("reviewTask");
    expect(spawn).not.toHaveBeenCalled();
    expect(applyTaskDirective).not.toHaveBeenCalled();
  });
});
