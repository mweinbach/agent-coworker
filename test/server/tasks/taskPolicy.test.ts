import { describe, expect, test } from "bun:test";

import { registerPendingTerminalTaskLocks } from "../../../src/server/session/taskLocks";
import {
  ArtifactConflictError,
  assertExpectedTaskRevision,
  assertNoIncompleteDependencyRemoval,
  assertTaskAcceptsMutation,
  assertTaskAcceptsNewThreads,
  assertThreadCanClaimWorkItem,
  assertThreadCanMarkWorkItem,
  assertWorkspace,
  buildTaskRetryPrompt,
  isTerminalTask,
  isTerminalTaskMutationError,
  liveArtifactEvidence,
  mediaTypeForArtifact,
  nonEmpty,
  replacementChangesWorkItem,
  TASK_TRANSITIONS,
  type TaskReviewMaterial,
  validateWorkGraph,
} from "../../../src/server/tasks/taskPolicy";
import type { TaskRecord, TaskStatus, WorkItem } from "../../../src/shared/tasks";

const createdAt = "2026-06-18T12:00:00.000Z";

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1",
    taskId: "task-1",
    title: "Design",
    description: "",
    status: "queued",
    dependsOn: [],
    assignedThreadId: null,
    claimedByThreadId: null,
    expectedOutputs: ["plan.md"],
    completionEvidence: null,
    position: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    workspacePath: "/workspace",
    title: "Ship the parser",
    objective: "Cover task policy gates.",
    status: "working",
    revision: 3,
    reviewRequired: true,
    createdAt,
    updatedAt: createdAt,
    threadCount: 2,
    completedWorkItemCount: 0,
    totalWorkItemCount: 2,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
    requirements: [],
    threads: [
      {
        id: "primary",
        taskId: "task-1",
        sessionId: "session-1",
        title: "Main",
        createdBy: "user",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "helper",
        taskId: "task-1",
        sessionId: "session-2",
        title: "Helper",
        createdBy: "coordinator",
        createdAt,
        updatedAt: createdAt,
      },
    ],
    workItems: [],
    decisions: [],
    questions: [],
    artifacts: [],
    blockers: [],
    activity: [],
    latestCheckpoint: null,
    ...overrides,
  };
}

function reviewMaterial(
  artifacts: TaskReviewMaterial["snapshot"]["artifacts"],
): TaskReviewMaterial {
  return {
    fingerprint: "fp-1",
    snapshot: { artifacts } as TaskReviewMaterial["snapshot"],
  };
}

describe("task status transitions", () => {
  test("terminal statuses cannot leave the completed graph", () => {
    expect([...TASK_TRANSITIONS.completed]).toEqual([]);
    expect([...TASK_TRANSITIONS.failed]).toEqual([]);
    expect([...TASK_TRANSITIONS.cancelled]).toEqual([]);
  });

  test("keeps the allowed reopen-free transition table", () => {
    const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
      draft: ["planning", "working", "cancelled", "failed"],
      planning: ["working", "blocked", "cancelled", "failed"],
      working: ["blocked", "awaiting_review", "completed", "cancelled", "failed"],
      blocked: ["working", "cancelled", "failed"],
      awaiting_review: ["working", "completed", "cancelled", "failed"],
      completed: [],
      failed: [],
      cancelled: [],
    };
    expect(TASK_TRANSITIONS).toEqual(allowed);
    expect(TASK_TRANSITIONS.working.includes("draft")).toBe(false);
    expect(TASK_TRANSITIONS.awaiting_review.includes("planning")).toBe(false);
    expect(TASK_TRANSITIONS.blocked.includes("completed")).toBe(false);
  });
});

