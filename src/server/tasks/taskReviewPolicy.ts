import { createHash } from "node:crypto";
import { z } from "zod";

import {
  TASK_REVIEW_VERDICTS,
  type TaskActivity,
  type TaskArtifactDetail,
  type TaskContextSnapshot,
  type TaskRecord,
  type TaskReviewRecord,
  type TaskReviewVerdict,
} from "../../shared/tasks";

const completedReviewDetailSchema = z
  .object({
    round: z.number().int().positive(),
    verdict: z.enum(TASK_REVIEW_VERDICTS),
    feedback: z.string().trim().min(1),
    reviewerAgentId: z.string().trim().min(1),
    reviewerProvider: z.string().trim().min(1),
    reviewerModel: z.string().trim().min(1),
  })
  .strict();

const addressedReviewDetailSchema = z
  .object({
    reviewId: z.string().trim().min(1),
    implementationSummary: z.string().trim().min(1),
  })
  .strict();

export type TaskReviewRound = {
  reviewId: string;
  round: number;
  verdict: TaskReviewVerdict;
  feedback: string;
  reviewerAgentId: string;
  reviewerProvider: string;
  reviewerModel: string;
  createdAt: string;
  taskRevision?: number;
  materialFingerprint?: string;
  materialSnapshot?: Record<string, unknown>;
  addressedAt: string | null;
  implementationSummary: string | null;
};

export type TaskReviewMaterialSnapshot = {
  schemaVersion: 1;
  objective: string;
  context: string;
  requirements: Array<Record<string, unknown>>;
  workItems: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
};

export type TaskReviewArtifactFileSnapshot = {
  artifactId: string;
  path: string;
  canonicalWorkspaceRelativePath: string;
  sha256: string;
  sizeBytes: number;
};

function parseDetail(activity: TaskActivity): unknown {
  if (!activity.detail) return null;
  try {
    return JSON.parse(activity.detail);
  } catch {
    return null;
  }
}

export function getTaskReviewRounds(activity: readonly TaskActivity[]): TaskReviewRound[] {
  const ordered = [...activity].sort((left, right) => left.seq - right.seq);
  const rounds: TaskReviewRound[] = [];
  const byId = new Map<string, TaskReviewRound>();

  for (const entry of ordered) {
    if (entry.kind === "review_completed") {
      const detail = completedReviewDetailSchema.safeParse(parseDetail(entry));
      if (!detail.success) continue;
      const round: TaskReviewRound = {
        reviewId: entry.id,
        ...detail.data,
        createdAt: entry.createdAt,
        addressedAt: null,
        implementationSummary: null,
      };
      rounds.push(round);
      byId.set(round.reviewId, round);
      continue;
    }
    if (entry.kind !== "review_addressed") continue;
    const detail = addressedReviewDetailSchema.safeParse(parseDetail(entry));
    if (!detail.success) continue;
    const round = byId.get(detail.data.reviewId);
    if (!round || round.addressedAt) continue;
    round.addressedAt = entry.createdAt;
    round.implementationSummary = detail.data.implementationSummary;
  }

  return rounds;
}

export function getTaskReviewRoundsFromRecords(
  reviews: readonly TaskReviewRecord[],
): TaskReviewRound[] {
  return [...reviews]
    .sort(
      (left, right) => left.round - right.round || left.createdAt.localeCompare(right.createdAt),
    )
    .map((review) => ({
      reviewId: review.id,
      round: review.round,
      verdict: review.verdict,
      feedback: review.feedback,
      reviewerAgentId: review.reviewerAgentId,
      reviewerProvider: review.reviewerProvider,
      reviewerModel: review.reviewerModel,
      createdAt: review.createdAt,
      taskRevision: review.taskRevision,
      materialFingerprint: review.materialFingerprint,
      materialSnapshot: review.materialSnapshot,
      addressedAt: review.addressedAt,
      implementationSummary: review.implementationSummary,
    }));
}

export function getTaskReviewRoundsForContext(
  context: Pick<TaskContextSnapshot, "activity" | "reviews">,
): TaskReviewRound[] {
  return context.reviews
    ? getTaskReviewRoundsFromRecords(context.reviews)
    : getTaskReviewRounds(context.activity ?? []);
}

export function getPendingTaskReview(activity: readonly TaskActivity[]): TaskReviewRound | null {
  return (
    getTaskReviewRounds(activity).find(
      (round) => round.verdict !== "pass" && round.addressedAt === null,
    ) ?? null
  );
}

export function getPendingTaskReviewFromRecords(
  reviews: readonly TaskReviewRecord[],
): TaskReviewRound | null {
  return (
    getTaskReviewRoundsFromRecords(reviews).find(
      (round) => round.verdict !== "pass" && round.addressedAt === null,
    ) ?? null
  );
}

