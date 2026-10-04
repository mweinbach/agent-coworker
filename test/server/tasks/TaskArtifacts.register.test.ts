import { describe, expect, mock, test } from "bun:test";

import { type TaskArtifactHost, TaskArtifacts } from "../../../src/server/tasks/TaskArtifacts";
import type { RevisionOutcomeResult } from "../../../src/server/tasks/TaskCoordinator";
import type {
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskRecord,
} from "../../../src/shared/tasks";

const CREATED_AT = "2026-06-18T12:00:00.000Z";
const ARTIFACT_PATH = "/workspace/out/report.md";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    workspacePath: "/workspace",
    title: "Task",
    objective: "Do the work",
    status: "working",
    revision: 3,
    reviewRequired: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
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
        sessionId: "session-1",
        title: "Main",
        createdBy: "user",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    workItems: [
      {
        id: "item-1",
        taskId: "task-1",
        title: "Write report",
        description: "",
        status: "in_progress",
        dependsOn: [],
        assignedThreadId: "task-thread-1",
        claimedByThreadId: "task-thread-1",
        expectedOutputs: ["report.md"],
        completionEvidence: null,
        position: 0,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    decisions: [],
    questions: [],
    artifacts: [
      {
        id: "artifact-1",
        taskId: "task-1",
        workItemId: "item-1",
        threadId: "task-thread-1",
        path: ARTIFACT_PATH,
        kind: "markdown",
        title: "Report",
        createdBy: "user",
        provenance: {},
        createdAt: CREATED_AT,
      },
    ],
    blockers: [],
    activity: [],
    latestCheckpoint: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return {
    id: "artifact-1",
    taskId: "task-1",
    workItemId: "item-1",
    threadId: "task-thread-1",
    path: ARTIFACT_PATH,
    kind: "markdown",
    title: "Report",
    createdBy: "user",
    provenance: {},
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function makeRevision(overrides: Partial<TaskArtifactRevision> = {}): TaskArtifactRevision {
  return {
    id: "rev-1",
    taskId: "task-1",
    artifactId: "artifact-1",
    workItemId: "item-1",
    taskThreadId: "task-thread-1",
    sessionId: "session-1",
    baseVersionId: "ver-1",
    priorVersionId: "ver-1",
    status: "active",
    instruction: "Update the report",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    completedAt: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<TaskArtifactDetail> = {}): TaskArtifactDetail {
  const artifact = makeArtifact();
  return {
    artifact,
    versions: [
      {
        id: "ver-1",
        artifactId: artifact.id,
        version: 1,
        parentVersionId: null,
        sha256: "a".repeat(64),
        sizeBytes: 12,
        mediaType: "text/markdown",
        createdBy: "user",
        createdAt: CREATED_AT,
        changeSummary: "initial",
        provenance: {},
        reviewStatus: "draft",
      },
    ],
    latestVersionId: "ver-1",
    acceptedVersionId: null,
    activeRevision: makeRevision(),
    ...overrides,
  };
}

function makeHost(options?: {
  task?: TaskRecord;
  activeRevision?: TaskArtifactRevision | null;
  detail?: TaskArtifactDetail | null;
  captureSha256?: string;
  finalizeLocked?: RevisionOutcomeResult | null;
  finalize?: RevisionOutcomeResult | null;
}): {
  artifacts: TaskArtifacts;
  host: TaskArtifactHost;
  handleThreadOutcome: ReturnType<typeof mock>;
  handleThreadOutcomeLocked: ReturnType<typeof mock>;
  captureFile: ReturnType<typeof mock>;
} {
  const task = options?.task ?? makeTask();
  const handleThreadOutcome = mock(async () =>
    options && "finalize" in options ? (options.finalize ?? null) : null,
  );
  const handleThreadOutcomeLocked = mock(async () =>
    options && "finalizeLocked" in options ? (options.finalizeLocked ?? null) : null,
  );
  const captureFile = mock(async () => ({
    sha256: options?.captureSha256 ?? "b".repeat(64),
    sizeBytes: 20,
  }));

  const host: TaskArtifactHost = {
    sessionDb: {
      getActiveTaskArtifactRevisionForSession: () =>
        options && "activeRevision" in options ? (options.activeRevision ?? null) : makeRevision(),
      getTaskArtifactDetail: () =>
        options && "detail" in options ? (options.detail ?? null) : makeDetail(),
    } as TaskArtifactHost["sessionDb"],
    artifactStore: {
      captureFile,
    } as TaskArtifactHost["artifactStore"],
    runTaskMutation: async (_taskId, callback) => await callback({ queued: false }),
    requireTask: () => task,
    requireArtifactDetail: () =>
      options && "detail" in options && options.detail ? options.detail : makeDetail(),
    resolveArtifactPath: async (_task, artifactPath) => artifactPath,
    makeArtifactVersion: (input) => ({
      id: "ver-2",
      artifactId: input.artifact.id,
      version: input.version,
      parentVersionId: input.parentVersionId,
      sha256: input.stored.sha256,
      sizeBytes: input.stored.sizeBytes,
      mediaType: input.mediaType,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      changeSummary: input.changeSummary,
      provenance: input.provenance,
      reviewStatus: input.reviewStatus,
    }),
    assertExpectedFingerprint: () => undefined,
    notifyUpdated: () => undefined,
    handleThreadOutcome,
    handleThreadOutcomeLocked,
  };

  return {
    artifacts: new TaskArtifacts(host),
    host,
    handleThreadOutcome,
    handleThreadOutcomeLocked,
    captureFile,
  };
}

const registerInput = {
  taskId: "task-1",
  workspacePath: "/workspace",
  expectedRevision: 3,
  sessionId: "session-1",
  path: ARTIFACT_PATH,
  title: "Report",
  kind: "markdown",
};

describe("TaskArtifacts.registerArtifactLocked", () => {
  test("rejects unknown work items before touching an active revision", async () => {
    const { artifacts, handleThreadOutcomeLocked } = makeHost();
    await expect(
      artifacts.registerArtifactLocked({ ...registerInput, workItemId: "missing" }),
    ).rejects.toThrow("Unknown work item: missing");
    expect(handleThreadOutcomeLocked).not.toHaveBeenCalled();
  });

  test("rejects an active revision that targets a different artifact or path", async () => {
    const { artifacts: artifactMismatch } = makeHost();
    await expect(
      artifactMismatch.registerArtifactLocked({ ...registerInput, artifactId: "other-artifact" }),
    ).rejects.toThrow("Active revision targets a different artifact");

    const { artifacts: pathMismatch } = makeHost({
      detail: makeDetail({ artifact: makeArtifact({ path: "/workspace/other.md" }) }),
    });
    await expect(pathMismatch.registerArtifactLocked(registerInput)).rejects.toThrow(
      "Active revision targets a different artifact path",
    );

    const { artifacts: missingDetail } = makeHost({ detail: null });
    await expect(missingDetail.registerArtifactLocked(registerInput)).rejects.toThrow(
      "Active revision targets a different artifact path",
    );
  });

  test("rejects a base version that does not match the active revision", async () => {
    const { artifacts } = makeHost();
    await expect(
      artifacts.registerArtifactLocked({ ...registerInput, baseVersionId: "ver-other" }),
    ).rejects.toThrow("Artifact base version does not match the active revision");
  });

  test("fails closed when the active revision cannot be finalized", async () => {
    const { artifacts, handleThreadOutcomeLocked, handleThreadOutcome } = makeHost({
      finalizeLocked: null,
    });
    await expect(
      artifacts.registerArtifactLocked(registerInput, {
        finishActiveRevisionInCurrentLock: true,
      }),
    ).rejects.toThrow("Active artifact revision could not be finalized");
    expect(handleThreadOutcomeLocked).toHaveBeenCalledTimes(1);
    expect(handleThreadOutcomeLocked.mock.calls[0]?.[3]).toEqual({
      deferTerminalUntilOriginSettled: true,
    });
    expect(handleThreadOutcome).not.toHaveBeenCalled();
  });

  test("uses the unlocked outcome path when not finishing inside the current lock", async () => {
    const finalizedTask = makeTask({ revision: 4 });
    const { artifacts, handleThreadOutcome, handleThreadOutcomeLocked } = makeHost({
      finalize: {
        task: finalizedTask,
        detail: makeDetail(),
        revision: makeRevision({ status: "completed" }),
      },
    });

    await expect(
      artifacts.registerArtifactLocked(registerInput, { finishActiveRevisionInCurrentLock: false }),
    ).resolves.toEqual(finalizedTask);
    expect(handleThreadOutcome).toHaveBeenCalledTimes(1);
    expect(handleThreadOutcomeLocked).not.toHaveBeenCalled();
  });

  test("rejects unknown artifact ids and unknown base versions when no revision is active", async () => {
    const { artifacts: unknownArtifact, captureFile } = makeHost({ activeRevision: null });
    await expect(
      unknownArtifact.registerArtifactLocked({
        ...registerInput,
        artifactId: "missing-artifact",
        sessionId: undefined,
      }),
    ).rejects.toThrow("Unknown task artifact: missing-artifact");
    expect(captureFile).toHaveBeenCalledTimes(1);

    const { artifacts: unknownBase } = makeHost({ activeRevision: null });
    await expect(
      unknownBase.registerArtifactLocked({
        ...registerInput,
        artifactId: "artifact-1",
        baseVersionId: "missing-version",
        sessionId: undefined,
      }),
    ).rejects.toThrow("Unknown artifact base version: missing-version");
  });

  test("returns the current task when the captured file matches the latest version", async () => {
    const task = makeTask();
    const { artifacts, host } = makeHost({
      task,
      activeRevision: null,
      captureSha256: "a".repeat(64),
    });
    const makeVersion = mock(host.makeArtifactVersion);
    host.makeArtifactVersion = makeVersion;

    await expect(
      artifacts.registerArtifactLocked({ ...registerInput, sessionId: undefined }),
    ).resolves.toBe(task);
    expect(makeVersion).not.toHaveBeenCalled();
  });
});
