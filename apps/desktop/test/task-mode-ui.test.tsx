import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { TaskArtifactDetail, TaskQuestion, TaskRecord } from "../../../src/shared/tasks";
import { createTaskActions, type TaskActionDependencies } from "../src/app/store.actions/tasks";
import type { ChatInteraction } from "../src/app/types";
import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const realOpenFilePreview = useAppStore.getState().openFilePreview;

const NOW = "2026-06-18T12:00:00.000Z";

afterEach(() => {
  useAppStore.setState({ openFilePreview: realOpenFilePreview });
});

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    workspacePath: "/workspace",
    title: "Existing task",
    objective: "Keep task work separate from standard chat.",
    status: "awaiting_review",
    revision: 4,
    reviewRequired: true,
    createdAt: NOW,
    updatedAt: NOW,
    threadCount: 1,
    completedWorkItemCount: 1,
    totalWorkItemCount: 2,
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
    ],
    workItems: [
      {
        id: "done",
        taskId: "task-1",
        title: "Build coordinator",
        description: "",
        status: "done",
        dependsOn: [],
        assignedThreadId: null,
        claimedByThreadId: null,
        expectedOutputs: [],
        completionEvidence: "Tests pass",
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "review",
        taskId: "task-1",
        title: "Review delivery",
        description: "",
        status: "review",
        dependsOn: ["done"],
        assignedThreadId: null,
        claimedByThreadId: null,
        expectedOutputs: [],
        completionEvidence: null,
        position: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    decisions: [],
    questions: [],
    artifacts: [
      {
        id: "artifact-1",
        taskId: "task-1",
        workItemId: "done",
        threadId: "task-thread-1",
        path: "/workspace/report.md",
        kind: "markdown",
        title: "Delivery report",
        createdBy: "task-session-1",
        provenance: {},
        createdAt: NOW,
      },
    ],
    blockers: [],
    activity: [],
    latestCheckpoint: null,
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
    question: "Who should receive the recommendation?",
    context: "This choice changes the tone of the final report.",
    blocking: true,
    urgency: "now",
    defaultAction: null,
    options: [
      { id: "internal", label: "Internal team", description: "Use candid language." },
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

function artifactDetail(): TaskArtifactDetail {
  const artifact = taskRecord().artifacts[0];
  if (!artifact) throw new Error("missing artifact fixture");
  return {
    artifact,
    versions: [
      {
        id: "version-1",
        artifactId: artifact.id,
        version: 1,
        parentVersionId: null,
        sha256: "a".repeat(64),
        sizeBytes: 100,
        mediaType: "text/markdown",
        createdBy: "task-session-1",
        createdAt: "2026-06-18T10:00:00.000Z",
        changeSummary: "Initial analyst draft",
        provenance: { source: "research" },
        reviewStatus: "accepted",
      },
      {
        id: "version-2",
        artifactId: artifact.id,
        version: 2,
        parentVersionId: "version-1",
        sha256: "b".repeat(64),
        sizeBytes: 140,
        mediaType: "text/markdown",
        createdBy: "task-session-1",
        createdAt: NOW,
        changeSummary: "Updated recommendation",
        provenance: { source: "user feedback" },
        reviewStatus: "draft",
      },
    ],
    latestVersionId: "version-2",
    acceptedVersionId: "version-1",
    activeRevision: null,
  };
}

function sandboxApproval(requestId: string, command: string): ChatInteraction {
  return {
    kind: "approval",
    approvalKind: "sandbox",
    requestId,
    command,
    dangerous: true,
    reasonCode: "sandbox_denied_escalation",
    detail: "The command needs access outside the workspace sandbox.",
    category: "filesystem",
    receivedSequence: 1,
    status: "pending",
  };
}

function taskThreadSummary(task: TaskRecord, threadIndex = 0) {
  const thread = task.threads[threadIndex];
  if (!thread) throw new Error(`missing task thread ${threadIndex} for ${task.id}`);
  return {
    id: thread.sessionId,
    workspaceId: "ws-1",
    title: thread.title,
    createdAt: thread.createdAt,
    lastMessageAt: thread.updatedAt,
    status: "active",
    sessionId: thread.sessionId,
    messageCount: 0,
    lastEventSeq: 0,
    draft: false,
    taskId: task.id,
    taskThreadId: thread.id,
  };
}

function resetStore(task: TaskRecord | null) {
  const current = useAppStore.getState();
  useAppStore.setState({
    ...current,
    desktopFeatureFlags: { ...current.desktopFeatureFlags, tasks: true },
    view: "task",
    workspaces: [
      {
        id: "ws-1",
        name: "Project",
        path: "/workspace",
        workspaceKind: "project",
        createdAt: NOW,
        lastOpenedAt: NOW,
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      },
    ],
    selectedWorkspaceId: "ws-1",
    selectedThreadId: task?.threads[0]?.sessionId ?? null,
    selectedTaskId: task?.id ?? null,
    newTaskWorkspaceId: "ws-1",
    taskLifecycleRequestByTaskId: {},
    taskSummariesByWorkspaceId: task
      ? {
          "ws-1": [
            {
              id: task.id,
              workspacePath: task.workspacePath,
              title: task.title,
              objective: task.objective,
              status: task.status,
              revision: task.revision,
              reviewRequired: task.reviewRequired,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
              threadCount: task.threadCount,
              completedWorkItemCount: task.completedWorkItemCount,
              totalWorkItemCount: task.totalWorkItemCount,
              activeBlockerCount: task.activeBlockerCount,
              pendingQuestionCount: task.pendingQuestionCount,
              blockingQuestionCount: task.blockingQuestionCount,
            },
          ],
        }
      : {},
    tasksById: task ? { [task.id]: task } : {},
    taskListLoadingByWorkspaceId: {},
    taskError: null,
    refreshTasks: async () => {},
    startTask: async () => null,
    selectTask: async () => {},
    updateTaskBrief: async () => true,
    acceptTask: async () => {},
    requestTaskChanges: async () => {},
    cancelTask: async () => {},
    reopenTask: async () => {},
    retryTask: async () => true,
    resolveTaskQuestions: async () => "not_needed",
    openFilePreview: () => {},
    readTaskArtifact: async () => artifactDetail(),
    captureTaskArtifactVersion: async () => artifactDetail(),
    compareTaskArtifactVersions: async () => ({
      kind: "text",
      summary: {
        totalChanges: 1,
        added: 1,
        removed: 0,
        modified: 0,
        moved: 0,
        byCategory: { line_added: 1 },
      },
      changes: [{ type: "line_added", oldLine: null, newLine: 2, text: "Recommendation" }],
      truncated: false,
      changeLimit: 10_000,
      warnings: ["Comparison fell back to extracted text."],
      unifiedDiff: "+Recommendation",
    }),
    previewTaskArtifactVersion: async (
      _taskId: string,
      _artifactId: string,
      versionId: string,
    ) => ({
      versionId,
      preview: {
        kind: "text",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 140,
        sha256: "b".repeat(64),
        warnings: ["Preview was truncated to the first 100 sections."],
        text: "# Delivery report\nRecommendation",
        encoding: "utf-8",
      },
    }),
    restoreTaskArtifactVersion: async () => artifactDetail(),
    acceptTaskArtifactVersion: async () => artifactDetail(),
    startTaskArtifactRevision: async () => artifactDetail(),
  } as never);
}

function installTaskLifecycleActions(
  handler: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  const requestJsonRpc = mock(
    async (_get: unknown, _set: unknown, _workspaceId: unknown, method: string, params?: unknown) =>
      await handler(
        method,
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {},
      ),
  );
  const deps = {
    ensureControlSocket: () => {},
    ensureServerRunning: async () => {},
    ensureThreadRuntime: () => {},
    registerWorkspaceJsonRpcRouter: () => () => {},
    requestJsonRpc,
    syncDesktopStateCache: () => {},
    persistNow: async () => {},
  } as unknown as TaskActionDependencies;
  const taskActions = createTaskActions(
    useAppStore.setState as never,
    useAppStore.getState as never,
    deps,
  );
  useAppStore.setState({ ...taskActions } as never);
  return requestJsonRpc;
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLSelectElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value);
    return;
  }
  if (valueSetter) {
    valueSetter.call(element, value);
    return;
  }
  element.value = value;
}

type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type ValueChangeEvent = {
  target: ValueElement;
  currentTarget: ValueElement;
};
type SubmitEventStub = {
  preventDefault: () => void;
  target: HTMLFormElement;
  currentTarget: HTMLFormElement;
};
type ReactDomProps = {
  onChange?: (event: ValueChangeEvent) => void;
  onInput?: (event: ValueChangeEvent) => void;
  onSubmit?: (event: SubmitEventStub) => void;
};

function reactDomProps(element: Element): ReactDomProps {
  // The Bun preload imports React before jsdom exists, so direct DOM events alone
  // do not reliably drive controlled fields in this file.
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) return {};
  const value = (element as unknown as Record<string, unknown>)[propsKey];
  return typeof value === "object" && value !== null ? (value as ReactDomProps) : {};
}

