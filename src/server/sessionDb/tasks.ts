import type { Database } from "bun:sqlite";

import type {
  TaskActivity,
  TaskActivityKind,
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskArtifactRevisionStatus,
  TaskArtifactVersion,
  TaskBlocker,
  TaskCheckpoint,
  TaskCreationOrigin,
  TaskDecision,
  TaskQuestion,
  TaskRecord,
  TaskRequirement,
  TaskReviewRecord,
  TaskStatus,
  TaskSummary,
  TaskThread,
  WorkItem,
  WorkItemStatus,
} from "../../shared/tasks";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "cancelled", "failed"]);
const PENDING_ARTIFACT_REVISION_SETTLEMENT = "pending";

function sql(lines: readonly string[]): string {
  return lines.join(String.fromCharCode(10));
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseArtifactManifest(value: unknown): TaskCheckpoint["artifactManifest"] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.path !== "string" ||
        typeof record.title !== "string" ||
        typeof record.kind !== "string"
      ) {
        return [];
      }
      return [{ id: record.id, path: record.path, title: record.title, kind: record.kind }];
    });
  } catch {
    return [];
  }
}

function parseQuestionOptions(value: unknown): TaskQuestion["options"] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const option = entry as Record<string, unknown>;
      if (typeof option.id !== "string" || typeof option.label !== "string") return [];
      return [
        {
          id: option.id,
          label: option.label,
          description: typeof option.description === "string" ? option.description : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

type TaskRow = {
  task_id: string;
  workspace_path: string;
  title: string;
  objective: string;
  context: string;
  source_session_id: string | null;
  creation_origin: TaskCreationOrigin;
  creation_idempotency_key: string | null;
  status: TaskStatus;
  revision: number;
  review_required: number;
  review_rounds: number;
  created_at: string;
  updated_at: string;
};

export type CreateTaskInput = {
  id: string;
  workspacePath: string;
  title: string;
  objective: string;
  context?: string;
  sourceSessionId?: string | null;
  creationOrigin?: TaskCreationOrigin;
  creationIdempotencyKey?: string | null;
  initialStatus?: TaskStatus;
  reviewRequired: boolean;
  reviewRounds?: number;
  thread: TaskThread;
  requirements?: TaskRequirementInput[];
  workItems?: WorkItemInput[];
  decisions?: TaskDecision[];
};

export type TaskRequirementInput = Pick<
  TaskRequirement,
  "id" | "kind" | "text" | "source" | "permanence" | "status" | "createdAt" | "supersedes"
>;

export type WorkItemInput = Pick<
  WorkItem,
  | "id"
  | "title"
  | "description"
  | "status"
  | "dependsOn"
  | "assignedThreadId"
  | "claimedByThreadId"
  | "expectedOutputs"
  | "completionEvidence"
  | "position"
  | "createdAt"
  | "updatedAt"
>;

export type StartTaskArtifactRevisionInput = {
  revision: TaskArtifactRevision;
  thread: TaskThread;
  workItem: WorkItemInput;
  expectedRevision: number;
};

export type UpdateTaskPlanInput = {
  taskId: string;
  expectedRevision: number;
  title?: string;
  objective?: string;
  requirements?: TaskRequirementInput[];
  items: WorkItemInput[];
  updatedAt: string;
};

export type QueueTaskQuestionsInput = {
  taskId: string;
  expectedRevision: number;
  questions: TaskQuestion[];
  provisionalDecisions: TaskDecision[];
  blockTask: boolean;
  updatedAt: string;
};

export type ResolveTaskQuestionsInput = {
  taskId: string;
  expectedRevision: number;
  resolutions: Array<{
    questionId: string;
    answer: string;
    answerOptionId: string | null;
    decision: TaskDecision;
  }>;
  updatedAt: string;
};

export class SessionTaskRepository {
  constructor(private readonly db: Database) {}

  createSchema(): void {
    this.db.exec(
      sql([
        "CREATE TABLE IF NOT EXISTS tasks (",
        "  task_id TEXT PRIMARY KEY,",
        "  workspace_path TEXT NOT NULL,",
        "  title TEXT NOT NULL,",
        "  objective TEXT NOT NULL,",
        "  context TEXT NOT NULL DEFAULT '',",
        "  source_session_id TEXT NULL,",
        "  creation_origin TEXT NOT NULL DEFAULT 'manual',",
        "  creation_idempotency_key TEXT NULL,",
        "  status TEXT NOT NULL,",
        "  revision INTEGER NOT NULL DEFAULT 0,",
        "  review_required INTEGER NOT NULL DEFAULT 1,",
        "  review_rounds INTEGER NOT NULL DEFAULT 0,",
        "  created_at TEXT NOT NULL,",
        "  updated_at TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_threads (",
        "  thread_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  session_id TEXT NOT NULL UNIQUE,",
        "  title TEXT NOT NULL,",
        "  created_by TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  updated_at TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_requirements (",
        "  requirement_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  kind TEXT NOT NULL,",
        "  text TEXT NOT NULL,",
        "  source TEXT NOT NULL,",
        "  permanence TEXT NOT NULL,",
        "  status TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  supersedes TEXT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_work_items (",
        "  work_item_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  title TEXT NOT NULL,",
        "  description TEXT NOT NULL,",
        "  status TEXT NOT NULL,",
        "  assigned_thread_id TEXT NULL,",
        "  expected_outputs_json TEXT NOT NULL,",
        "  completion_evidence TEXT NULL,",
        "  position INTEGER NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  updated_at TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_work_item_dependencies (",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,",
        "  depends_on_work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,",
        "  PRIMARY KEY(work_item_id, depends_on_work_item_id)",
        ");",
        "CREATE TABLE IF NOT EXISTS task_work_item_claims (",
        "  work_item_id TEXT PRIMARY KEY REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  thread_id TEXT NOT NULL REFERENCES task_threads(thread_id) ON DELETE CASCADE,",
        "  claimed_at TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_decisions (",
        "  decision_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  question TEXT NOT NULL,",
        "  resolution TEXT NOT NULL,",
        "  source TEXT NOT NULL,",
        "  scope TEXT NOT NULL,",
        "  confidence REAL NULL,",
        "  status TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  supersedes TEXT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_artifacts (",
        "  artifact_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  work_item_id TEXT NULL,",
        "  thread_id TEXT NULL,",
        "  path TEXT NOT NULL,",
        "  kind TEXT NOT NULL,",
        "  title TEXT NOT NULL,",
        "  created_by TEXT NOT NULL,",
        "  provenance_json TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  UNIQUE(task_id, path)",
        ");",
        "CREATE TABLE IF NOT EXISTS task_blockers (",
        "  blocker_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  work_item_id TEXT NULL,",
        "  description TEXT NOT NULL,",
        "  blocking INTEGER NOT NULL,",
        "  status TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  resolved_at TEXT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_activity (",
        "  activity_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  seq INTEGER NOT NULL,",
        "  thread_id TEXT NULL,",
        "  work_item_id TEXT NULL,",
        "  kind TEXT NOT NULL,",
        "  summary TEXT NOT NULL,",
        "  detail TEXT NULL,",
        "  created_at TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_checkpoints (",
        "  checkpoint_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  thread_id TEXT NULL,",
        "  task_revision INTEGER NOT NULL,",
        "  reason TEXT NOT NULL,",
        "  agent_summary TEXT NOT NULL,",
        "  context_digest TEXT NOT NULL,",
        "  task_snapshot_json TEXT NOT NULL,",
        "  artifact_manifest_json TEXT NOT NULL,",
        "  created_at TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS task_directive_receipts (",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  idempotency_key TEXT NOT NULL,",
        "  result_revision INTEGER NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  PRIMARY KEY(task_id, idempotency_key)",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated ON tasks(workspace_path, updated_at DESC);",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_source_key ON tasks(source_session_id, creation_idempotency_key) WHERE source_session_id IS NOT NULL AND creation_idempotency_key IS NOT NULL;",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_workspace_key ON tasks(workspace_path, creation_idempotency_key) WHERE source_session_id IS NULL AND creation_idempotency_key IS NOT NULL;",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_source ON tasks(source_session_id) WHERE source_session_id IS NOT NULL AND status NOT IN ('completed', 'failed', 'cancelled');",
        "CREATE INDEX IF NOT EXISTS idx_task_threads_task ON task_threads(task_id, updated_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_task_work_items_task_position ON task_work_items(task_id, position);",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_activity_task_seq ON task_activity(task_id, seq);",
        "CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created ON task_checkpoints(task_id, created_at DESC);",
      ]),
    );
    this.createArtifactVersionSchema();
    this.createQuestionSchema();
    this.createReviewSchema();
  }

  addCreationColumns(): void {
    const columns = this.db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "context")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === "source_session_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN source_session_id TEXT NULL");
    }
    if (!columns.some((column) => column.name === "creation_origin")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN creation_origin TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!columns.some((column) => column.name === "creation_idempotency_key")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN creation_idempotency_key TEXT NULL");
    }
    if (!columns.some((column) => column.name === "review_rounds")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("DROP INDEX IF EXISTS idx_tasks_creation_key");
    this.db.exec(
      sql([
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_source_key ON tasks(source_session_id, creation_idempotency_key) WHERE source_session_id IS NOT NULL AND creation_idempotency_key IS NOT NULL;",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_workspace_key ON tasks(workspace_path, creation_idempotency_key) WHERE source_session_id IS NULL AND creation_idempotency_key IS NOT NULL;",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_source ON tasks(source_session_id) WHERE source_session_id IS NOT NULL AND status NOT IN ('completed', 'failed', 'cancelled');",
      ]),
    );
  }

  createQuestionSchema(): void {
    this.db.exec(
      sql([
        "CREATE TABLE IF NOT EXISTS task_questions (",
        "  question_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  thread_id TEXT NULL REFERENCES task_threads(thread_id) ON DELETE SET NULL,",
        "  work_item_id TEXT NULL REFERENCES task_work_items(work_item_id) ON DELETE SET NULL,",
        "  header TEXT NOT NULL,",
        "  question TEXT NOT NULL,",
        "  context TEXT NOT NULL,",
        "  blocking INTEGER NOT NULL,",
        "  urgency TEXT NOT NULL,",
        "  default_action TEXT NULL,",
        "  options_json TEXT NOT NULL,",
        "  recommended_option_id TEXT NULL,",
        "  status TEXT NOT NULL,",
        "  provisional_decision_id TEXT NULL REFERENCES task_decisions(decision_id) ON DELETE SET NULL,",
        "  answer TEXT NULL,",
        "  answer_option_id TEXT NULL,",
        "  resolution_source TEXT NULL,",
        "  supersedes TEXT NULL REFERENCES task_questions(question_id) ON DELETE SET NULL,",
        "  created_at TEXT NOT NULL,",
        "  resolved_at TEXT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_task_questions_task_status ON task_questions(task_id, status, created_at);",
        "CREATE INDEX IF NOT EXISTS idx_task_questions_blocking ON task_questions(task_id, blocking, status);",
      ]),
    );
  }

  createReviewSchema(): void {
    this.db.exec(
      sql([
        "CREATE TABLE IF NOT EXISTS task_reviews (",
        "  review_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  round INTEGER NOT NULL,",
        "  verdict TEXT NOT NULL,",
        "  feedback TEXT NOT NULL,",
        "  reviewer_agent_id TEXT NOT NULL,",
        "  reviewer_provider TEXT NOT NULL,",
        "  reviewer_model TEXT NOT NULL,",
        "  task_revision INTEGER NOT NULL,",
        "  material_fingerprint TEXT NOT NULL,",
        "  material_snapshot_json TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  addressed_at TEXT NULL,",
        "  implementation_summary TEXT NULL,",
        "  UNIQUE(task_id, round),",
        "  UNIQUE(task_id, reviewer_agent_id)",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_task_reviews_task_round ON task_reviews(task_id, round);",
        "CREATE INDEX IF NOT EXISTS idx_task_reviews_task_fingerprint ON task_reviews(task_id, material_fingerprint);",
      ]),
    );
  }

  createArtifactVersionSchema(): void {
    this.db.exec(
      sql([
        "CREATE TABLE IF NOT EXISTS task_artifact_versions (",
        "  version_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,",
        "  version_number INTEGER NOT NULL,",
        "  parent_version_id TEXT NULL REFERENCES task_artifact_versions(version_id) ON DELETE SET NULL,",
        "  sha256 TEXT NOT NULL,",
        "  size_bytes INTEGER NOT NULL,",
        "  media_type TEXT NOT NULL,",
        "  created_by TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  change_summary TEXT NOT NULL,",
        "  provenance_json TEXT NOT NULL,",
        "  review_status TEXT NOT NULL,",
        "  UNIQUE(artifact_id, version_number)",
        ");",
        "CREATE TABLE IF NOT EXISTS task_artifact_revisions (",
        "  revision_id TEXT PRIMARY KEY,",
        "  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,",
        "  artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,",
        "  work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,",
        "  task_thread_id TEXT NOT NULL REFERENCES task_threads(thread_id) ON DELETE CASCADE,",
        "  session_id TEXT NOT NULL,",
        "  base_version_id TEXT NOT NULL REFERENCES task_artifact_versions(version_id),",
        "  prior_version_id TEXT NOT NULL REFERENCES task_artifact_versions(version_id),",
        "  result_version_id TEXT NULL REFERENCES task_artifact_versions(version_id) ON DELETE SET NULL,",
        "  prior_task_status TEXT NOT NULL,",
        "  settlement_status TEXT NOT NULL DEFAULT 'none',",
        "  status TEXT NOT NULL,",
        "  instruction TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  updated_at TEXT NOT NULL,",
        "  completed_at TEXT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_task_artifact_versions_artifact ON task_artifact_versions(artifact_id, version_number);",
        "CREATE INDEX IF NOT EXISTS idx_task_artifact_versions_task ON task_artifact_versions(task_id, created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_task_artifact_revisions_artifact ON task_artifact_revisions(artifact_id, created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_task_artifact_revisions_session ON task_artifact_revisions(session_id, status);",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifact_revisions_active ON task_artifact_revisions(artifact_id) WHERE status = 'active';",
      ]),
    );
    const revisionColumns = this.db
      .query("PRAGMA table_info(task_artifact_revisions)")
      .all() as Array<{
      name: string;
    }>;
    if (!revisionColumns.some((column) => column.name === "prior_task_status")) {
      this.db.exec(
        "ALTER TABLE task_artifact_revisions ADD COLUMN prior_task_status TEXT NOT NULL DEFAULT 'working'",
      );
    }
  }

  ensureArtifactRevisionSettlementStatusColumn(): void {
    const revisionColumns = this.db
      .query("PRAGMA table_info(task_artifact_revisions)")
      .all() as Array<{
      name: string;
    }>;
    if (!revisionColumns.some((column) => column.name === "settlement_status")) {
      this.db.exec(
        "ALTER TABLE task_artifact_revisions ADD COLUMN settlement_status TEXT NOT NULL DEFAULT 'none'",
      );
    }
    this.db
      .query(
        "UPDATE task_artifact_revisions SET settlement_status = 'none' WHERE settlement_status IS NULL OR settlement_status = ''",
      )
      .run();
    this.db
      .query(
        "UPDATE task_artifact_revisions AS revision SET settlement_status = ? WHERE revision.status = 'completed' AND revision.result_version_id IS NOT NULL AND revision.settlement_status = 'none' AND EXISTS (SELECT 1 FROM task_artifact_revisions AS sibling WHERE sibling.task_id = revision.task_id AND sibling.revision_id != revision.revision_id AND sibling.status = 'active')",
      )
      .run(PENDING_ARTIFACT_REVISION_SETTLEMENT);
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const now = input.thread.createdAt;
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO tasks(task_id, workspace_path, title, objective, context, source_session_id, creation_origin, creation_idempotency_key, status, revision, review_required, review_rounds, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          input.workspacePath,
          input.title,
          input.objective,
          input.context ?? "",
          input.sourceSessionId ?? null,
          input.creationOrigin ?? "manual",
          input.creationIdempotencyKey ?? null,
          input.initialStatus ?? "draft",
          input.reviewRequired ? 1 : 0,
          input.reviewRounds ?? 0,
          now,
          now,
        );
      this.insertThread(input.thread);
      for (const requirement of input.requirements ?? []) {
        this.db
          .query(
            "INSERT INTO task_requirements(requirement_id, task_id, kind, text, source, permanence, status, created_at, supersedes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            requirement.id,
            input.id,
            requirement.kind,
            requirement.text,
            requirement.source,
            requirement.permanence,
            requirement.status,
            requirement.createdAt,
            requirement.supersedes,
          );
      }
      for (const item of input.workItems ?? []) {
        this.db
          .query(
            "INSERT INTO task_work_items(work_item_id, task_id, title, description, status, assigned_thread_id, expected_outputs_json, completion_evidence, position, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            item.id,
            input.id,
            item.title,
            item.description,
            item.status,
            item.assignedThreadId,
            JSON.stringify(item.expectedOutputs),
            item.completionEvidence,
            item.position,
            item.createdAt,
            item.updatedAt,
          );
      }
      for (const item of input.workItems ?? []) {
        for (const dependencyId of item.dependsOn) {
          this.db
            .query(
              "INSERT INTO task_work_item_dependencies(task_id, work_item_id, depends_on_work_item_id) VALUES(?, ?, ?)",
            )
            .run(input.id, item.id, dependencyId);
        }
      }
      for (const decision of input.decisions ?? []) this.insertDecision(decision);
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.id,
        threadId: input.thread.id,
        workItemId: null,
        kind: "task_created",
        summary: `Task created: ${input.title}`,
        detail: null,
        createdAt: now,
      });
    })();
    return this.requireTask(input.id);
  }

  getTaskByCreationKey(
    idempotencyKey: string,
    scope: { sourceSessionId?: string | null; workspacePath?: string } = {},
  ): TaskRecord | null {
    const row = (
      scope.sourceSessionId
        ? this.db
            .query(
              "SELECT task_id FROM tasks WHERE source_session_id = ? AND creation_idempotency_key = ?",
            )
            .get(scope.sourceSessionId, idempotencyKey)
        : scope.workspacePath
          ? this.db
              .query(
                "SELECT task_id FROM tasks WHERE source_session_id IS NULL AND workspace_path = ? AND creation_idempotency_key = ?",
              )
              .get(scope.workspacePath, idempotencyKey)
          : this.db
              .query(
                "SELECT task_id FROM tasks WHERE creation_idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
              )
              .get(idempotencyKey)
    ) as { task_id: string } | null;
    return row ? this.getTask(row.task_id) : null;
  }

  getActiveTaskForSourceSession(sessionId: string): TaskRecord | null {
    const row = this.db
      .query(
        "SELECT task_id FROM tasks WHERE source_session_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as { task_id: string } | null;
    return row ? this.getTask(row.task_id) : null;
  }

  listTasks(workspacePath?: string | null): TaskSummary[] {
    const rows = (
      workspacePath
        ? this.db
            .query("SELECT task_id FROM tasks WHERE workspace_path = ? ORDER BY updated_at DESC")
            .all(workspacePath)
        : this.db.query("SELECT task_id FROM tasks ORDER BY updated_at DESC").all()
    ) as Array<{
      task_id: string;
    }>;
    return rows.map(({ task_id }) => this.toSummary(this.requireTask(task_id)));
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | null;
    if (!row) return null;
    return this.mapTask(row);
  }

  getTaskForThread(sessionId: string): TaskRecord | null {
    const row = this.db
      .query("SELECT task_id FROM task_threads WHERE session_id = ?")
      .get(sessionId) as { task_id: string } | null;
    return row ? this.getTask(row.task_id) : null;
  }

  listReviews(taskId: string): TaskReviewRecord[] {
    return (
      this.db
        .query("SELECT * FROM task_reviews WHERE task_id = ? ORDER BY round, created_at")
        .all(taskId) as Array<Record<string, unknown>>
    ).map((row) => this.mapReview(row));
  }

  isTaskThread(sessionId: string): boolean {
    return (
      this.db.query("SELECT 1 AS found FROM task_threads WHERE session_id = ?").get(sessionId) !==
      null
    );
  }

  addThread(thread: TaskThread, expectedRevision: number): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(thread.taskId, expectedRevision, thread.updatedAt);
      this.insertThread(thread);
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: thread.taskId,
        threadId: thread.id,
        workItemId: null,
        kind: "thread_created",
        summary: `Thread created: ${thread.title}`,
        detail: null,
        createdAt: thread.createdAt,
      });
    })();
    return this.requireTask(thread.taskId);
  }

  updateBrief(input: {
    taskId: string;
    expectedRevision: number;
    title?: string;
    objective?: string;
    requirements?: TaskRequirementInput[];
    updatedAt: string;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      this.updateBriefInOpenTransaction(input);
    })();
    return this.requireTask(input.taskId);
  }

  updatePlan(input: UpdateTaskPlanInput): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      if (
        input.title !== undefined ||
        input.objective !== undefined ||
        input.requirements !== undefined
      ) {
        this.updateBriefInOpenTransaction(input);
      }
      this.replaceWorkItemsInOpenTransaction(input);
    })();
    return this.requireTask(input.taskId);
  }

  replaceWorkItems(input: {
    taskId: string;
    expectedRevision: number;
    items: WorkItemInput[];
    updatedAt: string;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      this.replaceWorkItemsInOpenTransaction(input);
    })();
    return this.requireTask(input.taskId);
  }

  private updateBriefInOpenTransaction(input: {
    taskId: string;
    title?: string;
    objective?: string;
    requirements?: TaskRequirementInput[];
    updatedAt: string;
  }): void {
    if (input.title !== undefined) {
      this.db.query("UPDATE tasks SET title = ? WHERE task_id = ?").run(input.title, input.taskId);
    }
    if (input.objective !== undefined) {
      this.db
        .query("UPDATE tasks SET objective = ? WHERE task_id = ?")
        .run(input.objective, input.taskId);
    }
    if (input.requirements) {
      this.db.query("DELETE FROM task_requirements WHERE task_id = ?").run(input.taskId);
      for (const requirement of input.requirements) {
        this.db
          .query(
            "INSERT INTO task_requirements(requirement_id, task_id, kind, text, source, permanence, status, created_at, supersedes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            requirement.id,
            input.taskId,
            requirement.kind,
            requirement.text,
            requirement.source,
            requirement.permanence,
            requirement.status,
            requirement.createdAt,
            requirement.supersedes,
          );
      }
    }
    this.insertActivity({
      id: crypto.randomUUID(),
      seq: 1,
      taskId: input.taskId,
      threadId: null,
      workItemId: null,
      kind: "brief_updated",
      summary: "Task brief updated",
      detail: null,
      createdAt: input.updatedAt,
    });
  }

  private replaceWorkItemsInOpenTransaction(input: {
    taskId: string;
    items: WorkItemInput[];
    updatedAt: string;
  }): void {
    const existingRows = this.db
      .query("SELECT work_item_id FROM task_work_items WHERE task_id = ?")
      .all(input.taskId) as Array<{ work_item_id: string }>;
    const existingIds = new Set(existingRows.map((row) => row.work_item_id));
    const inputIds = new Set(input.items.map((item) => item.id));
    for (const existingId of existingIds) {
      if (inputIds.has(existingId)) continue;
      const activeRevision = this.db
        .query(
          "SELECT revision_id FROM task_artifact_revisions WHERE task_id = ? AND work_item_id = ? AND (status = 'active' OR (status = 'completed' AND settlement_status = ?)) LIMIT 1",
        )
        .get(input.taskId, existingId, PENDING_ARTIFACT_REVISION_SETTLEMENT) as {
        revision_id: string;
      } | null;
      if (activeRevision) {
        throw new Error(
          `Cannot remove work item with active artifact revision or deferred artifact revision: ${existingId}`,
        );
      }
    }

    this.db.query("DELETE FROM task_work_item_dependencies WHERE task_id = ?").run(input.taskId);
    this.db.query("DELETE FROM task_work_item_claims WHERE task_id = ?").run(input.taskId);

    for (const existingId of existingIds) {
      if (inputIds.has(existingId)) continue;
      this.db
        .query("DELETE FROM task_work_items WHERE task_id = ? AND work_item_id = ?")
        .run(input.taskId, existingId);
    }

    for (const item of input.items) {
      if (existingIds.has(item.id)) {
        this.db
          .query(
            "UPDATE task_work_items SET title = ?, description = ?, status = ?, assigned_thread_id = ?, expected_outputs_json = ?, completion_evidence = ?, position = ?, updated_at = ? WHERE task_id = ? AND work_item_id = ?",
          )
          .run(
            item.title,
            item.description,
            item.status,
            item.assignedThreadId,
            JSON.stringify(item.expectedOutputs),
            item.completionEvidence,
            item.position,
            item.updatedAt,
            input.taskId,
            item.id,
          );
        continue;
      }
      const conflictingOwner = this.db
        .query("SELECT task_id FROM task_work_items WHERE work_item_id = ?")
        .get(item.id) as { task_id: string } | null;
      if (conflictingOwner && conflictingOwner.task_id !== input.taskId) {
        throw new Error(`Work item id already belongs to another task: ${item.id}`);
      }
      this.db
        .query(
          "INSERT INTO task_work_items(work_item_id, task_id, title, description, status, assigned_thread_id, expected_outputs_json, completion_evidence, position, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          item.id,
          input.taskId,
          item.title,
          item.description,
          item.status,
          item.assignedThreadId,
          JSON.stringify(item.expectedOutputs),
          item.completionEvidence,
          item.position,
          item.createdAt,
          item.updatedAt,
        );
    }

    for (const item of input.items) {
      for (const dependencyId of item.dependsOn) {
        this.db
          .query(
            "INSERT INTO task_work_item_dependencies(task_id, work_item_id, depends_on_work_item_id) VALUES(?, ?, ?)",
          )
          .run(input.taskId, item.id, dependencyId);
      }
      if (item.claimedByThreadId) {
        this.db
          .query(
            "INSERT INTO task_work_item_claims(work_item_id, task_id, thread_id, claimed_at) VALUES(?, ?, ?, ?)",
          )
          .run(item.id, input.taskId, item.claimedByThreadId, input.updatedAt);
      }
    }

    this.insertActivity({
      id: crypto.randomUUID(),
      seq: 1,
      taskId: input.taskId,
      threadId: null,
      workItemId: null,
      kind: "plan_updated",
      summary: `Work plan updated (${input.items.length} items)`,
      detail: null,
      createdAt: input.updatedAt,
    });
  }

  updateWorkItem(input: {
    taskId: string;
    workItemId: string;
    expectedRevision: number;
    status: WorkItemStatus;
    completionEvidence?: string;
    updatedAt: string;
    threadId?: string | null;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      const result = this.db
        .query(
          "UPDATE task_work_items SET status = ?, completion_evidence = COALESCE(?, completion_evidence), updated_at = ? WHERE task_id = ? AND work_item_id = ?",
        )
        .run(
          input.status,
          input.completionEvidence ?? null,
          input.updatedAt,
          input.taskId,
          input.workItemId,
        );
      if (Number(result.changes ?? 0) !== 1) throw new Error("Unknown work item");
      if (["done", "abandoned", "blocked"].includes(input.status)) {
        this.db
          .query("DELETE FROM task_work_item_claims WHERE work_item_id = ?")
          .run(input.workItemId);
      }
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: input.threadId ?? null,
        workItemId: input.workItemId,
        kind: "work_item_updated",
        summary: `Work item marked ${input.status.replaceAll("_", " ")}`,
        detail: input.completionEvidence ?? null,
        createdAt: input.updatedAt,
      });
    })();
    return this.requireTask(input.taskId);
  }

  claimWorkItem(input: {
    taskId: string;
    workItemId: string;
    threadId: string;
    expectedRevision: number;
    claimedAt: string;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.claimedAt);
      const existing = this.db
        .query("SELECT thread_id FROM task_work_item_claims WHERE work_item_id = ?")
        .get(input.workItemId) as { thread_id: string } | null;
      if (existing && existing.thread_id !== input.threadId) {
        throw new Error("Work item is already claimed by another task thread");
      }
      this.db
        .query(
          "INSERT OR REPLACE INTO task_work_item_claims(work_item_id, task_id, thread_id, claimed_at) VALUES(?, ?, ?, ?)",
        )
        .run(input.workItemId, input.taskId, input.threadId, input.claimedAt);
      this.db
        .query(
          "UPDATE task_work_items SET status = 'in_progress', assigned_thread_id = ?, updated_at = ? WHERE task_id = ? AND work_item_id = ?",
        )
        .run(input.threadId, input.claimedAt, input.taskId, input.workItemId);
    })();
    return this.requireTask(input.taskId);
  }

  recordDecision(decision: TaskDecision, expectedRevision: number, updatedAt: string): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(decision.taskId, expectedRevision, updatedAt);
      this.insertDecision(decision);
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: decision.taskId,
        threadId: null,
        workItemId: null,
        kind: "decision_recorded",
        summary: decision.question,
        detail: decision.resolution,
        createdAt: updatedAt,
      });
    })();
    return this.requireTask(decision.taskId);
  }

  queueQuestions(input: QueueTaskQuestionsInput): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      const provisionalById = new Map(
        input.provisionalDecisions.map((decision) => [decision.id, decision]),
      );
      for (const question of input.questions) {
        if (question.supersedes) {
          const prior = this.db
            .query(
              "SELECT provisional_decision_id FROM task_questions WHERE task_id = ? AND question_id = ? AND status = 'pending'",
            )
            .get(input.taskId, question.supersedes) as {
            provisional_decision_id: string | null;
          } | null;
          if (!prior)
            throw new Error(`Unknown pending superseded question: ${question.supersedes}`);
          this.db
            .query(
              "UPDATE task_questions SET status = 'superseded', resolved_at = ? WHERE task_id = ? AND question_id = ?",
            )
            .run(input.updatedAt, input.taskId, question.supersedes);
          if (prior.provisional_decision_id && !question.provisionalDecisionId) {
            this.db
              .query(
                "UPDATE task_decisions SET status = 'superseded' WHERE task_id = ? AND decision_id = ?",
              )
              .run(input.taskId, prior.provisional_decision_id);
          }
        }
        const provisional = question.provisionalDecisionId
          ? provisionalById.get(question.provisionalDecisionId)
          : undefined;
        if (question.provisionalDecisionId && !provisional) {
          throw new Error(`Missing provisional decision: ${question.provisionalDecisionId}`);
        }
        if (provisional) this.insertDecision(provisional);
        this.db
          .query(
            "INSERT INTO task_questions(question_id, task_id, thread_id, work_item_id, header, question, context, blocking, urgency, default_action, options_json, recommended_option_id, status, provisional_decision_id, answer, answer_option_id, resolution_source, supersedes, created_at, resolved_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            question.id,
            question.taskId,
            question.threadId,
            question.workItemId,
            question.header,
            question.question,
            question.context,
            question.blocking ? 1 : 0,
            question.urgency,
            question.defaultAction,
            JSON.stringify(question.options),
            question.recommendedOptionId,
            question.status,
            question.provisionalDecisionId,
            question.answer,
            question.answerOptionId,
            question.resolutionSource,
            question.supersedes,
            question.createdAt,
            question.resolvedAt,
          );
      }
      if (input.blockTask) {
        this.db
          .query(
            "UPDATE tasks SET status = 'blocked' WHERE task_id = ? AND status IN ('draft', 'planning', 'working')",
          )
          .run(input.taskId);
      }
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: input.questions[0]?.threadId ?? null,
        workItemId: null,
        kind: "input_requested",
        summary: `${input.questions.length} task question${input.questions.length === 1 ? "" : "s"} queued`,
        detail: input.questions.map((question) => question.question).join("\n"),
        createdAt: input.updatedAt,
      });
    })();
    return this.requireTask(input.taskId);
  }

  resolveQuestions(input: ResolveTaskQuestionsInput): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      for (const resolution of input.resolutions) {
        const updated = this.db
          .query(
            "UPDATE task_questions SET status = 'answered', answer = ?, answer_option_id = ?, resolution_source = 'user', resolved_at = ? WHERE task_id = ? AND question_id = ? AND status = 'pending'",
          )
          .run(
            resolution.answer,
            resolution.answerOptionId,
            input.updatedAt,
            input.taskId,
            resolution.questionId,
          );
        if (Number(updated.changes ?? 0) !== 1) {
          throw new Error(`Unknown pending task question: ${resolution.questionId}`);
        }
        this.insertDecision(resolution.decision);
      }
      const pendingBlocking = this.db
        .query(
          "SELECT COUNT(*) AS count FROM task_questions WHERE task_id = ? AND status = 'pending' AND blocking = 1",
        )
        .get(input.taskId) as { count: number };
      const activeBlocking = this.db
        .query(
          "SELECT COUNT(*) AS count FROM task_blockers WHERE task_id = ? AND status = 'active' AND blocking = 1",
        )
        .get(input.taskId) as { count: number };
      if (Number(pendingBlocking.count) === 0 && Number(activeBlocking.count) === 0) {
        this.db
          .query("UPDATE tasks SET status = 'working' WHERE task_id = ? AND status = 'blocked'")
          .run(input.taskId);
      }
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: null,
        workItemId: null,
        kind: "input_resolved",
        summary: `${input.resolutions.length} task answer${input.resolutions.length === 1 ? "" : "s"} recorded`,
        detail: input.resolutions
          .map((resolution) => `${resolution.decision.question}: ${resolution.answer}`)
          .join("\n"),
        createdAt: input.updatedAt,
      });
    })();
    return this.requireTask(input.taskId);
  }

  defaultPendingQuestions(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
  }): TaskRecord {
    const pending = this.db
      .query(
        "SELECT question_id, blocking, default_action, provisional_decision_id FROM task_questions WHERE task_id = ? AND status = 'pending' ORDER BY created_at, question_id",
      )
      .all(input.taskId) as Array<{
      question_id: string;
      blocking: number;
      default_action: string | null;
      provisional_decision_id: string | null;
    }>;
    if (pending.some((question) => bool(question.blocking))) {
      throw new Error("Task has unresolved blocking questions");
    }
    if (pending.length === 0) return this.requireTask(input.taskId);
    for (const question of pending) {
      if (!question.default_action || !question.provisional_decision_id) {
        throw new Error(`Task question has no usable default: ${question.question_id}`);
      }
    }
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      for (const question of pending) {
        this.db
          .query(
            "UPDATE task_questions SET status = 'defaulted', answer = default_action, resolution_source = 'default', resolved_at = ? WHERE task_id = ? AND question_id = ? AND status = 'pending'",
          )
          .run(input.updatedAt, input.taskId, question.question_id);
      }
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: null,
        workItemId: null,
        kind: "input_defaulted",
        summary: `${pending.length} unanswered task question${pending.length === 1 ? "" : "s"} resolved with recorded defaults`,
        detail: null,
        createdAt: input.updatedAt,
      });
    })();
    return this.requireTask(input.taskId);
  }

  registerArtifact(
    artifact: TaskArtifact,
    expectedRevision: number,
    updatedAt: string,
  ): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(artifact.taskId, expectedRevision, updatedAt);
      this.db
        .query(
          "INSERT INTO task_artifacts(artifact_id, task_id, work_item_id, thread_id, path, kind, title, created_by, provenance_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, path) DO UPDATE SET work_item_id = excluded.work_item_id, thread_id = excluded.thread_id, kind = excluded.kind, title = excluded.title, provenance_json = excluded.provenance_json",
        )
        .run(
          artifact.id,
          artifact.taskId,
          artifact.workItemId,
          artifact.threadId,
          artifact.path,
          artifact.kind,
          artifact.title,
          artifact.createdBy,
          JSON.stringify(artifact.provenance),
          artifact.createdAt,
        );
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: artifact.taskId,
        threadId: artifact.threadId,
        workItemId: artifact.workItemId,
        kind: "artifact_registered",
        summary: `Artifact ready: ${artifact.title}`,
        detail: artifact.path,
        createdAt: updatedAt,
      });
    })();
    return this.requireTask(artifact.taskId);
  }

  getArtifactDetail(taskId: string, artifactId: string): TaskArtifactDetail | null {
    const artifactRow = this.db
      .query("SELECT * FROM task_artifacts WHERE task_id = ? AND artifact_id = ?")
      .get(taskId, artifactId) as Record<string, unknown> | null;
    if (!artifactRow) return null;
    const artifact = this.mapArtifact(artifactRow, taskId);
    const versions = (
      this.db
        .query(
          "SELECT * FROM task_artifact_versions WHERE task_id = ? AND artifact_id = ? ORDER BY version_number ASC",
        )
        .all(taskId, artifactId) as Array<Record<string, unknown>>
    ).map((row) => this.mapArtifactVersion(row));
    const activeRevisionRow = this.db
      .query(
        "SELECT * FROM task_artifact_revisions WHERE task_id = ? AND artifact_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId, artifactId) as Record<string, unknown> | null;
    const acceptedVersion = [...versions]
      .reverse()
      .find((version) => version.reviewStatus === "accepted");
    return {
      artifact,
      versions,
      latestVersionId: versions.at(-1)?.id ?? null,
      acceptedVersionId: acceptedVersion?.id ?? null,
      activeRevision: activeRevisionRow ? this.mapArtifactRevision(activeRevisionRow) : null,
    };
  }

  getArtifactVersion(
    taskId: string,
    artifactId: string,
    versionId: string,
  ): TaskArtifactVersion | null {
    const row = this.db
      .query(
        "SELECT * FROM task_artifact_versions WHERE task_id = ? AND artifact_id = ? AND version_id = ?",
      )
      .get(taskId, artifactId, versionId) as Record<string, unknown> | null;
    return row ? this.mapArtifactVersion(row) : null;
  }

  getActiveArtifactRevisionForSession(sessionId: string): TaskArtifactRevision | null {
    const row = this.db
      .query(
        "SELECT * FROM task_artifact_revisions WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as Record<string, unknown> | null;
    return row ? this.mapArtifactRevision(row) : null;
  }

  getArtifactRevisionForSession(sessionId: string): TaskArtifactRevision | null {
    const row = this.db
      .query(
        "SELECT * FROM task_artifact_revisions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as Record<string, unknown> | null;
    return row ? this.mapArtifactRevision(row) : null;
  }

  getArtifactRevision(revisionId: string): TaskArtifactRevision | null {
    const row = this.db
      .query("SELECT * FROM task_artifact_revisions WHERE revision_id = ?")
      .get(revisionId) as Record<string, unknown> | null;
    return row ? this.mapArtifactRevision(row) : null;
  }

  getArtifactRevisionPriorTaskStatus(revisionId: string): TaskStatus | null {
    const row = this.db
      .query("SELECT prior_task_status FROM task_artifact_revisions WHERE revision_id = ?")
      .get(revisionId) as { prior_task_status: TaskStatus } | null;
    return row?.prior_task_status ?? null;
  }

  hasCompletedArtifactRevisionForWorkItem(taskId: string, workItemId: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS found FROM task_artifact_revisions WHERE task_id = ? AND work_item_id = ? AND status = 'completed' AND result_version_id IS NOT NULL LIMIT 1",
      )
      .get(taskId, workItemId);
    return row !== null;
  }

  hasPendingArtifactRevisionSettlement(taskId: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS found FROM task_artifact_revisions WHERE task_id = ? AND status = 'completed' AND result_version_id IS NOT NULL AND settlement_status = ? LIMIT 1",
      )
      .get(taskId, PENDING_ARTIFACT_REVISION_SETTLEMENT);
    return row !== null;
  }

  hasPendingArtifactRevisionSettlementForWorkItem(taskId: string, workItemId: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS found FROM task_artifact_revisions WHERE task_id = ? AND work_item_id = ? AND status = 'completed' AND result_version_id IS NOT NULL AND settlement_status = ? LIMIT 1",
      )
      .get(taskId, workItemId, PENDING_ARTIFACT_REVISION_SETTLEMENT);
    return row !== null;
  }

  listPendingArtifactRevisionSettlementIds(taskId: string): string[] {
    const rows = this.db
      .query(
        "SELECT revision_id FROM task_artifact_revisions WHERE task_id = ? AND status = 'completed' AND result_version_id IS NOT NULL AND settlement_status = ? ORDER BY completed_at ASC, revision_id ASC",
      )
      .all(taskId, PENDING_ARTIFACT_REVISION_SETTLEMENT) as Array<{ revision_id: string }>;
    return rows.map((row) => row.revision_id);
  }

  listArtifactRevisionOutputPathsForWorkItem(taskId: string, workItemId: string): string[] {
    const rows = this.db
      .query(
        "SELECT DISTINCT artifact.path AS path FROM task_artifact_revisions revision JOIN task_artifacts artifact ON artifact.task_id = revision.task_id AND artifact.artifact_id = revision.artifact_id WHERE revision.task_id = ? AND revision.work_item_id = ? AND revision.status IN ('completed', 'cancelled')",
      )
      .all(taskId, workItemId) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  listCoordinatorOwnedArtifactRevisionWorkItemIds(taskId: string): string[] {
    const rows = this.db
      .query(
        "SELECT DISTINCT work_item_id FROM task_artifact_revisions WHERE task_id = ? AND (status = 'active' OR (status = 'completed' AND settlement_status = ?))",
      )
      .all(taskId, PENDING_ARTIFACT_REVISION_SETTLEMENT) as Array<{ work_item_id: string }>;
    return rows.map((row) => row.work_item_id);
  }

  settlePendingArtifactRevisionSettlements(input: {
    taskId: string;
    updatedAt: string;
  }): TaskRecord {
    this.requireTask(input.taskId);
    this.db
      .query(
        "UPDATE task_artifact_revisions SET settlement_status = 'settled', updated_at = ? WHERE task_id = ? AND status = 'completed' AND settlement_status = ?",
      )
      .run(input.updatedAt, input.taskId, PENDING_ARTIFACT_REVISION_SETTLEMENT);
    return this.requireTask(input.taskId);
  }

  settlePendingArtifactRevisionSettlementsInOpenTransaction(input: {
    taskId: string;
    revisionIds: readonly string[];
    updatedAt: string;
  }): void {
    this.requireTask(input.taskId);
    const revisionIds = [...new Set(input.revisionIds)];
    if (revisionIds.length === 0) return;
    const placeholders = revisionIds.map(() => "?").join(", ");
    const result = this.db
      .query(
        `UPDATE task_artifact_revisions SET settlement_status = 'settled', updated_at = ? WHERE task_id = ? AND revision_id IN (${placeholders}) AND status = 'completed' AND settlement_status = ?`,
      )
      .run(input.updatedAt, input.taskId, ...revisionIds, PENDING_ARTIFACT_REVISION_SETTLEMENT);
    if (Number(result.changes ?? 0) !== revisionIds.length) {
      throw new Error(
        "Pending artifact revision settlements changed before they could be consumed",
      );
    }
  }

  hasCancelledArtifactRevisionForWorkItem(taskId: string, workItemId: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS found FROM task_artifact_revisions WHERE task_id = ? AND work_item_id = ? AND status = 'cancelled' LIMIT 1",
      )
      .get(taskId, workItemId);
    return row !== null;
  }

  registerArtifactVersioned(input: {
    artifact: TaskArtifact;
    version: TaskArtifactVersion;
    expectedRevision: number;
    updatedAt: string;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.artifact.taskId, input.expectedRevision, input.updatedAt);
      this.upsertArtifact(input.artifact);
      this.insertArtifactVersion(input.artifact.taskId, input.version);
      this.moveArtifactWorkItemToReview(
        input.artifact.taskId,
        input.artifact.workItemId,
        input.updatedAt,
      );
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.artifact.taskId,
        threadId: input.artifact.threadId,
        workItemId: input.artifact.workItemId,
        kind: "artifact_version_captured",
        summary: `Artifact version ${input.version.version} ready: ${input.artifact.title}`,
        detail: input.artifact.path,
        createdAt: input.updatedAt,
      });
    })();
    return this.requireTask(input.artifact.taskId);
  }

  registerArtifactBaseline(input: {
    taskId: string;
    artifactId: string;
    version: TaskArtifactVersion;
    expectedRevision: number;
    updatedAt: string;
  }): TaskArtifactDetail {
    const existing = this.getArtifactDetail(input.taskId, input.artifactId);
    if (!existing) throw new Error(`Unknown task artifact: ${input.artifactId}`);
    if (existing.versions.length > 0) return existing;
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      this.insertArtifactVersion(input.taskId, input.version);
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: existing.artifact.threadId,
        workItemId: existing.artifact.workItemId,
        kind: "artifact_version_captured",
        summary: `Artifact baseline captured: ${existing.artifact.title}`,
        detail: existing.artifact.path,
        createdAt: input.updatedAt,
      });
    })();
    return this.getArtifactDetail(input.taskId, input.artifactId) as TaskArtifactDetail;
  }

  captureArtifactVersion(input: {
    taskId: string;
    artifactId: string;
    version: TaskArtifactVersion;
    expectedRevision: number;
    updatedAt: string;
    activityKind?: "artifact_version_captured" | "artifact_version_restored";
  }): TaskArtifactDetail {
    const detail = this.getArtifactDetail(input.taskId, input.artifactId);
    if (!detail) throw new Error(`Unknown task artifact: ${input.artifactId}`);
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      this.supersedePendingArtifactVersions(input.artifactId);
      this.insertArtifactVersion(input.taskId, input.version);
      this.moveArtifactWorkItemToReview(input.taskId, detail.artifact.workItemId, input.updatedAt);
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: detail.artifact.threadId,
        workItemId: detail.artifact.workItemId,
        kind: input.activityKind ?? "artifact_version_captured",
        summary:
          input.activityKind === "artifact_version_restored"
            ? `Artifact restored as version ${input.version.version}: ${detail.artifact.title}`
            : `Artifact version ${input.version.version} captured: ${detail.artifact.title}`,
        detail: input.version.changeSummary || null,
        createdAt: input.updatedAt,
      });
    })();
    return this.getArtifactDetail(input.taskId, input.artifactId) as TaskArtifactDetail;
  }

  startArtifactRevision(input: StartTaskArtifactRevisionInput): TaskRecord {
    this.db.transaction(() => {
      const taskRow = this.db
        .query("SELECT status FROM tasks WHERE task_id = ?")
        .get(input.revision.taskId) as { status: TaskStatus } | null;
      if (!taskRow) throw new Error(`Unknown task: ${input.revision.taskId}`);
      const activePriorTask = this.db
        .query(
          "SELECT prior_task_status FROM task_artifact_revisions WHERE task_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1",
        )
        .get(input.revision.taskId) as { prior_task_status: TaskStatus } | null;
      this.bumpRevision(input.revision.taskId, input.expectedRevision, input.revision.createdAt);
      this.db
        .query("UPDATE tasks SET status = 'working' WHERE task_id = ?")
        .run(input.revision.taskId);
      this.insertThread(input.thread);
      this.db
        .query(
          "INSERT INTO task_work_items(work_item_id, task_id, title, description, status, assigned_thread_id, expected_outputs_json, completion_evidence, position, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.workItem.id,
          input.revision.taskId,
          input.workItem.title,
          input.workItem.description,
          input.workItem.status,
          input.thread.id,
          JSON.stringify(input.workItem.expectedOutputs),
          input.workItem.completionEvidence,
          input.workItem.position,
          input.workItem.createdAt,
          input.workItem.updatedAt,
        );
      for (const dependencyId of input.workItem.dependsOn) {
        this.db
          .query(
            "INSERT INTO task_work_item_dependencies(task_id, work_item_id, depends_on_work_item_id) VALUES(?, ?, ?)",
          )
          .run(input.revision.taskId, input.workItem.id, dependencyId);
      }
      this.db
        .query(
          "INSERT INTO task_work_item_claims(work_item_id, task_id, thread_id, claimed_at) VALUES(?, ?, ?, ?)",
        )
        .run(input.workItem.id, input.revision.taskId, input.thread.id, input.revision.createdAt);
      this.db
        .query(
          "INSERT INTO task_artifact_revisions(revision_id, task_id, artifact_id, work_item_id, task_thread_id, session_id, base_version_id, prior_version_id, result_version_id, prior_task_status, settlement_status, status, instruction, created_at, updated_at, completed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'none', ?, ?, ?, ?, ?)",
        )
        .run(
          input.revision.id,
          input.revision.taskId,
          input.revision.artifactId,
          input.revision.workItemId,
          input.revision.taskThreadId,
          input.revision.sessionId,
          input.revision.baseVersionId,
          input.revision.priorVersionId,
          activePriorTask?.prior_task_status ?? taskRow.status,
          input.revision.status,
          input.revision.instruction,
          input.revision.createdAt,
          input.revision.updatedAt,
          input.revision.completedAt,
        );
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.revision.taskId,
        threadId: input.thread.id,
        workItemId: input.workItem.id,
        kind: "artifact_revision_started",
        summary: `Artifact revision started: ${input.workItem.title}`,
        detail: input.revision.instruction,
        createdAt: input.revision.createdAt,
      });
    })();
    return this.requireTask(input.revision.taskId);
  }

  completeArtifactRevision(input: {
    revisionId: string;
    version: TaskArtifactVersion;
    updatedAt: string;
    forcePendingSettlement?: boolean;
  }): TaskRecord {
    const revisionRow = this.requireArtifactRevisionRow(input.revisionId);
    const taskId = String(revisionRow.task_id);
    if (revisionRow.status !== "active") return this.requireTask(taskId);
    this.db.transaction(() => {
      this.completeArtifactRevisionInOpenTransaction(input);
    })();
    return this.requireTask(taskId);
  }

  completeArtifactRevisionInOpenTransaction(input: {
    revisionId: string;
    version: TaskArtifactVersion;
    updatedAt: string;
    forcePendingSettlement?: boolean;
  }): void {
    const revisionRow = this.requireArtifactRevisionRow(input.revisionId);
    const taskId = String(revisionRow.task_id);
    if (revisionRow.status !== "active") return;
    this.bumpCurrentRevision(taskId, input.updatedAt);
    const activeSibling = this.db
      .query(
        "SELECT 1 AS found FROM task_artifact_revisions WHERE task_id = ? AND revision_id != ? AND status = 'active' LIMIT 1",
      )
      .get(taskId, input.revisionId);
    const settlementStatus =
      activeSibling || input.forcePendingSettlement ? PENDING_ARTIFACT_REVISION_SETTLEMENT : "none";
    this.supersedePendingArtifactVersions(String(revisionRow.artifact_id));
    this.insertArtifactVersion(taskId, input.version);
    this.db
      .query(
        "UPDATE task_artifact_revisions SET result_version_id = ?, settlement_status = ?, status = 'completed', updated_at = ?, completed_at = ? WHERE revision_id = ? AND status = 'active'",
      )
      .run(input.version.id, settlementStatus, input.updatedAt, input.updatedAt, input.revisionId);
    this.db
      .query(
        "UPDATE task_work_items SET status = ?, completion_evidence = ?, updated_at = ? WHERE task_id = ? AND work_item_id = ?",
      )
      .run(
        "review",
        input.version.changeSummary,
        input.updatedAt,
        taskId,
        String(revisionRow.work_item_id),
      );
    this.db
      .query("DELETE FROM task_work_item_claims WHERE work_item_id = ?")
      .run(String(revisionRow.work_item_id));
    this.insertActivity({
      id: crypto.randomUUID(),
      seq: 1,
      taskId,
      threadId: String(revisionRow.task_thread_id),
      workItemId: String(revisionRow.work_item_id),
      kind: "artifact_revision_completed",
      summary: `Artifact revision ready for review (version ${input.version.version})`,
      detail: input.version.changeSummary || null,
      createdAt: input.updatedAt,
    });
  }

  markArtifactRevisionSettlementPending(input: {
    revisionId: string;
    updatedAt: string;
  }): TaskRecord {
    const revisionRow = this.requireArtifactRevisionRow(input.revisionId);
    const taskId = String(revisionRow.task_id);
    if (revisionRow.status !== "completed" || revisionRow.result_version_id === null) {
      return this.requireTask(taskId);
    }
    this.db
      .query(
        "UPDATE task_artifact_revisions SET settlement_status = ?, updated_at = ? WHERE revision_id = ? AND status = 'completed' AND result_version_id IS NOT NULL",
      )
      .run(PENDING_ARTIFACT_REVISION_SETTLEMENT, input.updatedAt, input.revisionId);
    return this.requireTask(taskId);
  }

  failArtifactRevision(input: {
    revisionId: string;
    status: Extract<TaskArtifactRevisionStatus, "cancelled" | "error">;
    updatedAt: string;
    detail?: string;
  }): TaskRecord {
    const revisionRow = this.requireArtifactRevisionRow(input.revisionId);
    const taskId = String(revisionRow.task_id);
    if (revisionRow.status !== "active") return this.requireTask(taskId);
    this.db.transaction(() => {
      this.failArtifactRevisionInOpenTransaction(input);
    })();
    return this.requireTask(taskId);
  }

  failArtifactRevisionInOpenTransaction(input: {
    revisionId: string;
    status: Extract<TaskArtifactRevisionStatus, "cancelled" | "error">;
    updatedAt: string;
    detail?: string;
  }): void {
    const revisionRow = this.requireArtifactRevisionRow(input.revisionId);
    const taskId = String(revisionRow.task_id);
    if (revisionRow.status !== "active") return;
    this.bumpCurrentRevision(taskId, input.updatedAt);
    this.db
      .query(
        "UPDATE task_artifact_revisions SET status = ?, settlement_status = 'none', updated_at = ?, completed_at = ? WHERE revision_id = ? AND status = 'active'",
      )
      .run(input.status, input.updatedAt, input.updatedAt, input.revisionId);
    this.db
      .query(
        "UPDATE task_work_items SET status = ?, completion_evidence = ?, updated_at = ? WHERE task_id = ? AND work_item_id = ?",
      )
      .run(
        input.status === "cancelled" ? "abandoned" : "blocked",
        input.detail ?? null,
        input.updatedAt,
        taskId,
        String(revisionRow.work_item_id),
      );
    this.db
      .query("DELETE FROM task_work_item_claims WHERE work_item_id = ?")
      .run(String(revisionRow.work_item_id));
    this.insertActivity({
      id: crypto.randomUUID(),
      seq: 1,
      taskId,
      threadId: String(revisionRow.task_thread_id),
      workItemId: String(revisionRow.work_item_id),
      kind: "artifact_revision_failed",
      summary:
        input.status === "cancelled" ? "Artifact revision cancelled" : "Artifact revision failed",
      detail: input.detail ?? null,
      createdAt: input.updatedAt,
    });
  }

  abandonArtifactRevisionForTerminalTask(input: {
    revisionId: string;
    updatedAt: string;
  }): TaskRecord {
    const revisionRow = this.requireArtifactRevisionRow(input.revisionId);
    const taskId = String(revisionRow.task_id);
    this.db.transaction(() => {
      const taskRow = this.db.query("SELECT status FROM tasks WHERE task_id = ?").get(taskId) as {
        status: TaskStatus;
      } | null;
      if (!taskRow) throw new Error(`Unknown task: ${taskId}`);
      if (!TERMINAL_TASK_STATUSES.has(taskRow.status)) return;
      const result = this.db
        .query(
          "UPDATE task_artifact_revisions SET status = 'cancelled', settlement_status = 'none', updated_at = ?, completed_at = ? WHERE revision_id = ? AND status = 'active'",
        )
        .run(input.updatedAt, input.updatedAt, input.revisionId);
      if (result.changes === 0) return;
      this.abandonRevisionWorkItem(
        taskId,
        typeof revisionRow.work_item_id === "string" ? revisionRow.work_item_id : null,
        input.updatedAt,
      );
    })();
    return this.requireTask(taskId);
  }

  acceptArtifactVersion(input: {
    taskId: string;
    artifactId: string;
    versionId: string;
    expectedRevision: number;
    updatedAt: string;
  }): TaskRecord {
    const detail = this.getArtifactDetail(input.taskId, input.artifactId);
    if (!detail) throw new Error(`Unknown task artifact: ${input.artifactId}`);
    if (!detail.versions.some((version) => version.id === input.versionId)) {
      throw new Error(`Unknown artifact version: ${input.versionId}`);
    }
    const selectedVersion = detail.versions.find((version) => version.id === input.versionId);
    if (selectedVersion?.reviewStatus === "accepted") return this.requireTask(input.taskId);
    if (selectedVersion?.reviewStatus !== "draft") {
      throw new Error("Only a draft artifact version can be accepted");
    }
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
      this.db
        .query(
          "UPDATE task_artifact_versions SET review_status = 'superseded' WHERE task_id = ? AND artifact_id = ? AND review_status = 'accepted' AND version_id != ?",
        )
        .run(input.taskId, input.artifactId, input.versionId);
      this.db
        .query(
          "UPDATE task_artifact_versions SET review_status = 'accepted' WHERE task_id = ? AND artifact_id = ? AND version_id = ?",
        )
        .run(input.taskId, input.artifactId, input.versionId);
      const revision = this.db
        .query(
          "SELECT work_item_id FROM task_artifact_revisions WHERE task_id = ? AND artifact_id = ? AND result_version_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
        )
        .get(input.taskId, input.artifactId, input.versionId) as { work_item_id: string } | null;
      const workItemId = revision?.work_item_id ?? detail.artifact.workItemId;
      if (workItemId) {
        this.db
          .query(
            "UPDATE task_work_items SET status = 'done', completion_evidence = COALESCE(completion_evidence, ?), updated_at = ? WHERE task_id = ? AND work_item_id = ? AND status = 'review'",
          )
          .run(
            `Accepted artifact version ${input.versionId}`,
            input.updatedAt,
            input.taskId,
            workItemId,
          );
      }
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: detail.artifact.threadId,
        workItemId,
        kind: "artifact_version_accepted",
        summary: `Artifact accepted: ${detail.artifact.title}`,
        detail: input.versionId,
        createdAt: input.updatedAt,
      });
    })();
    return this.requireTask(input.taskId);
  }

  acceptAllArtifactVersions(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
  }): TaskRecord {
    this.db.transaction(() => {
      this.acceptAllArtifactVersionsInOpenTransaction(input);
    })();
    return this.requireTask(input.taskId);
  }

  acceptAllArtifactVersionsInOpenTransaction(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
  }): void {
    this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
    this.db
      .query(
        "UPDATE task_artifact_versions SET review_status = 'superseded' WHERE task_id = ? AND review_status = 'accepted' AND artifact_id IN (SELECT artifact_id FROM task_artifact_versions WHERE task_id = ? AND review_status = 'draft' GROUP BY artifact_id)",
      )
      .run(input.taskId, input.taskId);
    this.db
      .query(
        "UPDATE task_artifact_versions SET review_status = 'accepted' WHERE version_id IN (SELECT version_id FROM task_artifact_versions draft WHERE draft.task_id = ? AND draft.review_status = 'draft' AND draft.version_number = (SELECT MAX(latest.version_number) FROM task_artifact_versions latest WHERE latest.artifact_id = draft.artifact_id AND latest.review_status = 'draft'))",
      )
      .run(input.taskId);
    this.db
      .query(
        "UPDATE task_work_items SET status = 'done', completion_evidence = COALESCE(completion_evidence, 'Accepted with task delivery'), updated_at = ? WHERE task_id = ? AND status = 'review'",
      )
      .run(input.updatedAt, input.taskId);
    this.db.query("DELETE FROM task_work_item_claims WHERE task_id = ?").run(input.taskId);
    this.db.query("UPDATE tasks SET status = 'completed' WHERE task_id = ?").run(input.taskId);
    this.insertActivity({
      id: crypto.randomUUID(),
      seq: 1,
      taskId: input.taskId,
      threadId: null,
      workItemId: null,
      kind: "status_changed",
      summary: "Task accepted",
      detail: null,
      createdAt: input.updatedAt,
    });
  }

  reportBlocker(blocker: TaskBlocker, expectedRevision: number, updatedAt: string): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(blocker.taskId, expectedRevision, updatedAt);
      this.db
        .query(
          "INSERT INTO task_blockers(blocker_id, task_id, work_item_id, description, blocking, status, created_at, resolved_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          blocker.id,
          blocker.taskId,
          blocker.workItemId,
          blocker.description,
          blocker.blocking ? 1 : 0,
          blocker.status,
          blocker.createdAt,
          blocker.resolvedAt,
        );
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: blocker.taskId,
        threadId: null,
        workItemId: blocker.workItemId,
        kind: "blocker_reported",
        summary: blocker.description,
        detail: blocker.blocking ? "Blocking" : "Non-blocking",
        createdAt: updatedAt,
      });
    })();
    return this.requireTask(blocker.taskId);
  }

  resolveBlocker(input: {
    taskId: string;
    blockerId: string;
    expectedRevision: number;
    resolvedAt: string;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.resolvedAt);
      const result = this.db
        .query(
          "UPDATE task_blockers SET status = 'resolved', resolved_at = ? WHERE task_id = ? AND blocker_id = ?",
        )
        .run(input.resolvedAt, input.taskId, input.blockerId);
      if (Number(result.changes ?? 0) !== 1) throw new Error("Unknown blocker");
      this.insertActivity({
        id: crypto.randomUUID(),
        seq: 1,
        taskId: input.taskId,
        threadId: null,
        workItemId: null,
        kind: "blocker_resolved",
        summary: "Task blocker resolved",
        detail: null,
        createdAt: input.resolvedAt,
      });
    })();
    return this.requireTask(input.taskId);
  }

  setStatus(input: {
    taskId: string;
    expectedRevision: number;
    status: TaskStatus;
    summary: string;
    detail?: string | null;
    updatedAt: string;
    threadId?: string | null;
  }): TaskRecord {
    this.db.transaction(() => {
      this.setStatusInOpenTransaction(input);
    })();
    return this.requireTask(input.taskId);
  }

  setStatusInOpenTransaction(input: {
    taskId: string;
    expectedRevision: number;
    status: TaskStatus;
    summary: string;
    detail?: string | null;
    updatedAt: string;
    threadId?: string | null;
  }): void {
    this.bumpRevision(input.taskId, input.expectedRevision, input.updatedAt);
    this.db.query("UPDATE tasks SET status = ? WHERE task_id = ?").run(input.status, input.taskId);
    if (TERMINAL_TASK_STATUSES.has(input.status)) {
      this.abandonActiveArtifactRevisionsForTerminalTask(input.taskId, input.updatedAt);
    }
    if (input.status === "cancelled") {
      this.db
        .query(
          "UPDATE task_decisions SET status = 'superseded' WHERE task_id = ? AND decision_id IN (SELECT provisional_decision_id FROM task_questions WHERE task_id = ? AND status = 'pending' AND provisional_decision_id IS NOT NULL)",
        )
        .run(input.taskId, input.taskId);
      this.db
        .query(
          "UPDATE task_questions SET status = 'dismissed', resolved_at = ? WHERE task_id = ? AND status = 'pending'",
        )
        .run(input.updatedAt, input.taskId);
    }
    this.insertActivity({
      id: crypto.randomUUID(),
      seq: 1,
      taskId: input.taskId,
      threadId: input.threadId ?? null,
      workItemId: null,
      kind: "status_changed",
      summary: input.summary,
      detail: input.detail ?? null,
      createdAt: input.updatedAt,
    });
  }

  appendActivity(activity: TaskActivity, options?: { rejectTerminal?: boolean }): TaskRecord {
    this.db.transaction(() => {
      if (options?.rejectTerminal) this.assertTaskAcceptsMutation(activity.taskId);
      this.insertActivity(activity);
      this.db
        .query("UPDATE tasks SET updated_at = ? WHERE task_id = ?")
        .run(activity.createdAt, activity.taskId);
    })();
    return this.requireTask(activity.taskId);
  }

  appendActivityWithRevision(activity: TaskActivity, expectedRevision: number): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(activity.taskId, expectedRevision, activity.createdAt);
      this.insertActivity(activity);
    })();
    return this.requireTask(activity.taskId);
  }

  recordReview(input: {
    review: TaskReviewRecord;
    activity: TaskActivity;
    expectedRevision: number;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.review.taskId, input.expectedRevision, input.review.createdAt);
      this.insertReview(input.review);
      this.insertActivity(input.activity);
    })();
    return this.requireTask(input.review.taskId);
  }

  addressReview(input: {
    taskId: string;
    reviewId: string;
    expectedRevision: number;
    addressedAt: string;
    implementationSummary: string;
    activity: TaskActivity;
  }): TaskRecord {
    this.db.transaction(() => {
      this.bumpRevision(input.taskId, input.expectedRevision, input.addressedAt);
      const result = this.db
        .query(
          "UPDATE task_reviews SET addressed_at = ?, implementation_summary = ? WHERE task_id = ? AND review_id = ? AND verdict != 'pass' AND addressed_at IS NULL",
        )
        .run(input.addressedAt, input.implementationSummary, input.taskId, input.reviewId);
      if (Number(result.changes ?? 0) !== 1) {
        throw new Error(`Unknown unaddressed review: ${input.reviewId}`);
      }
      this.insertActivity(input.activity);
    })();
    return this.requireTask(input.taskId);
  }

  createCheckpoint(
    checkpoint: TaskCheckpoint,
    options?: { rejectTerminal?: boolean },
  ): TaskCheckpoint {
    this.db.transaction(() => {
      if (options?.rejectTerminal) this.assertTaskAcceptsMutation(checkpoint.taskId);
      this.insertCheckpoint(checkpoint);
    })();
    return checkpoint;
  }

  recordDirectiveReceiptWithCheckpoint(input: {
    taskId: string;
    idempotencyKey: string;
    resultRevision: number;
    receiptCreatedAt: string;
    checkpoint: TaskCheckpoint;
    checkpointOptions?: { rejectTerminal?: boolean };
  }): TaskCheckpoint | null {
    let createdCheckpoint: TaskCheckpoint | null = null;
    this.db.transaction(() => {
      if (this.getDirectiveReceipt(input.taskId, input.idempotencyKey) !== null) return;
      if (input.checkpointOptions?.rejectTerminal) this.assertTaskAcceptsMutation(input.taskId);
      this.insertCheckpoint(input.checkpoint);
      this.recordDirectiveReceipt(
        input.taskId,
        input.idempotencyKey,
        input.resultRevision,
        input.receiptCreatedAt,
      );
      createdCheckpoint = input.checkpoint;
    })();
    return createdCheckpoint;
  }

  getDirectiveReceipt(taskId: string, idempotencyKey: string): number | null {
    const row = this.db
      .query(
        "SELECT result_revision FROM task_directive_receipts WHERE task_id = ? AND idempotency_key = ?",
      )
      .get(taskId, idempotencyKey) as { result_revision: number } | null;
    return row ? Number(row.result_revision) : null;
  }

  recordDirectiveReceipt(
    taskId: string,
    idempotencyKey: string,
    resultRevision: number,
    createdAt: string,
  ): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO task_directive_receipts(task_id, idempotency_key, result_revision, created_at) VALUES(?, ?, ?, ?)",
      )
      .run(taskId, idempotencyKey, resultRevision, createdAt);
  }

  private insertCheckpoint(checkpoint: TaskCheckpoint): void {
    this.db
      .query(
        "INSERT INTO task_checkpoints(checkpoint_id, task_id, thread_id, task_revision, reason, agent_summary, context_digest, task_snapshot_json, artifact_manifest_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        checkpoint.id,
        checkpoint.taskId,
        checkpoint.threadId,
        checkpoint.taskRevision,
        checkpoint.reason,
        checkpoint.agentSummary,
        checkpoint.contextDigest,
        JSON.stringify(checkpoint.taskSnapshot),
        JSON.stringify(checkpoint.artifactManifest),
        checkpoint.createdAt,
      );
  }

  private bumpRevision(taskId: string, expectedRevision: number, updatedAt: string): void {
    const result = this.db
      .query(
        "UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?",
      )
      .run(updatedAt, taskId, expectedRevision);
    if (Number(result.changes ?? 0) !== 1) {
      const current = this.db.query("SELECT revision FROM tasks WHERE task_id = ?").get(taskId) as {
        revision: number;
      } | null;
      if (!current) throw new Error(`Unknown task: ${taskId}`);
      throw new Error(
        `Task revision conflict: expected ${expectedRevision}, current ${current.revision}`,
      );
    }
  }

  private assertTaskAcceptsMutation(taskId: string): void {
    const row = this.db.query("SELECT status FROM tasks WHERE task_id = ?").get(taskId) as {
      status: TaskStatus;
    } | null;
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    if (!TERMINAL_TASK_STATUSES.has(row.status)) return;
    throw new Error(
      `Task ${taskId} is ${row.status} and cannot be changed until it is reopened or retried.`,
    );
  }

  private insertDecision(decision: TaskDecision): void {
    if (decision.supersedes) {
      this.db
        .query(
          "UPDATE task_decisions SET status = 'superseded' WHERE task_id = ? AND decision_id = ?",
        )
        .run(decision.taskId, decision.supersedes);
    }
    this.db
      .query(
        "INSERT INTO task_decisions(decision_id, task_id, question, resolution, source, scope, confidence, status, created_at, supersedes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        decision.id,
        decision.taskId,
        decision.question,
        decision.resolution,
        decision.source,
        decision.scope,
        decision.confidence,
        decision.status,
        decision.createdAt,
        decision.supersedes,
      );
  }

  private bumpCurrentRevision(taskId: string, updatedAt: string): void {
    const result = this.db
      .query("UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE task_id = ?")
      .run(updatedAt, taskId);
    if (Number(result.changes ?? 0) !== 1) throw new Error(`Unknown task: ${taskId}`);
  }

  private upsertArtifact(artifact: TaskArtifact): void {
    this.db
      .query(
        "INSERT INTO task_artifacts(artifact_id, task_id, work_item_id, thread_id, path, kind, title, created_by, provenance_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, path) DO UPDATE SET work_item_id = excluded.work_item_id, thread_id = excluded.thread_id, kind = excluded.kind, title = excluded.title, provenance_json = excluded.provenance_json",
      )
      .run(
        artifact.id,
        artifact.taskId,
        artifact.workItemId,
        artifact.threadId,
        artifact.path,
        artifact.kind,
        artifact.title,
        artifact.createdBy,
        JSON.stringify(artifact.provenance),
        artifact.createdAt,
      );
  }

  private insertArtifactVersion(taskId: string, version: TaskArtifactVersion): void {
    const latest = this.db
      .query(
        "SELECT version_id, version_number FROM task_artifact_versions WHERE task_id = ? AND artifact_id = ? ORDER BY version_number DESC LIMIT 1",
      )
      .get(taskId, version.artifactId) as {
      version_id: string;
      version_number: number;
    } | null;
    const expectedVersion = Number(latest?.version_number ?? 0) + 1;
    if (version.version !== expectedVersion) {
      throw new Error(
        `Invalid artifact version number: expected ${expectedVersion}, received ${version.version}`,
      );
    }
    if ((latest?.version_id ?? null) !== version.parentVersionId) {
      throw new Error("Artifact version parent is not the current latest version");
    }
    this.db
      .query(
        "INSERT INTO task_artifact_versions(version_id, task_id, artifact_id, version_number, parent_version_id, sha256, size_bytes, media_type, created_by, created_at, change_summary, provenance_json, review_status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        version.id,
        taskId,
        version.artifactId,
        version.version,
        version.parentVersionId,
        version.sha256,
        version.sizeBytes,
        version.mediaType,
        version.createdBy,
        version.createdAt,
        version.changeSummary,
        JSON.stringify(version.provenance),
        version.reviewStatus,
      );
  }

  private supersedePendingArtifactVersions(artifactId: string): void {
    this.db
      .query(
        "UPDATE task_artifact_versions SET review_status = 'superseded' WHERE artifact_id = ? AND review_status = 'draft'",
      )
      .run(artifactId);
  }

  private abandonActiveArtifactRevisionsForTerminalTask(taskId: string, updatedAt: string): void {
    const rows = this.db
      .query(
        "SELECT work_item_id FROM task_artifact_revisions WHERE task_id = ? AND status = 'active'",
      )
      .all(taskId) as Array<{ work_item_id: string | null }>;
    this.db
      .query(
        "UPDATE task_artifact_revisions SET status = 'cancelled', settlement_status = 'none', updated_at = ?, completed_at = ? WHERE task_id = ? AND status = 'active'",
      )
      .run(updatedAt, updatedAt, taskId);
    for (const row of rows) {
      this.abandonRevisionWorkItem(taskId, row.work_item_id, updatedAt);
    }
  }

  private abandonRevisionWorkItem(
    taskId: string,
    workItemId: string | null,
    updatedAt: string,
  ): void {
    if (!workItemId) return;
    this.db
      .query(
        "UPDATE task_work_items SET status = 'abandoned', completion_evidence = COALESCE(completion_evidence, 'Artifact revision abandoned because the task is terminal'), updated_at = ? WHERE task_id = ? AND work_item_id = ? AND status NOT IN ('done', 'abandoned')",
      )
      .run(updatedAt, taskId, workItemId);
    this.db.query("DELETE FROM task_work_item_claims WHERE work_item_id = ?").run(workItemId);
  }

  private moveArtifactWorkItemToReview(
    taskId: string,
    workItemId: string | null,
    updatedAt: string,
  ): void {
    if (!workItemId) return;
    this.db
      .query(
        "UPDATE task_work_items SET status = 'review', completion_evidence = COALESCE(completion_evidence, 'Artifact ready for review'), updated_at = ? WHERE task_id = ? AND work_item_id = ? AND status NOT IN ('done', 'abandoned')",
      )
      .run(updatedAt, taskId, workItemId);
    this.db.query("DELETE FROM task_work_item_claims WHERE work_item_id = ?").run(workItemId);
  }

  private requireArtifactRevisionRow(revisionId: string): Record<string, unknown> {
    const row = this.db
      .query("SELECT * FROM task_artifact_revisions WHERE revision_id = ?")
      .get(revisionId) as Record<string, unknown> | null;
    if (!row) throw new Error(`Unknown artifact revision: ${revisionId}`);
    return row;
  }

  private mapArtifact(row: Record<string, unknown>, taskId: string): TaskArtifact {
    return {
      id: String(row.artifact_id),
      taskId,
      workItemId: typeof row.work_item_id === "string" ? row.work_item_id : null,
      threadId: typeof row.thread_id === "string" ? row.thread_id : null,
      path: String(row.path),
      kind: String(row.kind),
      title: String(row.title),
      createdBy: String(row.created_by),
      provenance: parseJsonObject(row.provenance_json),
      createdAt: String(row.created_at),
    };
  }

  private mapArtifactVersion(row: Record<string, unknown>): TaskArtifactVersion {
    return {
      id: String(row.version_id),
      artifactId: String(row.artifact_id),
      version: Number(row.version_number),
      parentVersionId: typeof row.parent_version_id === "string" ? row.parent_version_id : null,
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      mediaType: String(row.media_type),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      changeSummary: String(row.change_summary),
      provenance: parseJsonObject(row.provenance_json),
      reviewStatus: row.review_status as TaskArtifactVersion["reviewStatus"],
    };
  }

  private mapArtifactRevision(row: Record<string, unknown>): TaskArtifactRevision {
    return {
      id: String(row.revision_id),
      taskId: String(row.task_id),
      artifactId: String(row.artifact_id),
      workItemId: String(row.work_item_id),
      taskThreadId: String(row.task_thread_id),
      sessionId: String(row.session_id),
      baseVersionId: String(row.base_version_id),
      priorVersionId: String(row.prior_version_id),
      status: row.status as TaskArtifactRevision["status"],
      instruction: String(row.instruction),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    };
  }

  private mapReview(row: Record<string, unknown>): TaskReviewRecord {
    return {
      id: String(row.review_id),
      taskId: String(row.task_id),
      round: Number(row.round),
      verdict: row.verdict as TaskReviewRecord["verdict"],
      feedback: String(row.feedback),
      reviewerAgentId: String(row.reviewer_agent_id),
      reviewerProvider: String(row.reviewer_provider),
      reviewerModel: String(row.reviewer_model),
      taskRevision: Number(row.task_revision),
      materialFingerprint: String(row.material_fingerprint),
      materialSnapshot: parseJsonObject(row.material_snapshot_json),
      createdAt: String(row.created_at),
      addressedAt: typeof row.addressed_at === "string" ? row.addressed_at : null,
      implementationSummary:
        typeof row.implementation_summary === "string" ? row.implementation_summary : null,
    };
  }

  private insertReview(review: TaskReviewRecord): void {
    this.db
      .query(
        "INSERT INTO task_reviews(review_id, task_id, round, verdict, feedback, reviewer_agent_id, reviewer_provider, reviewer_model, task_revision, material_fingerprint, material_snapshot_json, created_at, addressed_at, implementation_summary) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        review.id,
        review.taskId,
        review.round,
        review.verdict,
        review.feedback,
        review.reviewerAgentId,
        review.reviewerProvider,
        review.reviewerModel,
        review.taskRevision,
        review.materialFingerprint,
        JSON.stringify(review.materialSnapshot),
        review.createdAt,
        review.addressedAt,
        review.implementationSummary,
      );
  }

  private insertThread(thread: TaskThread): void {
    this.db
      .query(
        "INSERT INTO task_threads(thread_id, task_id, session_id, title, created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        thread.id,
        thread.taskId,
        thread.sessionId,
        thread.title,
        thread.createdBy,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  private insertActivity(activity: TaskActivity): void {
    const current = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS seq FROM task_activity WHERE task_id = ?")
      .get(activity.taskId) as { seq: number };
    const nextSeq = Number(current.seq) + 1;
    this.db
      .query(
        "INSERT INTO task_activity(activity_id, task_id, seq, thread_id, work_item_id, kind, summary, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        activity.id,
        activity.taskId,
        nextSeq,
        activity.threadId,
        activity.workItemId,
        activity.kind,
        activity.summary,
        activity.detail,
        activity.createdAt,
      );
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private toSummary(task: TaskRecord): TaskSummary {
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
    return summary;
  }

  private mapTask(row: TaskRow): TaskRecord {
    const requirements = (
      this.db
        .query(
          "SELECT * FROM task_requirements WHERE task_id = ? ORDER BY created_at, requirement_id",
        )
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map(
      (item): TaskRequirement => ({
        id: String(item.requirement_id),
        kind: item.kind as TaskRequirement["kind"],
        text: String(item.text),
        source: item.source as TaskRequirement["source"],
        permanence: item.permanence as TaskRequirement["permanence"],
        status: item.status as TaskRequirement["status"],
        createdAt: String(item.created_at),
        supersedes: typeof item.supersedes === "string" ? item.supersedes : null,
      }),
    );
    const threads = (
      this.db
        .query("SELECT * FROM task_threads WHERE task_id = ? ORDER BY created_at, thread_id")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map(
      (item): TaskThread => ({
        id: String(item.thread_id),
        taskId: row.task_id,
        sessionId: String(item.session_id),
        title: String(item.title),
        createdBy: item.created_by as TaskThread["createdBy"],
        createdAt: String(item.created_at),
        updatedAt: String(item.updated_at),
      }),
    );
    const dependencyRows = this.db
      .query(
        "SELECT work_item_id, depends_on_work_item_id FROM task_work_item_dependencies WHERE task_id = ?",
      )
      .all(row.task_id) as Array<{ work_item_id: string; depends_on_work_item_id: string }>;
    const dependencies = new Map<string, string[]>();
    for (const dependency of dependencyRows) {
      const current = dependencies.get(dependency.work_item_id) ?? [];
      current.push(dependency.depends_on_work_item_id);
      dependencies.set(dependency.work_item_id, current);
    }
    const claims = new Map(
      (
        this.db
          .query("SELECT work_item_id, thread_id FROM task_work_item_claims WHERE task_id = ?")
          .all(row.task_id) as Array<{ work_item_id: string; thread_id: string }>
      ).map((item) => [item.work_item_id, item.thread_id]),
    );
    const workItems = (
      this.db
        .query("SELECT * FROM task_work_items WHERE task_id = ? ORDER BY position, created_at")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map((item): WorkItem => {
      const id = String(item.work_item_id);
      return {
        id,
        taskId: row.task_id,
        title: String(item.title),
        description: String(item.description),
        status: item.status as WorkItem["status"],
        dependsOn: dependencies.get(id) ?? [],
        assignedThreadId:
          typeof item.assigned_thread_id === "string" ? item.assigned_thread_id : null,
        claimedByThreadId: claims.get(id) ?? null,
        expectedOutputs: parseJsonArray(item.expected_outputs_json),
        completionEvidence:
          typeof item.completion_evidence === "string" ? item.completion_evidence : null,
        position: Number(item.position),
        createdAt: String(item.created_at),
        updatedAt: String(item.updated_at),
      };
    });
    const decisions = (
      this.db
        .query("SELECT * FROM task_decisions WHERE task_id = ? ORDER BY created_at, decision_id")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map(
      (item): TaskDecision => ({
        id: String(item.decision_id),
        taskId: row.task_id,
        question: String(item.question),
        resolution: String(item.resolution),
        source: item.source as TaskDecision["source"],
        scope: item.scope as TaskDecision["scope"],
        confidence: typeof item.confidence === "number" ? item.confidence : null,
        status: item.status as TaskDecision["status"],
        createdAt: String(item.created_at),
        supersedes: typeof item.supersedes === "string" ? item.supersedes : null,
      }),
    );
    const questions = (
      this.db
        .query("SELECT * FROM task_questions WHERE task_id = ? ORDER BY created_at, rowid")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map(
      (item): TaskQuestion => ({
        id: String(item.question_id),
        taskId: row.task_id,
        threadId: typeof item.thread_id === "string" ? item.thread_id : null,
        workItemId: typeof item.work_item_id === "string" ? item.work_item_id : null,
        header: String(item.header),
        question: String(item.question),
        context: String(item.context),
        blocking: bool(item.blocking),
        urgency: item.urgency as TaskQuestion["urgency"],
        defaultAction: typeof item.default_action === "string" ? item.default_action : null,
        options: parseQuestionOptions(item.options_json),
        recommendedOptionId:
          typeof item.recommended_option_id === "string" ? item.recommended_option_id : null,
        status: item.status as TaskQuestion["status"],
        provisionalDecisionId:
          typeof item.provisional_decision_id === "string" ? item.provisional_decision_id : null,
        answer: typeof item.answer === "string" ? item.answer : null,
        answerOptionId: typeof item.answer_option_id === "string" ? item.answer_option_id : null,
        resolutionSource:
          item.resolution_source === "user" || item.resolution_source === "default"
            ? item.resolution_source
            : null,
        supersedes: typeof item.supersedes === "string" ? item.supersedes : null,
        createdAt: String(item.created_at),
        resolvedAt: typeof item.resolved_at === "string" ? item.resolved_at : null,
      }),
    );
    const artifacts = (
      this.db
        .query("SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at, artifact_id")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map((item) => this.mapArtifact(item, row.task_id));
    const blockers = (
      this.db
        .query("SELECT * FROM task_blockers WHERE task_id = ? ORDER BY created_at, blocker_id")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map(
      (item): TaskBlocker => ({
        id: String(item.blocker_id),
        taskId: row.task_id,
        workItemId: typeof item.work_item_id === "string" ? item.work_item_id : null,
        description: String(item.description),
        blocking: bool(item.blocking),
        status: item.status as TaskBlocker["status"],
        createdAt: String(item.created_at),
        resolvedAt: typeof item.resolved_at === "string" ? item.resolved_at : null,
      }),
    );
    const activity = (
      this.db
        .query("SELECT * FROM task_activity WHERE task_id = ? ORDER BY seq DESC LIMIT 200")
        .all(row.task_id) as Array<Record<string, unknown>>
    ).map(
      (item): TaskActivity => ({
        id: String(item.activity_id),
        seq: Number(item.seq),
        taskId: row.task_id,
        threadId: typeof item.thread_id === "string" ? item.thread_id : null,
        workItemId: typeof item.work_item_id === "string" ? item.work_item_id : null,
        kind: item.kind as TaskActivityKind,
        summary: String(item.summary),
        detail: typeof item.detail === "string" ? item.detail : null,
        createdAt: String(item.created_at),
      }),
    );
    const checkpointRow = this.db
      .query("SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(row.task_id) as Record<string, unknown> | null;
    const latestCheckpoint: TaskCheckpoint | null = checkpointRow
      ? {
          id: String(checkpointRow.checkpoint_id),
          taskId: row.task_id,
          threadId: typeof checkpointRow.thread_id === "string" ? checkpointRow.thread_id : null,
          taskRevision: Number(checkpointRow.task_revision),
          reason: String(checkpointRow.reason),
          agentSummary: String(checkpointRow.agent_summary),
          contextDigest: String(checkpointRow.context_digest),
          taskSnapshot: parseJsonObject(checkpointRow.task_snapshot_json),
          artifactManifest: parseArtifactManifest(checkpointRow.artifact_manifest_json),
          createdAt: String(checkpointRow.created_at),
        }
      : null;
    return {
      id: row.task_id,
      workspacePath: row.workspace_path,
      title: row.title,
      objective: row.objective,
      context: row.context,
      sourceSessionId: row.source_session_id,
      creationOrigin: row.creation_origin,
      status: row.status,
      revision: Number(row.revision),
      reviewRequired: bool(row.review_required),
      reviewRounds: Number(row.review_rounds ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      threadCount: threads.length,
      completedWorkItemCount: workItems.filter((item) => item.status === "done").length,
      totalWorkItemCount: workItems.length,
      activeBlockerCount: blockers.filter((item) => item.status === "active").length,
      pendingQuestionCount: questions.filter((item) => item.status === "pending").length,
      blockingQuestionCount: questions.filter((item) => item.status === "pending" && item.blocking)
        .length,
      requirements,
      threads,
      workItems,
      decisions,
      questions,
      artifacts,
      blockers,
      activity,
      latestCheckpoint,
    };
  }
}