export function getPendingTaskReviewForContext(
  context: Pick<TaskContextSnapshot, "activity" | "reviews">,
): TaskReviewRound | null {
  return (
    getTaskReviewRoundsForContext(context).find(
      (round) => round.verdict !== "pass" && round.addressedAt === null,
    ) ?? null
  );
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableNormalize(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    normalized[key] = stableNormalize(record[key]);
  }
  return normalized;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function sortByStableValue<T>(items: readonly T[], projector: (item: T) => unknown): T[] {
  return [...items].sort((left, right) =>
    stableStringify(projector(left)).localeCompare(stableStringify(projector(right))),
  );
}

export function buildTaskReviewMaterialSnapshot(input: {
  task: TaskRecord;
  artifactDetails: readonly TaskArtifactDetail[];
  artifactFiles: readonly TaskReviewArtifactFileSnapshot[];
}): TaskReviewMaterialSnapshot {
  const artifactDetailsById = new Map(
    input.artifactDetails.map((detail) => [detail.artifact.id, detail]),
  );
  const artifactFilesById = new Map(input.artifactFiles.map((file) => [file.artifactId, file]));
  const activeRequirements = input.task.requirements.filter((item) => item.status === "active");
  const relevantDecisions = input.task.decisions.filter((item) => item.status === "active");
  const relevantQuestions = input.task.questions.filter((item) => item.status !== "superseded");
  const relevantBlockers = input.task.blockers.filter((item) => item.status === "active");

  return {
    schemaVersion: 1,
    objective: input.task.objective,
    context: input.task.context ?? "",
    requirements: sortByStableValue(activeRequirements, (item) => [
      item.kind,
      item.text,
      item.permanence,
      item.source,
    ]).map((item) => ({
      kind: item.kind,
      text: item.text,
      source: item.source,
      permanence: item.permanence,
      status: item.status,
    })),
    workItems: sortByStableValue(input.task.workItems, (item) => [item.position, item.id]).map(
      (item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        status: item.status,
        dependsOn: [...item.dependsOn].sort(),
        assignedThreadId: item.assignedThreadId,
        expectedOutputs: [...item.expectedOutputs].sort(),
        completionEvidence: item.completionEvidence,
        position: item.position,
      }),
    ),
    decisions: sortByStableValue(relevantDecisions, (item) => [
      item.question,
      item.resolution,
      item.scope,
    ]).map((item) => ({
      question: item.question,
      resolution: item.resolution,
      source: item.source,
      scope: item.scope,
      confidence: item.confidence,
      status: item.status,
    })),
    questions: sortByStableValue(relevantQuestions, (item) => [
      item.status,
      item.blocking,
      item.question,
    ]).map((item) => ({
      threadId: item.threadId,
      workItemId: item.workItemId,
      header: item.header,
      question: item.question,
      context: item.context,
      blocking: item.blocking,
      urgency: item.urgency,
      defaultAction: item.defaultAction,
      options: sortByStableValue(item.options, (option) => option.id),
      recommendedOptionId: item.recommendedOptionId,
      status: item.status,
      answer: item.answer,
      answerOptionId: item.answerOptionId,
      resolutionSource: item.resolutionSource,
    })),
    blockers: sortByStableValue(relevantBlockers, (item) => [
      item.blocking,
      item.workItemId,
      item.description,
    ]).map((item) => ({
      workItemId: item.workItemId,
      description: item.description,
      blocking: item.blocking,
      status: item.status,
    })),
    artifacts: sortByStableValue(input.task.artifacts, (item) => [item.path, item.id]).map(
      (artifact) => {
        const detail = artifactDetailsById.get(artifact.id);
        return {
          id: artifact.id,
          workItemId: artifact.workItemId,
          threadId: artifact.threadId,
          path: artifact.path,
          kind: artifact.kind,
          title: artifact.title,
          provenance: artifact.provenance,
          liveFile: artifactFilesById.get(artifact.id) ?? null,
          latestVersionId: detail?.latestVersionId ?? null,
          acceptedVersionId: detail?.acceptedVersionId ?? null,
          versions:
            detail?.versions.map((version) => ({
              id: version.id,
              version: version.version,
              parentVersionId: version.parentVersionId,
              sha256: version.sha256,
              sizeBytes: version.sizeBytes,
              mediaType: version.mediaType,
              reviewStatus: version.reviewStatus,
            })) ?? [],
          activeRevision: detail?.activeRevision
            ? {
                id: detail.activeRevision.id,
                workItemId: detail.activeRevision.workItemId,
                taskThreadId: detail.activeRevision.taskThreadId,
                baseVersionId: detail.activeRevision.baseVersionId,
                priorVersionId: detail.activeRevision.priorVersionId,
                status: detail.activeRevision.status,
                instruction: detail.activeRevision.instruction,
              }
            : null,
        };
      },
    ),
  };
}

export function fingerprintTaskReviewMaterial(snapshot: TaskReviewMaterialSnapshot): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}
