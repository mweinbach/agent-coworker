import { z } from "zod";

import {
  TASK_REVIEW_VERDICTS,
  type TaskActivity,
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
  addressedAt: string | null;
  implementationSummary: string | null;
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

export function getPendingTaskReview(activity: readonly TaskActivity[]): TaskReviewRound | null {
  return (
    getTaskReviewRounds(activity).find(
      (round) => round.verdict !== "pass" && round.addressedAt === null,
    ) ?? null
  );
}