describe("terminal task mutation gates", () => {
  test("non-terminal tasks accept mutations and new threads", () => {
    expect(() => assertTaskAcceptsMutation(task({ status: "working" }))).not.toThrow();
    expect(() => assertTaskAcceptsNewThreads(task({ status: "blocked" }))).not.toThrow();
    expect(isTerminalTask(task({ status: "working" }))).toBe(false);
  });

  test("completed, failed, and cancelled tasks reject mutations and new threads", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const record = task({ status });
      expect(isTerminalTask(record)).toBe(true);
      expect(() => assertTaskAcceptsMutation(record)).toThrow(
        `Task task-1 is ${status} and cannot be changed until it is reopened or retried.`,
      );
      expect(() => assertTaskAcceptsNewThreads(record)).toThrow(
        `Task task-1 is ${status} and cannot create new focused threads until it is reopened or retried.`,
      );
    }
  });

  test("pending terminal locks fail closed unless the caller opts in", () => {
    const record = task({ status: "working" });
    const release = registerPendingTerminalTaskLocks(
      {
        id: record.id,
        title: record.title,
        threads: record.threads,
        sourceSessionId: null,
      },
      "completed",
    );
    try {
      expect(() => assertTaskAcceptsMutation(record)).toThrow(/finalizing completed/);
      expect(() => assertTaskAcceptsNewThreads(record)).toThrow(/finalizing completed/);
      expect(() =>
        assertTaskAcceptsMutation(record, { allowPendingTerminalLock: true }),
      ).not.toThrow();
      expect(() =>
        assertTaskAcceptsMutation(task({ status: "completed" }), {
          allowPendingTerminalLock: true,
        }),
      ).toThrow(/cannot be changed until it is reopened or retried/);
    } finally {
      release();
    }
  });

  test("isTerminalTaskMutationError matches only durable mutation messages", () => {
    try {
      assertTaskAcceptsMutation(task({ status: "failed" }));
    } catch (error) {
      expect(isTerminalTaskMutationError("task-1", error)).toBe(true);
    }
    try {
      assertTaskAcceptsNewThreads(task({ status: "failed" }));
    } catch (error) {
      expect(isTerminalTaskMutationError("task-1", error)).toBe(false);
    }
    expect(isTerminalTaskMutationError("task-1", new Error("boom"))).toBe(false);
    expect(isTerminalTaskMutationError("task-1", "not-an-error")).toBe(false);
  });

  test("revision conflicts name both expected and current values", () => {
    expect(() => assertExpectedTaskRevision(task({ revision: 4 }), 4)).not.toThrow();
    expect(() => assertExpectedTaskRevision(task({ revision: 4 }), 3)).toThrow(
      "Task revision conflict: expected 3, current 4",
    );
  });

  test("workspace mismatch is fail-closed", () => {
    expect(() =>
      assertWorkspace(task({ workspacePath: "/workspace" }), "/workspace/."),
    ).not.toThrow();
    expect(() => assertWorkspace(task({ workspacePath: "/workspace" }), "/other")).toThrow(
      "Task is outside the active workspace",
    );
  });
});

