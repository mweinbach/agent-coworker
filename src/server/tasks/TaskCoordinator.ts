import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_TASK_REVIEW_ROUNDS,
  MAX_TASK_REVIEW_ROUNDS,
  type TaskActivity,
  type TaskArtifact,
  type TaskArtifactDetail,
  type TaskArtifactRevision,
  type TaskArtifactVersion,
  type TaskBlocker,
  type TaskCheckpoint,
  type TaskContextSnapshot,
  type TaskCreationInput,
  type TaskCreationResult,
  type TaskDecision,
  type TaskDirective,
  type TaskDirectiveResult,
  type TaskQuestion,
  type TaskQuestionAnswerInput,
  type TaskQuestionResumeStatus,
  type TaskRecord,
  type TaskRequirement,
  type TaskRequirementKind,
  type TaskReviewMaterialReference,
  type TaskReviewRecord,
  type TaskReviewVerdict,
  type TaskStatus,
  type TaskSummary,
  type TaskThread,
  type WorkItem,
  type WorkItemStatus,
} from "../../shared/tasks";
import { resolvePathInsideRootForBoundaryCheck } from "../../utils/paths";
import { canonicalWorkspacePath, sameWorkspacePath } from "../../utils/workspacePath";
import type { SessionDb } from "../sessionDb";
import { ArtifactVersionStore } from "./ArtifactVersionStore";
import {
  buildTaskReviewMaterialSnapshot,
  fingerprintTaskReviewMaterial,
  getPendingTaskReviewFromRecords,
  getTaskReviewRoundsFromRecords,
  stableStringify,
  type TaskReviewArtifactFileSnapshot,
} from "./taskReviewPolicy";

type TaskNotification = {
  method: "task/created" | "task/updated" | "task/activity" | "task/checkpointCreated";
  params: Record<string, unknown>;
};

type TaskThreadFactory = (input: {
  task: TaskRecord;
  title: string;
  workItemId: string | null;
  provider?: string;
  model?: string;
}) => Promise<{ sessionId: string }>;

type TaskContinuationDispatcher = (input: {
  sessionId: string;
  prompt: string;
  displayText: string;
  onFailure: (error: unknown) => Promise<void>;
}) => Promise<Exclude<TaskQuestionResumeStatus, "not_needed">>;

type TaskThreadQuiescer = (
  task: TaskRecord,
  reason: "completed" | "cancelled" | "failed",
) => Promise<void> | void;

type TaskCoordinatorOptions = {
  sessionDb: SessionDb;
  notify?: (notification: TaskNotification) => void;
  artifactStore?: ArtifactVersionStore;
  quiesceTaskThreads?: TaskThreadQuiescer;
};

type CaptureArtifactVersionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  expectedRevision: number;
  expectedSha256?: string;
  changeSummary?: string;
  createdBy?: string;
  provenance?: Record<string, unknown>;
};

type RestoreArtifactVersionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  versionId: string;
  expectedRevision: number;
  expectedSha256?: string;
  createdBy?: string;
  changeSummary?: string;
};

type AcceptArtifactVersionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  versionId?: string;
  expectedRevision: number;
};

type TaskReviewMaterial = {
  snapshot: ReturnType<typeof buildTaskReviewMaterialSnapshot>;
  fingerprint: string;
};

type TaskReviewLiveArtifactEvidence = Array<{
  id: string;
  path: string;
  liveFile: TaskReviewArtifactFileSnapshot | null;
}>;

function liveArtifactEvidence(material: TaskReviewMaterial): TaskReviewLiveArtifactEvidence {
  return material.snapshot.artifacts.map((artifact) => ({
    id: stringSnapshotField(artifact, "id"),
    path: stringSnapshotField(artifact, "path"),
    liveFile: liveFileSnapshotField(artifact.liveFile),
  }));
}

