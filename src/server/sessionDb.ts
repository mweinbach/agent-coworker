import { Database } from "bun:sqlite";
import path from "node:path";

import type { AiCoworkerPaths } from "../connect";
import type { SessionUsageSnapshot } from "../session/costTracker";
import type { AgentProfileSnapshot } from "../shared/agentProfiles";
import type {
  AgentExecutionState,
  AgentMode,
  AgentReasoningEffort,
  AgentRole,
  AgentTaskType,
  PersistentAgentSummary,
  SessionKind,
} from "../shared/agents";
import type { ProviderContinuationState } from "../shared/providerContinuation";
import type { SessionSnapshot } from "../shared/sessionSnapshot";
import type {
  TaskActivity,
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskArtifactRevisionStatus,
  TaskArtifactVersion,
  TaskBlocker,
  TaskCheckpoint,
  TaskDecision,
  TaskRecord,
  TaskReviewRecord,
  TaskStatus,
  TaskSummary,
  TaskThread,
  WorkItemStatus,
} from "../shared/tasks";
import type { AgentConfig, HarnessContextState, ModelMessage, TodoItem } from "../types";
import type { ModelStreamRawFormat } from "./modelStream";
import type { ResearchRecord } from "./research/types";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  quarantineCorruptedDb,
} from "./sessionDb/fileHardening";
import { importLegacySnapshots } from "./sessionDb/legacyImport";
import { bootstrapSessionDb } from "./sessionDb/migrations";
import { isCorruptionError } from "./sessionDb/normalizers";
import { SessionDbRepository } from "./sessionDb/repository";
import {
  type CreateTaskInput,
  type QueueTaskQuestionsInput,
  type ResolveTaskQuestionsInput,
  SessionTaskRepository,
  type StartTaskArtifactRevisionInput,
  type TaskRequirementInput,
  type UpdateTaskPlanInput,
  type WorkItemInput,
} from "./sessionDb/tasks";
import type { SessionDbWriteLockDiagnostics } from "./sessionDb/writeCoordinator";
import { SessionDbWriteCoordinator } from "./sessionDb/writeCoordinator";
import type { PersistedSessionSummary } from "./sessionStore";
import type { SessionTitleSource } from "./sessionTitleService";

export type { PersistedSessionSummary } from "./sessionStore";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const ANONYMOUS_IN_MEMORY_DB_PATH = ":memory:";

export type SessionPersistenceStatus = "active" | "closed";

export type PersistedSessionRecord = {
  sessionId: string;
  sessionKind: SessionKind;
  parentSessionId: string | null;
  role: AgentRole | null;
  mode?: AgentMode | null;
  depth?: number | null;
  nickname?: string | null;
  taskType?: AgentTaskType | null;
  targetPaths?: string[] | null;
  profile?: AgentProfileSnapshot | null;
  requestedModel?: string | null;
  effectiveModel?: string | null;
  requestedReasoningEffort?: AgentReasoningEffort | null;
  effectiveReasoningEffort?: AgentReasoningEffort | null;
  executionState?: AgentExecutionState | null;
  lastMessagePreview?: string | null;
  title: string;
  titleSource: SessionTitleSource;
  titleModel: string | null;
  provider: AgentConfig["provider"];
  model: string;
  workingDirectory: string;
  outputDirectory?: string;
  uploadsDirectory?: string;
  providerOptions?: AgentConfig["providerOptions"];
  sandbox?: AgentConfig["sandbox"];
  enableMcp: boolean;
  backupsEnabledOverride: boolean | null;
  createdAt: string;
  updatedAt: string;
  status: SessionPersistenceStatus;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
  messageCount: number;
  lastEventSeq: number;
  systemPrompt: string;
  messages: ModelMessage[];
  lastMemoryGeneratedIndex?: number;
  providerState: ProviderContinuationState | null;
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
  costTracker: SessionUsageSnapshot | null;
};

export type PersistedSessionMutation = {
  sessionId: string;
  eventType: string;
  eventTs?: string;
  direction?: "client" | "server" | "system";
  payload?: unknown;
  snapshot: {
    sessionKind: SessionKind;
    parentSessionId: string | null;
    role: AgentRole | null;
    mode?: AgentMode | null;
    depth?: number | null;
    nickname?: string | null;
    taskType?: AgentTaskType | null;
    targetPaths?: string[] | null;
    profile?: AgentProfileSnapshot | null;
    requestedModel?: string | null;
    effectiveModel?: string | null;
    requestedReasoningEffort?: AgentReasoningEffort | null;
    effectiveReasoningEffort?: AgentReasoningEffort | null;
    executionState?: AgentExecutionState | null;
    lastMessagePreview?: string | null;
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
    providerOptions?: AgentConfig["providerOptions"];
    sandbox?: AgentConfig["sandbox"];
    enableMcp: boolean;
    backupsEnabledOverride: boolean | null;
    createdAt: string;
    updatedAt: string;
    status: SessionPersistenceStatus;
    hasPendingAsk: boolean;
    hasPendingApproval: boolean;
    systemPrompt: string;
    messages: ModelMessage[];
    lastMemoryGeneratedIndex?: number | null;
    providerState: ProviderContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
    costTracker: SessionUsageSnapshot | null;
  };
};

