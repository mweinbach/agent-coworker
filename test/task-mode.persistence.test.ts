import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createTaskRouteHandlers } from "../src/server/jsonrpc/routes/tasks";
import { SessionDb } from "../src/server/sessionDb";
import { TaskCoordinator } from "../src/server/tasks/TaskCoordinator";
import type { TaskRecord, TaskStatus } from "../src/shared/tasks";

async function createHarness(
  options: {
    quiesceTaskThreads?: (task: TaskRecord, reason: "completed" | "cancelled" | "failed") => void;
  } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-mode-test-"));
  const paths = {
    rootDir: path.join(home, ".cowork"),
    sessionsDir: path.join(home, ".cowork", "sessions"),
  };
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  const sessionDb = await SessionDb.create({ paths });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const coordinator = new TaskCoordinator({
    sessionDb,
    notify: (notification) => notifications.push(notification),
    ...(options.quiesceTaskThreads
      ? {
          quiesceTaskThreads: options.quiesceTaskThreads,
        }
      : {}),
  });
  let nextThread = 1;
  coordinator.setThreadFactory(async () => ({ sessionId: `session-${++nextThread}` }));
  return {
    home,
    sessionDb,
    coordinator,
    notifications,
    workspacePath: path.join(home, "project"),
  };
}

const TERMINAL_TASK_STATUSES = [
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly TaskStatus[];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized");
      resolvePromise();
    },
  };
}

function restorePendingQuestionAfterCancellation(
  harness: Awaited<ReturnType<typeof createHarness>>,
  taskId: string,
  questionId: string,
): void {
  const db = (
    harness.sessionDb as unknown as {
      db: { query: (sql: string) => { run: (...args: unknown[]) => unknown } };
    }
  ).db;
  db.query(
    "UPDATE task_questions SET status = 'pending', resolved_at = NULL WHERE task_id = ? AND question_id = ?",
  ).run(taskId, questionId);
}

async function createWorkingTask(harness: Awaited<ReturnType<typeof createHarness>>) {
  return await harness.coordinator.createPlanned({
    workspacePath: harness.workspacePath,
    sessionId: "task-session-1",
    sourceSessionId: "source-chat-1",
    creationOrigin: "chat_tool",
    workspaceDisposition: "existing_project",
    creation: {
      idempotencyKey: `task-${crypto.randomUUID()}`,
      title: "Terminal task",
      objective: "Exercise task lifecycle guards.",
      context: "Thread creation must stop after terminal lifecycle states.",
      requirements: [
        { kind: "acceptance_criterion", text: "Terminal tasks reject new focused threads." },
      ],
      workItems: [{ key: "run", title: "Run", expectedOutputs: ["A visible result"] }],
      reviewRequired: false,
    },
  });
}

async function createReviewReadyTask(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: { reviewRequired?: boolean } = {},
) {
  const created = await harness.coordinator.createPlanned({
    workspacePath: harness.workspacePath,
    sessionId: "task-session-1",
    sourceSessionId: "source-chat-1",
    creationOrigin: "chat_tool",
    workspaceDisposition: "existing_project",
    creation: {
      idempotencyKey: `review-ready-${crypto.randomUUID()}`,
      title: "Review ready task",
      objective: "Exercise accept lifecycle.",
      context: "The work plan is already complete.",
      requirements: [
        { kind: "acceptance_criterion", text: "Accepting the task quiesces live runtimes." },
      ],
      workItems: [{ key: "run", title: "Run" }],
      reviewRequired: options.reviewRequired ?? true,
      reviewRounds: 0,
    },
  });
  const workItem = created.task.workItems[0];
  if (!workItem) throw new Error("Expected work item");
  const done = await harness.coordinator.markWorkItem({
    taskId: created.task.id,
    workspacePath: harness.workspacePath,
    workItemId: workItem.id,
    expectedRevision: created.task.revision,
    status: "done",
    completionEvidence: "All checks passed.",
    threadId: created.task.threads[0]?.id,
  });
  return await harness.coordinator.proposeCompletion({
    taskId: done.id,
    workspacePath: harness.workspacePath,
    expectedRevision: done.revision,
    summary: "Ready for delivery",
    sessionId: "task-session-1",
  });
}

async function transitionToStatus(
  harness: Awaited<ReturnType<typeof createHarness>>,
  taskId: string,
  status: (typeof TERMINAL_TASK_STATUSES)[number],
) {
  const task = harness.coordinator.get(taskId, harness.workspacePath);
  if (!task) throw new Error("Expected task");
  return await harness.coordinator.transition({
    taskId,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    status,
    summary: `Task is ${status}`,
    sessionId: "task-session-1",
  });
}

