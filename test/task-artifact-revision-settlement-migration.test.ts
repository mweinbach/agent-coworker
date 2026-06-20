import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";
import { SessionTaskRepository } from "../src/server/sessionDb/tasks";
import { ArtifactVersionStore } from "../src/server/tasks/ArtifactVersionStore";
import { TaskCoordinator } from "../src/server/tasks/TaskCoordinator";
import type { TaskArtifact, TaskArtifactRevision, TaskRecord } from "../src/shared/tasks";

const SETTLEMENT_MIGRATION_VERSION = 24;

type Harness = {
  rootDir: string;
  sessionsDir: string;
  workspacePath: string;
  sessionDb: SessionDb;
  coordinator: TaskCoordinator;
};

async function createHarness(prefix = "artifact-settlement-migration-"): Promise<Harness> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  const workspacePath = path.join(home, "project");
  await Promise.all([
    fs.mkdir(sessionsDir, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ]);
  const sessionDb = await SessionDb.create({ paths: { rootDir, sessionsDir } });
  const coordinator = createCoordinator(sessionDb, rootDir);
  let threadIndex = 1;
  coordinator.setThreadFactory(async () => ({ sessionId: `revision-session-${threadIndex++}` }));
  return { rootDir, sessionsDir, workspacePath, sessionDb, coordinator };
}

function createCoordinator(sessionDb: SessionDb, rootDir: string): TaskCoordinator {
  return new TaskCoordinator({
    sessionDb,
    artifactStore: new ArtifactVersionStore({ rootDir: path.join(rootDir, "artifacts") }),
  });
}

async function createTaskWithArtifactSet(harness: Harness): Promise<{
  task: TaskRecord;
  artifacts: Record<"active" | "completed" | "cancelled" | "failed", TaskArtifact>;
  artifactPaths: Record<"active" | "completed" | "cancelled" | "failed", string>;
}> {
  const artifactPaths = {
    active: path.join(harness.workspacePath, "active.md"),
    completed: path.join(harness.workspacePath, "completed.md"),
    cancelled: path.join(harness.workspacePath, "cancelled.md"),
    failed: path.join(harness.workspacePath, "failed.md"),
  };
  await Promise.all(
    Object.entries(artifactPaths).map(([name, filePath]) =>
      fs.writeFile(filePath, `${name} version one\n`),
    ),
  );

  let task = await harness.coordinator.create({
    workspacePath: harness.workspacePath,
    title: "Artifact settlement migration",
    objective: "Exercise artifact revisions across a schema upgrade.",
    sessionId: `main-session-${crypto.randomUUID()}`,
    reviewRequired: false,
    reviewRounds: 0,
  });
  task = await harness.coordinator.replaceWorkItems({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    expectedRevision: task.revision,
    items: [
      { id: "active-item", title: "Active", expectedOutputs: ["active.md"] },
      { id: "completed-item", title: "Completed", expectedOutputs: ["completed.md"] },
      { id: "cancelled-item", title: "Cancelled", expectedOutputs: ["cancelled.md"] },
      { id: "failed-item", title: "Failed", expectedOutputs: ["failed.md"] },
    ],
  });

  const artifacts = {} as Record<keyof typeof artifactPaths, TaskArtifact>;
  for (const [name, filePath] of Object.entries(artifactPaths) as Array<
    [keyof typeof artifactPaths, string]
  >) {
    task = await harness.coordinator.registerArtifact({
      taskId: task.id,
      workspacePath: harness.workspacePath,
      expectedRevision: task.revision,
      path: filePath,
      title: `${name} artifact`,
      kind: "markdown",
      workItemId: `${name}-item`,
    });
    const canonicalPath = await fs.realpath(filePath);
    const artifact = task.artifacts.find((candidate) => candidate.path === canonicalPath);
    if (!artifact) throw new Error(`Expected registered artifact for ${name}`);
    artifacts[name] = artifact;
  }

  return { task, artifacts, artifactPaths };
}

