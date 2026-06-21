import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import type { RunTurnParams } from "../../src/agent";
import { JSONRPC_ERROR_CODES } from "../../src/server/jsonrpc/protocol";
import { startAgentServer } from "../../src/server/startServer";
import type { TaskRecord, TaskStatus } from "../../src/shared/tasks";
import {
  initProductAnalytics,
  type ProductAnalyticsClient,
  type ProductAnalyticsSdkModule,
  __internal as productAnalyticsInternal,
} from "../../src/telemetry/productAnalytics";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc, type JsonRpcConnection } from "./flow.harness";

const TERMINAL_TASK_STATUSES = [
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly TaskStatus[];

const observabilityEvents: Array<{
  name: string;
  status?: "ok" | "error";
  attributes?: Record<string, string | number | boolean>;
}> = [];

mock.module("../../src/observability/otel", () => ({
  emitObservabilityEvent: mock(
    async (_config: unknown, event: (typeof observabilityEvents)[number]) => {
      observabilityEvents.push(event);
      return {
        emitted: true,
        healthChanged: false,
        health: {
          status: "ready",
          reason: "test",
          updatedAt: new Date().toISOString(),
        },
      };
    },
  ),
}));

async function makeCanonicalTmpProject(): Promise<string> {
  return await fs.realpath(await makeTmpProject());
}

function taskCreateParams(cwd: string, idempotencyKey: string) {
  return {
    cwd,
    idempotencyKey,
    title: `Terminal lock ${idempotencyKey}`,
    objective: "Prove terminal task threads cannot accept late writes.",
    context: "The task starts from a real JSON-RPC task/create route.",
    requirements: [
      {
        kind: "acceptance_criterion",
        text: "Terminal task-owned threads reject turn writes until reopened or retried.",
      },
    ],
    workItems: [
      {
        key: "verify",
        title: "Verify terminal lock",
        expectedOutputs: ["terminal-lock-evidence.txt"],
      },
    ],
    decisions: [],
    reviewRequired: false,
    reviewRounds: 0,
  };
}

async function createTask(rpc: JsonRpcConnection, cwd: string, key: string): Promise<TaskRecord> {
  const response = await rpc.sendRequest("task/create", taskCreateParams(cwd, key));
  expect(response.error).toBeUndefined();
  return response.result.task;
}

async function readTask(rpc: JsonRpcConnection, cwd: string, taskId: string): Promise<TaskRecord> {
  const response = await rpc.sendRequest("task/read", { cwd, taskId });
  expect(response.error).toBeUndefined();
  return response.result.task;
}

async function waitForTaskStatus(
  rpc: JsonRpcConnection,
  cwd: string,
  taskId: string,
  status: TaskStatus,
): Promise<TaskRecord> {
  const deadline = Date.now() + 5_000;
  let latest: TaskRecord | null = null;
  while (Date.now() < deadline) {
    latest = await readTask(rpc, cwd, taskId);
    if (latest.status === status) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for task ${taskId} to become ${status}; latest=${latest?.status}`,
  );
}

async function waitForTurnCompleted(rpc: JsonRpcConnection, threadId: string, turnId?: string) {
  return await rpc.waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params.threadId === threadId &&
      (turnId === undefined || message.params.turn.id === turnId),
    5_000,
  );
}

async function waitForThreadReadToContain(
  rpc: JsonRpcConnection,
  threadId: string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const read = await rpc.sendRequest("thread/read", { threadId, includeTurns: true });
    expect(read.error).toBeUndefined();
    if (JSON.stringify(read.result).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for thread/read to contain ${JSON.stringify(text)}`);
}

async function withProductAnalyticsCapture<T>(
  run: (events: Array<{ event: string; properties?: Record<string, unknown> }>) => Promise<T>,
): Promise<T> {
  const events: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  class FakePostHog implements ProductAnalyticsClient {
    capture(event: { event: string; properties?: Record<string, unknown> }): void {
      events.push({ event: event.event, properties: event.properties });
    }
  }

  await productAnalyticsInternal.resetProductAnalyticsForTests();
  await initProductAnalytics({
    enabled: true,
    apiKey: "phc_terminal_lock_test",
    anonymousId: "terminal-lock-test",
    environment: "test",
    eventSource: "server",
    platform: "test",
    arch: "test",
    loadSdk: async (): Promise<ProductAnalyticsSdkModule> => ({ PostHog: FakePostHog }),
  });

  try {
    const result = await run(events);
    await productAnalyticsInternal.flushProductAnalyticsQueueForTests();
    return result;
  } finally {
    await productAnalyticsInternal.resetProductAnalyticsForTests();
  }
}

async function completeTask(
  rpc: JsonRpcConnection,
  cwd: string,
  task: TaskRecord,
): Promise<TaskRecord> {
  const workItem = task.workItems[0];
  if (!workItem) throw new Error("Expected a task work item");
  await fs.writeFile(
    path.join(cwd, "terminal-lock-evidence.txt"),
    "Terminal lock JSON-RPC regression evidence.",
    "utf8",
  );
  const marked = await rpc.sendRequest("task/workItem/mark", {
    cwd,
    taskId: task.id,
    expectedRevision: task.revision,
    workItemId: workItem.id,
    status: "done",
    completionEvidence: "JSON-RPC terminal lock test completed the work item.",
  });
  expect(marked.error).toBeUndefined();
  const artifact = await rpc.sendRequest("task/artifact/register", {
    cwd,
    taskId: task.id,
    expectedRevision: marked.result.task.revision,
    path: "terminal-lock-evidence.txt",
    title: "Terminal lock evidence",
    kind: "text",
    workItemId: workItem.id,
    changeSummary: "Captured terminal lock regression evidence.",
  });
  expect(artifact.error).toBeUndefined();
  const proposed = await rpc.sendRequest("task/proposeCompletion", {
    cwd,
    taskId: task.id,
    expectedRevision: artifact.result.task.revision,
    summary: "Terminal lock test completed.",
  });
  expect(proposed.error).toBeUndefined();
  expect(proposed.result.task.status).toBe("completed");
  return proposed.result.task;
}

async function terminalTask(
  rpc: JsonRpcConnection,
  cwd: string,
  status: (typeof TERMINAL_TASK_STATUSES)[number],
  key: string,
): Promise<TaskRecord> {
  const created = await createTask(rpc, cwd, key);
  const threadId = created.threads[0]?.sessionId;
  if (!threadId) throw new Error("Expected primary task thread");
  if (status === "completed") {
    return await completeTask(rpc, cwd, await readTask(rpc, cwd, created.id));
  }
  if (status === "cancelled") {
    const latest = await readTask(rpc, cwd, created.id);
    const response = await rpc.sendRequest("task/cancel", {
      cwd,
      taskId: latest.id,
      expectedRevision: latest.revision,
      reason: "Terminal lock regression cancellation.",
    });
    expect(response.error).toBeUndefined();
    expect(response.result.task.status).toBe("cancelled");
    return response.result.task;
  }
  return await waitForTaskStatus(rpc, cwd, created.id, "failed");
}

async function expectTaskLocked(
  response: Awaited<ReturnType<JsonRpcConnection["sendRequest"]>>,
  message?: string,
) {
  expect(response.result).toBeUndefined();
  expect(response.error).toEqual(
    expect.objectContaining({
      code: JSONRPC_ERROR_CODES.invalidRequest,
      message: expect.stringContaining(
        message ?? "cannot accept new turns until it is reopened or retried",
      ),
      data: {
        category: "task_locked",
        source: "session",
      },
    }),
  );
}

describe("server JSON-RPC task terminal turn locks", () => {
  for (const status of TERMINAL_TASK_STATUSES) {
    test(`turn/start rejects ${status} task-owned threads with structured task_locked errors after restart`, async () => {
      const tmpDir = await makeCanonicalTmpProject();
      let failTurns = status === "failed";
      const opts = serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          if (failTurns) throw new Error("planned task failure");
          return { text: "ok", responseMessages: [] };
        }) as never,
      });
      let running = await startAgentServer(opts);
      let rpc = await connectJsonRpc(running.url);

      try {
        const task = await terminalTask(rpc, tmpDir, status, `terminal-${status}`);
        const threadId = task.threads[0]?.sessionId;
        if (!threadId) throw new Error("Expected primary task thread");

        const locked = await rpc.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: "late write" }],
        });
        await expectTaskLocked(locked);

        rpc.close();
        await stopTestServer(running.server);

        failTurns = false;
        running = await startAgentServer(opts);
        rpc = await connectJsonRpc(running.url);
        const resumed = await rpc.sendRequest("thread/resume", { threadId });
        expect(resumed.error).toBeUndefined();

        const lockedAfterRestart = await rpc.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: "late write after restart" }],
        });
        await expectTaskLocked(lockedAfterRestart);
      } finally {
        rpc.close();
        await stopTestServer(running.server);
      }
    }, 20_000);
  }

  test("terminal transition aborts a running task turn before late output, telemetry, or tool writes escape", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const lateWritePath = path.join(tmpDir, "late-tool-write.txt");
    let holdNextTurn = false;
    const kickoffCompleted = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<AbortSignal | null>();
    const releaseManual = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: { abortSignal?: AbortSignal }) => {
          if (!holdNextTurn) {
            kickoffCompleted.resolve();
            return { text: "kickoff complete", responseMessages: [] };
          }
          manualStarted.resolve(params.abortSignal ?? null);
          await releaseManual.promise;
          if (!params.abortSignal?.aborted) {
            await fs.writeFile(lateWritePath, "late write escaped", "utf8");
          }
          return { text: "late assistant output escaped", responseMessages: [] };
        }) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const created = await createTask(rpc, tmpDir, "running-race");
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");
      observabilityEvents.length = 0;

      await withProductAnalyticsCapture(async (productEvents) => {
        holdNextTurn = true;
        const started = await rpc.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: "start long task turn" }],
        });
        expect(started.error).toBeUndefined();
        const turnId = started.result.turn.id;
        const signal = await manualStarted.promise;

        const latest = await readTask(rpc, tmpDir, created.id);
        const cancelled = await rpc.sendRequest("task/cancel", {
          cwd: tmpDir,
          taskId: latest.id,
          expectedRevision: latest.revision,
          reason: "Close the task while a turn is running.",
        });
        expect(cancelled.error).toBeUndefined();
        expect(cancelled.result.task.status).toBe("cancelled");
        expect(signal?.aborted).toBe(true);

        const steer = await rpc.sendRequest("turn/steer", {
          threadId,
          turnId,
          input: [{ type: "text", text: "stale steer after cancellation" }],
        });
        await expectTaskLocked(steer);

        releaseManual.resolve();
        const completed = await waitForTurnCompleted(rpc, threadId, turnId);
        expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
        await expect(
          rpc.waitFor(
            (message) =>
              message.method === "item/agentMessage/delta" && message.params.threadId === threadId,
            250,
          ),
        ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
        await expect(fs.access(lateWritePath)).rejects.toThrow();

        const read = await rpc.sendRequest("thread/read", { threadId, includeTurns: true });
        expect(read.error).toBeUndefined();
        const persistedThread = JSON.stringify(read.result);
        expect(persistedThread).toContain(turnId);
        expect(persistedThread).not.toContain("late assistant output escaped");

        await productAnalyticsInternal.flushProductAnalyticsQueueForTests();
        expect(productEvents.map((event) => event.event)).toContain("turn_started");
        expect(productEvents.filter((event) => event.event === "turn_completed")).toEqual([]);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(observabilityEvents).toContainEqual(
          expect.objectContaining({
            name: "agent.turn.aborted",
            status: "ok",
            attributes: expect.objectContaining({ sessionId: threadId, turnId }),
          }),
        );
        expect(observabilityEvents).not.toContainEqual(
          expect.objectContaining({
            name: "agent.turn.completed",
            attributes: expect.objectContaining({ sessionId: threadId, turnId }),
          }),
        );
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("terminal locks apply independently to every task-owned thread", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => ({ text: "ok", responseMessages: [] })) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const created = await createTask(rpc, tmpDir, "multiple-threads");
      const primaryThreadId = created.threads[0]?.sessionId;
      if (!primaryThreadId) throw new Error("Expected primary task thread");
      const latest = await readTask(rpc, tmpDir, created.id);
      const focused = await rpc.sendRequest("task/thread/create", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        title: "Focused lock lane",
      });
      expect(focused.error).toBeUndefined();
      const terminal = await rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: focused.result.task.revision,
      });
      expect(terminal.error).toBeUndefined();

      for (const thread of terminal.result.task.threads as TaskRecord["threads"]) {
        const response = await rpc.sendRequest("turn/start", {
          threadId: thread.sessionId,
          input: [{ type: "text", text: `late write into ${thread.title}` }],
        });
        await expectTaskLocked(response);
      }
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("explicit reopen and retry restore task-owned thread writes after durable status changes", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    let failTurns = false;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          if (failTurns) throw new Error("planned task failure");
          return { text: "ok", responseMessages: [] };
        }) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const completed = await terminalTask(rpc, tmpDir, "completed", "reopen-completed");
      const completedThreadId = completed.threads[0]?.sessionId;
      if (!completedThreadId) throw new Error("Expected completed task thread");
      await expectTaskLocked(
        await rpc.sendRequest("turn/start", {
          threadId: completedThreadId,
          input: [{ type: "text", text: "blocked before reopen" }],
        }),
      );
      const reopened = await rpc.sendRequest("task/reopen", {
        cwd: tmpDir,
        taskId: completed.id,
        expectedRevision: completed.revision,
        reason: "Continue verified work.",
      });
      expect(reopened.error).toBeUndefined();
      expect(reopened.result.task.status).toBe("working");
      const reopenedTurn = await rpc.sendRequest("turn/start", {
        threadId: completedThreadId,
        input: [{ type: "text", text: "allowed after reopen" }],
      });
      expect(reopenedTurn.error).toBeUndefined();
      await waitForTurnCompleted(rpc, completedThreadId, reopenedTurn.result.turn.id);

      failTurns = true;
      const failed = await terminalTask(rpc, tmpDir, "failed", "retry-failed");
      const failedThreadId = failed.threads[0]?.sessionId;
      if (!failedThreadId) throw new Error("Expected failed task thread");
      await expectTaskLocked(
        await rpc.sendRequest("turn/start", {
          threadId: failedThreadId,
          input: [{ type: "text", text: "blocked before retry" }],
        }),
      );
      failTurns = false;
      const retried = await rpc.sendRequest("task/retry", {
        cwd: tmpDir,
        taskId: failed.id,
        expectedRevision: failed.revision,
      });
      expect(retried.error).toBeUndefined();
      expect(retried.result.task.status).toBe("working");
      await waitForTurnCompleted(rpc, failedThreadId);
      const retryTurn = await rpc.sendRequest("turn/start", {
        threadId: failedThreadId,
        input: [{ type: "text", text: "allowed after retry" }],
      });
      expect(retryTurn.error).toBeUndefined();
      await waitForTurnCompleted(rpc, failedThreadId, retryTurn.result.turn.id);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("source chat locks only while its promoted task is active and ordinary chats remain writable", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    let promoteNextTurn = true;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: RunTurnParams) => {
          if (promoteNextTurn) {
            promoteNextTurn = false;
            const result = await params.createTask?.({
              idempotencyKey: "source-chat-lock",
              title: "Source chat terminal lock",
              objective: "Prove source chats are locked only while their task is active.",
              context: "Created through the real chat createTask path.",
              requirements: [
                {
                  kind: "acceptance_criterion",
                  text: "Source chat writes resume after the task reaches a terminal state.",
                },
              ],
              workItems: [
                {
                  key: "verify",
                  title: "Verify source lock",
                  expectedOutputs: ["source-lock-evidence.txt"],
                },
              ],
              decisions: [],
              reviewRequired: false,
              reviewRounds: 0,
            });
            if (!result) throw new Error("createTask tool path was not registered");
            return { text: "", responseMessages: [] };
          }
          return { text: "ordinary chat response", responseMessages: [] };
        }) as never,
      }),
    );

    try {
      const sourceRpc = await connectJsonRpc(url);
      const ordinaryRpc = await connectJsonRpc(url);
      const sourceStarted = await sourceRpc.sendRequest("thread/start", { cwd: tmpDir });
      expect(sourceStarted.error).toBeUndefined();
      const sourceThreadId = sourceStarted.result.thread.id;
      const ordinaryStarted = await ordinaryRpc.sendRequest("thread/start", { cwd: tmpDir });
      expect(ordinaryStarted.error).toBeUndefined();
      const ordinaryThreadId = ordinaryStarted.result.thread.id;

      const promotionTurn = await sourceRpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "promote this chat to a task" }],
      });
      expect(promotionTurn.error).toBeUndefined();
      const createdNotification = await sourceRpc.waitFor(
        (message) => message.method === "task/created",
      );
      const taskId = createdNotification.params.task.id;
      await waitForTurnCompleted(sourceRpc, sourceThreadId, promotionTurn.result.turn.id);

      const lockedSource = await sourceRpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "source write while task is active" }],
      });
      await expectTaskLocked(lockedSource, "Chat is locked by active task");

      const ordinaryTurn = await ordinaryRpc.sendRequest("turn/start", {
        threadId: ordinaryThreadId,
        input: [{ type: "text", text: "ordinary chat should still work" }],
      });
      expect(ordinaryTurn.error).toBeUndefined();
      await waitForTurnCompleted(ordinaryRpc, ordinaryThreadId, ordinaryTurn.result.turn.id);

      const activeTask = await readTask(sourceRpc, tmpDir, taskId);
      const cancelled = await sourceRpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId,
        expectedRevision: activeTask.revision,
        reason: "Release the source chat lock.",
      });
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result.task.status).toBe("cancelled");

      const releasedSourceTurn = await sourceRpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "source write after terminal task" }],
      });
      expect(releasedSourceTurn.error).toBeUndefined();
      await waitForTurnCompleted(sourceRpc, sourceThreadId, releasedSourceTurn.result.turn.id);
      sourceRpc.close();
      ordinaryRpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);
});
