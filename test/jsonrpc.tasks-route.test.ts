import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  JsonRpcLiteError,
  JsonRpcLiteId,
  JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createTaskRouteHandlers } from "../src/server/jsonrpc/routes/tasks";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcTaskResultSchemas } from "../src/server/jsonrpc/schema.tasks";
import type { TaskRecord } from "../src/shared/tasks";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const createdAt = "2026-06-18T12:00:00.000Z";
  return {
    id: "task-1",
    workspacePath: "C:\\workspace",
    title: "Task",
    objective: "Do the work",
    status: "draft",
    revision: 0,
    reviewRequired: true,
    createdAt,
    updatedAt: createdAt,
    threadCount: 1,
    completedWorkItemCount: 0,
    totalWorkItemCount: 0,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
    requirements: [],
    threads: [
      {
        id: "task-thread-1",
        taskId: "task-1",
        sessionId: "session-1",
        title: "Main",
        createdBy: "user",
        createdAt,
        updatedAt: createdAt,
      },
    ],
    workItems: [],
    decisions: [],
    questions: [],
    artifacts: [],
    blockers: [],
    activity: [
      {
        id: "activity-1",
        seq: 1,
        taskId: "task-1",
        threadId: "task-thread-1",
        workItemId: null,
        kind: "task_created",
        summary: "Task created",
        detail: null,
        createdAt,
      },
    ],
    latestCheckpoint: null,
    ...overrides,
  };
}

function makeHarness(
  overrides: {
    updateBrief?: () => Promise<TaskRecord>;
    retryTask?: (input: unknown) => Promise<{
      task: TaskRecord;
      retryStatus: "queued" | "steered" | "failed";
    }>;
    transition?: (input: unknown) => Promise<TaskRecord>;
    resolveQuestions?: (input: unknown) => Promise<{
      task: TaskRecord;
      resumeStatus: "queued" | "steered" | "not_needed" | "failed";
    }>;
    resolveWorkspacePath?: (params: unknown, method: string) => string;
  } = {},
) {
  const results: Array<{ id: JsonRpcLiteId; result: unknown }> = [];
  const errors: Array<{ id: JsonRpcLiteId | null; error: JsonRpcLiteError }> = [];
  const createCalls: unknown[] = [];
  const task = makeTask();
  const {
    requirements: _requirements,
    threads: _threads,
    workItems: _workItems,
    decisions: _decisions,
    questions: _questions,
    artifacts: _artifacts,
    blockers: _blockers,
    activity: _activity,
    latestCheckpoint: _latestCheckpoint,
    ...summary
  } = task;
  let waited = false;
  const runtime = {
    id: "session-1",
    lifecycle: {
      waitForPersistenceIdle: async () => {
        waited = true;
      },
    },
    turns: {
      sendUserMessage: async () => {},
    },
  };
  const context = {
    tasks: {
      getByCreationKey: () => null,
      createPlanned: async (input: unknown) => {
        createCalls.push(input);
        return { task, workspaceDisposition: "existing_project" as const };
      },
      list: () => [summary],
      get: () => task,
      updateBrief: overrides.updateBrief ?? (async () => task),
      transition: overrides.transition ?? (async () => task),
      retryTask:
        overrides.retryTask ??
        (async () => ({
          task: makeTask({ status: "working", revision: 1 }),
          retryStatus: "queued" as const,
        })),
      resolveQuestions:
        overrides.resolveQuestions ??
        (async () => ({
          task,
          resumeStatus: "queued" as const,
        })),
    },
    threads: {
      create: () => runtime,
      getLive: () => undefined,
      getPersisted: () => null,
    },
    utils: {
      resolveWorkspacePath: overrides.resolveWorkspacePath ?? (() => "C:\\workspace"),
      buildThreadFromSession: () => ({
        id: "session-1",
        title: "New thread",
        preview: "",
        modelProvider: "openai",
        model: "gpt-5",
        cwd: "C:\\workspace",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        messageCount: 0,
        lastEventSeq: 0,
        status: { type: "loaded" },
      }),
    },
    jsonrpc: {
      sendResult: (_ws: unknown, id: JsonRpcLiteId, result: unknown) =>
        results.push({ id, result }),
      sendError: (_ws: unknown, id: JsonRpcLiteId | null, error: JsonRpcLiteError) =>
        errors.push({ id, error }),
    },
  } as unknown as JsonRpcRouteContext;
  return {
    context,
    results,
    errors,
    createCalls,
    task,
    get waited() {
      return waited;
    },
  };
}

