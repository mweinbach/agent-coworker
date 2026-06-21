import { Database } from "bun:sqlite";
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

type EarlyPhaseTaskStatus = Extract<TaskStatus, "draft" | "planning">;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type CapturedTaskNotification = {
  method: string;
  params: Record<string, unknown>;
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
  const notifications: CapturedTaskNotification[] = [];
  const coordinator = new TaskCoordinator({
    sessionDb,
    artifactStore,
    notify: (notification) => {
      notifications.push({ method: notification.method, params: notification.params });
    },
  });
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
    notifications,
    getThreadFactoryCalls: () => threadFactoryCalls,
  };
}

function installSettlementFailureTrigger(dbPath: string): () => void {
  const db = new Database(dbPath);
  db.exec("DROP TRIGGER IF EXISTS fail_pending_artifact_revision_settlement");
  db.exec(`
    CREATE TRIGGER fail_pending_artifact_revision_settlement
    BEFORE UPDATE OF settlement_status ON task_artifact_revisions
    WHEN NEW.settlement_status = 'settled'
    BEGIN
      SELECT RAISE(ABORT, 'injected settlement failure');
    END
  `);
  db.close();
  return () => {
    const cleanupDb = new Database(dbPath);
    cleanupDb.exec("DROP TRIGGER IF EXISTS fail_pending_artifact_revision_settlement");
    cleanupDb.close();
  };
}

function taskActivityFingerprint(task: TaskRecord): string[] {
  return task.activity.map((entry) =>
    [
      entry.kind,
      entry.summary,
      entry.detail ?? "",
      entry.workItemId ?? "",
      entry.threadId ?? "",
    ].join("\u0000"),
  );
}