export type PersistedModelStreamChunk = {
  sessionId: string;
  turnId: string;
  chunkIndex: number;
  ts: string;
  provider: AgentConfig["provider"];
  model: string;
  rawFormat: ModelStreamRawFormat;
  normalizerVersion: number;
  rawEvent: unknown;
};

export type PersistedThreadJournalEvent = {
  threadId: string;
  seq: number;
  ts: string;
  eventType: string;
  turnId: string | null;
  itemId: string | null;
  requestId: string | null;
  payload: unknown;
};

export type PersistedThreadJournalFailure = {
  threadId: string;
  failedWriteCount: number;
  droppedEventCount: number;
  lastFailureAt: string;
  lastFailureMessage: string;
};

export type PersistedResearchRecord = ResearchRecord;

type SessionDbOptions = {
  paths: Pick<AiCoworkerPaths, "rootDir" | "sessionsDir">;
  dbPath?: string;
  busyTimeoutMs?: number;
  emitTelemetry?: (
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number,
  ) => void;
};

export type TaskDirectiveCommitHooks = {
  create: (task: TaskRecord) => {
    idempotencyKey: string;
    receiptCreatedAt: string;
    checkpoint: TaskCheckpoint;
  };
  onCommitted?: (task: TaskRecord, checkpoint: TaskCheckpoint | null) => void;
};

export class SessionDb {
  readonly dbPath: string;

  private readonly db: Database;
  private readonly committedReadDb: Database;
  private readonly sessionsDir: string;
  private readonly busyTimeoutMs: number;
  private readonly repository: SessionDbRepository;
  private readonly committedReadRepository: SessionDbRepository;
  private readonly taskRepository: SessionTaskRepository;
  private readonly committedReadTaskRepository: SessionTaskRepository;
  private readonly writeCoordinator: SessionDbWriteCoordinator;

  private constructor(opts: {
    db: Database;
    dbPath: string;
    sessionsDir: string;
    busyTimeoutMs: number;
    writeCoordinator: SessionDbWriteCoordinator;
  }) {
    this.db = opts.db;
    this.committedReadDb = new Database(opts.dbPath, { readonly: true, strict: false });
    this.dbPath = opts.dbPath;
    this.sessionsDir = opts.sessionsDir;
    this.busyTimeoutMs = opts.busyTimeoutMs;
    this.committedReadDb.exec(
      `PRAGMA busy_timeout=${Math.max(0, Math.floor(opts.busyTimeoutMs))};`,
    );
    this.committedReadDb.exec("PRAGMA foreign_keys=ON;");
    this.repository = new SessionDbRepository(this.db);
    this.committedReadRepository = new SessionDbRepository(this.committedReadDb);
    this.taskRepository = new SessionTaskRepository(this.db);
    this.committedReadTaskRepository = new SessionTaskRepository(this.committedReadDb);
    this.writeCoordinator = opts.writeCoordinator;
  }

  static async create(opts: SessionDbOptions): Promise<SessionDb> {
    await ensurePrivateDirectory(opts.paths.rootDir);

    const dbPath = opts.dbPath ?? path.join(opts.paths.rootDir, "sessions.db");
    if (dbPath === ANONYMOUS_IN_MEMORY_DB_PATH) {
      throw new Error(
        "SessionDb requires a durable file-backed database path; anonymous in-memory databases cannot provide committed-reader isolation.",
      );
    }
    const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    const writeCoordinator = new SessionDbWriteCoordinator({
      rootDir: opts.paths.rootDir,
      emitTelemetry: opts.emitTelemetry,
    });
    let db: Database;
    try {
      db = new Database(dbPath, { create: true, strict: false });
    } catch (error) {
      throw new Error(`Failed to open session database at ${dbPath}: ${String(error)}`);
    }

    const repo = new SessionDb({
      db,
      dbPath,
      sessionsDir: opts.paths.sessionsDir,
      busyTimeoutMs,
      writeCoordinator,
    });

    try {
      await repo.bootstrap();
      await repo.hardenDbFile();
      return repo;
    } catch (error) {
      if (!isCorruptionError(error)) {
        repo.close();
        throw error;
      }

      repo.close();
      await quarantineCorruptedDb(dbPath);

      const recreated = new Database(dbPath, { create: true, strict: false });
      const recoveredRepo = new SessionDb({
        db: recreated,
        dbPath,
        sessionsDir: opts.paths.sessionsDir,
        busyTimeoutMs,
        writeCoordinator,
      });
      await recoveredRepo.bootstrap();
      await recoveredRepo.hardenDbFile();
      return recoveredRepo;
    }
  }

  close(): void {
    let needsStatementFinalization = false;
    const closeDatabase = (database: Database) => {
      try {
        database.close(true);
      } catch (error) {
        if (!String(error).toLowerCase().includes("database is locked")) throw error;
        // Bun's cached SQLite statements can keep a WAL handle alive after
        // sqlite3_close_v2 on Windows. Closing in deferred mode and forcing
        // finalization releases those native handles before close() returns.
        database.close();
        needsStatementFinalization = true;
      }
    };
    closeDatabase(this.committedReadDb);
    closeDatabase(this.db);
    if (needsStatementFinalization) Bun.gc(true);
  }

