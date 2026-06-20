import { z } from "zod";

import {
  getPendingTaskReviewForContext,
  getTaskReviewRoundsForContext,
} from "../server/tasks/taskReviewPolicy";
import {
  MAX_TASK_REVIEW_ROUNDS,
  type TaskContextSnapshot,
  type TaskReviewVerdict,
} from "../shared/tasks";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const taskReviewInputSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
  },
  z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      focus: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
    })
    .strict(),
);

function reviewBriefing(context: TaskContextSnapshot, focus?: string): string {
  const reviews = getTaskReviewRoundsForContext(context);
  return [
    `Task: ${context.title}`,
    `Objective: ${context.objective}`,
    context.context ? `Context: ${context.context}` : "",
    "Acceptance requirements:",
    ...context.requirements
      .filter((requirement) => requirement.status === "active")
      .map((requirement) => `- [${requirement.kind}] ${requirement.text}`),
    "Work evidence:",
    ...context.workItems.map(
      (item) =>
        `- [${item.status}] ${item.title}: ${item.completionEvidence ?? "no completion evidence"}`,
    ),
    "Registered artifacts (inspect these directly):",
    ...context.artifacts.map((artifact) => `- ${artifact.title}: ${artifact.path}`),
    reviews.length > 0 ? "Prior independent reviews and implementation responses:" : "",
    ...reviews.flatMap((review) => [
      `- Round ${review.round} ${review.verdict.toUpperCase()}: ${review.feedback}`,
      review.implementationSummary ? `  Implemented response: ${review.implementationSummary}` : "",
    ]),
    focus ? `Requested review focus: ${focus}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewPrompt(round: number, requiredRounds: number, focus?: string): string {
  return [
    `Perform independent quality review round ${round}. The task requires at least ${requiredRounds} round(s); rounds beyond that minimum are deliberate additional assurance.`,
    "Inspect the actual registered deliverables and relevant source material. Do not accept the primary agent's completion claims as evidence.",
    "Evaluate correctness, completeness, every acceptance criterion, edge and failure cases, data or formula integrity, and user-facing usability/polish where applicable.",
    "Actively look for shallow work: placeholders, unsupported assertions, missing scenarios, skipped validation, superficial formatting, and shortcuts that technically exist but do not satisfy the intent.",
    "Run concrete verification and at least one adversarial probe. If prior feedback has an implemented response, verify the implementation itself rather than trusting its summary.",
    "Stay read-only. Give prioritized, actionable findings with precise evidence and finish with VERDICT: PASS, VERDICT: PARTIAL, or VERDICT: FAIL.",
    focus ? `Pay particular attention to: ${focus}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseVerdict(feedback: string, reportStatus?: string): TaskReviewVerdict {
  const matches = [...feedback.matchAll(/VERDICT:\s*(PASS|PARTIAL|FAIL)\b/gi)];
  const explicit = matches.at(-1)?.[1]?.toLowerCase();
  if (explicit === "pass" || explicit === "partial" || explicit === "fail") return explicit;
  if (reportStatus === "completed") return "pass";
  if (reportStatus === "blocked") return "partial";
  if (reportStatus === "failed") return "fail";
  throw new Error("Reviewer did not provide a valid PASS, PARTIAL, or FAIL verdict");
}

const TASK_REVIEW_DESCRIPTION = `Run the next required independent task review round with a separate read-only reviewer agent.

Use this only after all work items and expected artifacts are complete and registered. The reviewer inspects actual deliverables, tests acceptance criteria, probes for shallow or incomplete work, and records a durable verdict. A FAIL or PARTIAL verdict must be implemented and verified, then acknowledged with taskUpdate address_review before another round. The configured review count is a minimum: after it is met, run additional rounds when material uncertainty, risky changes, or prior findings justify more assurance, up to the safety cap. Do not call propose_completion until every required round is recorded.`;

export function createTaskReviewTool(ctx: ToolContext) {
  if (!ctx.taskContext || !ctx.applyTaskDirective || !ctx.agentControl) return null;
  const initialTaskContext = ctx.taskContext;
  const applyTaskDirective = ctx.applyTaskDirective;
  const agentControl = ctx.agentControl;
  return defineTool({
    description: TASK_REVIEW_DESCRIPTION,
    inputSchema: taskReviewInputSchema,
    execute: async (rawInput: z.input<typeof taskReviewInputSchema>) => {
      const input = taskReviewInputSchema.parse(rawInput);
      const context = ctx.getTaskContext?.() ?? initialTaskContext;
      if (!context) throw new Error("Task context is unavailable");
      if (context.revision !== input.expectedRevision) {
        throw new Error(
          `Task revision conflict: expected ${input.expectedRevision}, current ${context.revision}`,
        );
      }
      const requiredRounds = context.reviewRounds ?? 0;
      if (requiredRounds === 0) throw new Error("This task does not require independent reviews");
      const priorRounds = getTaskReviewRoundsForContext(context);
      const pending = getPendingTaskReviewForContext(context);
      if (pending) {
        throw new Error(
          `Review round ${pending.round} feedback must be implemented and addressed first`,
        );
      }
      if (priorRounds.length >= MAX_TASK_REVIEW_ROUNDS) {
        throw new Error(`Task reached the ${MAX_TASK_REVIEW_ROUNDS}-round review safety cap`);
      }

      const round = priorRounds.length + 1;
      const requestedModel =
        input.model ?? ctx.config.preferredChildModelRef ?? ctx.config.preferredChildModel;
      const reviewedMaterial = await ctx.getTaskReviewMaterial?.();
      if (!reviewedMaterial) throw new Error("Task review material is unavailable");
      ctx.log(`tool> reviewTask ${JSON.stringify({ round, requiredRounds, requestedModel })}`);
      const reviewer = await agentControl.spawn({
        message: reviewPrompt(round, requiredRounds, input.focus),
        role: "reviewer",
        model: requestedModel,
        nickname: `task-review-${round}`,
        taskType: "verify",
        contextMode: "brief",
        briefing: reviewBriefing(context, input.focus),
      });

      try {
        const waited = await agentControl.wait({
          agentIds: [reviewer.agentId],
          timeoutMs: 600_000,
          mode: "all",
          includeFinalMessage: true,
          includeReport: true,
        });
        if (waited.timedOut) throw new Error(`Reviewer ${reviewer.agentId} timed out`);
        const inspection = waited.inspections?.find(
          (candidate) => candidate.agentId === reviewer.agentId,
        );
        const feedback = inspection?.latestAssistantText?.trim();
        if (!feedback) throw new Error(`Reviewer ${reviewer.agentId} returned no critique`);
        const verdict = parseVerdict(feedback, inspection?.parsedReport?.status);
        const result = await applyTaskDirective({
          type: "record_review",
          idempotencyKey: `review:${context.id}:${reviewer.agentId}`,
          expectedRevision: input.expectedRevision,
          expectedMaterialFingerprint: reviewedMaterial.fingerprint,
          reviewerAgentId: reviewer.agentId,
          reviewerProvider: reviewer.provider,
          reviewerModel: reviewer.effectiveModel,
          verdict,
          feedback,
        });
        const recorded = getTaskReviewRoundsForContext({
          activity: result.task.activity,
          reviews: result.task.reviews,
        }).at(-1);
        if (!recorded || recorded.reviewerAgentId !== reviewer.agentId) {
          throw new Error("Recorded review could not be read from the task review state");
        }
        ctx.log(
          `tool< reviewTask ${JSON.stringify({ round: recorded.round, verdict: recorded.verdict })}`,
        );
        return {
          reviewId: recorded.reviewId,
          round: recorded.round,
          verdict: recorded.verdict,
          feedback: recorded.feedback,
          requiresImplementation: recorded.verdict !== "pass",
          requiredRounds,
          taskRevision: result.task.revision,
        };
      } finally {
        try {
          await agentControl.close({ agentId: reviewer.agentId });
        } catch (error) {
          ctx.log(
            `tool! reviewTask reviewer cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  });
}

export const __internal = { parseVerdict, reviewBriefing, reviewPrompt };
