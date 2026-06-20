import { describe, expect, mock, test } from "bun:test";

import { createTools } from "../../src/tools";
import { makeConfig, makeCtx, tmpDir } from "./tools.harness";

describe("task review tool", () => {
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
    const spawn = mock(async () => ({
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
    }));
    const wait = mock(async () => ({
      timedOut: false,
      mode: "all" as const,
      agents: [],
      readyAgentIds: ["reviewer-1"],
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

  test("allows an optional fourth round after the required minimum", async () => {
    const dir = await tmpDir();
    const priorActivity = [1, 2, 3].map((round) => ({
      id: `review-${round}`,
      seq: round,
      taskId: "task-1",
      threadId: "task-thread-1",
      workItemId: null,
      kind: "review_completed" as const,
      summary: `Independent review round ${round}: PASS`,
      detail: JSON.stringify({
        round,
        verdict: "pass",
        feedback: `Round ${round} passed.`,
        reviewerAgentId: `reviewer-${round}`,
        reviewerProvider: "openai",
        reviewerModel: "gpt-5.4",
      }),
      createdAt: `2026-06-19T12:0${round}:00.000Z`,
    }));
    const fourthFeedback = "Optional final check found no issues.\nVERDICT: PASS";
    const fourthActivity = {
      id: "review-4",
      seq: 4,
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
        activity: [fourthActivity, ...priorActivity],
        latestCheckpoint: null,
      },
    }));
    const spawn = mock(async () => ({
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
    }));
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
        activeThreadId: "task-thread-1",
      },
      applyTaskDirective,
      agentControl: {
        spawn,
        wait: mock(async () => ({
          timedOut: false,
          mode: "all" as const,
          agents: [],
          readyAgentIds: ["reviewer-4"],
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

    const result = await tool.execute({ expectedRevision: 4 });

    expect(spawn).toHaveBeenCalled();
    expect(applyTaskDirective).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "record_review",
        expectedRevision: 4,
        expectedMaterialFingerprint: "review-start-fingerprint-4",
      }),
    );
    expect(result).toMatchObject({ round: 4, requiredRounds: 3, verdict: "pass" });
  });
});
