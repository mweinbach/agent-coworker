import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { createRunTurn, type RunTurnParams } from "../../src/agent";
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

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForFile(pathname: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(pathname);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for file ${pathname}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  data?: Record<string, unknown>,
) {
  expect(response.result).toBeUndefined();
  expect(response.error).toEqual(
    expect.objectContaining({
      code: JSONRPC_ERROR_CODES.invalidRequest,
      message: expect.stringContaining(
        message ?? "cannot accept new turns until it is reopened or retried",
      ),
      data: expect.objectContaining({
        category: "task_locked",
        source: "session",
        ...data,
      }),
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
        await expectTaskLocked(locked, undefined, {
          lockKind: "terminal_task_thread",
          taskId: task.id,
          taskStatus: status,
        });

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
        await expectTaskLocked(lockedAfterRestart, undefined, {
          lockKind: "terminal_task_thread",
          taskId: task.id,
          taskStatus: status,
        });
      } finally {
        rpc.close();
        await stopTestServer(running.server);
      }
    }, 20_000);
  }

  for (const status of TERMINAL_TASK_STATUSES) {
    test(`JSON-RPC agent work routes reject ${status} task-owned threads with structured task_locked errors`, async () => {
      const tmpDir = await makeCanonicalTmpProject();
      let failTurns = status === "failed";
      let runCalls = 0;
      const { server, url } = await startAgentServer(
        serverOpts(tmpDir, {
          runTurnImpl: (async () => {
            runCalls += 1;
            if (failTurns) throw new Error("planned task failure");
            return { text: "ok", responseMessages: [] };
          }) as never,
        }),
      );

      try {
        const rpc = await connectJsonRpc(url);
        const task = await terminalTask(rpc, tmpDir, status, `agent-route-${status}`);
        failTurns = false;
        const threadId = task.threads[0]?.sessionId;
        if (!threadId) throw new Error("Expected primary task thread");
        const runCallsBeforeAgentRoutes = runCalls;

        const spawn = await rpc.sendRequest("cowork/session/agent/spawn", {
          threadId,
          message: "spawn should be rejected",
        });
        await expectTaskLocked(spawn, undefined, {
          lockKind: "terminal_task_thread",
          taskId: task.id,
          taskStatus: status,
        });

        const send = await rpc.sendRequest("cowork/session/agent/input/send", {
          threadId,
          agentId: "child-agent",
          message: "send should be rejected",
        });
        await expectTaskLocked(send, undefined, {
          lockKind: "terminal_task_thread",
          taskId: task.id,
          taskStatus: status,
        });

        const resume = await rpc.sendRequest("cowork/session/agent/resume", {
          threadId,
          agentId: "child-agent",
        });
        await expectTaskLocked(resume, undefined, {
          lockKind: "terminal_task_thread",
          taskId: task.id,
          taskStatus: status,
        });

        await expect(
          rpc.waitFor(
            (message) =>
              (message.method === "cowork/session/agentSpawned" ||
                message.method === "cowork/session/agentStatus") &&
              message.params.sessionId === threadId,
            250,
          ),
        ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
        expect(runCalls).toBe(runCallsBeforeAgentRoutes);
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    }, 20_000);
  }

  test("JSON-RPC agent work routes reject active source chats with structured task_locked errors", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    let sourceThreadIdForProvider: string | null = null;
    let promoteNextTurn = true;
    let nonSourceRunCalls = 0;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: RunTurnParams) => {
          if (params.sessionId !== sourceThreadIdForProvider) {
            nonSourceRunCalls += 1;
            return { text: "task or child response", responseMessages: [] };
          }
          if (promoteNextTurn) {
            promoteNextTurn = false;
            const result = await params.createTask?.({
              idempotencyKey: "source-agent-route-lock",
              title: "Source agent route lock",
              objective: "Prove source-chat agent controls are locked while a task is active.",
              context: "Created through the real chat createTask path.",
              requirements: [
                {
                  kind: "acceptance_criterion",
                  text: "Source chat agent routes cannot launch child work while locked.",
                },
              ],
              workItems: [
                {
                  key: "verify",
                  title: "Verify source agent route lock",
                  expectedOutputs: ["source-agent-route-lock.txt"],
                },
              ],
              decisions: [],
              reviewRequired: false,
              reviewRounds: 0,
            });
            if (!result) throw new Error("createTask tool path was not registered");
            return { text: "promotion complete", responseMessages: [] };
          }
          return { text: "source chat response", responseMessages: [] };
        }) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      expect(started.error).toBeUndefined();
      const sourceThreadId = started.result.thread.id;
      sourceThreadIdForProvider = sourceThreadId;

      const promotionTurn = await rpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "promote this source chat" }],
      });
      expect(promotionTurn.error).toBeUndefined();
      const createdNotification = await rpc.waitFor((message) => message.method === "task/created");
      const taskId = createdNotification.params.task.id;
      await waitForTurnCompleted(rpc, sourceThreadId, promotionTurn.result.turn.id);
      const nonSourceRunCallsBeforeAgentRoutes = nonSourceRunCalls;

      const spawn = await rpc.sendRequest("cowork/session/agent/spawn", {
        threadId: sourceThreadId,
        message: "spawn should be rejected",
      });
      await expectTaskLocked(spawn, "Chat is locked by active task", {
        lockKind: "active_source_chat",
        taskId,
        taskStatus: "working",
        taskTitle: "Source agent route lock",
      });

      const send = await rpc.sendRequest("cowork/session/agent/input/send", {
        threadId: sourceThreadId,
        agentId: "child-agent",
        message: "send should be rejected",
      });
      await expectTaskLocked(send, "Chat is locked by active task", {
        lockKind: "active_source_chat",
        taskId,
        taskStatus: "working",
        taskTitle: "Source agent route lock",
      });

      const resume = await rpc.sendRequest("cowork/session/agent/resume", {
        threadId: sourceThreadId,
        agentId: "child-agent",
      });
      await expectTaskLocked(resume, "Chat is locked by active task", {
        lockKind: "active_source_chat",
        taskId,
        taskStatus: "working",
        taskTitle: "Source agent route lock",
      });

      await expect(
        rpc.waitFor(
          (message) =>
            (message.method === "cowork/session/agentSpawned" ||
              message.method === "cowork/session/agentStatus") &&
            message.params.sessionId === sourceThreadId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
      expect(nonSourceRunCalls).toBe(nonSourceRunCallsBeforeAgentRoutes);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("terminal transition aborts a running task turn before late output, telemetry, or tool writes escape", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const lateWritePath = path.join(tmpDir, "late-tool-write.txt");
    let holdNextTurn = false;
    const kickoffCompleted = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<AbortSignal | null>();
    const releaseManual = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: {
          abortSignal?: AbortSignal;
          onModelRawEvent?: (rawEvent: unknown) => Promise<void> | void;
          onModelStreamPart?: (rawPart: unknown) => Promise<void> | void;
        }) => {
          if (!holdNextTurn) {
            kickoffCompleted.resolve();
            return { text: "kickoff complete", responseMessages: [] };
          }
          manualStarted.resolve(params.abortSignal ?? null);
          await releaseManual.promise;
          if (!params.abortSignal?.aborted) {
            await fs.writeFile(lateWritePath, "late write escaped", "utf8");
          }
          await params.onModelRawEvent?.({
            format: "openai-responses-v1",
            event: {
              type: "response.output_text.delta",
              delta: "late raw output escaped",
            },
          });
          await params.onModelStreamPart?.({
            type: "text-delta",
            id: "late-stream",
            text: "late streamed output escaped",
          });
          return {
            text: "late assistant output escaped",
            responseMessages: [],
            usage: {
              promptTokens: 11,
              completionTokens: 7,
              totalTokens: 18,
            },
          };
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
        const cancelPromise = rpc.sendRequest("task/cancel", {
          cwd: tmpDir,
          taskId: latest.id,
          expectedRevision: latest.revision,
          reason: "Close the task while a turn is running.",
        });
        await waitForCondition(
          () => signal?.aborted === true,
          "task cancel did not abort the turn",
        );
        expect(signal?.aborted).toBe(true);
        const pendingTerminal = await readTask(rpc, tmpDir, created.id);
        expect(pendingTerminal.status).toBe("working");

        const steer = await rpc.sendRequest("turn/steer", {
          threadId,
          turnId,
          input: [{ type: "text", text: "stale steer after cancellation" }],
        });
        await expectTaskLocked(steer);

        releaseManual.resolve();
        const cancelled = await cancelPromise;
        expect(cancelled.error).toBeUndefined();
        expect(cancelled.result.task.status).toBe("cancelled");
        const completed = await waitForTurnCompleted(rpc, threadId, turnId);
        expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
        const usageNotification = await rpc.waitFor(
          (message) =>
            message.method === "cowork/session/turnUsage" &&
            message.params.sessionId === threadId &&
            message.params.turnId === turnId,
        );
        expect(usageNotification.params).toMatchObject({
          type: "turn_usage",
          usage: {
            promptTokens: 11,
            completionTokens: 7,
            totalTokens: 18,
          },
        });
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
        expect(persistedThread).not.toContain("late streamed output escaped");
        expect(persistedThread).not.toContain("late raw output escaped");

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

  test("terminal transition blocks in-flight mutating tools before writes escape", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const guardedWritePath = path.join(tmpDir, "guarded-tool-write.txt");
    let holdNextTurn = false;
    let toolMutationResult: string | null = null;
    const kickoffCompleted = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<AbortSignal | null>();
    const releaseManual = Promise.withResolvers<void>();
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          if (!holdNextTurn) {
            kickoffCompleted.resolve();
            return { text: "kickoff complete", responseMessages: [] };
          }
          manualStarted.resolve(params.abortSignal ?? null);
          await releaseManual.promise;
          try {
            await params.tools.write.execute({
              filePath: guardedWritePath,
              content: "tool write escaped terminal task cancellation",
            });
            toolMutationResult = "wrote";
          } catch (error) {
            toolMutationResult = error instanceof Error ? error.message : String(error);
          }
          return {
            text: `tool mutation result: ${toolMutationResult}`,
            responseMessages: [],
            usage: {
              promptTokens: 3,
              completionTokens: 2,
              totalTokens: 5,
            },
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const created = await createTask(rpc, tmpDir, "running-tool-race");
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");

      holdNextTurn = true;
      const started = await rpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "start tool write race" }],
      });
      expect(started.error).toBeUndefined();
      const turnId = started.result.turn.id;
      const signal = await manualStarted.promise;

      const latest = await readTask(rpc, tmpDir, created.id);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        reason: "Close the task while a mutating tool is in flight.",
      });
      await waitForCondition(() => signal?.aborted === true, "task cancel did not abort the turn");
      expect(signal?.aborted).toBe(true);
      const pendingTerminal = await readTask(rpc, tmpDir, created.id);
      expect(pendingTerminal.status).toBe("working");

      releaseManual.resolve();
      const cancelled = await cancelPromise;
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result.task.status).toBe("cancelled");
      const completed = await waitForTurnCompleted(rpc, threadId, turnId);
      expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
      expect(toolMutationResult).toMatch(/blocked because the turn was cancelled/);
      await expect(fs.access(guardedWritePath)).rejects.toThrow();

      const read = await rpc.sendRequest("thread/read", { threadId, includeTurns: true });
      expect(read.error).toBeUndefined();
      expect(JSON.stringify(read.result)).not.toContain("tool write escaped");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("terminal transition waits for non-cooperative MCP execution to settle before committing", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const mcpWritePath = path.join(tmpDir, "mcp-tool-write.txt");
    let holdNextTurn = false;
    let mcpMutationResult: string | null = null;
    let mcpExecuteCalls = 0;
    const kickoffCompleted = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<AbortSignal | null>();
    const mcpEntered = Promise.withResolvers<AbortSignal | null>();
    const releaseMcpWrite = Promise.withResolvers<void>();
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          if (!holdNextTurn) {
            kickoffCompleted.resolve();
            return { text: "kickoff complete", responseMessages: [] };
          }
          manualStarted.resolve(params.abortSignal ?? null);
          try {
            await params.tools.mcp__local__mutate.execute({});
            mcpMutationResult = "wrote";
          } catch (error) {
            mcpMutationResult = error instanceof Error ? error.message : String(error);
          }
          return {
            text: `mcp mutation result: ${mcpMutationResult}`,
            responseMessages: [],
            usage: {
              promptTokens: 4,
              completionTokens: 2,
              totalTokens: 6,
            },
          };
        },
      }),
      loadMCPServers: async () => [
        { name: "local", transport: { type: "stdio", command: "mcp-local", args: [] } },
      ],
      loadMCPTools: async () => ({
        tools: {
          mcp__local__mutate: {
            description: "Mutates the workspace if not lifecycle-gated.",
            inputSchema: { type: "object", properties: {} },
            execute: async (_input: unknown, options?: { abortSignal?: AbortSignal }) => {
              mcpExecuteCalls += 1;
              mcpEntered.resolve(options?.abortSignal ?? null);
              await releaseMcpWrite.promise;
              await fs.writeFile(mcpWritePath, "mcp side effect settled before terminal", "utf8");
              return "mcp write settled";
            },
          },
        },
        errors: [],
        close: async () => {},
      }),
    });
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: { AGENT_ENABLE_MCP: "true" },
        runTurnImpl,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const created = await createTask(rpc, tmpDir, "mcp-tool-race");
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");

      holdNextTurn = true;
      const started = await rpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "start mcp tool race" }],
      });
      expect(started.error).toBeUndefined();
      const turnId = started.result.turn.id;
      const signal = await manualStarted.promise;
      const toolSignal = await mcpEntered.promise;
      expect(toolSignal).toBe(signal);

      const latest = await readTask(rpc, tmpDir, created.id);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        reason: "Close the task while an MCP tool is in flight.",
      });
      await waitForCondition(() => signal?.aborted === true, "task cancel did not abort the turn");
      const settledBeforeMcpSettled = await Promise.race([
        cancelPromise.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
      ]);
      expect(settledBeforeMcpSettled).toBe(false);
      const duringCancel = await readTask(rpc, tmpDir, created.id);
      expect(duringCancel.status).toBe("working");

      releaseMcpWrite.resolve();
      await waitForFile(mcpWritePath);
      const cancelled = await cancelPromise;
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result.task.status).toBe("cancelled");
      expect(signal?.aborted).toBe(true);
      expect(toolSignal?.aborted).toBe(true);

      const completed = await waitForTurnCompleted(rpc, threadId, turnId);
      expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
      expect(mcpMutationResult).toBe("wrote");
      expect(mcpExecuteCalls).toBe(1);
      await expect(fs.readFile(mcpWritePath, "utf8")).resolves.toBe(
        "mcp side effect settled before terminal",
      );

      const read = await rpc.sendRequest("thread/read", { threadId, includeTurns: true });
      expect(read.error).toBeUndefined();
      expect(JSON.stringify(read.result)).not.toContain("mcp write settled");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("terminal transition timeout fails closed while non-cooperative MCP execution remains unsettled", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const mcpWritePath = path.join(tmpDir, "mcp-timeout-write.txt");
    let holdNextTurn = false;
    let mcpMutationResult: string | null = null;
    let mcpExecuteCalls = 0;
    const kickoffCompleted = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<AbortSignal | null>();
    const mcpEntered = Promise.withResolvers<AbortSignal | null>();
    const releaseMcpWrite = Promise.withResolvers<void>();
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          if (!holdNextTurn) {
            kickoffCompleted.resolve();
            return { text: "kickoff complete", responseMessages: [] };
          }
          manualStarted.resolve(params.abortSignal ?? null);
          try {
            await params.tools.mcp__local__mutate.execute({});
            mcpMutationResult = "wrote";
          } catch (error) {
            mcpMutationResult = error instanceof Error ? error.message : String(error);
          }
          return {
            text: `mcp timeout result: ${mcpMutationResult}`,
            responseMessages: [],
          };
        },
      }),
      loadMCPServers: async () => [
        { name: "local", transport: { type: "stdio", command: "mcp-local", args: [] } },
      ],
      loadMCPTools: async () => ({
        tools: {
          mcp__local__mutate: {
            description: "Mutates the workspace after the local abort signal fires.",
            inputSchema: { type: "object", properties: {} },
            execute: async (_input: unknown, options?: { abortSignal?: AbortSignal }) => {
              mcpExecuteCalls += 1;
              mcpEntered.resolve(options?.abortSignal ?? null);
              await releaseMcpWrite.promise;
              await fs.writeFile(mcpWritePath, "mcp side effect settled after timeout", "utf8");
              return "mcp write settled after timeout";
            },
          },
        },
        errors: [],
        close: async () => {},
      }),
    });
    const opts = serverOpts(tmpDir, {
      env: { AGENT_ENABLE_MCP: "true" },
      runTurnImpl,
      taskTerminalQuiesceTimeoutMs: 35,
    });
    let running = await startAgentServer(opts);
    let rpc = await connectJsonRpc(running.url);

    try {
      const created = await createTask(rpc, tmpDir, "mcp-timeout");
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");

      holdNextTurn = true;
      const started = await rpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "start mcp timeout race" }],
      });
      expect(started.error).toBeUndefined();
      const turnId = started.result.turn.id;
      const signal = await manualStarted.promise;
      const toolSignal = await mcpEntered.promise;
      expect(toolSignal).toBe(signal);

      const latest = await readTask(rpc, tmpDir, created.id);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        reason: "Close the task while an MCP tool remains unsettled.",
      });
      await waitForCondition(() => signal?.aborted === true, "task cancel did not abort the turn");

      await expectTaskLocked(
        await rpc.sendRequest("turn/steer", {
          threadId,
          turnId,
          input: [{ type: "text", text: "blocked while cancel is pending" }],
        }),
        "finalizing cancelled",
        {
          lockKind: "terminal_task_thread",
          taskId: created.id,
          taskStatus: "cancelled",
        },
      );

      const timedOutCancel = await cancelPromise;
      expect(timedOutCancel.result).toBeUndefined();
      expect(timedOutCancel.error).toEqual(
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: expect.stringContaining(
            "Timed out waiting for turn settlement after cancellation.",
          ),
        }),
      );

      const afterTimeout = await readTask(rpc, tmpDir, created.id);
      expect(afterTimeout.status).toBe("working");
      expect(afterTimeout.revision).toBe(latest.revision);
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "cancelled",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      const steerAfterTimeout = await rpc.sendRequest("turn/steer", {
        threadId,
        turnId,
        input: [{ type: "text", text: "accepted after timed-out terminal lock releases" }],
      });
      expect(steerAfterTimeout.error).toBeUndefined();

      releaseMcpWrite.resolve();
      await waitForFile(mcpWritePath);
      const completed = await waitForTurnCompleted(rpc, threadId, turnId);
      expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
      expect(mcpMutationResult).toBe("wrote");
      expect(mcpExecuteCalls).toBe(1);
      expect(await readTask(rpc, tmpDir, created.id)).toMatchObject({
        id: created.id,
        status: "working",
      });
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "cancelled",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      rpc.close();
      await stopTestServer(running.server);

      running = await startAgentServer(opts);
      rpc = await connectJsonRpc(running.url);
      const afterRestart = await readTask(rpc, tmpDir, created.id);
      expect(afterRestart.status).toBe("working");
      expect(afterRestart.revision).toBe(latest.revision);

      const retryTerminalUpdate = rpc.waitFor(
        (message) =>
          message.method === "task/updated" &&
          message.params.task?.id === created.id &&
          message.params.task?.status === "cancelled",
        1_000,
      );
      const retryCancel = await rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: afterRestart.id,
        expectedRevision: afterRestart.revision,
        reason: "Retry cancellation after the original MCP turn settled.",
      });
      expect(retryCancel.error).toBeUndefined();
      expect(retryCancel.result.task.status).toBe("cancelled");
      const terminalUpdate = await retryTerminalUpdate;
      expect(terminalUpdate.params.task.revision).toBe(retryCancel.result.task.revision);
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "cancelled",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
      await expect(fs.readFile(mcpWritePath, "utf8")).resolves.toBe(
        "mcp side effect settled after timeout",
      );
      rpc.close();
    } finally {
      rpc.close();
      await stopTestServer(running.server);
    }
  }, 20_000);

  test("terminal quiescence waits for child-agent settlement before committing task status", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const childWritePath = path.join(tmpDir, "child-agent-before-terminal.txt");
    const childStarted = Promise.withResolvers<AbortSignal | null>();
    const releaseChild = Promise.withResolvers<void>();
    const childSettled = Promise.withResolvers<void>();
    const parentSpawnedChild = Promise.withResolvers<void>();
    const runTurnImpl = (async (params: RunTurnParams) => {
      if (params.agentRole) {
        childStarted.resolve(params.abortSignal ?? null);
        await releaseChild.promise;
        await fs.writeFile(childWritePath, "child settled before terminal commit", "utf8");
        childSettled.resolve();
        return {
          text: "child settled",
          responseMessages: [],
        };
      }

      if (!params.agentControl || !params.sessionId) {
        throw new Error("Expected task thread run to receive agent control");
      }
      await params.agentControl.spawn({
        parentSessionId: params.sessionId,
        parentConfig: params.config,
        message: "hold child turn until terminal quiescence cancels it",
        role: "worker",
        contextMode: "none",
        parentDepth: params.spawnDepth ?? 0,
      });
      parentSpawnedChild.resolve();
      return {
        text: "parent spawned child",
        responseMessages: [],
      };
    }) as never;
    const opts = serverOpts(tmpDir, { runTurnImpl, taskTerminalQuiesceTimeoutMs: 500 });
    const running = await startAgentServer(opts);
    const rpc = await connectJsonRpc(running.url);

    try {
      const created = await createTask(rpc, tmpDir, "child-agent-settlement");
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await parentSpawnedChild.promise;
      const childSignal = await childStarted.promise;

      const latest = await readTask(rpc, tmpDir, created.id);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        reason: "Cancel waits for child-agent settlement.",
      });
      await waitForCondition(
        () => childSignal?.aborted === true,
        "task cancel did not abort the child agent turn",
      );

      await expect(
        Promise.race([cancelPromise.then(() => "settled"), delay(75).then(() => "pending")]),
      ).resolves.toBe("pending");
      const stillWorking = await readTask(rpc, tmpDir, created.id);
      expect(stillWorking.status).toBe("working");
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "cancelled",
          75,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
      await expect(fs.access(childWritePath)).rejects.toThrow();

      releaseChild.resolve();
      await childSettled.promise;
      const cancelled = await cancelPromise;

      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result.task.status).toBe("cancelled");
      await fs.access(childWritePath);
      const afterCancel = await readTask(rpc, tmpDir, created.id);
      expect(afterCancel.status).toBe("cancelled");
    } finally {
      rpc.close();
      await stopTestServer(running.server);
    }
  }, 20_000);

  test("terminal transition timeout waits for cooperative sibling quiescence before failing closed", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const modeBySession = new Map<string, "stuck" | "cooperative">();
    const kickoffCompleted = Promise.withResolvers<void>();
    const stuckStarted = Promise.withResolvers<AbortSignal | null>();
    const cooperativeStarted = Promise.withResolvers<AbortSignal | null>();
    const releaseStuck = Promise.withResolvers<void>();
    let cooperativeSettled = false;
    const opts = serverOpts(tmpDir, {
      taskTerminalQuiesceTimeoutMs: 100,
      runTurnImpl: (async (params: RunTurnParams) => {
        const mode = params.sessionId ? modeBySession.get(params.sessionId) : undefined;
        if (!mode) {
          kickoffCompleted.resolve();
          return { text: "kickoff complete", responseMessages: [] };
        }
        if (mode === "stuck") {
          stuckStarted.resolve(params.abortSignal ?? null);
          await releaseStuck.promise;
          return { text: "stuck turn eventually settled", responseMessages: [] };
        }
        cooperativeStarted.resolve(params.abortSignal ?? null);
        await waitForCondition(
          () => params.abortSignal?.aborted === true,
          "cooperative sibling was not aborted",
        );
        await delay(10);
        cooperativeSettled = true;
        return { text: "cooperative turn settled after abort", responseMessages: [] };
      }) as never,
    });
    const { server, url } = await startAgentServer(opts);
    const rpc = await connectJsonRpc(url);

    try {
      const created = await createTask(rpc, tmpDir, "sibling-timeout");
      const primaryThreadId = created.threads[0]?.sessionId;
      if (!primaryThreadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;

      const focused = await rpc.sendRequest("task/thread/create", {
        cwd: tmpDir,
        taskId: created.id,
        expectedRevision: created.revision,
        title: "Cooperative sibling",
      });
      expect(focused.error).toBeUndefined();
      const cooperativeThreadId = focused.result.thread.id;
      modeBySession.set(primaryThreadId, "stuck");
      modeBySession.set(cooperativeThreadId, "cooperative");

      const stuckTurn = await rpc.sendRequest("turn/start", {
        threadId: primaryThreadId,
        input: [{ type: "text", text: "start stuck turn" }],
      });
      expect(stuckTurn.error).toBeUndefined();
      const cooperativeTurn = await rpc.sendRequest("turn/start", {
        threadId: cooperativeThreadId,
        input: [{ type: "text", text: "start cooperative turn" }],
      });
      expect(cooperativeTurn.error).toBeUndefined();
      const stuckSignal = await stuckStarted.promise;
      const cooperativeSignal = await cooperativeStarted.promise;

      const latest = await readTask(rpc, tmpDir, created.id);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        reason: "Cancel while one task thread remains non-cooperative.",
      });
      await waitForCondition(() => stuckSignal?.aborted === true, "stuck turn was not aborted");
      await waitForCondition(
        () => cooperativeSignal?.aborted === true,
        "cooperative turn was not aborted",
      );

      const timedOutCancel = await cancelPromise;
      expect(cooperativeSettled).toBe(true);
      expect(timedOutCancel.result).toBeUndefined();
      expect(timedOutCancel.error).toEqual(
        expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: expect.stringContaining(
            "Timed out waiting for turn settlement after cancellation.",
          ),
        }),
      );
      expect(await readTask(rpc, tmpDir, created.id)).toMatchObject({
        id: created.id,
        status: "working",
      });
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "cancelled",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      releaseStuck.resolve();
      await waitForTurnCompleted(rpc, primaryThreadId, stuckTurn.result.turn.id);
      await waitForTurnCompleted(rpc, cooperativeThreadId, cooperativeTurn.result.turn.id);
      rpc.close();
    } finally {
      rpc.close();
      await stopTestServer(server);
    }
  }, 20_000);

  test("self-origin terminal directive waits for provider turn settlement before terminal notification", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const evidencePath = path.join(tmpDir, "self-terminal-evidence.txt");
    const providerWritePath = path.join(tmpDir, "self-terminal-provider-write.txt");
    const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> =>
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 2_000)),
      ]);
    let holdNextTurn = false;
    let createdForProvider: TaskRecord | null = null;
    const kickoffCompleted = Promise.withResolvers<void>();
    const directiveReturned = Promise.withResolvers<void>();
    const directiveFailed = Promise.withResolvers<string>();
    const providerSideEffectEntered = Promise.withResolvers<AbortSignal | null>();
    const providerWriteCompleted = Promise.withResolvers<void>();
    const releaseProviderSideEffect = Promise.withResolvers<void>();
    const runTurnImpl = (async (params: RunTurnParams) => {
      if (!holdNextTurn) {
        kickoffCompleted.resolve();
        return { text: "kickoff complete", responseMessages: [] };
      }
      try {
        const context = params.getTaskContext?.();
        const workItem = context?.workItems[0] ?? createdForProvider?.workItems[0];
        const expectedRevision = context?.revision ?? createdForProvider?.revision;
        if (!workItem || expectedRevision === undefined) {
          throw new Error("Expected task context with a work item");
        }
        await fs.writeFile(evidencePath, "ready for completion", "utf8");
        const registered = await params.applyTaskDirective?.({
          type: "register_artifact",
          idempotencyKey: "self-terminal-register-artifact",
          expectedRevision,
          path: "self-terminal-evidence.txt",
          title: "Self-terminal evidence",
          kind: "text",
          workItemId: workItem.id,
        });
        if (!registered) throw new Error("Expected register_artifact directive result");
        const marked = await params.applyTaskDirective?.({
          type: "mark_work_item",
          idempotencyKey: "self-terminal-mark-work",
          expectedRevision: registered.task.revision,
          workItemId: workItem.id,
          status: "done",
          completionEvidence: "Focused regression completed its work item.",
        });
        if (!marked) throw new Error("Expected mark_work_item directive result");
        await params.applyTaskDirective?.({
          type: "propose_completion",
          idempotencyKey: "self-terminal-propose-completion",
          expectedRevision: marked.task.revision,
          summary: "Self-origin terminal proposal",
        });
        directiveReturned.resolve();
      } catch (error) {
        directiveFailed.resolve(error instanceof Error ? error.message : String(error));
        throw error;
      }
      providerSideEffectEntered.resolve(params.abortSignal ?? null);
      await releaseProviderSideEffect.promise;
      await fs.writeFile(providerWritePath, "provider side effect settled before terminal", "utf8");
      providerWriteCompleted.resolve();
      return {
        text: "provider turn settled after self-origin terminal proposal",
        responseMessages: [],
      };
    }) as never;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const createdResponse = await rpc.sendRequest("task/create", {
        ...taskCreateParams(tmpDir, "self-origin-terminal"),
        workItems: [
          {
            key: "verify",
            title: "Verify self-origin terminal handoff",
            expectedOutputs: ["self-terminal-evidence.txt"],
          },
        ],
        reviewRequired: false,
        reviewRounds: 0,
      });
      expect(createdResponse.error).toBeUndefined();
      const created = createdResponse.result.task as TaskRecord;
      createdForProvider = created;
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await withTimeout(kickoffCompleted.promise, "Timed out waiting for initial task kickoff");
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");

      holdNextTurn = true;
      const started = await rpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "complete this task from inside the provider turn" }],
      });
      expect(started.error).toBeUndefined();
      const turnId = started.result.turn.id;
      const directiveOutcome = await withTimeout(
        Promise.race([
          directiveReturned.promise.then(() => "ok" as const),
          directiveFailed.promise.then((message) => `error: ${message}` as const),
        ]),
        "Timed out waiting for terminal directive",
      );
      expect(directiveOutcome).toBe("ok");
      const signal = await withTimeout(
        providerSideEffectEntered.promise,
        "Timed out waiting for provider side effect entry",
      );
      expect(signal?.aborted).toBe(true);

      const beforeSettlement = await readTask(rpc, tmpDir, created.id);
      expect(beforeSettlement.status).not.toBe("completed");
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "completed",
          100,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      const completedTaskUpdate = rpc.waitFor(
        (message) =>
          message.method === "task/updated" &&
          message.params.task?.id === created.id &&
          message.params.task?.status === "completed",
      );
      releaseProviderSideEffect.resolve();
      const terminalBeforeWrite = await Promise.race([
        completedTaskUpdate.then(() => true),
        providerWriteCompleted.promise.then(() => false),
      ]);
      expect(terminalBeforeWrite).toBe(false);
      await waitForFile(providerWritePath);
      await completedTaskUpdate;
      const completed = await waitForTurnCompleted(rpc, threadId, turnId);
      expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
      const finalTask = await readTask(rpc, tmpDir, created.id);
      expect(finalTask.status).toBe("completed");
      await expect(fs.readFile(providerWritePath, "utf8")).resolves.toBe(
        "provider side effect settled before terminal",
      );
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("self-origin terminal directive timeout fails closed until an explicit later accept", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const evidencePath = path.join(tmpDir, "self-terminal-timeout-evidence.txt");
    const providerWritePath = path.join(tmpDir, "self-terminal-timeout-provider-write.txt");
    let holdNextTurn = false;
    let createdForProvider: TaskRecord | null = null;
    const kickoffCompleted = Promise.withResolvers<void>();
    const directiveReturned = Promise.withResolvers<void>();
    const directiveFailed = Promise.withResolvers<string>();
    const providerSideEffectEntered = Promise.withResolvers<AbortSignal | null>();
    const providerWriteCompleted = Promise.withResolvers<void>();
    const releaseProviderSideEffect = Promise.withResolvers<void>();
    const runTurnImpl = (async (params: RunTurnParams) => {
      if (!holdNextTurn) {
        kickoffCompleted.resolve();
        return { text: "kickoff complete", responseMessages: [] };
      }
      try {
        const context = params.getTaskContext?.();
        const workItem = context?.workItems[0] ?? createdForProvider?.workItems[0];
        const expectedRevision = context?.revision ?? createdForProvider?.revision;
        if (!workItem || expectedRevision === undefined) {
          throw new Error("Expected task context with a work item");
        }
        await fs.writeFile(evidencePath, "ready for delayed completion", "utf8");
        const registered = await params.applyTaskDirective?.({
          type: "register_artifact",
          idempotencyKey: "self-terminal-timeout-register-artifact",
          expectedRevision,
          path: "self-terminal-timeout-evidence.txt",
          title: "Self-terminal timeout evidence",
          kind: "text",
          workItemId: workItem.id,
        });
        if (!registered) throw new Error("Expected register_artifact directive result");
        const marked = await params.applyTaskDirective?.({
          type: "mark_work_item",
          idempotencyKey: "self-terminal-timeout-mark-work",
          expectedRevision: registered.task.revision,
          workItemId: workItem.id,
          status: "done",
          completionEvidence: "Focused timeout regression completed its work item.",
        });
        if (!marked) throw new Error("Expected mark_work_item directive result");
        await params.applyTaskDirective?.({
          type: "propose_completion",
          idempotencyKey: "self-terminal-timeout-propose-completion",
          expectedRevision: marked.task.revision,
          summary: "Self-origin terminal timeout proposal",
        });
        directiveReturned.resolve();
      } catch (error) {
        directiveFailed.resolve(error instanceof Error ? error.message : String(error));
        throw error;
      }
      providerSideEffectEntered.resolve(params.abortSignal ?? null);
      await releaseProviderSideEffect.promise;
      await fs.writeFile(providerWritePath, "provider side effect settled after timeout", "utf8");
      providerWriteCompleted.resolve();
      return {
        text: "provider turn settled after self-origin terminal timeout",
        responseMessages: [],
      };
    }) as never;
    const opts = serverOpts(tmpDir, {
      runTurnImpl,
      taskTerminalQuiesceTimeoutMs: 35,
    });
    let running = await startAgentServer(opts);
    let rpc = await connectJsonRpc(running.url);

    try {
      const createdResponse = await rpc.sendRequest("task/create", {
        ...taskCreateParams(tmpDir, "self-origin-terminal-timeout"),
        workItems: [
          {
            key: "verify",
            title: "Verify self-origin timeout handoff",
            expectedOutputs: ["self-terminal-timeout-evidence.txt"],
          },
        ],
        reviewRequired: false,
        reviewRounds: 0,
      });
      expect(createdResponse.error).toBeUndefined();
      const created = createdResponse.result.task as TaskRecord;
      createdForProvider = created;
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");

      holdNextTurn = true;
      const started = await rpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "complete this task but let terminal quiesce time out" }],
      });
      expect(started.error).toBeUndefined();
      const turnId = started.result.turn.id;
      const directiveOutcome = await Promise.race([
        directiveReturned.promise.then(() => "ok" as const),
        directiveFailed.promise.then((message) => `error: ${message}` as const),
        delay(2_000).then(() => "timeout" as const),
      ]);
      expect(directiveOutcome).toBe("ok");
      const signal = await providerSideEffectEntered.promise;
      expect(signal?.aborted).toBe(true);

      await expectTaskLocked(
        await rpc.sendRequest("turn/steer", {
          threadId,
          turnId,
          input: [{ type: "text", text: "blocked while self-terminal finalizer is pending" }],
        }),
        "finalizing completed",
        {
          lockKind: "terminal_task_thread",
          taskId: created.id,
          taskStatus: "completed",
        },
      );

      await delay(120);
      const afterTimeout = await readTask(rpc, tmpDir, created.id);
      expect(afterTimeout.status).toBe("awaiting_review");
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "completed",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      const steerAfterTimeout = await rpc.sendRequest("turn/steer", {
        threadId,
        turnId,
        input: [{ type: "text", text: "accepted after timed-out self-terminal lock releases" }],
      });
      expect(steerAfterTimeout.error).toBeUndefined();

      releaseProviderSideEffect.resolve();
      await providerWriteCompleted.promise;
      const completed = await waitForTurnCompleted(rpc, threadId, turnId);
      expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
      await expect(fs.readFile(providerWritePath, "utf8")).resolves.toBe(
        "provider side effect settled after timeout",
      );
      expect(await readTask(rpc, tmpDir, created.id)).toMatchObject({
        id: created.id,
        status: "awaiting_review",
      });
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "completed",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      rpc.close();
      await stopTestServer(running.server);

      running = await startAgentServer(opts);
      rpc = await connectJsonRpc(running.url);
      const afterRestart = await readTask(rpc, tmpDir, created.id);
      expect(afterRestart.status).toBe("awaiting_review");
      const acceptUpdate = rpc.waitFor(
        (message) =>
          message.method === "task/updated" &&
          message.params.task?.id === created.id &&
          message.params.task?.status === "completed",
        1_000,
      );
      const accepted = await rpc.sendRequest("task/accept", {
        cwd: tmpDir,
        taskId: afterRestart.id,
        expectedRevision: afterRestart.revision,
      });
      expect(accepted.error).toBeUndefined();
      expect(accepted.result.task.status).toBe("completed");
      const terminalUpdate = await acceptUpdate;
      expect(terminalUpdate.params.task.revision).toBe(accepted.result.task.revision);
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === created.id &&
            message.params.task?.status === "completed",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
      rpc.close();
    } finally {
      rpc.close();
      await stopTestServer(running.server);
    }
  }, 20_000);

  test("terminal abort does not launch provider continuation fallback retry", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    let holdNextTurn = false;
    let activeTurnCalls = 0;
    let retryProviderState: unknown;
    const kickoffCompleted = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<AbortSignal | null>();
    const releaseManual = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: RunTurnParams) => {
          if (!holdNextTurn) {
            kickoffCompleted.resolve();
            return {
              text: "kickoff complete",
              responseMessages: [],
              providerState: {
                provider: "google",
                model: "gemini-test",
                interactionId: "interaction_stale",
                updatedAt: "2026-06-20T00:00:00.000Z",
              },
            };
          }
          activeTurnCalls += 1;
          if (activeTurnCalls === 1) {
            manualStarted.resolve(params.abortSignal ?? null);
            await releaseManual.promise;
            throw new Error("Invalid previous_interaction_id: interaction not found");
          }
          retryProviderState = params.providerState;
          return {
            text: "fallback retry escaped after terminal cancellation",
            responseMessages: [],
          };
        }) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const created = await createTask(rpc, tmpDir, "continuation-abort-race");
      const threadId = created.threads[0]?.sessionId;
      if (!threadId) throw new Error("Expected primary task thread");
      await kickoffCompleted.promise;
      await waitForThreadReadToContain(rpc, threadId, "kickoff complete");

      holdNextTurn = true;
      const started = await rpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "start continuation fallback race" }],
      });
      expect(started.error).toBeUndefined();
      const turnId = started.result.turn.id;
      const signal = await manualStarted.promise;

      const latest = await readTask(rpc, tmpDir, created.id);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId: latest.id,
        expectedRevision: latest.revision,
        reason: "Close the task before invalid continuation fallback retry.",
      });
      await waitForCondition(() => signal?.aborted === true, "task cancel did not abort the turn");
      expect(signal?.aborted).toBe(true);
      const pendingTerminal = await readTask(rpc, tmpDir, created.id);
      expect(pendingTerminal.status).toBe("working");

      releaseManual.resolve();
      const cancelled = await cancelPromise;
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result.task.status).toBe("cancelled");
      const completed = await waitForTurnCompleted(rpc, threadId, turnId);
      expect(completed.params.turn).toMatchObject({ id: turnId, status: "interrupted" });
      expect(activeTurnCalls).toBe(1);
      expect(retryProviderState).toBeUndefined();

      const read = await rpc.sendRequest("thread/read", { threadId, includeTurns: true });
      expect(read.error).toBeUndefined();
      expect(JSON.stringify(read.result)).not.toContain("fallback retry escaped");
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
      const activeTaskStatus = createdNotification.params.task.status;
      await waitForTurnCompleted(sourceRpc, sourceThreadId, promotionTurn.result.turn.id);

      const lockedSource = await sourceRpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "source write while task is active" }],
      });
      await expectTaskLocked(lockedSource, "Chat is locked by active task", {
        lockKind: "active_source_chat",
        taskId,
        taskStatus: activeTaskStatus,
        taskTitle: "Source chat terminal lock",
      });

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

  test("terminal transition waits for promoted source chat turn settlement before committing", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const sourceWritePath = path.join(tmpDir, "source-chat-settled-before-terminal.txt");
    let sourceThreadIdForProvider: string | null = null;
    let promoteNextSourceTurn = true;
    const createdFromTool = Promise.withResolvers<TaskRecord>();
    const sourceAbortObserved = Promise.withResolvers<AbortSignal | null>();
    const sourceWriteCompleted = Promise.withResolvers<void>();
    const releaseSourceTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: RunTurnParams) => {
          if (params.sessionId !== sourceThreadIdForProvider) {
            return { text: "task thread kickoff", responseMessages: [] };
          }
          if (promoteNextSourceTurn) {
            promoteNextSourceTurn = false;
            const result = await params.createTask?.({
              idempotencyKey: "source-chat-terminal-quiesce",
              title: "Source chat terminal quiesce",
              objective: "Prove source-chat turns settle before terminal task state commits.",
              context: "Created through the real chat createTask path while the source turn waits.",
              requirements: [
                {
                  kind: "acceptance_criterion",
                  text: "Terminal transitions quiesce the promoted source chat.",
                },
              ],
              workItems: [
                {
                  key: "verify",
                  title: "Verify source quiescence",
                  expectedOutputs: ["source-chat-settled-before-terminal.txt"],
                },
              ],
              decisions: [],
              reviewRequired: false,
              reviewRounds: 0,
            });
            if (!result) throw new Error("createTask tool path was not registered");
            createdFromTool.resolve(result.task);
            await waitForCondition(
              () => params.abortSignal?.aborted === true,
              "source chat turn was not aborted by terminal quiescence",
            );
            sourceAbortObserved.resolve(params.abortSignal ?? null);
            await releaseSourceTurn.promise;
            await fs.writeFile(
              sourceWritePath,
              "source side effect settled before terminal",
              "utf8",
            );
            sourceWriteCompleted.resolve();
            return { text: "source turn settled", responseMessages: [] };
          }
          return { text: "source chat after terminal", responseMessages: [] };
        }) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      expect(started.error).toBeUndefined();
      const sourceThreadId = started.result.thread.id;
      sourceThreadIdForProvider = sourceThreadId;

      const promotionTurn = await rpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "promote this chat and keep the source turn open" }],
      });
      expect(promotionTurn.error).toBeUndefined();
      const sourceTurnId = promotionTurn.result.turn.id;
      const createdNotification = await rpc.waitFor((message) => message.method === "task/created");
      const taskId = createdNotification.params.task.id;
      const created = await createdFromTool.promise;
      expect(created.id).toBe(taskId);

      const latest = await readTask(rpc, tmpDir, taskId);
      const cancelPromise = rpc.sendRequest("task/cancel", {
        cwd: tmpDir,
        taskId,
        expectedRevision: latest.revision,
        reason: "Cancel while the promoted source chat turn is still draining.",
      });
      const sourceSignal = await sourceAbortObserved.promise;
      expect(sourceSignal?.aborted).toBe(true);

      await expectTaskLocked(
        await rpc.sendRequest("turn/steer", {
          threadId: sourceThreadId,
          turnId: sourceTurnId,
          input: [{ type: "text", text: "blocked while source terminal quiesce is pending" }],
        }),
        "finalizing cancelled",
        {
          lockKind: "terminal_task_thread",
          taskId,
          taskStatus: "cancelled",
        },
      );

      await delay(120);
      expect(await readTask(rpc, tmpDir, taskId)).toMatchObject({
        id: taskId,
        status: "working",
        revision: latest.revision,
      });
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "task/updated" &&
            message.params.task?.id === taskId &&
            message.params.task?.status === "cancelled",
          120,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      releaseSourceTurn.resolve();
      await sourceWriteCompleted.promise;
      const sourceCompleted = await waitForTurnCompleted(rpc, sourceThreadId, sourceTurnId);
      expect(sourceCompleted.params.turn).toMatchObject({
        id: sourceTurnId,
        status: "interrupted",
      });
      const cancelled = await cancelPromise;
      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result.task.status).toBe("cancelled");
      await expect(fs.readFile(sourceWritePath, "utf8")).resolves.toBe(
        "source side effect settled before terminal",
      );
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("queued source chat steers are rejected if createTask locks the source before drain", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    let sourceProviderPasses = 0;
    let sourceThreadIdForProvider: string | null = null;
    const providerEntered = Promise.withResolvers<void>();
    const releasePromotion = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: RunTurnParams) => {
          if (params.sessionId !== sourceThreadIdForProvider) {
            return { text: "task thread kickoff", responseMessages: [] };
          }
          sourceProviderPasses += 1;
          if (sourceProviderPasses === 1) {
            providerEntered.resolve();
            await releasePromotion.promise;
            const result = await params.createTask?.({
              idempotencyKey: "source-chat-queued-steer",
              title: "Queued steer source lock",
              objective: "Prove queued source-chat steers cannot drain after task promotion.",
              context: "Created through the real chat createTask path while a steer is queued.",
              requirements: [
                {
                  kind: "acceptance_criterion",
                  text: "Queued steers are cleared with task_locked after source promotion.",
                },
              ],
              workItems: [
                {
                  key: "verify",
                  title: "Verify queued steer lock",
                  expectedOutputs: ["queued-steer-lock.txt"],
                },
              ],
              decisions: [],
              reviewRequired: false,
              reviewRounds: 0,
            });
            if (!result) throw new Error("createTask tool path was not registered");
            return { text: "promotion complete", responseMessages: [] };
          }
          return {
            text: "queued steer escaped after source lock",
            responseMessages: [],
          };
        }) as never,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      expect(started.error).toBeUndefined();
      const sourceThreadId = started.result.thread.id;
      sourceThreadIdForProvider = sourceThreadId;

      const promotionTurn = await rpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "promote this chat to a task" }],
      });
      expect(promotionTurn.error).toBeUndefined();
      const turnId = promotionTurn.result.turn.id;
      await providerEntered.promise;

      const steer = await rpc.sendRequest("turn/steer", {
        threadId: sourceThreadId,
        turnId,
        input: [{ type: "text", text: "queued steer should not survive promotion" }],
      });
      expect(steer.error).toBeUndefined();
      const secondSteer = await rpc.sendRequest("turn/steer", {
        threadId: sourceThreadId,
        turnId,
        input: [{ type: "text", text: "second queued steer should be cleared too" }],
      });
      expect(secondSteer.error).toBeUndefined();
      releasePromotion.resolve();

      const createdNotification = await rpc.waitFor((message) => message.method === "task/created");
      const taskId = createdNotification.params.task.id;
      const lockError = await rpc.waitFor(
        (message) =>
          message.method === "item/started" &&
          message.params.item?.type === "error" &&
          message.params.item?.code === "task_locked" &&
          message.params.item?.data?.lockKind === "active_source_chat",
      );
      await waitForTurnCompleted(rpc, sourceThreadId, turnId);

      expect(sourceProviderPasses).toBe(1);
      expect(lockError.params.item.data).toEqual(
        expect.objectContaining({
          category: "task_locked",
          source: "session",
          lockKind: "active_source_chat",
          taskId,
          taskStatus: "working",
          taskTitle: "Queued steer source lock",
        }),
      );
      const read = await rpc.sendRequest("thread/read", {
        threadId: sourceThreadId,
        includeTurns: true,
      });
      expect(read.error).toBeUndefined();
      const serializedThread = JSON.stringify(read.result);
      expect(serializedThread).not.toContain("queued steer should not survive promotion");
      expect(serializedThread).not.toContain("second queued steer should be cleared too");
      expect(serializedThread).not.toContain("queued steer escaped after source lock");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("source chat promotion blocks later tool mutations in the same assistant step", async () => {
    const tmpDir = await makeCanonicalTmpProject();
    const leakedWritePath = path.join(tmpDir, "source-chat-after-createTask.txt");
    let shouldPromote = true;
    let writeAfterPromotionResult: string | null = null;
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          if (!shouldPromote) {
            return { text: "task kickoff complete", responseMessages: [] };
          }
          shouldPromote = false;
          await params.tools.createTask.execute({
            idempotencyKey: "source-chat-same-step-tool-gate",
            title: "Source chat same-step gate",
            objective: "Prove createTask locks later same-step tool mutations.",
            context: "Created through the real createTask tool during the source chat turn.",
            requirements: [
              {
                kind: "acceptance_criterion",
                text: "No source-chat write can run after task promotion in the same assistant step.",
              },
            ],
            workItems: [
              {
                key: "verify",
                title: "Verify same-step source lock",
                expectedOutputs: ["same-step-lock.txt"],
              },
            ],
            decisions: [],
            reviewRequired: false,
            reviewRounds: 0,
          });
          try {
            await params.tools.write.execute({
              filePath: leakedWritePath,
              content: "source chat write escaped after createTask",
            });
            writeAfterPromotionResult = "wrote";
          } catch (error) {
            writeAfterPromotionResult = error instanceof Error ? error.message : String(error);
          }
          return {
            text: `same-step source mutation result: ${writeAfterPromotionResult}`,
            responseMessages: [],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      expect(started.error).toBeUndefined();
      const sourceThreadId = started.result.thread.id;

      const promotionTurn = await rpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "promote and then try to write" }],
      });
      expect(promotionTurn.error).toBeUndefined();
      const createdNotification = await rpc.waitFor((message) => message.method === "task/created");
      const taskId = createdNotification.params.task.id;
      await waitForTurnCompleted(rpc, sourceThreadId, promotionTurn.result.turn.id);

      expect(writeAfterPromotionResult).toMatch(/source chat is locked by active task/);
      await expect(fs.access(leakedWritePath)).rejects.toThrow();

      const lockedSource = await rpc.sendRequest("turn/start", {
        threadId: sourceThreadId,
        input: [{ type: "text", text: "source write while same-step task is active" }],
      });
      await expectTaskLocked(lockedSource, "Chat is locked by active task", {
        lockKind: "active_source_chat",
        taskId,
        taskStatus: "working",
        taskTitle: "Source chat same-step gate",
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);
});
