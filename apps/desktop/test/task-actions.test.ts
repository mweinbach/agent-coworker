import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskQuestion,
  TaskRecord,
} from "../../../src/shared/tasks";
import {
  __internalTaskActions,
  createTaskActions,
  type TaskActionDependencies,
} from "../src/app/store.actions/tasks";
import type { ThreadRecord } from "../src/app/types";

const NOW = "2026-06-18T12:00:00.000Z";

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    workspacePath: "C:/Users/Max/Projects/Demo",
    title: "Implement task mode",
    objective: "Add explicit task mode without changing standard chat.",
    status: "working",
    revision: 2,
    reviewRequired: true,
    createdAt: NOW,
    updatedAt: NOW,
    threadCount: 1,
    completedWorkItemCount: 0,
    totalWorkItemCount: 1,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
    requirements: [],
    threads: [
      {
        id: "task-thread-1",
        taskId: "task-1",
        sessionId: "task-session-1",
        title: "Main",
        createdBy: "coordinator",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ] as ThreadRecord[],
    workItems: [
      {
        id: "work-1",
        taskId: "task-1",
        title: "Build the mode",
        description: "",
        status: "in_progress",
        dependsOn: [],
        assignedThreadId: null,
        claimedByThreadId: null,
        expectedOutputs: [],
        completionEvidence: null,
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    decisions: [],
    questions: [],
    artifacts: [],
    blockers: [],
    activity: [],
    latestCheckpoint: null,
    ...overrides,
  };
}

function artifactDetail(overrides: Partial<TaskArtifactDetail> = {}): TaskArtifactDetail {
  return {
    artifact: {
      id: "artifact-1",
      taskId: "task-1",
      workItemId: "work-1",
      threadId: "task-thread-1",
      path: "C:/Users/Max/Projects/Demo/report.md",
      kind: "markdown",
      title: "Report",
      createdBy: "task-session-1",
      provenance: { source: "agent" },
      createdAt: NOW,
    },
    versions: [
      {
        id: "version-1",
        artifactId: "artifact-1",
        version: 1,
        parentVersionId: null,
        sha256: "a".repeat(64),
        sizeBytes: 128,
        mediaType: "text/markdown",
        createdBy: "task-session-1",
        createdAt: NOW,
        changeSummary: "Initial draft",
        provenance: { source: "agent" },
        reviewStatus: "draft",
      },
    ],
    latestVersionId: "version-1",
    acceptedVersionId: null,
    activeRevision: null,
    ...overrides,
  };
}

function taskQuestion(overrides: Partial<TaskQuestion> = {}): TaskQuestion {
  return {
    id: "question-1",
    taskId: "task-1",
    threadId: "task-thread-1",
    workItemId: null,
    header: "Audience",
    question: "Who is the audience?",
    context: "The answer changes the final recommendation.",
    blocking: true,
    urgency: "now",
    defaultAction: null,
    options: [
      { id: "internal", label: "Internal", description: "Use a candid recommendation." },
      { id: "client", label: "Client", description: "Use client-facing language." },
    ],
    recommendedOptionId: "internal",
    status: "pending",
    provisionalDecisionId: null,
    answer: null,
    answerOptionId: null,
    resolutionSource: null,
    supersedes: null,
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

function createHarness() {
  const reconnectThread = mock(async () => {});
  const state = {
    workspaces: [
      {
        id: "ws-1",
        name: "Demo",
        path: "C:\\Users\\Max\\Projects\\Demo\\",
        workspaceKind: "project",
      },
    ],
    threads: [
      {
        id: "chat-1",
        workspaceId: "ws-1",
        title: "Standard chat",
        createdAt: NOW,
        lastMessageAt: NOW,
        status: "active",
        sessionId: "chat-1",
        messageCount: 1,
        lastEventSeq: 1,
      },
    ],
    selectedWorkspaceId: "ws-1",
    selectedThreadId: "chat-1",
    selectedTaskId: null as string | null,
    newTaskWorkspaceId: null as string | null,
    view: "chat",
    taskSummariesByWorkspaceId: {},
    tasksById: {} as Record<string, TaskRecord>,
    taskListLoadingByWorkspaceId: {},
    taskError: null as string | null,
    threadRuntimeById: {},
    notifications: [],
    reconnectThread,
    addWorkspace: mock(async () => {}),
  };
  const get = () => state;
  const set = (updater: Record<string, unknown> | ((value: typeof state) => object)) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    Object.assign(state, patch);
  };
  return { get, reconnectThread, set, state };
}

describe("desktop task actions", () => {
  let notificationRouter:
    | ((message: { kind: "notification"; method: string; params?: unknown }) => void)
    | null;
  const requestJsonRpc = mock(
    async (
      _get: unknown,
      _set: unknown,
      _workspaceId: unknown,
      method: string,
      _params?: unknown,
    ) => {
      if (method === "task/list") return { tasks: [] };
      return { task: taskRecord(), thread: { id: "task-session-1" } };
    },
  );
  const deps = {
    ensureControlSocket: () => {},
    ensureServerRunning: async () => {},
    ensureThreadRuntime: () => {},
    registerWorkspaceJsonRpcLifecycle: () => () => {},
    registerWorkspaceJsonRpcRouter: (_workspaceId: string, router: typeof notificationRouter) => {
      notificationRouter = router;
      return () => {
        notificationRouter = null;
      };
    },
    requestJsonRpc,
    syncDesktopStateCache: () => {},
    persistNow: async () => {},
  } as unknown as TaskActionDependencies;

  beforeEach(() => {
    __internalTaskActions.reset();
    notificationRouter = null;
    requestJsonRpc.mockClear();
  });

  test("creates an explicit task thread without replacing standard chat", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);

    const created = await actions.startTask({
      workspaceId: "ws-1",
      task: {
        idempotencyKey: "manual-task-1",
        title: "Implement task mode",
        objective: "Add explicit task mode without changing standard chat.",
        context: "The chat flow must remain available alongside managed tasks.",
        requirements: [
          {
            kind: "acceptance_criterion",
            text: "A complete task opens in the work-first task view.",
          },
        ],
        workItems: [
          {
            key: "implement",
            title: "Implement task mode",
            description: "Build and verify the managed task flow.",
            dependsOn: [],
            expectedOutputs: ["Working task mode"],
          },
        ],
        decisions: [],
        reviewRequired: true,
      },
    });

    expect(created?.id).toBe("task-1");
    expect(harness.state.view).toBe("task");
    expect(harness.state.selectedTaskId).toBe("task-1");
    expect(harness.state.selectedThreadId).toBe("task-session-1");
    expect(harness.state.threads.find((thread) => thread.id === "chat-1")?.taskId).toBeUndefined();
    expect(harness.state.threads.find((thread) => thread.id === "task-session-1")?.taskId).toBe(
      "task-1",
    );
    expect(harness.reconnectThread).toHaveBeenCalledWith("task-session-1", undefined, {
      skipWorkspaceSelect: true,
      refreshSnapshot: true,
    });
    expect(requestJsonRpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ws-1",
      "task/create",
      expect.objectContaining({
        idempotencyKey: "manual-task-1",
        context: "The chat flow must remain available alongside managed tasks.",
        workItems: [expect.objectContaining({ key: "implement" })],
      }),
    );
  });

  test("promotes a one-off chat workspace and takes over on model-created tasks", async () => {
    const harness = createHarness();
    harness.state.workspaces[0] = {
      ...harness.state.workspaces[0],
      name: "Chat",
      workspaceKind: "oneOffChat",
    };
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    await actions.refreshTasks("ws-1");

    const created = taskRecord({
      context: "Structured handoff",
      sourceSessionId: "chat-1",
      creationOrigin: "chat_tool",
    });
    notificationRouter?.({
      kind: "notification",
      method: "task/created",
      params: {
        cwd: "c:/users/max/projects/demo",
        task: created,
        sourceSessionId: "chat-1",
        takeover: true,
        workspaceDisposition: "promote_one_off",
      },
    });

    expect(harness.state.workspaces[0]?.workspaceKind).toBe("project");
    expect(harness.state.workspaces[0]?.name).toBe("Implement task mode");
    expect(harness.state.view).toBe("task");
    expect(harness.state.selectedTaskId).toBe("task-1");
    expect(harness.state.selectedThreadId).toBe("task-session-1");
  });

  test("accepts canonical task notifications for the same Windows workspace", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    await actions.refreshTasks("ws-1");

    const updated = taskRecord({
      workspacePath: "c:/users/max/projects/demo",
      title: "Updated task",
      revision: 3,
    });
    notificationRouter?.({
      kind: "notification",
      method: "task/updated",
      params: { cwd: "c:/users/max/projects/demo", task: updated },
    });

    expect(harness.state.tasksById["task-1"]?.title).toBe("Updated task");
    expect(harness.state.threads.some((thread) => thread.id === "task-session-1")).toBe(true);
  });

  test("resolves task questions through JSON-RPC and stores the returned task", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    const pending = taskQuestion();
    harness.state.tasksById["task-1"] = taskRecord({
      status: "blocked",
      revision: 7,
      pendingQuestionCount: 1,
      blockingQuestionCount: 1,
      questions: [pending],
    });
    requestJsonRpc.mockImplementationOnce(async () => ({
      task: taskRecord({
        revision: 8,
        questions: [
          taskQuestion({
            status: "answered",
            answer: "Internal",
            answerOptionId: "internal",
            resolutionSource: "user",
            resolvedAt: NOW,
          }),
        ],
      }),
      resumeStatus: "queued",
    }));

    const result = await actions.resolveTaskQuestions("task-1", [
      { questionId: "question-1", optionId: "internal" },
    ]);

    expect(result).toBe("queued");
    expect(requestJsonRpc.mock.calls.at(-1)?.slice(3)).toEqual([
      "task/questions/resolve",
      {
        cwd: "C:/Users/Max/Projects/Demo",
        taskId: "task-1",
        expectedRevision: 7,
        answers: [{ questionId: "question-1", optionId: "internal" }],
      },
    ]);
    expect(harness.state.tasksById["task-1"]?.revision).toBe(8);
  });

  test("shows one non-modal notification for a blocking input request", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    harness.state.tasksById["task-1"] = taskRecord({
      status: "blocked",
      pendingQuestionCount: 1,
      blockingQuestionCount: 1,
      questions: [taskQuestion()],
    });
    await actions.refreshTasks("ws-1");
    const activity = {
      id: "activity-input-1",
      seq: 2,
      taskId: "task-1",
      threadId: "task-thread-1",
      workItemId: null,
      kind: "input_requested" as const,
      summary: "The task needs one blocking decision",
      detail: null,
      createdAt: NOW,
    };

    notificationRouter?.({
      kind: "notification",
      method: "task/activity",
      params: { cwd: "C:/Users/Max/Projects/Demo", taskId: "task-1", activity },
    });
    notificationRouter?.({
      kind: "notification",
      method: "task/activity",
      params: { cwd: "C:/Users/Max/Projects/Demo", taskId: "task-1", activity },
    });

    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]).toMatchObject({
      id: "task-input:activity-input-1",
      kind: "info",
      title: "Implement task mode needs input",
    });
  });

  test("reports a rejected brief save so the editor can retain unsaved input", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    harness.state.tasksById["task-1"] = taskRecord();
    requestJsonRpc.mockImplementationOnce(async () => {
      throw new Error("Task revision conflict");
    });

    await expect(actions.updateTaskBrief("task-1", { title: "Unsaved title" })).resolves.toBe(
      false,
    );
    expect(harness.state.taskError).toContain("revision conflict");
  });

  test("does not recurse when project creation is cancelled", async () => {
    const harness = createHarness();
    harness.state.workspaces.length = 0;
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);

    await actions.openNewTask();

    expect(harness.state.addWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.state.view).toBe("chat");
  });

  test("reads, previews, and compares artifact versions with the canonical envelopes", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    harness.state.tasksById["task-1"] = taskRecord();
    requestJsonRpc
      .mockImplementationOnce(async () => ({ detail: artifactDetail() }))
      .mockImplementationOnce(async () => ({
        versionId: "version-1",
        preview: {
          kind: "text",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 128,
          sha256: "a".repeat(64),
          warnings: [],
          text: "# Report",
          encoding: "utf-8",
        },
      }))
      .mockImplementationOnce(async () => ({
        comparison: {
          kind: "text",
          summary: {
            totalChanges: 1,
            added: 1,
            removed: 0,
            modified: 0,
            moved: 0,
            byCategory: { line_added: 1 },
          },
          changes: [{ type: "line_added", oldLine: null, newLine: 1, text: "# Report" }],
          truncated: false,
          changeLimit: 10_000,
          warnings: [],
          unifiedDiff: "+# Report",
        },
      }));

    const detail = await actions.readTaskArtifact("task-1", "artifact-1");
    const preview = await actions.previewTaskArtifactVersion("task-1", "artifact-1", "version-1");
    const comparison = await actions.compareTaskArtifactVersions(
      "task-1",
      "artifact-1",
      "version-0",
      "version-1",
    );

    expect(harness.state.taskError).toBeNull();
    expect(detail?.latestVersionId).toBe("version-1");
    expect(preview?.preview.kind).toBe("text");
    expect(comparison?.summary.totalChanges).toBe(1);
    expect(requestJsonRpc.mock.calls.slice(-3).map((call) => [call[3], call[4]])).toEqual([
      ["task/artifact/read", { taskId: "task-1", artifactId: "artifact-1" }],
      [
        "task/artifact/version/preview",
        { taskId: "task-1", artifactId: "artifact-1", versionId: "version-1" },
      ],
      [
        "task/artifact/version/compare",
        {
          taskId: "task-1",
          artifactId: "artifact-1",
          baseVersionId: "version-0",
          targetVersionId: "version-1",
        },
      ],
    ]);
  });

  test("sends expected task revisions for artifact capture, restore, and accept", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    harness.state.tasksById["task-1"] = taskRecord({ revision: 7 });
    requestJsonRpc.mockImplementation(async () => ({
      task: taskRecord({ revision: 8 }),
      detail: artifactDetail(),
    }));

    await actions.captureTaskArtifactVersion("task-1", "artifact-1", "Manual checkpoint");
    harness.state.tasksById["task-1"] = taskRecord({ revision: 7 });
    await actions.restoreTaskArtifactVersion("task-1", "artifact-1", "version-1");
    harness.state.tasksById["task-1"] = taskRecord({ revision: 7 });
    await actions.acceptTaskArtifactVersion("task-1", "artifact-1", "version-1");

    expect(requestJsonRpc.mock.calls.slice(-3).map((call) => [call[3], call[4]])).toEqual([
      [
        "task/artifact/version/capture",
        {
          taskId: "task-1",
          artifactId: "artifact-1",
          expectedRevision: 7,
          changeSummary: "Manual checkpoint",
        },
      ],
      [
        "task/artifact/version/restore",
        {
          taskId: "task-1",
          artifactId: "artifact-1",
          versionId: "version-1",
          expectedRevision: 7,
        },
      ],
      [
        "task/artifact/version/accept",
        {
          taskId: "task-1",
          artifactId: "artifact-1",
          versionId: "version-1",
          expectedRevision: 7,
        },
      ],
    ]);
  });

  test("starts an artifact revision and focuses the returned task thread", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    const focusedThread = {
      id: "task-thread-revision",
      taskId: "task-1",
      sessionId: "task-session-revision",
      title: "Revise report",
      createdBy: "coordinator" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const nextTask = taskRecord({
      revision: 3,
      threads: [...taskRecord().threads, focusedThread],
      threadCount: 2,
    });
    harness.state.tasksById["task-1"] = taskRecord({ revision: 2 });
    const revision: TaskArtifactRevision = {
      id: "revision-1",
      taskId: "task-1",
      artifactId: "artifact-1",
      workItemId: "work-1",
      taskThreadId: focusedThread.id,
      sessionId: focusedThread.sessionId,
      baseVersionId: "version-1",
      priorVersionId: "version-1",
      status: "active",
      instruction: "Tighten the recommendation.",
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
    };
    requestJsonRpc.mockImplementationOnce(async () => ({
      task: nextTask,
      detail: artifactDetail({ activeRevision: revision }),
      revision,
      thread: { id: focusedThread.sessionId },
    }));

    const detail = await actions.startTaskArtifactRevision(
      "task-1",
      "artifact-1",
      "version-1",
      "  Tighten the recommendation.  ",
    );

    expect(harness.state.taskError).toBeNull();
    expect(detail?.activeRevision?.id).toBe("revision-1");
    expect(requestJsonRpc.mock.calls.at(-1)?.[4]).toEqual({
      taskId: "task-1",
      artifactId: "artifact-1",
      baseVersionId: "version-1",
      instruction: "Tighten the recommendation.",
      expectedRevision: 2,
    });
    expect(harness.state.selectedTaskId).toBe("task-1");
    expect(harness.state.selectedThreadId).toBe(focusedThread.sessionId);
    expect(harness.reconnectThread).toHaveBeenCalledWith(focusedThread.sessionId, undefined, {
      skipWorkspaceSelect: true,
      refreshSnapshot: true,
    });
  });

  test("does not retry a conflicting artifact restore", async () => {
    const harness = createHarness();
    const actions = createTaskActions(harness.set as never, harness.get as never, deps);
    Object.assign(harness.state, actions);
    harness.state.tasksById["task-1"] = taskRecord({ revision: 9 });
    requestJsonRpc.mockImplementationOnce(async () => {
      throw new Error("Task revision conflict");
    });

    const result = await actions.restoreTaskArtifactVersion("task-1", "artifact-1", "version-1");

    expect(result).toBeNull();
    expect(requestJsonRpc).toHaveBeenCalledTimes(1);
    expect(harness.state.taskError).toContain("revision conflict");
  });
});