function taskWorkItemFingerprint(task: TaskRecord): string[] {
  return task.workItems.map((item) =>
    [
      item.id,
      item.status,
      item.completionEvidence ?? "",
      item.assignedThreadId ?? "",
      item.claimedByThreadId ?? "",
      item.expectedOutputs.join("\u0000"),
    ].join("\u0001"),
  );
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
  options: {
    reviewRequired?: boolean;
    reviewRounds?: number;
    workItemId?: string;
    artifactFilename?: string;
  } = {},
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
    reviewRounds: options.reviewRounds,
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

async function createTaskWithTwoArtifacts(
  harness: Pick<Awaited<ReturnType<typeof createHarness>>, "workspacePath" | "coordinator">,
  options: {
    reviewRequired?: boolean;
    reviewRounds?: number;
  } = {},
) {
  const reportPath = path.join(harness.workspacePath, "report.md");
  const notesPath = path.join(harness.workspacePath, "notes.md");
  await Promise.all([
    fs.writeFile(reportPath, "report version one\n"),
    fs.writeFile(notesPath, "notes version one\n"),
  ]);
  let task = await harness.coordinator.create({
    workspacePath: harness.workspacePath,
    title: "Parallel artifact review",
    objective: "Produce and review two deliverables.",
    sessionId: `main-session-${crypto.randomUUID()}`,
    reviewRequired: options.reviewRequired,
    reviewRounds: options.reviewRounds,
  });
  task = await harness.coordinator.replaceWorkItems({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    items: [
      {
        id: "deliver-report",
        title: "Deliver report",
        expectedOutputs: ["report.md"],
      },
      {
        id: "deliver-notes",
        title: "Deliver notes",
        expectedOutputs: ["notes.md"],
      },
    ],
  });
  task = await harness.coordinator.registerArtifact({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    path: reportPath,
    title: "Report",
    kind: "markdown",
    workItemId: "deliver-report",
  });
  task = await harness.coordinator.registerArtifact({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    path: notesPath,
    title: "Notes",
    kind: "markdown",
    workItemId: "deliver-notes",
  });
  const canonicalReportPath = await fs.realpath(reportPath);
  const canonicalNotesPath = await fs.realpath(notesPath);
  const reportArtifact = task.artifacts.find((artifact) => artifact.path === canonicalReportPath);
  const notesArtifact = task.artifacts.find((artifact) => artifact.path === canonicalNotesPath);
  if (!reportArtifact || !notesArtifact) throw new Error("Expected registered artifacts");
  return { task, reportArtifact, notesArtifact, reportPath, notesPath };
}

async function startParallelArtifactRevisionsFromEarlyPhase(
  harness: Pick<Awaited<ReturnType<typeof createHarness>>, "workspacePath" | "coordinator">,
  options: {
    priorStatus: EarlyPhaseTaskStatus;
    reviewRequired?: boolean;
    reviewRounds?: number;
    prepareTask?: (
      task: TaskRecord,
      artifacts: Awaited<ReturnType<typeof createTaskWithTwoArtifacts>>,
    ) => Promise<TaskRecord>;
  },
) {
  const artifacts = await createTaskWithTwoArtifacts(harness, {
    reviewRequired: options.reviewRequired,
    reviewRounds: options.reviewRounds,
  });
  let task = artifacts.task;
  task = (await options.prepareTask?.(task, artifacts)) ?? task;
  if (options.priorStatus === "planning") {
    task = await harness.coordinator.transition({
      taskId: task.id,
      workspacePath: harness.workspacePath,
      expectedRevision: task.revision,
      status: "planning",
      summary: "Keep task in planning before artifact revisions.",
    });
  }
  const reportRevision = await harness.coordinator.startArtifactRevision({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifacts.reportArtifact.id,
    expectedRevision: task.revision,
    instruction: "Revise report from early phase.",
  });
  const notesRevision = await harness.coordinator.startArtifactRevision({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifacts.notesArtifact.id,
    expectedRevision: reportRevision.task.revision,
    instruction: "Revise notes from early phase.",
  });
  return { ...artifacts, task: notesRevision.task, reportRevision, notesRevision };
}

function blockingTaskQuestion() {
  return {
    header: "Approval",
    question: "Which approval path should delivery use?",
    context: "The answer changes the final delivered artifacts.",
    blocking: true,
    urgency: "now" as const,
    options: [
      { id: "standard", label: "Standard", description: "Use the standard approval path." },
      { id: "expedite", label: "Expedite", description: "Use the expedited approval path." },
    ],
    recommendedOptionId: "standard",
  };
}

function nonBlockingTaskQuestion() {
  return {
    header: "Packaging",
    question: "Should the final package include an appendix?",
    context: "The default is reversible before final delivery.",
    blocking: false,
    urgency: "before_delivery" as const,
    defaultAction: "Proceed without an appendix.",
    options: [
      { id: "skip", label: "Skip", description: "Proceed without the appendix." },
      { id: "include", label: "Include", description: "Include the appendix." },
    ],
    recommendedOptionId: "skip",
  };
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

  test("keeps artifact revision success from bypassing queued work", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          {
            id: "deliver-report",
            title: "Deliver report",
            expectedOutputs: ["report.md"],
          },
          {
            id: "follow-up",
            title: "Complete follow-up analysis",
            expectedOutputs: ["follow-up.md"],
          },
        ],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Begin work before revision completion.",
      });

      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Add an executive summary.",
      });
      await fs.writeFile(artifactPath, "version one\n\nExecutive summary.\n");

      const finalized = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      if (!finalized) throw new Error("Expected finalized revision");

      expect(finalized.revision.status).toBe("completed");
      expect(finalized.task.status).toBe("working");
      expect(finalized.task.workItems.find((item) => item.id === "follow-up")?.status).toBe(
        "queued",
      );
      expect(
        finalized.task.workItems.find((item) => item.id === started.revision.workItemId)?.status,
      ).toBe("review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps artifact revision success from bypassing fresh independent review gates", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness, {
        reviewRounds: 1,
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Begin work before review-sensitive revision.",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Add review-sensitive conclusions.",
      });
      await fs.writeFile(artifactPath, "version one\n\nReview-sensitive conclusion.\n");

      const finalized = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      if (!finalized) throw new Error("Expected finalized revision");

      expect(finalized.revision.status).toBe("completed");
      expect(finalized.task.status).toBe("working");
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: finalized.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: finalized.task.revision,
          summary: "Ready without a fresh review",
        }),
      ).rejects.toThrow("fresh passing reviews");

      const material = await harness.coordinator.getReviewMaterial({
        taskId: finalized.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: finalized.task.revision,
      });
      const reviewed = await harness.coordinator.recordReview({
        taskId: finalized.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: finalized.task.revision,
        expectedMaterialFingerprint: material.fingerprint,
        reviewerAgentId: "reviewer-1",
        reviewerProvider: "test",
        reviewerModel: "test-model",
        verdict: "pass",
        feedback: "Looks complete.",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: reviewed.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: reviewed.task.revision,
        summary: "Ready after fresh review",
      });
      expect(task.status).toBe("awaiting_review");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps cancelled artifact revisions from restoring review when blockers appear", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness);
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
        instruction: "Try a small revision.",
      });
      task = await harness.coordinator.reportBlocker({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        description: "A new required credential is missing.",
        blocking: true,
      });
      expect(task.status).toBe("blocked");

      const cancelled = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "cancelled",
      );
      if (!cancelled) throw new Error("Expected cancelled revision");
      expect(cancelled.revision.status).toBe("cancelled");
      expect(cancelled.task.status).toBe("blocked");
      expect(cancelled.task.blockers.some((blocker) => blocker.status === "active")).toBe(true);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("preserves active artifact revision state across compatible plan updates", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness);
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Keep this revision alive while the plan is clarified.",
      });
      const revisionItem = started.task.workItems.find(
        (item) => item.id === started.revision.workItemId,
      );
      if (!revisionItem) throw new Error("Expected revision work item");

      task = await harness.coordinator.replaceWorkItems({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        items: [
          {
            id: "deliver-report",
            title: "Deliver report with clarified scope",
            expectedOutputs: ["report.md"],
          },
          {
            id: revisionItem.id,
            title: revisionItem.title,
            description: `${revisionItem.description}\n\nClarified without rekeying.`,
            status: revisionItem.status,
            expectedOutputs: revisionItem.expectedOutputs,
          },
          {
            id: "verification",
            title: "Verify the revised report",
            dependsOn: [revisionItem.id],
            expectedOutputs: [],
          },
        ],
      });

      const preservedRevision = harness.sessionDb.getTaskArtifactRevision(started.revision.id);
      const detail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
      });
      const preservedItem = task.workItems.find((item) => item.id === revisionItem.id);

      expect(preservedRevision).toMatchObject({
        id: started.revision.id,
        status: "active",
        sessionId: started.revision.sessionId,
        workItemId: revisionItem.id,
      });
      expect(detail?.activeRevision?.id).toBe(started.revision.id);
      expect(preservedItem).toMatchObject({
        id: revisionItem.id,
        assignedThreadId: revisionItem.assignedThreadId,
        claimedByThreadId: revisionItem.claimedByThreadId,
        status: "in_progress",
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("preserves coordinator-owned active revision work item fields during plan updates", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness, { reviewRequired: false });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Keep this revision in progress while the main plan shifts.",
      });
      const mainSession = started.task.threads[0]?.sessionId;
      if (!mainSession) throw new Error("Expected main task session");
      const revisionItem = started.task.workItems.find(
        (item) => item.id === started.revision.workItemId,
      );
      if (!revisionItem) throw new Error("Expected revision work item");

      const updated = await harness.coordinator.applyDirective(mainSession, {
        type: "update_plan",
        idempotencyKey: "preserve-active-revision-owned-fields",
        expectedRevision: started.task.revision,
        workItems: [
          {
            id: "deliver-report",
            title: "Deliver report",
            status: "done",
            expectedOutputs: ["report.md"],
          },
          {
            id: ` ${revisionItem.id} `,
            title: "Rewrite active revision helper",
            description: "Caller may clarify text but not execution state.",
            status: "done",
            dependsOn: ["deliver-report"],
            expectedOutputs: [],
          },
        ],
      });
      task = updated.task;

      const preservedItem = task.workItems.find((item) => item.id === revisionItem.id);
      expect(preservedItem).toMatchObject({
        id: revisionItem.id,
        title: "Rewrite active revision helper",
        description: "Caller may clarify text but not execution state.",
        status: "in_progress",
        assignedThreadId: revisionItem.assignedThreadId,
        claimedByThreadId: revisionItem.claimedByThreadId,
        expectedOutputs: revisionItem.expectedOutputs,
        completionEvidence: revisionItem.completionEvidence,
        dependsOn: revisionItem.dependsOn,
      });
      expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
        status: "active",
        workItemId: revisionItem.id,
        sessionId: started.revision.sessionId,
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Should not finish while the revision runtime is still active.",
        }),
      ).rejects.toThrow("unfinished work item");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("normalizes active revision work item ids before direct plan reconciliation", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact } = await createTaskWithArtifact(harness, { reviewRequired: false });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Keep active revision state while the plan is normalized.",
      });
      const revisionItem = started.task.workItems.find(
        (item) => item.id === started.revision.workItemId,
      );
      if (!revisionItem) throw new Error("Expected revision work item");

      task = await harness.coordinator.replaceWorkItems({
        taskId: started.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: started.task.revision,
        items: [
          {
            id: "deliver-report",
            title: "Deliver report",
            status: "done",
            expectedOutputs: ["report.md"],
          },
          {
            id: `\u00a0${revisionItem.id}\u00a0`,
            title: "Normalized active revision helper",
            description: "Caller may change prose but not runtime-owned state.",
            status: "done",
            dependsOn: ["deliver-report"],
            expectedOutputs: [],
          },
        ],
      });

      expect(task.workItems.find((item) => item.id === revisionItem.id)).toMatchObject({
        id: revisionItem.id,
        title: "Normalized active revision helper",
        description: "Caller may change prose but not runtime-owned state.",
        status: "in_progress",
        assignedThreadId: revisionItem.assignedThreadId,
        claimedByThreadId: revisionItem.claimedByThreadId,
        expectedOutputs: revisionItem.expectedOutputs,
        completionEvidence: revisionItem.completionEvidence,
        dependsOn: revisionItem.dependsOn,
      });
      expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
        status: "active",
        workItemId: revisionItem.id,
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Should remain gated by the active revision.",
        }),
      ).rejects.toThrow("unfinished work item");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects normalized active revision work item id collisions atomically", async () => {
    const harness = await createHarness();
    try {
      const { task, artifact } = await createTaskWithArtifact(harness);
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Active revision ids must be unambiguous after normalization.",
      });
      const mainSession = started.task.threads[0]?.sessionId;
      if (!mainSession) throw new Error("Expected main task session");
      const before = harness.coordinator.get(started.task.id, harness.workspacePath);
      if (!before) throw new Error("Expected task before failed directive");

      await expect(
        harness.coordinator.applyDirective(mainSession, {
          type: "update_plan",
          idempotencyKey: "normalized-id-collision",
          expectedRevision: started.task.revision,
          objective: "This objective must roll back with the rejected plan.",
          workItems: [
            {
              id: started.revision.workItemId,
              title: "Active revision helper",
              expectedOutputs: ["report.md"],
            },
            {
              id: ` ${started.revision.workItemId} `,
              title: "Duplicate normalized revision helper",
              expectedOutputs: ["report.md"],
            },
          ],
        }),
      ).rejects.toThrow("Duplicate work item id");

      const after = harness.coordinator.get(started.task.id, harness.workspacePath);
      expect(after).toMatchObject({
        objective: before.objective,
        revision: before.revision,
      });
      expect(after?.workItems).toEqual(before.workItems);
      expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
        status: "active",
        workItemId: started.revision.workItemId,
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects empty-normalized active revision work item removal atomically", async () => {
    const harness = await createHarness();
    try {
      const { task, artifact } = await createTaskWithArtifact(harness);
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Whitespace-only ids must not hide active revision removal.",
      });
      const before = harness.coordinator.get(started.task.id, harness.workspacePath);
      if (!before) throw new Error("Expected task before failed update");

      await expect(
        harness.coordinator.replaceWorkItems({
          taskId: started.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: started.task.revision,
          items: [
            {
              id: "deliver-report",
              title: "Deliver report",
              expectedOutputs: ["report.md"],
            },
            {
              id: "   ",
              title: "Whitespace-only replacement",
              expectedOutputs: ["report.md"],
            },
          ],
        }),
      ).rejects.toThrow("active artifact revision");

      const after = harness.coordinator.get(started.task.id, harness.workspacePath);
      expect(after).toMatchObject({
        revision: before.revision,
        objective: before.objective,
      });
      expect(after?.workItems).toEqual(before.workItems);
      expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
        status: "active",
        workItemId: started.revision.workItemId,
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("normalizes active revision work item ids after coordinator restart", async () => {
    const harness = await createHarness();
    let closed = false;
    try {
      let { task, artifact } = await createTaskWithArtifact(harness, { reviewRequired: false });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Restart before normalizing active revision ids.",
      });
      const revisionItem = started.task.workItems.find(
        (item) => item.id === started.revision.workItemId,
      );
      if (!revisionItem) throw new Error("Expected revision work item");

      harness.sessionDb.close();
      closed = true;
      const reopenedDb = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      const reopenedCoordinator = new TaskCoordinator({
        sessionDb: reopenedDb,
        artifactStore: new ArtifactVersionStore({
          rootDir: path.join(harness.rootDir, "artifacts"),
        }),
      });
      try {
        task = await reopenedCoordinator.replaceWorkItems({
          taskId: started.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: started.task.revision,
          items: [
            {
              id: "deliver-report",
              title: "Deliver report",
              status: "done",
              expectedOutputs: ["report.md"],
            },
            {
              id: `\t${revisionItem.id}\n`,
              title: "Restart-normalized active revision helper",
              status: "done",
              expectedOutputs: [],
            },
          ],
        });

        expect(task.workItems.find((item) => item.id === revisionItem.id)).toMatchObject({
          status: "in_progress",
          assignedThreadId: revisionItem.assignedThreadId,
          claimedByThreadId: revisionItem.claimedByThreadId,
          expectedOutputs: revisionItem.expectedOutputs,
        });
        await expect(
          reopenedCoordinator.proposeCompletion({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            summary: "Still blocked by restarted active revision state.",
          }),
        ).rejects.toThrow("unfinished work item");
      } finally {
        reopenedDb.close();
      }
    } finally {
      if (!closed) harness.sessionDb.close();
    }
  });

  test("rejects active revision work item rekeys atomically during directive plan updates", async () => {
    const harness = await createHarness();
    try {
      const { task, artifact } = await createTaskWithArtifact(harness);
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Active revision must survive a bad plan update.",
      });
      const mainSession = started.task.threads[0]?.sessionId;
      if (!mainSession) throw new Error("Expected main task session");
      const before = harness.coordinator.get(started.task.id, harness.workspacePath);
      if (!before) throw new Error("Expected task before failed directive");

      await expect(
        harness.coordinator.applyDirective(mainSession, {
          type: "update_plan",
          idempotencyKey: "bad-active-revision-rekey",
          expectedRevision: started.task.revision,
          objective: "Silently weaken the plan while rekeying active revision work.",
          requirements: [
            {
              kind: "acceptance_criterion",
              text: "The active revision must not be lost.",
            },
          ],
          workItems: [
            {
              id: "deliver-report",
              title: "Deliver report",
              expectedOutputs: ["report.md"],
            },
            {
              id: "replacement-revision-item",
              title: "Replacement revision item",
              expectedOutputs: ["report.md"],
            },
          ],
        }),
      ).rejects.toThrow("active artifact revision");

      const after = harness.coordinator.get(started.task.id, harness.workspacePath);
      expect(after).toMatchObject({
        objective: before.objective,
        revision: before.revision,
      });
      expect(after?.workItems.map((item) => item.id)).toEqual(
        before.workItems.map((item) => item.id),
      );
      expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
        status: "active",
        workItemId: started.revision.workItemId,
      });
    } finally {
      harness.sessionDb.close();
    }
  });

  test("ordinary abandoned expected-output work still requires a registered artifact", async () => {
    const harness = await createHarness();
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Abandoned delivery",
        objective: "Do not count ordinary abandoned deliverables as produced.",
        sessionId: "main-session-abandoned-output",
        reviewRequired: false,
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          {
            id: "deliver-missing-report",
            title: "Deliver missing report",
            status: "abandoned",
            expectedOutputs: ["missing-report.md"],
          },
        ],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Ready to evaluate abandoned output.",
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Should not complete without the expected artifact.",
        }),
      ).rejects.toThrow("Expected artifact is not registered");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("revision helper outputs must still match the revised artifact path", async () => {
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
        summary: "Start helper output binding check.",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before repurposing the helper.",
      });
      await fs.writeFile(artifactPath, "version two for helper output binding\n");
      const finalized = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      if (!finalized) throw new Error("Expected completed revision");
      expect(finalized.task.status).toBe("completed");

      task = await harness.coordinator.reopenTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: finalized.task.revision,
        reason: "Try to repurpose settled revision evidence.",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: task.workItems.map((item) =>
          item.id === started.revision.workItemId
            ? {
                id: item.id,
                title: item.title,
                status: "done" as const,
                expectedOutputs: ["new-deliverable.md"],
              }
            : {
                id: item.id,
                title: item.title,
                status: item.status,
                expectedOutputs: item.expectedOutputs,
              },
        ),
      });

      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Should not reuse revision evidence for a different output.",
        }),
      ).rejects.toThrow("Expected artifact is not registered");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("restores draft status after cancelling a draft-phase artifact revision", async () => {
    const harness = await createHarness();
    try {
      const { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      expect(task.status).toBe("draft");
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Explore a draft-phase artifact change.",
      });
      expect(started.task.status).toBe("working");

      await fs.writeFile(artifactPath, "draft edit to discard\n");
      const cancelled = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "cancelled",
      );
      if (!cancelled) throw new Error("Expected cancelled revision");

      expect(cancelled.revision.status).toBe("cancelled");
      expect(cancelled.task.status).toBe("draft");
      expect(await fs.readFile(artifactPath, "utf8")).toBe("version one\n");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("restores planning status after cancelling a planning-phase artifact revision", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "planning",
        summary: "Still planning the task",
      });
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Explore a planning-phase artifact change.",
      });
      expect(started.task.status).toBe("working");

      await fs.writeFile(artifactPath, "planning edit to discard\n");
      const cancelled = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "cancelled",
      );
      if (!cancelled) throw new Error("Expected cancelled revision");

      expect(cancelled.revision.status).toBe("cancelled");
      expect(cancelled.task.status).toBe("planning");
      expect(await fs.readFile(artifactPath, "utf8")).toBe("version one\n");
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const scenario of [
    { priorStatus: "draft", outcome: "cancelled" },
    { priorStatus: "planning", outcome: "completed" },
  ] as const) {
    test(`keeps ${scenario.priorStatus}-phase revisions blocked when blockers appear before ${scenario.outcome}`, async () => {
      const harness = await createHarness();
      try {
        let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
        if (scenario.priorStatus === "planning") {
          task = await harness.coordinator.transition({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            expectedRevision: task.revision,
            status: "planning",
            summary: "Still planning the task",
          });
        }
        const started = await harness.coordinator.startArtifactRevision({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
          expectedRevision: task.revision,
          instruction: "Settle after a blocker appears.",
        });
        expect(started.task.status).toBe("working");
        task = await harness.coordinator.reportBlocker({
          taskId: started.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: started.task.revision,
          description: "A new blocking dependency appeared.",
          blocking: true,
        });
        expect(task.status).toBe("blocked");

        await fs.writeFile(artifactPath, "early phase edit\n");
        const settled = await harness.coordinator.handleThreadOutcome(
          started.revision.sessionId,
          scenario.outcome,
        );
        if (!settled) throw new Error("Expected settled revision");

        expect(settled.revision.status).toBe(scenario.outcome);
        expect(settled.task.status).toBe("blocked");
        expect(settled.task.blockers.some((blocker) => blocker.status === "active")).toBe(true);
        expect(await fs.readFile(artifactPath, "utf8")).toBe(
          scenario.outcome === "cancelled" ? "version one\n" : "early phase edit\n",
        );
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("restores blocked status before completion proposal failures can strand a task working", async () => {
    const harness = await createHarness();
    try {
      let { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start before blocking.",
      });
      task = await harness.coordinator.reportBlocker({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        description: "Blocked before starting the revision.",
        blocking: true,
      });
      expect(task.status).toBe("blocked");

      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Complete while the blocker is still active.",
      });
      expect(started.task.status).toBe("working");

      await fs.writeFile(artifactPath, "version one\n\nCompleted while blocked.\n");
      const completed = await harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      if (!completed) throw new Error("Expected completed revision");

      expect(completed.revision.status).toBe("completed");
      expect(completed.task.status).toBe("blocked");
      expect(completed.task.blockers.some((blocker) => blocker.status === "active")).toBe(true);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects concurrent destructive plan updates during artifact revision outcomes", async () => {
    const harness = await createPausingHarness();
    try {
      const { task, artifact, artifactPath } = await createTaskWithArtifact(harness);
      const started = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: artifact.id,
        expectedRevision: task.revision,
        instruction: "Complete while a plan update queues behind it.",
      });
      await fs.writeFile(artifactPath, "version one\n\nConcurrent revision.\n");
      const mainSession = started.task.threads[0]?.sessionId;
      if (!mainSession) throw new Error("Expected main task session");

      const pause = harness.artifactStore.pauseNext("capture", await fs.realpath(artifactPath));
      const outcomePromise = harness.coordinator.handleThreadOutcome(
        started.revision.sessionId,
        "completed",
      );
      await pause.reached;

      const planPromise = harness.coordinator.applyDirective(mainSession, {
        type: "update_plan",
        idempotencyKey: "concurrent-plan-update",
        expectedRevision: started.task.revision,
        objective: "This stale objective must not persist.",
        workItems: [
          {
            id: "deliver-report",
            title: "Deliver report after stale plan update",
            expectedOutputs: ["report.md"],
          },
        ],
      });
      await flushAsyncWork();

      expect(harness.coordinator.get(task.id, harness.workspacePath)).toMatchObject({
        objective: started.task.objective,
        revision: started.task.revision,
      });

      pause.release();
      const [outcome, plan] = await Promise.all([
        outcomePromise,
        planPromise.then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      if (!outcome) throw new Error("Expected completed revision outcome");

      expect(outcome.revision.status).toBe("completed");
      expect(plan.ok).toBe(false);
      if (plan.ok) throw new Error("Stale plan update unexpectedly succeeded");
      expect(plan.error).toBeInstanceOf(Error);
      expect((plan.error as Error).message).toContain("Task revision conflict");

      const current = harness.coordinator.get(task.id, harness.workspacePath);
      expect(current).toMatchObject({
        objective: started.task.objective,
        revision: outcome.task.revision,
      });
      expect(
        current?.workItems.find((item) => item.id === started.revision.workItemId),
      ).toMatchObject({
        status: "review",
        completionEvidence: started.revision.instruction,
      });
      expect(harness.sessionDb.getTaskArtifactRevision(started.revision.id)).toMatchObject({
        status: "completed",
        workItemId: started.revision.workItemId,
      });
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
          status: "working",
          revision: task.revision,
        });

        const detailWhileTerminalPending = harness.coordinator.getArtifactDetail({
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
        ).toEqual(detailWhileTerminalPending);
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
      expect(quiesced).toEqual([`cancelled:${task.revision}`]);
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

  test("settles a deferred completed revision when the final sibling revision cancels", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Delivery ready.",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Delivered without review.",
      });
      expect(task.status).toBe("completed");
      task = await harness.coordinator.reopenTask({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        reason: "Revise both artifacts concurrently.",
      });

      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Add the report appendix.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Try an alternate notes framing.",
      });

      await fs.writeFile(reportPath, "report version two\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.revision.status).toBe("completed");
      expect(firstClosed.task.status).toBe("working");
      let reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");

      await fs.writeFile(notesPath, "notes version two to discard\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.revision.status).toBe("cancelled");
      expect(lastClosed.task.status).toBe("completed");
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(false);
      expect(
        lastClosed.task.workItems.find((item) => item.id === reportRevision.revision.workItemId)
          ?.status,
      ).toBe("done");
      expect(
        lastClosed.task.workItems.find((item) => item.id === notesRevision.revision.workItemId)
          ?.status,
      ).toBe("abandoned");
      reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("accepted");
      expect(await fs.readFile(notesPath, "utf8")).toBe("notes version one\n");

      const replay = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!replay) throw new Error("Expected idempotent replay result");
      expect(replay.task.status).toBe("completed");
      expect(replay.revision.status).toBe("cancelled");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("settles deferred completed revisions when the final sibling revision succeeds", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start parallel delivery revisions.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise the report.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Revise the notes.",
      });

      await fs.writeFile(reportPath, "report version two\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "completed",
      );
      if (!lastClosed) throw new Error("Expected completed notes revision");
      expect(lastClosed.task.status).toBe("completed");
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(false);
      for (const revision of [reportRevision.revision, notesRevision.revision]) {
        expect(
          lastClosed.task.workItems.find((item) => item.id === revision.workItemId)?.status,
        ).toBe("done");
      }
      for (const artifact of [reportArtifact, notesArtifact]) {
        const detail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: artifact.id,
        });
        expect(detail?.acceptedVersionId).toBe(detail?.latestVersionId);
        expect(detail?.versions.at(-1)?.reviewStatus).toBe("accepted");
      }
    } finally {
      harness.sessionDb.close();
    }
  });

  for (const scenario of [
    {
      priorStatus: "draft",
      completedCloses: "first",
      finalOutcome: "cancelled",
      name: "completed sibling first, cancelled sibling last",
    },
    {
      priorStatus: "draft",
      completedCloses: "last",
      finalOutcome: "completed",
      name: "cancelled sibling first, completed sibling last",
    },
    {
      priorStatus: "draft",
      completedCloses: "first",
      finalOutcome: "completed",
      name: "completed sibling first, completed sibling last",
    },
    {
      priorStatus: "planning",
      completedCloses: "first",
      finalOutcome: "cancelled",
      name: "completed sibling first, cancelled sibling last",
    },
    {
      priorStatus: "planning",
      completedCloses: "last",
      finalOutcome: "completed",
      name: "cancelled sibling first, completed sibling last",
    },
    {
      priorStatus: "planning",
      completedCloses: "first",
      finalOutcome: "completed",
      name: "completed sibling first, completed sibling last",
    },
  ] as const) {
    test(`settles ${scenario.priorStatus}-phase deferred revisions through no-review gates: ${scenario.name}`, async () => {
      const harness = await createHarness();
      try {
        const {
          task,
          reportArtifact,
          notesArtifact,
          reportPath,
          notesPath,
          reportRevision,
          notesRevision,
        } = await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: scenario.priorStatus,
          reviewRequired: false,
        });
        expect(task.status).toBe("working");

        let lastClosed: Awaited<ReturnType<TaskCoordinator["handleThreadOutcome"]>>;
        if (scenario.completedCloses === "first") {
          await fs.writeFile(reportPath, "report version two from early phase\n");
          const firstClosed = await harness.coordinator.handleThreadOutcome(
            reportRevision.revision.sessionId,
            "completed",
          );
          if (!firstClosed) throw new Error("Expected completed report revision");
          expect(firstClosed.task.status).toBe("working");
          const reportDetailAfterFirst = harness.coordinator.getArtifactDetail({
            taskId: task.id,
            workspacePath: harness.workspacePath,
            artifactId: reportArtifact.id,
          });
          expect(reportDetailAfterFirst?.versions.at(-1)?.reviewStatus).toBe("draft");

          await fs.writeFile(notesPath, "notes version two from early phase\n");
          lastClosed = await harness.coordinator.handleThreadOutcome(
            notesRevision.revision.sessionId,
            scenario.finalOutcome,
          );
        } else {
          await fs.writeFile(notesPath, "notes version two to discard before report completes\n");
          const firstClosed = await harness.coordinator.handleThreadOutcome(
            notesRevision.revision.sessionId,
            "cancelled",
          );
          if (!firstClosed) throw new Error("Expected cancelled notes revision");
          expect(firstClosed.task.status).toBe("working");
          expect(await fs.readFile(notesPath, "utf8")).toBe("notes version one\n");

          await fs.writeFile(reportPath, "report version two from early phase\n");
          lastClosed = await harness.coordinator.handleThreadOutcome(
            reportRevision.revision.sessionId,
            "completed",
          );
        }
        if (!lastClosed) throw new Error("Expected final artifact revision outcome");

        expect(lastClosed.revision.status).toBe(scenario.finalOutcome);
        expect(lastClosed.task.status).toBe("completed");
        const reportDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        const notesDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: notesArtifact.id,
        });
        expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
        expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("accepted");
        expect(notesDetail?.acceptedVersionId).toBe(notesDetail?.latestVersionId);
        expect(notesDetail?.versions.at(-1)?.reviewStatus).toBe("accepted");
        expect(await fs.readFile(reportPath, "utf8")).toBe("report version two from early phase\n");
        expect(await fs.readFile(notesPath, "utf8")).toBe(
          scenario.completedCloses === "first" && scenario.finalOutcome === "completed"
            ? "notes version two from early phase\n"
            : "notes version one\n",
        );
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  for (const priorStatus of ["draft", "planning"] as const) {
    test(`settles ${priorStatus}-phase deferred revisions to awaiting review when review is required`, async () => {
      const harness = await createHarness();
      try {
        const { task, reportArtifact, reportPath, notesPath, reportRevision, notesRevision } =
          await startParallelArtifactRevisionsFromEarlyPhase(harness, {
            priorStatus,
            reviewRequired: true,
            reviewRounds: 0,
          });

        await fs.writeFile(reportPath, "report version two awaiting review from early phase\n");
        const firstClosed = await harness.coordinator.handleThreadOutcome(
          reportRevision.revision.sessionId,
          "completed",
        );
        if (!firstClosed) throw new Error("Expected completed report revision");
        expect(firstClosed.task.status).toBe("working");

        await fs.writeFile(notesPath, "notes version two to discard before review\n");
        const lastClosed = await harness.coordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!lastClosed) throw new Error("Expected cancelled notes revision");
        expect(lastClosed.task.status).toBe("awaiting_review");
        const reportDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
        expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
      } finally {
        harness.sessionDb.close();
      }
    });
  }

  test("restores planning when deferred settlement still needs fresh review evidence", async () => {
    const harness = await createHarness();
    try {
      const { task, reportArtifact, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "planning",
          reviewRounds: 1,
        });

      await fs.writeFile(reportPath, "report version two before required review\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard before required review\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("planning");
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: lastClosed.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: lastClosed.task.revision,
          summary: "Cannot complete with stale review.",
        }),
      ).rejects.toThrow("fresh passing reviews");
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("restores draft without accepting deferred revisions when queued work blocks settlement", async () => {
    const harness = await createHarness();
    try {
      const { task, reportArtifact, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "draft",
          reviewRequired: false,
          prepareTask: async (task) =>
            await harness.coordinator.replaceWorkItems({
              taskId: task.id,
              workspacePath: harness.workspacePath,
              expectedRevision: task.revision,
              items: [
                { id: "deliver-report", title: "Deliver report", expectedOutputs: ["report.md"] },
                { id: "deliver-notes", title: "Deliver notes", expectedOutputs: ["notes.md"] },
                { id: "follow-up", title: "Follow up", expectedOutputs: [] },
              ],
            }),
        });

      await fs.writeFile(reportPath, "report version two with queued work\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard with queued work\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("draft");
      expect(lastClosed.task.workItems.find((item) => item.id === "follow-up")?.status).toBe(
        "queued",
      );
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
      expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("restores planning without accepting deferred revisions when required artifact evidence is missing", async () => {
    const harness = await createHarness();
    try {
      const { task, reportArtifact, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "planning",
          reviewRequired: false,
          prepareTask: async (task) =>
            await harness.coordinator.replaceWorkItems({
              taskId: task.id,
              workspacePath: harness.workspacePath,
              expectedRevision: task.revision,
              items: [
                { id: "deliver-report", title: "Deliver report", expectedOutputs: ["report.md"] },
                { id: "deliver-notes", title: "Deliver notes", expectedOutputs: ["notes.md"] },
                {
                  id: "deliver-summary",
                  title: "Deliver summary",
                  status: "done",
                  expectedOutputs: ["summary.md"],
                  completionEvidence: "Summary was claimed complete.",
                },
              ],
            }),
        });

      await fs.writeFile(reportPath, "report version two without summary artifact\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard without summary artifact\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("planning");
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
      expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps blockers and blocking questions ahead of early-phase deferred settlement", async () => {
    const harness = await createHarness();
    try {
      const { task, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "draft",
          reviewRequired: false,
        });

      await fs.writeFile(reportPath, "report version two before blocking question\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: firstClosed.task.revision,
        sessionId: notesRevision.revision.sessionId,
        questions: [blockingTaskQuestion()],
      });
      expect(requested.task.status).toBe("blocked");

      await fs.writeFile(notesPath, "notes version two to discard while blocked\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("blocked");
      expect(
        lastClosed.task.questions.some(
          (question) => question.status === "pending" && question.blocking,
        ),
      ).toBe(true);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps terminal early-phase deferred callbacks inert after task cancellation", async () => {
    const harness = await createHarness();
    try {
      const { task, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "planning",
          reviewRequired: false,
        });

      await fs.writeFile(reportPath, "report version two before terminal cancellation\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      const terminal = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: firstClosed.task.revision,
        status: "cancelled",
        summary: "User cancelled the task while sibling revision remained active.",
      });
      expect(terminal.status).toBe("cancelled");

      await fs.writeFile(notesPath, "late notes edit after terminal cancellation\n");
      const late = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!late) throw new Error("Expected late cancelled revision callback");
      expect(late.task.status).toBe("cancelled");
      expect(late.task.revision).toBe(terminal.revision);
      expect(await fs.readFile(notesPath, "utf8")).toBe(
        "late notes edit after terminal cancellation\n",
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("settles early-phase deferred revisions after restart and replays idempotently", async () => {
    const harness = await createHarness();
    let closed = false;
    try {
      const { task, reportArtifact, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "planning",
          reviewRequired: false,
        });

      await fs.writeFile(reportPath, "report version two before early-phase restart\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");
      await fs.writeFile(notesPath, "notes version two to discard after restart\n");

      harness.sessionDb.close();
      closed = true;
      const reopenedDb = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      const reopenedCoordinator = new TaskCoordinator({
        sessionDb: reopenedDb,
        artifactStore: new ArtifactVersionStore({
          rootDir: path.join(harness.rootDir, "artifacts"),
        }),
      });
      try {
        const lastClosed = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!lastClosed) throw new Error("Expected cancelled notes revision");
        expect(lastClosed.task.status).toBe("completed");
        const replay = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!replay) throw new Error("Expected idempotent replay");
        expect(replay.task.status).toBe("completed");
        expect(replay.task.revision).toBe(lastClosed.task.revision);
        const reportDetail = reopenedCoordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
      } finally {
        reopenedDb.close();
      }
    } finally {
      if (!closed) harness.sessionDb.close();
    }
  });

  test("serializes concurrent early-phase last-close settlement against stale completion", async () => {
    const harness = await createPausingHarness();
    try {
      const { task, reportPath, notesPath, reportRevision, notesRevision } =
        await startParallelArtifactRevisionsFromEarlyPhase(harness, {
          priorStatus: "draft",
          reviewRequired: false,
        });

      await fs.writeFile(reportPath, "report version two before concurrent final close\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard during final close\n");
      const pause = harness.artifactStore.pauseNext("restore", await fs.realpath(notesPath));
      const finalClosePromise = harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      await pause.reached;

      const staleCompletionPromise = harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: firstClosed.task.revision,
        summary: "Stale completion raced with final revision close.",
      });
      await flushAsyncWork();
      expect(harness.coordinator.get(task.id, harness.workspacePath)?.status).toBe("working");

      pause.release();
      const [finalClose, staleCompletion] = await Promise.all([
        finalClosePromise,
        staleCompletionPromise.then(
          (task) => ({ ok: true as const, task }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      if (!finalClose) throw new Error("Expected final cancelled revision");
      expect(finalClose.task.status).toBe("completed");
      expect(staleCompletion.ok).toBe(false);
      if (staleCompletion.ok) throw new Error("Stale completion unexpectedly succeeded");
      expect(staleCompletion.error).toBeInstanceOf(Error);
      expect((staleCompletion.error as Error).message).toBe(
        `Task revision conflict: expected ${firstClosed.task.revision}, current ${finalClose.task.revision}`,
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps deferred completed revisions working when fresh review gates are unmet", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRounds: 1 });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start review-gated parallel revisions.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise the review-gated report.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Try notes changes for the review-gated task.",
      });

      await fs.writeFile(reportPath, "report version two needing review\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("working");
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: lastClosed.task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: lastClosed.task.revision,
          summary: "Cannot complete without a fresh review.",
        }),
      ).rejects.toThrow("fresh passing reviews");
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("settles deferred completed revisions to awaiting review when task review is required", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: true, reviewRounds: 0 });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start review-required parallel revisions.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise the review-required report.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Try notes changes for the review-required task.",
      });

      await fs.writeFile(reportPath, "report version two awaiting review\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("awaiting_review");
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(false);
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
      expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rolls back no-review deferred settlement when consuming pending rows fails", async () => {
    const harness = await createHarness();
    let closed = false;
    let cleanupTrigger: (() => void) | null = null;
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start atomic no-review settlement.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before injected settlement failure.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Cancel notes after injected settlement failure.",
      });

      await fs.writeFile(reportPath, "report version two before injected failure\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(true);
      const preAttemptTask = firstClosed.task;
      const preAttemptReportRevision = harness.sessionDb.getTaskArtifactRevision(
        reportRevision.revision.id,
      );
      const preAttemptNotesRevision = harness.sessionDb.getTaskArtifactRevision(
        notesRevision.revision.id,
      );
      const preAttemptReportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      const preAttemptActivity = taskActivityFingerprint(preAttemptTask);
      const preAttemptWorkItems = taskWorkItemFingerprint(preAttemptTask);
      const preAttemptReviews = harness.sessionDb.listTaskReviews(task.id);
      const preAttemptNotifications = harness.notifications.length;

      cleanupTrigger = installSettlementFailureTrigger(harness.sessionDb.dbPath);
      await fs.writeFile(notesPath, "notes version two to discard during injected failure\n");
      await expect(
        harness.coordinator.handleThreadOutcome(notesRevision.revision.sessionId, "cancelled"),
      ).rejects.toThrow("injected settlement failure");

      expect(harness.notifications).toHaveLength(preAttemptNotifications);
      let afterFailureTask = harness.sessionDb.getTask(task.id);
      expect(afterFailureTask).not.toBeNull();
      if (!afterFailureTask) throw new Error("Expected task after failed settlement");
      expect(afterFailureTask.status).toBe(preAttemptTask.status);
      expect(afterFailureTask.revision).toBe(preAttemptTask.revision);
      expect(taskWorkItemFingerprint(afterFailureTask)).toEqual(preAttemptWorkItems);
      expect(taskActivityFingerprint(afterFailureTask)).toEqual(preAttemptActivity);
      expect(harness.sessionDb.listTaskReviews(task.id)).toEqual(preAttemptReviews);
      expect(harness.sessionDb.getTaskArtifactRevision(reportRevision.revision.id)).toEqual(
        preAttemptReportRevision,
      );
      expect(harness.sessionDb.getTaskArtifactRevision(notesRevision.revision.id)).toEqual(
        preAttemptNotesRevision,
      );
      let reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.acceptedVersionId).toBe(preAttemptReportDetail?.acceptedVersionId);
      expect(reportDetail?.latestVersionId).toBe(preAttemptReportDetail?.latestVersionId);
      expect(reportDetail?.versions).toEqual(preAttemptReportDetail?.versions);
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(true);

      harness.sessionDb.close();
      closed = true;
      const reopenedNotifications: CapturedTaskNotification[] = [];
      const reopenedDb = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      const reopenedCoordinator = new TaskCoordinator({
        sessionDb: reopenedDb,
        artifactStore: new ArtifactVersionStore({
          rootDir: path.join(harness.rootDir, "artifacts"),
        }),
        notify: (notification) => {
          reopenedNotifications.push({
            method: notification.method,
            params: notification.params,
          });
        },
      });
      try {
        afterFailureTask = reopenedDb.getTask(task.id);
        expect(afterFailureTask).not.toBeNull();
        if (!afterFailureTask) throw new Error("Expected task after restart");
        expect(afterFailureTask.status).toBe(preAttemptTask.status);
        expect(afterFailureTask.revision).toBe(preAttemptTask.revision);
        expect(taskWorkItemFingerprint(afterFailureTask)).toEqual(preAttemptWorkItems);
        expect(taskActivityFingerprint(afterFailureTask)).toEqual(preAttemptActivity);
        expect(reopenedDb.listTaskReviews(task.id)).toEqual(preAttemptReviews);
        expect(reopenedDb.getTaskArtifactRevision(notesRevision.revision.id)).toEqual(
          preAttemptNotesRevision,
        );
        expect(reopenedDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(true);

        cleanupTrigger();
        cleanupTrigger = null;
        const retried = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!retried) throw new Error("Expected retry settlement");
        expect(retried.task.status).toBe("completed");
        expect(reopenedDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(false);
        reportDetail = reopenedCoordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
        expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("accepted");
        const afterRetryActivity = taskActivityFingerprint(retried.task);
        const afterRetryNotifications = [...reopenedNotifications];

        const replay = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!replay) throw new Error("Expected idempotent retry replay");
        expect(replay.task.revision).toBe(retried.task.revision);
        expect(taskActivityFingerprint(replay.task)).toEqual(afterRetryActivity);
        expect(reopenedNotifications).toEqual(afterRetryNotifications);
      } finally {
        reopenedDb.close();
      }
    } finally {
      cleanupTrigger?.();
      if (!closed) harness.sessionDb.close();
    }
  });

  test("rolls back review-required deferred settlement when consuming pending rows fails", async () => {
    const harness = await createHarness();
    let closed = false;
    let cleanupTrigger: (() => void) | null = null;
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: true, reviewRounds: 0 });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start atomic review-required settlement.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before review-required settlement failure.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Cancel notes after review-required settlement failure.",
      });

      await fs.writeFile(reportPath, "report version two awaiting atomic review\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      const preAttemptTask = firstClosed.task;
      const preAttemptReportRevision = harness.sessionDb.getTaskArtifactRevision(
        reportRevision.revision.id,
      );
      const preAttemptNotesRevision = harness.sessionDb.getTaskArtifactRevision(
        notesRevision.revision.id,
      );
      const preAttemptReportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      const preAttemptActivity = taskActivityFingerprint(preAttemptTask);
      const preAttemptWorkItems = taskWorkItemFingerprint(preAttemptTask);
      const preAttemptReviews = harness.sessionDb.listTaskReviews(task.id);
      const preAttemptNotifications = harness.notifications.length;

      cleanupTrigger = installSettlementFailureTrigger(harness.sessionDb.dbPath);
      await fs.writeFile(notesPath, "notes version two to discard before atomic review\n");
      await expect(
        harness.coordinator.handleThreadOutcome(notesRevision.revision.sessionId, "cancelled"),
      ).rejects.toThrow("injected settlement failure");

      expect(harness.notifications).toHaveLength(preAttemptNotifications);
      let afterFailureTask = harness.sessionDb.getTask(task.id);
      expect(afterFailureTask).not.toBeNull();
      if (!afterFailureTask) throw new Error("Expected task after failed review settlement");
      expect(afterFailureTask.status).toBe(preAttemptTask.status);
      expect(afterFailureTask.revision).toBe(preAttemptTask.revision);
      expect(taskWorkItemFingerprint(afterFailureTask)).toEqual(preAttemptWorkItems);
      expect(taskActivityFingerprint(afterFailureTask)).toEqual(preAttemptActivity);
      expect(harness.sessionDb.listTaskReviews(task.id)).toEqual(preAttemptReviews);
      expect(harness.sessionDb.getTaskArtifactRevision(reportRevision.revision.id)).toEqual(
        preAttemptReportRevision,
      );
      expect(harness.sessionDb.getTaskArtifactRevision(notesRevision.revision.id)).toEqual(
        preAttemptNotesRevision,
      );
      let reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.acceptedVersionId).toBe(preAttemptReportDetail?.acceptedVersionId);
      expect(reportDetail?.latestVersionId).toBe(preAttemptReportDetail?.latestVersionId);
      expect(reportDetail?.versions).toEqual(preAttemptReportDetail?.versions);
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(true);

      harness.sessionDb.close();
      closed = true;
      const reopenedNotifications: CapturedTaskNotification[] = [];
      const reopenedDb = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      const reopenedCoordinator = new TaskCoordinator({
        sessionDb: reopenedDb,
        artifactStore: new ArtifactVersionStore({
          rootDir: path.join(harness.rootDir, "artifacts"),
        }),
        notify: (notification) => {
          reopenedNotifications.push({
            method: notification.method,
            params: notification.params,
          });
        },
      });
      try {
        afterFailureTask = reopenedDb.getTask(task.id);
        expect(afterFailureTask).not.toBeNull();
        if (!afterFailureTask) throw new Error("Expected task after review restart");
        expect(afterFailureTask.status).toBe(preAttemptTask.status);
        expect(afterFailureTask.revision).toBe(preAttemptTask.revision);
        expect(taskWorkItemFingerprint(afterFailureTask)).toEqual(preAttemptWorkItems);
        expect(taskActivityFingerprint(afterFailureTask)).toEqual(preAttemptActivity);
        expect(reopenedDb.listTaskReviews(task.id)).toEqual(preAttemptReviews);
        expect(reopenedDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(true);

        cleanupTrigger();
        cleanupTrigger = null;
        const retried = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!retried) throw new Error("Expected review-required retry settlement");
        expect(retried.task.status).toBe("awaiting_review");
        expect(reopenedDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(false);
        reportDetail = reopenedCoordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
        expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
        const afterRetryActivity = taskActivityFingerprint(retried.task);
        const afterRetryNotifications = [...reopenedNotifications];

        const replay = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!replay) throw new Error("Expected review retry replay");
        expect(replay.task.revision).toBe(retried.task.revision);
        expect(taskActivityFingerprint(replay.task)).toEqual(afterRetryActivity);
        expect(reopenedNotifications).toEqual(afterRetryNotifications);
      } finally {
        reopenedDb.close();
      }
    } finally {
      cleanupTrigger?.();
      if (!closed) harness.sessionDb.close();
    }
  });

  for (const scenario of [
    { label: "no-review", reviewRequired: false },
    { label: "review-required", reviewRequired: true },
  ] as const) {
    test(`restores final completed artifact after ${scenario.label} atomic settlement failure`, async () => {
      const harness = await createHarness();
      let cleanupTrigger: (() => void) | null = null;
      try {
        const createOptions = scenario.reviewRequired
          ? { reviewRequired: true, reviewRounds: 0 }
          : { reviewRequired: false };
        let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
          await createTaskWithTwoArtifacts(harness, createOptions);
        task = await harness.coordinator.transition({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          status: "working",
          summary: "Start atomic completed settlement failure.",
        });
        const reportRevision = await harness.coordinator.startArtifactRevision({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
          expectedRevision: task.revision,
          instruction: "Revise report before final sibling completes.",
        });
        const notesRevision = await harness.coordinator.startArtifactRevision({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: notesArtifact.id,
          expectedRevision: reportRevision.task.revision,
          instruction: "Complete notes after injected settlement failure.",
        });

        await fs.writeFile(reportPath, "report version two before completed sibling failure\n");
        const firstClosed = await harness.coordinator.handleThreadOutcome(
          reportRevision.revision.sessionId,
          "completed",
        );
        if (!firstClosed) throw new Error("Expected completed report revision");
        expect(firstClosed.task.status).toBe("working");
        expect(
          harness.sessionDb.hasPendingTaskArtifactRevisionSettlementForWorkItem(
            task.id,
            reportRevision.revision.workItemId,
          ),
        ).toBe(true);

        const preAttemptNotesContent = await fs.readFile(notesPath, "utf8");
        const preAttemptNotesDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: notesArtifact.id,
        });
        const preAttemptReportDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });

        cleanupTrigger = installSettlementFailureTrigger(harness.sessionDb.dbPath);
        await fs.writeFile(notesPath, "notes version two should not survive atomic failure\n");
        await expect(
          harness.coordinator.handleThreadOutcome(notesRevision.revision.sessionId, "completed"),
        ).rejects.toThrow("injected settlement failure");

        expect(await fs.readFile(notesPath, "utf8")).toBe(preAttemptNotesContent);
        const afterFailureTask = harness.sessionDb.getTask(task.id);
        expect(afterFailureTask).not.toBeNull();
        if (!afterFailureTask) throw new Error("Expected task after failed completed settlement");
        expect(afterFailureTask.status).toBe("blocked");
        const afterFailureNotesRevision = harness.sessionDb.getTaskArtifactRevision(
          notesRevision.revision.id,
        );
        expect(afterFailureNotesRevision?.status).toBe("error");
        const afterFailureNotesDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: notesArtifact.id,
        });
        const afterFailureReportDetail = harness.coordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(afterFailureNotesDetail?.latestVersionId).toBe(
          preAttemptNotesDetail?.latestVersionId,
        );
        expect(afterFailureNotesDetail?.acceptedVersionId).toBe(
          preAttemptNotesDetail?.acceptedVersionId,
        );
        expect(afterFailureNotesDetail?.versions).toEqual(preAttemptNotesDetail?.versions);
        expect(afterFailureReportDetail?.latestVersionId).toBe(
          preAttemptReportDetail?.latestVersionId,
        );
        expect(afterFailureReportDetail?.acceptedVersionId).toBe(
          preAttemptReportDetail?.acceptedVersionId,
        );
        expect(
          harness.sessionDb.hasPendingTaskArtifactRevisionSettlementForWorkItem(
            task.id,
            reportRevision.revision.workItemId,
          ),
        ).toBe(true);
        expect(
          harness.sessionDb.hasPendingTaskArtifactRevisionSettlementForWorkItem(
            task.id,
            notesRevision.revision.workItemId,
          ),
        ).toBe(false);
      } finally {
        cleanupTrigger?.();
        harness.sessionDb.close();
      }
    });
  }

  test("keeps deferred completed revisions working when queued work remains", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          { id: "deliver-report", title: "Deliver report", expectedOutputs: ["report.md"] },
          { id: "deliver-notes", title: "Deliver notes", expectedOutputs: ["notes.md"] },
          { id: "follow-up", title: "Follow up", expectedOutputs: [] },
        ],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start parallel revisions before follow-up is complete.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report while follow-up is queued.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Try notes while follow-up is queued.",
      });

      await fs.writeFile(reportPath, "report version two with queued follow-up\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");

      await fs.writeFile(notesPath, "notes version two to discard\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("working");
      expect(lastClosed.task.workItems.find((item) => item.id === "follow-up")?.status).toBe(
        "queued",
      );
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("keeps failure precedence over deferred completed revision settlement", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath } = await createTaskWithTwoArtifacts(
        harness,
        { reviewRequired: false },
      );
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start parallel revisions before one fails.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before sibling failure.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Fail notes sibling.",
      });

      await fs.writeFile(reportPath, "report version two before sibling failure\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");
      expect(
        harness.sessionDb.hasPendingTaskArtifactRevisionSettlementForWorkItem(
          task.id,
          reportRevision.revision.workItemId,
        ),
      ).toBe(true);

      const failed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "error",
      );
      if (!failed) throw new Error("Expected failed notes revision");
      expect(failed.task.status).toBe("blocked");
      expect(harness.sessionDb.hasPendingTaskArtifactRevisionSettlement(task.id)).toBe(true);
      expect(
        harness.sessionDb.hasPendingTaskArtifactRevisionSettlementForWorkItem(
          task.id,
          reportRevision.revision.workItemId,
        ),
      ).toBe(true);
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("settles deferred completed revisions after restart when the final sibling closes", async () => {
    const harness = await createHarness();
    let closed = false;
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start restart-sensitive parallel revisions.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before restart.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Cancel notes after restart.",
      });

      await fs.writeFile(reportPath, "report version two before restart\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      expect(firstClosed.task.status).toBe("working");
      await fs.writeFile(notesPath, "notes version two to discard after restart\n");

      harness.sessionDb.close();
      closed = true;
      const reopenedDb = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      const reopenedCoordinator = new TaskCoordinator({
        sessionDb: reopenedDb,
        artifactStore: new ArtifactVersionStore({
          rootDir: path.join(harness.rootDir, "artifacts"),
        }),
      });
      try {
        const lastClosed = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!lastClosed) throw new Error("Expected cancelled notes revision");
        expect(lastClosed.task.status).toBe("completed");
        const reportDetail = reopenedCoordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
      } finally {
        reopenedDb.close();
      }
    } finally {
      if (!closed) harness.sessionDb.close();
    }
  });

  test("preserves deferred completed revision helpers during compatible plan updates", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start parallel revision settlement preservation.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before a compatible plan update.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Keep notes revision active during the plan update.",
      });

      await fs.writeFile(reportPath, "report version two before compatible plan update\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      const deferredReportItem = firstClosed.task.workItems.find(
        (item) => item.id === reportRevision.revision.workItemId,
      );
      const activeNotesItem = firstClosed.task.workItems.find(
        (item) => item.id === notesRevision.revision.workItemId,
      );
      if (!deferredReportItem || !activeNotesItem) {
        throw new Error("Expected revision helper work items");
      }

      const mutated = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: firstClosed.task.revision,
        items: [
          ...firstClosed.task.workItems.map((item) => ({
            id: item.id,
            title: item.title,
            status:
              item.id === reportRevision.revision.workItemId ||
              item.id === notesRevision.revision.workItemId
                ? ("done" as const)
                : item.status,
            dependsOn:
              item.id === reportRevision.revision.workItemId ||
              item.id === notesRevision.revision.workItemId
                ? ["follow-up"]
                : item.dependsOn,
            expectedOutputs:
              item.id === reportRevision.revision.workItemId ||
              item.id === notesRevision.revision.workItemId
                ? []
                : item.expectedOutputs,
          })),
          {
            id: "follow-up",
            title: "Follow up",
            status: "done" as const,
            expectedOutputs: [],
          },
        ],
      });
      const preservedReport = mutated.workItems.find(
        (item) => item.id === reportRevision.revision.workItemId,
      );
      const preservedNotes = mutated.workItems.find(
        (item) => item.id === notesRevision.revision.workItemId,
      );
      expect(preservedReport).toMatchObject({
        status: deferredReportItem.status,
        dependsOn: deferredReportItem.dependsOn,
        assignedThreadId: deferredReportItem.assignedThreadId,
        claimedByThreadId: deferredReportItem.claimedByThreadId,
        expectedOutputs: deferredReportItem.expectedOutputs,
        completionEvidence: deferredReportItem.completionEvidence,
      });
      expect(preservedNotes).toMatchObject({
        status: activeNotesItem.status,
        dependsOn: activeNotesItem.dependsOn,
        assignedThreadId: activeNotesItem.assignedThreadId,
        claimedByThreadId: activeNotesItem.claimedByThreadId,
        expectedOutputs: activeNotesItem.expectedOutputs,
        completionEvidence: activeNotesItem.completionEvidence,
      });
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: mutated.revision,
          summary: "Cannot complete while notes revision still runs.",
        }),
      ).rejects.toThrow("unfinished work item");

      await fs.writeFile(notesPath, "notes version two to discard after compatible plan update\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected final cancelled revision");
      expect(lastClosed.task.status).toBe("completed");
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects removing deferred completed revision helpers without losing revision state", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start deferred helper removal rejection.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report before removal attempt.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Keep sibling active while removal is attempted.",
      });

      await fs.writeFile(reportPath, "report version two before deferred removal attempt\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      const beforeRemoval = harness.sessionDb.getTaskArtifactRevision(reportRevision.revision.id);
      await expect(
        harness.coordinator.replaceWorkItems({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: firstClosed.task.revision,
          items: firstClosed.task.workItems
            .filter((item) => item.id !== reportRevision.revision.workItemId)
            .map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
              dependsOn: item.dependsOn,
              expectedOutputs: item.expectedOutputs,
            })),
        }),
      ).rejects.toThrow("artifact revision");
      expect(harness.sessionDb.getTaskArtifactRevision(reportRevision.revision.id)).toEqual(
        beforeRemoval,
      );

      await fs.writeFile(notesPath, "notes version two to discard after removal rejection\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("completed");
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.acceptedVersionId).toBe(reportDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("does not re-propose an already reviewed revision when an unrelated revision cancels", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: true, reviewRounds: 0 });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start first report revision.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report for review.",
      });

      await fs.writeFile(reportPath, "report version two already proposed for review\n");
      const proposed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!proposed) throw new Error("Expected completed report revision");
      expect(proposed.task.status).toBe("awaiting_review");

      task = await harness.coordinator.requestChanges({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: proposed.task.revision,
        feedback: "Needs additional edits before delivery.",
      });
      expect(task.status).toBe("working");
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: task.revision,
        instruction: "Try unrelated notes changes.",
      });

      await fs.writeFile(notesPath, "notes version two to discard after requested changes\n");
      const unrelatedCancelled = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!unrelatedCancelled) throw new Error("Expected cancelled notes revision");
      expect(unrelatedCancelled.task.status).toBe("working");
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
      expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("does not re-propose an already reviewed revision after restart", async () => {
    const harness = await createHarness();
    let closed = false;
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: true, reviewRounds: 0 });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start restart-sensitive reviewed revision.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report for review before restart.",
      });

      await fs.writeFile(reportPath, "report version two already proposed before restart\n");
      const proposed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!proposed) throw new Error("Expected completed report revision");
      task = await harness.coordinator.requestChanges({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: proposed.task.revision,
        feedback: "Needs changes before restart.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: task.revision,
        instruction: "Try unrelated notes changes after restart.",
      });
      await fs.writeFile(notesPath, "notes version two to discard after restart\n");

      harness.sessionDb.close();
      closed = true;
      const reopenedDb = await SessionDb.create({
        paths: {
          rootDir: harness.rootDir,
          sessionsDir: path.join(harness.rootDir, "sessions"),
        },
      });
      const reopenedCoordinator = new TaskCoordinator({
        sessionDb: reopenedDb,
        artifactStore: new ArtifactVersionStore({
          rootDir: path.join(harness.rootDir, "artifacts"),
        }),
      });
      try {
        const unrelatedCancelled = await reopenedCoordinator.handleThreadOutcome(
          notesRevision.revision.sessionId,
          "cancelled",
        );
        if (!unrelatedCancelled) throw new Error("Expected cancelled notes revision");
        expect(unrelatedCancelled.task.status).toBe("working");
        const reportDetail = reopenedCoordinator.getArtifactDetail({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          artifactId: reportArtifact.id,
        });
        expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
        expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
      } finally {
        reopenedDb.close();
      }
    } finally {
      if (!closed) harness.sessionDb.close();
    }
  });

  test("preserves pending non-blocking questions when deferred settlement is not ready", async () => {
    const harness = await createHarness();
    try {
      let { task, reportArtifact, notesArtifact, reportPath, notesPath } =
        await createTaskWithTwoArtifacts(harness, { reviewRequired: false });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          { id: "deliver-report", title: "Deliver report", expectedOutputs: ["report.md"] },
          { id: "deliver-notes", title: "Deliver notes", expectedOutputs: ["notes.md"] },
          { id: "follow-up", title: "Follow up", expectedOutputs: [] },
        ],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Start deferred settlement with queued work.",
      });
      const reportRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
        expectedRevision: task.revision,
        instruction: "Revise report while queued work remains.",
      });
      const notesRevision = await harness.coordinator.startArtifactRevision({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: notesArtifact.id,
        expectedRevision: reportRevision.task.revision,
        instruction: "Cancel notes after the question remains pending.",
      });

      await fs.writeFile(reportPath, "report version two with pending input\n");
      const firstClosed = await harness.coordinator.handleThreadOutcome(
        reportRevision.revision.sessionId,
        "completed",
      );
      if (!firstClosed) throw new Error("Expected completed report revision");
      const requested = await harness.coordinator.requestInput({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: firstClosed.task.revision,
        sessionId: notesRevision.revision.sessionId,
        questions: [nonBlockingTaskQuestion()],
      });
      expect(requested.task.questions.at(-1)).toMatchObject({
        status: "pending",
        blocking: false,
        answer: null,
        resolutionSource: null,
      });
      const defaultedBefore = requested.task.activity.filter(
        (item) => item.kind === "input_defaulted",
      ).length;

      await fs.writeFile(notesPath, "notes version two to discard with pending input\n");
      const lastClosed = await harness.coordinator.handleThreadOutcome(
        notesRevision.revision.sessionId,
        "cancelled",
      );
      if (!lastClosed) throw new Error("Expected cancelled notes revision");
      expect(lastClosed.task.status).toBe("working");
      expect(lastClosed.task.workItems.find((item) => item.id === "follow-up")?.status).toBe(
        "queued",
      );
      expect(lastClosed.task.questions.at(-1)).toMatchObject({
        status: "pending",
        blocking: false,
        answer: null,
        resolutionSource: null,
      });
      expect(
        lastClosed.task.activity.filter((item) => item.kind === "input_defaulted"),
      ).toHaveLength(defaultedBefore);
      const reportDetail = harness.coordinator.getArtifactDetail({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        artifactId: reportArtifact.id,
      });
      expect(reportDetail?.versions.at(-1)?.reviewStatus).toBe("draft");
      expect(reportDetail?.acceptedVersionId).not.toBe(reportDetail?.latestVersionId);
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
