import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";
import { TaskCoordinator } from "../src/server/tasks/TaskCoordinator";
import { getTaskInputResumeFailure, type TaskActivity, type TaskRecord } from "../src/shared/tasks";

async function createHarness() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-questions-test-"));
  const workspacePath = path.join(home, "project");
  const paths = {
    rootDir: path.join(home, ".cowork"),
    sessionsDir: path.join(home, ".cowork", "sessions"),
  };
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  const sessionDb = await SessionDb.create({ paths });
  const coordinator = new TaskCoordinator({ sessionDb });
  coordinator.setThreadFactory(async () => ({ sessionId: crypto.randomUUID() }));
  return { coordinator, home, paths, sessionDb, workspacePath };
}

async function createWorkingTask(
  coordinator: TaskCoordinator,
  workspacePath: string,
  sessionId = "session-1",
) {
  let task = await coordinator.create({
    workspacePath,
    title: "Durable questions",
    objective: "Continue useful work while managing user decisions.",
    sessionId,
  });
  task = await coordinator.replaceWorkItems({
    taskId: task.id,
    workspacePath,
    expectedRevision: task.revision,
    items: [{ id: `deliver-${sessionId}`, title: "Deliver the result" }],
  });
  return await coordinator.transition({
    taskId: task.id,
    workspacePath,
    expectedRevision: task.revision,
    status: "working",
    summary: "Work started",
  });
}

function blockingQuestion(header: string, question: string) {
  return {
    header,
    question,
    context: "The answer changes the final output.",
    blocking: true,
    urgency: "now" as const,
    options: [
      { id: "first", label: "First option", description: "Use the first approach." },
      { id: "second", label: "Second option", description: "Use the second approach." },
    ],
    recommendedOptionId: "first",
  };
}

function nonBlockingQuestion() {
  return {
    header: "Report style",
    question: "Which report style should I use?",
    context: "The analysis can proceed with the normal project style.",
    blocking: false,
    urgency: "before_delivery" as const,
    defaultAction: "Use the normal five-page analyst brief.",
    options: [
      { id: "brief", label: "Analyst brief", description: "Keep the report concise." },
      { id: "memo", label: "Detailed memo", description: "Include full methodology." },
    ],
    recommendedOptionId: "brief",
  };
}

describe("getTaskInputResumeFailure", () => {
  const message = "Provider is unavailable";
  const resumeFailure = JSON.stringify({ kind: "input_resume_failed", message });
  const statusChanged = (seq: number, detail: string | null): TaskActivity => ({
    id: `activity-${seq}`,
    seq,
    taskId: "task-1",
    threadId: null,
    workItemId: null,
    kind: "status_changed",
    summary: "Task status changed",
    detail,
    createdAt: "2026-09-01T12:00:00.000Z",
  });

  test("reports the current structured continuation failure", () => {
    expect(
      getTaskInputResumeFailure({ status: "failed", activity: [statusChanged(1, resumeFailure)] }),
    ).toBe(message);
  });

  test("ignores historical failures after retry or completion", () => {
    for (const status of ["working", "completed", "cancelled"] as const) {
      expect(
        getTaskInputResumeFailure({ status, activity: [statusChanged(1, resumeFailure)] }),
      ).toBeNull();
    }
  });

  test("newer lifecycle changes supersede an old continuation failure", () => {
    for (const detail of [null, "An unrelated task run failed"]) {
      expect(
        getTaskInputResumeFailure({
          status: "failed",
          activity: [statusChanged(2, detail), statusChanged(1, resumeFailure)],
        }),
      ).toBeNull();
    }
  });

  test.each([
    null,
    "{invalid",
    "null",
    '{"kind":"input_resume_failed"}',
    '{"kind":"other","message":"failed"}',
  ])("ignores malformed or unrelated failure detail %s", (detail) => {
    expect(
      getTaskInputResumeFailure({ status: "failed", activity: [statusChanged(1, detail)] }),
    ).toBeNull();
  });

  test("unrelated newer activity does not hide the current continuation failure", () => {
    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [
          { ...statusChanged(3, null), kind: "progress_reported" },
          statusChanged(2, resumeFailure),
        ],
      }),
    ).toBe(message);
  });

  test("uses the highest lifecycle sequence in an unordered activity list", () => {
    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [
          statusChanged(1, resumeFailure),
          statusChanged(3, null),
          statusChanged(2, resumeFailure),
        ],
      }),
    ).toBeNull();
    expect(
      getTaskInputResumeFailure({
        status: "failed",
        activity: [statusChanged(1, null), statusChanged(3, resumeFailure), statusChanged(2, null)],
      }),
    ).toBe(message);
  });
});