describe("work item ownership and dependency gates", () => {
  test("validateWorkGraph rejects duplicates, unknown edges, self-edges, and cycles", () => {
    const design = workItem({ id: "design" });
    const implement = workItem({ id: "implement", dependsOn: ["design"] });
    expect(() => validateWorkGraph([design, implement])).not.toThrow();

    expect(() => validateWorkGraph([design, workItem({ id: "design", title: "Copy" })])).toThrow(
      "Duplicate work item id: design",
    );
    expect(() =>
      validateWorkGraph([workItem({ id: "implement", dependsOn: ["missing"] })]),
    ).toThrow("Work item implement depends on unknown item missing");
    expect(() => validateWorkGraph([workItem({ id: "loop", dependsOn: ["loop"] })])).toThrow(
      "Work item loop cannot depend on itself",
    );
    expect(() =>
      validateWorkGraph([
        workItem({ id: "a", dependsOn: ["b"] }),
        workItem({ id: "b", dependsOn: ["a"] }),
      ]),
    ).toThrow("Work item dependency graph contains a cycle");
  });

  test("only the owning or primary thread can mark an unclaimed work item", () => {
    const item = workItem({ id: "design" });
    const record = task({ workItems: [item] });

    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item,
        status: "in_progress",
        threadId: "primary",
      }),
    ).not.toThrow();
    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item,
        status: "in_progress",
        threadId: "helper",
      }),
    ).toThrow("Work item must be claimed before this task thread can mark it: design");
    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item,
        status: "in_progress",
        threadId: "unknown",
      }),
    ).toThrow("Unknown task thread: unknown");
    expect(() =>
      assertThreadCanMarkWorkItem({ task: record, item, status: "in_progress", threadId: null }),
    ).not.toThrow();
  });

  test("a thread owned by another assignee cannot claim or mark the item", () => {
    const item = workItem({
      id: "design",
      assignedThreadId: "primary",
      claimedByThreadId: "primary",
    });
    const record = task({ workItems: [item] });

    expect(() => assertThreadCanClaimWorkItem({ task: record, item, threadId: "helper" })).toThrow(
      "Work item is owned by another task thread: design",
    );
    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item,
        status: "done",
        threadId: "helper",
      }),
    ).toThrow("Work item is owned by another task thread: design");
    expect(() =>
      assertThreadCanClaimWorkItem({ task: record, item, threadId: "primary" }),
    ).not.toThrow();
  });

  test("dependency-gated statuses and claims require completed dependencies", () => {
    const design = workItem({ id: "design", status: "queued" });
    const implement = workItem({ id: "implement", dependsOn: ["design"] });
    const record = task({ workItems: [design, implement] });

    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item: implement,
        status: "queued",
        threadId: "primary",
      }),
    ).not.toThrow();
    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item: implement,
        status: "blocked",
        threadId: "primary",
      }),
    ).not.toThrow();
    expect(() =>
      assertThreadCanMarkWorkItem({
        task: record,
        item: implement,
        status: "in_progress",
        threadId: "primary",
      }),
    ).toThrow("Work item dependency is not complete: design");
    expect(() =>
      assertThreadCanClaimWorkItem({ task: record, item: implement, threadId: "helper" }),
    ).toThrow("Work item dependency is not complete: design");

    const ready = task({
      workItems: [workItem({ id: "design", status: "done" }), implement],
    });
    expect(() =>
      assertThreadCanClaimWorkItem({ task: ready, item: implement, threadId: "helper" }),
    ).not.toThrow();
  });

  test("incomplete dependencies cannot be removed from the graph", () => {
    const design = workItem({ id: "design", status: "queued" });
    const implement = workItem({ id: "implement", dependsOn: ["design"] });
    expect(() =>
      assertNoIncompleteDependencyRemoval({
        items: [design, implement],
        existing: implement,
        next: workItem({ id: "implement", dependsOn: [] }),
      }),
    ).toThrow("Work item dependency is not complete: design");

    expect(() =>
      assertNoIncompleteDependencyRemoval({
        items: [workItem({ id: "design", status: "done" }), implement],
        existing: implement,
        next: workItem({ id: "implement", dependsOn: [] }),
      }),
    ).not.toThrow();
  });

  test("replacementChangesWorkItem is order-sensitive for dependency lists", () => {
    const existing = workItem({
      id: "implement",
      dependsOn: ["design", "review"],
      expectedOutputs: ["code.ts"],
    });
    expect(replacementChangesWorkItem(undefined, existing)).toBe(true);
    expect(replacementChangesWorkItem(existing, { ...existing })).toBe(false);
    expect(
      replacementChangesWorkItem(existing, {
        ...existing,
        dependsOn: ["review", "design"],
      }),
    ).toBe(true);
    expect(replacementChangesWorkItem(existing, { ...existing, status: "done" })).toBe(true);
  });
});