async function invokeTaskRoute(
  harness: Awaited<ReturnType<typeof createHarness>>,
  method: string,
  params: Record<string, unknown>,
  options: {
    getLive?: (threadId: string) => unknown;
  } = {},
) {
  const errors: unknown[] = [];
  const results: unknown[] = [];
  const handlers = createTaskRouteHandlers({
    tasks: harness.coordinator,
    threads: { getLive: options.getLive ?? (() => null) },
    jsonrpc: {
      sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
      sendError: (_ws: unknown, _id: unknown, error: unknown) => errors.push(error),
    },
    utils: {
      resolveWorkspacePath: () => harness.workspacePath,
      buildThreadFromSession: () => null,
    },
  } as never);
  await handlers[method]?.({} as never, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  return { errors, results };
}

describe("task mode persistence", () => {
  test("task/accept quiesces every live task runtime and ignores unrelated sessions", async () => {
    const cancellations: string[] = [];
    const disposals: string[] = [];
    const liveBindings = new Map<string, unknown>();
    const harness = await createHarness({
      quiesceTaskThreads: (task, reason) => {
        if (!task) return;
        for (const thread of task.threads) {
          const binding = liveBindings.get(thread.sessionId) as
            | {
                runtime?: {
                  turns?: { cancel?: (opts?: { includeSubagents?: boolean }) => void };
                  lifecycle?: { dispose?: (reason: string) => void };
                };
              }
            | undefined;
          try {
            binding?.runtime?.turns?.cancel?.({ includeSubagents: true });
          } catch {
            binding?.runtime?.lifecycle?.dispose?.(`task ${task.id} ${reason}`);
          }
        }
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const ready = await createReviewReadyTask(harness);
      const focusedOne = await harness.coordinator.addThread({
        taskId: ready.id,
        workspacePath: harness.workspacePath,
        expectedRevision: ready.revision,
        title: "Focused one",
        createdBy: "user",
      });
      const focusedTwo = await harness.coordinator.addThread({
        taskId: focusedOne.id,
        workspacePath: harness.workspacePath,
        expectedRevision: focusedOne.revision,
        title: "Focused two",
        createdBy: "user",
      });
      for (const thread of focusedTwo.threads) {
        liveBindings.set(thread.sessionId, {
          runtime: {
            turns: {
              cancel: (opts?: { includeSubagents?: boolean }) => {
                expect(opts).toEqual({ includeSubagents: true });
                cancellations.push(thread.sessionId);
              },
            },
            lifecycle: {
              dispose: (reason: string) => disposals.push(`${thread.sessionId}:${reason}`),
            },
          },
        });
      }
      liveBindings.set("ordinary-chat", {
        runtime: {
          turns: { cancel: () => cancellations.push("ordinary-chat") },
          lifecycle: { dispose: () => disposals.push("ordinary-chat") },
        },
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/accept", {
        cwd: harness.workspacePath,
        taskId: focusedTwo.id,
        expectedRevision: focusedTwo.revision,
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({ status: "completed" }),
        }),
      ]);
      expect(cancellations.sort()).toEqual(
        focusedTwo.threads.map((thread) => thread.sessionId).sort(),
      );
      expect(cancellations).not.toContain("ordinary-chat");
      expect(disposals).toEqual([]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task/accept continues cancelling sibling task runtimes when one cancel throws", async () => {
    const cancellations: string[] = [];
    const disposals: string[] = [];
    const liveBindings = new Map<string, unknown>();
    const harness = await createHarness({
      quiesceTaskThreads: (task, reason) => {
        if (!task) return;
        for (const thread of task.threads) {
          const binding = liveBindings.get(thread.sessionId) as
            | {
                runtime?: {
                  turns?: { cancel?: (opts?: { includeSubagents?: boolean }) => void };
                  lifecycle?: { dispose?: (reason: string) => void };
                };
              }
            | undefined;
          try {
            binding?.runtime?.turns?.cancel?.({ includeSubagents: true });
          } catch {
            binding?.runtime?.lifecycle?.dispose?.(`task ${task.id} ${reason}`);
          }
        }
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const ready = await createReviewReadyTask(harness);
      const focused = await harness.coordinator.addThread({
        taskId: ready.id,
        workspacePath: harness.workspacePath,
        expectedRevision: ready.revision,
        title: "Focused one",
        createdBy: "user",
      });
      const primarySessionId = focused.threads[0]?.sessionId;
      const focusedSessionId = focused.threads[1]?.sessionId;
      if (!primarySessionId || !focusedSessionId) throw new Error("Expected task threads");
      liveBindings.set(primarySessionId, {
        runtime: {
          turns: {
            cancel: () => {
              cancellations.push(primarySessionId);
              throw new Error("cancel failed");
            },
          },
          lifecycle: {
            dispose: (reason: string) => disposals.push(`${primarySessionId}:${reason}`),
          },
        },
      });
      liveBindings.set(focusedSessionId, {
        runtime: {
          turns: { cancel: () => cancellations.push(focusedSessionId) },
          lifecycle: {
            dispose: (reason: string) => disposals.push(`${focusedSessionId}:${reason}`),
          },
        },
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/accept", {
        cwd: harness.workspacePath,
        taskId: focused.id,
        expectedRevision: focused.revision,
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({ status: "completed" }),
        }),
      ]);
      expect(cancellations.sort()).toEqual([focusedSessionId, primarySessionId].sort());
      expect(disposals).toEqual([`${primarySessionId}:task ${focused.id} completed`]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("auto-accept quiesces task runtimes after proposal completion", async () => {
    const cancellations: string[] = [];
    const liveBindings = new Map<string, unknown>();
    const harness = await createHarness({
      quiesceTaskThreads: (task) => {
        if (!task) return;
        for (const thread of task.threads) {
          const binding = liveBindings.get(thread.sessionId) as
            | {
                runtime?: { turns?: { cancel?: (opts?: { includeSubagents?: boolean }) => void } };
              }
            | undefined;
          binding?.runtime?.turns?.cancel?.({ includeSubagents: true });
        }
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: `auto-accept-${crypto.randomUUID()}`,
          title: "Auto accept task",
          objective: "Auto-complete after proposal.",
          context: "No review is required.",
          requirements: [{ kind: "acceptance_criterion", text: "Auto accept cancels runtimes." }],
          workItems: [{ key: "run", title: "Run" }],
          reviewRequired: false,
          reviewRounds: 0,
        },
      });
      const focused = await harness.coordinator.addThread({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        title: "Focused one",
        createdBy: "user",
      });
      for (const thread of focused.threads) {
        liveBindings.set(thread.sessionId, {
          runtime: {
            turns: { cancel: () => cancellations.push(thread.sessionId) },
          },
        });
      }
      const workItem = focused.workItems[0];
      if (!workItem) throw new Error("Expected work item");
      const done = await harness.coordinator.markWorkItem({
        taskId: focused.id,
        workspacePath: harness.workspacePath,
        workItemId: workItem.id,
        expectedRevision: focused.revision,
        status: "done",
        completionEvidence: "Complete.",
        threadId: focused.threads[0]?.id,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/proposeCompletion", {
        cwd: harness.workspacePath,
        taskId: done.id,
        expectedRevision: done.revision,
        summary: "Ready for auto acceptance",
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({ status: "completed" }),
        }),
      ]);
      expect(cancellations.sort()).toEqual(done.threads.map((thread) => thread.sessionId).sort());
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task/cancel quiesces live task runtimes through the coordinator lifecycle hook", async () => {
    const cancellations: string[] = [];
    const harness = await createHarness({
      quiesceTaskThreads: (task) => {
        for (const thread of task.threads) cancellations.push(thread.sessionId);
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const focused = await harness.coordinator.addThread({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        title: "Focused one",
        createdBy: "user",
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/cancel", {
        cwd: harness.workspacePath,
        taskId: focused.id,
        expectedRevision: focused.revision,
        reason: "User stopped the task",
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({ status: "cancelled" }),
        }),
      ]);
      expect(cancellations.sort()).toEqual(
        focused.threads.map((thread) => thread.sessionId).sort(),
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("failed terminal transitions quiesce only the owning task runtimes", async () => {
    const cancellations: string[] = [];
    const harness = await createHarness({
      quiesceTaskThreads: (task) => {
        for (const thread of task.threads) cancellations.push(thread.sessionId);
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const first = await createWorkingTask(harness);
      const firstFocused = await harness.coordinator.addThread({
        taskId: first.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: first.task.revision,
        title: "Focused one",
        createdBy: "user",
      });
      const second = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "other-task-session",
        sourceSessionId: "source-chat-2",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: `other-task-${crypto.randomUUID()}`,
          title: "Other task",
          objective: "Stay untouched.",
          context: "This task should not be quiesced.",
          requirements: [{ kind: "acceptance_criterion", text: "Do not cancel this task." }],
          workItems: [{ key: "run", title: "Run" }],
          reviewRounds: 0,
        },
      });

      await harness.coordinator.transition({
        taskId: firstFocused.id,
        workspacePath: harness.workspacePath,
        expectedRevision: firstFocused.revision,
        status: "failed",
        summary: "Task failed",
      });

      expect(cancellations.sort()).toEqual(
        firstFocused.threads.map((thread) => thread.sessionId).sort(),
      );
      expect(cancellations).not.toContain("other-task-session");
      expect(harness.coordinator.get(second.task.id, harness.workspacePath)?.status).toBe(
        "working",
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("marks a task failed when its primary thread errors", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: "primary-thread-failure",
          title: "Failing task",
          objective: "Exercise task failure handling.",
          context: "The primary task run fails before any work item starts.",
          requirements: [
            { kind: "acceptance_criterion", text: "The failure is visible to the user." },
          ],
          workItems: [{ key: "run", title: "Run", expectedOutputs: ["A visible result"] }],
        },
      });

      await harness.coordinator.handleThreadOutcome(
        "task-session-1",
        "error",
        new Error("Provider rejected the request"),
      );

      const failed = harness.coordinator.get(created.task.id, harness.workspacePath);
      expect(failed?.status).toBe("failed");
      expect(failed?.activity[0]).toMatchObject({
        kind: "status_changed",
        summary: "Task run failed",
        detail: "Provider rejected the request",
      });
      expect(harness.sessionDb.getActiveTaskForSourceSession("source-chat-1")).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("retries a failed task in its existing primary thread", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: "retry-failed-task",
          title: "Retryable task",
          objective: "Continue after a provider failure.",
          context: "Existing task state and artifacts must be preserved.",
          requirements: [
            { kind: "acceptance_criterion", text: "Retry uses the original task thread." },
          ],
          workItems: [{ key: "run", title: "Run", expectedOutputs: ["A visible result"] }],
        },
      });
      await harness.coordinator.handleThreadOutcome("task-session-1", "error");
      const failed = harness.coordinator.get(created.task.id, harness.workspacePath);
      if (!failed) throw new Error("Expected failed task");

      let dispatched:
        | {
            sessionId: string;
            prompt: string;
            displayText: string;
            onFailure: (error: unknown) => Promise<void>;
          }
        | undefined;
      harness.coordinator.setContinuationDispatcher(async (input) => {
        dispatched = input;
        return "queued";
      });

      const retried = await harness.coordinator.retryTask({
        taskId: failed.id,
        workspacePath: harness.workspacePath,
        expectedRevision: failed.revision,
      });

      expect(retried.retryStatus).toBe("queued");
      expect(retried.task.status).toBe("working");
      expect(dispatched?.sessionId).toBe("task-session-1");
      expect(dispatched?.prompt).toContain("previous run failed");
      expect(retried.task.activity[0]?.summary).toBe("Task retry started");

      await dispatched?.onFailure(new Error("Retry failed too"));
      expect(harness.coordinator.get(failed.id, harness.workspacePath)?.status).toBe("failed");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("does not dispatch retry continuation when failed task recovery remains blocked", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const blocked = await harness.coordinator.reportBlocker({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        description: "Needs a user credential",
        blocking: true,
      });
      expect(blocked.status).toBe("blocked");
      const failed = await transitionToStatus(harness, created.task.id, "failed");

      let dispatched = false;
      harness.coordinator.setContinuationDispatcher(async () => {
        dispatched = true;
        return "queued";
      });

      const retried = await harness.coordinator.retryTask({
        taskId: failed.id,
        workspacePath: harness.workspacePath,
        expectedRevision: failed.revision,
      });

      expect(retried.retryStatus).toBe("failed");
      expect(retried.task.status).toBe("blocked");
      expect(retried.task.blockers[0]).toMatchObject({
        status: "active",
        blocking: true,
        description: "Needs a user credential",
      });
      expect(dispatched).toBe(false);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("recovers persisted working tasks whose primary run already errored", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        sourceSessionId: null,
        creationOrigin: "manual",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: "recover-errored-run",
          title: "Interrupted task",
          objective: "Recover the task lifecycle after restart.",
          context: "The persisted task session is already errored.",
          requirements: [{ kind: "acceptance_criterion", text: "The task becomes retryable." }],
          workItems: [{ key: "run", title: "Run", expectedOutputs: ["A visible result"] }],
        },
      });
      const createdAt = "2099-01-01T00:00:00.000Z";
      await harness.sessionDb.persistSessionMutation({
        sessionId: "task-session-1",
        eventType: "session.errored",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          executionState: "errored",
          lastMessagePreview: "Request failed",
          title: "Interrupted task",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: harness.workspacePath,
          enableMcp: false,
          backupsEnabledOverride: null,
          createdAt,
          updatedAt: createdAt,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "",
          messages: [],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      expect(created.task.status).toBe("working");
      expect(await harness.coordinator.reconcileFailedRuns()).toBe(1);
      expect(harness.coordinator.get(created.task.id, harness.workspacePath)?.status).toBe(
        "failed",
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("creates a complete working plan and locks its source chat idempotently", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const creation = {
        idempotencyKey: "planned-task-1",
        title: "Managed delivery",
        objective: "Deliver a reviewed implementation.",
        context: "The source chat established the implementation constraints.",
        requirements: [{ kind: "acceptance_criterion" as const, text: "All verification passes." }],
        workItems: [
          { key: "build", title: "Build", expectedOutputs: ["Implementation"] },
          {
            key: "verify",
            title: "Verify",
            dependsOn: ["build"],
            expectedOutputs: ["Test evidence"],
          },
        ],
      };
      const created = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation,
      });
      const retried = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "unused-retry-session",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation,
      });
      const sameKeyFromAnotherChat = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-2",
        sourceSessionId: "source-chat-2",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation,
      });

      expect(created.task.status).toBe("working");
      expect(created.task.sourceSessionId).toBe("source-chat-1");
      expect(created.task.context).toContain("source chat");
      expect(created.task.workItems).toHaveLength(2);
      expect(created.task.workItems[1]?.dependsOn).toEqual([created.task.workItems[0]?.id]);
      expect(retried.task.id).toBe(created.task.id);
      expect(sameKeyFromAnotherChat.task.id).not.toBe(created.task.id);
      expect(harness.sessionDb.getActiveTaskForSourceSession("source-chat-1")?.id).toBe(
        created.task.id,
      );
      expect(harness.notifications.some((entry) => entry.method === "task/created")).toBe(true);
      await harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        status: "cancelled",
        summary: "Cancelled by user",
      });
      expect(harness.sessionDb.getActiveTaskForSourceSession("source-chat-1")).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("persists a task independently from standard chat sessions", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Competitive analysis",
        objective: "Compare the three primary vendors.",
        sessionId: "session-1",
      });

      expect(created.status).toBe("draft");
      expect(created.threads).toHaveLength(1);
      expect(harness.sessionDb.isTaskThread("session-1")).toBe(true);
      expect(harness.coordinator.list(harness.workspacePath)).toHaveLength(1);
      expect(harness.coordinator.getContextForThread("session-1")?.objective).toBe(
        "Compare the three primary vendors.",
      );
      expect(harness.notifications.at(-1)?.method).toBe("task/updated");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects cyclic plans without partially mutating task state", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Model",
        objective: "Build and verify a model.",
        sessionId: "session-1",
      });

      await expect(
        harness.coordinator.replaceWorkItems({
          taskId: created.id,
          workspacePath: harness.workspacePath,
          expectedRevision: created.revision,
          items: [
            { id: "a", title: "A", dependsOn: ["b"] },
            { id: "b", title: "B", dependsOn: ["a"] },
          ],
        }),
      ).rejects.toThrow("cycle");

      const reloaded = harness.coordinator.get(created.id, harness.workspacePath);
      expect(reloaded?.revision).toBe(0);
      expect(reloaded?.workItems).toEqual([]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("allows concurrent threads only one claim for the same work item", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Research",
        objective: "Research in parallel.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "research", title: "Collect sources" }],
      });
      task = await harness.coordinator.addThread({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        title: "Second lane",
        createdBy: "user",
      });
      const [firstThread, secondThread] = task.threads;
      if (!firstThread || !secondThread) throw new Error("Expected two task threads");

      const results = await Promise.allSettled([
        harness.coordinator.claimWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          workItemId: "research",
          threadId: firstThread.id,
          expectedRevision: task.revision,
        }),
        harness.coordinator.claimWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          workItemId: "research",
          threadId: secondThread.id,
          expectedRevision: task.revision,
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(
        harness.coordinator.get(task.id, harness.workspacePath)?.workItems[0]?.claimedByThreadId,
      ).toBeTruthy();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("preserves work ownership when the plan is revised", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Owned plan",
        objective: "Keep concurrent work ownership stable.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "owned", title: "Owned work" }],
      });
      const mainThread = task.threads[0];
      if (!mainThread) throw new Error("Expected a main task thread");
      task = await harness.coordinator.claimWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "owned",
        threadId: mainThread.id,
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          { id: "owned", title: "Owned work, clarified" },
          { id: "next", title: "Next work", dependsOn: ["owned"] },
        ],
      });

      expect(task.workItems.find((item) => item.id === "owned")?.claimedByThreadId).toBe(
        mainThread.id,
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("moves blocking tasks back to working when the final blocker resolves", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Recoverable work",
        objective: "Recover from a blocking dependency.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      task = await harness.coordinator.reportBlocker({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        description: "Credential expired",
        blocking: true,
      });
      expect(task.status).toBe("blocked");
      const blocker = task.blockers[0];
      if (!blocker) throw new Error("Expected a blocker");

      task = await harness.coordinator.resolveBlocker({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        blockerId: blocker.id,
      });
      expect(task.status).toBe("working");
      expect(task.blockers[0]?.status).toBe("resolved");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("requires evidence and registered expected outputs before review", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    const artifactPath = path.join(harness.workspacePath, "report.md");
    await fs.writeFile(artifactPath, "# Report\n");
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Report",
        objective: "Produce a reviewed report.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "draft", title: "Draft report", expectedOutputs: ["report"] }],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      await expect(
        harness.coordinator.markWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          workItemId: "draft",
          expectedRevision: task.revision,
          status: "done",
        }),
      ).rejects.toThrow("Completion evidence");
      task = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        workItemId: "draft",
        expectedRevision: task.revision,
        status: "done",
        completionEvidence: "Draft exists and was checked.",
      });
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready",
        }),
      ).rejects.toThrow("Expected artifact");
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        workItemId: "draft",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Report ready for review",
      });

      expect(task.status).toBe("awaiting_review");
      await harness.coordinator.checkpointThread("session-1", "turn completed", "Report built");
      expect(
        harness.coordinator.get(task.id, harness.workspacePath)?.latestCheckpoint,
      ).not.toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("requires bounded independent review rounds and implemented feedback", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    const artifactPath = path.join(harness.workspacePath, "report.md");
    await fs.writeFile(artifactPath, "# Report\n");
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Reviewed report",
        objective: "Produce a report that survives independent critique.",
        sessionId: "session-1",
        reviewRounds: 2,
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "deliver", title: "Deliver report", expectedOutputs: ["report.md"] }],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      task = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "deliver",
        status: "done",
        completionEvidence: "Report generated and checked.",
      });
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        workItemId: "deliver",
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready",
        }),
      ).rejects.toThrow("2 independent review round");

      const first = await harness.coordinator.recordReview({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        sessionId: "session-1",
        expectedRevision: task.revision,
        reviewerAgentId: "reviewer-1",
        reviewerProvider: "openai",
        reviewerModel: "gpt-5.4",
        verdict: "fail",
        feedback: "The report omits the downside case.",
      });
      task = first.task;
      expect(first.round).toBe(1);
      expect(typeof first.reviewId).toBe("string");

      await expect(
        harness.coordinator.recordReview({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "session-1",
          expectedRevision: task.revision,
          reviewerAgentId: "reviewer-2",
          reviewerProvider: "google",
          reviewerModel: "gemini-3.1-pro-preview",
          verdict: "pass",
          feedback: "Looks good.",
        }),
      ).rejects.toThrow("must be addressed");

      task = await harness.coordinator.addressReview({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        sessionId: "session-1",
        expectedRevision: task.revision,
        reviewId: first.reviewId,
        implementationSummary: "Added and verified a downside scenario section.",
      });
      const second = await harness.coordinator.recordReview({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        sessionId: "session-1",
        expectedRevision: task.revision,
        reviewerAgentId: "reviewer-2",
        reviewerProvider: "google",
        reviewerModel: "gemini-3.1-pro-preview",
        verdict: "pass",
        feedback: "The downside case is present and the report meets the acceptance criteria.",
      });
      task = second.task;

      task = (
        await harness.coordinator.recordReview({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "session-1",
          expectedRevision: task.revision,
          reviewerAgentId: "reviewer-3",
          reviewerProvider: "anthropic",
          reviewerModel: "claude-opus-4-6",
          verdict: "pass",
          feedback: "Optional review round three found no regressions.",
        })
      ).task;
      task = (
        await harness.coordinator.recordReview({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "session-1",
          expectedRevision: task.revision,
          reviewerAgentId: "reviewer-4",
          reviewerProvider: "openai",
          reviewerModel: "gpt-5.4",
          verdict: "pass",
          feedback: "Optional review round four confirmed the final deliverable.",
        })
      ).task;

      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Reviewed report ready",
      });

      expect(task.status).toBe("awaiting_review");
      expect(task.activity.filter((item) => item.kind === "review_completed")).toHaveLength(4);
      expect(task.activity.filter((item) => item.kind === "review_addressed")).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("deduplicates retried agent directives", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Digest",
        objective: "Prepare a digest.",
        sessionId: "session-1",
      });
      const directive = {
        type: "report_progress" as const,
        idempotencyKey: "progress-1",
        summary: "Sources collected",
      };
      await harness.coordinator.applyDirective("session-1", directive);
      await harness.coordinator.applyDirective("session-1", directive);

      const progress = harness.coordinator
        .get(task.id, harness.workspacePath)
        ?.activity.filter((item) => item.kind === "progress_reported");
      expect(progress).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("replays an already-recorded directive idempotently after terminal completion", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const directive = {
        type: "report_progress" as const,
        idempotencyKey: "progress-before-completion",
        summary: "Final evidence recorded",
      };
      await harness.coordinator.applyDirective("task-session-1", directive);
      const completed = await transitionToStatus(harness, created.task.id, "completed");

      const replayed = await harness.coordinator.applyDirective("task-session-1", directive);

      const progress = harness.coordinator
        .get(completed.id, harness.workspacePath)
        ?.activity.filter((item) => item.kind === "progress_reported");
      expect(replayed.task.status).toBe("completed");
      expect(replayed.continuation).toBe("continue");
      expect(progress).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("serializes revisionless progress directives against terminal transitions", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    const appendStarted = deferred();
    const releaseAppend = deferred();
    const terminalAttempted = deferred();
    const originalAppendTaskActivity = harness.sessionDb.appendTaskActivity.bind(harness.sessionDb);
    const originalSetTaskStatus = harness.sessionDb.setTaskStatus.bind(harness.sessionDb);
    try {
      const created = await createWorkingTask(harness);
      const idempotencyKey = "progress-terminal-race";
      harness.sessionDb.appendTaskActivity = async (taskActivity) => {
        if (taskActivity.taskId === created.task.id && taskActivity.kind === "progress_reported") {
          appendStarted.resolve();
          await releaseAppend.promise;
        }
        return await originalAppendTaskActivity(taskActivity);
      };
      harness.sessionDb.setTaskStatus = async (input) => {
        if (input.taskId === created.task.id && input.status === "completed") {
          terminalAttempted.resolve();
        }
        return await originalSetTaskStatus(input);
      };

      const directivePromise = harness.coordinator.applyDirective("task-session-1", {
        type: "report_progress",
        idempotencyKey,
        summary: "Progress raced with terminal completion",
      });
      await appendStarted.promise;
      const terminalPromise = transitionToStatus(harness, created.task.id, "completed");
      await terminalAttempted.promise;
      releaseAppend.resolve();

      const [directiveResult] = await Promise.all([directivePromise, terminalPromise]);
      const final = harness.coordinator.get(created.task.id, harness.workspacePath);
      if (!final) throw new Error("Expected task");
      const progress = final.activity.find(
        (item) =>
          item.kind === "progress_reported" &&
          item.summary === "Progress raced with terminal completion",
      );
      const completed = final.activity.find(
        (item) => item.kind === "status_changed" && item.summary === "Task is completed",
      );
      const receiptRevision = harness.sessionDb.getTaskDirectiveReceipt(
        created.task.id,
        idempotencyKey,
      );

      expect(directiveResult.task.status).toBe("working");
      expect(final.status).toBe("completed");
      expect(progress).toBeDefined();
      expect(completed).toBeDefined();
      if (!progress || !completed) throw new Error("Expected progress and terminal activities");
      expect(progress.seq).toBeLessThan(completed.seq);
      expect(receiptRevision).not.toBeNull();
      if (receiptRevision === null) throw new Error("Expected directive receipt");
      expect(receiptRevision).toBeLessThan(final.revision);
      expect(final.latestCheckpoint?.reason).toBe("directive report_progress");
      expect(final.latestCheckpoint?.taskSnapshot.status).toBe("working");
    } finally {
      harness.sessionDb.appendTaskActivity = originalAppendTaskActivity;
      harness.sessionDb.setTaskStatus = originalSetTaskStatus;
      harness.sessionDb.close();
    }
  });

  test("skips terminal task checkpoints without mutation", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const terminal = await transitionToStatus(harness, created.task.id, "completed");
      expect(terminal.latestCheckpoint).toBeNull();

      const checkpointed = await harness.coordinator.checkpointThread(
        "task-session-1",
        "turn completed",
        "Late turn summary",
      );

      const after = harness.coordinator.get(created.task.id, harness.workspacePath);
      expect(checkpointed?.status).toBe("completed");
      expect(after?.latestCheckpoint).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const status of TERMINAL_TASK_STATUSES) {
    test(`rejects fresh late directives on ${status} tasks without mutation`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const created = await createWorkingTask(harness);
        const terminal = await transitionToStatus(harness, created.task.id, status);
        const workItem = terminal.workItems[0];
        if (!workItem) throw new Error("Expected work item");
        const activityCount = terminal.activity.length;

        await expect(
          harness.coordinator.applyDirective("task-session-1", {
            type: "report_progress",
            idempotencyKey: `late-progress-${status}`,
            summary: "Late progress after terminal state",
          }),
        ).rejects.toThrow(`Task ${terminal.id} is ${status}`);
        await expect(
          harness.coordinator.applyDirective("task-session-1", {
            type: "mark_work_item",
            idempotencyKey: `late-mark-${status}`,
            expectedRevision: terminal.revision,
            workItemId: workItem.id,
            status: "done",
            completionEvidence: "Late evidence after terminal state",
          }),
        ).rejects.toThrow(`Task ${terminal.id} is ${status}`);

        const after = harness.coordinator.get(terminal.id, harness.workspacePath);
        expect(after).toMatchObject({
          status,
          revision: terminal.revision,
        });
        expect(after?.activity).toHaveLength(activityCount);
        expect(after?.workItems[0]).toMatchObject({
          status: workItem.status,
          completionEvidence: workItem.completionEvidence,
        });
        expect(
          harness.sessionDb.getTaskDirectiveReceipt(terminal.id, `late-progress-${status}`),
        ).toBeNull();
        expect(harness.sessionDb.getTaskDirectiveReceipt(terminal.id, `late-mark-${status}`)).toBe(
          null,
        );
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("completes directly when review is explicitly disabled", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Automatic delivery",
        objective: "Finish without a review gate.",
        sessionId: "session-1",
        reviewRequired: false,
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "deliver", title: "Deliver" }],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      task = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "deliver",
        status: "done",
        completionEvidence: "Delivery verified.",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Delivered",
      });

      expect(task.status).toBe("completed");
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const status of TERMINAL_TASK_STATUSES) {
    test(`generic transitions cannot revive ${status} tasks`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const created = await createWorkingTask(harness);
        const terminal = await transitionToStatus(harness, created.task.id, status);

        await expect(
          harness.coordinator.transition({
            taskId: terminal.id,
            workspacePath: harness.workspacePath,
            expectedRevision: terminal.revision,
            status: "working",
            summary: "Implicitly revived",
          }),
        ).rejects.toThrow(`Invalid task transition: ${status} -> working`);

        expect(harness.coordinator.get(terminal.id, harness.workspacePath)).toMatchObject({
          status,
          revision: terminal.revision,
        });
      } finally {
        harness.sessionDb.close();
      }
    });

    test(`task/requestChanges rejects ${status} tasks without reopening them`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const created = await createWorkingTask(harness);
        const terminal = await transitionToStatus(harness, created.task.id, status);
        const { errors, results } = await invokeTaskRoute(harness, "task/requestChanges", {
          cwd: harness.workspacePath,
          taskId: terminal.id,
          expectedRevision: terminal.revision,
          feedback: "This must not reopen a terminal task.",
        });

        expect(results).toEqual([]);
        expect(errors).toEqual([
          expect.objectContaining({
            code: JSONRPC_ERROR_CODES.invalidRequest,
            message: expect.stringContaining("awaiting review"),
          }),
        ]);
        expect(harness.coordinator.get(terminal.id, harness.workspacePath)).toMatchObject({
          status,
          revision: terminal.revision,
        });
      } finally {
        harness.sessionDb.close();
      }
    });

    test(`rejects focused thread creation on ${status} tasks`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const created = await createWorkingTask(harness);
        const terminal = await transitionToStatus(harness, created.task.id, status);

        await expect(
          harness.coordinator.addThread({
            taskId: terminal.id,
            workspacePath: harness.workspacePath,
            expectedRevision: terminal.revision,
            title: "Late focused lane",
            createdBy: "user",
          }),
        ).rejects.toThrow(`Task ${terminal.id} is ${status}`);

        expect(harness.coordinator.get(terminal.id, harness.workspacePath)?.threads).toHaveLength(
          1,
        );
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("task/requestChanges returns an awaiting-review task to working", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const review = await harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        status: "awaiting_review",
        summary: "Ready for review",
      });
      const { errors, results } = await invokeTaskRoute(harness, "task/requestChanges", {
        cwd: harness.workspacePath,
        taskId: review.id,
        expectedRevision: review.revision,
        feedback: "Tighten the final recommendation.",
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({ status: "working" }),
        }),
      ]);
      expect(harness.coordinator.get(review.id, harness.workspacePath)?.activity[0]).toMatchObject({
        summary: "Changes requested",
        detail: "Tighten the final recommendation.",
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task/requestChanges reports a stale revision conflict before lifecycle state errors", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const review = await harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        status: "awaiting_review",
        summary: "Ready for review",
      });
      await harness.coordinator.acceptTask({
        taskId: review.id,
        workspacePath: harness.workspacePath,
        expectedRevision: review.revision,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/requestChanges", {
        cwd: harness.workspacePath,
        taskId: review.id,
        expectedRevision: review.revision,
        feedback: "A stale reviewer wants another change.",
      });

      expect(results).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          data: expect.objectContaining({
            category: "revision_conflict",
            expectedRevision: review.revision,
            currentRevision: review.revision + 1,
          }),
        }),
      ]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("allows focused thread creation after a terminal task is explicitly reopened", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const terminal = await transitionToStatus(harness, created.task.id, "completed");
      const reopened = await harness.coordinator.reopenTask({
        taskId: terminal.id,
        workspacePath: harness.workspacePath,
        expectedRevision: terminal.revision,
      });

      const updated = await harness.coordinator.addThread({
        taskId: reopened.id,
        workspacePath: harness.workspacePath,
        expectedRevision: reopened.revision,
        title: "Focused lane after reopen",
        createdBy: "user",
      });

      expect(updated.threads).toHaveLength(2);
      expect(updated.threads.at(-1)?.title).toBe("Focused lane after reopen");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("reopening a cancelled task with active blocking issues restores blocked state", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const blocked = await harness.coordinator.reportBlocker({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        description: "Needs a user credential",
        blocking: true,
      });
      expect(blocked.status).toBe("blocked");
      const cancelled = await transitionToStatus(harness, created.task.id, "cancelled");
      expect(cancelled.blockers).toEqual([
        expect.objectContaining({ description: "Needs a user credential", status: "active" }),
      ]);

      const reopened = await harness.coordinator.reopenTask({
        taskId: cancelled.id,
        workspacePath: harness.workspacePath,
        expectedRevision: cancelled.revision,
        reason: "Credential is available again",
      });
      const blocker = reopened.blockers[0];
      if (!blocker) throw new Error("Expected blocker");
      const resolved = await harness.coordinator.resolveBlocker({
        taskId: reopened.id,
        workspacePath: harness.workspacePath,
        expectedRevision: reopened.revision,
        blockerId: blocker.id,
      });

      expect(reopened.status).toBe("blocked");
      expect(resolved.status).toBe("working");
      expect(resolved.blockers[0]).toMatchObject({ status: "resolved" });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("reopening a cancelled task with pending blocking questions restores blocked state", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const requested = await harness.coordinator.requestInput({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        sessionId: "task-session-1",
        questions: [
          {
            header: "Credential",
            question: "Which credential should this task use?",
            blocking: true,
            urgency: "now",
          },
        ],
      });
      expect(requested.task.status).toBe("blocked");
      const question = requested.task.questions[0];
      if (!question) throw new Error("Expected question");
      const cancelled = await transitionToStatus(harness, created.task.id, "cancelled");
      restorePendingQuestionAfterCancellation(harness, cancelled.id, question.id);
      const persistedCancelled = harness.coordinator.get(cancelled.id, harness.workspacePath);
      expect(persistedCancelled?.questions[0]).toMatchObject({
        id: question.id,
        status: "pending",
        blocking: true,
      });

      const reopened = await harness.coordinator.reopenTask({
        taskId: cancelled.id,
        workspacePath: harness.workspacePath,
        expectedRevision: cancelled.revision,
        reason: "User can now answer",
      });
      const resolved = await harness.coordinator.resolveQuestions({
        taskId: reopened.id,
        workspacePath: harness.workspacePath,
        expectedRevision: reopened.revision,
        answers: [{ questionId: question.id, text: "Use the restored test credential." }],
      });

      expect(reopened.status).toBe("blocked");
      expect(resolved.task.status).toBe("working");
      expect(resolved.task.questions[0]).toMatchObject({ status: "answered" });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task/reopen reports stale revision conflicts before lifecycle state errors", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const terminal = await transitionToStatus(harness, created.task.id, "completed");
      await harness.coordinator.reopenTask({
        taskId: terminal.id,
        workspacePath: harness.workspacePath,
        expectedRevision: terminal.revision,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/reopen", {
        cwd: harness.workspacePath,
        taskId: terminal.id,
        expectedRevision: terminal.revision,
        reason: "Stale duplicate reopen",
      });

      expect(results).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          data: expect.objectContaining({
            category: "revision_conflict",
            expectedRevision: terminal.revision,
            currentRevision: terminal.revision + 1,
          }),
        }),
      ]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task/thread/create returns a JSON-RPC error for terminal tasks", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const terminal = await transitionToStatus(harness, created.task.id, "completed");
      const errors: unknown[] = [];
      const results: unknown[] = [];
      const handlers = createTaskRouteHandlers({
        tasks: harness.coordinator,
        threads: {
          getLive: () => {
            throw new Error("route should not create a live terminal task thread");
          },
        },
        jsonrpc: {
          sendResult: (_ws: unknown, _id: unknown, result: unknown) => {
            results.push(result);
          },
          sendError: (_ws: unknown, _id: unknown, error: unknown) => {
            errors.push(error);
          },
        },
        utils: {
          resolveWorkspacePath: () => harness.workspacePath,
          buildThreadFromSession: () => {
            throw new Error("route should not build a terminal task thread");
          },
        },
      } as never);

      await handlers["task/thread/create"]?.({} as never, {
        jsonrpc: "2.0",
        id: 1,
        method: "task/thread/create",
        params: {
          cwd: harness.workspacePath,
          taskId: terminal.id,
          expectedRevision: terminal.revision,
          title: "Late focused lane",
        },
      });

      expect(results).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: expect.stringContaining(`Task ${terminal.id} is completed`),
        }),
      ]);
      expect(harness.coordinator.get(terminal.id, harness.workspacePath)?.threads).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });
});