async function seedPopulatedRevisionRows(harness: Harness): Promise<{
  taskId: string;
  activeRevision: TaskArtifactRevision;
  revisionIds: Record<"active" | "completed" | "cancelled" | "failed", string>;
  artifactPaths: Record<"active" | "completed" | "cancelled" | "failed", string>;
}> {
  const { task, artifacts, artifactPaths } = await createTaskWithArtifactSet(harness);
  const active = await harness.coordinator.startArtifactRevision({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifacts.active.id,
    expectedRevision: task.revision,
    instruction: "Keep this revision active across the migration.",
  });

  const completed = await harness.coordinator.startArtifactRevision({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifacts.completed.id,
    expectedRevision: active.task.revision,
    instruction: "Complete while a sibling revision remains active.",
  });
  await fs.writeFile(artifactPaths.completed, "completed version two\n");
  const completedOutcome = await harness.coordinator.handleThreadOutcome(
    completed.revision.sessionId,
    "completed",
  );
  if (!completedOutcome) throw new Error("Expected completed revision outcome");

  const cancelled = await harness.coordinator.startArtifactRevision({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifacts.cancelled.id,
    expectedRevision: completedOutcome.task.revision,
    instruction: "Cancel while a sibling revision remains active.",
  });
  const cancelledOutcome = await harness.coordinator.handleThreadOutcome(
    cancelled.revision.sessionId,
    "cancelled",
  );
  if (!cancelledOutcome) throw new Error("Expected cancelled revision outcome");

  const failed = await harness.coordinator.startArtifactRevision({
    taskId: task.id,
    workspacePath: harness.workspacePath,
    artifactId: artifacts.failed.id,
    expectedRevision: cancelledOutcome.task.revision,
    instruction: "Fail while a sibling revision remains active.",
  });
  const failedOutcome = await harness.coordinator.handleThreadOutcome(
    failed.revision.sessionId,
    "error",
  );
  if (!failedOutcome) throw new Error("Expected failed revision outcome");

  return {
    taskId: task.id,
    activeRevision: active.revision,
    revisionIds: {
      active: active.revision.id,
      completed: completed.revision.id,
      cancelled: cancelled.revision.id,
      failed: failed.revision.id,
    },
    artifactPaths,
  };
}