function stringSnapshotField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Invalid review material artifact ${field}`);
  return value;
}

function liveFileSnapshotField(value: unknown): TaskReviewArtifactFileSnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid review material live file evidence");
  }
  const record = value as Record<string, unknown>;
  const artifactId = stringSnapshotField(record, "artifactId");
  const filePath = stringSnapshotField(record, "path");
  const canonicalWorkspaceRelativePath = stringSnapshotField(
    record,
    "canonicalWorkspaceRelativePath",
  );
  const sha256 = stringSnapshotField(record, "sha256");
  const sizeBytes = record.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) {
    throw new Error("Invalid review material live file size");
  }
  return {
    artifactId,
    path: filePath,
    canonicalWorkspaceRelativePath,
    sha256,
    sizeBytes,
  };
}

type StartArtifactRevisionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  expectedRevision: number;
  instruction: string;
  baseVersionId?: string;
  title?: string;
  provider?: string;
  model?: string;
};

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["planning", "working", "cancelled", "failed"],
  planning: ["working", "blocked", "cancelled", "failed"],
  working: ["blocked", "awaiting_review", "completed", "cancelled", "failed"],
  blocked: ["working", "cancelled", "failed"],
  awaiting_review: ["working", "completed", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "cancelled", "failed"]);

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function assertTaskAcceptsNewThreads(task: TaskRecord): void {
  if (!TERMINAL_TASK_STATUSES.has(task.status)) return;
  throw new Error(
    `Task ${task.id} is ${task.status} and cannot create new focused threads until it is reopened or retried.`,
  );
}

function assertTaskAcceptsMutation(task: TaskRecord): void {
  if (!TERMINAL_TASK_STATUSES.has(task.status)) return;
  throw new Error(
    `Task ${task.id} is ${task.status} and cannot be changed until it is reopened or retried.`,
  );
}

function isTerminalTask(task: Pick<TaskRecord, "status">): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

function isTerminalTaskMutationError(taskId: string, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith(`Task ${taskId} is `) &&
    error.message.includes("cannot be changed until it is reopened or retried")
  );
}

function taskRevisionConflictMessage(task: TaskRecord, expectedRevision: number): string {
  return `Task revision conflict: expected ${expectedRevision}, current ${task.revision}`;
}

function assertExpectedTaskRevision(task: TaskRecord, expectedRevision: number): void {
  if (task.revision === expectedRevision) return;
  throw new Error(taskRevisionConflictMessage(task, expectedRevision));
}

function activity(input: Omit<TaskActivity, "id" | "seq" | "createdAt">): TaskActivity {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    createdAt: nowIso(),
    ...input,
  };
}

function requirement(input: {
  kind: TaskRequirementKind;
  text: string;
  permanence?: "fixed" | "temporary";
  source?: "user" | "agent" | "policy";
}): TaskRequirement {
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    text: nonEmpty(input.text, "Requirement text"),
    source: input.source ?? "agent",
    permanence: input.permanence ?? "fixed",
    status: "active",
    createdAt: nowIso(),
    supersedes: null,
  };
}

function validateWorkGraph(items: WorkItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate work item id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Work item ${item.id} depends on unknown item ${dependency}`);
      }
      if (dependency === item.id) throw new Error(`Work item ${item.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(items.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Work item dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}

function assertWorkspace(task: TaskRecord, workspacePath: string): void {
  if (!sameWorkspacePath(task.workspacePath, workspacePath)) {
    throw new Error("Task is outside the active workspace");
  }
}

function taskSnapshot(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    workspacePath: task.workspacePath,
    title: task.title,
    objective: task.objective,
    status: task.status,
    revision: task.revision,
    reviewRequired: task.reviewRequired,
    reviewRounds: task.reviewRounds ?? 0,
    requirements: task.requirements,
    threads: task.threads,
    workItems: task.workItems,
    decisions: task.decisions,
    questions: task.questions,
    blockers: task.blockers,
    artifacts: task.artifacts,
  };
}

export function buildTaskQuestionContinuationPrompt(input: {
  task: TaskRecord;
  answers: Array<{ question: string; answer: string }>;
}): string {
  return [
    "The user answered blocking questions in the task work panel.",
    ...input.answers.map((answer) => `- ${answer.question}: ${answer.answer}`),
    "Review the authoritative task record and latest checkpoint, then continue the work.",
    "Do not re-ask resolved questions unless the task requirements materially change.",
  ].join("\n");
}

export function buildTaskRetryPrompt(task: TaskRecord): string {
  return [
    `Retry the task "${task.title}" in its existing task thread.`,
    "The previous run failed before the task reached a review or completion state.",
    "Review the authoritative task brief, work graph, decisions, artifacts, and latest checkpoint before continuing.",
    "Preserve completed work and resume the first unblocked unfinished work item. Do not restart completed work unless validation shows it is invalid.",
  ].join("\n\n");
}

function mediaTypeForArtifact(filePath: string, kind: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const byExtension: Record<string, string> = {
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  if (byExtension[extension]) return byExtension[extension];
  return kind.includes("/") ? kind : "application/octet-stream";
}

export class ArtifactConflictError extends Error {
  readonly code = "artifact_conflict";
  readonly category = "artifact_conflict";

  constructor(
    readonly artifactId: string,
    readonly expectedSha256: string,
    readonly currentSha256: string | null,
  ) {
    super(
      `Artifact changed on disk: expected ${expectedSha256}, current ${currentSha256 ?? "missing"}`,
    );
    this.name = "ArtifactConflictError";
  }
}

export function buildArtifactRevisionPrompt(input: {
  artifact: TaskArtifact;
  revision: TaskArtifactRevision;
}): string {
  return [
    `Revise the task artifact at ${input.artifact.path}.`,
    "Apply only the requested delta and preserve unaffected content and formatting.",
    `Requested revision: ${input.revision.instruction}`,
    "When finished, verify the artifact remains readable and editable.",
  ].join("\n\n");
}

export class TaskCoordinator {
  private threadFactory: TaskThreadFactory | null = null;
  private continuationDispatcher: TaskContinuationDispatcher | null = null;
  private readonly artifactStore: ArtifactVersionStore;
  private readonly taskMutationTails = new Map<string, Promise<void>>();

  constructor(private readonly options: TaskCoordinatorOptions) {
    this.artifactStore =
      options.artifactStore ??
      new ArtifactVersionStore({
        rootDir: path.join(path.dirname(options.sessionDb.dbPath), "artifacts"),
      });
  }

  setThreadFactory(factory: TaskThreadFactory): void {
    this.threadFactory = factory;
  }

  setContinuationDispatcher(dispatcher: TaskContinuationDispatcher): void {
    this.continuationDispatcher = dispatcher;
  }

  private async runTaskMutation<T>(
    taskId: string,
    callback: (context: { queued: boolean }) => Promise<T> | T,
  ): Promise<T> {
    const previous = this.taskMutationTails.get(taskId);
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextTail = (previous ?? Promise.resolve()).catch(() => {}).then(() => current);
    this.taskMutationTails.set(taskId, nextTail);

    if (previous) await previous.catch(() => {});
    try {
      return await callback({ queued: Boolean(previous) });
    } finally {
      releaseCurrent();
      if (this.taskMutationTails.get(taskId) === nextTail) {
        this.taskMutationTails.delete(taskId);
      }
    }
  }

  private async quiesceTaskThreads(task: TaskRecord): Promise<void> {
    const reason = task.status;
    if (reason !== "completed" && reason !== "cancelled" && reason !== "failed") return;
    await this.options.quiesceTaskThreads?.(task, reason);
  }

  list(workspacePath?: string | null): TaskSummary[] {
    return this.options.sessionDb.listTasks(
      workspacePath ? canonicalWorkspacePath(workspacePath) : workspacePath,
    );
  }

  get(taskId: string, workspacePath?: string): TaskRecord | null {
    const task = this.options.sessionDb.getTask(taskId);
    if (task && workspacePath) assertWorkspace(task, workspacePath);
    return task;
  }

  getByCreationKey(
    idempotencyKey: string,
    scope?: { sourceSessionId?: string | null; workspacePath?: string },
  ): TaskRecord | null {
    return this.options.sessionDb.getTaskByCreationKey(idempotencyKey, {
      ...scope,
      ...(scope?.workspacePath
        ? { workspacePath: canonicalWorkspacePath(scope.workspacePath) }
        : {}),
    });
  }

  getForThread(sessionId: string): TaskRecord | null {
    return this.options.sessionDb.getTaskForThread(sessionId);
  }

  isTaskThread(sessionId: string): boolean {
    return this.options.sessionDb.isTaskThread(sessionId);
  }

  getContextForThread(sessionId: string): TaskContextSnapshot | null {
    const task = this.getForThread(sessionId);
    if (!task) return null;
    const thread = task.threads.find((candidate) => candidate.sessionId === sessionId);
    if (!thread) return null;
    return {
      id: task.id,
      title: task.title,
      objective: task.objective,
      context: task.context ?? "",
      sourceSessionId: task.sourceSessionId ?? null,
      status: task.status,
      revision: task.revision,
      requirements: task.requirements.filter((item) => item.status === "active"),
      workItems: task.workItems,
      decisions: task.decisions.filter((item) => item.status === "active"),
      questions: task.questions,
      blockers: task.blockers.filter((item) => item.status === "active"),
      artifacts: task.artifacts,
      reviewRequired: task.reviewRequired,
      reviewRounds: task.reviewRounds ?? 0,
      activity: task.activity,
      reviews: this.options.sessionDb.listTaskReviews(task.id),
      activeThreadId: thread.id,
    };
  }

  private withDirectiveReviewState(task: TaskRecord): TaskDirectiveResult["task"] {
    return { ...task, reviews: this.options.sessionDb.listTaskReviews(task.id) };
  }

  async getReviewMaterial(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision?: number;
  }): Promise<TaskReviewMaterialReference> {
    return await this.runTaskMutation(input.taskId, async () => {
      const task = this.requireTask(input.taskId, input.workspacePath);
      if (input.expectedRevision !== undefined) {
        assertExpectedTaskRevision(task, input.expectedRevision);
      }
      const material = await this.currentReviewMaterial(task);
      return { fingerprint: material.fingerprint };
    });
  }

  async getReviewMaterialForThread(sessionId: string): Promise<TaskReviewMaterialReference | null> {
    const task = this.getForThread(sessionId);
    if (!task) return null;
    return await this.getReviewMaterial({
      taskId: task.id,
      workspacePath: task.workspacePath,
      expectedRevision: task.revision,
    });
  }

  async create(input: {
    workspacePath: string;
    title: string;
    objective: string;
    sessionId: string;
    threadTitle?: string;
    reviewRequired?: boolean;
    reviewRounds?: number;
  }): Promise<TaskRecord> {
    const createdAt = nowIso();
    const taskId = crypto.randomUUID();
    const thread: TaskThread = {
      id: crypto.randomUUID(),
      taskId,
      sessionId: nonEmpty(input.sessionId, "Session id"),
      title: nonEmpty(input.threadTitle ?? "Main", "Thread title"),
      createdBy: "user",
      createdAt,
      updatedAt: createdAt,
    };
    const task = await this.options.sessionDb.createTask({
      id: taskId,
      workspacePath: canonicalWorkspacePath(input.workspacePath),
      title: nonEmpty(input.title, "Task title"),
      objective: nonEmpty(input.objective, "Task objective"),
      reviewRequired: input.reviewRequired ?? true,
      reviewRounds: input.reviewRounds ?? 0,
      thread,
    });
    this.notifyUpdated(task);
    return task;
  }

  async createPlanned(input: {
    workspacePath: string;
    sessionId: string;
    sourceSessionId?: string | null;
    creationOrigin: "manual" | "chat_tool";
    workspaceDisposition: TaskCreationResult["workspaceDisposition"];
    creation: TaskCreationInput;
    threadTitle?: string;
  }): Promise<TaskCreationResult> {
    const existing = this.options.sessionDb.getTaskByCreationKey(input.creation.idempotencyKey, {
      sourceSessionId: input.sourceSessionId,
      workspacePath: canonicalWorkspacePath(input.workspacePath),
    });
    if (existing) {
      return { task: existing, workspaceDisposition: input.workspaceDisposition };
    }

    const createdAt = nowIso();
    const taskId = crypto.randomUUID();
    const thread: TaskThread = {
      id: crypto.randomUUID(),
      taskId,
      sessionId: nonEmpty(input.sessionId, "Session id"),
      title: nonEmpty(input.threadTitle ?? "Main", "Thread title"),
      createdBy: input.creationOrigin === "manual" ? "user" : "coordinator",
      createdAt,
      updatedAt: createdAt,
    };
    const workItemIdByKey = new Map(
      input.creation.workItems.map((item) => [item.key, crypto.randomUUID()]),
    );
    const source = input.creationOrigin === "manual" ? "user" : "agent";
    const task = await this.options.sessionDb.createTask({
      id: taskId,
      workspacePath: canonicalWorkspacePath(input.workspacePath),
      title: nonEmpty(input.creation.title, "Task title"),
      objective: nonEmpty(input.creation.objective, "Task objective"),
      context: nonEmpty(input.creation.context, "Task context"),
      sourceSessionId: input.sourceSessionId ?? null,
      creationOrigin: input.creationOrigin,
      creationIdempotencyKey: input.creation.idempotencyKey,
      initialStatus: "working",
      reviewRequired: input.creation.reviewRequired ?? true,
      reviewRounds: input.creation.reviewRounds ?? DEFAULT_TASK_REVIEW_ROUNDS,
      thread,
      requirements: input.creation.requirements.map((requirement) => ({
        id: crypto.randomUUID(),
        kind: requirement.kind,
        text: requirement.text,
        source,
        permanence: requirement.permanence ?? "fixed",
        status: "active",
        createdAt,
        supersedes: null,
      })),
      workItems: input.creation.workItems.map((item, position) => ({
        id: workItemIdByKey.get(item.key) ?? crypto.randomUUID(),
        title: item.title,
        description: item.description ?? "",
        status: "queued",
        dependsOn: (item.dependsOn ?? []).map((key) => {
          const dependencyId = workItemIdByKey.get(key);
          if (!dependencyId) throw new Error(`Unknown work item dependency: ${key}`);
          return dependencyId;
        }),
        assignedThreadId: null,
        claimedByThreadId: null,
        expectedOutputs: item.expectedOutputs ?? [],
        completionEvidence: null,
        position,
        createdAt,
        updatedAt: createdAt,
      })),
      decisions: (input.creation.decisions ?? []).map((decision) => ({
        id: crypto.randomUUID(),
        taskId,
        question: decision.question,
        resolution: decision.resolution,
        source,
        scope: "task",
        confidence: decision.confidence ?? null,
        status: "active",
        createdAt,
        supersedes: null,
      })),
    });
    this.options.notify?.({
      method: "task/created",
      params: {
        cwd: task.workspacePath,
        task,
        sourceSessionId: task.sourceSessionId ?? null,
        takeover: true,
        workspaceDisposition: input.workspaceDisposition,
      },
    });
    this.notifyUpdated(task);
    return { task, workspaceDisposition: input.workspaceDisposition };
  }

  async addThread(input: {
    taskId: string;
    workspacePath: string;
    title: string;
    expectedRevision: number;
    createdBy: "user" | "coordinator";
    workItemId?: string | null;
    provider?: string;
    model?: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsNewThreads(task);
    const workItemId = input.workItemId ?? null;
    if (workItemId && !task.workItems.some((item) => item.id === workItemId)) {
      throw new Error(`Unknown work item: ${workItemId}`);
    }
    if (!this.threadFactory) throw new Error("Task thread creation is unavailable");
    const created = await this.threadFactory({
      task,
      title: nonEmpty(input.title, "Thread title"),
      workItemId,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    const createdAt = nowIso();
    const thread: TaskThread = {
      id: crypto.randomUUID(),
      taskId: task.id,
      sessionId: created.sessionId,
      title: input.title.trim(),
      createdBy: input.createdBy,
      createdAt,
      updatedAt: createdAt,
    };
    let updated = await this.options.sessionDb.addTaskThread(thread, input.expectedRevision);
    if (workItemId) {
      updated = await this.claimWorkItem({
        taskId: task.id,
        workspacePath: task.workspacePath,
        workItemId,
        threadId: thread.id,
        expectedRevision: updated.revision,
      });
    }
    this.notifyUpdated(updated);
    return updated;
  }

  async updateBrief(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    title?: string;
    objective?: string;
    requirements?: Array<{
      kind: TaskRequirementKind;
      text: string;
      permanence?: "fixed" | "temporary";
      source?: "user" | "agent" | "policy";
    }>;
  }): Promise<TaskRecord> {
    const current = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(current, input.expectedRevision);
    assertTaskAcceptsMutation(current);
    const task = await this.options.sessionDb.updateTaskBrief({
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      ...(input.title !== undefined ? { title: nonEmpty(input.title, "Task title") } : {}),
      ...(input.objective !== undefined
        ? { objective: nonEmpty(input.objective, "Task objective") }
        : {}),
      ...(input.requirements
        ? { requirements: input.requirements.map((item) => requirement(item)) }
        : {}),
      updatedAt: nowIso(),
    });
    this.notifyUpdated(task);
    return task;
  }

  async replaceWorkItems(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    items: Array<{
      id?: string;
      title: string;
      description?: string;
      status?: WorkItemStatus;
      dependsOn?: string[];
      expectedOutputs?: string[];
    }>;
  }): Promise<TaskRecord> {
    const current = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(current, input.expectedRevision);
    assertTaskAcceptsMutation(current);
    const now = nowIso();
    const items: WorkItem[] = input.items.map((item, position) => {
      const existing = item.id
        ? current.workItems.find((candidate) => candidate.id === item.id)
        : undefined;
      return {
        id: item.id?.trim() || crypto.randomUUID(),
        taskId: current.id,
        title: nonEmpty(item.title, "Work item title"),
        description: item.description?.trim() ?? "",
        status: item.status ?? existing?.status ?? "queued",
        dependsOn: [...new Set(item.dependsOn ?? [])],
        assignedThreadId: existing?.assignedThreadId ?? null,
        claimedByThreadId: existing?.claimedByThreadId ?? null,
        expectedOutputs: (item.expectedOutputs ?? []).map((value) => value.trim()).filter(Boolean),
        completionEvidence: existing?.completionEvidence ?? null,
        position,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    });
    validateWorkGraph(items);
    const removedClaim = current.workItems.find(
      (item) => item.claimedByThreadId && !items.some((candidate) => candidate.id === item.id),
    );
    if (removedClaim) {
      throw new Error(`Cannot remove claimed work item: ${removedClaim.title}`);
    }
    const task = await this.options.sessionDb.replaceTaskWorkItems({
      taskId: current.id,
      expectedRevision: input.expectedRevision,
      items,
      updatedAt: now,
    });
    this.notifyUpdated(task);
    return task;
  }

  async claimWorkItem(input: {
    taskId: string;
    workspacePath: string;
    workItemId: string;
    threadId: string;
    expectedRevision: number;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const item = task.workItems.find((candidate) => candidate.id === input.workItemId);
    if (!item) throw new Error(`Unknown work item: ${input.workItemId}`);
    if (!task.threads.some((thread) => thread.id === input.threadId)) {
      throw new Error(`Unknown task thread: ${input.threadId}`);
    }
    const incompleteDependency = item.dependsOn.find(
      (id) => task.workItems.find((candidate) => candidate.id === id)?.status !== "done",
    );
    if (incompleteDependency) {
      throw new Error(`Work item dependency is not complete: ${incompleteDependency}`);
    }
    const updated = await this.options.sessionDb.claimTaskWorkItem({
      taskId: task.id,
      workItemId: item.id,
      threadId: input.threadId,
      expectedRevision: input.expectedRevision,
      claimedAt: nowIso(),
    });
    this.notifyUpdated(updated);
    return updated;
  }

  async markWorkItem(input: {
    taskId: string;
    workspacePath: string;
    workItemId: string;
    expectedRevision: number;
    status: WorkItemStatus;
    completionEvidence?: string;
    threadId?: string | null;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const item = task.workItems.find((candidate) => candidate.id === input.workItemId);
    if (!item) throw new Error(`Unknown work item: ${input.workItemId}`);
    if (input.status === "done" && !input.completionEvidence?.trim() && !item.completionEvidence) {
      throw new Error("Completion evidence is required before marking a work item done");
    }
    const updated = await this.options.sessionDb.updateTaskWorkItem({
      taskId: task.id,
      workItemId: item.id,
      expectedRevision: input.expectedRevision,
      status: input.status,
      ...(input.completionEvidence?.trim()
        ? { completionEvidence: input.completionEvidence.trim() }
        : {}),
      updatedAt: nowIso(),
      threadId: input.threadId ?? null,
    });
    this.notifyUpdated(updated);
    return updated;
  }

  async recordDecision(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    question: string;
    resolution: string;
    source: "user" | "agent" | "policy";
    scope?: "task" | "project";
    confidence?: number;
    supersedes?: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (input.supersedes && !task.decisions.some((item) => item.id === input.supersedes)) {
      throw new Error(`Unknown superseded decision: ${input.supersedes}`);
    }
    const createdAt = nowIso();
    const decision: TaskDecision = {
      id: crypto.randomUUID(),
      taskId: task.id,
      question: nonEmpty(input.question, "Decision question"),
      resolution: nonEmpty(input.resolution, "Decision resolution"),
      source: input.source,
      scope: input.scope ?? "task",
      confidence: input.confidence ?? null,
      status: "active",
      createdAt,
      supersedes: input.supersedes ?? null,
    };
    const updated = await this.options.sessionDb.recordTaskDecision(
      decision,
      input.expectedRevision,
      createdAt,
    );
    this.notifyUpdated(updated);
    return updated;
  }

  async requestInput(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    sessionId: string;
    questions: Extract<TaskDirective, { type: "request_input" }>["questions"];
  }): Promise<TaskDirectiveResult> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (["awaiting_review", "completed", "failed", "cancelled"].includes(task.status)) {
      throw new Error(`Task cannot request input while ${task.status.replaceAll("_", " ")}`);
    }
    if (input.questions.length < 1 || input.questions.length > 3) {
      throw new Error("Request input must contain between 1 and 3 questions");
    }
    const thread = task.threads.find((candidate) => candidate.sessionId === input.sessionId);
    if (!thread) throw new Error("Input requests must originate from a task thread");

    const pendingQuestions = task.questions.filter((question) => question.status === "pending");
    const pendingById = new Map(pendingQuestions.map((question) => [question.id, question]));
    const normalizedQuestions = new Set(
      pendingQuestions.map((question) => question.question.trim().toLocaleLowerCase()),
    );
    const createdAt = nowIso();
    const provisionalDecisions: TaskDecision[] = [];
    const questions: TaskQuestion[] = [];

    for (const questionInput of input.questions) {
      const questionText = nonEmpty(questionInput.question, "Question");
      const normalizedQuestion = questionText.toLocaleLowerCase();
      const superseded = questionInput.supersedes
        ? pendingById.get(questionInput.supersedes)
        : undefined;
      if (questionInput.supersedes && !superseded) {
        throw new Error(`Unknown pending superseded question: ${questionInput.supersedes}`);
      }
      const supersededQuestion = superseded?.question.trim().toLocaleLowerCase();
      if (
        normalizedQuestions.has(normalizedQuestion) &&
        supersededQuestion !== normalizedQuestion
      ) {
        throw new Error(`Task already has a pending question: ${questionText}`);
      }
      if (
        questionInput.workItemId &&
        !task.workItems.some((item) => item.id === questionInput.workItemId)
      ) {
        throw new Error(`Unknown work item: ${questionInput.workItemId}`);
      }
      if (questionInput.blocking && questionInput.urgency !== "now") {
        throw new Error("Blocking task questions must use urgency now");
      }
      const defaultAction = questionInput.defaultAction?.trim() || null;
      if (!questionInput.blocking && !defaultAction) {
        throw new Error("Non-blocking task questions require a reversible default action");
      }
      const options = (questionInput.options ?? []).map((option) => ({
        id: nonEmpty(option.id, "Question option id"),
        label: nonEmpty(option.label, "Question option label"),
        description: option.description?.trim() ?? "",
      }));
      if (options.length === 1 || options.length > 3) {
        throw new Error("Task questions must provide either no options or 2 to 3 options");
      }
      if (new Set(options.map((option) => option.id)).size !== options.length) {
        throw new Error("Task question option ids must be unique");
      }
      if (
        questionInput.recommendedOptionId &&
        !options.some((option) => option.id === questionInput.recommendedOptionId)
      ) {
        throw new Error("Recommended option must reference a question option");
      }

      const provisionalDecisionId = !questionInput.blocking ? crypto.randomUUID() : null;
      if (provisionalDecisionId && defaultAction) {
        provisionalDecisions.push({
          id: provisionalDecisionId,
          taskId: task.id,
          question: questionText,
          resolution: defaultAction,
          source: "agent",
          scope: "task",
          confidence: 0.5,
          status: "active",
          createdAt,
          supersedes: superseded?.provisionalDecisionId ?? null,
        });
      }
      const question: TaskQuestion = {
        id: crypto.randomUUID(),
        taskId: task.id,
        threadId: thread.id,
        workItemId: questionInput.workItemId ?? null,
        header: nonEmpty(questionInput.header, "Question header"),
        question: questionText,
        context: questionInput.context?.trim() ?? "",
        blocking: questionInput.blocking,
        urgency: questionInput.urgency,
        defaultAction,
        options,
        recommendedOptionId: questionInput.recommendedOptionId ?? null,
        status: "pending",
        provisionalDecisionId,
        answer: null,
        answerOptionId: null,
        resolutionSource: null,
        supersedes: questionInput.supersedes ?? null,
        createdAt,
        resolvedAt: null,
      };
      questions.push(question);
      normalizedQuestions.add(normalizedQuestion);
    }

    const pauseForInput = questions.some((question) => question.blocking);
    const updated = await this.options.sessionDb.queueTaskQuestions({
      taskId: task.id,
      expectedRevision: input.expectedRevision,
      questions,
      provisionalDecisions,
      blockTask: pauseForInput,
      updatedAt: createdAt,
    });
    this.notifyUpdated(updated);
    this.notifyActivity(updated);
    return {
      task: updated,
      continuation: pauseForInput ? "pause_for_input" : "continue",
    };
  }

  async resolveQuestions(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    answers: TaskQuestionAnswerInput[];
  }): Promise<{ task: TaskRecord; resumeStatus: TaskQuestionResumeStatus }> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (input.answers.length < 1 || input.answers.length > 3) {
      throw new Error("Resolve questions must contain between 1 and 3 answers");
    }
    const answerIds = input.answers.map((answer) => nonEmpty(answer.questionId, "Question id"));
    if (new Set(answerIds).size !== answerIds.length) {
      throw new Error("Task question answers must reference unique questions");
    }
    const createdAt = nowIso();
    const resolvedAnswers: Array<{
      question: TaskQuestion;
      answer: string;
      answerOptionId: string | null;
      decision: TaskDecision;
    }> = [];
    for (const answerInput of input.answers) {
      const question = task.questions.find(
        (candidate) => candidate.id === answerInput.questionId && candidate.status === "pending",
      );
      if (!question) throw new Error(`Unknown pending task question: ${answerInput.questionId}`);
      const hasOption = Boolean(answerInput.optionId?.trim());
      const hasText = Boolean(answerInput.text?.trim());
      if (hasOption === hasText) {
        throw new Error("Provide exactly one of optionId or text for each task answer");
      }
      const option = hasOption
        ? question.options.find((candidate) => candidate.id === answerInput.optionId)
        : null;
      if (hasOption && !option)
        throw new Error(`Unknown task question option: ${answerInput.optionId}`);
      const answer = option?.label ?? nonEmpty(answerInput.text ?? "", "Task answer");
      resolvedAnswers.push({
        question,
        answer,
        answerOptionId: option?.id ?? null,
        decision: {
          id: crypto.randomUUID(),
          taskId: task.id,
          question: question.question,
          resolution: answer,
          source: "user",
          scope: "task",
          confidence: null,
          status: "active",
          createdAt,
          supersedes: question.provisionalDecisionId,
        },
      });
    }

    const updated = await this.options.sessionDb.resolveTaskQuestions({
      taskId: task.id,
      expectedRevision: input.expectedRevision,
      resolutions: resolvedAnswers.map((answer) => ({
        questionId: answer.question.id,
        answer: answer.answer,
        answerOptionId: answer.answerOptionId,
        decision: answer.decision,
      })),
      updatedAt: createdAt,
    });
    this.notifyUpdated(updated);
    this.notifyActivity(updated);

    const resolvedBlocking = resolvedAnswers.some((answer) => answer.question.blocking);
    if (!resolvedBlocking || updated.status !== "working" || task.status !== "blocked") {
      return { task: updated, resumeStatus: "not_needed" };
    }
    const primaryThread = updated.threads[0];
    if (!primaryThread || !this.continuationDispatcher) {
      await this.recordInputResumeFailure(updated, new Error("Task continuation is unavailable"));
      return { task: this.requireTask(updated.id, updated.workspacePath), resumeStatus: "failed" };
    }
    const continuationAnswers = updated.questions
      .filter(
        (question) =>
          question.blocking &&
          question.status === "answered" &&
          question.answer &&
          question.resolvedAt === createdAt,
      )
      .map((question) => ({ question: question.question, answer: question.answer as string }));
    const resumeStatus = await this.continuationDispatcher({
      sessionId: primaryThread.sessionId,
      prompt: buildTaskQuestionContinuationPrompt({ task: updated, answers: continuationAnswers }),
      displayText: `Answered ${continuationAnswers.length} task question${continuationAnswers.length === 1 ? "" : "s"} in the work panel.`,
      onFailure: async (error) => {
        await this.recordInputResumeFailure(updated, error);
      },
    });
    return { task: updated, resumeStatus };
  }

  private async recordInputResumeFailure(task: TaskRecord, error: unknown): Promise<void> {
    const current = this.options.sessionDb.getTask(task.id);
    if (!current || isTerminalTask(current)) return;
    let failed: TaskRecord;
    try {
      failed = await this.options.sessionDb.appendTaskActivity(
        activity({
          taskId: task.id,
          threadId: task.threads[0]?.id ?? null,
          workItemId: null,
          kind: "input_resume_failed",
          summary: "Task answers were saved, but automatic resume failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
        { rejectTerminal: true },
      );
    } catch (appendError) {
      if (isTerminalTaskMutationError(task.id, appendError)) return;
      throw appendError;
    }
    this.notifyActivity(failed);
  }

  async reportProgress(input: {
    taskId: string;
    workspacePath: string;
    sessionId?: string;
    summary: string;
    detail?: string;
    workItemId?: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertTaskAcceptsMutation(task);
    if (input.workItemId && !task.workItems.some((item) => item.id === input.workItemId)) {
      throw new Error(`Unknown work item: ${input.workItemId}`);
    }
    const thread = input.sessionId
      ? task.threads.find((candidate) => candidate.sessionId === input.sessionId)
      : null;
    const updated = await this.options.sessionDb.appendTaskActivity(
      activity({
        taskId: task.id,
        threadId: thread?.id ?? null,
        workItemId: input.workItemId ?? null,
        kind: "progress_reported",
        summary: nonEmpty(input.summary, "Progress summary"),
        detail: input.detail?.trim() || null,
      }),
      { rejectTerminal: true },
    );
    this.notifyActivity(updated);
    return updated;
  }

  async reportBlocker(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    description: string;
    blocking: boolean;
    workItemId?: string;
  }): Promise<TaskRecord> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.reportBlockerLocked(input),
    );
  }

  private async reportBlockerLocked(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    description: string;
    blocking: boolean;
    workItemId?: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (input.workItemId && !task.workItems.some((item) => item.id === input.workItemId)) {
      throw new Error(`Unknown work item: ${input.workItemId}`);
    }
    const createdAt = nowIso();
    const blocker: TaskBlocker = {
      id: crypto.randomUUID(),
      taskId: task.id,
      workItemId: input.workItemId ?? null,
      description: nonEmpty(input.description, "Blocker description"),
      blocking: input.blocking,
      status: "active",
      createdAt,
      resolvedAt: null,
    };
    let updated = await this.options.sessionDb.reportTaskBlocker(
      blocker,
      input.expectedRevision,
      createdAt,
    );
    if (input.blocking && (updated.status === "planning" || updated.status === "working")) {
      updated = await this.transitionLocked({
        taskId: task.id,
        workspacePath: task.workspacePath,
        expectedRevision: updated.revision,
        status: "blocked",
        summary: "Task blocked",
        detail: blocker.description,
      });
    } else {
      this.notifyUpdated(updated);
    }
    return updated;
  }

  async resolveBlocker(input: {
    taskId: string;
    workspacePath: string;
    blockerId: string;
    expectedRevision: number;
  }): Promise<TaskRecord> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.resolveBlockerLocked(input),
    );
  }

  private async resolveBlockerLocked(input: {
    taskId: string;
    workspacePath: string;
    blockerId: string;
    expectedRevision: number;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (!task.blockers.some((item) => item.id === input.blockerId)) {
      throw new Error(`Unknown blocker: ${input.blockerId}`);
    }
    let updated = await this.options.sessionDb.resolveTaskBlocker({
      taskId: task.id,
      blockerId: input.blockerId,
      expectedRevision: input.expectedRevision,
      resolvedAt: nowIso(),
    });
    const hasActiveBlockingIssue =
      updated.blockers.some((item) => item.status === "active" && item.blocking) ||
      updated.questions.some((question) => question.status === "pending" && question.blocking);
    if (updated.status === "blocked" && !hasActiveBlockingIssue) {
      updated = await this.transitionLocked({
        taskId: task.id,
        workspacePath: task.workspacePath,
        expectedRevision: updated.revision,
        status: "working",
        summary: "Task unblocked",
      });
    } else {
      this.notifyUpdated(updated);
    }
    return updated;
  }

  async registerArtifact(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    sessionId?: string;
    path: string;
    title: string;
    kind: string;
    artifactId?: string;
    baseVersionId?: string;
    changeSummary?: string;
    workItemId?: string;
    provenance?: Record<string, unknown>;
  }): Promise<TaskRecord> {
    return await this.registerArtifactLocked(input);
  }

  private async registerArtifactLocked(
    input: {
      taskId: string;
      workspacePath: string;
      expectedRevision: number;
      sessionId?: string;
      path: string;
      title: string;
      kind: string;
      artifactId?: string;
      baseVersionId?: string;
      changeSummary?: string;
      workItemId?: string;
      provenance?: Record<string, unknown>;
    },
    options: { finishActiveRevisionInCurrentLock?: boolean } = {},
  ): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (input.workItemId && !task.workItems.some((item) => item.id === input.workItemId)) {
      throw new Error(`Unknown work item: ${input.workItemId}`);
    }
    const resolvedPath = await this.resolveArtifactPath(task, input.path);
    const activeRevision = input.sessionId
      ? this.options.sessionDb.getActiveTaskArtifactRevisionForSession(input.sessionId)
      : null;
    if (activeRevision) {
      if (input.artifactId && activeRevision.artifactId !== input.artifactId) {
        throw new Error("Active revision targets a different artifact");
      }
      if (input.baseVersionId && input.baseVersionId !== activeRevision.baseVersionId) {
        throw new Error("Artifact base version does not match the active revision");
      }
      const activeDetail = this.options.sessionDb.getTaskArtifactDetail(
        task.id,
        activeRevision.artifactId,
      );
      if (!activeDetail || !sameWorkspacePath(activeDetail.artifact.path, resolvedPath)) {
        throw new Error("Active revision targets a different artifact path");
      }
      const finalized = options.finishActiveRevisionInCurrentLock
        ? await this.handleThreadOutcomeLocked(input.sessionId as string, "completed")
        : await this.handleThreadOutcome(input.sessionId as string, "completed");
      if (!finalized) throw new Error("Active artifact revision could not be finalized");
      return finalized.task;
    }
    const stored = await this.artifactStore.captureFile(resolvedPath);
    const thread = input.sessionId
      ? task.threads.find((candidate) => candidate.sessionId === input.sessionId)
      : null;
    const createdAt = nowIso();
    const existingArtifact = input.artifactId
      ? task.artifacts.find((candidate) => candidate.id === input.artifactId)
      : task.artifacts.find((candidate) => sameWorkspacePath(candidate.path, resolvedPath));
    if (input.artifactId && !existingArtifact) {
      throw new Error(`Unknown task artifact: ${input.artifactId}`);
    }
    const artifactRecord: TaskArtifact = {
      id: existingArtifact?.id ?? crypto.randomUUID(),
      taskId: task.id,
      workItemId: input.workItemId ?? existingArtifact?.workItemId ?? null,
      threadId: thread?.id ?? existingArtifact?.threadId ?? null,
      path: resolvedPath,
      kind: nonEmpty(input.kind, "Artifact kind"),
      title: nonEmpty(input.title, "Artifact title"),
      createdBy: existingArtifact?.createdBy ?? input.sessionId ?? "user",
      provenance: { ...(existingArtifact?.provenance ?? {}), ...(input.provenance ?? {}) },
      createdAt: existingArtifact?.createdAt ?? createdAt,
    };
    const existingDetail = existingArtifact
      ? this.options.sessionDb.getTaskArtifactDetail(task.id, existingArtifact.id)
      : null;
    const parentVersion = existingDetail?.versions.at(-1) ?? null;
    if (
      input.baseVersionId &&
      !existingDetail?.versions.some((version) => version.id === input.baseVersionId)
    ) {
      throw new Error(`Unknown artifact base version: ${input.baseVersionId}`);
    }
    if (parentVersion?.sha256 === stored.sha256) return task;
    const version = this.makeArtifactVersion({
      artifact: artifactRecord,
      version: (parentVersion?.version ?? 0) + 1,
      parentVersionId: parentVersion?.id ?? null,
      stored,
      mediaType: mediaTypeForArtifact(resolvedPath, artifactRecord.kind),
      createdBy: input.sessionId ?? "user",
      createdAt,
      changeSummary:
        input.changeSummary?.trim() ||
        (parentVersion ? "Updated artifact registered" : "Initial artifact registered"),
      provenance: {
        ...(input.provenance ?? {}),
        ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}),
      },
      reviewStatus: "draft",
    });
    const updated = await this.options.sessionDb.registerTaskArtifactVersioned({
      artifact: artifactRecord,
      version,
      expectedRevision: input.expectedRevision,
      updatedAt: createdAt,
    });
    this.notifyUpdated(updated);
    return updated;
  }

  getArtifactDetail(input: {
    taskId: string;
    workspacePath: string;
    artifactId: string;
  }): TaskArtifactDetail | null {
    this.requireTask(input.taskId, input.workspacePath);
    return this.options.sessionDb.getTaskArtifactDetail(input.taskId, input.artifactId);
  }

  async readArtifactVersion(input: {
    taskId: string;
    workspacePath: string;
    artifactId: string;
    versionId: string;
  }): Promise<{
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    version: TaskArtifactVersion;
  }> {
    const detail = this.requireArtifactDetail(input);
    const version = detail.versions.find((candidate) => candidate.id === input.versionId);
    if (!version) throw new Error(`Unknown artifact version: ${input.versionId}`);
    return {
      bytes: await this.artifactStore.readBytes(version.sha256),
      filename: path.basename(detail.artifact.path),
      mimeType: version.mediaType,
      version,
    };
  }

  async ensureArtifactBaseline(input: {
    taskId: string;
    workspacePath: string;
    artifactId: string;
    expectedRevision: number;
    expectedSha256?: string;
    createdBy?: string;
  }): Promise<TaskArtifactDetail> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    const detail = this.requireArtifactDetail(input);
    if (detail.versions.length > 0) return detail;
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const resolvedPath = await this.resolveArtifactPath(task, detail.artifact.path);
    const stored = await this.artifactStore.captureFile(resolvedPath);
    this.assertExpectedFingerprint(detail.artifact.id, input.expectedSha256, stored.sha256);
    const createdAt = nowIso();
    const version = this.makeArtifactVersion({
      artifact: detail.artifact,
      version: 1,
      parentVersionId: null,
      stored,
      mediaType: mediaTypeForArtifact(resolvedPath, detail.artifact.kind),
      createdBy: input.createdBy ?? "system",
      createdAt,
      changeSummary: "Initial versioning baseline",
      provenance: { baseline: true },
      reviewStatus: "accepted",
    });
    const baseline = await this.options.sessionDb.registerTaskArtifactBaseline({
      taskId: input.taskId,
      artifactId: input.artifactId,
      version,
      expectedRevision: input.expectedRevision,
      updatedAt: createdAt,
    });
    const refreshedTask = this.options.sessionDb.getTask(input.taskId);
    if (refreshedTask) this.notifyUpdated(refreshedTask);
    return baseline;
  }

  async captureArtifactVersion(
    input: CaptureArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.captureArtifactVersionLocked(input),
    );
  }

  private async captureArtifactVersionLocked(
    input: CaptureArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    let task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    let detail = this.requireArtifactDetail(input);
    if (detail.versions.length === 0) {
      detail = await this.ensureArtifactBaseline({
        ...input,
        createdBy: input.createdBy,
      });
      task = this.requireTask(input.taskId, input.workspacePath);
      const baseline = detail.versions[0];
      if (!baseline) throw new Error("Artifact baseline was not created");
      return { task, detail, version: baseline };
    }
    const resolvedPath = await this.resolveArtifactPath(task, detail.artifact.path);
    const stored = await this.artifactStore.captureFile(resolvedPath);
    this.assertExpectedFingerprint(detail.artifact.id, input.expectedSha256, stored.sha256);
    const parent = detail.versions.at(-1);
    if (!parent) throw new Error("Artifact baseline was not created");
    if (parent.sha256 === stored.sha256) return { task, detail, version: parent };
    const createdAt = nowIso();
    const version = this.makeArtifactVersion({
      artifact: detail.artifact,
      version: parent.version + 1,
      parentVersionId: parent.id,
      stored,
      mediaType: mediaTypeForArtifact(resolvedPath, detail.artifact.kind),
      createdBy: input.createdBy ?? "user",
      createdAt,
      changeSummary: input.changeSummary?.trim() ?? "Artifact version captured",
      provenance: input.provenance ?? {},
      reviewStatus: "draft",
    });
    const updatedDetail = await this.options.sessionDb.captureTaskArtifactVersion({
      taskId: task.id,
      artifactId: detail.artifact.id,
      version,
      expectedRevision: input.expectedRevision,
      updatedAt: createdAt,
    });
    task = this.requireTask(task.id, task.workspacePath);
    this.notifyUpdated(task);
    return { task, detail: updatedDetail, version };
  }

  async restoreArtifactVersion(
    input: RestoreArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.restoreArtifactVersionLocked(input),
    );
  }

  private async restoreArtifactVersionLocked(
    input: RestoreArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    let task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const detail = this.requireArtifactDetail(input);
    const target = detail.versions.find((version) => version.id === input.versionId);
    if (!target) throw new Error(`Unknown artifact version: ${input.versionId}`);
    const parent = detail.versions.at(-1);
    if (!parent) throw new Error("Artifact has no version to restore from");
    const resolvedPath = await this.resolveArtifactPath(task, detail.artifact.path);
    const current = await this.artifactStore.fingerprintFile(resolvedPath);
    this.assertExpectedFingerprint(
      detail.artifact.id,
      input.expectedSha256 ?? parent.sha256,
      current?.sha256 ?? null,
    );
    await this.artifactStore.restoreFile({
      blobSha256: target.sha256,
      filePath: resolvedPath,
      expectedFingerprint: input.expectedSha256 ?? parent.sha256,
    });
    const createdAt = nowIso();
    const version = this.makeArtifactVersion({
      artifact: detail.artifact,
      version: parent.version + 1,
      parentVersionId: parent.id,
      stored: { sha256: target.sha256, sizeBytes: target.sizeBytes },
      mediaType: target.mediaType,
      createdBy: input.createdBy ?? "user",
      createdAt,
      changeSummary:
        input.changeSummary?.trim() || `Restored from artifact version ${target.version}`,
      provenance: { restoredFromVersionId: target.id },
      reviewStatus: "draft",
    });
    try {
      const updatedDetail = await this.options.sessionDb.captureTaskArtifactVersion({
        taskId: task.id,
        artifactId: detail.artifact.id,
        version,
        expectedRevision: input.expectedRevision,
        updatedAt: createdAt,
        activityKind: "artifact_version_restored",
      });
      task = this.requireTask(task.id, task.workspacePath);
      this.notifyUpdated(task);
      return { task, detail: updatedDetail, version };
    } catch (error) {
      await this.artifactStore.restoreFile({
        blobSha256: parent.sha256,
        filePath: resolvedPath,
      });
      throw error;
    }
  }

  async acceptArtifactVersion(
    input: AcceptArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail }> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.acceptArtifactVersionLocked(input),
    );
  }

  private async acceptArtifactVersionLocked(
    input: AcceptArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail }> {
    const current = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(current, input.expectedRevision);
    assertTaskAcceptsMutation(current);
    const detail = this.requireArtifactDetail(input);
    const versionId = input.versionId ?? detail.latestVersionId;
    if (!versionId) throw new Error("Artifact has no version to accept");
    const task = await this.options.sessionDb.acceptTaskArtifactVersion({
      taskId: input.taskId,
      artifactId: input.artifactId,
      versionId,
      expectedRevision: input.expectedRevision,
      updatedAt: nowIso(),
    });
    const updatedDetail = this.requireArtifactDetail(input);
    this.notifyUpdated(task);
    return { task, detail: updatedDetail };
  }

  async acceptTask(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
  }): Promise<TaskRecord> {
    const current = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(current, input.expectedRevision);
    return await this.runTaskMutation(input.taskId, async () => await this.acceptTaskLocked(input));
  }

  private async acceptTaskLocked(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
  }): Promise<TaskRecord> {
    const current = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(current, input.expectedRevision);
    if (current.status !== "awaiting_review") {
      throw new Error("Task must be awaiting review before it can be accepted");
    }
    let reviewedMaterial: TaskReviewMaterial | null;
    try {
      reviewedMaterial = await this.requireCompletionReviewEligibility(current);
      if (reviewedMaterial) {
        await this.assertLiveArtifactEvidenceUnchanged(current, reviewedMaterial);
      }
    } catch (error) {
      await this.returnTaskToWorkingAfterStaleAcceptance(current, error);
      throw error;
    }
    if (reviewedMaterial) {
      let task: TaskRecord;
      try {
        task = await this.options.sessionDb.acceptAllTaskArtifactVersionsValidated({
          taskId: current.id,
          expectedRevision: input.expectedRevision,
          updatedAt: nowIso(),
          validateAcceptedTask: async (acceptedTask) => {
            await this.assertLiveArtifactEvidenceUnchanged(acceptedTask, reviewedMaterial);
          },
        });
      } catch (error) {
        await this.returnTaskToWorkingAfterStaleAcceptance(current, error);
        throw error;
      }
      await this.quiesceTaskThreads(task);
      this.notifyUpdated(task);
      return task;
    }
    const task = await this.options.sessionDb.acceptAllTaskArtifactVersions({
      taskId: current.id,
      expectedRevision: input.expectedRevision,
      updatedAt: nowIso(),
    });
    await this.quiesceTaskThreads(task);
    this.notifyUpdated(task);
    return task;
  }

  async requestChanges(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    feedback: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    if (task.status !== "awaiting_review") {
      throw new Error("Task must be awaiting review before changes can be requested");
    }
    return await this.transition({
      taskId: task.id,
      workspacePath: task.workspacePath,
      expectedRevision: input.expectedRevision,
      status: "working",
      summary: "Changes requested",
      detail: input.feedback,
    });
  }

  async reopenTask(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    reason?: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    if (task.status !== "completed" && task.status !== "cancelled") {
      throw new Error("Only completed or cancelled tasks can be reopened");
    }
    return await this.recoverTerminalTask({
      task,
      expectedRevision: input.expectedRevision,
      summary: "Task reopened",
      detail: input.reason,
    });
  }

  async startArtifactRevision(input: StartArtifactRevisionRequest): Promise<{
    task: TaskRecord;
    detail: TaskArtifactDetail;
    revision: TaskArtifactRevision;
  }> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.startArtifactRevisionLocked(input),
    );
  }

  private async startArtifactRevisionLocked(input: StartArtifactRevisionRequest): Promise<{
    task: TaskRecord;
    detail: TaskArtifactDetail;
    revision: TaskArtifactRevision;
  }> {
    let task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsNewThreads(task);
    let detail = this.requireArtifactDetail(input);
    if (detail.versions.length === 0) {
      detail = await this.ensureArtifactBaseline({
        taskId: input.taskId,
        workspacePath: input.workspacePath,
        artifactId: input.artifactId,
        expectedRevision: input.expectedRevision,
        createdBy: "system",
      });
      task = this.requireTask(input.taskId, input.workspacePath);
      assertTaskAcceptsNewThreads(task);
    }
    if (detail.activeRevision) throw new Error("Artifact already has an active revision");
    const prior = detail.versions.at(-1);
    if (!prior) throw new Error("Artifact has no baseline version");
    const baseId = input.baseVersionId ?? detail.acceptedVersionId ?? prior.id;
    const base = detail.versions.find((version) => version.id === baseId);
    if (!base) throw new Error(`Unknown artifact base version: ${baseId}`);
    const resolvedPath = await this.resolveArtifactPath(task, detail.artifact.path);
    const current = await this.artifactStore.fingerprintFile(resolvedPath);
    this.assertExpectedFingerprint(detail.artifact.id, prior.sha256, current?.sha256 ?? null);
    const changedWorkingBase = base.id !== prior.id;
    if (changedWorkingBase) {
      await this.artifactStore.restoreFile({
        blobSha256: base.sha256,
        filePath: resolvedPath,
        expectedFingerprint: current?.sha256,
      });
    }
    if (!this.threadFactory) {
      if (changedWorkingBase) {
        await this.artifactStore.restoreFile({ blobSha256: prior.sha256, filePath: resolvedPath });
      }
      throw new Error("Task thread creation is unavailable");
    }

    const createdAt = nowIso();
    const workItemId = crypto.randomUUID();
    const threadTitle = nonEmpty(input.title ?? `Revise ${detail.artifact.title}`, "Thread title");
    let created: { sessionId: string };
    try {
      created = await this.threadFactory({
        task,
        title: threadTitle,
        workItemId,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
    } catch (error) {
      if (changedWorkingBase) {
        await this.artifactStore.restoreFile({ blobSha256: prior.sha256, filePath: resolvedPath });
      }
      throw error;
    }
    const thread: TaskThread = {
      id: crypto.randomUUID(),
      taskId: task.id,
      sessionId: created.sessionId,
      title: threadTitle,
      createdBy: "coordinator",
      createdAt,
      updatedAt: createdAt,
    };
    const revision: TaskArtifactRevision = {
      id: crypto.randomUUID(),
      taskId: task.id,
      artifactId: detail.artifact.id,
      workItemId,
      taskThreadId: thread.id,
      sessionId: thread.sessionId,
      baseVersionId: base.id,
      priorVersionId: prior.id,
      status: "active",
      instruction: nonEmpty(input.instruction, "Revision instruction"),
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    const workItem: WorkItem = {
      id: workItemId,
      taskId: task.id,
      title: threadTitle,
      description: revision.instruction,
      status: "in_progress",
      dependsOn: [],
      assignedThreadId: thread.id,
      claimedByThreadId: thread.id,
      expectedOutputs: [detail.artifact.path],
      completionEvidence: null,
      position: task.workItems.length,
      createdAt,
      updatedAt: createdAt,
    };
    try {
      task = await this.options.sessionDb.startTaskArtifactRevision({
        revision,
        thread,
        workItem,
        expectedRevision: task.revision,
      });
    } catch (error) {
      if (changedWorkingBase) {
        await this.artifactStore.restoreFile({ blobSha256: prior.sha256, filePath: resolvedPath });
      }
      throw error;
    }
    detail = this.requireArtifactDetail(input);
    this.notifyUpdated(task);
    return { task, detail, revision };
  }

  async handleThreadOutcome(
    sessionId: string,
    outcome: "completed" | "cancelled" | "error",
    failure?: unknown,
  ): Promise<{
    task: TaskRecord;
    detail: TaskArtifactDetail;
    revision: TaskArtifactRevision;
  } | null> {
    const knownRevision =
      this.options.sessionDb.getActiveTaskArtifactRevisionForSession(sessionId) ??
      this.options.sessionDb.getTaskArtifactRevisionForSession(sessionId);
    if (!knownRevision) {
      if (outcome === "error") await this.failPrimaryTaskRun(sessionId, failure);
      return null;
    }
    return await this.runTaskMutation(
      knownRevision.taskId,
      async () => await this.handleThreadOutcomeLocked(sessionId, outcome, failure),
    );
  }

  private async handleThreadOutcomeLocked(
    sessionId: string,
    outcome: "completed" | "cancelled" | "error",
    _failure?: unknown,
  ): Promise<{
    task: TaskRecord;
    detail: TaskArtifactDetail;
    revision: TaskArtifactRevision;
  } | null> {
    const revision = this.options.sessionDb.getActiveTaskArtifactRevisionForSession(sessionId);
    if (!revision) {
      const closedRevision = this.options.sessionDb.getTaskArtifactRevisionForSession(sessionId);
      if (closedRevision) {
        const closedTask = this.options.sessionDb.getTask(closedRevision.taskId);
        const closedDetail = this.options.sessionDb.getTaskArtifactDetail(
          closedRevision.taskId,
          closedRevision.artifactId,
        );
        if (!closedTask || !closedDetail) return null;
        return { task: closedTask, detail: closedDetail, revision: closedRevision };
      }
      return null;
    }
    const task = this.options.sessionDb.getTask(revision.taskId);
    if (!task) throw new Error(`Unknown task: ${revision.taskId}`);
    const detail = this.options.sessionDb.getTaskArtifactDetail(task.id, revision.artifactId);
    if (!detail) throw new Error(`Unknown task artifact: ${revision.artifactId}`);
    const prior = detail.versions.find((version) => version.id === revision.priorVersionId);
    if (!prior) throw new Error(`Unknown prior artifact version: ${revision.priorVersionId}`);
    if (isTerminalTask(task)) {
      const updatedTask = await this.options.sessionDb.abandonTaskArtifactRevisionForTerminalTask({
        revisionId: revision.id,
        updatedAt: nowIso(),
      });
      const updatedRevision = this.options.sessionDb.getTaskArtifactRevision(revision.id);
      const updatedDetail = this.options.sessionDb.getTaskArtifactDetail(
        task.id,
        revision.artifactId,
      );
      if (!updatedRevision || !updatedDetail) throw new Error("Artifact revision did not close");
      this.notifyUpdated(updatedTask);
      return { task: updatedTask, detail: updatedDetail, revision: updatedRevision };
    }
    const resolvedPath = await this.resolveArtifactPath(task, detail.artifact.path);

    if (outcome === "completed") {
      try {
        const latest = detail.versions.at(-1);
        if (latest?.id !== prior.id) {
          throw new Error("Artifact version changed while its revision thread was active");
        }
        const stored = await this.artifactStore.captureFile(resolvedPath);
        const createdAt = nowIso();
        const version = this.makeArtifactVersion({
          artifact: detail.artifact,
          version: prior.version + 1,
          parentVersionId: prior.id,
          stored,
          mediaType: mediaTypeForArtifact(resolvedPath, detail.artifact.kind),
          createdBy: sessionId,
          createdAt,
          changeSummary: revision.instruction,
          provenance: {
            revisionId: revision.id,
            baseVersionId: revision.baseVersionId,
            sessionId,
          },
          reviewStatus: "draft",
        });
        const updatedTask = await this.options.sessionDb.completeTaskArtifactRevision({
          revisionId: revision.id,
          version,
          updatedAt: createdAt,
        });
        const completedRevision = this.options.sessionDb.getTaskArtifactRevision(revision.id);
        const updatedDetail = this.options.sessionDb.getTaskArtifactDetail(
          task.id,
          detail.artifact.id,
        );
        if (!completedRevision || !updatedDetail)
          throw new Error("Artifact revision did not persist");
        this.notifyUpdated(updatedTask);
        return { task: updatedTask, detail: updatedDetail, revision: completedRevision };
      } catch (error) {
        await this.artifactStore.restoreFile({
          blobSha256: prior.sha256,
          filePath: resolvedPath,
        });
        const failedTask = await this.options.sessionDb.failTaskArtifactRevision({
          revisionId: revision.id,
          status: "error",
          updatedAt: nowIso(),
          detail: error instanceof Error ? error.message : String(error),
        });
        const failedRevision = this.options.sessionDb.getTaskArtifactRevision(revision.id);
        const updatedDetail = this.options.sessionDb.getTaskArtifactDetail(
          task.id,
          detail.artifact.id,
        );
        if (!failedRevision || !updatedDetail) throw error;
        this.notifyUpdated(failedTask);
        return { task: failedTask, detail: updatedDetail, revision: failedRevision };
      }
    }

    await this.artifactStore.restoreFile({
      blobSha256: prior.sha256,
      filePath: resolvedPath,
    });
    const failedTask = await this.options.sessionDb.failTaskArtifactRevision({
      revisionId: revision.id,
      status: outcome,
      updatedAt: nowIso(),
      detail: outcome === "cancelled" ? "Revision cancelled" : "Revision thread failed",
    });
    const failedRevision = this.options.sessionDb.getTaskArtifactRevision(revision.id);
    const updatedDetail = this.options.sessionDb.getTaskArtifactDetail(task.id, detail.artifact.id);
    if (!failedRevision || !updatedDetail) throw new Error("Artifact revision did not finalize");
    this.notifyUpdated(failedTask);
    return { task: failedTask, detail: updatedDetail, revision: failedRevision };
  }

  async retryTask(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
  }): Promise<{
    task: TaskRecord;
    retryStatus: Exclude<TaskQuestionResumeStatus, "not_needed">;
  }> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    if (task.revision !== input.expectedRevision) {
      throw new Error(
        `Task revision conflict: expected ${input.expectedRevision}, current ${task.revision}`,
      );
    }
    if (task.status !== "failed") throw new Error("Only failed tasks can be retried");
    const primaryThread = task.threads[0];
    if (!primaryThread) throw new Error("Task has no primary thread to retry");

    const recovered = await this.recoverTerminalTask({
      task,
      expectedRevision: task.revision,
      summary: "Task retry started",
      sessionId: primaryThread.sessionId,
    });

    if (recovered.status !== "working") {
      return {
        task: recovered,
        retryStatus: "failed",
      };
    }

    if (!this.continuationDispatcher) {
      await this.failPrimaryTaskRun(
        primaryThread.sessionId,
        new Error("Task continuation is unavailable"),
      );
      return {
        task: this.requireTask(task.id, task.workspacePath),
        retryStatus: "failed",
      };
    }

    const retryStatus = await this.continuationDispatcher({
      sessionId: primaryThread.sessionId,
      prompt: buildTaskRetryPrompt(task),
      displayText: `Retry task: ${task.title}`,
      onFailure: async (error) => {
        await this.failPrimaryTaskRun(primaryThread.sessionId, error);
      },
    });
    return {
      task: this.requireTask(task.id, task.workspacePath),
      retryStatus,
    };
  }

  async reconcileFailedRuns(workspacePath?: string | null): Promise<number> {
    let reconciled = 0;
    for (const summary of this.list(workspacePath)) {
      if (summary.status !== "working" && summary.status !== "planning") continue;
      const task = this.options.sessionDb.getTask(summary.id);
      const primaryThread = task?.threads[0];
      if (!task || !primaryThread) continue;
      const session = this.options.sessionDb.getSessionRecord(primaryThread.sessionId);
      if (session?.executionState !== "errored") continue;

      const failed = await this.failPrimaryTaskRun(
        primaryThread.sessionId,
        new Error("The persisted primary task run ended with an error"),
      );
      if (failed?.status === "failed") reconciled += 1;
    }
    return reconciled;
  }

  private async failPrimaryTaskRun(
    sessionId: string,
    failure?: unknown,
  ): Promise<TaskRecord | null> {
    const task = this.options.sessionDb.getTaskForThread(sessionId);
    const primaryThread = task?.threads[0];
    if (!task || primaryThread?.sessionId !== sessionId) return null;
    if (task.status === "failed") return task;
    if (task.status !== "working" && task.status !== "planning") return null;

    const detail =
      failure instanceof Error
        ? failure.message
        : failure === undefined
          ? "The primary task run ended with an error"
          : String(failure);
    try {
      return await this.transition({
        taskId: task.id,
        workspacePath: task.workspacePath,
        expectedRevision: task.revision,
        status: "failed",
        summary: "Task run failed",
        detail,
        sessionId,
      });
    } catch (error) {
      const current = this.options.sessionDb.getTask(task.id);
      if (current?.status === "failed") return current;
      throw error;
    }
  }

  async transition(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    status: TaskStatus;
    summary: string;
    detail?: string;
    sessionId?: string;
  }): Promise<TaskRecord> {
    const initial = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(initial, input.expectedRevision);
    return await this.runTaskMutation(input.taskId, async () => await this.transitionLocked(input));
  }

  private async transitionLocked(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    status: TaskStatus;
    summary: string;
    detail?: string;
    sessionId?: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    const expectedRevision = input.expectedRevision;
    if (input.status === "completed" && task.status === "awaiting_review") {
      return await this.acceptTaskLocked({
        taskId: task.id,
        workspacePath: task.workspacePath,
        expectedRevision,
      });
    }
    if (!TASK_TRANSITIONS[task.status].includes(input.status)) {
      throw new Error(`Invalid task transition: ${task.status} -> ${input.status}`);
    }
    if (
      input.status === "working" &&
      (task.questions.some((question) => question.status === "pending" && question.blocking) ||
        task.blockers.some((blocker) => blocker.status === "active" && blocker.blocking))
    ) {
      throw new Error("Task cannot return to working while blocking input or issues remain");
    }
    const thread = input.sessionId
      ? task.threads.find((candidate) => candidate.sessionId === input.sessionId)
      : null;
    const updated = await this.options.sessionDb.setTaskStatus({
      taskId: task.id,
      expectedRevision,
      status: input.status,
      summary: nonEmpty(input.summary, "Status summary"),
      detail: input.detail?.trim() || null,
      updatedAt: nowIso(),
      threadId: thread?.id ?? null,
    });
    await this.quiesceTaskThreads(updated);
    this.notifyUpdated(updated);
    return updated;
  }

  private async recoverTerminalTask(input: {
    task: TaskRecord;
    expectedRevision: number;
    summary: string;
    detail?: string;
    sessionId?: string;
  }): Promise<TaskRecord> {
    const { task } = input;
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task ${task.id} is not terminal`);
    }
    if (task.revision !== input.expectedRevision) {
      throw new Error(
        `Task revision conflict: expected ${input.expectedRevision}, current ${task.revision}`,
      );
    }
    const recoveryStatus: TaskStatus =
      task.questions.some((question) => question.status === "pending" && question.blocking) ||
      task.blockers.some((blocker) => blocker.status === "active" && blocker.blocking)
        ? "blocked"
        : "working";
    const thread = input.sessionId
      ? task.threads.find((candidate) => candidate.sessionId === input.sessionId)
      : null;
    const updated = await this.options.sessionDb.setTaskStatus({
      taskId: task.id,
      expectedRevision: input.expectedRevision,
      status: recoveryStatus,
      summary: nonEmpty(input.summary, "Status summary"),
      detail: input.detail?.trim() || null,
      updatedAt: nowIso(),
      threadId: thread?.id ?? null,
    });
    this.notifyUpdated(updated);
    return updated;
  }

  async recordReview(input: {
    taskId: string;
    workspacePath: string;
    sessionId?: string;
    expectedRevision: number;
    expectedMaterialFingerprint?: string;
    reviewerAgentId: string;
    reviewerProvider: string;
    reviewerModel: string;
    verdict: TaskReviewVerdict;
    feedback: string;
  }): Promise<{ task: TaskRecord; reviewId: string; round: number }> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.recordReviewLocked(input),
    );
  }

  private async recordReviewLocked(input: {
    taskId: string;
    workspacePath: string;
    sessionId?: string;
    expectedRevision: number;
    expectedMaterialFingerprint?: string;
    reviewerAgentId: string;
    reviewerProvider: string;
    reviewerModel: string;
    verdict: TaskReviewVerdict;
    feedback: string;
  }): Promise<{ task: TaskRecord; reviewId: string; round: number }> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (task.status !== "working") {
      throw new Error("Independent reviews can run only while a task is working");
    }
    const requiredRounds = task.reviewRounds ?? 0;
    if (requiredRounds === 0) throw new Error("This task does not require independent reviews");
    if (task.workItems.length === 0) throw new Error("Task has no work plan");
    const unfinished = task.workItems.filter(
      (item) => item.status !== "done" && item.status !== "review" && item.status !== "abandoned",
    );
    if (unfinished.length > 0) {
      throw new Error(`Task has ${unfinished.length} unfinished work item(s)`);
    }
    const missingOutput = task.workItems.find(
      (item) =>
        item.expectedOutputs.length > 0 &&
        !task.artifacts.some((artifactRecord) => artifactRecord.workItemId === item.id),
    );
    if (missingOutput) {
      throw new Error(`Expected artifact is not registered for: ${missingOutput.title}`);
    }

    const reviews = this.options.sessionDb.listTaskReviews(task.id);
    const rounds = getTaskReviewRoundsFromRecords(reviews);
    const pending = getPendingTaskReviewFromRecords(reviews);
    if (pending) {
      throw new Error(
        `Review round ${pending.round} feedback must be addressed before another review`,
      );
    }
    if (rounds.length >= MAX_TASK_REVIEW_ROUNDS) {
      throw new Error(`Task reached the ${MAX_TASK_REVIEW_ROUNDS}-round review safety cap`);
    }
    const reviewerAgentId = nonEmpty(input.reviewerAgentId, "Reviewer agent id");
    if (rounds.some((round) => round.reviewerAgentId === reviewerAgentId)) {
      throw new Error("Each independent review round must use a new reviewer agent");
    }

    const round = rounds.length + 1;
    const material = await this.currentReviewMaterial(task);
    const expectedMaterialFingerprint = input.expectedMaterialFingerprint?.trim();
    if (expectedMaterialFingerprint && material.fingerprint !== expectedMaterialFingerprint) {
      throw new Error(
        "Reviewed material changed before the review could be recorded; rerun a fresh independent review",
      );
    }
    const reviewId = crypto.randomUUID();
    const feedback = nonEmpty(input.feedback, "Review feedback");
    const reviewerProvider = nonEmpty(input.reviewerProvider, "Reviewer provider");
    const reviewerModel = nonEmpty(input.reviewerModel, "Reviewer model");
    const createdAt = nowIso();
    const review: TaskReviewRecord = {
      id: reviewId,
      taskId: task.id,
      round,
      verdict: input.verdict,
      feedback,
      reviewerAgentId,
      reviewerProvider,
      reviewerModel,
      taskRevision: task.revision,
      materialFingerprint: material.fingerprint,
      materialSnapshot: material.snapshot,
      createdAt,
      addressedAt: null,
      implementationSummary: null,
    };
    const reviewActivity = activity({
      taskId: task.id,
      threadId:
        task.threads.find((candidate) => candidate.sessionId === input.sessionId)?.id ?? null,
      workItemId: null,
      kind: "review_completed",
      summary: `Independent review round ${round}: ${input.verdict.toUpperCase()}`,
      detail: JSON.stringify({
        round,
        verdict: input.verdict,
        feedback,
        reviewerAgentId,
        reviewerProvider,
        reviewerModel,
      }),
    });
    reviewActivity.id = reviewId;
    reviewActivity.createdAt = createdAt;
    const updated = await this.options.sessionDb.recordTaskReview({
      review,
      activity: reviewActivity,
      expectedRevision: input.expectedRevision,
    });
    this.notifyUpdated(updated);
    this.notifyActivity(updated);
    return { task: updated, reviewId: reviewActivity.id, round };
  }

  async addressReview(input: {
    taskId: string;
    workspacePath: string;
    sessionId?: string;
    expectedRevision: number;
    reviewId: string;
    implementationSummary: string;
  }): Promise<TaskRecord> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.addressReviewLocked(input),
    );
  }

  private async addressReviewLocked(input: {
    taskId: string;
    workspacePath: string;
    sessionId?: string;
    expectedRevision: number;
    reviewId: string;
    implementationSummary: string;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const pending = getPendingTaskReviewFromRecords(
      this.options.sessionDb.listTaskReviews(task.id),
    );
    if (!pending) throw new Error("Task has no unaddressed review feedback");
    if (pending.reviewId !== input.reviewId) {
      throw new Error(`Review ${input.reviewId} is not the pending review`);
    }
    const implementationSummary = nonEmpty(
      input.implementationSummary,
      "Review implementation summary",
    );
    const addressedAt = nowIso();
    const addressedActivity = activity({
      taskId: task.id,
      threadId:
        task.threads.find((candidate) => candidate.sessionId === input.sessionId)?.id ?? null,
      workItemId: null,
      kind: "review_addressed",
      summary: `Independent review round ${pending.round} feedback implemented`,
      detail: JSON.stringify({
        reviewId: pending.reviewId,
        implementationSummary,
      }),
    });
    addressedActivity.createdAt = addressedAt;
    const updated = await this.options.sessionDb.addressTaskReview({
      taskId: task.id,
      reviewId: pending.reviewId,
      expectedRevision: input.expectedRevision,
      addressedAt,
      implementationSummary,
      activity: addressedActivity,
    });
    this.notifyUpdated(updated);
    this.notifyActivity(updated);
    return updated;
  }

  private assertCompletionReadiness(task: TaskRecord): void {
    if (task.questions.some((question) => question.status === "pending" && question.blocking)) {
      throw new Error("Task has unresolved blocking questions");
    }
    if (task.questions.some((question) => question.status === "pending")) {
      throw new Error("Task has unresolved pending questions");
    }
    const unfinished = task.workItems.filter(
      (item) => item.status !== "done" && item.status !== "review" && item.status !== "abandoned",
    );
    if (task.workItems.length === 0) throw new Error("Task has no work plan");
    if (unfinished.length > 0) {
      throw new Error(`Task has ${unfinished.length} unfinished work item(s)`);
    }
    const blocking = task.blockers.filter((item) => item.status === "active" && item.blocking);
    if (blocking.length > 0) throw new Error("Task has unresolved blocking issues");
    const missingOutput = task.workItems.find(
      (item) =>
        item.expectedOutputs.length > 0 &&
        !task.artifacts.some((artifactRecord) => artifactRecord.workItemId === item.id),
    );
    if (missingOutput) {
      throw new Error(`Expected artifact is not registered for: ${missingOutput.title}`);
    }
  }

  private async requireCompletionReviewEligibility(
    task: TaskRecord,
  ): Promise<TaskReviewMaterial | null> {
    const requiredReviewRounds = task.reviewRounds ?? 0;
    if (requiredReviewRounds <= 0) return null;

    const reviews = this.options.sessionDb.listTaskReviews(task.id);
    const reviewRounds = getTaskReviewRoundsFromRecords(reviews);
    const materialForCompletion = await this.currentReviewMaterial(task);
    const currentPasses = reviewRounds.filter(
      (round) =>
        round.verdict === "pass" && round.materialFingerprint === materialForCompletion.fingerprint,
    );
    const pendingReview = getPendingTaskReviewFromRecords(reviews);
    if (pendingReview) {
      throw new Error(`Review round ${pendingReview.round} feedback must be addressed`);
    }
    if (currentPasses.length < requiredReviewRounds) {
      throw new Error(
        `Task requires ${requiredReviewRounds} independent review round(s) with fresh passing reviews for the current delivery state; ${currentPasses.length} recorded`,
      );
    }
    const latestReview = reviewRounds.at(-1);
    if (
      latestReview?.verdict !== "pass" ||
      latestReview.materialFingerprint !== materialForCompletion.fingerprint
    ) {
      throw new Error(
        "Task requires a fresh passing review for the current delivery state before completion",
      );
    }
    return materialForCompletion;
  }

  private async returnTaskToWorkingAfterStaleAcceptance(
    task: TaskRecord,
    error: unknown,
    sessionId?: string,
  ): Promise<void> {
    const latest = this.options.sessionDb.getTask(task.id);
    if (latest?.status !== "awaiting_review") return;
    try {
      await this.transitionLocked({
        taskId: latest.id,
        workspacePath: latest.workspacePath,
        expectedRevision: latest.revision,
        status: "working",
        summary: "Task review material changed before acceptance",
        detail: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    } catch {
      // Keep the original acceptance failure. Some blocking-state changes may
      // intentionally prevent an automatic return to working.
    }
  }

  private async assertLiveArtifactEvidenceUnchanged(
    task: TaskRecord,
    reviewedMaterial: TaskReviewMaterial,
  ): Promise<void> {
    const currentMaterial = await this.currentReviewMaterial(task);
    if (
      stableStringify(liveArtifactEvidence(currentMaterial)) !==
      stableStringify(liveArtifactEvidence(reviewedMaterial))
    ) {
      throw new Error(
        "Task requires a fresh passing review for the current delivery state before completion",
      );
    }
  }

  async proposeCompletion(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    summary: string;
    caveats?: string[];
    sessionId?: string;
  }): Promise<TaskRecord> {
    return await this.runTaskMutation(
      input.taskId,
      async () => await this.proposeCompletionLocked(input),
    );
  }

  private async proposeCompletionLocked(input: {
    taskId: string;
    workspacePath: string;
    expectedRevision: number;
    summary: string;
    caveats?: string[];
    sessionId?: string;
  }): Promise<TaskRecord> {
    let task = this.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (task.questions.some((question) => question.status === "pending" && question.blocking)) {
      throw new Error("Task has unresolved blocking questions");
    }
    if (task.questions.some((question) => question.status === "pending")) {
      task = await this.options.sessionDb.defaultPendingTaskQuestions({
        taskId: task.id,
        expectedRevision: input.expectedRevision,
        updatedAt: nowIso(),
      });
      this.notifyUpdated(task);
      this.notifyActivity(task);
    }
    this.assertCompletionReadiness(task);
    const currentMaterial = await this.requireCompletionReviewEligibility(task);
    if (currentMaterial) {
      const nextMaterial = await this.currentReviewMaterial(task);
      if (nextMaterial.fingerprint !== currentMaterial.fingerprint) {
        throw new Error(
          "Task requires a fresh passing review for the current delivery state before completion",
        );
      }
    }
    const ready = await this.transitionLocked({
      taskId: task.id,
      workspacePath: task.workspacePath,
      expectedRevision: task.revision,
      status: "awaiting_review",
      summary: input.summary,
      detail: input.caveats?.filter(Boolean).join("\n") || undefined,
      sessionId: input.sessionId,
    });
    if (task.reviewRequired) return ready;
    return await this.acceptTaskLocked({
      taskId: ready.id,
      workspacePath: ready.workspacePath,
      expectedRevision: ready.revision,
    });
  }

  async checkpointThread(
    sessionId: string,
    reason: string,
    agentSummary = "",
    options?: { allowTerminal?: boolean },
  ): Promise<TaskRecord | null> {
    const task = this.getForThread(sessionId);
    if (!task) return null;
    if (!options?.allowTerminal && isTerminalTask(task)) return task;
    const thread = task.threads.find((candidate) => candidate.sessionId === sessionId) ?? null;
    let checkpoint: TaskCheckpoint;
    try {
      checkpoint = await this.options.sessionDb.createTaskCheckpoint(
        {
          id: crypto.randomUUID(),
          taskId: task.id,
          threadId: thread?.id ?? null,
          taskRevision: task.revision,
          reason: nonEmpty(reason, "Checkpoint reason"),
          agentSummary,
          contextDigest: JSON.stringify({
            objective: task.objective,
            status: task.status,
            workItems: task.workItems.map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
            })),
            decisions: task.decisions
              .filter((item) => item.status === "active")
              .map((item) => ({ question: item.question, resolution: item.resolution })),
            questions: task.questions
              .filter((item) => item.status === "pending")
              .map((item) => ({ question: item.question, blocking: item.blocking })),
            blockers: task.blockers
              .filter((item) => item.status === "active")
              .map((item) => item.description),
          }),
          taskSnapshot: taskSnapshot(task),
          artifactManifest: task.artifacts.map((item) => ({
            id: item.id,
            path: item.path,
            title: item.title,
            kind: item.kind,
          })),
          createdAt: nowIso(),
        },
        { rejectTerminal: options?.allowTerminal !== true },
      );
    } catch (error) {
      if (isTerminalTaskMutationError(task.id, error))
        return this.options.sessionDb.getTask(task.id);
      throw error;
    }
    this.options.notify?.({
      method: "task/checkpointCreated",
      params: { cwd: task.workspacePath, taskId: task.id, checkpoint },
    });
    return this.options.sessionDb.getTask(task.id);
  }

  async applyDirective(sessionId: string, directive: TaskDirective): Promise<TaskDirectiveResult> {
    const task = this.getForThread(sessionId);
    if (!task) throw new Error("Task directives are available only in task threads");
    return await this.options.sessionDb.runTaskMutationExclusive(
      "apply_task_directive",
      task.id,
      async () => await this.applyDirectiveLocked(sessionId, directive),
    );
  }

  private async applyDirectiveLocked(
    sessionId: string,
    directive: TaskDirective,
  ): Promise<TaskDirectiveResult> {
    const current = this.getForThread(sessionId);
    if (!current) throw new Error("Task directives are available only in task threads");
    const receipt = this.options.sessionDb.getTaskDirectiveReceipt(
      current.id,
      nonEmpty(directive.idempotencyKey, "Idempotency key"),
    );
    if (receipt !== null) {
      const replayTask = this.requireTask(current.id, current.workspacePath);
      return {
        task: this.withDirectiveReviewState(replayTask),
        continuation: current.questions.some(
          (question) => question.status === "pending" && question.blocking,
        )
          ? "pause_for_input"
          : "continue",
      };
    }
    assertTaskAcceptsMutation(current);

    const thread = current.threads.find((candidate) => candidate.sessionId === sessionId);
    let updated: TaskRecord;
    let continuation: TaskDirectiveResult["continuation"] = "continue";
    switch (directive.type) {
      case "update_plan": {
        updated = current;
        if (directive.objective !== undefined || directive.requirements !== undefined) {
          updated = await this.updateBrief({
            taskId: current.id,
            workspacePath: current.workspacePath,
            expectedRevision: directive.expectedRevision,
            ...(directive.objective !== undefined ? { objective: directive.objective } : {}),
            ...(directive.requirements
              ? {
                  requirements: directive.requirements.map((item) => ({
                    ...item,
                    source: "agent" as const,
                  })),
                }
              : {}),
          });
        }
        updated = await this.replaceWorkItems({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: updated.revision,
          items: directive.workItems,
        });
        if (updated.status === "draft") {
          updated = await this.transitionLocked({
            taskId: current.id,
            workspacePath: current.workspacePath,
            expectedRevision: updated.revision,
            status: "planning",
            summary: "Task plan created",
            sessionId,
          });
        }
        if (updated.status === "planning" && updated.workItems.length > 0) {
          updated = await this.transitionLocked({
            taskId: current.id,
            workspacePath: current.workspacePath,
            expectedRevision: updated.revision,
            status: "working",
            summary: "Task execution started",
            sessionId,
          });
        }
        break;
      }
      case "mark_work_item":
        updated = await this.markWorkItem({
          taskId: current.id,
          workspacePath: current.workspacePath,
          workItemId: directive.workItemId,
          expectedRevision: directive.expectedRevision,
          status: directive.status,
          completionEvidence: directive.completionEvidence,
          threadId: thread?.id,
        });
        break;
      case "record_decision":
        updated = await this.recordDecision({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          question: directive.question,
          resolution: directive.resolution,
          source: "agent",
          scope: directive.scope,
          confidence: directive.confidence,
          supersedes: directive.supersedes,
        });
        break;
      case "report_progress":
        updated = await this.reportProgress({
          taskId: current.id,
          workspacePath: current.workspacePath,
          sessionId,
          summary: directive.summary,
          detail: directive.detail,
          workItemId: directive.workItemId,
        });
        break;
      case "report_blocker":
        updated = await this.reportBlockerLocked({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          description: directive.description,
          blocking: directive.blocking,
          workItemId: directive.workItemId,
        });
        break;
      case "request_input": {
        const result = await this.requestInput({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          sessionId,
          questions: directive.questions,
        });
        updated = result.task;
        continuation = result.continuation;
        break;
      }
      case "register_artifact":
        updated = await this.registerArtifactLocked(
          {
            taskId: current.id,
            workspacePath: current.workspacePath,
            expectedRevision: directive.expectedRevision,
            sessionId,
            path: directive.path,
            title: directive.title,
            kind: directive.kind,
            artifactId: directive.artifactId,
            baseVersionId: directive.baseVersionId,
            changeSummary: directive.changeSummary,
            workItemId: directive.workItemId,
            provenance: directive.provenance,
          },
          { finishActiveRevisionInCurrentLock: true },
        );
        break;
      case "record_review": {
        const result = await this.recordReviewLocked({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          expectedMaterialFingerprint: directive.expectedMaterialFingerprint,
          sessionId,
          reviewerAgentId: directive.reviewerAgentId,
          reviewerProvider: directive.reviewerProvider,
          reviewerModel: directive.reviewerModel,
          verdict: directive.verdict,
          feedback: directive.feedback,
        });
        updated = result.task;
        break;
      }
      case "address_review":
        updated = await this.addressReviewLocked({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          sessionId,
          reviewId: directive.reviewId,
          implementationSummary: directive.implementationSummary,
        });
        break;
      case "propose_completion":
        updated = await this.proposeCompletionLocked({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          summary: directive.summary,
          caveats: directive.caveats,
          sessionId,
        });
        break;
      case "create_thread":
        updated = await this.addThread({
          taskId: current.id,
          workspacePath: current.workspacePath,
          expectedRevision: directive.expectedRevision,
          title: directive.title,
          createdBy: "coordinator",
          workItemId: directive.workItemId,
        });
        break;
    }
    await this.options.sessionDb.recordTaskDirectiveReceipt(
      current.id,
      directive.idempotencyKey,
      updated.revision,
      nowIso(),
    );
    await this.checkpointThread(sessionId, `directive ${directive.type}`, "", {
      allowTerminal: true,
    });
    return { task: this.withDirectiveReviewState(updated), continuation };
  }

  private requireTask(taskId: string, workspacePath: string): TaskRecord {
    const task = this.options.sessionDb.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    assertWorkspace(task, workspacePath);
    return task;
  }

  private requireArtifactDetail(input: {
    taskId: string;
    workspacePath: string;
    artifactId: string;
  }): TaskArtifactDetail {
    this.requireTask(input.taskId, input.workspacePath);
    const detail = this.options.sessionDb.getTaskArtifactDetail(input.taskId, input.artifactId);
    if (!detail) throw new Error(`Unknown task artifact: ${input.artifactId}`);
    return detail;
  }

  private async currentReviewMaterial(task: TaskRecord): Promise<TaskReviewMaterial> {
    const artifactDetails: TaskArtifactDetail[] = [];
    for (const artifactRecord of task.artifacts) {
      const detail = this.options.sessionDb.getTaskArtifactDetail(task.id, artifactRecord.id);
      if (!detail) throw new Error(`Artifact metadata is missing: ${artifactRecord.id}`);
      artifactDetails.push(detail);
    }
    const workspaceRoot = await fs.realpath(task.workspacePath);
    const artifactFiles: TaskReviewArtifactFileSnapshot[] = [];
    for (const artifactRecord of task.artifacts) {
      const resolvedPath = await this.resolveArtifactPath(task, artifactRecord.path);
      const fingerprint = await this.artifactStore.fingerprintFile(resolvedPath);
      if (!fingerprint) throw new Error(`Artifact does not exist: ${resolvedPath}`);
      artifactFiles.push({
        artifactId: artifactRecord.id,
        path: artifactRecord.path,
        canonicalWorkspaceRelativePath: path
          .relative(workspaceRoot, resolvedPath)
          .split(path.sep)
          .join("/"),
        sha256: fingerprint.sha256,
        sizeBytes: fingerprint.sizeBytes,
      });
    }
    const snapshot = buildTaskReviewMaterialSnapshot({ task, artifactDetails, artifactFiles });
    return {
      snapshot,
      fingerprint: fingerprintTaskReviewMaterial(snapshot),
    };
  }

  private async resolveArtifactPath(task: TaskRecord, artifactPath: string): Promise<string> {
    const candidate = path.resolve(task.workspacePath, nonEmpty(artifactPath, "Artifact path"));
    let resolved: string;
    try {
      resolved = await resolvePathInsideRootForBoundaryCheck(task.workspacePath, candidate);
    } catch {
      try {
        const [canonicalWorkspacePath, canonicalCandidatePath] = await Promise.all([
          fs.realpath(task.workspacePath),
          fs.realpath(candidate).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return candidate;
            throw error;
          }),
        ]);
        resolved = await resolvePathInsideRootForBoundaryCheck(
          canonicalWorkspacePath,
          canonicalCandidatePath,
        );
      } catch {
        throw new Error("Artifact path is outside the task workspace");
      }
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new Error(`Artifact does not exist: ${resolved}`);
    }
    if (!stat.isFile()) throw new Error(`Artifact is not a file: ${resolved}`);
    return resolved;
  }

  private assertExpectedFingerprint(
    artifactId: string,
    expectedSha256: string | undefined,
    currentSha256: string | null,
  ): void {
    if (expectedSha256 !== undefined && expectedSha256 !== currentSha256) {
      throw new ArtifactConflictError(artifactId, expectedSha256, currentSha256);
    }
  }

  private makeArtifactVersion(input: {
    artifact: TaskArtifact;
    version: number;
    parentVersionId: string | null;
    stored: { sha256: string; sizeBytes: number };
    mediaType: string;
    createdBy: string;
    createdAt: string;
    changeSummary: string;
    provenance: Record<string, unknown>;
    reviewStatus: TaskArtifactVersion["reviewStatus"];
  }): TaskArtifactVersion {
    return {
      id: crypto.randomUUID(),
      artifactId: input.artifact.id,
      version: input.version,
      parentVersionId: input.parentVersionId,
      sha256: input.stored.sha256,
      sizeBytes: input.stored.sizeBytes,
      mediaType: input.mediaType,
      createdBy: nonEmpty(input.createdBy, "Artifact version creator"),
      createdAt: input.createdAt,
      changeSummary: input.changeSummary,
      provenance: input.provenance,
      reviewStatus: input.reviewStatus,
    };
  }

  private notifyUpdated(task: TaskRecord): void {
    this.options.notify?.({
      method: "task/updated",
      params: { cwd: task.workspacePath, task },
    });
  }

  private notifyActivity(task: TaskRecord): void {
    const latest = task.activity[0];
    if (!latest) return;
    this.options.notify?.({
      method: "task/activity",
      params: { cwd: task.workspacePath, taskId: task.id, activity: latest },
    });
  }
}
