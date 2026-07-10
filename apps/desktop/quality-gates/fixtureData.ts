import type { TaskArtifactDetail, TaskRecord } from "../../../src/shared/tasks";

export const FIXED_NOW = "2026-07-09T12:00:00.000Z";
export const PROJECT_WORKSPACE_ID = "quality-project";
export const PROJECT_THREAD_ID = "quality-thread";
export const TASK_ID = "quality-task";

export function createQualityTaskFixture(status: TaskRecord["status"] = "blocked"): TaskRecord {
  const cancelled = status === "cancelled";
  return {
    id: TASK_ID,
    workspacePath: "/quality/project",
    title: "Ship Electron quality gates",
    objective:
      "Protect desktop releases with deterministic UI, accessibility, and performance checks.",
    context: "The task is active and awaiting a product decision before final review.",
    sourceSessionId: PROJECT_THREAD_ID,
    creationOrigin: "manual",
    status,
    revision: cancelled ? 5 : 4,
    reviewRequired: true,
    reviewRounds: 3,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    threadCount: 1,
    completedWorkItemCount: 1,
    totalWorkItemCount: 2,
    activeBlockerCount: cancelled ? 0 : 1,
    pendingQuestionCount: cancelled ? 0 : 1,
    blockingQuestionCount: cancelled ? 0 : 1,
    requirements: [
      {
        id: "requirement-1",
        kind: "acceptance_criterion",
        text: "All quality gates run without provider credentials.",
        source: "user",
        permanence: "fixed",
        status: "active",
        createdAt: FIXED_NOW,
        supersedes: null,
      },
    ],
    threads: [
      {
        id: "task-thread-1",
        taskId: TASK_ID,
        sessionId: "task-session-1",
        title: "Implementation",
        createdBy: "coordinator",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ],
    workItems: [
      {
        id: "work-1",
        taskId: TASK_ID,
        title: "Build deterministic harness",
        description: "Launch the shipping renderer through Electron.",
        status: "done",
        dependsOn: [],
        assignedThreadId: "task-thread-1",
        claimedByThreadId: "task-thread-1",
        expectedOutputs: ["Electron harness"],
        completionEvidence: "Harness launches locally.",
        position: 0,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      {
        id: "work-2",
        taskId: TASK_ID,
        title: "Review release artifacts",
        description: "Approve the generated desktop screenshot.",
        status: cancelled ? "abandoned" : "blocked",
        dependsOn: ["work-1"],
        assignedThreadId: "task-thread-1",
        claimedByThreadId: "task-thread-1",
        expectedOutputs: ["Approved screenshot"],
        completionEvidence: null,
        position: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ],
    decisions: [],
    questions: cancelled
      ? []
      : [
          {
            id: "question-1",
            taskId: TASK_ID,
            threadId: "task-thread-1",
            workItemId: "work-2",
            header: "Release screenshot",
            question: "Which theme should be used for the release screenshot?",
            context: "The approved image is copied from a visual baseline.",
            blocking: true,
            urgency: "now",
            defaultAction: "Use the light theme.",
            options: [
              {
                id: "light",
                label: "Light",
                description: "Use the 1240px light baseline.",
              },
              {
                id: "dark",
                label: "Dark",
                description: "Use the 1240px dark baseline.",
              },
            ],
            recommendedOptionId: "light",
            status: "pending",
            provisionalDecisionId: null,
            answer: null,
            answerOptionId: null,
            resolutionSource: null,
            supersedes: null,
            createdAt: FIXED_NOW,
            resolvedAt: null,
          },
        ],
    artifacts: [
      {
        id: "artifact-1",
        taskId: TASK_ID,
        workItemId: "work-2",
        threadId: "task-thread-1",
        path: "/quality/project/quality-gate-report.md",
        kind: "markdown",
        title: "Quality gate report",
        createdBy: "task-thread-1",
        provenance: { source: "quality-gate-fixture" },
        createdAt: FIXED_NOW,
      },
    ],
    blockers: cancelled
      ? []
      : [
          {
            id: "blocker-1",
            taskId: TASK_ID,
            workItemId: "work-2",
            description: "Waiting for the release screenshot decision.",
            blocking: true,
            status: "active",
            createdAt: FIXED_NOW,
            resolvedAt: null,
          },
        ],
    activity: [],
    latestCheckpoint: null,
  };
}

export function createQualityTaskArtifactDetail(): TaskArtifactDetail {
  const artifact = createQualityTaskFixture().artifacts[0];
  if (!artifact) {
    throw new Error("Quality task artifact fixture is missing");
  }
  return {
    artifact,
    versions: [],
    latestVersionId: null,
    acceptedVersionId: null,
    activeRevision: null,
  };
}
