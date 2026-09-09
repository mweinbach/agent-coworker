import path from "node:path";

import type {
  TaskActivity,
  TaskArtifact,
  TaskArtifactRevision,
  TaskRecord,
  TaskRequirement,
  TaskRequirementKind,
  TaskStatus,
  WorkItem,
  WorkItemStatus,
} from "../../shared/tasks";
import {
  getPendingTerminalTaskLock,
  isTerminalTaskStatus,
  makeTaskLockedError,
} from "../session/taskLocks";
import { nowIso } from "../../utils/typeGuards";
import { sameWorkspacePath } from "../../utils/workspacePath";
import type { TaskReviewArtifactFileSnapshot } from "./taskReviewPolicy";
import { buildTaskReviewMaterialSnapshot } from "./taskReviewPolicy";

/** Pure task policy: validation, prompts, transitions, and error types. */

export type TaskReviewMaterial = {
  snapshot: ReturnType<typeof buildTaskReviewMaterialSnapshot>;
  fingerprint: string;
};

type TaskReviewLiveArtifactEvidence = Array<{
  id: string;
  path: string;
  liveFile: TaskReviewArtifactFileSnapshot | null;
}>;

export function liveArtifactEvidence(material: TaskReviewMaterial): TaskReviewLiveArtifactEvidence {
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

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["planning", "working", "cancelled", "failed"],
  planning: ["working", "blocked", "cancelled", "failed"],
  working: ["blocked", "awaiting_review", "completed", "cancelled", "failed"],
  blocked: ["working", "cancelled", "failed"],
  awaiting_review: ["working", "completed", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const DEFAULT_ARTIFACT_SETTLEMENT_RETRY_DELAYS_MS = [0, 25, 100, 250, 500, 1000] as const;

export function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function assertTaskAcceptsNewThreads(
  task: TaskRecord,
  opts: { allowPendingTerminalLock?: boolean } = {},
): void {
  const pendingLock = getPendingTerminalTaskLock(task.id);
  if (pendingLock && !opts.allowPendingTerminalLock) throw makeTaskLockedError(pendingLock);
  if (!isTerminalTaskStatus(task.status)) return;
  throw new Error(
    `Task ${task.id} is ${task.status} and cannot create new focused threads until it is reopened or retried.`,
  );
}

export function assertTaskAcceptsMutation(
  task: TaskRecord,
  opts: { allowPendingTerminalLock?: boolean } = {},
): void {
  const pendingLock = getPendingTerminalTaskLock(task.id);
  if (pendingLock && !opts.allowPendingTerminalLock) throw makeTaskLockedError(pendingLock);
  if (!isTerminalTaskStatus(task.status)) return;
  throw new Error(
    `Task ${task.id} is ${task.status} and cannot be changed until it is reopened or retried.`,
  );
}

export function isTerminalTask(task: Pick<TaskRecord, "status">): boolean {
  return isTerminalTaskStatus(task.status);
}

export function isTerminalTaskMutationError(taskId: string, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith(`Task ${taskId} is `) &&
    error.message.includes("cannot be changed until it is reopened or retried")
  );
}

function taskRevisionConflictMessage(task: TaskRecord, expectedRevision: number): string {
  return `Task revision conflict: expected ${expectedRevision}, current ${task.revision}`;
}

export function assertExpectedTaskRevision(task: TaskRecord, expectedRevision: number): void {
  if (task.revision === expectedRevision) return;
  throw new Error(taskRevisionConflictMessage(task, expectedRevision));
}

const DEPENDENCY_GATED_WORK_ITEM_STATUSES = new Set<WorkItemStatus>([
  "in_progress",
  "review",
  "done",
]);

export const TERMINAL_WORK_ITEM_STATUSES = new Set<WorkItemStatus>(["blocked", "done", "abandoned"]);

export function assertTaskThreadMember(task: TaskRecord, threadId: string): void {
  if (task.threads.some((thread) => thread.id === threadId)) return;
  throw new Error(`Unknown task thread: ${threadId}`);
}

export function assertNoConflictingWorkItemOwner(item: WorkItem, threadId: string): void {
  const conflictingOwner = [item.assignedThreadId, item.claimedByThreadId].find(
    (ownerThreadId) => ownerThreadId !== null && ownerThreadId !== threadId,
  );
  if (conflictingOwner) {
    throw new Error(`Work item is owned by another task thread: ${item.id}`);
  }
}

export function assertThreadCanMutateWorkItem(input: {
  task: TaskRecord;
  item: WorkItem;
  threadId: string;
}): void {
  assertTaskThreadMember(input.task, input.threadId);
  assertNoConflictingWorkItemOwner(input.item, input.threadId);

  const ownsWorkItem =
    input.item.assignedThreadId === input.threadId ||
    input.item.claimedByThreadId === input.threadId;
  const primaryThreadId = input.task.threads[0]?.id ?? null;
  if (!ownsWorkItem && input.threadId !== primaryThreadId) {
    throw new Error(
      `Work item must be claimed before this task thread can mark it: ${input.item.id}`,
    );
  }
}

export function assertWorkItemDependenciesComplete(input: {
  items: WorkItem[];
  item: WorkItem;
  status: WorkItemStatus;
}): void {
  if (!DEPENDENCY_GATED_WORK_ITEM_STATUSES.has(input.status)) return;
  const incompleteDependency = input.item.dependsOn.find(
    (id) => input.items.find((candidate) => candidate.id === id)?.status !== "done",
  );
  if (incompleteDependency) {
    throw new Error(`Work item dependency is not complete: ${incompleteDependency}`);
  }
}

export function assertNoIncompleteDependencyRemoval(input: {
  items: WorkItem[];
  existing: WorkItem;
  next: WorkItem;
}): void {
  const nextDependencies = new Set(input.next.dependsOn);
  const removedIncompleteDependency = input.existing.dependsOn.find(
    (id) =>
      !nextDependencies.has(id) &&
      input.items.find((candidate) => candidate.id === id)?.status !== "done",
  );
  if (removedIncompleteDependency) {
    throw new Error(`Work item dependency is not complete: ${removedIncompleteDependency}`);
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function replacementChangesWorkItem(existing: WorkItem | undefined, next: WorkItem): boolean {
  if (!existing) return true;
  return (
    existing.title !== next.title ||
    existing.description !== next.description ||
    existing.status !== next.status ||
    !arraysEqual(existing.dependsOn, next.dependsOn) ||
    !arraysEqual(existing.expectedOutputs, next.expectedOutputs)
  );
}

export function assertThreadCanMarkWorkItem(input: {
  task: TaskRecord;
  item: WorkItem;
  status: WorkItemStatus;
  threadId?: string | null;
}): void {
  if (input.threadId === null || input.threadId === undefined) return;
  assertThreadCanMutateWorkItem({
    task: input.task,
    item: input.item,
    threadId: input.threadId,
  });
  assertWorkItemDependenciesComplete({
    items: input.task.workItems,
    item: input.item,
    status: input.status,
  });
}

export function assertThreadCanClaimWorkItem(input: {
  task: TaskRecord;
  item: WorkItem;
  threadId: string;
}): void {
  const threadId = input.threadId;
  assertTaskThreadMember(input.task, threadId);
  assertNoConflictingWorkItemOwner(input.item, threadId);
  assertWorkItemDependenciesComplete({
    items: input.task.workItems,
    item: input.item,
    status: "in_progress",
  });
}

export function activity(input: Omit<TaskActivity, "id" | "seq" | "createdAt">): TaskActivity {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    createdAt: nowIso(),
    ...input,
  };
}

export function requirement(input: {
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

export function validateWorkGraph(items: WorkItem[]): void {
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

export function assertWorkspace(task: TaskRecord, workspacePath: string): void {
  if (!sameWorkspacePath(task.workspacePath, workspacePath)) {
    throw new Error("Task is outside the active workspace");
  }
}

export function taskSnapshot(task: TaskRecord): Record<string, unknown> {
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
  const answers = task.questions.flatMap((question) =>
    question.status === "answered" && question.answer
      ? [{ question: question.question, answer: question.answer }]
      : [],
  );
  return [
    `Retry the task "${task.title}" in its existing task thread.`,
    "The previous run failed before the task reached a review or completion state.",
    "Review the authoritative task brief, work graph, decisions, artifacts, and latest checkpoint before continuing.",
    "Preserve completed work and resume the first unblocked unfinished work item. Do not restart completed work unless validation shows it is invalid.",
    ...(answers.length > 0 ? [buildTaskQuestionContinuationPrompt({ task, answers })] : []),
  ].join("\n\n");
}

export function mediaTypeForArtifact(filePath: string, kind: string): string {
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

export class AtomicTaskCompletionSettlementError extends Error {
  constructor(cause: unknown) {
    super(`Failed to commit task completion settlement atomically: ${String(cause)}`, { cause });
    this.name = "AtomicTaskCompletionSettlementError";
  }
}

export class TerminalTaskCompletionQuiescenceError extends Error {
  constructor(cause: unknown) {
    super(`Failed to quiesce task before completion settlement: ${String(cause)}`, { cause });
    this.name = "TerminalTaskCompletionQuiescenceError";
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
