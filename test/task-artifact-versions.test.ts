import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";
import { ArtifactVersionStore } from "../src/server/tasks/ArtifactVersionStore";
import { ArtifactConflictError, TaskCoordinator } from "../src/server/tasks/TaskCoordinator";
import type { TaskRecord, TaskStatus } from "../src/shared/tasks";

const TERMINAL_TASK_STATUSES = [
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly TaskStatus[];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class PausingArtifactVersionStore extends ArtifactVersionStore {
  readonly captureCalls: string[] = [];
  readonly restoreCalls: string[] = [];
  private pause: {
    kind: "capture" | "restore";
    filePath: string;
    reached: Deferred<void>;
    release: Deferred<void>;
  } | null = null;

  pauseNext(
    kind: "capture" | "restore",
    filePath: string,
  ): {
    reached: Promise<void>;
    release: () => void;
  } {
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    this.pause = { kind, filePath, reached, release };
    return {
      reached: reached.promise,
      release: () => release.resolve(),
    };
  }

  override async captureFile(filePath: string) {
    await this.maybePause("capture", filePath);
    this.captureCalls.push(filePath);
    return await super.captureFile(filePath);
  }

  override async restoreFile(input: Parameters<ArtifactVersionStore["restoreFile"]>[0]) {
    await this.maybePause("restore", input.filePath);
    this.restoreCalls.push(input.filePath);
    return await super.restoreFile(input);
  }

  private async maybePause(kind: "capture" | "restore", filePath: string): Promise<void> {
    const pause = this.pause;
    if (!pause || pause.kind !== kind || pause.filePath !== filePath) return;
    this.pause = null;
    pause.reached.resolve();
    await pause.release.promise;
  }
}

async function createHarness() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-artifact-version-test-"));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  const workspacePath = path.join(home, "project");
  await Promise.all([
    fs.mkdir(sessionsDir, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ]);
  const sessionDb = await SessionDb.create({ paths: { rootDir, sessionsDir } });
  const artifactStore = new ArtifactVersionStore({ rootDir: path.join(rootDir, "artifacts") });
  const coordinator = new TaskCoordinator({ sessionDb, artifactStore });
  let threadIndex = 1;
  let threadFactoryCalls = 0;
  coordinator.setThreadFactory(async () => {
    threadFactoryCalls += 1;
    return { sessionId: `revision-session-${threadIndex++}` };
  });
  return {
    home,
    rootDir,
    workspacePath,
    sessionDb,
    artifactStore,
    coordinator,
    getThreadFactoryCalls: () => threadFactoryCalls,
  };
}

async function createPausingHarness(
  options: {
    quiesceTaskThreads?: (
      task: TaskRecord,
      reason: "completed" | "cancelled" | "failed",
    ) => Promise<void> | void;
  } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-artifact-version-test-"));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  const workspacePath = path.join(home, "project");
  await Promise.all([
    fs.mkdir(sessionsDir, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ]);
  const sessionDb = await SessionDb.create({ paths: { rootDir, sessionsDir } });
  const artifactStore = new PausingArtifactVersionStore({
    rootDir: path.join(rootDir, "artifacts"),
  });
  const coordinator = new TaskCoordinator({
    sessionDb,
    artifactStore,
    ...(options.quiesceTaskThreads ? { quiesceTaskThreads: options.quiesceTaskThreads } : {}),
  });
  let threadIndex = 1;
  coordinator.setThreadFactory(async () => ({ sessionId: `revision-session-${threadIndex++}` }));
  return {
    home,
    rootDir,
    workspacePath,
    sessionDb,
    artifactStore,
    coordinator,
  };
}

async function createTaskWithArtifact(
  harness: Pick<Awaited<ReturnType<typeof createHarness>>, "workspacePath" | "coordinator">,
  options: { reviewRequired?: boolean; workItemId?: string; artifactFilename?: string } = {},
) {
  const workItemId = options.workItemId ?? "deliver-report";
  const artifactPath = path.join(harness.workspacePath, options.artifactFilename ?? "report.md");
  await fs.writeFile(artifactPath, "version one\n");
  let task = await harness.coordinator.create({
    workspacePath: harness.workspacePath,
    title: "Artifact review",
    objective: "Produce and review a report.",
    sessionId: `main-session-${crypto.randomUUID()}`,
    reviewRequired: options.reviewRequired,
  });
  task = await harness.coordinator.replaceWorkItems({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    items: [
      {
        id: workItemId,
        title: "Deliver report",
        expectedOutputs: [path.basename(artifactPath)],
      },
    ],
  });
  task = await harness.coordinator.registerArtifact({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    path: artifactPath,
    title: "Report",
    kind: "markdown",
    workItemId,
  });
  const artifact = task.artifacts[0];
  if (!artifact) throw new Error("Expected registered artifact");
  const detail = harness.coordinator.getArtifactDetail({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifact.id,
  });
  if (!detail) throw new Error("Expected artifact detail");
  return { task, artifact, detail, artifactPath };
}

async function createTaskWithRestorableArtifactVersion(
  harness: Pick<Awaited<ReturnType<typeof createHarness>>, "workspacePath" | "coordinator">,
) {
  let { task, artifact, detail, artifactPath } = await createTaskWithArtifact(harness);
  const first = detail.versions[0];
  if (!first) throw new Error("Expected initial artifact version");
  task = await harness.coordinator.transition({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    status: "working",
    summary: "Artifact work started",
  });
  await fs.writeFile(artifactPath, "version two\n");
  const captured = await harness.coordinator.captureArtifactVersion({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifact.id,
    expectedRevision: task.revision,
    changeSummary: "Second version",
  });
  return {
    task: captured.task,
    artifact,
    artifactPath,
    first,
    second: captured.version,
    detail: captured.detail,
  };
}

describe("ArtifactVersionStore", () => {
  test("deduplicates immutable bytes by SHA-256", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-cas-test-"));
    const store = new ArtifactVersionStore({ rootDir });
    const first = await store.putBytes(Buffer.from("same bytes"));
    const second = await store.putBytes(Buffer.from("same bytes"));

    expect(second).toEqual(first);
    expect(store.getBlobPath(second.sha256)).toBe(store.getBlobPath(first.sha256));
    expect(Buffer.from(await store.readBytes(first.sha256)).toString("utf8")).toBe("same bytes");
  });
});

describe("task artifact versions", () => {
  for (const status of TERMINAL_TASK_STATUSES) {
    test(`rejects artifact revision starts on ${status} tasks before mutation`, async () => {
      const harness = await createHarness();
      try {
        let { task, artifact } = await createTaskWithArtifact(harness);
        task = await harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: "working",
          summary: "Artifact work started",
        });
        task = await harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status,
          summary: `Task is ${status}`,
        });
        const threadFactoryCalls = harness.getThreadFactoryCalls();
        const detailBefore = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });

        await expect(
          harness.coordinator.startArtifactRevision({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: artifact.id,
            expectedRevision: task.revision,
            instruction: "Mutate nothing after terminal state.",
          }),
        ).rejects.toThrow(`Task ${task.id} is ${status}`);

        const taskAfter = harness.coordinator.get(task.id, harness.workspacePath);
        const detailAfter = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });
        expect(harness.getThreadFactoryCalls()).toBe(threadFactoryCalls);
        expect(taskAfter).toMatchObject({
          status,
          revision: task.revision,
          threadCount: task.threadCount,
        });
        expect(detailAfter).toEqual(detailBefore);
        expect(detailAfter?.activeRevision).toBeNull();
      } finally {
        harness.sessionDb.close();
      }
    });

    test(`rejects artifact version mutations on ${status} tasks before mutation`, async () => {
      const harness = await createHarness();
      try {
        let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
        task = await harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: "working",
          summary: "Artifact work started",
        });
        await fs.writeFile(artifactPath, "version two\n");
        const captured = await harness.coordinator.captureArtifactVersion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          expectedRevision: task.revision,
          changeSummary: "Pre-terminal draft",
        });
        task = await harness.coordinator.transition({
          taskId: captured.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: captured.task.revision,
          status,
          summary: `Task is ${status}`,
        });
        await fs.writeFile(artifactPath, "late live edit\n");
        const firstVersion = captured.detail.versions[0];
        if (!firstVersion) throw new Error("Expected first version");
        const detailBefore = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });

        await expect(
          harness.coordinator.captureArtifactVersion({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: artifact.id,
            expectedRevision: task.revision,
            changeSummary: "Late capture after terminal state",
          }),
        ).rejects.toThrow(`Task ${task.id} is ${status}`);
        await expect(
          harness.coordinator.restoreArtifactVersion({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: artifact.id,
            versionId: firstVersion.id,
            expectedRevision: task.revision,
          }),
        ).rejects.toThrow(`Task ${task.id} is ${status}`);
        await expect(
          harness.coordinator.acceptArtifactVersion({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: artifact.id,
            versionId: captured.version.id,
            expectedRevision: task.revision,
          }),
        ).rejects.toThrow(`Task ${task.id} is ${status}`);

        expect(await fs.readFile(artifactPath, "utf8")).toBe("late live edit\n");
        expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
          status,
          revision: task.revision,
        });
        expect(
          harness.coordinator.getArtifactDetail({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: artifact.id,
          }),
        ).toEqual(detailBefore);
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("reports stale artifact revision conflicts before terminal lifecycle errors", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Artifact work started",
      });
      const staleRevision = task.revision;
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "completed",
        summary: "Task completed elsewhere",
      });

      await expect(
        harness.coordinator.startArtifactRevision({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          expectedRevision: staleRevision,
          instruction: "Stale client wants a revision.",
        }),
      ).rejects.toThrow(
        `Task revision conflict: expected ${staleRevision}, current ${task.revision}`,
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("persists lineage, skips identical captures, and restores as a new version", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, detail, artifactPath } = await createTaskWithArtifact(harness);
      const first = detail.versions[0];
      if (!first) throw new Error("Expected initial version");
      expect(first).toMatchObject({ version: 1, parentVersionId: null, reviewStatus: "draft" });

      await fs.writeFile(artifactPath, "version two\n");
      const captured = await harness.coordinator.captureArtifactVersion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        changeSummary: "Updated analysis",
      });
      task = captured.task;
      detail = captured.detail;
      const second = captured.version;
      expect(second).toMatchObject({
        version: 2,
        parentVersionId: first.id,
        reviewStatus: "draft",
      });
      expect(detail.versions[0]?.reviewStatus).toBe("superseded");

      const identical = await harness.coordinator.captureArtifactVersion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
      });
      expect(identical.detail.versions).toHaveLength(2);
      expect(identical.task.revision).toBe(task.revision);

      const accepted = await harness.coordinator.acceptArtifactVersion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        versionId: second.id,
        expectedRevision: task.revision,
      });
      task = accepted.task;
      expect(accepted.detail.acceptedVersionId).toBe(second.id);
      expect(task.workItems.find((item) => item.id === "deliver-report")?.status).toBe("done");

      const restored = await harness.coordinator.restoreArtifactVersion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        versionId: first.id,
        expectedRevision: task.revision,
      });
      expect(restored.version).toMatchObject({
        version: 3,
        parentVersionId: second.id,
        sha256: first.sha256,
        reviewStatus: "draft",
      });
      expect(await fs.readFile(artifactPath, "utf8")).toBe("version one\n");
      expect(restored.detail.acceptedVersionId).toBe(second.id);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("captures a legacy artifact baseline lazily and only once", async () => {
    const harness = await createHarness();
    try {
      const artifactPath = path.join(harness.workspacePath, "legacy.txt");
      await fs.writeFile(artifactPath, "legacy\n");
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Legacy task",
        objective: "Version a legacy artifact.",
        sessionId: "main-session",
      });
      const artifactId = crypto.randomUUID();
      task = await harness.sessionDb.registerTaskArtifact(
        {
          id: artifactId,
          taskId: task.id,
          workItemId: null,
          threadId: task.threads[0]?.id ?? null,
          path: artifactPath,
          kind: "text",
          title: "Legacy file",
          createdBy: "legacy",
          provenance: {},
          createdAt: new Date().toISOString(),
        },
        task.revision,
        new Date().toISOString(),
      );

      const baseline = await harness.coordinator.ensureArtifactBaseline({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId,
        expectedRevision: task.revision,
      });
      expect(baseline.versions).toHaveLength(1);
      expect(baseline.versions[0]?.reviewStatus).toBe("accepted");
      const afterFirst = harness.coordinator.get(task.id, harness.workspacePath);
      if (!afterFirst) throw new Error("Expected task");

      const repeated = await harness.coordinator.ensureArtifactBaseline({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId,
        expectedRevision: afterFirst.revision,
      });
      expect(repeated.versions).toHaveLength(1);
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.revision).toBe(
        afterFirst.revision,
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects path escapes and structured live-file fingerprint conflicts", async () => {
    const harness = await createHarness();
    try {
      const outside = path.join(harness.home, "outside.txt");
      await fs.writeFile(outside, "outside\n");
      const task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Boundaries",
        objective: "Keep artifacts inside the project.",
        sessionId: "main-session",
      });
      await expect(
        harness.coordinator.registerArtifact({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          path: outside,
          title: "Outside",
          kind: "text",
        }),
      ).rejects.toThrow("outside the task workspace");

      const registered = await createTaskWithArtifact(harness);
      const first = registered.detail.versions[0];
      if (!first) throw new Error("Expected initial version");
      await fs.writeFile(registered.artifactPath, "external edit\n");
      let conflict: unknown;
      try {
        await harness.coordinator.restoreArtifactVersion({
          taskId: registered.task.id,
          workspacePath: harness.workspacePath,
          artifactId: registered.artifact.id,
          versionId: first.id,
          expectedRevision: registered.task.revision,
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ArtifactConflictError);
      expect(conflict).toMatchObject({
        code: "artifact_conflict",
        artifactId: registered.artifact.id,
        expectedSha256: first.sha256,
      });
      expect(await fs.readFile(registered.artifactPath, "utf8")).toBe("external edit\n");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("tracks revision threads through review and bulk task acceptance", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, detail, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Delivery ready",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready for review",
      });
      expect(task.status).toBe("awaiting_review");

      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Add a concise conclusion.",
      });
      task = started.task;
      detail = started.detail;
      expect(task.status).toBe("working");
      expect(detail.activeRevision?.id).toBe(started.revision.id);
      expect(task.workItems.find((item) => item.id === started.revision.workItemId)?.status).toBe(
        "in_progress",
      );

      await expect(
        harness.coordinator.registerArtifact({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          sessionId: started.revision.sessionId,
          path: artifactPath,
          title: artifact.title,
          kind: artifact.kind,
          artifactId: artifact.id,
          baseVersionId: crypto.randomUUID(),
        }),
      ).rejects.toThrow("Artifact base version does not match the active revision");

      await fs.writeFile(artifactPath, "version one\n\nConclusion.\n");
      const finalized = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      if (!finalized) throw new Error("Expected finalized revision");
      expect(finalized.revision.status).toBe("completed");
      expect(finalized.task.status).toBe("awaiting_review");
      expect(
        finalized.task.workItems.find((item) => item.id === started.revision.workItemId)?.status,
      ).toBe("review");
      expect(finalized.detail.versions.at(-1)?.reviewStatus).toBe("draft");

      const accepted = await harness.coordinator.acceptTask({
        taskId: finalized.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: finalized.task.revision,
      });
      expect(accepted.status).toBe("completed");
      expect(
        accepted.workItems.find((item) => item.id === started.revision.workItemId)?.status,
      ).toBe("done");
      const acceptedDetail = harness.coordinator.getArtifactDetail({
        taskId: accepted.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
      });
      expect(
        acceptedDetail?.versions.filter((version) => version.reviewStatus === "accepted"),
      ).toHaveLength(1);
      expect(acceptedDetail?.acceptedVersionId).toBe(acceptedDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("accepts no-review delivery versions and completes revision work items", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness, {
        reviewRequired: false,
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Delivery ready",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Delivered without review",
      });
      expect(task.status).toBe("completed");
      let detail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
      });
      expect(detail?.acceptedVersionId).toBe(detail?.latestVersionId);

      task = await harness.coordinator.reopenTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        reason: "Revise the accepted no-review delivery.",
      });

      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Tighten the conclusion.",
      });
      await fs.writeFile(artifactPath, "version one\n\nTighter conclusion.\n");
      const finalized = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      if (!finalized) throw new Error("Expected finalized revision");
      expect(finalized.task.status).toBe("completed");
      expect(
        finalized.task.workItems.find((item) => item.id === started.revision.workItemId)?.status,
      ).toBe("done");
      detail = finalized.detail;
      expect(detail.acceptedVersionId).toBe(detail.latestVersionId);
      expect(detail.versions.filter((version) => version.reviewStatus === "accepted")).toHaveLength(
        1,
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rolls back cancelled revision bytes and preserves durable revision metadata", async () => {
    const harness = await createHarness();
    let closed = false;
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Working",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Review",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Try a different opening.",
      });
      await fs.writeFile(artifactPath, "unwanted edit\n");
      const cancelled = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "cancelled",
      );
      if (!cancelled) throw new Error("Expected cancelled revision");
      expect(cancelled.revision.status).toBe("cancelled");
      expect(cancelled.task.status).toBe("awaiting_review");
      expect(
        cancelled.task.workItems.find((item) => item.id === started.revision.workItemId)?.status,
      ).toBe("abandoned");
      expect(await fs.readFile(artifactPath, "utf8")).toBe("version one\n");

      harness.sessionDb.close();
      closed = true;
      const reopened = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      try {
        expect(reopened.getTaskArtifactRevision(started.revision.id)?.status).toBe("cancelled");
        expect(reopened.getTaskArtifactDetail(task.id, artifact.id)?.versions).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      if (!closed) harness.sessionDb.close();
    }
  });

  for (const terminalStatus of TERMINAL_TASK_STATUSES) {
    test(`closes active artifact revisions safely when the parent task becomes ${terminalStatus}`, async () => {
      const harness = await createHarness();
      try {
        let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
        task = await harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: "working",
          summary: "Working",
        });
        const started = await harness.coordinator.startArtifactRevision({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          expectedRevision: task.revision,
          instruction: "Try a terminal race edit.",
        });
        await fs.writeFile(artifactPath, `late terminal edit for ${terminalStatus}\n`);
        const terminal = await harness.coordinator.transition({
          taskId: started.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: started.task.revision,
          status: terminalStatus,
          summary: `Task became ${terminalStatus}`,
        });
        const closedBeforeOutcome = harness.sessionDb.getTaskArtifactRevision(started.revision.id);
        const detailBeforeOutcome = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });

        expect(closedBeforeOutcome).toMatchObject({
          status: "cancelled",
          completedAt: expect.any(String),
        });
        expect(detailBeforeOutcome?.activeRevision).toBeNull();

        const finalized = await harness.coordinator.handleThreadOutcome(
          started.revision.sessionId,
          terminalStatus === "completed" ? "completed" : "cancelled",
        );
        if (!finalized) throw new Error("Expected terminal revision snapshot");

        expect(finalized.task).toMatchObject({
          status: terminalStatus,
          revision: terminal.revision,
        });
        expect(finalized.revision).toMatchObject({
          id: started.revision.id,
          status: "cancelled",
        });
        expect(finalized.detail.activeRevision).toBeNull();
        expect(finalized.detail.versions).toHaveLength(started.detail.versions.length);
        expect(await fs.readFile(artifactPath, "utf8")).toBe(
          `late terminal edit for ${terminalStatus}\n`,
        );

        await harness.coordinator.handleThreadOutcome(
          started.revision.sessionId,
          "error",
          new Error("late replay"),
        );
        expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
          status: terminalStatus,
          revision: terminal.revision,
        });
        expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
          status: "cancelled",
          completedAt: closedBeforeOutcome?.completedAt,
        });
        expect(await fs.readFile(artifactPath, "utf8")).toBe(
          `late terminal edit for ${terminalStatus}\n`,
        );

        await fs.writeFile(artifactPath, "version one\n");
        let recovered = terminal;
        if (terminalStatus === "failed") {
          harness.coordinator.setContinuationDispatcher(async () => "queued");
          const retried = await harness.coordinator.retryTask({
            taskId: terminal.id,
            workspacePath: harness.workspacePath,
            expectedRevision: terminal.revision,
          });
          expect(retried.retryStatus).toBe("queued");
          recovered = retried.task;
        } else {
          recovered = await harness.coordinator.reopenTask({
            taskId: terminal.id,
            workspacePath: harness.workspacePath,
            expectedRevision: terminal.revision,
            reason: "Continue after terminal revision cleanup.",
          });
        }

        expect(recovered.status).toBe("working");
        const freshRevision = await harness.coordinator.startArtifactRevision({
          taskId: recovered.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          expectedRevision: recovered.revision,
          instruction: "Start a fresh revision after recovery.",
        });
        expect(freshRevision.revision.id).not.toBe(started.revision.id);
        expect(freshRevision.revision.status).toBe("active");
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  for (const terminalStatus of TERMINAL_TASK_STATUSES) {
    test(`rejects stale ${terminalStatus} transition after direct artifact restore wins the queue`, async () => {
      const harness = await createPausingHarness();
      try {
        const { task, artifact, artifactPath, first } =
          await createTaskWithRestorableArtifactVersion(harness);
        const beforeDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });
        if (!beforeDetail) throw new Error("Expected artifact detail before restore");
        const pause = harness.artifactStore.pauseNext("restore", await fs.realpath(artifactPath));

        const restorePromise = harness.coordinator.restoreArtifactVersion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          versionId: first.id,
          expectedRevision: task.revision,
        });
        await pause.reached;

        const terminalPromise = harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: terminalStatus,
          summary: `Task became ${terminalStatus}`,
        });
        await flushAsyncWork();

        expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
          status: "working",
          revision: task.revision,
        });
        expect(harness.artifactStore.restoreCalls).toHaveLength(0);

        pause.release();
        const [restored, terminal] = await Promise.all([
          restorePromise,
          terminalPromise.then(
            (task) => ({ ok: true as const, task }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        ]);

        expect(restored.task.status).toBe("working");
        expect(restored.version.sha256).toBe(first.sha256);
        expect(terminal.ok).toBe(false);
        if (terminal.ok) throw new Error("Stale terminal transition unexpectedly succeeded");
        expect(terminal.error).toBeInstanceOf(Error);
        expect((terminal.error as Error).message).toBe(
          `Task revision conflict: expected ${task.revision}, current ${restored.task.revision}`,
        );
        expect(harness.artifactStore.restoreCalls).toHaveLength(1);
        expect(await fs.readFile(artifactPath, "utf8")).toBe("version one\n");
        expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
          status: "working",
          revision: restored.task.revision,
        });
        expect(restored.detail.versions).toHaveLength(beforeDetail.versions.length + 1);
      } finally {
        harness.sessionDb.close();
      }
    });

    test(`keeps terminal-first direct artifact restore inert after ${terminalStatus}`, async () => {
      const terminalQuiesce = createDeferred<void>();
      const releaseTerminal = createDeferred<void>();
      const harness = await createPausingHarness({
        quiesceTaskThreads: async () => {
          terminalQuiesce.resolve();
          await releaseTerminal.promise;
        },
      });
      try {
        const { task, artifact, artifactPath, first } =
          await createTaskWithRestorableArtifactVersion(harness);

        const terminalPromise = harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: terminalStatus,
          summary: `Task became ${terminalStatus}`,
        });
        await terminalQuiesce.promise;
        expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
          status: terminalStatus,
          revision: task.revision + 1,
        });

        const detailAfterTerminal = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });
        const restorePromise = harness.coordinator.restoreArtifactVersion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          versionId: first.id,
          expectedRevision: task.revision + 1,
        });
        await flushAsyncWork();

        expect(harness.artifactStore.restoreCalls).toHaveLength(0);
        expect(await fs.readFile(artifactPath, "utf8")).toBe("version two\n");

        releaseTerminal.resolve();
        await terminalPromise;
        await expect(restorePromise).rejects.toThrow(`Task ${task.id} is ${terminalStatus}`);

        expect(harness.artifactStore.restoreCalls).toHaveLength(0);
        expect(await fs.readFile(artifactPath, "utf8")).toBe("version two\n");
        expect(
          harness.coordinator.getArtifactDetail({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: artifact.id,
          }),
        ).toEqual(detailAfterTerminal);
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("allows a fresh terminal transition queued behind non-revision-changing artifact work", async () => {
    const quiesced: string[] = [];
    const harness = await createPausingHarness({
      quiesceTaskThreads: (task, reason) => {
        quiesced.push(`${reason}:${task.revision}`);
      },
    });
    try {
      const { task, artifact, artifactPath, detail } = await createTaskWithArtifact(harness);
      const latest = detail.versions.at(-1);
      if (!latest) throw new Error("Expected artifact baseline");
      const pause = harness.artifactStore.pauseNext("capture", await fs.realpath(artifactPath));

      const noChangeCapture = harness.coordinator.captureArtifactVersion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        changeSummary: "No byte change",
      });
      await pause.reached;

      const terminalPromise = harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "cancelled",
        summary: "Fresh queued cancellation",
      });
      await flushAsyncWork();

      expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
        status: "draft",
        revision: task.revision,
      });

      pause.release();
      const [captured, terminal] = await Promise.all([noChangeCapture, terminalPromise]);

      expect(captured.version.id).toBe(latest.id);
      expect(captured.task.revision).toBe(task.revision);
      expect(terminal).toMatchObject({
        status: "cancelled",
        revision: task.revision + 1,
      });
      expect(quiesced).toEqual([`cancelled:${terminal.revision}`]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects stale terminal transition after same-task revision cancellation wins the queue", async () => {
    const harness = await createPausingHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Working",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Try a cancellable edit.",
      });
      await fs.writeFile(artifactPath, "unwanted edit\n");

      const pause = harness.artifactStore.pauseNext("restore", await fs.realpath(artifactPath));
      const outcomePromise = harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "cancelled",
      );
      await pause.reached;

      const terminalPromise = harness.coordinator.transition({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        status: "cancelled",
        summary: "User cancelled task",
      });
      await flushAsyncWork();

      expect(harness.coordinator.get(task.id, harness.workspacePath)?.status).toBe("working");

      pause.release();
      const [outcome, terminal] = await Promise.all([
        outcomePromise,
        terminalPromise.then(
          (task) => ({ ok: true as const, task }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      if (!outcome) throw new Error("Expected cancelled revision outcome");

      expect(outcome.revision.status).toBe("cancelled");
      expect(outcome.task.status).toBe("working");
      expect(terminal.ok).toBe(false);
      if (terminal.ok) throw new Error("Stale terminal transition unexpectedly succeeded");
      expect(terminal.error).toBeInstanceOf(Error);
      expect((terminal.error as Error).message).toBe(
        `Task revision conflict: expected ${started.task.revision}, current ${outcome.task.revision}`,
      );
      expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
        status: outcome.task.status,
        revision: outcome.task.revision,
      });
      expect(await fs.readFile(artifactPath, "utf8")).toBe("version one\n");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects stale terminal transition after same-task revision completion wins the queue", async () => {
    const harness = await createPausingHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Working",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Complete a revised draft.",
      });
      await fs.writeFile(artifactPath, "completed edit\n");

      const pause = harness.artifactStore.pauseNext("capture", await fs.realpath(artifactPath));
      const outcomePromise = harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      await pause.reached;

      const terminalPromise = harness.coordinator.transition({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        status: "failed",
        summary: "Task failed after revision completion",
      });
      await flushAsyncWork();

      expect(harness.coordinator.get(task.id, harness.workspacePath)?.status).toBe("working");

      pause.release();
      const [outcome, terminal] = await Promise.all([
        outcomePromise,
        terminalPromise.then(
          (task) => ({ ok: true as const, task }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      if (!outcome) throw new Error("Expected completed revision outcome");

      expect(outcome.revision.status).toBe("completed");
      expect(outcome.detail.versions.at(-1)?.changeSummary).toBe("Complete a revised draft.");
      expect(terminal.ok).toBe(false);
      if (terminal.ok) throw new Error("Stale terminal transition unexpectedly succeeded");
      expect(terminal.error).toBeInstanceOf(Error);
      expect((terminal.error as Error).message).toBe(
        `Task revision conflict: expected ${started.task.revision}, current ${outcome.task.revision}`,
      );
      expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
        status: outcome.task.status,
        revision: outcome.task.revision,
      });
      expect(await fs.readFile(artifactPath, "utf8")).toBe("completed edit\n");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps terminal-first late revision outcomes inert without restore side effects", async () => {
    const harness = await createPausingHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Working",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Try an edit that loses to terminal transition.",
      });
      await fs.writeFile(artifactPath, "late edit after terminal\n");
      const terminal = await harness.coordinator.transition({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        status: "failed",
        summary: "Task failed",
      });

      const outcome = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "cancelled",
      );
      if (!outcome) throw new Error("Expected closed revision snapshot");

      expect(outcome.task).toMatchObject({ status: "failed", revision: terminal.revision });
      expect(outcome.revision.status).toBe("cancelled");
      expect(harness.artifactStore.restoreCalls).toHaveLength(0);
      expect(await fs.readFile(artifactPath, "utf8")).toBe("late edit after terminal\n");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("does not serialize terminal transitions for unrelated task artifact outcomes", async () => {
    const harness = await createPausingHarness();
    try {
      const first = await createTaskWithArtifact(harness);
      const second = await createTaskWithArtifact(harness, {
        workItemId: "deliver-second-report",
        artifactFilename: "second-report.md",
      });
      first.task = await harness.coordinator.transition({
        taskId: first.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: first.task.revision,
        status: "working",
        summary: "First working",
      });
      second.task = await harness.coordinator.transition({
        taskId: second.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: second.task.revision,
        status: "working",
        summary: "Second working",
      });
      const startedFirst = await harness.coordinator.startArtifactRevision({
        taskId: first.task.id,
        workspacePath: harness.workspacePath,
        artifactId: first.artifact.id,
        expectedRevision: first.task.revision,
        instruction: "Pause first revision cancellation.",
      });
      await fs.writeFile(first.artifactPath, "first unwanted edit\n");

      const pause = harness.artifactStore.pauseNext(
        "restore",
        await fs.realpath(first.artifactPath),
      );
      const outcomePromise = harness.coordinator.handleThreadOutcome(
        startedFirst.revision.sessionId,
        "cancelled",
      );
      await pause.reached;

      const secondTerminal = await harness.coordinator.transition({
        taskId: second.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: second.task.revision,
        status: "cancelled",
        summary: "Second task cancelled independently",
      });
      expect(secondTerminal.status).toBe("cancelled");

      pause.release();
      await outcomePromise;
    } finally {
      harness.sessionDb.close();
    }
  });

  test("releases the task outcome critical section when restore fails", async () => {
    const harness = await createPausingHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Working",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Trigger restore failure.",
      });
      await fs.writeFile(artifactPath, "unwanted edit\n");
      const originalRestore = harness.artifactStore.restoreFile.bind(harness.artifactStore);
      let failedOnce = false;
      harness.artifactStore.restoreFile = async (input) => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("restore exploded");
        }
        return await originalRestore(input);
      };

      await expect(
        harness.coordinator.handleThreadOutcome(started.revision.sessionId, "cancelled"),
      ).rejects.toThrow("restore exploded");

      const terminal = await harness.coordinator.transition({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        status: "cancelled",
        summary: "Task cancellation after restore failure",
      });
      expect(terminal.status).toBe("cancelled");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps parallel revisions working until the final cancellation restores prior status", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          { id: "deliver-report", title: "Deliver report", expectedOutputs: ["report.md"] },
          { id: "deliver-notes", title: "Deliver notes", expectedOutputs: ["notes.md"] },
        ],
      });
      const notesPath = path.join(harness.workspacePath, "notes.md");
      await fs.writeFile(notesPath, "notes version one\n");
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: notesPath,
        title: "Notes",
        kind: "markdown",
        workItemId: "deliver-notes",
      });
      const canonicalNotesPath = await fs.realpath(notesPath);
      const notesArtifact = task.artifacts.find(
        (candidate) => candidate.path === canonicalNotesPath,
      );
      if (!notesArtifact) throw new Error("Expected notes artifact");
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Delivery ready",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Ready for review",
      });

      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Try a report edit.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Try a notes edit.",
      });

      const firstCancelled = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "cancelled",
      );
      if (!firstCancelled) throw new Error("Expected first cancelled revision");
      expect(firstCancelled.task.status).toBe("working");

      const secondCancelled = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!secondCancelled) throw new Error("Expected second cancelled revision");
      expect(secondCancelled.task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("blocks the task and revision work item when a revision thread errors", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Working",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Revise the report.",
      });
      const failed = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "error",
      );
      if (!failed) throw new Error("Expected failed revision");
      expect(failed.task.status).toBe("blocked");
      expect(failed.revision.status).toBe("error");
      expect(
        failed.task.workItems.find((item) => item.id === started.revision.workItemId)?.status,
      ).toBe("blocked");
    } finally {
      harness.sessionDb.close();
    }
  });
});