function changeValue(
  harness: ReturnType<typeof setupJsdom>,
  element: ValueElement | null,
  value: string,
) {
  if (!element) throw new Error("missing form element");
  setNativeValue(element, value);
  const props = reactDomProps(element);
  props.onInput?.({ target: element, currentTarget: element });
  props.onChange?.({ target: element, currentTarget: element });
  element.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
  element.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
}

function submitForm(harness: ReturnType<typeof setupJsdom>, form: HTMLFormElement | null) {
  if (!form) throw new Error("missing form");
  const props = reactDomProps(form);
  if (props.onSubmit) {
    props.onSubmit({
      preventDefault: () => {},
      target: form,
      currentTarget: form,
    });
    return;
  }
  form.dispatchEvent(new harness.dom.window.Event("submit", { bubbles: true, cancelable: true }));
}

describe("desktop task mode UI", () => {
  test.serial("renders an explicit task landing instead of a chat composer", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { NewTaskLanding } = await import("../src/ui/tasks/NewTaskLanding");
      const root = createRoot(container);
      resetStore(taskRecord());
      useAppStore.setState({ selectedTaskId: null, selectedThreadId: null } as never);

      await act(async () => root.render(createElement(NewTaskLanding)));

      expect(container.textContent).toContain("New task");
      expect(container.textContent).toContain("Brief");
      expect(container.textContent).toContain("Work graph");
      expect(container.textContent).toContain("Definition of done");
      expect(container.textContent).toContain("Recent tasks");
      expect(container.textContent).toContain("Existing task");
      expect(container.querySelector("#new-task-objective")).not.toBeNull();
      expect(container.querySelector("#new-task-context")).not.toBeNull();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial(
    "retargets a mounted new-task form to the project chosen from the sidebar",
    async () => {
      const harness = setupJsdom();
      const startTask = mock(async () => null);
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const { NewTaskLanding } = await import("../src/ui/tasks/NewTaskLanding");
        const root = createRoot(container);
        resetStore(null);
        useAppStore.setState({
          workspaces: [
            {
              id: "ws-1",
              name: "Project One",
              path: "/workspace-one",
              workspaceKind: "project",
              createdAt: NOW,
              lastOpenedAt: NOW,
              defaultEnableMcp: true,
              defaultBackupsEnabled: false,
              yolo: false,
            },
            {
              id: "ws-2",
              name: "Project Two",
              path: "/workspace-two",
              workspaceKind: "project",
              createdAt: NOW,
              lastOpenedAt: NOW,
              defaultEnableMcp: true,
              defaultBackupsEnabled: false,
              yolo: false,
            },
          ],
          selectedWorkspaceId: "ws-1",
          newTaskWorkspaceId: "ws-1",
          startTask,
        } as never);

        await act(async () => root.render(createElement(NewTaskLanding)));
        const projectSelect = container.querySelector(
          "#new-task-project",
        ) as HTMLSelectElement | null;
        expect(projectSelect?.value).toBe("ws-1");

        await act(async () => {
          useAppStore.setState({
            selectedWorkspaceId: "ws-2",
            newTaskWorkspaceId: "ws-2",
          } as never);
          await Promise.resolve();
        });
        expect(projectSelect?.value).toBe("ws-2");

        await act(async () => {
          const showAdvanced = container.querySelector(
            'button[aria-expanded="false"]',
          ) as HTMLButtonElement | null;
          showAdvanced?.click();
          await Promise.resolve();
        });

        await act(async () => {
          changeValue(
            harness,
            container.querySelector("#new-task-title") as HTMLInputElement | null,
            "Ship dashboard hardening",
          );
          changeValue(
            harness,
            container.querySelector("#new-task-objective") as HTMLTextAreaElement | null,
            "Fix task dashboard state contracts.",
          );
          changeValue(
            harness,
            container.querySelector("#new-task-context") as HTMLTextAreaElement | null,
            "The user selected Project Two from the sidebar.",
          );
          changeValue(
            harness,
            container.querySelector("#new-task-acceptance") as HTMLTextAreaElement | null,
            "Task starts in the selected project.",
          );
          changeValue(
            harness,
            container.querySelector('input[id^="work-item-title-"]') as HTMLInputElement | null,
            "Implement the invariant",
          );
          changeValue(
            harness,
            container.querySelector(
              'textarea[id^="work-item-outputs-"]',
            ) as HTMLTextAreaElement | null,
            "Passing regression tests",
          );
          await Promise.resolve();
        });

        await act(async () => {
          const hideAdvanced = container.querySelector(
            'button[aria-expanded="true"]',
          ) as HTMLButtonElement | null;
          hideAdvanced?.click();
          await Promise.resolve();
        });
        expect(container.querySelector('input[id^="work-item-title-"]')).toBeNull();
        expect(container.textContent).toContain(
          "Your customized work graph is preserved and will be submitted.",
        );

        await act(async () => {
          submitForm(harness, container.querySelector("form"));
          await Promise.resolve();
        });

        expect(startTask).toHaveBeenCalledWith({
          workspaceId: "ws-2",
          task: expect.objectContaining({
            title: "Ship dashboard hardening",
            workItems: [
              expect.objectContaining({
                key: "step-1",
                title: "Implement the invariant",
                expectedOutputs: ["Passing regression tests"],
              }),
            ],
          }),
        });

        await act(async () => root.unmount());
      } finally {
        harness.restore();
      }
    },
  );

  test.serial(
    "removes deleted work-item keys from remaining dependencies before submit",
    async () => {
      const harness = setupJsdom();
      const startTask = mock(async () => null);
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const { NewTaskLanding } = await import("../src/ui/tasks/NewTaskLanding");
        const root = createRoot(container);
        resetStore(null);
        useAppStore.setState({ startTask } as never);

        await act(async () => root.render(createElement(NewTaskLanding)));
        await act(async () => {
          changeValue(
            harness,
            container.querySelector("#new-task-title") as HTMLInputElement | null,
            "Ship a dependency-safe plan",
          );
          changeValue(
            harness,
            container.querySelector("#new-task-objective") as HTMLTextAreaElement | null,
            "Submit a valid graph after deleting an intermediate step.",
          );
          const showAdvanced = container.querySelector(
            'button[aria-expanded="false"]',
          ) as HTMLButtonElement | null;
          showAdvanced?.click();
          await Promise.resolve();
        });

        const addStep = () =>
          Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Add step",
          ) as HTMLButtonElement | undefined;
        await act(async () => {
          addStep()?.click();
          await Promise.resolve();
          addStep()?.click();
          await Promise.resolve();
        });

        const titleInputs = Array.from(
          container.querySelectorAll('input[id^="work-item-title-"]'),
        ) as HTMLInputElement[];
        const dependencyInputs = Array.from(
          container.querySelectorAll('input[id^="work-item-dependencies-"]'),
        ) as HTMLInputElement[];
        const outputInputs = Array.from(
          container.querySelectorAll('textarea[id^="work-item-outputs-"]'),
        ) as HTMLTextAreaElement[];
        expect(titleInputs).toHaveLength(3);
        expect(dependencyInputs).toHaveLength(3);

        await act(async () => {
          changeValue(harness, titleInputs[0] ?? null, "Prepare");
          changeValue(harness, titleInputs[1] ?? null, "Discarded intermediate");
          changeValue(harness, titleInputs[2] ?? null, "Deliver");
          changeValue(harness, outputInputs[0] ?? null, "Prepared input");
          changeValue(harness, outputInputs[1] ?? null, "Temporary output");
          changeValue(harness, outputInputs[2] ?? null, "Final output");
          changeValue(harness, dependencyInputs[2] ?? null, "step-1, step-2");
          await Promise.resolve();
        });

        const removeSecondStep = container.querySelector(
          'button[aria-label="Remove step 2"]',
        ) as HTMLButtonElement | null;
        await act(async () => {
          removeSecondStep?.click();
          await Promise.resolve();
        });

        const remainingDependencies = Array.from(
          container.querySelectorAll('input[id^="work-item-dependencies-"]'),
        ) as HTMLInputElement[];
        expect(remainingDependencies).toHaveLength(2);
        expect(remainingDependencies[1]?.value).toBe("step-1");

        await act(async () => {
          submitForm(harness, container.querySelector("form"));
          await Promise.resolve();
        });
        expect(startTask).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          task: expect.objectContaining({
            workItems: [
              expect.objectContaining({ key: "step-1", dependsOn: [] }),
              expect.objectContaining({ key: "step-3", dependsOn: ["step-1"] }),
            ],
          }),
        });

        await act(async () => root.unmount());
      } finally {
        harness.restore();
      }
    },
  );

  test.serial("retargets repeated new-task requests for the same project", async () => {
    const harness = setupJsdom();
    const startTask = mock(async () => null);
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { NewTaskLanding } = await import("../src/ui/tasks/NewTaskLanding");
      const root = createRoot(container);
      resetStore(null);
      useAppStore.setState({
        workspaces: [
          {
            id: "ws-1",
            name: "Project One",
            path: "/workspace-one",
            workspaceKind: "project",
            createdAt: NOW,
            lastOpenedAt: NOW,
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
          {
            id: "ws-2",
            name: "Project Two",
            path: "/workspace-two",
            workspaceKind: "project",
            createdAt: NOW,
            lastOpenedAt: NOW,
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        selectedWorkspaceId: "ws-1",
        newTaskWorkspaceId: "ws-1",
        startTask,
      } as never);

      await act(async () => root.render(createElement(NewTaskLanding)));
      const projectSelect = container.querySelector(
        "#new-task-project",
      ) as HTMLSelectElement | null;
      expect(projectSelect?.value).toBe("ws-1");

      await act(async () => {
        changeValue(harness, projectSelect, "ws-2");
        await Promise.resolve();
      });
      expect(projectSelect?.value).toBe("ws-2");

      await act(async () => {
        await useAppStore.getState().openNewTask("ws-1");
        await Promise.resolve();
      });

      expect(projectSelect?.value).toBe("ws-1");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("renders coordinator state and review controls in the task work panel", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      resetStore(taskRecord());

      await act(async () => root.render(createElement(TaskContextSidebar)));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const text = container.textContent ?? "";
      expect(text).toContain("Awaiting review");
      expect(text).toContain("Work plan");
      expect(text).toContain("Build coordinator");
      expect(text).toContain("After Build coordinator");
      expect(text).toContain("Delivery report");
      expect(text).toContain("Needs review");
      expect(text).toContain("Latest v2 · Accepted v1");
      expect(text).toContain("Accept delivery");
      expect(text).toContain("Request changes");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("uses the conversation as the primary task view", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskView } = await import("../src/ui/tasks/TaskView");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      resetStore(taskRecord());

      // Center pane: conversation (chat shell for the task thread).
      await act(async () => root.render(createElement(TaskView)));
      expect(container.textContent).toMatch(
        /Conversation|Message|No messages yet|What should we work on/,
      );
      expect(container.textContent).not.toContain("Work plan");

      // Right rail: brief / work plan / controls.
      await act(async () => root.render(createElement(TaskContextSidebar, { variant: "sidebar" })));
      expect(container.textContent).toContain("Work plan");
      expect(container.textContent).toContain("Review and control");
      expect(container.querySelector(".app-context-sidebar")).not.toBeNull();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("offers a return to the source chat after terminal delivery", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      resetStore(taskRecord({ status: "completed", sourceSessionId: "source-chat-1" }));

      await act(async () => root.render(createElement(TaskContextSidebar)));
      expect(container.textContent).toContain("Return to source chat");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("offers retry instead of reopen when a task fails", async () => {
    const harness = setupJsdom();
    const retryTask = mock(async () => true);
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      resetStore(taskRecord({ status: "failed" }));
      useAppStore.setState({ retryTask } as never);

      await act(async () => root.render(createElement(TaskContextSidebar)));
      const retryButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry task",
      );
      expect(retryButton).toBeDefined();
      expect(container.textContent).not.toContain("Reopen task");

      await act(async () => {
        retryButton?.click();
        await Promise.resolve();
      });
      expect(retryTask).toHaveBeenCalledWith("task-1");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("resets dirty brief editor state when the selected task changes", async () => {
    const harness = setupJsdom();
    const updateTaskBrief = mock(async () => true);
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      const firstTask = taskRecord({ id: "task-1", title: "First task" });
      const secondTask = taskRecord({
        id: "task-2",
        title: "Second task",
        objective: "Keep this objective attached to task two.",
        threads: [
          {
            id: "task-thread-2",
            taskId: "task-2",
            sessionId: "task-session-2",
            title: "Main",
            createdBy: "coordinator",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      resetStore(firstTask);
      useAppStore.setState({
        tasksById: { "task-1": firstTask, "task-2": secondTask },
        selectedTaskId: "task-1",
        updateTaskBrief,
      } as never);

      await act(async () => root.render(createElement(TaskContextSidebar)));
      await act(async () => {
        changeValue(
          harness,
          container.querySelector("#task-brief-title") as HTMLInputElement | null,
          "Unsaved first task title",
        );
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Save brief");

      await act(async () => {
        useAppStore.setState({
          selectedTaskId: "task-2",
          selectedThreadId: "task-session-2",
        } as never);
        await Promise.resolve();
      });

      const titleInput = container.querySelector("#task-brief-title") as HTMLInputElement | null;
      const objectiveInput = container.querySelector(
        "#task-brief-objective",
      ) as HTMLTextAreaElement | null;
      expect(titleInput?.value).toBe("Second task");
      expect(objectiveInput?.value).toBe("Keep this objective attached to task two.");
      expect(container.textContent).not.toContain("Save brief");
      expect(updateTaskBrief).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("makes terminal task conversations read-only while preserving feed", async () => {
    const harness = setupJsdom();
    const reopenResult = Promise.withResolvers<{ task: TaskRecord }>();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      const root = createRoot(container);
      resetStore(taskRecord({ status: "completed" }));
      const requestJsonRpc = installTaskLifecycleActions(async (method) => {
        if (method === "task/reopen") return await reopenResult.promise;
        throw new Error(`Unexpected ${method}`);
      });
      const reopenRequestCount = () =>
        requestJsonRpc.mock.calls.filter((call) => call[3] === "task/reopen").length;
      useAppStore.setState({
        threads: [
          {
            id: "task-session-1",
            workspaceId: "ws-1",
            title: "Main",
            createdAt: NOW,
            lastMessageAt: NOW,
            status: "active",
            sessionId: "task-session-1",
            messageCount: 1,
            lastEventSeq: 1,
            draft: false,
            taskId: "task-1",
            taskThreadId: "task-thread-1",
          },
        ],
        threadRuntimeById: {
          "task-session-1": {
            status: "connected",
            sessionId: "task-session-1",
            sessionKind: "chat",
            title: "Main",
            config: { provider: "openai", model: "gpt-5.2" },
            sessionConfig: null,
            busy: false,
            busySince: null,
            feed: [
              {
                id: "assistant-audit-note",
                ts: NOW,
                kind: "message",
                role: "assistant",
                text: "Preserved terminal transcript audit line.",
              },
            ],
            agents: [],
            pendingSteer: null,
            pendingTurnStart: null,
            transcriptOnly: false,
          },
        },
      } as never);

      await act(async () => root.render(createElement(TaskConversationSidebar)));

      expect(container.textContent).toContain("This task is completed.");
      expect(container.textContent).toContain("Reopen the task to continue this conversation.");
      expect(container.textContent).toContain("Reopen task");
      expect(container.textContent).toContain("Preserved terminal transcript audit line.");
      expect(container.querySelector('[aria-label="Message input"]')).toBeNull();
      const reopenButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Reopen task",
      );
      expect(reopenButton).toBeDefined();
      const addThreadButton = container.querySelector(
        '[aria-label="Add focused task thread"]',
      ) as HTMLButtonElement | null;
      expect(addThreadButton?.disabled).toBe(false);
      expect(addThreadButton?.getAttribute("aria-disabled")).toBe("true");
      const descriptionId = addThreadButton?.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      const lockNotice = descriptionId
        ? harness.dom.window.document.getElementById(descriptionId)
        : null;
      expect(lockNotice?.textContent).toContain("Reopen the task to continue this conversation.");
      expect(lockNotice?.getAttribute("role")).toBe("status");
      expect(lockNotice?.getAttribute("aria-live")).toBe("polite");
      addThreadButton?.focus();
      expect(harness.dom.window.document.activeElement).toBe(addThreadButton);
      await act(async () => addThreadButton?.click());
      expect(harness.dom.window.document.body.textContent).not.toContain("Add task thread");
      await act(async () => {
        reopenButton?.click();
        reopenButton?.click();
        await Promise.resolve();
      });
      expect(reopenRequestCount()).toBe(1);
      expect(
        requestJsonRpc.mock.calls.find((call) => call[3] === "task/reopen")?.[4],
      ).toMatchObject({
        taskId: "task-1",
        expectedRevision: 4,
      });

      await act(async () => {
        reopenResult.resolve({ task: taskRecord({ status: "working", revision: 5 }) });
        await reopenResult.promise;
        await Promise.resolve();
      });

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("shows failed task conversations as retry-only with pending state", async () => {
    const harness = setupJsdom();
    const retryResult = Promise.withResolvers<{ task: TaskRecord }>();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      const root = createRoot(container);
      resetStore(taskRecord({ status: "failed" }));
      const requestJsonRpc = installTaskLifecycleActions(async (method) => {
        if (method === "task/retry") return await retryResult.promise;
        throw new Error(`Unexpected ${method}`);
      });
      const retryRequestCount = () =>
        requestJsonRpc.mock.calls.filter((call) => call[3] === "task/retry").length;
      useAppStore.setState({
        threads: [
          {
            id: "task-session-1",
            workspaceId: "ws-1",
            title: "Main",
            createdAt: NOW,
            lastMessageAt: NOW,
            status: "active",
            sessionId: "task-session-1",
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            taskId: "task-1",
            taskThreadId: "task-thread-1",
          },
        ],
        threadRuntimeById: {},
      } as never);

      await act(async () => root.render(createElement(TaskConversationSidebar)));

      expect(container.textContent).toContain("This task failed.");
      expect(container.textContent).toContain("Retry the task to continue this conversation.");
      expect(container.textContent).toContain("Retry task");
      expect(container.textContent).not.toContain("Reopen task");
      expect(container.querySelector('[aria-label="Message input"]')).toBeNull();
      const retryButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry task",
      ) as HTMLButtonElement | undefined;
      expect(retryButton).toBeDefined();

      await act(async () => {
        retryButton?.click();
        retryButton?.click();
        await Promise.resolve();
      });
      expect(retryRequestCount()).toBe(1);
      expect(requestJsonRpc.mock.calls.find((call) => call[3] === "task/retry")?.[4]).toMatchObject(
        {
          taskId: "task-1",
          expectedRevision: 4,
        },
      );
      expect(retryButton?.disabled).toBe(true);
      expect(retryButton?.getAttribute("aria-busy")).toBe("true");
      expect(retryButton?.textContent).toContain("Retrying...");

      await act(async () => {
        retryResult.resolve({ task: taskRecord({ status: "working", revision: 5 }) });
        await retryResult.promise;
        await Promise.resolve();
      });

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("keys terminal conversation reopen pending state by selected task", async () => {
    const harness = setupJsdom();
    const firstReopen = Promise.withResolvers<{ task: TaskRecord }>();
    const secondReopen = Promise.withResolvers<{ task: TaskRecord }>();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      const root = createRoot(container);
      const firstTask = taskRecord({ id: "task-1", status: "completed", title: "First terminal" });
      const secondTask = taskRecord({
        id: "task-2",
        status: "completed",
        title: "Second terminal",
        threads: [
          {
            id: "task-thread-2",
            taskId: "task-2",
            sessionId: "task-session-2",
            title: "Main",
            createdBy: "coordinator",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      resetStore(firstTask);
      const requestJsonRpc = installTaskLifecycleActions(async (method, params) => {
        if (method !== "task/reopen") throw new Error(`Unexpected ${method}`);
        return await (params.taskId === "task-1" ? firstReopen.promise : secondReopen.promise);
      });
      const reopenRequestCount = () =>
        requestJsonRpc.mock.calls.filter((call) => call[3] === "task/reopen").length;
      useAppStore.setState({
        tasksById: { "task-1": firstTask, "task-2": secondTask },
        threads: [taskThreadSummary(firstTask), taskThreadSummary(secondTask)],
        threadRuntimeById: {},
      } as never);

      await act(async () => root.render(createElement(TaskConversationSidebar)));
      const firstButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Reopen task",
      ) as HTMLButtonElement | undefined;
      await act(async () => {
        firstButton?.click();
        firstButton?.click();
        await Promise.resolve();
      });
      expect(reopenRequestCount()).toBe(1);
      expect(
        requestJsonRpc.mock.calls.find((call) => call[3] === "task/reopen")?.[4],
      ).toMatchObject({
        taskId: "task-1",
        expectedRevision: 4,
      });
      expect(container.textContent).toContain("Reopening...");

      await act(async () => {
        useAppStore.setState({
          selectedTaskId: "task-2",
          selectedThreadId: "task-session-2",
        } as never);
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Reopening...");
      const secondButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Reopen task",
      ) as HTMLButtonElement | undefined;
      expect(secondButton?.disabled).toBe(false);

      await act(async () => {
        secondButton?.click();
        await Promise.resolve();
      });
      expect(reopenRequestCount()).toBe(2);
      expect(
        requestJsonRpc.mock.calls.filter((call) => call[3] === "task/reopen")[1]?.[4],
      ).toMatchObject({
        taskId: "task-2",
        expectedRevision: 4,
      });
      expect(container.textContent).toContain("Reopening...");

      await act(async () => {
        firstReopen.resolve({ task: { ...firstTask, status: "working", revision: 5 } });
        await firstReopen.promise;
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Reopening...");

      await act(async () => {
        secondReopen.resolve({ task: { ...secondTask, status: "working", revision: 5 } });
        await secondReopen.promise;
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Reopening...");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("keys terminal conversation retry pending state by selected task", async () => {
    const harness = setupJsdom();
    const firstRetry = Promise.withResolvers<{ task: TaskRecord }>();
    const secondRetry = Promise.withResolvers<{ task: TaskRecord }>();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      const root = createRoot(container);
      const firstTask = taskRecord({ id: "task-1", status: "failed", title: "First failed" });
      const secondTask = taskRecord({
        id: "task-2",
        status: "failed",
        title: "Second failed",
        threads: [
          {
            id: "task-thread-2",
            taskId: "task-2",
            sessionId: "task-session-2",
            title: "Main",
            createdBy: "coordinator",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      resetStore(firstTask);
      const requestJsonRpc = installTaskLifecycleActions(async (method, params) => {
        if (method !== "task/retry") throw new Error(`Unexpected ${method}`);
        return await (params.taskId === "task-1" ? firstRetry.promise : secondRetry.promise);
      });
      const retryRequestCount = () =>
        requestJsonRpc.mock.calls.filter((call) => call[3] === "task/retry").length;
      useAppStore.setState({
        tasksById: { "task-1": firstTask, "task-2": secondTask },
        threads: [taskThreadSummary(firstTask), taskThreadSummary(secondTask)],
        threadRuntimeById: {},
      } as never);

      await act(async () => root.render(createElement(TaskConversationSidebar)));
      const firstButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry task",
      ) as HTMLButtonElement | undefined;
      await act(async () => {
        firstButton?.click();
        firstButton?.click();
        await Promise.resolve();
      });
      expect(retryRequestCount()).toBe(1);
      expect(requestJsonRpc.mock.calls.find((call) => call[3] === "task/retry")?.[4]).toMatchObject(
        {
          taskId: "task-1",
          expectedRevision: 4,
        },
      );
      expect(container.textContent).toContain("Retrying...");

      await act(async () => {
        useAppStore.setState({
          selectedTaskId: "task-2",
          selectedThreadId: "task-session-2",
        } as never);
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Retrying...");
      const secondButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry task",
      ) as HTMLButtonElement | undefined;
      expect(secondButton?.disabled).toBe(false);

      await act(async () => {
        secondButton?.click();
        await Promise.resolve();
      });
      expect(retryRequestCount()).toBe(2);
      expect(
        requestJsonRpc.mock.calls.filter((call) => call[3] === "task/retry")[1]?.[4],
      ).toMatchObject({
        taskId: "task-2",
        expectedRevision: 4,
      });
      expect(container.textContent).toContain("Retrying...");

      await act(async () => {
        firstRetry.resolve({ task: { ...firstTask, status: "working", revision: 5 } });
        await firstRetry.promise;
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Retrying...");

      await act(async () => {
        secondRetry.resolve({ task: { ...secondTask, status: "working", revision: 5 } });
        await secondRetry.promise;
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Retrying...");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("clears terminal conversation pending state after lifecycle rejection", async () => {
    const harness = setupJsdom();
    const realConsoleError = console.error;
    console.error = mock(() => {}) as never;
    let attempts = 0;
    const reopenTask = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("reopen failed");
    });
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      const root = createRoot(container);
      resetStore(taskRecord({ status: "completed" }));
      useAppStore.setState({ reopenTask } as never);

      await act(async () => root.render(createElement(TaskConversationSidebar)));
      const reopenButton = () =>
        Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Reopen task",
        ) as HTMLButtonElement | undefined;

      await act(async () => {
        reopenButton()?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reopenTask).toHaveBeenCalledTimes(1);
      expect(reopenButton()?.disabled).toBe(false);

      await act(async () => {
        reopenButton()?.click();
        await Promise.resolve();
      });
      expect(reopenTask).toHaveBeenCalledTimes(2);

      await act(async () => root.unmount());
    } finally {
      console.error = realConsoleError;
      harness.restore();
    }
  });

  test.serial(
    "shares terminal lifecycle pending state across task sidebars and remounts",
    async () => {
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
        const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
        root = createRoot(container);
        const task = taskRecord({ status: "completed" });
        resetStore(task);
        const reopenResult = Promise.withResolvers<{ task: TaskRecord }>();
        const requestJsonRpc = mock(
          async (
            _get: unknown,
            _set: unknown,
            _workspaceId: unknown,
            method: string,
            _params?: unknown,
          ) => {
            if (method === "task/artifact/read") return { detail: artifactDetail() };
            if (method === "task/reopen") return await reopenResult.promise;
            throw new Error(`Unexpected ${method}`);
          },
        );
        const deps = {
          ensureControlSocket: () => {},
          ensureServerRunning: async () => {},
          ensureThreadRuntime: () => {},
          registerWorkspaceJsonRpcRouter: () => () => {},
          requestJsonRpc,
          syncDesktopStateCache: () => {},
          persistNow: async () => {},
        } as unknown as TaskActionDependencies;
        const taskActions = createTaskActions(
          useAppStore.setState as never,
          useAppStore.getState as never,
          deps,
        );
        useAppStore.setState({
          ...taskActions,
          threads: [taskThreadSummary(task)],
          threadRuntimeById: {
            "task-session-1": {
              status: "connected",
              sessionId: "task-session-1",
              sessionKind: "chat",
              title: "Main",
              config: { provider: "openai", model: "gpt-5.2" },
              sessionConfig: null,
              busy: false,
              busySince: null,
              feed: [],
              agents: [],
              pendingSteer: null,
              pendingTurnStart: null,
              transcriptOnly: false,
            },
          },
        } as never);

        const renderShell = (showConversation: boolean) =>
          root?.render(
            createElement(
              "div",
              null,
              createElement(TaskContextSidebar),
              showConversation ? createElement(TaskConversationSidebar) : null,
            ),
          );

        await act(async () => renderShell(true));

        const reopenButtons = () =>
          Array.from(container.querySelectorAll("button")).filter((button) =>
            button.textContent?.includes("Reopen task"),
          ) as HTMLButtonElement[];
        const reopenRequestCount = () =>
          requestJsonRpc.mock.calls.filter((call) => call[3] === "task/reopen").length;
        expect(reopenButtons()).toHaveLength(2);

        await act(async () => {
          reopenButtons()[0]?.click();
          await Promise.resolve();
        });
        expect(reopenRequestCount()).toBe(1);
        expect(useAppStore.getState().taskLifecycleRequestByTaskId["task-1"]).toMatchObject({
          action: "reopen",
          expectedRevision: 4,
        });

        const buttons = Array.from(container.querySelectorAll("button"));
        const pendingReopenButtons = buttons.filter(
          (button) => button.textContent?.trim() === "Reopening...",
        );
        expect(pendingReopenButtons).toHaveLength(2);
        expect(
          pendingReopenButtons.every((button) => button.getAttribute("aria-busy") === "true"),
        ).toBe(true);

        await act(async () => renderShell(false));
        await act(async () => renderShell(true));
        const remountedPendingButtons = Array.from(container.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Reopening...",
        ) as HTMLButtonElement[];
        expect(remountedPendingButtons).toHaveLength(2);
        expect(remountedPendingButtons.every((button) => button.disabled)).toBe(true);

        await act(async () => {
          useAppStore.setState((state) => ({
            tasksById: {
              ...state.tasksById,
              [task.id]: taskRecord({ status: "completed", revision: 5 }),
            },
          }));
          renderShell(true);
        });
        const revisionDriftPendingButtons = Array.from(container.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Reopening...",
        ) as HTMLButtonElement[];
        expect(revisionDriftPendingButtons).toHaveLength(2);
        expect(revisionDriftPendingButtons.every((button) => button.disabled)).toBe(true);

        await act(async () => {
          for (const button of revisionDriftPendingButtons) button.click();
          await Promise.resolve();
        });
        expect(reopenRequestCount()).toBe(1);

        await act(async () => {
          reopenResult.resolve({ task: taskRecord({ status: "working", revision: 6 }) });
          await reopenResult.promise;
          await Promise.resolve();
        });
        expect(useAppStore.getState().taskLifecycleRequestByTaskId["task-1"]).toBeUndefined();
        expect(container.textContent).not.toContain("Reopen task");
      } finally {
        if (root) await act(async () => root.unmount());
        harness.restore();
      }
    },
  );

  test.serial("ignores stale opposite lifecycle requests in both task sidebars", async () => {
    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      root = createRoot(container);
      const failedTask = taskRecord({ status: "failed", revision: 5 });
      const retryTask = mock(async () => true);
      resetStore(failedTask);
      useAppStore.setState({
        retryTask,
        taskLifecycleRequestByTaskId: {
          [failedTask.id]: {
            action: "reopen",
            expectedRevision: 4,
            requestId: "stale-reopen",
          },
        },
      } as never);

      await act(async () => {
        root?.render(
          createElement(
            "div",
            null,
            createElement(TaskContextSidebar),
            createElement(TaskConversationSidebar),
          ),
        );
      });

      const retryButtons = Array.from(container.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Retry task",
      ) as HTMLButtonElement[];
      expect(retryButtons).toHaveLength(2);
      expect(retryButtons.every((button) => !button.disabled)).toBe(true);
      expect(retryButtons.every((button) => button.getAttribute("aria-busy") === null)).toBe(true);
      expect(container.textContent).not.toContain("Reopening...");

      await act(async () => {
        retryButtons[0]?.click();
        await Promise.resolve();
      });
      expect(retryTask).toHaveBeenCalledTimes(1);
      expect(retryTask).toHaveBeenCalledWith(failedTask.id);
    } finally {
      if (root) await act(async () => root.unmount());
      harness.restore();
    }
  });

  test.serial("rebinds the message overlay observer when a task becomes read-only", async () => {
    const observedElements: Element[] = [];
    let disconnectCount = 0;
    class TrackingResizeObserver {
      observe(element: Element) {
        observedElements.push(element);
      }
      disconnect() {
        disconnectCount += 1;
      }
      unobserve() {}
    }
    const harness = setupJsdom({ extraGlobals: { ResizeObserver: TrackingResizeObserver } });
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskConversationSidebar } = await import("../src/ui/tasks/TaskConversationSidebar");
      const root = createRoot(container);
      const workingTask = taskRecord({ status: "working" });
      resetStore(workingTask);
      useAppStore.setState({
        threads: [
          {
            id: "task-session-1",
            workspaceId: "ws-1",
            title: "Main",
            createdAt: NOW,
            lastMessageAt: NOW,
            status: "active",
            sessionId: "task-session-1",
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            taskId: "task-1",
            taskThreadId: "task-thread-1",
          },
        ],
        threadRuntimeById: {},
      } as never);

      await act(async () => root.render(createElement(TaskConversationSidebar)));
      const firstOverlay = observedElements.find(
        (element) => element.getAttribute("data-slot") === "message-bar-overlay",
      );
      expect(firstOverlay).toBeTruthy();

      await act(async () => {
        useAppStore.setState({
          tasksById: { "task-1": taskRecord({ status: "completed", revision: 5 }) },
        } as never);
        await Promise.resolve();
      });

      const observedOverlays = observedElements.filter(
        (element) => element.getAttribute("data-slot") === "message-bar-overlay",
      );
      const latestOverlay = observedOverlays.at(-1);
      expect(observedOverlays.length).toBeGreaterThanOrEqual(2);
      expect(latestOverlay).not.toBe(firstOverlay);
      expect(latestOverlay?.isConnected).toBe(true);
      expect(disconnectCount).toBeGreaterThanOrEqual(1);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial(
    "isolates sandbox approvals by ordinary-chat and selected-task ownership",
    async () => {
      const harness = setupJsdom();
      const selectTaskThread = mock(async () => {});
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const { ChatView } = await import("../src/ui/ChatView");
        const root = createRoot(container);
        const task = taskRecord({
          status: "working",
          threads: [
            ...taskRecord().threads,
            {
              id: "task-thread-2",
              taskId: "task-1",
              sessionId: "task-session-2",
              title: "Task approval lane",
              createdBy: "coordinator",
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          threadCount: 2,
        });
        resetStore(task);
        useAppStore.setState({
          view: "chat",
          selectedTaskId: null,
          selectedThreadId: "chat-session-1",
          selectTaskThread,
          threads: [
            {
              id: "chat-session-1",
              workspaceId: "ws-1",
              title: "Ordinary chat",
              createdAt: NOW,
              lastMessageAt: NOW,
              status: "active",
              sessionId: "chat-session-1",
              messageCount: 0,
              lastEventSeq: 0,
              draft: false,
            },
            {
              id: "task-session-1",
              workspaceId: "ws-1",
              title: "Task main",
              createdAt: NOW,
              lastMessageAt: NOW,
              status: "active",
              sessionId: "task-session-1",
              messageCount: 0,
              lastEventSeq: 0,
              draft: false,
              taskId: "task-1",
              taskThreadId: "task-thread-1",
            },
            {
              id: "task-session-2",
              workspaceId: "ws-1",
              title: "Task approval lane",
              createdAt: NOW,
              lastMessageAt: NOW,
              status: "active",
              sessionId: "task-session-2",
              messageCount: 0,
              lastEventSeq: 0,
              draft: false,
              taskId: "task-1",
              taskThreadId: "task-thread-2",
            },
          ],
          interactionsByThread: {
            "chat-session-1": [sandboxApproval("chat-approval", "echo ordinary-chat")],
            "task-session-2": [sandboxApproval("task-approval", "echo task-only")],
          },
        } as never);

        await act(async () => root.render(createElement(ChatView)));
        expect(container.textContent).toContain("echo ordinary-chat");
        expect(container.textContent).not.toContain("echo task-only");

        await act(async () => {
          useAppStore.setState({
            view: "task",
            selectedTaskId: "task-1",
            selectedThreadId: "task-session-1",
          } as never);
          await Promise.resolve();
        });
        expect(container.textContent).toContain("echo task-only");
        expect(container.textContent).not.toContain("echo ordinary-chat");
        const openButton = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Open",
        );
        await act(async () => openButton?.click());
        expect(selectTaskThread).toHaveBeenCalledWith("task-1", "task-thread-2");

        await act(async () => {
          useAppStore.setState({
            tasksById: { "task-1": taskRecord({ status: "completed" }) },
          } as never);
          await Promise.resolve();
        });
        expect(container.textContent).toContain("echo task-only");
        expect(container.textContent).not.toContain("echo ordinary-chat");

        await act(async () => root.unmount());
      } finally {
        harness.restore();
      }
    },
  );

  test.serial("bundles pending task questions and submits partial answers", async () => {
    const harness = setupJsdom();
    const resolveQuestions = mock(async () => "not_needed" as const);
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      const questions = [
        taskQuestion(),
        taskQuestion({
          id: "question-2",
          header: "Format",
          question: "Which report format should I use?",
          blocking: false,
          urgency: "before_delivery",
          defaultAction: "Use the normal five-page analyst brief.",
          provisionalDecisionId: "decision-provisional",
        }),
      ];
      resetStore(
        taskRecord({
          status: "blocked",
          pendingQuestionCount: 2,
          blockingQuestionCount: 1,
          questions,
        }),
      );
      useAppStore.setState({ resolveTaskQuestions: resolveQuestions } as never);

      await act(async () => root.render(createElement(TaskContextSidebar)));
      const card = container.querySelector("[data-task-questions]");
      expect(card?.textContent).toContain("Needs input");
      expect(card?.textContent).toContain("1 blocking");
      expect(card?.textContent).toContain(
        "Continuing for now with: Use the normal five-page analyst brief.",
      );

      const answerButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Answer 2 questions"),
      );
      await act(async () => answerButton?.click());

      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText).toContain("Who should receive the recommendation?");
      expect(dialogText).toContain("Which report format should I use?");
      expect(dialogText).toContain("Recommended");
      expect(dialogText).toContain(
        "Continuing for now with: Use the normal five-page analyst brief.",
      );

      const radios = harness.dom.window.document.body.querySelectorAll('[role="radio"]');
      await act(async () => (radios[0] as HTMLElement | undefined)?.click());
      const submitButton = Array.from(
        harness.dom.window.document.body.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("Submit 1 answer"));
      await act(async () => {
        submitButton?.click();
        await Promise.resolve();
      });

      expect(resolveQuestions).toHaveBeenCalledWith("task-1", [
        { questionId: "question-1", optionId: "internal" },
      ]);
      expect(harness.dom.window.document.body.textContent).not.toContain("Answer task questions");

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("refreshes artifact review state when the task revision changes", async () => {
    const harness = setupJsdom();
    let nextDetail = artifactDetail();
    const readArtifact = mock(async () => nextDetail);
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      const initialTask = taskRecord();
      resetStore(initialTask);
      useAppStore.setState({ readTaskArtifact: readArtifact } as never);

      await act(async () => root.render(createElement(TaskContextSidebar)));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const artifactCard = container.querySelector('[data-artifact-id="artifact-1"]');
      expect(artifactCard?.textContent).toContain("Needs review");
      expect(readArtifact).toHaveBeenCalledTimes(1);

      nextDetail = {
        ...nextDetail,
        acceptedVersionId: nextDetail.latestVersionId,
        versions: nextDetail.versions.map((version) => ({
          ...version,
          reviewStatus: version.id === nextDetail.latestVersionId ? "accepted" : "superseded",
        })),
      };
      await act(async () => {
        useAppStore.setState({
          tasksById: {
            "task-1": { ...initialTask, revision: initialTask.revision + 1 },
          },
        } as never);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(artifactCard?.textContent).toContain("Accepted");
      expect(artifactCard?.textContent).not.toContain("Needs review");
      expect(readArtifact).toHaveBeenCalledTimes(2);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial("loads artifact review state under React Strict Mode", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      const readArtifact = mock(async () => artifactDetail());
      resetStore(taskRecord());
      useAppStore.setState({ readTaskArtifact: readArtifact } as never);

      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(TaskContextSidebar)));
        await Promise.resolve();
      });

      const artifactCard = container.querySelector('[data-artifact-id="artifact-1"]');
      expect(artifactCard?.textContent).toContain("Needs review");
      expect(artifactCard?.textContent).not.toContain("Loading history");
      expect(readArtifact).toHaveBeenCalledTimes(1);

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test.serial(
    "keeps terminal artifact history readable while disabling revision starts",
    async () => {
      const harness = setupJsdom();
      const startRevision = mock(async () => artifactDetail());
      const captureVersion = mock(async () => artifactDetail());
      const restoreVersion = mock(async () => artifactDetail());
      const acceptVersion = mock(async () => artifactDetail());
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
        const root = createRoot(container);
        resetStore(taskRecord({ status: "completed" }));
        useAppStore.setState({
          startTaskArtifactRevision: startRevision,
          captureTaskArtifactVersion: captureVersion,
          restoreTaskArtifactVersion: restoreVersion,
          acceptTaskArtifactVersion: acceptVersion,
        } as never);

        await act(async () => root.render(createElement(TaskContextSidebar)));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const reviewButton = Array.from(container.querySelectorAll("button")).find((button) =>
          ["Revise this", "Review versions"].includes(button.textContent?.trim() ?? ""),
        );
        await act(async () => {
          reviewButton?.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(harness.dom.window.document.body.textContent).toContain("Version history");
        const reviewDialog = Array.from(
          harness.dom.window.document.body.querySelectorAll('[data-slot="dialog-content"]'),
        ).find((dialog) => dialog.textContent?.includes("Version history"));
        const requestChangesButton = Array.from(
          reviewDialog?.querySelectorAll("button") ?? [],
        ).find((button) => button.textContent?.trim() === "Request changes");
        const captureCurrentButton = Array.from(
          reviewDialog?.querySelectorAll("button") ?? [],
        ).find((button) => button.textContent?.trim() === "Capture current");
        const acceptButton = Array.from(reviewDialog?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent?.trim() === "Accept",
        );
        expect(captureCurrentButton?.hasAttribute("disabled")).toBe(true);
        expect(acceptButton?.hasAttribute("disabled")).toBe(true);
        expect(requestChangesButton?.hasAttribute("disabled")).toBe(true);
        expect(requestChangesButton?.getAttribute("aria-disabled")).toBe("true");
        const descriptionId = requestChangesButton?.getAttribute("aria-describedby");
        expect(descriptionId).toBeTruthy();
        expect(
          descriptionId
            ? harness.dom.window.document.getElementById(descriptionId)?.textContent
            : "",
        ).toContain("Reopen the task before changing artifact versions");
        await act(async () => {
          captureCurrentButton?.click();
          acceptButton?.click();
          requestChangesButton?.click();
        });
        expect(
          harness.dom.window.document.querySelector("#artifact-revision-artifact-1"),
        ).toBeNull();
        expect(captureVersion).not.toHaveBeenCalled();
        expect(acceptVersion).not.toHaveBeenCalled();
        expect(startRevision).not.toHaveBeenCalled();

        const versionOneButton = Array.from(reviewDialog?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent?.includes("Version 1"),
        );
        await act(async () => {
          versionOneButton?.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const restoreButton = Array.from(reviewDialog?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent?.trim() === "Restore draft",
        );
        expect(restoreButton?.hasAttribute("disabled")).toBe(true);
        await act(async () => restoreButton?.click());
        expect(harness.dom.window.document.body.textContent).not.toContain(
          "Restore this version as the draft?",
        );
        expect(restoreVersion).not.toHaveBeenCalled();

        await act(async () => root.unmount());
      } finally {
        harness.restore();
      }
    },
  );

  test.serial("reviews artifact history and gates restore and revision actions", async () => {
    const harness = setupJsdom();
    const restoreVersion = mock(async () => artifactDetail());
    const acceptVersion = mock(async () => artifactDetail());
    const startRevision = mock(async () => artifactDetail());
    const readArtifact = mock(async () => artifactDetail());
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const { TaskContextSidebar } = await import("../src/ui/tasks/TaskContextSidebar");
      const root = createRoot(container);
      resetStore(taskRecord());
      useAppStore.setState({
        restoreTaskArtifactVersion: restoreVersion,
        acceptTaskArtifactVersion: acceptVersion,
        startTaskArtifactRevision: startRevision,
        readTaskArtifact: readArtifact,
      } as never);

      await act(async () => root.render(createElement(TaskContextSidebar)));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const reviseButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Revise this",
      );
      expect(reviseButton).toBeDefined();
      await act(async () => {
        reviseButton?.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(readArtifact).toHaveBeenCalledTimes(1);

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("Version history");
      expect(bodyText).toContain("Updated recommendation");
      expect(bodyText).toContain("Compared with Version 1");
      expect(bodyText).toContain("+Recommendation");
      expect(bodyText).toContain("user feedback");
      expect(bodyText).toContain("Comparison fell back to extracted text.");
      expect(bodyText).toContain("Preview was truncated to the first 100 sections.");
      const openReviewDialog = Array.from(
        harness.dom.window.document.body.querySelectorAll('[data-slot="dialog-content"]'),
      ).find((dialog) => dialog.textContent?.includes("Version history"));
      expect(openReviewDialog?.className).toContain("sm:max-w-[72rem]");

      const acceptButton = Array.from(
        harness.dom.window.document.body.querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "Accept");
      await act(async () => {
        acceptButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(acceptVersion).toHaveBeenCalledWith("task-1", "artifact-1", "version-2");

      const versionOneButton = Array.from(
        harness.dom.window.document.body.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("Version 1"));
      await act(async () => {
        versionOneButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const restoreButton = Array.from(
        harness.dom.window.document.body.querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "Restore draft");
      await act(async () => {
        restoreButton?.click();
      });
      expect(restoreVersion).not.toHaveBeenCalled();
      expect(harness.dom.window.document.body.textContent).toContain(
        "Restore this version as the draft?",
      );
      const restoreConfirmButtons = Array.from(
        harness.dom.window.document.body.querySelectorAll("button"),
      ).filter((button) => button.textContent?.trim() === "Restore draft");
      await act(async () => {
        restoreConfirmButtons.at(-1)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(restoreVersion).toHaveBeenCalledWith("task-1", "artifact-1", "version-1");

      const reviewDialog = Array.from(
        harness.dom.window.document.body.querySelectorAll('[data-slot="dialog-content"]'),
      ).find((dialog) => dialog.textContent?.includes("Version history"));
      const requestChangesButton = Array.from(reviewDialog?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent?.trim() === "Request changes",
      );
      await act(async () => {
        requestChangesButton?.click();
      });
      const textarea = harness.dom.window.document.querySelector(
        "#artifact-revision-artifact-1",
      ) as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      const requestSubmitButtons = Array.from(
        harness.dom.window.document.body.querySelectorAll("button"),
      ).filter((button) => button.textContent?.trim() === "Request changes");
      expect(requestSubmitButtons.at(-1)?.hasAttribute("disabled")).toBe(true);
      expect(startRevision).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });
});
