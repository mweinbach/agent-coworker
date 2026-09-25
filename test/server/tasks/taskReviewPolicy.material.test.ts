import { describe, expect, test } from "bun:test";

import {
  buildTaskReviewMaterialSnapshot,
  fingerprintTaskReviewMaterial,
  stableStringify,
  type TaskReviewArtifactFileSnapshot,
} from "../../../src/server/tasks/taskReviewPolicy";
import type {
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactVersion,
  TaskBlocker,
  TaskDecision,
  TaskQuestion,
  TaskRecord,
  TaskRequirement,
  WorkItem,
} from "../../../src/shared/tasks";

const CREATED_AT = "2026-06-18T12:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    workspacePath: "/workspace",
    title: "Ship report",
    objective: "Produce the accepted report",
    context: "Keep the live file authoritative",
    status: "awaiting_review",
    revision: 3,
    reviewRequired: true,
    reviewRounds: 2,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    threadCount: 1,
    completedWorkItemCount: 0,
    totalWorkItemCount: 1,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
    requirements: [],
    threads: [],
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

function requirement(overrides: Partial<TaskRequirement>): TaskRequirement {
  return {
    id: "req-1",
    kind: "acceptance_criterion",
    text: "Report is complete",
    source: "user",
    permanence: "fixed",
    status: "active",
    createdAt: CREATED_AT,
    supersedes: null,
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-1",
    taskId: "task-1",
    title: "Write report",
    description: "Draft then accept",
    status: "review",
    dependsOn: ["wi-setup"],
    assignedThreadId: "thread-1",
    claimedByThreadId: null,
    expectedOutputs: ["report.md"],
    completionEvidence: "report.md exists",
    position: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function decision(overrides: Partial<TaskDecision>): TaskDecision {
  return {
    id: "dec-1",
    taskId: "task-1",
    question: "Which format?",
    resolution: "Markdown",
    source: "user",
    scope: "task",
    confidence: 0.9,
    status: "active",
    createdAt: CREATED_AT,
    supersedes: null,
    ...overrides,
  };
}

function question(overrides: Partial<TaskQuestion>): TaskQuestion {
  return {
    id: "q-1",
    taskId: "task-1",
    threadId: "thread-1",
    workItemId: "wi-1",
    header: "Scope",
    question: "Include appendix?",
    context: "Customer asked",
    blocking: true,
    urgency: "now",
    defaultAction: "omit",
    options: [
      { id: "opt-b", label: "Yes", description: "Add it" },
      { id: "opt-a", label: "No", description: "Skip it" },
    ],
    recommendedOptionId: "opt-a",
    status: "answered",
    provisionalDecisionId: null,
    answer: "No",
    answerOptionId: "opt-a",
    resolutionSource: "user",
    supersedes: null,
    createdAt: CREATED_AT,
    resolvedAt: CREATED_AT,
    ...overrides,
  };
}

function blocker(overrides: Partial<TaskBlocker>): TaskBlocker {
  return {
    id: "blk-1",
    taskId: "task-1",
    workItemId: "wi-1",
    description: "Waiting on numbers",
    blocking: true,
    status: "active",
    createdAt: CREATED_AT,
    resolvedAt: null,
    ...overrides,
  };
}

function artifact(overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return {
    id: "art-1",
    taskId: "task-1",
    workItemId: "wi-1",
    threadId: "thread-1",
    path: "report.md",
    kind: "markdown",
    title: "Report",
    createdBy: "user",
    provenance: { origin: "register" },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function version(overrides: Partial<TaskArtifactVersion> = {}): TaskArtifactVersion {
  return {
    id: "ver-1",
    artifactId: "art-1",
    version: 1,
    parentVersionId: null,
    sha256: SHA_A,
    sizeBytes: 12,
    mediaType: "text/markdown",
    createdBy: "user",
    createdAt: CREATED_AT,
    changeSummary: "Initial",
    provenance: { baseline: true },
    reviewStatus: "accepted",
    ...overrides,
  };
}

function liveFile(
  overrides: Partial<TaskReviewArtifactFileSnapshot> = {},
): TaskReviewArtifactFileSnapshot {
  return {
    artifactId: "art-1",
    path: "/workspace/report.md",
    canonicalWorkspaceRelativePath: "report.md",
    sha256: SHA_B,
    sizeBytes: 20,
    ...overrides,
  };
}

describe("task review material fingerprints", () => {
  test("stableStringify sorts object keys without changing array order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(stableStringify([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
  });

  test("snapshot drops inactive and superseded material and includes live file evidence", () => {
    const report = artifact();
    const snapshot = buildTaskReviewMaterialSnapshot({
      task: makeTask({
        context: undefined,
        requirements: [
          requirement({ id: "req-old", status: "superseded", text: "Old criterion" }),
          requirement({ id: "req-active", text: "Report is complete" }),
        ],
        workItems: [
          workItem({
            dependsOn: ["wi-b", "wi-a"],
            expectedOutputs: ["notes.md", "report.md"],
          }),
        ],
        decisions: [
          decision({ id: "dec-old", status: "superseded", resolution: "PDF" }),
          decision({ id: "dec-active", resolution: "Markdown" }),
        ],
        questions: [
          question({ id: "q-old", status: "superseded", question: "Old question" }),
          question({ id: "q-live", question: "Include appendix?" }),
        ],
        blockers: [
          blocker({ id: "blk-old", status: "resolved", description: "Resolved blocker" }),
          blocker({ id: "blk-live", description: "Waiting on numbers" }),
        ],
        artifacts: [report],
      }),
      artifactDetails: [
        {
          artifact: report,
          versions: [version()],
          latestVersionId: "ver-1",
          acceptedVersionId: "ver-1",
          activeRevision: {
            id: "rev-1",
            taskId: "task-1",
            artifactId: "art-1",
            workItemId: "wi-1",
            taskThreadId: "task-thread-1",
            sessionId: "session-1",
            baseVersionId: "ver-1",
            priorVersionId: "ver-1",
            status: "active",
            instruction: "Tighten the summary",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            completedAt: null,
          },
        } satisfies TaskArtifactDetail,
      ],
      artifactFiles: [liveFile()],
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      objective: "Produce the accepted report",
      context: "",
      requirements: [{ text: "Report is complete", status: "active" }],
      decisions: [{ resolution: "Markdown", status: "active" }],
      questions: [{ question: "Include appendix?", status: "answered" }],
      blockers: [{ description: "Waiting on numbers", status: "active" }],
    });
    expect(snapshot.requirements).toHaveLength(1);
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.questions).toHaveLength(1);
    expect(snapshot.blockers).toHaveLength(1);
    expect(snapshot.workItems[0]?.dependsOn).toEqual(["wi-a", "wi-b"]);
    expect(snapshot.workItems[0]?.expectedOutputs).toEqual(["notes.md", "report.md"]);
    expect(snapshot.questions[0]?.options.map((option) => option.id)).toEqual(["opt-a", "opt-b"]);
    expect(snapshot.artifacts[0]).toMatchObject({
      id: "art-1",
      latestVersionId: "ver-1",
      acceptedVersionId: "ver-1",
      liveFile: {
        artifactId: "art-1",
        sha256: SHA_B,
        sizeBytes: 20,
      },
      activeRevision: {
        id: "rev-1",
        status: "active",
        instruction: "Tighten the summary",
      },
    });
  });

  test("input reorder and unused details do not change the fingerprint", () => {
    const first = artifact({ id: "art-a", path: "a.md", title: "A" });
    const second = artifact({ id: "art-b", path: "b.md", title: "B" });
    const firstFile = liveFile({ artifactId: "art-a", path: "/workspace/a.md", sha256: SHA_A });
    const secondFile = liveFile({ artifactId: "art-b", path: "/workspace/b.md", sha256: SHA_B });
    const unusedDetail = {
      artifact: artifact({ id: "art-unused", path: "unused.md" }),
      versions: [version({ id: "ver-unused", artifactId: "art-unused" })],
      latestVersionId: "ver-unused",
      acceptedVersionId: null,
      activeRevision: null,
    } satisfies TaskArtifactDetail;

    const left = buildTaskReviewMaterialSnapshot({
      task: makeTask({
        requirements: [
          requirement({ id: "req-b", text: "Beta", kind: "constraint" }),
          requirement({ id: "req-a", text: "Alpha", kind: "requirement" }),
        ],
        workItems: [workItem({ id: "wi-2", position: 2, title: "Second" }), workItem()],
        artifacts: [second, first],
      }),
      artifactDetails: [unusedDetail],
      artifactFiles: [secondFile, firstFile],
    });
    const right = buildTaskReviewMaterialSnapshot({
      task: makeTask({
        requirements: [
          requirement({ id: "req-a", text: "Alpha", kind: "requirement" }),
          requirement({ id: "req-b", text: "Beta", kind: "constraint" }),
        ],
        workItems: [workItem(), workItem({ id: "wi-2", position: 2, title: "Second" })],
        artifacts: [first, second],
      }),
      artifactDetails: [],
      artifactFiles: [firstFile, secondFile],
    });

    expect(left.requirements.map((item) => item.text)).toEqual(["Beta", "Alpha"]);
    expect(left.workItems.map((item) => item.id)).toEqual(["wi-1", "wi-2"]);
    expect(left.artifacts.map((item) => item.id)).toEqual(["art-a", "art-b"]);
    expect(left.artifacts[0]?.liveFile?.sha256).toBe(SHA_A);
    expect(left.artifacts[0]?.latestVersionId).toBeNull();
    expect(fingerprintTaskReviewMaterial(left)).toBe(fingerprintTaskReviewMaterial(right));
  });

  test("objective or live SHA changes produce a different fingerprint", () => {
    const report = artifact();
    const base = buildTaskReviewMaterialSnapshot({
      task: makeTask({ artifacts: [report] }),
      artifactDetails: [],
      artifactFiles: [liveFile()],
    });
    const changedObjective = buildTaskReviewMaterialSnapshot({
      task: makeTask({ objective: "Produce a different report", artifacts: [report] }),
      artifactDetails: [],
      artifactFiles: [liveFile()],
    });
    const changedFile = buildTaskReviewMaterialSnapshot({
      task: makeTask({ artifacts: [report] }),
      artifactDetails: [],
      artifactFiles: [liveFile({ sha256: SHA_A })],
    });

    expect(fingerprintTaskReviewMaterial(base)).not.toBe(
      fingerprintTaskReviewMaterial(changedObjective),
    );
    expect(fingerprintTaskReviewMaterial(base)).not.toBe(
      fingerprintTaskReviewMaterial(changedFile),
    );
  });
});