async function invoke(context: JsonRpcRouteContext, method: string, params: unknown) {
  const handler = createTaskRouteHandlers(context)[method];
  if (!handler) throw new Error(`Missing handler: ${method}`);
  const request: JsonRpcLiteRequest = { id: 1, method, params };
  await handler({} as never, request);
}

describe("task JSON-RPC routes", () => {
  test("rejects task reads and mutations for explicitly underprivileged sockets", async () => {
    const harness = makeHarness();
    const handlers = createTaskRouteHandlers(harness.context);
    const underprivilegedSocket = {
      data: {
        taskReadAllowed: false,
        taskMutationAllowed: false,
      },
    } as never;

    await handlers["task/list"]?.(underprivilegedSocket, {
      id: 1,
      method: "task/list",
      params: { cwd: "C:\\workspace" },
    });
    await handlers["task/updateBrief"]?.(underprivilegedSocket, {
      id: 2,
      method: "task/updateBrief",
      params: {
        cwd: "C:\\workspace",
        taskId: "task-1",
        expectedRevision: 1,
        title: "Updated",
      },
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([
      {
        id: 1,
        error: {
          code: -32600,
          message: "task/list requires conversations permission",
          data: { category: "permission_denied", permission: "conversations" },
        },
      },
      {
        id: 2,
        error: {
          code: -32600,
          message: "task/updateBrief requires conversations permission",
          data: { category: "permission_denied", permission: "conversations" },
        },
      },
    ]);
  });

  test("rejects task mutations for sockets with read-only task permission", async () => {
    const harness = makeHarness();
    const handlers = createTaskRouteHandlers(harness.context);
    const readOnlySocket = {
      data: {
        taskReadAllowed: true,
        taskMutationAllowed: false,
      },
    } as never;

    await handlers["task/updateBrief"]?.(readOnlySocket, {
      id: 1,
      method: "task/updateBrief",
      params: {
        cwd: "C:\\workspace",
        taskId: "task-1",
        expectedRevision: 1,
        title: "Updated",
      },
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([
      {
        id: 1,
        error: {
          code: -32600,
          message: "task/updateBrief requires turns permission",
          data: { category: "permission_denied", permission: "turns" },
        },
      },
    ]);
  });

  test("task/cancel validates the workspace before entering the coordinator transition", async () => {
    const transitionInputs: unknown[] = [];
    const harness = makeHarness({
      resolveWorkspacePath: () => {
        throw new Error("task/cancel cwd must match an authorized project workspace");
      },
      transition: async (input) => {
        transitionInputs.push(input);
        throw new Error("transition should not run for an unauthorized workspace");
      },
    });

    await invoke(harness.context, "task/cancel", {
      cwd: "C:\\unauthorized",
      taskId: "task-1",
      expectedRevision: 0,
      reason: "wrong workspace",
    });

    expect(transitionInputs).toEqual([]);
    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([
      {
        id: 1,
        error: {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "task/cancel cwd must match an authorized project workspace",
        },
      },
    ]);
  });

  test("creates an isolated task thread and waits for session persistence", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/create", {
      cwd: "C:\\workspace",
      idempotencyKey: "manual-task-1",
      title: "Task",
      objective: "Do the work",
      context: "The task needs an explicit implementation and verification pass.",
      requirements: [
        { kind: "acceptance_criterion", text: "The implementation passes its tests." },
      ],
      workItems: [
        {
          key: "implement",
          title: "Implement",
          description: "Build the requested feature.",
          dependsOn: [],
          expectedOutputs: ["Working implementation"],
        },
      ],
      decisions: [],
      reviewRequired: true,
      reviewRounds: 5,
    });

    expect(harness.waited).toBe(true);
    expect(harness.createCalls).toHaveLength(1);
    expect(harness.errors).toEqual([]);
    expect(
      jsonRpcTaskResultSchemas["task/create"].safeParse(harness.results[0]?.result).success,
    ).toBe(true);
    expect(harness.createCalls[0]).toEqual(
      expect.objectContaining({
        creationOrigin: "manual",
        sourceSessionId: null,
        creation: expect.objectContaining({
          idempotencyKey: "manual-task-1",
          reviewRounds: 5,
        }),
      }),
    );
  });

  test("rejects manual task creation without a complete initial plan", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/create", {
      cwd: "C:\\workspace",
      idempotencyKey: "incomplete",
      title: "Task",
      objective: "Do the work",
      context: "Missing a work graph.",
      requirements: [{ kind: "acceptance_criterion", text: "Done" }],
      workItems: [],
    });

    expect(harness.createCalls).toEqual([]);
    expect(harness.errors[0]?.error.code).toBe(-32602);
  });

  test("lists task summaries independently from chat threads", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/list", { cwd: "C:\\workspace" });

    expect(harness.errors).toEqual([]);
    expect(
      jsonRpcTaskResultSchemas["task/list"].safeParse(harness.results[0]?.result).success,
    ).toBe(true);
  });

  test("allows task reads for a desktop-persisted workspace from the workspace catalog", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-route-catalog-"));
    const harness = makeHarness();
    const calls: string[] = [];
    try {
      const activeWorkspace = path.join(home, "workspace-a");
      const catalogWorkspace = path.join(home, "workspace-b");
      await fs.mkdir(activeWorkspace, { recursive: true });
      await fs.mkdir(catalogWorkspace, { recursive: true });
      const activePath = await fs.realpath(activeWorkspace);
      const catalogPath = await fs.realpath(catalogWorkspace);
      (harness.context as unknown as { desktopService: unknown }).desktopService = {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "project-b",
              name: "Project B",
              path: catalogPath,
              workspaceKind: "project",
              createdAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        }),
      };
      (harness.context as unknown as { getConfig: () => { workingDirectory: string } }).getConfig =
        () => ({ workingDirectory: activePath });
      (
        harness.context as unknown as { utils: { resolveWorkspacePath: () => string } }
      ).utils.resolveWorkspacePath = () => {
        throw new Error("task/list cwd must match an authorized workspace");
      };
      (
        harness.context as unknown as { tasks: { list: (workspacePath: string) => unknown[] } }
      ).tasks.list = (workspacePath: string) => {
        calls.push(workspacePath);
        return [];
      };

      await invoke(harness.context, "task/list", { cwd: `${catalogPath}${path.sep}.` });

      expect(harness.errors).toEqual([]);
      expect(harness.results[0]?.result).toEqual({ tasks: [], total: 0 });
      expect(calls).toEqual([catalogPath]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("retries a failed task through the coordinator", async () => {
    const calls: unknown[] = [];
    const harness = makeHarness({
      retryTask: async (input) => {
        calls.push(input);
        return {
          task: makeTask({ status: "working", revision: 3 }),
          retryStatus: "queued",
        };
      },
    });
    await invoke(harness.context, "task/retry", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      expectedRevision: 2,
    });

    expect(harness.errors).toEqual([]);
    expect(calls).toEqual([
      {
        taskId: "task-1",
        workspacePath: "C:\\workspace",
        expectedRevision: 2,
      },
    ]);
    expect(
      jsonRpcTaskResultSchemas["task/retry"].safeParse(harness.results[0]?.result).success,
    ).toBe(true);
  });

  test("returns structured revision conflicts", async () => {
    const harness = makeHarness({
      updateBrief: async () => {
        throw new Error("Task revision conflict: expected 1, current 2");
      },
    });
    await invoke(harness.context, "task/updateBrief", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      expectedRevision: 1,
      objective: "Updated objective",
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors[0]?.error.data).toEqual({
      category: "revision_conflict",
      expectedRevision: 1,
      currentRevision: 2,
    });
  });

  test("resolves a task question and returns automatic resume status", async () => {
    const calls: unknown[] = [];
    const harness = makeHarness({
      resolveQuestions: async (input) => {
        calls.push(input);
        return { task: makeTask(), resumeStatus: "steered" };
      },
    });
    await invoke(harness.context, "task/questions/resolve", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      expectedRevision: 2,
      answers: [{ questionId: "question-1", optionId: "option-1" }],
    });

    expect(harness.errors).toEqual([]);
    expect(calls[0]).toEqual({
      taskId: "task-1",
      workspacePath: "C:\\workspace",
      expectedRevision: 2,
      answers: [{ questionId: "question-1", optionId: "option-1" }],
    });
    expect(
      jsonRpcTaskResultSchemas["task/questions/resolve"].safeParse(harness.results[0]?.result)
        .success,
    ).toBe(true);
  });

  test("rejects task question answers that provide both an option and text", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/questions/resolve", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      expectedRevision: 2,
      answers: [
        {
          questionId: "question-1",
          optionId: "option-1",
          text: "Conflicting free text",
        },
      ],
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors[0]?.error.code).toBe(-32602);
  });
});
