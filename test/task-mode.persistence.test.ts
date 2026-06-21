import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createTaskRouteHandlers } from "../src/server/jsonrpc/routes/tasks";
import { SessionDb } from "../src/server/sessionDb";
import { TaskCoordinator } from "../src/server/tasks/TaskCoordinator";
import type { TaskCheckpoint, TaskRecord, TaskStatus, WorkItem } from "../src/shared/tasks";

async function createHarness(
  options: {
    quiesceTaskThreads?: (
      task: TaskRecord,
      reason: "completed" | "cancelled" | "failed",
    ) => void | Promise<void>;
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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function expectSettlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function pauseNextTaskStatusWrite(harness: Awaited<ReturnType<typeof createHarness>>) {
  const reached = deferred();
  const released = deferred();
  const original = harness.sessionDb.setTaskStatus.bind(harness.sessionDb);
  let paused = false;
  let calls = 0;
  harness.sessionDb.setTaskStatus = (async (input) => {
    calls += 1;
    if (!paused) {
      paused = true;
      reached.resolve();
      await released.promise;
    }
    return await original(input);
  }) as SessionDb["setTaskStatus"];
  return {
    reached: reached.promise,
    release: released.resolve,
    restore: () => {
      harness.sessionDb.setTaskStatus = original as SessionDb["setTaskStatus"];
    },
    get calls() {
      return calls;
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

async function createDependentWorkTask(harness: Awaited<ReturnType<typeof createHarness>>) {
  const created = await harness.coordinator.createPlanned({
    workspacePath: harness.workspacePath,
    sessionId: `task-session-${crypto.randomUUID()}`,
    sourceSessionId: `source-chat-${crypto.randomUUID()}`,
    creationOrigin: "chat_tool",
    workspaceDisposition: "existing_project",
    creation: {
      idempotencyKey: `dependent-${crypto.randomUUID()}`,
      title: "Dependent work",
      objective: "Complete work in dependency order.",
      context: "The dependent item must not advance before its prerequisite is done.",
      requirements: [{ kind: "acceptance_criterion", text: "Dependencies are respected." }],
      workItems: [
        { key: "setup", title: "Setup", expectedOutputs: ["Setup evidence"] },
        {
          key: "dependent",
          title: "Dependent",
          dependsOn: ["setup"],
          expectedOutputs: ["Dependent evidence"],
        },
      ],
      reviewRequired: false,
      reviewRounds: 0,
    },
  });
  const [setup, dependent] = created.task.workItems;
  if (!setup || !dependent) throw new Error("Expected dependent work items");
  return { task: created.task, setup, dependent };
}

async function createClaimedWorkTask(harness: Awaited<ReturnType<typeof createHarness>>) {
  const created = await harness.coordinator.createPlanned({
    workspacePath: harness.workspacePath,
    sessionId: `task-session-${crypto.randomUUID()}`,
    sourceSessionId: `source-chat-${crypto.randomUUID()}`,
    creationOrigin: "chat_tool",
    workspaceDisposition: "existing_project",
    creation: {
      idempotencyKey: `claimed-${crypto.randomUUID()}`,
      title: "Claimed work",
      objective: "Keep work item ownership isolated.",
      context: "Only the owning task thread should mutate claimed work.",
      requirements: [{ kind: "acceptance_criterion", text: "Ownership is enforced." }],
      workItems: [{ key: "run", title: "Run", expectedOutputs: ["A visible result"] }],
      reviewRequired: false,
      reviewRounds: 0,
    },
  });
  const workItem = created.task.workItems[0];
  if (!workItem) throw new Error("Expected work item");
  const primaryThread = created.task.threads[0];
  if (!primaryThread) throw new Error("Expected primary task thread");
  let task = await harness.coordinator.addThread({
    taskId: created.task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: created.task.revision,
    title: "Owner lane",
    createdBy: "user",
    workItemId: workItem.id,
  });
  task = await harness.coordinator.addThread({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    title: "Other lane",
    createdBy: "user",
  });
  const ownedItem = task.workItems.find((item) => item.id === workItem.id);
  const ownerThread = task.threads.find((thread) => thread.id === ownedItem?.assignedThreadId);
  const otherThread = task.threads.find(
    (thread) => thread.id !== primaryThread.id && thread.id !== ownerThread?.id,
  );
  if (!ownedItem || !ownerThread || !otherThread) throw new Error("Expected claimed task state");
  return { task, workItem: ownedItem, primaryThread, ownerThread, otherThread };
}

function replacementWorkItem(
  item: WorkItem,
  overrides: Partial<{
    id: string;
    title: string;
    description: string;
    status: WorkItem["status"];
    dependsOn: string[];
    expectedOutputs: string[];
  }> = {},
) {
  return {
    id: overrides.id ?? item.id,
    title: overrides.title ?? item.title,
    description: overrides.description ?? item.description,
    status: overrides.status ?? item.status,
    dependsOn: overrides.dependsOn ?? item.dependsOn,
    expectedOutputs: overrides.expectedOutputs ?? item.expectedOutputs,
  };
}

test("task coordinator rejects task IDs outside the requested workspace context", async () => {
  const harness = await createHarness();
  try {
    const { task } = await createWorkingTask(harness);
    const otherWorkspace = path.join(harness.home, "other-project");

    expect(() => harness.coordinator.get(task.id, otherWorkspace)).toThrow(
      "Task is outside the active workspace",
    );
    await expect(
      harness.coordinator.updateBrief({
        taskId: task.id,
        workspacePath: otherWorkspace,
        expectedRevision: task.revision,
        title: "Wrong workspace update",
      }),
    ).rejects.toThrow("Task is outside the active workspace");
  } finally {
    await fs.rm(harness.home, { recursive: true, force: true });
  }
});

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

async function createIndependentlyReviewedTask(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: { reviewRounds?: number; reviewRequired?: boolean } = {},
) {
  await fs.mkdir(harness.workspacePath, { recursive: true });
  const artifactPath = path.join(harness.workspacePath, `report-${crypto.randomUUID()}.md`);
  await fs.writeFile(artifactPath, "# Report\n\nInitial delivery.\n");
  let task = await harness.coordinator
    .createPlanned({
      workspacePath: harness.workspacePath,
      sessionId: "task-session-1",
      sourceSessionId: `source-chat-${crypto.randomUUID()}`,
      creationOrigin: "chat_tool",
      workspaceDisposition: "existing_project",
      creation: {
        idempotencyKey: `reviewed-${crypto.randomUUID()}`,
        title: "Reviewed task",
        objective: "Deliver a report that can be independently reviewed.",
        context: "The review gate must be tied to the material delivery state.",
        requirements: [
          { kind: "acceptance_criterion", text: "The report addresses the requested delivery." },
        ],
        workItems: [{ key: "deliver", title: "Deliver report", expectedOutputs: ["report.md"] }],
        reviewRequired: options.reviewRequired ?? true,
        reviewRounds: options.reviewRounds ?? 1,
      },
    })
    .then((result) => result.task);
  const workItem = task.workItems[0];
  if (!workItem) throw new Error("Expected review work item");
  task = await harness.coordinator.markWorkItem({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    workItemId: workItem.id,
    status: "done",
    completionEvidence: "Report was generated and checked.",
    threadId: task.threads[0]?.id,
  });
  task = await harness.coordinator.registerArtifact({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    path: artifactPath,
    title: "Report",
    kind: "markdown",
    workItemId: workItem.id,
    sessionId: "task-session-1",
  });
  return { task, artifactPath, workItemId: workItem.id };
}

async function recordPass(
  harness: Awaited<ReturnType<typeof createHarness>>,
  task: TaskRecord,
  reviewerAgentId: string,
) {
  const material = await harness.coordinator.getReviewMaterial({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
  });
  return await harness.coordinator.recordReview({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    sessionId: "task-session-1",
    expectedRevision: task.revision,
    expectedMaterialFingerprint: material.fingerprint,
    reviewerAgentId,
    reviewerProvider: "openai",
    reviewerModel: "gpt-5.5",
    verdict: "pass",
    feedback: `VERDICT: PASS\n${reviewerAgentId} verified the current delivery.`,
  });
}

async function recordFail(
  harness: Awaited<ReturnType<typeof createHarness>>,
  task: TaskRecord,
  reviewerAgentId: string,
) {
  const material = await harness.coordinator.getReviewMaterial({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
  });
  return await harness.coordinator.recordReview({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    sessionId: "task-session-1",
    expectedRevision: task.revision,
    expectedMaterialFingerprint: material.fingerprint,
    reviewerAgentId,
    reviewerProvider: "openai",
    reviewerModel: "gpt-5.5",
    verdict: "fail",
    feedback: `VERDICT: FAIL\n${reviewerAgentId} found a material acceptance gap.`,
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

  for (const terminalStatus of TERMINAL_TASK_STATUSES) {
    test(`queued stale ${terminalStatus} transition preserves the winning task revision`, async () => {
      const quiesced: string[] = [];
      const harness = await createHarness({
        quiesceTaskThreads: (task, reason) => {
          quiesced.push(`${reason}:${task.revision}`);
        },
      });
      await fs.mkdir(harness.workspacePath, { recursive: true });
      const pause = pauseNextTaskStatusWrite(harness);
      try {
        const created = await createWorkingTask(harness);
        const initial = created.task;
        const initialRevision = initial.revision;
        const winningTransition = harness.coordinator.transition({
          taskId: initial.id,
          workspacePath: harness.workspacePath,
          expectedRevision: initialRevision,
          status: "awaiting_review",
          summary: "Ready before stale terminal request",
        });
        await pause.reached;

        const staleTerminal = harness.coordinator
          .transition({
            taskId: initial.id,
            workspacePath: harness.workspacePath,
            expectedRevision: initialRevision,
            status: terminalStatus,
            summary: `Stale ${terminalStatus} request`,
          })
          .then(
            (task) => ({ ok: true as const, task }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        await flushAsyncWork();

        expect(harness.coordinator.get(initial.id, harness.workspacePath)).toMatchObject({
          status: "working",
          revision: initialRevision,
        });

        pause.release();
        const winner = await winningTransition;
        const stale = await staleTerminal;

        expect(stale.ok).toBe(false);
        if (stale.ok) throw new Error("Stale terminal transition unexpectedly succeeded");
        expect(stale.error).toBeInstanceOf(Error);
        expect((stale.error as Error).message).toBe(
          `Task revision conflict: expected ${initialRevision}, current ${winner.revision}`,
        );
        expect(harness.coordinator.get(initial.id, harness.workspacePath)).toMatchObject({
          status: "awaiting_review",
          revision: winner.revision,
        });
        expect(quiesced).toEqual([]);
        expect(
          harness.notifications.some(
            (notification) =>
              (notification.params.task as TaskRecord | undefined)?.status === terminalStatus,
          ),
        ).toBe(false);
      } finally {
        pause.restore();
        harness.sessionDb.close();
      }
    });
  }

  test("direct task mutations wait behind pending terminal quiescence", async () => {
    const quiesceEntered = deferred();
    const releaseQuiesce = deferred();
    const harness = await createHarness({
      quiesceTaskThreads: async () => {
        quiesceEntered.resolve();
        await releaseQuiesce.promise;
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const workItem = created.task.workItems[0];
      if (!workItem) throw new Error("Expected work item");
      const terminalTransition = harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        status: "cancelled",
        summary: "Cancel while direct mutations are racing",
      });
      await quiesceEntered.promise;

      const staleMark = harness.coordinator.markWorkItem({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "This mutation must not win the terminal race.",
      });
      const staleDecision = harness.coordinator.recordDecision({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        question: "Can direct mutations bypass terminal quiescence?",
        resolution: "No.",
        source: "user",
      });

      await flushAsyncWork();
      expect(harness.coordinator.get(created.task.id, harness.workspacePath)).toMatchObject({
        status: "working",
        revision: created.task.revision,
      });

      releaseQuiesce.resolve();
      const cancelled = await terminalTransition;
      const settled = await Promise.allSettled([staleMark, staleDecision]);

      expect(cancelled.status).toBe("cancelled");
      expect(settled).toEqual([
        expect.objectContaining({ status: "rejected" }),
        expect.objectContaining({ status: "rejected" }),
      ]);
      for (const result of settled) {
        if (result.status !== "rejected") throw new Error("Expected stale mutation rejection");
        expect(result.reason).toBeInstanceOf(Error);
        expect((result.reason as Error).message).toBe(
          `Task revision conflict: expected ${created.task.revision}, current ${cancelled.revision}`,
        );
      }
      const latest = harness.coordinator.get(created.task.id, harness.workspacePath);
      expect(latest?.status).toBe("cancelled");
      expect(latest?.workItems.find((item) => item.id === workItem.id)).toMatchObject({
        status: workItem.status,
        completionEvidence: workItem.completionEvidence,
      });
      expect(latest?.decisions).toHaveLength(0);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("queued stale task/cancel returns a structured revision conflict", async () => {
    const quiesced: string[] = [];
    const harness = await createHarness({
      quiesceTaskThreads: (task, reason) => {
        quiesced.push(`${reason}:${task.revision}`);
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    const pause = pauseNextTaskStatusWrite(harness);
    try {
      const created = await createWorkingTask(harness);
      const initialRevision = created.task.revision;
      const winningTransition = harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: initialRevision,
        status: "awaiting_review",
        summary: "Ready before stale route cancel",
      });
      await pause.reached;

      const staleCancel = invokeTaskRoute(harness, "task/cancel", {
        cwd: harness.workspacePath,
        taskId: created.task.id,
        expectedRevision: initialRevision,
        reason: "Client is stale",
      });
      await flushAsyncWork();

      pause.release();
      const winner = await winningTransition;
      const { errors, results } = await staleCancel;

      expect(results).toEqual([]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as { data?: unknown }).data).toEqual({
        category: "revision_conflict",
        expectedRevision: initialRevision,
        currentRevision: winner.revision,
      });
      expect(harness.coordinator.get(created.task.id, harness.workspacePath)).toMatchObject({
        status: "awaiting_review",
        revision: winner.revision,
      });
      expect(quiesced).toEqual([]);
    } finally {
      pause.restore();
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

  test("retry releases the task mutation queue before continuation failure callbacks", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      await harness.coordinator.handleThreadOutcome("task-session-1", "error");
      const failed = harness.coordinator.get(created.task.id, harness.workspacePath);
      if (!failed) throw new Error("Expected failed task");

      harness.coordinator.setContinuationDispatcher(async (input) => {
        await input.onFailure(new Error("Retry continuation failed"));
        return "failed";
      });

      const retried = await expectSettlesWithin(
        harness.coordinator.retryTask({
          taskId: failed.id,
          workspacePath: harness.workspacePath,
          expectedRevision: failed.revision,
        }),
        500,
        "retry with inline failure callback",
      );

      expect(retried.retryStatus).toBe("failed");
      expect(harness.coordinator.get(failed.id, harness.workspacePath)?.status).toBe("failed");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("retry recovery serializes with concurrent lifecycle mutations", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      await harness.coordinator.handleThreadOutcome("task-session-1", "error");
      const failed = harness.coordinator.get(created.task.id, harness.workspacePath);
      if (!failed) throw new Error("Expected failed task");
      const pausedStatusWrite = pauseNextTaskStatusWrite(harness);

      harness.coordinator.setContinuationDispatcher(async () => "queued");
      const retryPromise = harness.coordinator.retryTask({
        taskId: failed.id,
        workspacePath: harness.workspacePath,
        expectedRevision: failed.revision,
      });
      await pausedStatusWrite.reached;

      let reopenSettled = false;
      const reopenPromise = harness.coordinator
        .reopenTask({
          taskId: failed.id,
          workspacePath: harness.workspacePath,
          expectedRevision: failed.revision,
          reason: "Concurrent reopen should wait for retry recovery",
        })
        .finally(() => {
          reopenSettled = true;
        });
      await flushAsyncWork();
      expect(reopenSettled).toBe(false);

      pausedStatusWrite.release();
      const retried = await retryPromise;
      await expect(reopenPromise).rejects.toThrow(
        `Task revision conflict: expected ${failed.revision}, current ${retried.task.revision}`,
      );

      expect(retried.task.status).toBe("working");
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

  test("rejects directive plan cycles without partially mutating brief state", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Atomic plan",
        objective: "Keep the original objective.",
        sessionId: "session-1",
      });
      const beforeActivityCount = created.activity.length;

      await expect(
        harness.coordinator.applyDirective("session-1", {
          type: "update_plan",
          idempotencyKey: "cyclic-directive-plan",
          expectedRevision: created.revision,
          objective: "This objective must not persist.",
          requirements: [
            {
              kind: "acceptance_criterion",
              text: "This criterion must not persist.",
            },
          ],
          workItems: [
            { id: "a", title: "A", dependsOn: ["b"] },
            { id: "b", title: "B", dependsOn: ["a"] },
          ],
        }),
      ).rejects.toThrow("cycle");

      const current = harness.coordinator.get(created.id, harness.workspacePath);
      expect(current).toMatchObject({
        objective: created.objective,
        revision: created.revision,
      });
      expect(current?.requirements).toEqual(created.requirements);
      expect(current?.workItems).toEqual([]);
      expect(current?.activity).toHaveLength(beforeActivityCount);

      const reloadedDb = await SessionDb.create({
        paths: {
          rootDir: path.join(harness.home, ".cowork"),
          sessionsDir: path.join(harness.home, ".cowork", "sessions"),
        },
      });
      try {
        const reloaded = new TaskCoordinator({ sessionDb: reloadedDb });
        const reloadedTask = reloaded.get(created.id, harness.workspacePath);
        expect(reloadedTask).toMatchObject({
          objective: created.objective,
          revision: created.revision,
        });
        expect(reloadedTask?.requirements).toEqual(created.requirements);
        expect(reloadedTask?.workItems).toEqual([]);
        expect(reloadedTask?.activity).toHaveLength(beforeActivityCount);
      } finally {
        reloadedDb.close();
      }
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

  for (const status of ["in_progress", "review", "done"] as const) {
    test(`thread-scoped marks cannot move dependent work to ${status} before prerequisites finish`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const { task, dependent } = await createDependentWorkTask(harness);
        const primaryThread = task.threads[0];
        if (!primaryThread) throw new Error("Expected primary task thread");
        const beforeActivityCount = task.activity.length;

        await expect(
          harness.coordinator.markWorkItem({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            workItemId: dependent.id,
            status,
            ...(status === "done"
              ? { completionEvidence: "Dependent work was verified out of order." }
              : {}),
            threadId: primaryThread.id,
          }),
        ).rejects.toThrow("Work item dependency is not complete");

        const after = harness.coordinator.get(task.id, harness.workspacePath);
        expect(after).toMatchObject({ revision: task.revision });
        expect(after?.workItems.find((item) => item.id === dependent.id)).toMatchObject({
          status: dependent.status,
          completionEvidence: dependent.completionEvidence,
        });
        expect(after?.activity).toHaveLength(beforeActivityCount);
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  for (const status of ["in_progress", "review", "done"] as const) {
    test(`taskUpdate directives cannot move dependent work to ${status} before prerequisites finish`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const { task, dependent } = await createDependentWorkTask(harness);
        const sessionId = task.threads[0]?.sessionId;
        if (!sessionId) throw new Error("Expected primary task session");

        await expect(
          harness.coordinator.applyDirective(sessionId, {
            type: "mark_work_item",
            idempotencyKey: `dependent-${status}`,
            expectedRevision: task.revision,
            workItemId: dependent.id,
            status,
            ...(status === "done"
              ? { completionEvidence: "Dependent work was verified out of order." }
              : {}),
          }),
        ).rejects.toThrow("Work item dependency is not complete");

        const after = harness.coordinator.get(task.id, harness.workspacePath);
        expect(after).toMatchObject({ revision: task.revision });
        expect(after?.workItems.find((item) => item.id === dependent.id)?.status).toBe(
          dependent.status,
        );
        expect(
          harness.sessionDb.getTaskDirectiveReceipt(task.id, `dependent-${status}`),
        ).toBeNull();
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  for (const status of ["in_progress", "review", "done"] as const) {
    test(`taskUpdate update_plan cannot move dependent work to ${status} before prerequisites finish`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const created = await createDependentWorkTask(harness);
        let task = created.task;
        let dependent = created.dependent;
        if (status === "done") {
          task = await harness.coordinator.markWorkItem({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            workItemId: dependent.id,
            status: "blocked",
            completionEvidence: "Dependent evidence exists but the prerequisite is not done.",
          });
          dependent = task.workItems.find((item) => item.id === dependent.id) ?? dependent;
        }
        const sessionId = task.threads[0]?.sessionId;
        if (!sessionId) throw new Error("Expected primary task session");
        const beforeActivityCount = task.activity.length;

        await expect(
          harness.coordinator.applyDirective(sessionId, {
            type: "update_plan",
            idempotencyKey: `dependent-plan-${status}`,
            expectedRevision: task.revision,
            workItems: task.workItems.map((item) => ({
              id: item.id,
              title: item.title,
              description: item.description,
              dependsOn: item.dependsOn,
              expectedOutputs: item.expectedOutputs,
              status: item.id === dependent.id ? status : item.status,
            })),
          }),
        ).rejects.toThrow("Work item dependency is not complete");

        const after = harness.coordinator.get(task.id, harness.workspacePath);
        expect(after).toMatchObject({ revision: task.revision });
        expect(after?.workItems.find((item) => item.id === dependent.id)).toMatchObject({
          status: dependent.status,
          completionEvidence: dependent.completionEvidence,
        });
        expect(after?.activity).toHaveLength(beforeActivityCount);
        expect(
          harness.sessionDb.getTaskDirectiveReceipt(task.id, `dependent-plan-${status}`),
        ).toBeNull();
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("taskUpdate update_plan cannot remove an incomplete dependency from existing work", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, setup, dependent } = await createDependentWorkTask(harness);
      const sessionId = task.threads[0]?.sessionId;
      if (!sessionId) throw new Error("Expected primary task session");
      const beforeActivityCount = task.activity.length;

      await expect(
        harness.coordinator.applyDirective(sessionId, {
          type: "update_plan",
          idempotencyKey: "remove-incomplete-dependency",
          expectedRevision: task.revision,
          workItems: task.workItems.map((item) => ({
            id: item.id,
            title: item.title,
            description: item.description,
            dependsOn: item.id === dependent.id ? [] : item.dependsOn,
            expectedOutputs: item.expectedOutputs,
            status: item.status,
          })),
        }),
      ).rejects.toThrow(`Work item dependency is not complete: ${setup.id}`);

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: task.revision });
      expect(after?.workItems.find((item) => item.id === dependent.id)).toMatchObject({
        status: dependent.status,
        dependsOn: [setup.id],
      });
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "remove-incomplete-dependency"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate update_plan cannot remove an incomplete dependency and advance work", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, setup, dependent } = await createDependentWorkTask(harness);
      const sessionId = task.threads[0]?.sessionId;
      if (!sessionId) throw new Error("Expected primary task session");
      const beforeActivityCount = task.activity.length;

      await expect(
        harness.coordinator.applyDirective(sessionId, {
          type: "update_plan",
          idempotencyKey: "remove-incomplete-dependency-and-advance",
          expectedRevision: task.revision,
          workItems: task.workItems.map((item) => ({
            id: item.id,
            title: item.title,
            description: item.description,
            dependsOn: item.id === dependent.id ? [] : item.dependsOn,
            expectedOutputs: item.expectedOutputs,
            status: item.id === dependent.id ? "in_progress" : item.status,
          })),
        }),
      ).rejects.toThrow(`Work item dependency is not complete: ${setup.id}`);

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: task.revision });
      expect(after?.workItems.find((item) => item.id === dependent.id)).toMatchObject({
        status: dependent.status,
        dependsOn: [setup.id],
      });
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(
          task.id,
          "remove-incomplete-dependency-and-advance",
        ),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate update_plan can remove a completed dependency", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createDependentWorkTask(harness);
      const setup = created.setup;
      const dependent = created.dependent;
      const task = await harness.coordinator.markWorkItem({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        workItemId: setup.id,
        status: "done",
        completionEvidence: "Prerequisite has been completed.",
      });
      const sessionId = task.threads[0]?.sessionId;
      if (!sessionId) throw new Error("Expected primary task session");

      const updated = await harness.coordinator.applyDirective(sessionId, {
        type: "update_plan",
        idempotencyKey: "remove-completed-dependency",
        expectedRevision: task.revision,
        workItems: task.workItems.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          dependsOn: item.id === dependent.id ? [] : item.dependsOn,
          expectedOutputs: item.expectedOutputs,
          status: item.status,
        })),
      });

      expect(updated.task.workItems.find((item) => item.id === dependent.id)).toMatchObject({
        status: dependent.status,
        dependsOn: [],
      });
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "remove-completed-dependency"),
      ).not.toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate update_plan can complete a dependency and remove the edge in the same replacement", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createDependentWorkTask(harness);
      const setup = created.setup;
      const dependent = created.dependent;
      const task = await harness.coordinator.markWorkItem({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        workItemId: setup.id,
        status: "blocked",
        completionEvidence: "Prerequisite evidence is already attached.",
      });
      const sessionId = task.threads[0]?.sessionId;
      if (!sessionId) throw new Error("Expected primary task session");

      const updated = await harness.coordinator.applyDirective(sessionId, {
        type: "update_plan",
        idempotencyKey: "complete-and-remove-dependency",
        expectedRevision: task.revision,
        workItems: task.workItems.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          dependsOn: item.id === dependent.id ? [] : item.dependsOn,
          expectedOutputs: item.expectedOutputs,
          status: item.id === setup.id ? "done" : item.status,
        })),
      });

      expect(updated.task.workItems.find((item) => item.id === setup.id)).toMatchObject({
        status: "done",
        completionEvidence: "Prerequisite evidence is already attached.",
      });
      expect(updated.task.workItems.find((item) => item.id === dependent.id)).toMatchObject({
        status: dependent.status,
        dependsOn: [],
      });
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "complete-and-remove-dependency"),
      ).not.toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate update_plan cannot mark work done without completion evidence", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task } = await createWorkingTask(harness);
      const workItem = task.workItems[0];
      const sessionId = task.threads[0]?.sessionId;
      if (!workItem || !sessionId) throw new Error("Expected primary work item");
      const beforeActivityCount = task.activity.length;

      await expect(
        harness.coordinator.applyDirective(sessionId, {
          type: "update_plan",
          idempotencyKey: "plan-done-without-evidence",
          expectedRevision: task.revision,
          workItems: [
            {
              id: workItem.id,
              title: workItem.title,
              description: workItem.description,
              status: "done",
              dependsOn: workItem.dependsOn,
              expectedOutputs: workItem.expectedOutputs,
            },
          ],
        }),
      ).rejects.toThrow("Completion evidence is required");

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: task.revision });
      expect(after?.workItems[0]).toMatchObject({
        status: workItem.status,
        completionEvidence: null,
      });
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "plan-done-without-evidence"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("trusted JSON-RPC work-item marks remain explicit unthreaded overrides", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, dependent } = await createDependentWorkTask(harness);

      const { errors, results } = await invokeTaskRoute(harness, "task/workItem/mark", {
        cwd: harness.workspacePath,
        taskId: task.id,
        expectedRevision: task.revision,
        workItemId: dependent.id,
        status: "done",
        completionEvidence: "User override accepted the dependent work explicitly.",
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({
            revision: task.revision + 1,
            workItems: expect.arrayContaining([
              expect.objectContaining({
                id: dependent.id,
                status: "done",
                completionEvidence: "User override accepted the dependent work explicitly.",
              }),
            ]),
          }),
        }),
      ]);
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const status of ["blocked", "done", "abandoned"] as const) {
    test(`trusted direct graph replacement clears stale claims for ${status} overrides`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const { task, workItem, ownerThread } = await createClaimedWorkTask(harness);

        const updated = await harness.coordinator.replaceWorkItems({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          items: [
            {
              id: workItem.id,
              title: workItem.title,
              description: workItem.description,
              status,
              dependsOn: workItem.dependsOn,
              expectedOutputs: workItem.expectedOutputs,
            },
          ],
        });

        expect(updated.workItems.find((item) => item.id === workItem.id)).toMatchObject({
          status,
          assignedThreadId: ownerThread.id,
          claimedByThreadId: null,
        });
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("trusted JSON-RPC updateGraph overrides status but clears terminal claims", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread } = await createClaimedWorkTask(harness);

      const { errors, results } = await invokeTaskRoute(harness, "task/updateGraph", {
        cwd: harness.workspacePath,
        taskId: task.id,
        expectedRevision: task.revision,
        workItems: [
          {
            id: workItem.id,
            title: workItem.title,
            description: workItem.description,
            status: "done",
            dependsOn: workItem.dependsOn,
            expectedOutputs: workItem.expectedOutputs,
          },
        ],
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({
            revision: task.revision + 1,
            workItems: [
              expect.objectContaining({
                id: workItem.id,
                status: "done",
                assignedThreadId: ownerThread.id,
                claimedByThreadId: null,
              }),
            ],
          }),
        }),
      ]);
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const status of [
    "queued",
    "in_progress",
    "blocked",
    "review",
    "abandoned",
    "done",
  ] as const) {
    test(`task thread cannot mark work owned by another thread as ${status}`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
        const beforeActivityCount = task.activity.length;

        await expect(
          harness.coordinator.markWorkItem({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            workItemId: workItem.id,
            status,
            ...(status === "done" || status === "in_progress"
              ? { completionEvidence: "Evidence from the wrong thread." }
              : {}),
            threadId: otherThread.id,
          }),
        ).rejects.toThrow("Work item is owned by another task thread");

        const after = harness.coordinator.get(task.id, harness.workspacePath);
        expect(after).toMatchObject({ revision: task.revision });
        expect(after?.workItems.find((item) => item.id === workItem.id)).toMatchObject({
          status: workItem.status,
          assignedThreadId: ownerThread.id,
          claimedByThreadId: ownerThread.id,
          completionEvidence: workItem.completionEvidence,
        });
        expect(after?.activity).toHaveLength(beforeActivityCount);
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  for (const status of ["queued", "blocked", "review", "abandoned", "done"] as const) {
    test(`taskUpdate update_plan cannot mark work owned by another thread as ${status}`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
        const beforeActivityCount = task.activity.length;

        await expect(
          harness.coordinator.applyDirective(otherThread.sessionId, {
            type: "update_plan",
            idempotencyKey: `wrong-owner-plan-${status}`,
            expectedRevision: task.revision,
            workItems: [
              {
                id: workItem.id,
                title: workItem.title,
                description: workItem.description,
                status,
                dependsOn: workItem.dependsOn,
                expectedOutputs: workItem.expectedOutputs,
              },
            ],
          }),
        ).rejects.toThrow("Work item is owned by another task thread");

        const after = harness.coordinator.get(task.id, harness.workspacePath);
        expect(after).toMatchObject({ revision: task.revision });
        expect(after?.workItems.find((item) => item.id === workItem.id)).toMatchObject({
          assignedThreadId: ownerThread.id,
          claimedByThreadId: ownerThread.id,
          status: workItem.status,
          completionEvidence: null,
        });
        expect(after?.activity).toHaveLength(beforeActivityCount);
        expect(
          harness.sessionDb.getTaskDirectiveReceipt(task.id, `wrong-owner-plan-${status}`),
        ).toBeNull();
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("taskUpdate update_plan cannot delete claimed work owned by another thread", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
      const beforeActivityCount = task.activity.length;

      await expect(
        harness.coordinator.applyDirective(otherThread.sessionId, {
          type: "update_plan",
          idempotencyKey: "wrong-owner-delete-claimed",
          expectedRevision: task.revision,
          workItems: [],
        }),
      ).rejects.toThrow("Work item is owned by another task thread");

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: task.revision });
      expect(after?.workItems).toEqual([
        expect.objectContaining({
          id: workItem.id,
          assignedThreadId: ownerThread.id,
          claimedByThreadId: ownerThread.id,
          status: workItem.status,
        }),
      ]);
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "wrong-owner-delete-claimed"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate update_plan cannot delete unclaimed active work assigned to another thread", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
      const done = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "Owner finished before admin reopened the work item.",
        threadId: ownerThread.id,
      });
      const active = await harness.coordinator.replaceWorkItems({
        taskId: done.id,
        workspacePath: harness.workspacePath,
        expectedRevision: done.revision,
        items: [
          replacementWorkItem(done.workItems[0] ?? workItem, {
            status: "queued",
          }),
        ],
      });
      const activeItem = active.workItems.find((item) => item.id === workItem.id);
      if (!activeItem) throw new Error("Expected active assigned work item");
      expect(activeItem).toMatchObject({
        assignedThreadId: ownerThread.id,
        claimedByThreadId: null,
        status: "queued",
      });
      const beforeActivityCount = active.activity.length;

      await expect(
        harness.coordinator.applyDirective(otherThread.sessionId, {
          type: "update_plan",
          idempotencyKey: "wrong-owner-delete-active-unclaimed",
          expectedRevision: active.revision,
          workItems: [],
        }),
      ).rejects.toThrow("Work item is owned by another task thread");

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: active.revision });
      expect(after?.workItems).toEqual([expect.objectContaining(activeItem)]);
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "wrong-owner-delete-active-unclaimed"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const status of ["blocked", "done", "abandoned"] as const) {
    test(`taskUpdate update_plan cannot delete ${status} work assigned to another thread`, async () => {
      const harness = await createHarness();
      await fs.mkdir(harness.workspacePath, { recursive: true });
      try {
        const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
        const terminal = await harness.coordinator.markWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          workItemId: workItem.id,
          status,
          ...(status === "done"
            ? { completionEvidence: "Owner finished before the wrong-thread deletion." }
            : {}),
          threadId: ownerThread.id,
        });
        const terminalItem = terminal.workItems.find((item) => item.id === workItem.id);
        if (!terminalItem) throw new Error("Expected terminal assigned work item");
        expect(terminalItem).toMatchObject({
          assignedThreadId: ownerThread.id,
          claimedByThreadId: null,
          status,
        });
        const beforeActivityCount = terminal.activity.length;

        await expect(
          harness.coordinator.applyDirective(otherThread.sessionId, {
            type: "update_plan",
            idempotencyKey: `wrong-owner-delete-${status}`,
            expectedRevision: terminal.revision,
            workItems: [],
          }),
        ).rejects.toThrow("Work item is owned by another task thread");

        const after = harness.coordinator.get(task.id, harness.workspacePath);
        expect(after).toMatchObject({ revision: terminal.revision });
        expect(after?.workItems).toEqual([expect.objectContaining(terminalItem)]);
        expect(after?.activity).toHaveLength(beforeActivityCount);
        expect(
          harness.sessionDb.getTaskDirectiveReceipt(task.id, `wrong-owner-delete-${status}`),
        ).toBeNull();

        if (status === "done") {
          const reloadedDb = await SessionDb.create({
            paths: {
              rootDir: path.join(harness.home, ".cowork"),
              sessionsDir: path.join(harness.home, ".cowork", "sessions"),
            },
          });
          try {
            const reloaded = new TaskCoordinator({ sessionDb: reloadedDb });
            expect(reloaded.get(task.id, harness.workspacePath)?.workItems).toEqual([
              expect.objectContaining(terminalItem),
            ]);
            expect(
              reloadedDb.getTaskDirectiveReceipt(task.id, `wrong-owner-delete-${status}`),
            ).toBeNull();
          } finally {
            reloadedDb.close();
          }
        }
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("taskUpdate update_plan cannot rekey work assigned to another thread", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, primaryThread, ownerThread } = await createClaimedWorkTask(harness);
      const terminal = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: workItem.id,
        status: "blocked",
        threadId: ownerThread.id,
      });
      const terminalItem = terminal.workItems.find((item) => item.id === workItem.id);
      if (!terminalItem) throw new Error("Expected terminal assigned work item");
      const beforeActivityCount = terminal.activity.length;

      await expect(
        harness.coordinator.applyDirective(primaryThread.sessionId, {
          type: "update_plan",
          idempotencyKey: "wrong-owner-rekey-assigned",
          expectedRevision: terminal.revision,
          workItems: [
            replacementWorkItem(terminalItem, {
              id: "replacement-work-item",
              status: terminalItem.status,
            }),
          ],
        }),
      ).rejects.toThrow(/Work item is owned by another task thread|Work item must be claimed/);

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: terminal.revision });
      expect(after?.workItems).toEqual([expect.objectContaining(terminalItem)]);
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "wrong-owner-rekey-assigned"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("owning task thread can delete its assigned work through update_plan", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
      const done = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "Owner completed the work before deleting the item.",
        threadId: ownerThread.id,
      });

      const [ownerDelete, wrongThreadDelete] = await Promise.allSettled([
        harness.coordinator.applyDirective(ownerThread.sessionId, {
          type: "update_plan",
          idempotencyKey: "owner-delete-assigned",
          expectedRevision: done.revision,
          workItems: [],
        }),
        harness.coordinator.applyDirective(otherThread.sessionId, {
          type: "update_plan",
          idempotencyKey: "wrong-owner-concurrent-delete",
          expectedRevision: done.revision,
          workItems: [],
        }),
      ]);

      expect(ownerDelete.status).toBe("fulfilled");
      expect(wrongThreadDelete.status).toBe("rejected");
      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after?.workItems).toEqual([]);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "owner-delete-assigned"),
      ).not.toBeNull();
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "wrong-owner-concurrent-delete"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("primary task thread can rekey unowned work through update_plan", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task } = await createWorkingTask(harness);
      const workItem = task.workItems[0];
      const primaryThread = task.threads[0];
      if (!workItem || !primaryThread) throw new Error("Expected primary task work");

      const updated = await harness.coordinator.applyDirective(primaryThread.sessionId, {
        type: "update_plan",
        idempotencyKey: "primary-rekey-unowned",
        expectedRevision: task.revision,
        workItems: [
          replacementWorkItem(workItem, {
            id: "renamed-work-item",
          }),
        ],
      });

      expect(updated.task.workItems).toEqual([
        expect.objectContaining({
          id: "renamed-work-item",
          title: workItem.title,
          assignedThreadId: null,
          claimedByThreadId: null,
        }),
      ]);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "primary-rekey-unowned"),
      ).not.toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("trusted JSON-RPC updateGraph can delete assigned terminal work as an admin override", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread } = await createClaimedWorkTask(harness);
      const done = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "User accepted this terminal item can be removed.",
        threadId: ownerThread.id,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/updateGraph", {
        cwd: harness.workspacePath,
        taskId: task.id,
        expectedRevision: done.revision,
        workItems: [],
      });

      expect(errors).toEqual([]);
      expect(results).toEqual([
        expect.objectContaining({
          task: expect.objectContaining({
            revision: done.revision + 1,
            workItems: [],
          }),
        }),
      ]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate update_plan cannot remove active artifact revision helper work", async () => {
    const harness = await createHarness();
    try {
      const { task: reviewed } = await createIndependentlyReviewedTask(harness, {
        reviewRequired: false,
      });
      const artifact = reviewed.artifacts[0];
      const primarySessionId = reviewed.threads[0]?.sessionId;
      if (!artifact || !primarySessionId) throw new Error("Expected reviewed task artifact");
      const { task, revision } = await harness.coordinator.startArtifactRevision({
        taskId: reviewed.id,
        workspacePath: harness.workspacePath,
        expectedRevision: reviewed.revision,
        artifactId: artifact.id,
        instruction: "Revise the report.",
        title: "Revise report",
      });
      const beforeActivityCount = task.activity.length;

      await expect(
        harness.coordinator.applyDirective(primarySessionId, {
          type: "update_plan",
          idempotencyKey: "remove-active-artifact-revision",
          expectedRevision: task.revision,
          workItems: task.workItems.filter((item) => item.id !== revision.workItemId),
        }),
      ).rejects.toThrow("active artifact revision");

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: task.revision });
      expect(after?.workItems).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: revision.workItemId })]),
      );
      expect(after?.activity).toHaveLength(beforeActivityCount);
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(task.id, "remove-active-artifact-revision"),
      ).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("taskUpdate directives cannot mark work owned by another thread", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);

      await expect(
        harness.coordinator.applyDirective(otherThread.sessionId, {
          type: "mark_work_item",
          idempotencyKey: "wrong-owner-mark",
          expectedRevision: task.revision,
          workItemId: workItem.id,
          status: "done",
          completionEvidence: "Other thread tried to finish this item.",
        }),
      ).rejects.toThrow("Work item is owned by another task thread");

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: task.revision });
      expect(after?.workItems.find((item) => item.id === workItem.id)).toMatchObject({
        assignedThreadId: ownerThread.id,
        claimedByThreadId: ownerThread.id,
        status: workItem.status,
        completionEvidence: null,
      });
      expect(harness.sessionDb.getTaskDirectiveReceipt(task.id, "wrong-owner-mark")).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task thread cannot claim work still assigned to another thread after completion", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
      const done = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "Owner finished the item.",
        threadId: ownerThread.id,
      });

      await expect(
        harness.coordinator.claimWorkItem({
          taskId: done.id,
          workspacePath: harness.workspacePath,
          expectedRevision: done.revision,
          workItemId: workItem.id,
          threadId: otherThread.id,
        }),
      ).rejects.toThrow("Work item is owned by another task thread");

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: done.revision });
      expect(after?.workItems.find((item) => item.id === workItem.id)).toMatchObject({
        status: "done",
        assignedThreadId: ownerThread.id,
        claimedByThreadId: null,
        completionEvidence: "Owner finished the item.",
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("JSON-RPC claims reject work still assigned to another task thread", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const { task, workItem, ownerThread, otherThread } = await createClaimedWorkTask(harness);
      const done = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "Owner finished the item.",
        threadId: ownerThread.id,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/workItem/claim", {
        cwd: harness.workspacePath,
        taskId: done.id,
        expectedRevision: done.revision,
        workItemId: workItem.id,
        taskThreadId: otherThread.id,
      });

      expect(results).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: expect.stringContaining("owned by another task thread"),
        }),
      ]);
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.workItems[0]).toMatchObject({
        status: "done",
        assignedThreadId: ownerThread.id,
        claimedByThreadId: null,
        completionEvidence: "Owner finished the item.",
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("thread-scoped marks reject non-member and cross-task thread identities", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const first = await createWorkingTask(harness);
      const firstItem = first.task.workItems[0];
      if (!firstItem) throw new Error("Expected first work item");
      const second = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "other-task-session",
        sourceSessionId: "other-source-chat",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: `cross-task-${crypto.randomUUID()}`,
          title: "Other task",
          objective: "Stay isolated.",
          context: "Threads from this task must not mutate the first task.",
          requirements: [{ kind: "acceptance_criterion", text: "Task state is isolated." }],
          workItems: [{ key: "run", title: "Run", expectedOutputs: ["Result"] }],
          reviewRequired: false,
          reviewRounds: 0,
        },
      });
      const foreignThread = second.task.threads[0];
      if (!foreignThread) throw new Error("Expected foreign task thread");

      await expect(
        harness.coordinator.markWorkItem({
          taskId: first.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: first.task.revision,
          workItemId: firstItem.id,
          status: "done",
          completionEvidence: "Non-member evidence.",
          threadId: "missing-task-thread",
        }),
      ).rejects.toThrow("Unknown task thread");
      await expect(
        harness.coordinator.markWorkItem({
          taskId: first.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: first.task.revision,
          workItemId: firstItem.id,
          status: "done",
          completionEvidence: "Cross-task evidence.",
          threadId: foreignThread.id,
        }),
      ).rejects.toThrow("Unknown task thread");
      await expect(
        harness.coordinator.markWorkItem({
          taskId: first.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: first.task.revision,
          workItemId: firstItem.id,
          status: "done",
          completionEvidence: "Whitespace thread evidence.",
          threadId: " ",
        }),
      ).rejects.toThrow("Unknown task thread");

      const afterFirst = harness.coordinator.get(first.task.id, harness.workspacePath);
      const afterSecond = harness.coordinator.get(second.task.id, harness.workspacePath);
      expect(afterFirst).toMatchObject({ revision: first.task.revision });
      expect(afterFirst?.workItems[0]).toMatchObject({
        status: firstItem.status,
        completionEvidence: firstItem.completionEvidence,
      });
      expect(afterSecond).toMatchObject({ revision: second.task.revision });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("owning task thread and primary thread can mark their work", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const claimed = await createClaimedWorkTask(harness);
      const ownerDone = await harness.coordinator.markWorkItem({
        taskId: claimed.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: claimed.task.revision,
        workItemId: claimed.workItem.id,
        status: "done",
        completionEvidence: "Owner completed the work.",
        threadId: claimed.ownerThread.id,
      });
      expect(ownerDone.workItems.find((item) => item.id === claimed.workItem.id)).toMatchObject({
        status: "done",
        assignedThreadId: claimed.ownerThread.id,
        claimedByThreadId: null,
        completionEvidence: "Owner completed the work.",
      });

      const unclaimed = await createWorkingTask(harness);
      const unclaimedItem = unclaimed.task.workItems[0];
      const primaryThread = unclaimed.task.threads[0];
      if (!unclaimedItem || !primaryThread) throw new Error("Expected primary work item");
      const primaryDone = await harness.coordinator.applyDirective(primaryThread.sessionId, {
        type: "mark_work_item",
        idempotencyKey: "primary-unclaimed-mark",
        expectedRevision: unclaimed.task.revision,
        workItemId: unclaimedItem.id,
        status: "done",
        completionEvidence: "Primary thread completed unclaimed work.",
      });

      expect(primaryDone.task.workItems.find((item) => item.id === unclaimedItem.id)).toMatchObject(
        {
          status: "done",
          completionEvidence: "Primary thread completed unclaimed work.",
        },
      );
      expect(
        harness.sessionDb.getTaskDirectiveReceipt(unclaimed.task.id, "primary-unclaimed-mark"),
      ).not.toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("stale mark after a claim preserves ownership, status, and activity", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Race",
        objective: "Serialize claim and mark updates.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "race", title: "Race work", expectedOutputs: ["Result"] }],
      });
      task = await harness.coordinator.addThread({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        title: "Second lane",
        createdBy: "user",
      });
      const [ownerThread, otherThread] = task.threads;
      if (!ownerThread || !otherThread) throw new Error("Expected two task threads");
      const beforeActivityCount = task.activity.length;

      const claimed = await harness.coordinator.claimWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "race",
        threadId: ownerThread.id,
      });
      await expect(
        harness.coordinator.markWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          workItemId: "race",
          status: "done",
          completionEvidence: "Stale completion evidence.",
          threadId: otherThread.id,
        }),
      ).rejects.toThrow(`Task revision conflict: expected ${task.revision}, current`);

      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after).toMatchObject({ revision: claimed.revision });
      expect(after?.workItems.find((item) => item.id === "race")).toMatchObject({
        status: "in_progress",
        assignedThreadId: ownerThread.id,
        claimedByThreadId: ownerThread.id,
        completionEvidence: null,
      });
      expect(after?.activity).toHaveLength(beforeActivityCount);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("concurrent claim and stale mark serialize without partial mark mutation", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Concurrent race",
        objective: "Avoid partial ownership mutation.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "race", title: "Race work", expectedOutputs: ["Result"] }],
      });
      task = await harness.coordinator.addThread({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        title: "Second lane",
        createdBy: "user",
      });
      const [ownerThread, otherThread] = task.threads;
      if (!ownerThread || !otherThread) throw new Error("Expected two task threads");
      const beforeActivityCount = task.activity.length;

      const claim = harness.coordinator.claimWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "race",
        threadId: ownerThread.id,
      });
      const staleMark = harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "race",
        status: "done",
        completionEvidence: "Concurrent stale completion.",
        threadId: otherThread.id,
      });
      const [claimResult, markResult] = await Promise.allSettled([claim, staleMark]);

      expect(claimResult.status).toBe("fulfilled");
      expect(markResult.status).toBe("rejected");
      if (markResult.status !== "rejected") throw new Error("Expected stale mark rejection");
      expect(markResult.reason).toBeInstanceOf(Error);
      expect((markResult.reason as Error).message).toMatch(
        /Task revision conflict|owned by another task thread|must be claimed/,
      );
      const after = harness.coordinator.get(task.id, harness.workspacePath);
      expect(after?.workItems.find((item) => item.id === "race")).toMatchObject({
        status: "in_progress",
        assignedThreadId: ownerThread.id,
        claimedByThreadId: ownerThread.id,
        completionEvidence: null,
      });
      expect(after?.activity).toHaveLength(beforeActivityCount);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("JSON-RPC stale updateGraph reports conflicts without disturbing claimed work", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Route graph race",
        objective: "Expose stale graph route conflicts.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "route", title: "Route work", expectedOutputs: ["Result"] }],
      });
      const ownerThread = task.threads[0];
      if (!ownerThread) throw new Error("Expected task thread");
      const claimed = await harness.coordinator.claimWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "route",
        threadId: ownerThread.id,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/updateGraph", {
        cwd: harness.workspacePath,
        taskId: task.id,
        expectedRevision: task.revision,
        workItems: [{ id: "route", title: "Route work", status: "done" }],
      });

      expect(results).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          data: expect.objectContaining({
            category: "revision_conflict",
            expectedRevision: task.revision,
            currentRevision: claimed.revision,
          }),
        }),
      ]);
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.workItems[0]).toMatchObject({
        status: "in_progress",
        assignedThreadId: ownerThread.id,
        claimedByThreadId: ownerThread.id,
        completionEvidence: null,
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("JSON-RPC stale marks report conflicts without disturbing claimed work", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Route race",
        objective: "Expose stale route conflicts.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "route", title: "Route work", expectedOutputs: ["Result"] }],
      });
      const ownerThread = task.threads[0];
      if (!ownerThread) throw new Error("Expected task thread");
      const claimed = await harness.coordinator.claimWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "route",
        threadId: ownerThread.id,
      });

      const { errors, results } = await invokeTaskRoute(harness, "task/workItem/mark", {
        cwd: harness.workspacePath,
        taskId: task.id,
        expectedRevision: task.revision,
        workItemId: "route",
        status: "done",
        completionEvidence: "Stale JSON-RPC completion.",
      });

      expect(results).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          data: expect.objectContaining({
            category: "revision_conflict",
            expectedRevision: task.revision,
            currentRevision: claimed.revision,
          }),
        }),
      ]);
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.workItems[0]).toMatchObject({
        status: "in_progress",
        assignedThreadId: ownerThread.id,
        claimedByThreadId: ownerThread.id,
        completionEvidence: null,
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("restart preserves rejected and accepted thread ownership decisions", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const rejected = await createClaimedWorkTask(harness);
      await expect(
        harness.coordinator.markWorkItem({
          taskId: rejected.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: rejected.task.revision,
          workItemId: rejected.workItem.id,
          status: "done",
          completionEvidence: "Wrong-thread evidence.",
          threadId: rejected.otherThread.id,
        }),
      ).rejects.toThrow("Work item is owned by another task thread");

      const accepted = await createClaimedWorkTask(harness);
      const acceptedDone = await harness.coordinator.markWorkItem({
        taskId: accepted.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: accepted.task.revision,
        workItemId: accepted.workItem.id,
        status: "done",
        completionEvidence: "Owner evidence survives restart.",
        threadId: accepted.ownerThread.id,
      });

      const reloadedDb = await SessionDb.create({
        paths: {
          rootDir: path.join(harness.home, ".cowork"),
          sessionsDir: path.join(harness.home, ".cowork", "sessions"),
        },
      });
      try {
        const reloaded = new TaskCoordinator({ sessionDb: reloadedDb });
        expect(reloaded.get(rejected.task.id, harness.workspacePath)?.workItems[0]).toMatchObject({
          status: rejected.workItem.status,
          assignedThreadId: rejected.ownerThread.id,
          claimedByThreadId: rejected.ownerThread.id,
          completionEvidence: null,
        });
        expect(reloaded.get(acceptedDone.id, harness.workspacePath)?.workItems[0]).toMatchObject({
          status: "done",
          assignedThreadId: accepted.ownerThread.id,
          claimedByThreadId: null,
          completionEvidence: "Owner evidence survives restart.",
        });
      } finally {
        reloadedDb.close();
      }
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task directives cannot mutate work items from another task", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const first = await createWorkingTask(harness);
      const second = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "second-task-session",
        sourceSessionId: "second-source-chat",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation: {
          idempotencyKey: `directive-cross-task-${crypto.randomUUID()}`,
          title: "Second task",
          objective: "Stay in its own task.",
          context: "Directive work item IDs must be resolved within the current task.",
          requirements: [{ kind: "acceptance_criterion", text: "Tasks remain isolated." }],
          workItems: [{ key: "run", title: "Run", expectedOutputs: ["Result"] }],
          reviewRequired: false,
          reviewRounds: 0,
        },
      });
      const firstItem = first.task.workItems[0];
      const secondSession = second.task.threads[0]?.sessionId;
      if (!firstItem || !secondSession) throw new Error("Expected task state");

      await expect(
        harness.coordinator.applyDirective(secondSession, {
          type: "mark_work_item",
          idempotencyKey: "cross-task-work-item",
          expectedRevision: second.task.revision,
          workItemId: firstItem.id,
          status: "done",
          completionEvidence: "Cross-task completion attempt.",
        }),
      ).rejects.toThrow("Unknown work item");

      expect(harness.coordinator.get(first.task.id, harness.workspacePath)).toMatchObject({
        revision: first.task.revision,
      });
      expect(harness.coordinator.get(second.task.id, harness.workspacePath)).toMatchObject({
        revision: second.task.revision,
      });
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

  test("requires a fresh pass after an addressed optional review failure", async () => {
    const harness = await createHarness();
    try {
      let { task } = await createIndependentlyReviewedTask(harness, { reviewRounds: 2 });
      task = (await recordPass(harness, task, "reviewer-1")).task;
      task = (await recordPass(harness, task, "reviewer-2")).task;
      const failed = await recordFail(harness, task, "reviewer-3");
      task = failed.task;

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after optional review",
        }),
      ).rejects.toThrow("feedback");

      task = await harness.coordinator.addressReview({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        expectedRevision: task.revision,
        reviewId: failed.reviewId,
        implementationSummary: "Implemented and verified the optional reviewer feedback.",
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after addressed optional review",
        }),
      ).rejects.toThrow("fresh passing review");

      task = (await recordPass(harness, task, "reviewer-4")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after fresh review",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("invalidates passing reviews after artifact bytes and manifest change", async () => {
    const harness = await createHarness();
    try {
      let { task, artifactPath, workItemId } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;

      await fs.writeFile(artifactPath, "# Report\n\nMutated delivery.\n");
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report v2",
        kind: "markdown+reviewed",
        workItemId,
        sessionId: "task-session-1",
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after artifact mutation",
        }),
      ).rejects.toThrow("fresh passing review");

      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after fresh artifact review",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects completion when live artifact bytes change after a passing review", async () => {
    const harness = await createHarness();
    try {
      let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;

      await fs.writeFile(artifactPath, "# Report\n\nUnreviewed direct rewrite.\n");

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after direct artifact rewrite",
        }),
      ).rejects.toThrow("fresh passing review");
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.status).toBe("working");
      expect(
        harness.notifications.some(
          (notification) =>
            (notification.params.task as TaskRecord | undefined)?.id === task.id &&
            (notification.params.task as TaskRecord | undefined)?.status === "awaiting_review",
        ),
      ).toBe(false);

      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after reviewing recaptured bytes",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects artifact mutations between final completion hash and awaiting review write", async () => {
    const variants: Array<{
      name: string;
      mutate: (input: { artifactPath: string; siblingPath: string }) => Promise<void>;
      restoreForFreshReview?: (input: { artifactPath: string }) => Promise<void>;
    }> = [
      {
        name: "rewrite",
        mutate: async ({ artifactPath }) => {
          await fs.writeFile(artifactPath, "# Report\n\nChanged in the final proposal gap.\n");
        },
      },
      {
        name: "delete",
        mutate: async ({ artifactPath }) => {
          await fs.rm(artifactPath);
        },
        restoreForFreshReview: async ({ artifactPath }) => {
          await fs.writeFile(artifactPath, "# Report\n\nRestored after gap deletion.\n");
        },
      },
      {
        name: "path-swap",
        mutate: async ({ artifactPath, siblingPath }) => {
          await fs.rm(artifactPath);
          await fs.symlink(siblingPath, artifactPath);
        },
      },
    ];

    for (const variant of variants) {
      const harness = await createHarness();
      let originalDbClosed = false;
      const paths = {
        rootDir: path.join(harness.home, ".cowork"),
        sessionsDir: path.join(harness.home, ".cowork", "sessions"),
      };
      const originalSetTaskStatus = harness.sessionDb.setTaskStatus.bind(harness.sessionDb);
      try {
        let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
        const siblingPath = path.join(harness.workspacePath, `sibling-${variant.name}.md`);
        await fs.writeFile(siblingPath, "# Sibling\n\nUnreviewed swapped bytes.\n");
        task = (await recordPass(harness, task, "reviewer-1")).task;

        let mutated = false;
        const leakedSummary = `Ready during final gap ${variant.name}`;
        harness.sessionDb.setTaskStatus = (async (input) => {
          if (!mutated && input.taskId === task.id && input.status === "awaiting_review") {
            mutated = true;
            await variant.mutate({ artifactPath, siblingPath });
          }
          return await originalSetTaskStatus(input);
        }) as SessionDb["setTaskStatus"];

        await expect(
          harness.coordinator.proposeCompletion({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            summary: leakedSummary,
          }),
        ).rejects.toThrow();
        expect(mutated).toBe(true);

        const current = harness.coordinator.get(task.id, harness.workspacePath);
        expect(current?.status).toBe("working");
        expect(current?.revision).toBe(task.revision);
        expect(
          harness.notifications.some(
            (notification) =>
              (notification.params.task as TaskRecord | undefined)?.id === task.id &&
              (notification.params.task as TaskRecord | undefined)?.status === "awaiting_review",
          ),
        ).toBe(false);
        expect(
          current?.activity.some(
            (entry) => entry.kind === "status_changed" && entry.summary === leakedSummary,
          ),
        ).toBe(false);
        expect(current?.activity.some((entry) => entry.kind === "artifact_version_accepted")).toBe(
          false,
        );
        const rejectedDetail = harness.sessionDb.getTaskArtifactDetail(
          task.id,
          task.artifacts[0]?.id ?? "",
        );
        expect(rejectedDetail?.acceptedVersionId).toBeNull();
        expect(
          rejectedDetail?.versions.filter((version) => version.reviewStatus === "accepted"),
        ).toHaveLength(0);

        harness.sessionDb.setTaskStatus = originalSetTaskStatus as SessionDb["setTaskStatus"];
        harness.sessionDb.close();
        originalDbClosed = true;

        const reloadedDb = await SessionDb.create({ paths });
        const reloaded = new TaskCoordinator({ sessionDb: reloadedDb });
        try {
          let reloadedTask = reloaded.get(task.id, harness.workspacePath);
          expect(reloadedTask?.status).toBe("working");
          expect(
            reloadedTask?.activity.some(
              (entry) => entry.kind === "status_changed" && entry.summary === leakedSummary,
            ),
          ).toBe(false);
          if (!reloadedTask) throw new Error("Expected task after proposal race reload");
          await variant.restoreForFreshReview?.({ artifactPath });
          reloadedTask = await reloaded.registerArtifact({
            taskId: reloadedTask.id,
            workspacePath: harness.workspacePath,
            expectedRevision: reloadedTask.revision,
            path: artifactPath,
            title: "Report",
            kind: "markdown",
            sessionId: "task-session-1",
          });
          reloadedTask = (
            await reloaded.recordReview({
              taskId: reloadedTask.id,
              workspacePath: harness.workspacePath,
              sessionId: "task-session-1",
              expectedRevision: reloadedTask.revision,
              reviewerAgentId: `reviewer-current-${variant.name}`,
              reviewerProvider: "openai",
              reviewerModel: "gpt-5.5",
              verdict: "pass",
              feedback: "VERDICT: PASS\nThe current artifact bytes were reviewed.",
            })
          ).task;
          reloadedTask = await reloaded.proposeCompletion({
            taskId: reloadedTask.id,
            workspacePath: harness.workspacePath,
            expectedRevision: reloadedTask.revision,
            summary: `Ready after current ${variant.name} bytes were reviewed`,
          });
          expect(reloadedTask.status).toBe("awaiting_review");
          const reviewedDetail = reloadedDb.getTaskArtifactDetail(
            reloadedTask.id,
            reloadedTask.artifacts[0]?.id ?? "",
          );
          expect(reviewedDetail?.acceptedVersionId).toBeNull();
        } finally {
          reloadedDb.close();
        }
      } finally {
        harness.sessionDb.setTaskStatus = originalSetTaskStatus as SessionDb["setTaskStatus"];
        if (!originalDbClosed) {
          harness.sessionDb.close();
        }
      }
    }
  });

  test("rejects recording a pass when material changes after the reviewer starts", async () => {
    const harness = await createHarness();
    try {
      let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
      const reviewedMaterial = await harness.coordinator.getReviewMaterial({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
      });

      await fs.writeFile(artifactPath, "# Report\n\nUnseen bytes after reviewer start.\n");

      await expect(
        harness.coordinator.recordReview({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "task-session-1",
          expectedRevision: task.revision,
          expectedMaterialFingerprint: reviewedMaterial.fingerprint,
          reviewerAgentId: "reviewer-1",
          reviewerProvider: "openai",
          reviewerModel: "gpt-5.5",
          verdict: "pass",
          feedback: "VERDICT: PASS\nThe pre-mutation report looked good.",
        }),
      ).rejects.toThrow("Reviewed material changed");
      expect(harness.sessionDb.listTaskReviews(task.id)).toHaveLength(0);

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready with unseen bytes",
        }),
      ).rejects.toThrow("1 independent review");

      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after current bytes were reviewed",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects recording a pass when task material changes after the reviewer starts", async () => {
    const harness = await createHarness();
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      const reviewedMaterial = await harness.coordinator.getReviewMaterial({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
      });
      const reviewedRevision = task.revision;

      task = await harness.coordinator.updateBrief({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        objective: "Deliver a report with a changed objective after review started.",
      });

      await expect(
        harness.coordinator.recordReview({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "task-session-1",
          expectedRevision: reviewedRevision,
          expectedMaterialFingerprint: reviewedMaterial.fingerprint,
          reviewerAgentId: "reviewer-1",
          reviewerProvider: "openai",
          reviewerModel: "gpt-5.5",
          verdict: "pass",
          feedback: "VERDICT: PASS\nThe original objective looked good.",
        }),
      ).rejects.toThrow("Task revision conflict");
      expect(harness.sessionDb.listTaskReviews(task.id)).toHaveLength(0);

      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after changed objective was reviewed",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects review and completion when a registered artifact path is missing or swapped", async () => {
    const harness = await createHarness();
    try {
      let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
      const siblingPath = path.join(harness.workspacePath, "sibling.md");
      const outsidePath = path.join(harness.home, "outside.md");
      await fs.writeFile(siblingPath, "# Sibling\n\nDifferent content.\n");
      await fs.writeFile(outsidePath, "# Outside\n\nNot in the workspace.\n");
      task = (await recordPass(harness, task, "reviewer-1")).task;

      await fs.rm(artifactPath);
      await expect(recordPass(harness, task, "reviewer-2")).rejects.toThrow(
        "Artifact does not exist",
      );
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after artifact delete",
        }),
      ).rejects.toThrow("Artifact does not exist");

      await fs.symlink(outsidePath, artifactPath);
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after artifact symlink escape",
        }),
      ).rejects.toThrow("outside");
      await fs.rm(artifactPath);

      await fs.symlink(siblingPath, artifactPath);
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after artifact symlink swap",
        }),
      ).rejects.toThrow("fresh passing review");

      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after reviewing swapped bytes",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task accept rejects awaiting review after artifact bytes change until fresh pass and proposal", async () => {
    const harness = await createHarness();
    try {
      let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready before accept-time rewrite",
      });

      await fs.writeFile(artifactPath, "# Report\n\nChanged while awaiting user review.\n");

      await expect(
        harness.coordinator.acceptTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
        }),
      ).rejects.toThrow("fresh passing review");
      const working = harness.coordinator.get(task.id, harness.workspacePath);
      expect(working?.status).toBe("working");
      if (!working) throw new Error("Expected task after accept rejection");
      task = working;
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after accept-time bytes were reviewed",
      });
      expect(task.status).toBe("awaiting_review");
      task = await harness.coordinator.acceptTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
      });
      expect(task.status).toBe("completed");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task accept rejects artifact bytes changed during final acceptance", async () => {
    const harness = await createHarness();
    const originalAcceptAllValidated =
      harness.sessionDb.acceptAllTaskArtifactVersionsValidated.bind(harness.sessionDb);
    try {
      let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready before accept-time finalization race",
      });

      let mutated = false;
      harness.sessionDb.acceptAllTaskArtifactVersionsValidated = (async (input) => {
        return await originalAcceptAllValidated({
          ...input,
          validateAcceptedTask: async (acceptedTask) => {
            if (!mutated && input.taskId === task.id) {
              mutated = true;
              await fs.writeFile(artifactPath, "# Report\n\nChanged during final accept.\n");
            }
            await input.validateAcceptedTask(acceptedTask);
          },
        });
      }) as SessionDb["acceptAllTaskArtifactVersionsValidated"];

      await expect(
        harness.coordinator.acceptTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
        }),
      ).rejects.toThrow("fresh passing review");
      expect(mutated).toBe(true);
      const working = harness.coordinator.get(task.id, harness.workspacePath);
      expect(working?.status).toBe("working");
      expect(
        harness.notifications.some(
          (notification) =>
            (notification.params.task as TaskRecord | undefined)?.id === task.id &&
            (notification.params.task as TaskRecord | undefined)?.status === "completed",
        ),
      ).toBe(false);
      if (!working) throw new Error("Expected task after final accept race rejection");
      const rejectedDetail = harness.sessionDb.getTaskArtifactDetail(
        working.id,
        working.artifacts[0]?.id ?? "",
      );
      expect(rejectedDetail?.acceptedVersionId).toBeNull();
      expect(
        rejectedDetail?.versions.filter((version) => version.reviewStatus === "accepted"),
      ).toHaveLength(0);
      expect(
        working.activity.some(
          (entry) => entry.kind === "status_changed" && entry.summary === "Task accepted",
        ),
      ).toBe(false);

      harness.sessionDb.acceptAllTaskArtifactVersionsValidated =
        originalAcceptAllValidated as SessionDb["acceptAllTaskArtifactVersionsValidated"];
      task = await harness.coordinator.registerArtifact({
        taskId: working.id,
        workspacePath: harness.workspacePath,
        expectedRevision: working.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after finalization-race bytes were reviewed",
      });
      task = await harness.coordinator.acceptTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
      });
      expect(task.status).toBe("completed");
    } finally {
      harness.sessionDb.acceptAllTaskArtifactVersionsValidated =
        originalAcceptAllValidated as SessionDb["acceptAllTaskArtifactVersionsValidated"];
      harness.sessionDb.close();
    }
  });

  test("task accept rejects missing and swapped artifacts while awaiting review", async () => {
    const harness = await createHarness();
    try {
      let { task, artifactPath } = await createIndependentlyReviewedTask(harness);
      const siblingPath = path.join(harness.workspacePath, "accept-sibling.md");
      await fs.writeFile(siblingPath, "# Sibling\n\nAccept-time swapped content.\n");
      task = (await recordPass(harness, task, "reviewer-1")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready before accept-time delete",
      });

      await fs.rm(artifactPath);
      await expect(
        harness.coordinator.acceptTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
        }),
      ).rejects.toThrow("Artifact does not exist");
      let working = harness.coordinator.get(task.id, harness.workspacePath);
      expect(working?.status).toBe("working");
      if (!working) throw new Error("Expected task after missing artifact rejection");
      task = working;
      await fs.writeFile(artifactPath, "# Report\n\nRestored after delete.\n");
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready before accept-time path swap",
      });

      await fs.rm(artifactPath);
      await fs.symlink(siblingPath, artifactPath);
      await expect(
        harness.coordinator.acceptTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
        }),
      ).rejects.toThrow("fresh passing review");
      working = harness.coordinator.get(task.id, harness.workspacePath);
      expect(working?.status).toBe("working");
      if (!working) throw new Error("Expected task after path swap rejection");
      task = working;

      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        sessionId: "task-session-1",
      });
      task = (await recordPass(harness, task, "reviewer-3")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after swapped path was reviewed",
      });
      task = await harness.coordinator.acceptTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
      });
      expect(task.status).toBe("completed");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("task accept rejects material task changes while awaiting review", async () => {
    const harness = await createHarness();
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready before accept-time task change",
      });

      task = await harness.coordinator.updateBrief({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        requirements: [
          {
            kind: "acceptance_criterion",
            text: "The report addresses an accept-time requirement change.",
            source: "user",
          },
        ],
      });
      await expect(
        harness.coordinator.acceptTask({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
        }),
      ).rejects.toThrow("fresh passing review");
      const working = harness.coordinator.get(task.id, harness.workspacePath);
      expect(working?.status).toBe("working");
      if (!working) throw new Error("Expected task after material task change rejection");
      task = (await recordPass(harness, working, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after accept-time task change was reviewed",
      });
      task = await harness.coordinator.acceptTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
      });
      expect(task.status).toBe("completed");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("directive and API propose completion race settles without DB-lock task-tail deadlock", async () => {
    const harness = await createHarness();
    const originalSetTaskStatus = harness.sessionDb.setTaskStatus.bind(harness.sessionDb);
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;
      const pause = deferred();
      const release = deferred();
      let paused = false;
      harness.sessionDb.setTaskStatus = (async (input) => {
        if (!paused && input.taskId === task.id && input.status === "awaiting_review") {
          paused = true;
          pause.resolve();
          await release.promise;
        }
        return await originalSetTaskStatus(input);
      }) as SessionDb["setTaskStatus"];

      const apiProposal = harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "API proposal racing with directive",
      });
      await pause.promise;

      const directiveProposal = harness.coordinator.applyDirective("task-session-1", {
        type: "propose_completion",
        idempotencyKey: "race-propose-completion",
        expectedRevision: task.revision,
        summary: "Directive proposal racing with API",
      });
      await flushAsyncWork();
      release.resolve();

      const settled = await expectSettlesWithin(
        Promise.allSettled([apiProposal, directiveProposal]),
        2_000,
        "completion proposal race",
      );
      const fulfilled = settled.filter((result) => result.status === "fulfilled");
      const rejected = settled.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.status).toBe(
        "awaiting_review",
      );
    } finally {
      harness.sessionDb.setTaskStatus = originalSetTaskStatus as SessionDb["setTaskStatus"];
      harness.sessionDb.close();
    }
  });

  test("directive update_plan and API transition race settles without DB-lock task-tail deadlock", async () => {
    const harness = await createHarness();
    const originalSetTaskStatus = harness.sessionDb.setTaskStatus.bind(harness.sessionDb);
    try {
      const task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Plan race",
        objective: "Create a plan while another transition is queued.",
        sessionId: "session-1",
      });
      const pause = deferred();
      const release = deferred();
      let paused = false;
      harness.sessionDb.setTaskStatus = (async (input) => {
        if (!paused && input.taskId === task.id && input.status === "planning") {
          paused = true;
          pause.resolve();
          await release.promise;
        }
        return await originalSetTaskStatus(input);
      }) as SessionDb["setTaskStatus"];

      const directiveUpdate = harness.coordinator.applyDirective("session-1", {
        type: "update_plan",
        idempotencyKey: "race-update-plan",
        expectedRevision: task.revision,
        objective: "Create a plan while another transition is queued.",
        requirements: [
          {
            kind: "acceptance_criterion",
            text: "The directive creates work without waiting on the task tail.",
          },
        ],
        workItems: [{ id: "deliver", title: "Deliver" }],
      });
      await pause.promise;

      const apiTransition = harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "planning",
        summary: "API transition racing with directive",
      });
      await flushAsyncWork();
      release.resolve();

      const settled = await expectSettlesWithin(
        Promise.allSettled([directiveUpdate, apiTransition]),
        2_000,
        "update_plan transition race",
      );
      expect(settled[0]?.status).toBe("fulfilled");
      expect(settled[1]?.status).toBe("rejected");
      const current = harness.coordinator.get(task.id, harness.workspacePath);
      expect(current?.status).toBe("working");
      expect(current?.workItems).toEqual([
        expect.objectContaining({ id: "deliver", title: "Deliver" }),
      ]);
    } finally {
      harness.sessionDb.setTaskStatus = originalSetTaskStatus as SessionDb["setTaskStatus"];
      harness.sessionDb.close();
    }
  });

  test("invalidates passing reviews after material task state changes but ignores activity-only progress", async () => {
    const harness = await createHarness();
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;
      task = await harness.coordinator.reportProgress({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        summary: "Cosmetic status note",
        detail: "No material delivery state changed.",
      });
      task = await harness.coordinator.updateBrief({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        objective: "Deliver a revised report with a newly material acceptance target.",
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after objective change",
        }),
      ).rejects.toThrow("fresh passing review");

      task = (await recordPass(harness, task, "reviewer-2")).task;
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready after fresh material review",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("review enforcement survives activity display pruning", async () => {
    const harness = await createHarness();
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      const failed = await recordFail(harness, task, "reviewer-1");
      task = failed.task;
      for (let index = 0; index < 205; index += 1) {
        task = await harness.coordinator.reportProgress({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "task-session-1",
          summary: `Unrelated progress ${index}`,
        });
      }

      await expect(recordPass(harness, task, "reviewer-1")).rejects.toThrow("addressed");
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after pruned failed review",
        }),
      ).rejects.toThrow("feedback");

      task = await harness.coordinator.addressReview({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        expectedRevision: task.revision,
        reviewId: failed.reviewId,
        implementationSummary: "Addressed old pruned review feedback.",
      });
      task = (await recordPass(harness, task, "reviewer-2")).task;
      for (let index = 0; index < 205; index += 1) {
        task = await harness.coordinator.reportProgress({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          sessionId: "task-session-1",
          summary: `Unrelated pass-preserving progress ${index}`,
        });
      }
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready with durable pass",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("review enforcement survives session database reload", async () => {
    const harness = await createHarness();
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      const failed = await recordFail(harness, task, "reviewer-1");
      task = await harness.coordinator.addressReview({
        taskId: failed.task.id,
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        expectedRevision: failed.task.revision,
        reviewId: failed.reviewId,
        implementationSummary: "Implemented the failed review feedback before restart.",
      });

      const paths = {
        rootDir: path.join(harness.home, ".cowork"),
        sessionsDir: path.join(harness.home, ".cowork", "sessions"),
      };
      harness.sessionDb.close();
      const reloadedDb = await SessionDb.create({ paths });
      const reloaded = new TaskCoordinator({ sessionDb: reloadedDb });
      try {
        await expect(
          reloaded.proposeCompletion({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            summary: "Ready after restart",
          }),
        ).rejects.toThrow("fresh passing review");

        task = (
          await reloaded.recordReview({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            sessionId: "task-session-1",
            expectedRevision: task.revision,
            reviewerAgentId: "reviewer-2",
            reviewerProvider: "openai",
            reviewerModel: "gpt-5.5",
            verdict: "pass",
            feedback: "VERDICT: PASS\nRestarted coordinator sees a fresh pass.",
          })
        ).task;
        task = await reloaded.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready after durable review reload",
        });
        expect(task.status).toBe("awaiting_review");
      } finally {
        reloadedDb.close();
      }
    } finally {
      await fs.rm(harness.home, { recursive: true, force: true });
    }
  });

  test("completion serializes material mutation races through the task queue", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let { task } = await createIndependentlyReviewedTask(harness);
      task = (await recordPass(harness, task, "reviewer-1")).task;
      const pause = pauseNextTaskStatusWrite(harness);
      const completion = harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready while a mutation races",
      });
      await pause.reached;
      const mutation = harness.coordinator.updateBrief({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        objective: "Mutated while completion was waiting.",
      });
      await flushAsyncWork();
      await expect(
        Promise.race([
          mutation.then(
            () => "settled",
            () => "settled",
          ),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
        ]),
      ).resolves.toBe("pending");
      pause.release();
      await expect(completion).resolves.toMatchObject({ status: "awaiting_review" });
      await expect(mutation).rejects.toThrow(
        `Task revision conflict: expected ${task.revision}, current ${task.revision + 1}`,
      );
      pause.restore();
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

  test("records self-origin terminal directive receipts only after deferred terminal commit", async () => {
    let allowQuiesce = false;
    let quiesceCalls = 0;
    const harness = await createHarness({
      quiesceTaskThreads: async (_task, reason) => {
        expect(reason).toBe("completed");
        quiesceCalls += 1;
        if (!allowQuiesce) throw new Error("settlement timeout");
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
          idempotencyKey: `deferred-receipt-${crypto.randomUUID()}`,
          title: "Deferred receipt task",
          objective: "Complete only after deferred terminal commit succeeds.",
          context: "The self-origin terminal directive must not receipt before commit.",
          requirements: [
            { kind: "acceptance_criterion", text: "Terminal directive retries remain possible." },
          ],
          workItems: [{ key: "deliver", title: "Deliver" }],
          reviewRequired: false,
          reviewRounds: 0,
        },
      });
      const workItem = created.task.workItems[0];
      if (!workItem) throw new Error("Expected work item");
      const marked = await harness.coordinator.applyDirective("task-session-1", {
        type: "mark_work_item",
        idempotencyKey: "deferred-receipt-mark",
        expectedRevision: created.task.revision,
        workItemId: workItem.id,
        status: "done",
        completionEvidence: "The no-review delivery is complete.",
      });
      const proposalKey = "deferred-receipt-propose";
      const proposeCheckpointNotifications = () =>
        harness.notifications.filter(
          (notification) =>
            notification.method === "task/checkpointCreated" &&
            (notification.params.checkpoint as TaskCheckpoint | undefined)?.reason ===
              "directive propose_completion",
        );

      const first = await harness.coordinator.applyDirective("task-session-1", {
        type: "propose_completion",
        idempotencyKey: proposalKey,
        expectedRevision: marked.task.revision,
        summary: "Complete after deferred quiescence",
      });
      await flushAsyncWork();

      expect(first.task.status).toBe("awaiting_review");
      expect(harness.coordinator.get(created.task.id, harness.workspacePath)?.status).toBe(
        "awaiting_review",
      );
      expect(harness.sessionDb.getTaskDirectiveReceipt(created.task.id, proposalKey)).toBeNull();
      expect(
        harness.notifications.filter(
          (notification) =>
            notification.method === "task/updated" &&
            (notification.params.task as TaskRecord | undefined)?.status === "completed",
        ),
      ).toHaveLength(0);
      expect(
        harness.coordinator.get(created.task.id, harness.workspacePath)?.latestCheckpoint?.reason,
      ).not.toBe("directive propose_completion");
      expect(proposeCheckpointNotifications()).toHaveLength(0);

      allowQuiesce = true;
      const retry = await harness.coordinator.applyDirective("task-session-1", {
        type: "propose_completion",
        idempotencyKey: proposalKey,
        expectedRevision: first.task.revision,
        summary: "Retry completion after quiescence recovers",
      });
      expect(retry.task.status).toBe("awaiting_review");
      expect(harness.sessionDb.getTaskDirectiveReceipt(created.task.id, proposalKey)).toBeNull();
      expect(proposeCheckpointNotifications()).toHaveLength(0);

      const completed = await expectSettlesWithin(
        (async () => {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await flushAsyncWork();
            const latest = harness.coordinator.get(created.task.id, harness.workspacePath);
            if (latest?.status === "completed") return latest;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("deferred terminal commit did not complete");
        })(),
        1_000,
        "deferred terminal commit",
      );
      const receipt = harness.sessionDb.getTaskDirectiveReceipt(created.task.id, proposalKey);
      expect(receipt).toBe(completed.revision);
      expect(quiesceCalls).toBe(3);
      expect(
        harness.notifications.filter(
          (notification) =>
            notification.method === "task/updated" &&
            (notification.params.task as TaskRecord | undefined)?.status === "completed",
        ),
      ).toHaveLength(1);
      const terminalCheckpoint =
        harness.coordinator.get(created.task.id, harness.workspacePath)?.latestCheckpoint ?? null;
      expect(terminalCheckpoint?.reason).toBe("directive propose_completion");
      expect(terminalCheckpoint?.taskRevision).toBe(completed.revision);
      expect(terminalCheckpoint?.taskSnapshot.status).toBe("completed");
      expect(proposeCheckpointNotifications()).toHaveLength(1);

      const replay = await harness.coordinator.applyDirective("task-session-1", {
        type: "propose_completion",
        idempotencyKey: proposalKey,
        expectedRevision: first.task.revision,
        summary: "Replay after completed commit",
      });
      expect(replay.task.status).toBe("completed");
      expect(
        harness.notifications.filter(
          (notification) =>
            notification.method === "task/updated" &&
            (notification.params.task as TaskRecord | undefined)?.status === "completed",
        ),
      ).toHaveLength(1);
      expect(harness.sessionDb.getTaskDirectiveReceipt(created.task.id, proposalKey)).toBe(
        completed.revision,
      );
      expect(proposeCheckpointNotifications()).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("same-task directive transitions still complete without deadlock", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Plan from directive",
        objective: "Create a plan and start work.",
        sessionId: "session-1",
      });

      const result = await Promise.race([
        harness.coordinator.applyDirective("session-1", {
          type: "update_plan",
          idempotencyKey: "plan-starts-work",
          expectedRevision: task.revision,
          objective: "Create a plan and start work.",
          requirements: [
            {
              kind: "acceptance_criterion",
              text: "The directive creates work and starts the task.",
            },
          ],
          workItems: [{ id: "deliver", title: "Deliver" }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for directive transitions")), 1_000),
        ),
      ]);

      expect(result.task.status).toBe("working");
      expect(result.task.workItems).toEqual([
        expect.objectContaining({ id: "deliver", title: "Deliver" }),
      ]);
      expect(
        result.task.activity
          .filter((item) => item.kind === "status_changed")
          .map((item) => item.summary),
      ).toEqual(["Task execution started", "Task plan created"]);
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
      await flushAsyncWork();
      releaseAppend.resolve();
      await terminalAttempted.promise;

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
      const review = await createReviewReadyTask(harness);
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

  test("task/thread/create cannot advance the revision while terminal quiescence is pending", async () => {
    const quiesceReached = deferred();
    const releaseQuiesce = deferred();
    const harness = await createHarness({
      quiesceTaskThreads: async () => {
        quiesceReached.resolve();
        await releaseQuiesce.promise;
      },
    });
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await createWorkingTask(harness);
      const terminalPromise = harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        status: "cancelled",
        summary: "Cancel with pending quiescence",
        sessionId: "task-session-1",
      });
      await quiesceReached.promise;

      const threadPromise = harness.coordinator.addThread({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        title: "Late focused lane",
        createdBy: "user",
      });
      await flushAsyncWork();

      expect(harness.coordinator.get(created.task.id, harness.workspacePath)).toMatchObject({
        revision: created.task.revision,
        status: "working",
        threads: expect.arrayContaining([expect.objectContaining({ sessionId: "task-session-1" })]),
      });

      releaseQuiesce.resolve();
      const terminal = await terminalPromise;
      expect(terminal.status).toBe("cancelled");
      await expect(threadPromise).rejects.toThrow(/Task revision conflict|cancelled/);
      expect(harness.coordinator.get(created.task.id, harness.workspacePath)).toMatchObject({
        status: "cancelled",
        revision: terminal.revision,
        threads: [expect.objectContaining({ sessionId: "task-session-1" })],
      });
      expect(
        harness.notifications.filter(
          (notification) =>
            notification.method === "task/updated" &&
            (notification.params.task as TaskRecord | undefined)?.status === "cancelled",
        ),
      ).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });
});