  private recordTaskDirectiveCommitInOpenTransaction(
    task: TaskRecord,
    hooks?: TaskDirectiveCommitHooks,
  ): TaskCheckpoint | null {
    if (!hooks) return null;
    const commit = hooks.create(task);
    return this.taskRepository.recordDirectiveReceiptWithCheckpoint({
      taskId: task.id,
      idempotencyKey: commit.idempotencyKey,
      resultRevision: task.revision,
      receiptCreatedAt: commit.receiptCreatedAt,
      checkpoint: commit.checkpoint,
      checkpointOptions: { rejectTerminal: false },
    });
  }

  private notifyTaskDirectiveCommitted(
    task: TaskRecord,
    checkpoint: TaskCheckpoint | null,
    hooks?: TaskDirectiveCommitHooks,
  ): void {
    hooks?.onCommitted?.(task, checkpoint);
  }

  private get readRepository(): SessionDbRepository {
    return this.writeCoordinator.ownsCurrentContext()
      ? this.repository
      : this.committedReadRepository;
  }

  private get readTaskRepository(): SessionTaskRepository {
    return this.writeCoordinator.ownsCurrentContext()
      ? this.taskRepository
      : this.committedReadTaskRepository;
  }

  listSessions(opts?: { workingDirectory?: string | null }): PersistedSessionSummary[] {
    return this.readRepository.listSessions(opts);
  }

  listAgentSessions(parentSessionId: string): PersistentAgentSummary[] {
    return this.readRepository.listAgentSessions(parentSessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "delete_session",
      async () => {
        this.repository.deleteSession(sessionId);
      },
      { sessionId },
    );
  }

  getMessages(
    sessionId: string,
    offset = 0,
    limit = 100,
  ): { messages: ModelMessage[]; total: number } {
    return this.readRepository.getMessages(sessionId, offset, limit);
  }

  getSessionRecord(sessionId: string): PersistedSessionRecord | null {
    return this.readRepository.getSessionRecord(sessionId);
  }

  getSessionSnapshot(sessionId: string): SessionSnapshot | null {
    return this.readRepository.getSessionSnapshot(sessionId);
  }

  async persistSessionMutation(opts: PersistedSessionMutation): Promise<number> {
    return await this.writeCoordinator.runExclusive(
      "persist_session_mutation",
      async () => this.repository.persistSessionMutation(opts),
      { sessionId: opts.sessionId, eventType: opts.eventType },
    );
  }