function downgradeArtifactRevisionsToMigration20(dbPath: string): void {
  const db = new Database(dbPath, { create: false, strict: false });
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP INDEX IF EXISTS idx_task_artifact_revisions_artifact;
      DROP INDEX IF EXISTS idx_task_artifact_revisions_session;
      DROP INDEX IF EXISTS idx_task_artifact_revisions_active;
      ALTER TABLE task_artifact_revisions RENAME TO task_artifact_revisions_current;
      CREATE TABLE task_artifact_revisions (
        revision_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,
        task_thread_id TEXT NOT NULL REFERENCES task_threads(thread_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        base_version_id TEXT NOT NULL REFERENCES task_artifact_versions(version_id),
        prior_version_id TEXT NOT NULL REFERENCES task_artifact_versions(version_id),
        result_version_id TEXT NULL REFERENCES task_artifact_versions(version_id) ON DELETE SET NULL,
        prior_task_status TEXT NOT NULL,
        status TEXT NOT NULL,
        instruction TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NULL
      );
      INSERT INTO task_artifact_revisions(
        revision_id,
        task_id,
        artifact_id,
        work_item_id,
        task_thread_id,
        session_id,
        base_version_id,
        prior_version_id,
        result_version_id,
        prior_task_status,
        status,
        instruction,
        created_at,
        updated_at,
        completed_at
      )
      SELECT
        revision_id,
        task_id,
        artifact_id,
        work_item_id,
        task_thread_id,
        session_id,
        base_version_id,
        prior_version_id,
        result_version_id,
        prior_task_status,
        status,
        instruction,
        created_at,
        updated_at,
        completed_at
      FROM task_artifact_revisions_current;
      DROP TABLE task_artifact_revisions_current;
      CREATE INDEX IF NOT EXISTS idx_task_artifact_revisions_artifact
        ON task_artifact_revisions(artifact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_artifact_revisions_session
        ON task_artifact_revisions(session_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifact_revisions_active
        ON task_artifact_revisions(artifact_id) WHERE status = 'active';
      DELETE FROM schema_migrations WHERE version >= 24;
      PRAGMA foreign_keys=ON;
    `);
  } finally {
    db.close();
  }
}

function getRevisionColumns(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { create: false, strict: false });
  try {
    return db.query("PRAGMA table_info(task_artifact_revisions)").all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

function getMigrationCount(dbPath: string, version: number): number {
  const db = new Database(dbPath, { create: false, strict: false });
  try {
    const row = db
      .query("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?")
      .get(version) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

describe("task artifact revision settlement migration", () => {
  test("upgrades populated migration-20 revision tables fail-closed and remains idempotent", async () => {
    const harness = await createHarness();
    const dbPath = harness.sessionDb.dbPath;
    const seed = await seedPopulatedRevisionRows(harness);
    harness.sessionDb.close();

    downgradeArtifactRevisionsToMigration20(dbPath);
    expect(getMigrationCount(dbPath, 20)).toBe(1);
    expect(getMigrationCount(dbPath, SETTLEMENT_MIGRATION_VERSION)).toBe(0);
    expect(getRevisionColumns(dbPath).map((column) => column.name)).not.toContain(
      "settlement_status",
    );

    const legacyDb = new Database(dbPath, { create: false, strict: false });
    try {
      const repository = new SessionTaskRepository(legacyDb);
      expect(() => repository.hasPendingArtifactRevisionSettlement(seed.taskId)).toThrow(
        /no such column: settlement_status/,
      );
    } finally {
      legacyDb.close();
    }

    const upgraded = await SessionDb.create({
      paths: { rootDir: harness.rootDir, sessionsDir: harness.sessionsDir },
    });
    try {
      const settlementColumn = getRevisionColumns(dbPath).find(
        (column) => column.name === "settlement_status",
      );
      expect(settlementColumn).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'none'",
      });
      expect(getMigrationCount(dbPath, SETTLEMENT_MIGRATION_VERSION)).toBe(1);

      const inspectDb = new Database(dbPath, { create: false, strict: false });
      try {
        const rows = inspectDb
          .query(
            "SELECT revision_id, status, settlement_status FROM task_artifact_revisions ORDER BY revision_id",
          )
          .all() as Array<{
          revision_id: string;
          status: string;
          settlement_status: string;
        }>;
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              revision_id: seed.revisionIds.active,
              status: "active",
              settlement_status: "none",
            }),
            expect.objectContaining({
              revision_id: seed.revisionIds.completed,
              status: "completed",
              settlement_status: "none",
            }),
            expect.objectContaining({
              revision_id: seed.revisionIds.cancelled,
              status: "cancelled",
              settlement_status: "none",
            }),
            expect.objectContaining({
              revision_id: seed.revisionIds.failed,
              status: "error",
              settlement_status: "none",
            }),
          ]),
        );
      } finally {
        inspectDb.close();
      }

      expect(upgraded.hasPendingTaskArtifactRevisionSettlement(seed.taskId)).toBe(false);
      expect(upgraded.listCoordinatorOwnedTaskArtifactRevisionWorkItemIds(seed.taskId)).toEqual([
        seed.activeRevision.workItemId,
      ]);
      expect(upgraded.getTaskArtifactRevision(seed.revisionIds.completed)?.status).toBe(
        "completed",
      );

      const coordinator = createCoordinator(upgraded, harness.rootDir);
      await fs.writeFile(seed.artifactPaths.active, "active version two\n");
      const completedActive = await coordinator.handleThreadOutcome(
        seed.activeRevision.sessionId,
        "completed",
      );
      expect(completedActive?.revision.status).toBe("completed");
      expect(upgraded.getTaskArtifactRevision(seed.revisionIds.active)?.status).toBe("completed");
    } finally {
      upgraded.close();
    }

    const reopened = await SessionDb.create({
      paths: { rootDir: harness.rootDir, sessionsDir: harness.sessionsDir },
    });
    try {
      expect(
        getRevisionColumns(dbPath).filter((column) => column.name === "settlement_status"),
      ).toHaveLength(1);
      expect(getMigrationCount(dbPath, SETTLEMENT_MIGRATION_VERSION)).toBe(1);
      expect(reopened.hasPendingTaskArtifactRevisionSettlement(seed.taskId)).toBe(false);
      expect(reopened.getTaskArtifactRevision(seed.revisionIds.completed)?.status).toBe(
        "completed",
      );
    } finally {
      reopened.close();
    }
  });

  test("marks settlement migration on fresh and column-present databases without duplicate ALTER", async () => {
    const fresh = await createHarness("artifact-settlement-fresh-");
    const freshDbPath = fresh.sessionDb.dbPath;
    try {
      expect(getMigrationCount(freshDbPath, SETTLEMENT_MIGRATION_VERSION)).toBe(1);
      expect(
        getRevisionColumns(freshDbPath).filter((column) => column.name === "settlement_status"),
      ).toHaveLength(1);
    } finally {
      fresh.sessionDb.close();
    }

    const partial = await createHarness("artifact-settlement-partial-");
    const partialDbPath = partial.sessionDb.dbPath;
    partial.sessionDb.close();
    const inspectDb = new Database(partialDbPath, { create: false, strict: false });
    try {
      inspectDb
        .query("DELETE FROM schema_migrations WHERE version = ?")
        .run(SETTLEMENT_MIGRATION_VERSION);
    } finally {
      inspectDb.close();
    }

    const reopened = await SessionDb.create({
      paths: { rootDir: partial.rootDir, sessionsDir: partial.sessionsDir },
    });
    try {
      expect(getMigrationCount(partialDbPath, SETTLEMENT_MIGRATION_VERSION)).toBe(1);
      expect(
        getRevisionColumns(partialDbPath).filter((column) => column.name === "settlement_status"),
      ).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  test("does not mark settlement migration when the schema update fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-settlement-failure-"));
    const rootDir = path.join(home, ".cowork");
    const sessionsDir = path.join(rootDir, "sessions");
    const dbPath = path.join(rootDir, "sessions.db");
    await fs.mkdir(sessionsDir, { recursive: true });
    const db = new Database(dbPath, { create: true, strict: false });
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const insertMigration = db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (let version = 1; version <= 23; version += 1) {
        insertMigration.run(version, "2026-06-20T00:00:00.000Z");
      }
    } finally {
      db.close();
    }

    await expect(SessionDb.create({ paths: { rootDir, sessionsDir } })).rejects.toThrow(
      /task_artifact_revisions/,
    );
    expect(getMigrationCount(dbPath, SETTLEMENT_MIGRATION_VERSION)).toBe(0);
  });
});