describe("task policy helpers", () => {
  test("nonEmpty trims and rejects blank labels", () => {
    expect(nonEmpty("  brief  ", "Brief")).toBe("brief");
    expect(() => nonEmpty("   ", "Brief")).toThrow("Brief is required");
  });

  test("mediaTypeForArtifact prefers the file extension, then a typed kind", () => {
    expect(mediaTypeForArtifact("Notes.MD", "text")).toBe("text/markdown");
    expect(mediaTypeForArtifact("sheet.XLSX", "blob")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mediaTypeForArtifact("photo.bin", "image/webp")).toBe("image/webp");
    expect(mediaTypeForArtifact("photo.bin", "blob")).toBe("application/octet-stream");
  });

  test("retry prompts include answered questions and skip unresolved ones", () => {
    const prompt = buildTaskRetryPrompt(
      task({
        title: "Ship the parser",
        questions: [
          {
            id: "q-1",
            taskId: "task-1",
            threadId: "primary",
            workItemId: null,
            header: "Scope",
            question: "Keep the current graph?",
            context: "",
            blocking: true,
            urgency: "now",
            defaultAction: null,
            options: [],
            recommendedOptionId: null,
            status: "answered",
            provisionalDecisionId: null,
            answer: "Yes, keep it",
            answerOptionId: null,
            resolutionSource: "user",
            supersedes: null,
            createdAt,
            resolvedAt: createdAt,
          },
          {
            id: "q-2",
            taskId: "task-1",
            threadId: "primary",
            workItemId: null,
            header: "Open",
            question: "Need another reviewer?",
            context: "",
            blocking: false,
            urgency: "optional",
            defaultAction: null,
            options: [],
            recommendedOptionId: null,
            status: "pending",
            provisionalDecisionId: null,
            answer: null,
            answerOptionId: null,
            resolutionSource: null,
            supersedes: null,
            createdAt,
            resolvedAt: null,
          },
        ],
      }),
    );
    expect(prompt).toContain('Retry the task "Ship the parser"');
    expect(prompt).toContain("Keep the current graph?: Yes, keep it");
    expect(prompt).not.toContain("Need another reviewer?");
  });

  test("liveArtifactEvidence fail-closes on incomplete review snapshots", () => {
    expect(
      liveArtifactEvidence(
        reviewMaterial([
          {
            id: "artifact-1",
            path: "report.md",
            liveFile: {
              artifactId: "artifact-1",
              path: "report.md",
              canonicalWorkspaceRelativePath: "report.md",
              sha256: "a".repeat(64),
              sizeBytes: 12,
            },
          },
          {
            id: "artifact-2",
            path: "missing.md",
            liveFile: null,
          },
        ]),
      ),
    ).toEqual([
      {
        id: "artifact-1",
        path: "report.md",
        liveFile: {
          artifactId: "artifact-1",
          path: "report.md",
          canonicalWorkspaceRelativePath: "report.md",
          sha256: "a".repeat(64),
          sizeBytes: 12,
        },
      },
      { id: "artifact-2", path: "missing.md", liveFile: null },
    ]);

    expect(() =>
      liveArtifactEvidence(reviewMaterial([{ path: "report.md", liveFile: null }])),
    ).toThrow("Invalid review material artifact id");
    expect(() =>
      liveArtifactEvidence(
        reviewMaterial([
          {
            id: "artifact-1",
            path: "report.md",
            liveFile: { artifactId: "artifact-1", path: "report.md" },
          },
        ]),
      ),
    ).toThrow("Invalid review material artifact canonicalWorkspaceRelativePath");
    expect(() =>
      liveArtifactEvidence(
        reviewMaterial([
          {
            id: "artifact-1",
            path: "report.md",
            liveFile: {
              artifactId: "artifact-1",
              path: "report.md",
              canonicalWorkspaceRelativePath: "report.md",
              sha256: "a".repeat(64),
              sizeBytes: Number.NaN,
            },
          },
        ]),
      ),
    ).toThrow("Invalid review material live file size");
    expect(() =>
      liveArtifactEvidence(reviewMaterial([{ id: "artifact-1", path: "report.md", liveFile: [] }])),
    ).toThrow("Invalid review material live file evidence");
  });

  test("ArtifactConflictError reports the expected and current fingerprints", () => {
    const missing = new ArtifactConflictError("artifact-1", "abc", null);
    expect(missing.code).toBe("artifact_conflict");
    expect(missing.message).toBe("Artifact changed on disk: expected abc, current missing");
    expect(new ArtifactConflictError("artifact-1", "abc", "def").message).toBe(
      "Artifact changed on disk: expected abc, current def",
    );
  });
});