  async persistModelStreamChunk(opts: PersistedModelStreamChunk): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "persist_model_stream_chunk",
      async () => {
        this.repository.persistModelStreamChunk(opts);
      },
      { sessionId: opts.sessionId, turnId: opts.turnId },
    );
  }

  listModelStreamChunks(sessionId: string, turnId?: string): PersistedModelStreamChunk[] {
    return this.readRepository.listModelStreamChunks(sessionId, turnId);
  }

  async appendThreadJournalEvent(opts: Omit<PersistedThreadJournalEvent, "seq">): Promise<number> {
    return await this.writeCoordinator.runExclusive(
      "append_thread_journal_event",
      async () => this.repository.appendThreadJournalEvent(opts),
      { threadId: opts.threadId, eventType: opts.eventType },
    );
  }

  async appendThreadJournalEvents(
    opts: Array<Omit<PersistedThreadJournalEvent, "seq">>,
  ): Promise<number[]> {
    if (opts.length === 0) {
      return [];
    }
    return await this.writeCoordinator.runExclusive(
      "append_thread_journal_events",
      async () => this.repository.appendThreadJournalEvents(opts),
      {
        threadId: opts[0]?.threadId ?? "unknown",
        batchSize: opts.length,
      },
    );
  }

  listThreadJournalEvents(
    threadId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): PersistedThreadJournalEvent[] {
    return this.readRepository.listThreadJournalEvents(threadId, opts);
  }

  getThreadJournalTailSeq(threadId: string): number {
    return this.readRepository.getThreadJournalTailSeq(threadId);
  }

  getThreadJournalFailure(threadId: string): PersistedThreadJournalFailure | null {
    return this.readRepository.getThreadJournalFailure(threadId);
  }

  async recordThreadJournalFailure(input: PersistedThreadJournalFailure): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "record_thread_journal_failure",
      async () => {
        this.repository.recordThreadJournalFailure(input);
      },
      { threadId: input.threadId },
    );
  }

  getThreadIdByCreationKey(creationKey: string): string | null {
    return this.readRepository.getThreadIdByCreationKey(creationKey);
  }

  async rememberThreadCreationKey(creationKey: string, threadId: string): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "remember_thread_creation_key",
      async () => {
        this.repository.rememberThreadCreationKey(creationKey, threadId);
      },
      { threadId },
    );
  }

  getWriteLockDiagnostics(): SessionDbWriteLockDiagnostics {
    return this.writeCoordinator.getDiagnostics();
  }

  listResearch(opts?: { workspacePath?: string | null }): PersistedResearchRecord[] {
    return this.readRepository.listResearch(opts);
  }

  listRunningResearch(opts?: { workspacePath?: string | null }): PersistedResearchRecord[] {
    return this.readRepository.listRunningResearch(opts);
  }

  getResearch(
    researchId: string,
    opts?: { workspacePath?: string | null },
  ): PersistedResearchRecord | null {
    return this.readRepository.getResearch(researchId, opts);
  }

  async upsertResearch(record: PersistedResearchRecord): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "upsert_research",
      async () => {
        this.repository.upsertResearch(record);
      },
      { researchId: record.id, status: record.status },
    );
  }

  listTasks(workspacePath?: string | null): TaskSummary[] {
    return this.readTaskRepository.listTasks(workspacePath);
  }

  getTask(taskId: string): TaskRecord | null {
    return this.readTaskRepository.getTask(taskId);
  }

  getTaskForThread(sessionId: string): TaskRecord | null {
    return this.readTaskRepository.getTaskForThread(sessionId);
  }

  listTaskReviews(taskId: string): TaskReviewRecord[] {
    return this.readTaskRepository.listReviews(taskId);
  }

  getTaskByCreationKey(
    idempotencyKey: string,
    scope?: { sourceSessionId?: string | null; workspacePath?: string },
  ): TaskRecord | null {
    return this.readTaskRepository.getTaskByCreationKey(idempotencyKey, scope);
  }

  getActiveTaskForSourceSession(sessionId: string): TaskRecord | null {
    return this.readTaskRepository.getActiveTaskForSourceSession(sessionId);
  }

  isTaskThread(sessionId: string): boolean {
    return this.readTaskRepository.isTaskThread(sessionId);
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "create_task",
      async () => this.taskRepository.createTask(input),
      { taskId: input.id },
    );
  }

  async addTaskThread(thread: TaskThread, expectedRevision: number): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "add_task_thread",
      async () => this.taskRepository.addThread(thread, expectedRevision),
      { taskId: thread.taskId, threadId: thread.id },
    );
  }

  async updateTaskBrief(input: {
    taskId: string;
    expectedRevision: number;
    title?: string;
    objective?: string;
    requirements?: TaskRequirementInput[];
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "update_task_brief",
      async () => this.taskRepository.updateBrief(input),
      { taskId: input.taskId },
    );
  }

  async replaceTaskWorkItems(input: {
    taskId: string;
    expectedRevision: number;
    items: WorkItemInput[];
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "replace_task_work_items",
      async () => this.taskRepository.replaceWorkItems(input),
      { taskId: input.taskId },
    );
  }

  async updateTaskPlan(input: UpdateTaskPlanInput): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "update_task_plan",
      async () => this.taskRepository.updatePlan(input),
      { taskId: input.taskId },
    );
  }

  async updateTaskWorkItem(input: {
    taskId: string;
    workItemId: string;
    expectedRevision: number;
    status: WorkItemStatus;
    completionEvidence?: string;
    updatedAt: string;
    threadId?: string | null;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "update_task_work_item",
      async () => this.taskRepository.updateWorkItem(input),
      { taskId: input.taskId, workItemId: input.workItemId },
    );
  }

  async claimTaskWorkItem(input: {
    taskId: string;
    workItemId: string;
    threadId: string;
    expectedRevision: number;
    claimedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "claim_task_work_item",
      async () => this.taskRepository.claimWorkItem(input),
      { taskId: input.taskId, workItemId: input.workItemId, threadId: input.threadId },
    );
  }

  async recordTaskDecision(
    decision: TaskDecision,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "record_task_decision",
      async () => this.taskRepository.recordDecision(decision, expectedRevision, updatedAt),
      { taskId: decision.taskId },
    );
  }

  async queueTaskQuestions(input: QueueTaskQuestionsInput): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "queue_task_questions",
      async () => this.taskRepository.queueQuestions(input),
      { taskId: input.taskId, questionCount: input.questions.length },
    );
  }

  async resolveTaskQuestions(input: ResolveTaskQuestionsInput): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "resolve_task_questions",
      async () => this.taskRepository.resolveQuestions(input),
      { taskId: input.taskId, answerCount: input.resolutions.length },
    );
  }

  async defaultPendingTaskQuestions(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "default_pending_task_questions",
      async () => this.taskRepository.defaultPendingQuestions(input),
      { taskId: input.taskId },
    );
  }

  async registerTaskArtifact(
    artifact: TaskArtifact,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "register_task_artifact",
      async () => this.taskRepository.registerArtifact(artifact, expectedRevision, updatedAt),
      { taskId: artifact.taskId },
    );
  }

  getTaskArtifactDetail(taskId: string, artifactId: string): TaskArtifactDetail | null {
    return this.readTaskRepository.getArtifactDetail(taskId, artifactId);
  }

  getTaskArtifactVersion(
    taskId: string,
    artifactId: string,
    versionId: string,
  ): TaskArtifactVersion | null {
    return this.readTaskRepository.getArtifactVersion(taskId, artifactId, versionId);
  }

  getActiveTaskArtifactRevisionForSession(sessionId: string): TaskArtifactRevision | null {
    return this.readTaskRepository.getActiveArtifactRevisionForSession(sessionId);
  }

  getTaskArtifactRevisionForSession(sessionId: string): TaskArtifactRevision | null {
    return this.readTaskRepository.getArtifactRevisionForSession(sessionId);
  }

  getTaskArtifactRevision(revisionId: string): TaskArtifactRevision | null {
    return this.readTaskRepository.getArtifactRevision(revisionId);
  }

  getTaskArtifactRevisionPriorTaskStatus(revisionId: string): TaskStatus | null {
    return this.readTaskRepository.getArtifactRevisionPriorTaskStatus(revisionId);
  }

  hasCompletedTaskArtifactRevisionForWorkItem(taskId: string, workItemId: string): boolean {
    return this.readTaskRepository.hasCompletedArtifactRevisionForWorkItem(taskId, workItemId);
  }

  hasPendingTaskArtifactRevisionSettlement(taskId: string): boolean {
    return this.readTaskRepository.hasPendingArtifactRevisionSettlement(taskId);
  }

  hasPendingTaskArtifactRevisionSettlementForWorkItem(taskId: string, workItemId: string): boolean {
    return this.readTaskRepository.hasPendingArtifactRevisionSettlementForWorkItem(
      taskId,
      workItemId,
    );
  }

  listPendingTaskArtifactRevisionSettlementIds(taskId: string): string[] {
    return this.readTaskRepository.listPendingArtifactRevisionSettlementIds(taskId);
  }

  listTaskArtifactRevisionOutputPathsForWorkItem(taskId: string, workItemId: string): string[] {
    return this.readTaskRepository.listArtifactRevisionOutputPathsForWorkItem(taskId, workItemId);
  }

  listCoordinatorOwnedTaskArtifactRevisionWorkItemIds(taskId: string): string[] {
    return this.readTaskRepository.listCoordinatorOwnedArtifactRevisionWorkItemIds(taskId);
  }

  hasCancelledTaskArtifactRevisionForWorkItem(taskId: string, workItemId: string): boolean {
    return this.readTaskRepository.hasCancelledArtifactRevisionForWorkItem(taskId, workItemId);
  }

  async registerTaskArtifactVersioned(input: {
    artifact: TaskArtifact;
    version: TaskArtifactVersion;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "register_task_artifact_versioned",
      async () => this.taskRepository.registerArtifactVersioned(input),
      { taskId: input.artifact.taskId, artifactId: input.artifact.id },
    );
  }

  async registerTaskArtifactBaseline(input: {
    taskId: string;
    artifactId: string;
    version: TaskArtifactVersion;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<TaskArtifactDetail> {
    return await this.writeCoordinator.runExclusive(
      "register_task_artifact_baseline",
      async () => this.taskRepository.registerArtifactBaseline(input),
      { taskId: input.taskId, artifactId: input.artifactId },
    );
  }

  async captureTaskArtifactVersion(input: {
    taskId: string;
    artifactId: string;
    version: TaskArtifactVersion;
    expectedRevision: number;
    updatedAt: string;
    activityKind?: "artifact_version_captured" | "artifact_version_restored";
  }): Promise<TaskArtifactDetail> {
    return await this.writeCoordinator.runExclusive(
      "capture_task_artifact_version",
      async () => this.taskRepository.captureArtifactVersion(input),
      { taskId: input.taskId, artifactId: input.artifactId },
    );
  }

  async startTaskArtifactRevision(input: StartTaskArtifactRevisionInput): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "start_task_artifact_revision",
      async () => this.taskRepository.startArtifactRevision(input),
      { taskId: input.revision.taskId, artifactId: input.revision.artifactId },
    );
  }

  async completeTaskArtifactRevision(input: {
    revisionId: string;
    version: TaskArtifactVersion;
    updatedAt: string;
    forcePendingSettlement?: boolean;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "complete_task_artifact_revision",
      async () => this.taskRepository.completeArtifactRevision(input),
      { revisionId: input.revisionId, artifactId: input.version.artifactId },
    );
  }

  async markTaskArtifactRevisionSettlementPending(input: {
    revisionId: string;
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "mark_task_artifact_revision_settlement_pending",
      async () => this.taskRepository.markArtifactRevisionSettlementPending(input),
      { revisionId: input.revisionId },
    );
  }

  async failTaskArtifactRevision(input: {
    revisionId: string;
    status: Extract<TaskArtifactRevisionStatus, "cancelled" | "error">;
    updatedAt: string;
    detail?: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "fail_task_artifact_revision",
      async () => this.taskRepository.failArtifactRevision(input),
      { revisionId: input.revisionId, status: input.status },
    );
  }

  async settlePendingTaskArtifactRevisionSettlements(input: {
    taskId: string;
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "settle_pending_task_artifact_revision_settlements",
      async () => this.taskRepository.settlePendingArtifactRevisionSettlements(input),
      { taskId: input.taskId },
    );
  }

  async proposeTaskCompletionWithPendingArtifactRevisionSettlements(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
    summary: string;
    detail?: string | null;
    threadId?: string | null;
    settlementRevisionIds: readonly string[];
    reviewRequired: boolean;
    validateReadyTask?: (task: TaskRecord) => Promise<void>;
    validateAcceptedTask?: (task: TaskRecord) => Promise<void>;
    directiveCommit?: TaskDirectiveCommitHooks;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "propose_task_completion_with_pending_artifact_revision_settlements",
      async () => {
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        let committedCheckpoint: TaskCheckpoint | null = null;
        let committedTask: TaskRecord | null = null;
        try {
          this.taskRepository.setStatusInOpenTransaction({
            taskId: input.taskId,
            expectedRevision: input.expectedRevision,
            status: "awaiting_review",
            summary: input.summary,
            detail: input.detail ?? null,
            updatedAt: input.updatedAt,
            threadId: input.threadId ?? null,
          });
          let task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          await input.validateReadyTask?.(task);
          if (!input.reviewRequired) {
            this.taskRepository.acceptAllArtifactVersionsInOpenTransaction({
              taskId: input.taskId,
              expectedRevision: task.revision,
              updatedAt: input.updatedAt,
            });
            task = this.getTask(input.taskId);
            if (!task) throw new Error(`Unknown task: ${input.taskId}`);
            await input.validateAcceptedTask?.(task);
          }
          this.taskRepository.settlePendingArtifactRevisionSettlementsInOpenTransaction({
            taskId: input.taskId,
            revisionIds: input.settlementRevisionIds,
            updatedAt: input.updatedAt,
          });
          task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          committedCheckpoint = this.recordTaskDirectiveCommitInOpenTransaction(
            task,
            input.directiveCommit,
          );
          committedTask = task;
          this.db.exec("COMMIT");
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new Error(
              `Failed to roll back task completion settlement: ${String(rollbackError)}`,
              { cause: error },
            );
          }
          throw error;
        }
        if (!committedTask) throw new Error(`Unknown task: ${input.taskId}`);
        this.notifyTaskDirectiveCommitted(
          committedTask,
          committedCheckpoint,
          input.directiveCommit,
        );
        return committedTask;
      },
      { taskId: input.taskId },
    );
  }

  async previewArtifactRevisionCompletionReadiness(input: {
    taskId: string;
    revision:
      | {
          outcome: "completed";
          revisionId: string;
          version: TaskArtifactVersion;
        }
      | {
          outcome: "cancelled";
          revisionId: string;
          detail?: string;
        };
    updatedAt: string;
    summary: string;
    detail?: string | null;
    threadId?: string | null;
    reviewRequired: boolean;
    prepareCompletion: (task: TaskRecord) => Promise<
      | {
          ready: true;
          validateReadyTask?: (task: TaskRecord) => Promise<void>;
          validateAcceptedTask?: (task: TaskRecord) => Promise<void>;
        }
      | { ready: false; error: unknown }
    >;
  }): Promise<{ completion: "ready" | "not_ready"; error?: unknown }> {
    return await this.writeCoordinator.runExclusive(
      "preview_artifact_revision_completion_readiness",
      async () => {
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          if (input.revision.outcome === "completed") {
            this.taskRepository.completeArtifactRevisionInOpenTransaction({
              revisionId: input.revision.revisionId,
              version: input.revision.version,
              updatedAt: input.updatedAt,
            });
          } else {
            this.taskRepository.failArtifactRevisionInOpenTransaction({
              revisionId: input.revision.revisionId,
              status: "cancelled",
              updatedAt: input.updatedAt,
              detail: input.revision.detail,
            });
          }
          let task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          const prepared = await input.prepareCompletion(task);
          if (!prepared.ready) {
            this.db.exec("ROLLBACK");
            return { completion: "not_ready" as const, error: prepared.error };
          }
          this.taskRepository.setStatusInOpenTransaction({
            taskId: input.taskId,
            expectedRevision: task.revision,
            status: "awaiting_review",
            summary: input.summary,
            detail: input.detail ?? null,
            updatedAt: input.updatedAt,
            threadId: input.threadId ?? null,
          });
          task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          await prepared.validateReadyTask?.(task);
          if (!input.reviewRequired) {
            this.taskRepository.acceptAllArtifactVersionsInOpenTransaction({
              taskId: input.taskId,
              expectedRevision: task.revision,
              updatedAt: input.updatedAt,
            });
            task = this.getTask(input.taskId);
            if (!task) throw new Error(`Unknown task: ${input.taskId}`);
            await prepared.validateAcceptedTask?.(task);
          }
          this.db.exec("ROLLBACK");
          return { completion: "ready" as const };
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new Error(
              `Failed to roll back artifact revision completion readiness preview: ${String(
                rollbackError,
              )}`,
              { cause: error },
            );
          }
          throw error;
        }
      },
      { taskId: input.taskId, revisionId: input.revision.revisionId },
    );
  }

  async finalizeArtifactRevisionAndProposeTaskCompletion(input: {
    taskId: string;
    revision:
      | {
          outcome: "completed";
          revisionId: string;
          version: TaskArtifactVersion;
        }
      | {
          outcome: "cancelled";
          revisionId: string;
          detail?: string;
        };
    updatedAt: string;
    summary: string;
    detail?: string | null;
    threadId?: string | null;
    settlementRevisionIds: readonly string[];
    reviewRequired: boolean;
    prepareCompletion: (task: TaskRecord) => Promise<
      | {
          ready: true;
          validateReadyTask?: (task: TaskRecord) => Promise<void>;
          validateAcceptedTask?: (task: TaskRecord) => Promise<void>;
        }
      | { ready: false; error: unknown }
    >;
  }): Promise<{ task: TaskRecord; completion: "committed" | "not_ready"; error?: unknown }> {
    return await this.writeCoordinator.runExclusive(
      "finalize_artifact_revision_and_propose_task_completion",
      async () => {
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          if (input.revision.outcome === "completed") {
            this.taskRepository.completeArtifactRevisionInOpenTransaction({
              revisionId: input.revision.revisionId,
              version: input.revision.version,
              updatedAt: input.updatedAt,
            });
          } else {
            this.taskRepository.failArtifactRevisionInOpenTransaction({
              revisionId: input.revision.revisionId,
              status: "cancelled",
              updatedAt: input.updatedAt,
              detail: input.revision.detail,
            });
          }
          let task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          const prepared = await input.prepareCompletion(task);
          if (!prepared.ready) {
            this.db.exec("COMMIT");
            return { task, completion: "not_ready" as const, error: prepared.error };
          }
          this.taskRepository.setStatusInOpenTransaction({
            taskId: input.taskId,
            expectedRevision: task.revision,
            status: "awaiting_review",
            summary: input.summary,
            detail: input.detail ?? null,
            updatedAt: input.updatedAt,
            threadId: input.threadId ?? null,
          });
          task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          await prepared.validateReadyTask?.(task);
          if (!input.reviewRequired) {
            this.taskRepository.acceptAllArtifactVersionsInOpenTransaction({
              taskId: input.taskId,
              expectedRevision: task.revision,
              updatedAt: input.updatedAt,
            });
            task = this.getTask(input.taskId);
            if (!task) throw new Error(`Unknown task: ${input.taskId}`);
            await prepared.validateAcceptedTask?.(task);
          }
          this.taskRepository.settlePendingArtifactRevisionSettlementsInOpenTransaction({
            taskId: input.taskId,
            revisionIds: input.settlementRevisionIds,
            updatedAt: input.updatedAt,
          });
          task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          this.db.exec("COMMIT");
          return { task, completion: "committed" as const };
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new Error(
              `Failed to roll back artifact revision completion settlement: ${String(
                rollbackError,
              )}`,
              { cause: error },
            );
          }
          throw error;
        }
      },
      { taskId: input.taskId, revisionId: input.revision.revisionId },
    );
  }

  async abandonTaskArtifactRevisionForTerminalTask(input: {
    revisionId: string;
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "abandon_task_artifact_revision_terminal",
      async () => this.taskRepository.abandonArtifactRevisionForTerminalTask(input),
      { revisionId: input.revisionId },
    );
  }

  async acceptTaskArtifactVersion(input: {
    taskId: string;
    artifactId: string;
    versionId: string;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "accept_task_artifact_version",
      async () => this.taskRepository.acceptArtifactVersion(input),
      { taskId: input.taskId, artifactId: input.artifactId },
    );
  }

  async acceptAllTaskArtifactVersions(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
    directiveCommit?: TaskDirectiveCommitHooks;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "accept_all_task_artifact_versions",
      async () => {
        if (!input.directiveCommit) return this.taskRepository.acceptAllArtifactVersions(input);
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        let committedTask: TaskRecord | null = null;
        let committedCheckpoint: TaskCheckpoint | null = null;
        try {
          this.taskRepository.acceptAllArtifactVersionsInOpenTransaction(input);
          const task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          committedCheckpoint = this.recordTaskDirectiveCommitInOpenTransaction(
            task,
            input.directiveCommit,
          );
          committedTask = task;
          this.db.exec("COMMIT");
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new Error(
              `Failed to roll back task artifact acceptance: ${String(rollbackError)}`,
              { cause: error },
            );
          }
          throw error;
        }
        if (!committedTask) throw new Error(`Unknown task: ${input.taskId}`);
        this.notifyTaskDirectiveCommitted(
          committedTask,
          committedCheckpoint,
          input.directiveCommit,
        );
        return committedTask;
      },
      { taskId: input.taskId },
    );
  }

  async acceptAllTaskArtifactVersionsValidated(input: {
    taskId: string;
    expectedRevision: number;
    updatedAt: string;
    validateAcceptedTask: (task: TaskRecord) => Promise<void>;
    directiveCommit?: TaskDirectiveCommitHooks;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "accept_all_task_artifact_versions_validated",
      async () => {
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        let committedTask: TaskRecord | null = null;
        let committedCheckpoint: TaskCheckpoint | null = null;
        try {
          this.taskRepository.acceptAllArtifactVersionsInOpenTransaction(input);
          const task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          await input.validateAcceptedTask(task);
          committedCheckpoint = this.recordTaskDirectiveCommitInOpenTransaction(
            task,
            input.directiveCommit,
          );
          committedTask = task;
          this.db.exec("COMMIT");
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new Error(
              `Failed to roll back task artifact acceptance: ${String(rollbackError)}`,
              { cause: error },
            );
          }
          throw error;
        }
        if (!committedTask) throw new Error(`Unknown task: ${input.taskId}`);
        this.notifyTaskDirectiveCommitted(
          committedTask,
          committedCheckpoint,
          input.directiveCommit,
        );
        return committedTask;
      },
      { taskId: input.taskId },
    );
  }

  async reportTaskBlocker(
    blocker: TaskBlocker,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "report_task_blocker",
      async () => this.taskRepository.reportBlocker(blocker, expectedRevision, updatedAt),
      { taskId: blocker.taskId },
    );
  }

  async resolveTaskBlocker(input: {
    taskId: string;
    blockerId: string;
    expectedRevision: number;
    resolvedAt: string;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "resolve_task_blocker",
      async () => this.taskRepository.resolveBlocker(input),
      { taskId: input.taskId, blockerId: input.blockerId },
    );
  }

  async setTaskStatus(
    input: Parameters<SessionTaskRepository["setStatus"]>[0] & {
      validateUpdatedTask?: (task: TaskRecord) => Promise<void>;
    },
  ): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "set_task_status",
      async () => {
        if (!input.validateUpdatedTask) return this.taskRepository.setStatus(input);
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          this.taskRepository.setStatusInOpenTransaction(input);
          const task = this.getTask(input.taskId);
          if (!task) throw new Error(`Unknown task: ${input.taskId}`);
          await input.validateUpdatedTask(task);
          this.db.exec("COMMIT");
          return task;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new Error(
              `Failed to roll back task status transition: ${String(rollbackError)}`,
              { cause: error },
            );
          }
          throw error;
        }
      },
      { taskId: input.taskId, status: input.status },
    );
  }

  async runTaskMutationExclusive<T>(
    operation: string,
    taskId: string,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    return await this.writeCoordinator.runExclusive(operation, callback, { taskId });
  }

  async appendTaskActivity(
    activity: TaskActivity,
    options?: { rejectTerminal?: boolean },
  ): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "append_task_activity",
      async () => this.taskRepository.appendActivity(activity, options),
      { taskId: activity.taskId, kind: activity.kind },
    );
  }

  async appendTaskActivityWithRevision(
    activity: TaskActivity,
    expectedRevision: number,
  ): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "append_task_activity_with_revision",
      async () => this.taskRepository.appendActivityWithRevision(activity, expectedRevision),
      { taskId: activity.taskId, kind: activity.kind },
    );
  }

  async recordTaskReview(input: {
    review: TaskReviewRecord;
    activity: TaskActivity;
    expectedRevision: number;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "record_task_review",
      async () => this.taskRepository.recordReview(input),
      { taskId: input.review.taskId, reviewId: input.review.id },
    );
  }

  async addressTaskReview(input: {
    taskId: string;
    reviewId: string;
    expectedRevision: number;
    addressedAt: string;
    implementationSummary: string;
    activity: TaskActivity;
  }): Promise<TaskRecord> {
    return await this.writeCoordinator.runExclusive(
      "address_task_review",
      async () => this.taskRepository.addressReview(input),
      { taskId: input.taskId, reviewId: input.reviewId },
    );
  }

  async createTaskCheckpoint(
    checkpoint: TaskCheckpoint,
    options?: { rejectTerminal?: boolean },
  ): Promise<TaskCheckpoint> {
    return await this.writeCoordinator.runExclusive(
      "create_task_checkpoint",
      async () => this.taskRepository.createCheckpoint(checkpoint, options),
      { taskId: checkpoint.taskId },
    );
  }

  getTaskDirectiveReceipt(taskId: string, idempotencyKey: string): number | null {
    return this.readTaskRepository.getDirectiveReceipt(taskId, idempotencyKey);
  }

  async recordTaskDirectiveReceipt(
    taskId: string,
    idempotencyKey: string,
    resultRevision: number,
    createdAt: string,
  ): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "record_task_directive_receipt",
      async () => {
        this.taskRepository.recordDirectiveReceipt(
          taskId,
          idempotencyKey,
          resultRevision,
          createdAt,
        );
      },
      { taskId },
    );
  }

  async recordTaskDirectiveReceiptWithCheckpoint(input: {
    taskId: string;
    idempotencyKey: string;
    resultRevision: number;
    receiptCreatedAt: string;
    checkpoint: TaskCheckpoint;
    checkpointOptions?: { rejectTerminal?: boolean };
  }): Promise<TaskCheckpoint | null> {
    return await this.writeCoordinator.runExclusive(
      "record_task_directive_receipt_with_checkpoint",
      async () => this.taskRepository.recordDirectiveReceiptWithCheckpoint(input),
      { taskId: input.taskId },
    );
  }

  async persistSessionSnapshot(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    await this.writeCoordinator.runExclusive(
      "persist_session_snapshot",
      async () => {
        this.repository.persistSessionSnapshot(sessionId, snapshot);
      },
      { sessionId },
    );
  }

  private async bootstrap(): Promise<void> {
    await this.writeCoordinator.runExclusive("bootstrap_session_db", async () => {
      await bootstrapSessionDb({
        db: this.db,
        busyTimeoutMs: this.busyTimeoutMs,
        repository: this.repository,
        importLegacySnapshots: async () => {
          await importLegacySnapshots({
            sessionsDir: this.sessionsDir,
            importSnapshot: (snapshot) => {
              this.repository.importLegacySnapshot(snapshot);
            },
          });
        },
      });
    });
  }

  private async hardenDbFile(): Promise<void> {
    await hardenPrivateFile(this.dbPath);
  }
}
