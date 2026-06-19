import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";
import { TaskCoordinator } from "../src/server/tasks/TaskCoordinator";
import type { TaskRecord } from "../src/shared/tasks";

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
      expect(resolved.task.questions[0]?.answer).toBe("Internal leadership");
      expect(resolved.task.activity.some((item) => item.kind === "input_resume_failed")).toBe(true);
    } finally {
      harness.sessionDb.close();
    }
  });

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