describe("durable task questions", () => {
  test("installs the task question migration and indexes", async () => {
    const harness = await createHarness();
    try {
      const inspectDb = new Database(harness.sessionDb.dbPath, { create: false, strict: false });
      try {
        const migration = inspectDb
          .query("SELECT version FROM schema_migrations WHERE version = 21")
          .get() as { version: number } | null;
        const columns = (
          inspectDb.query("PRAGMA table_info(task_questions)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name);
        const indexes = (
          inspectDb.query("PRAGMA index_list(task_questions)").all() as Array<{
            name: string;
          }>
        ).map((index) => index.name);

        expect(migration?.version).toBe(21);
        expect(columns).toContain("provisional_decision_id");
        expect(columns).toContain("resolution_source");
        expect(indexes).toContain("idx_task_questions_task_status");
        expect(indexes).toContain("idx_task_questions_blocking");
      } finally {
        inspectDb.close();
      }
    } finally {
      harness.sessionDb.close();
    }
  });

  test("persists a non-blocking default and supersedes it with the user answer", async () => {
    const harness = await createHarness();
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [nonBlockingQuestion()],
      });

      expect(requested.continuation).toBe("continue");
      expect(requested.task.status).toBe("working");
      expect(requested.task.pendingQuestionCount).toBe(1);
      const question = requested.task.questions[0];
      expect(question?.status).toBe("pending");
      expect(question?.provisionalDecisionId).toBeTruthy();
      const provisional = requested.task.decisions.find(
        (decision) => decision.id === question?.provisionalDecisionId,
      );
      expect(provisional).toMatchObject({
        source: "agent",
        resolution: "Use the normal five-page analyst brief.",
        status: "active",
      });

      const resolved = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        answers: [{ questionId: question?.id ?? "", optionId: "memo" }],
      });

      expect(resolved.resumeStatus).toBe("not_needed");
      expect(resolved.task.questions[0]).toMatchObject({
        status: "answered",
        answer: "Detailed memo",
        answerOptionId: "memo",
        resolutionSource: "user",
      });
      expect(
        resolved.task.decisions.find((decision) => decision.id === provisional?.id)?.status,
      ).toBe("superseded");
      expect(
        resolved.task.decisions.find(
          (decision) => decision.source === "user" && decision.supersedes === provisional?.id,
        )?.resolution,
      ).toBe("Detailed memo");

      harness.sessionDb.close();
      const reopened = await SessionDb.create({ paths: harness.paths });
      try {
        expect(reopened.getTask(task.id)?.questions[0]?.answer).toBe("Detailed memo");
      } finally {
        reopened.close();
      }
    } finally {
      try {
        harness.sessionDb.close();
      } catch {
        // The persistence assertion closes this handle before reopening it.
      }
    }
  });

  test("keeps a task blocked until the final blocking answer and then resumes it", async () => {
    const harness = await createHarness();
    const continuation = mock(async () => "queued" as const);
    harness.coordinator.setContinuationDispatcher(continuation);
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [
          blockingQuestion("Audience", "Who is the audience?"),
          blockingQuestion("Market", "Which market is in scope?"),
        ],
      });
      const [audience, market] = requested.task.questions;
      if (!audience || !market) throw new Error("Expected two pending questions");

      expect(requested.continuation).toBe("pause_for_input");
      expect(requested.task.status).toBe("blocked");
      expect(requested.task.blockingQuestionCount).toBe(2);

      const partial = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        answers: [{ questionId: audience.id, text: "Internal leadership" }],
      });
      expect(partial.task.status).toBe("blocked");
      expect(partial.task.blockingQuestionCount).toBe(1);
      expect(partial.resumeStatus).toBe("not_needed");
      expect(continuation).not.toHaveBeenCalled();

      const completed = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: partial.task.revision,
        answers: [{ questionId: market.id, optionId: "first" }],
      });
      expect(completed.task.status).toBe("working");
      expect(completed.task.blockingQuestionCount).toBe(0);
      expect(completed.resumeStatus).toBe("queued");
      expect(continuation).toHaveBeenCalledTimes(1);
      expect(continuation.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-1" });
      expect(continuation.mock.calls[0]?.[0]?.prompt).toContain("Which market is in scope?");
      expect(continuation.mock.calls[0]?.[0]?.prompt).toContain("First option");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("does not auto-resume while an explicit blocking issue remains", async () => {
    const harness = await createHarness();
    const continuation = mock(async () => "queued" as const);
    harness.coordinator.setContinuationDispatcher(continuation);
    try {
      let task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      task = await harness.coordinator.reportBlocker({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        description: "Authentication is unavailable",
        blocking: true,
      });
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [blockingQuestion("Scope", "Which scope should I use?")],
      });
      const question = requested.task.questions[0];
      if (!question) throw new Error("Expected a pending question");

      const resolved = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        answers: [{ questionId: question.id, optionId: "first" }],
      });

      expect(resolved.task.status).toBe("blocked");
      expect(resolved.resumeStatus).toBe("not_needed");
      expect(continuation).not.toHaveBeenCalled();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("defaults non-blocking questions at delivery and rejects unresolved blocking ones", async () => {
    const harness = await createHarness();
    try {
      let task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      task = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: task.workItems[0]?.id ?? "",
        status: "done",
        completionEvidence: "Output verified.",
      });
      const nonBlocking = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [nonBlockingQuestion()],
      });
      const delivered = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: nonBlocking.task.revision,
        summary: "Ready for review",
      });
      expect(delivered.status).toBe("awaiting_review");
      expect(delivered.questions[0]).toMatchObject({
        status: "defaulted",
        answer: "Use the normal five-page analyst brief.",
        resolutionSource: "default",
      });

      let blockedTask = await createWorkingTask(
        harness.coordinator,
        harness.workspacePath,
        "session-2",
      );
      blockedTask = await harness.coordinator.markWorkItem({
        taskId: blockedTask.id,
        workspacePath: harness.workspacePath,
        expectedRevision: blockedTask.revision,
        workItemId: blockedTask.workItems[0]?.id ?? "",
        status: "done",
        completionEvidence: "Output verified.",
      });
      const blocking = await harness.coordinator.requestInput({
        taskId: blockedTask.id,
        workspacePath: harness.workspacePath,
        expectedRevision: blockedTask.revision,
        sessionId: "session-2",
        questions: [blockingQuestion("Approval", "May I deliver this version?")],
      });
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: blockedTask.id,
          workspacePath: harness.workspacePath,
          expectedRevision: blocking.task.revision,
          summary: "Ready",
        }),
      ).rejects.toThrow("unresolved blocking questions");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("dismisses pending questions when a task is cancelled", async () => {
    const harness = await createHarness();
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [blockingQuestion("Decision", "Should this continue?"), nonBlockingQuestion()],
      });
      const provisionalDecisionId = requested.task.questions.find(
        (question) => !question.blocking,
      )?.provisionalDecisionId;
      const cancelled = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        status: "cancelled",
        summary: "Task cancelled",
      });

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.pendingQuestionCount).toBe(0);
      expect(cancelled.questions[0]?.status).toBe("dismissed");
      expect(
        cancelled.decisions.find((decision) => decision.id === provisionalDecisionId)?.status,
      ).toBe("superseded");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("records a failed automatic resume without losing saved answers", async () => {
    const harness = await createHarness();
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [blockingQuestion("Audience", "Who is the audience?")],
      });
      const question = requested.task.questions[0];
      if (!question) throw new Error("Expected a pending question");

      const resolved = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        answers: [{ questionId: question.id, text: "Internal leadership" }],
      });

      expect(resolved.resumeStatus).toBe("failed");
      expect(resolved.task.status).toBe("failed");
      expect(resolved.task.questions[0]?.answer).toBe("Internal leadership");
      expect(resolved.task.activity.some((item) => item.kind === "input_resume_failed")).toBe(true);
      expect(resolved.task.activity[0]).toMatchObject({
        kind: "status_changed",
        detail: JSON.stringify({
          kind: "input_resume_failed",
          message: "Task continuation is unavailable",
        }),
      });

      harness.sessionDb.close();
      const reopened = await SessionDb.create({ paths: harness.paths });
      try {
        const coordinator = new TaskCoordinator({ sessionDb: reopened });
        const continuation = mock(async () => "queued" as const);
        coordinator.setContinuationDispatcher(continuation);
        const retried = await coordinator.retryTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: resolved.task.revision,
        });

        expect(retried.retryStatus).toBe("queued");
        expect(retried.task.status).toBe("working");
        expect(retried.task.questions).toEqual(resolved.task.questions);
        expect(retried.task.decisions).toEqual(resolved.task.decisions);
        expect(continuation).toHaveBeenCalledTimes(1);
        expect(continuation.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-1" });
        expect(continuation.mock.calls[0]?.[0]?.prompt).toContain("Internal leadership");
        expect(continuation.mock.calls[0]?.[0]?.prompt).toContain(
          "Do not re-ask resolved questions",
        );
      } finally {
        reopened.close();
      }
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const failureMode of ["callback", "throw", "failed_status", "empty_error"] as const) {
    test(`marks saved-answer continuation ${failureMode} failures retryable without holding the mutation queue`, async () => {
      const harness = await createHarness();
      harness.coordinator.setContinuationDispatcher(async (input) => {
        if (failureMode === "throw") throw new Error("Provider is unavailable");
        if (failureMode === "empty_error") throw new Error(" ");
        if (failureMode === "callback") {
          await input.onFailure(new Error("Provider is unavailable"));
        }
        return "failed";
      });
      try {
        const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
        const requested = await harness.coordinator.requestInput({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          sessionId: "session-1",
          questions: [blockingQuestion("Audience", "Who is the audience?")],
        });
        const question = requested.task.questions[0];
        if (!question) throw new Error("Expected a pending question");

        const resolved = await harness.coordinator.resolveQuestions({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: requested.task.revision,
          answers: [{ questionId: question.id, text: "Internal leadership" }],
        });

        expect(resolved.resumeStatus).toBe("failed");
        expect(resolved.task.status).toBe("failed");
        expect(resolved.task.questions[0]).toMatchObject({
          status: "answered",
          answer: "Internal leadership",
        });
        expect(
          resolved.task.decisions.filter((decision) => decision.source === "user"),
        ).toHaveLength(1);
        expect(
          resolved.task.activity.filter((item) => item.kind === "input_resume_failed"),
        ).toHaveLength(1);
        expect(JSON.parse(resolved.task.activity[0]?.detail ?? "null")).toMatchObject({
          kind: "input_resume_failed",
          message: expect.any(String),
        });
        expect(getTaskInputResumeFailure(resolved.task)).toBeTruthy();
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("late queued continuation failures become retryable without changing saved answers", async () => {
    const harness = await createHarness();
    const continuation = mock(async () => "queued" as const);
    harness.coordinator.setContinuationDispatcher(continuation);
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [blockingQuestion("Audience", "Who is the audience?")],
      });
      const question = requested.task.questions[0];
      if (!question) throw new Error("Expected a pending question");
      const resolved = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        answers: [{ questionId: question.id, text: "Internal leadership" }],
      });
      expect(resolved.resumeStatus).toBe("queued");
      const dispatch = continuation.mock.calls[0]?.[0];
      if (!dispatch) throw new Error("Expected continuation dispatch");

      await dispatch.onFailure(new Error("Queued continuation failed to start"));

      const failed = harness.coordinator.get(task.id, harness.workspacePath);
      expect(failed?.status).toBe("failed");
      expect(failed?.questions).toEqual(resolved.task.questions);
      expect(failed?.decisions).toEqual(resolved.task.decisions);
      expect(JSON.parse(failed?.activity[0]?.detail ?? "null")).toEqual({
        kind: "input_resume_failed",
        message: "Queued continuation failed to start",
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const scenario of ["answer_then_retry", "retry_then_retry", "answer_then_reopen"] as const) {
    test(`ignores an obsolete continuation failure after ${scenario}`, async () => {
      const harness = await createHarness();
      const continuation = mock(async () => "queued" as const);
      harness.coordinator.setContinuationDispatcher(continuation);
      try {
        let task = await createWorkingTask(harness.coordinator, harness.workspacePath);
        const requested = await harness.coordinator.requestInput({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          sessionId: "session-1",
          questions: [blockingQuestion("Audience", "Who is the audience?")],
        });
        const question = requested.task.questions[0];
        if (!question) throw new Error("Expected a pending question");
        task = (
          await harness.coordinator.resolveQuestions({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: requested.task.revision,
            answers: [{ questionId: question.id, text: "Internal leadership" }],
          })
        ).task;
        if (scenario === "retry_then_retry") {
          await harness.coordinator.handleThreadOutcome(
            "session-1",
            "error",
            new Error("Run failed"),
          );
          const failed = harness.coordinator.get(task.id, harness.workspacePath);
          if (!failed) throw new Error("Expected failed task");
          task = (
            await harness.coordinator.retryTask({
              taskId: task.id,
              workspacePath: harness.workspacePath,
              expectedRevision: failed.revision,
            })
          ).task;
        }
        const obsoleteDispatch = continuation.mock.calls.at(-1)?.[0];
        if (!obsoleteDispatch) throw new Error("Expected a continuation dispatch");

        task = await harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: scenario === "answer_then_reopen" ? "cancelled" : "failed",
          summary: "A separate event ended this run",
        });
        const recovery = {
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
        };
        const recovered =
          scenario === "answer_then_reopen"
            ? await harness.coordinator.reopenTask(recovery)
            : (await harness.coordinator.retryTask(recovery)).task;

        await obsoleteDispatch.onFailure(new Error("The old continuation failed late"));

        expect(harness.coordinator.get(task.id, harness.workspacePath)).toEqual(recovered);
        expect(getTaskInputResumeFailure(recovered)).toBeNull();
        if (scenario !== "answer_then_reopen") {
          const currentDispatch = continuation.mock.calls.at(-1)?.[0];
          if (!currentDispatch) throw new Error("Expected the current retry dispatch");
          await currentDispatch.onFailure(new Error("The current retry failed"));
          const failed = harness.coordinator.get(task.id, harness.workspacePath);
          expect(failed?.status).toBe("failed");
          expect(failed?.activity[0]?.detail).toBe("The current retry failed");
        }
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  for (const failureMode of ["throw", "failed_status"] as const) {
    test(`keeps a saved-answer retry failed when dispatch reports ${failureMode}`, async () => {
      const harness = await createHarness();
      try {
        const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
        const requested = await harness.coordinator.requestInput({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          sessionId: "session-1",
          questions: [blockingQuestion("Audience", "Who is the audience?")],
        });
        const question = requested.task.questions[0];
        if (!question) throw new Error("Expected a pending question");
        const resolved = await harness.coordinator.resolveQuestions({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: requested.task.revision,
          answers: [{ questionId: question.id, text: "Internal leadership" }],
        });
        harness.coordinator.setContinuationDispatcher(async () => {
          if (failureMode === "throw") throw new Error("Provider is still unavailable");
          return "failed";
        });

        const retried = await harness.coordinator.retryTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: resolved.task.revision,
        });

        expect(retried.retryStatus).toBe("failed");
        expect(retried.task.status).toBe("failed");
        expect(retried.task.questions).toEqual(resolved.task.questions);
        expect(retried.task.decisions).toEqual(resolved.task.decisions);
        expect(getTaskInputResumeFailure(retried.task)).toBeNull();
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("does not re-pause an answered idempotent input directive", async () => {
    const harness = await createHarness();
    harness.coordinator.setContinuationDispatcher(async () => "queued");
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const directive = {
        type: "request_input" as const,
        idempotencyKey: "blocking-input-1",
        expectedRevision: task.revision,
        questions: [blockingQuestion("Audience", "Who is the audience?")],
      };
      const requested = await harness.coordinator.applyDirective("session-1", directive);
      const question = requested.task.questions[0];
      if (!question) throw new Error("Expected a pending question");
      const resolved = await harness.coordinator.resolveQuestions({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: requested.task.revision,
        answers: [{ questionId: question.id, text: "Internal leadership" }],
      });

      const retried = await harness.coordinator.applyDirective("session-1", directive);

      expect(resolved.task.status).toBe("working");
      expect(retried.continuation).toBe("continue");
      expect(retried.task.questions).toHaveLength(1);
      expect(retried.task.questions[0]?.status).toBe("answered");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("does not allow lifecycle controls to bypass unresolved blocking input", async () => {
    const harness = await createHarness();
    try {
      const task = await createWorkingTask(harness.coordinator, harness.workspacePath);
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        sessionId: "session-1",
        questions: [blockingQuestion("Audience", "Who is the audience?")],
      });

      await expect(
        harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: requested.task.revision,
          status: "working",
          summary: "Bypass input",
        }),
      ).rejects.toThrow("blocking input or issues remain");
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.status).toBe("blocked");
    } finally {
      harness.sessionDb.close();
    }
  });
});
