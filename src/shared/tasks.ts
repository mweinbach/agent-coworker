import { z } from "zod";

export const TASK_STATUSES = [
  "draft",
  "planning",
  "working",
  "blocked",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
] as const;

export const WORK_ITEM_STATUSES = [
  "queued",
  "in_progress",
  "blocked",
  "review",
  "done",
  "abandoned",
] as const;

export const REQUIREMENT_KINDS = ["requirement", "constraint", "acceptance_criterion"] as const;

export const TASK_CREATION_ORIGINS = ["manual", "chat_tool"] as const;

export const TASK_REVIEW_VERDICTS = ["pass", "partial", "fail"] as const;
export const DEFAULT_TASK_REVIEW_ROUNDS = 3;
export const MAX_TASK_REVIEW_ROUNDS = 10;

export const TASK_QUESTION_URGENCIES = ["now", "before_delivery", "optional"] as const;

export const TASK_QUESTION_STATUSES = [
  "pending",
  "answered",
  "defaulted",
  "superseded",
  "dismissed",
] as const;

export const TASK_ACTIVITY_KINDS = [
  "task_created",
  "brief_updated",
  "plan_updated",
  "work_item_updated",
  "decision_recorded",
  "progress_reported",
  "blocker_reported",
  "blocker_resolved",
  "input_requested",
  "input_resolved",
  "input_defaulted",
  "input_resume_failed",
  "artifact_registered",
  "artifact_version_captured",
  "artifact_version_restored",
  "artifact_version_accepted",
  "artifact_revision_started",
  "artifact_revision_completed",
  "artifact_revision_failed",
  "review_completed",
  "review_addressed",
  "thread_created",
  "status_changed",
  "checkpoint_created",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type TaskRequirementKind = (typeof REQUIREMENT_KINDS)[number];
export type TaskCreationOrigin = (typeof TASK_CREATION_ORIGINS)[number];
export type TaskReviewVerdict = (typeof TASK_REVIEW_VERDICTS)[number];
export type TaskActivityKind = (typeof TASK_ACTIVITY_KINDS)[number];
export type TaskQuestionUrgency = (typeof TASK_QUESTION_URGENCIES)[number];
export type TaskQuestionStatus = (typeof TASK_QUESTION_STATUSES)[number];

export const TASK_ARTIFACT_VERSION_REVIEW_STATUSES = ["draft", "accepted", "superseded"] as const;

export const TASK_ARTIFACT_REVISION_STATUSES = [
  "active",
  "completed",
  "cancelled",
  "error",
] as const;

export type TaskArtifactVersionReviewStatus =
  (typeof TASK_ARTIFACT_VERSION_REVIEW_STATUSES)[number];
export type TaskArtifactRevisionStatus = (typeof TASK_ARTIFACT_REVISION_STATUSES)[number];

const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const taskCreationRequirementInputSchema = z
  .object({
    kind: z.enum(REQUIREMENT_KINDS),
    text: nonEmptyStringSchema,
    permanence: z.enum(["fixed", "temporary"]).default("fixed"),
  })
  .strict();

export const taskCreationWorkItemInputSchema = z
  .object({
    key: nonEmptyStringSchema.max(80),
    title: nonEmptyStringSchema.max(200),
    description: z.string().trim().default(""),
    dependsOn: z.array(nonEmptyStringSchema.max(80)).default([]),
    expectedOutputs: z.array(nonEmptyStringSchema).default([]),
  })
  .strict();

export const taskCreationDecisionInputSchema = z
  .object({
    question: nonEmptyStringSchema,
    resolution: nonEmptyStringSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const taskCreationInputSchema = z
  .object({
    idempotencyKey: nonEmptyStringSchema.max(200),
    title: nonEmptyStringSchema.max(160),
    objective: nonEmptyStringSchema,
    context: nonEmptyStringSchema,
    requirements: z.array(taskCreationRequirementInputSchema).min(1),
    workItems: z.array(taskCreationWorkItemInputSchema).min(1),
    decisions: z.array(taskCreationDecisionInputSchema).default([]),
    reviewRequired: z.boolean().default(true),
    reviewRounds: z
      .number()
      .int()
      .min(0)
      .max(MAX_TASK_REVIEW_ROUNDS)
      .default(DEFAULT_TASK_REVIEW_ROUNDS),
  })
  .strict()
  .superRefine((input, refinement) => {
    if (!input.requirements.some((item) => item.kind === "acceptance_criterion")) {
      refinement.addIssue({
        code: "custom",
        path: ["requirements"],
        message: "At least one acceptance criterion is required",
      });
    }
    if (!input.workItems.some((item) => item.expectedOutputs.length > 0)) {
      refinement.addIssue({
        code: "custom",
        path: ["workItems"],
        message: "At least one expected output is required",
      });
    }

    const keys = new Set<string>();
    for (const [index, item] of input.workItems.entries()) {
      if (keys.has(item.key)) {
        refinement.addIssue({
          code: "custom",
          path: ["workItems", index, "key"],
          message: `Duplicate work item key: ${item.key}`,
        });
      }
      keys.add(item.key);
    }

    const dependencyMap = new Map(input.workItems.map((item) => [item.key, item.dependsOn]));
    for (const [index, item] of input.workItems.entries()) {
      for (const dependency of item.dependsOn) {
        if (dependency === item.key) {
          refinement.addIssue({
            code: "custom",
            path: ["workItems", index, "dependsOn"],
            message: `Work item ${item.key} cannot depend on itself`,
          });
        } else if (!dependencyMap.has(dependency)) {
          refinement.addIssue({
            code: "custom",
            path: ["workItems", index, "dependsOn"],
            message: `Unknown work item dependency: ${dependency}`,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      for (const dependency of dependencyMap.get(key) ?? []) {
        if (dependencyMap.has(dependency) && visit(dependency)) return true;
      }
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    for (const key of dependencyMap.keys()) {
      if (visit(key)) {
        refinement.addIssue({
          code: "custom",
          path: ["workItems"],
          message: "Work item dependencies contain a cycle",
        });
        break;
      }
    }
  });

const taskCreationToolRequirementInputSchema = taskCreationRequirementInputSchema.extend({
  permanence: z.enum(["fixed", "temporary"]).nullable().optional(),
});

const taskCreationToolWorkItemInputSchema = taskCreationWorkItemInputSchema.extend({
  description: z.string().trim().nullable().optional(),
  dependsOn: z.array(nonEmptyStringSchema.max(80)).nullable().optional(),
  expectedOutputs: z.array(nonEmptyStringSchema).nullable().optional(),
});

const taskCreationToolDecisionInputSchema = taskCreationDecisionInputSchema.extend({
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const taskCreationToolInputSchema = z
  .object({
    idempotencyKey: nonEmptyStringSchema.max(200),
    title: nonEmptyStringSchema.max(160),
    objective: nonEmptyStringSchema,
    context: nonEmptyStringSchema,
    requirements: z.array(taskCreationToolRequirementInputSchema).min(1),
    workItems: z.array(taskCreationToolWorkItemInputSchema).min(1),
    decisions: z.array(taskCreationToolDecisionInputSchema).nullable().optional(),
    reviewRequired: z.boolean().nullable().optional(),
    reviewRounds: z.number().int().min(0).max(MAX_TASK_REVIEW_ROUNDS).nullable().optional(),
  })
  .strict();

export function parseTaskCreationToolInput(
  input: z.input<typeof taskCreationToolInputSchema>,
): z.output<typeof taskCreationInputSchema> {
  return taskCreationInputSchema.parse({
    ...input,
    requirements: input.requirements.map((requirement) => ({
      ...requirement,
      permanence: requirement.permanence ?? undefined,
    })),
    workItems: input.workItems.map((workItem) => ({
      ...workItem,
      description: workItem.description ?? undefined,
      dependsOn: workItem.dependsOn ?? undefined,
      expectedOutputs: workItem.expectedOutputs ?? undefined,
    })),
    decisions: (input.decisions ?? []).map((decision) => ({
      ...decision,
      confidence: decision.confidence ?? undefined,
    })),
    reviewRequired: input.reviewRequired ?? undefined,
    reviewRounds: input.reviewRounds ?? undefined,
  });
}

export const taskRequirementSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(REQUIREMENT_KINDS),
    text: nonEmptyStringSchema,
    source: z.enum(["user", "agent", "policy"]),
    permanence: z.enum(["fixed", "temporary"]),
    status: z.enum(["active", "superseded"]),
    createdAt: isoTimestampSchema,
    supersedes: nonEmptyStringSchema.nullable(),
  })
  .strict();

export const taskThreadSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    createdBy: z.enum(["user", "coordinator"]),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const workItemSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    description: z.string(),
    status: z.enum(WORK_ITEM_STATUSES),
    dependsOn: z.array(nonEmptyStringSchema),
    assignedThreadId: nonEmptyStringSchema.nullable(),
    claimedByThreadId: nonEmptyStringSchema.nullable(),
    expectedOutputs: z.array(nonEmptyStringSchema),
    completionEvidence: z.string().nullable(),
    position: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const taskDecisionSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    question: nonEmptyStringSchema,
    resolution: nonEmptyStringSchema,
    source: z.enum(["user", "agent", "policy"]),
    scope: z.enum(["task", "project"]),
    confidence: z.number().min(0).max(1).nullable(),
    status: z.enum(["active", "superseded"]),
    createdAt: isoTimestampSchema,
    supersedes: nonEmptyStringSchema.nullable(),
  })
  .strict();

export const taskQuestionOptionSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    description: z.string(),
  })
  .strict();

export const taskQuestionSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema.nullable(),
    workItemId: nonEmptyStringSchema.nullable(),
    header: nonEmptyStringSchema,
    question: nonEmptyStringSchema,
    context: z.string(),
    blocking: z.boolean(),
    urgency: z.enum(TASK_QUESTION_URGENCIES),
    defaultAction: nonEmptyStringSchema.nullable(),
    options: z.array(taskQuestionOptionSchema),
    recommendedOptionId: nonEmptyStringSchema.nullable(),
    status: z.enum(TASK_QUESTION_STATUSES),
    provisionalDecisionId: nonEmptyStringSchema.nullable(),
    answer: nonEmptyStringSchema.nullable(),
    answerOptionId: nonEmptyStringSchema.nullable(),
    resolutionSource: z.enum(["user", "default"]).nullable(),
    supersedes: nonEmptyStringSchema.nullable(),
    createdAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const taskArtifactSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    workItemId: nonEmptyStringSchema.nullable(),
    threadId: nonEmptyStringSchema.nullable(),
    path: nonEmptyStringSchema,
    kind: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    createdBy: nonEmptyStringSchema,
    provenance: z.record(z.string(), z.unknown()),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const taskArtifactVersionSchema = z
  .object({
    id: nonEmptyStringSchema,
    artifactId: nonEmptyStringSchema,
    version: z.number().int().positive(),
    parentVersionId: nonEmptyStringSchema.nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: nonEmptyStringSchema,
    createdBy: nonEmptyStringSchema,
    createdAt: isoTimestampSchema,
    changeSummary: z.string(),
    provenance: z.record(z.string(), z.unknown()),
    reviewStatus: z.enum(TASK_ARTIFACT_VERSION_REVIEW_STATUSES),
  })
  .strict();

export const taskArtifactRevisionSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    artifactId: nonEmptyStringSchema,
    workItemId: nonEmptyStringSchema,
    taskThreadId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    baseVersionId: nonEmptyStringSchema,
    priorVersionId: nonEmptyStringSchema,
    status: z.enum(TASK_ARTIFACT_REVISION_STATUSES),
    instruction: nonEmptyStringSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const taskArtifactDetailSchema = z
  .object({
    artifact: taskArtifactSchema,
    versions: z.array(taskArtifactVersionSchema),
    latestVersionId: nonEmptyStringSchema.nullable(),
    acceptedVersionId: nonEmptyStringSchema.nullable(),
    activeRevision: taskArtifactRevisionSchema.nullable(),
  })
  .strict();

export const taskBlockerSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    workItemId: nonEmptyStringSchema.nullable(),
    description: nonEmptyStringSchema,
    blocking: z.boolean(),
    status: z.enum(["active", "resolved"]),
    createdAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const taskActivitySchema = z
  .object({
    id: nonEmptyStringSchema,
    seq: z.number().int().positive(),
    taskId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema.nullable(),
    workItemId: nonEmptyStringSchema.nullable(),
    kind: z.enum(TASK_ACTIVITY_KINDS),
    summary: nonEmptyStringSchema,
    detail: z.string().nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const taskCheckpointSchema = z
  .object({
    id: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema.nullable(),
    taskRevision: z.number().int().nonnegative(),
    reason: nonEmptyStringSchema,
    agentSummary: z.string(),
    contextDigest: z.string(),
    taskSnapshot: z.record(z.string(), z.unknown()),
    artifactManifest: z.array(
      z
        .object({
          id: nonEmptyStringSchema,
          path: nonEmptyStringSchema,
          title: nonEmptyStringSchema,
          kind: nonEmptyStringSchema,
        })
        .strict(),
    ),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const taskSummarySchema = z
  .object({
    id: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    objective: nonEmptyStringSchema,
    context: z.string().optional(),
    sourceSessionId: nonEmptyStringSchema.nullable().optional(),
    creationOrigin: z.enum(TASK_CREATION_ORIGINS).optional(),
    status: z.enum(TASK_STATUSES),
    revision: z.number().int().nonnegative(),
    reviewRequired: z.boolean(),
    reviewRounds: z.number().int().min(0).max(MAX_TASK_REVIEW_ROUNDS).optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    threadCount: z.number().int().nonnegative(),
    completedWorkItemCount: z.number().int().nonnegative(),
    totalWorkItemCount: z.number().int().nonnegative(),
    activeBlockerCount: z.number().int().nonnegative(),
    pendingQuestionCount: z.number().int().nonnegative(),
    blockingQuestionCount: z.number().int().nonnegative(),
  })
  .strict();

export const taskRecordSchema = taskSummarySchema
  .extend({
    requirements: z.array(taskRequirementSchema),
    threads: z.array(taskThreadSchema),
    workItems: z.array(workItemSchema),
    decisions: z.array(taskDecisionSchema),
    questions: z.array(taskQuestionSchema),
    artifacts: z.array(taskArtifactSchema),
    blockers: z.array(taskBlockerSchema),
    activity: z.array(taskActivitySchema),
    latestCheckpoint: taskCheckpointSchema.nullable(),
  })
  .strict();

export type TaskRequirement = z.infer<typeof taskRequirementSchema>;
export type TaskThread = z.infer<typeof taskThreadSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type TaskDecision = z.infer<typeof taskDecisionSchema>;
export type TaskQuestionOption = z.infer<typeof taskQuestionOptionSchema>;
export type TaskQuestion = z.infer<typeof taskQuestionSchema>;
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;
export type TaskArtifactVersion = z.infer<typeof taskArtifactVersionSchema>;
export type TaskArtifactRevision = z.infer<typeof taskArtifactRevisionSchema>;
export type TaskArtifactDetail = z.infer<typeof taskArtifactDetailSchema>;
export type TaskBlocker = z.infer<typeof taskBlockerSchema>;
export type TaskActivity = z.infer<typeof taskActivitySchema>;
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export type TaskContextSnapshot = Pick<
  TaskRecord,
  | "id"
  | "title"
  | "objective"
  | "context"
  | "sourceSessionId"
  | "status"
  | "revision"
  | "requirements"
  | "workItems"
  | "decisions"
  | "questions"
  | "blockers"
  | "artifacts"
> & {
  activeThreadId: string;
  reviewRequired?: boolean;
  reviewRounds?: number;
  activity?: TaskActivity[];
};

export type TaskDirective =
  | {
      type: "update_plan";
      idempotencyKey: string;
      expectedRevision: number;
      objective?: string;
      requirements?: Array<{
        kind: TaskRequirementKind;
        text: string;
        permanence?: "fixed" | "temporary";
      }>;
      workItems: Array<{
        id?: string;
        title: string;
        description?: string;
        dependsOn?: string[];
        expectedOutputs?: string[];
      }>;
    }
  | {
      type: "mark_work_item";
      idempotencyKey: string;
      expectedRevision: number;
      workItemId: string;
      status: WorkItemStatus;
      completionEvidence?: string;
    }
  | {
      type: "record_decision";
      idempotencyKey: string;
      expectedRevision: number;
      question: string;
      resolution: string;
      confidence?: number;
      scope?: "task" | "project";
      supersedes?: string;
    }
  | {
      type: "report_progress";
      idempotencyKey: string;
      summary: string;
      detail?: string;
      workItemId?: string;
    }
  | {
      type: "report_blocker";
      idempotencyKey: string;
      expectedRevision: number;
      description: string;
      blocking: boolean;
      workItemId?: string;
    }
  | {
      type: "request_input";
      idempotencyKey: string;
      expectedRevision: number;
      questions: Array<{
        header: string;
        question: string;
        context?: string;
        blocking: boolean;
        urgency: TaskQuestionUrgency;
        defaultAction?: string;
        options?: Array<{
          id: string;
          label: string;
          description?: string;
        }>;
        recommendedOptionId?: string;
        workItemId?: string;
        supersedes?: string;
      }>;
    }
  | {
      type: "register_artifact";
      idempotencyKey: string;
      expectedRevision: number;
      path: string;
      title: string;
      kind: string;
      artifactId?: string;
      baseVersionId?: string;
      changeSummary?: string;
      workItemId?: string;
      provenance?: Record<string, unknown>;
    }
  | {
      type: "record_review";
      idempotencyKey: string;
      expectedRevision: number;
      reviewerAgentId: string;
      reviewerProvider: string;
      reviewerModel: string;
      verdict: TaskReviewVerdict;
      feedback: string;
    }
  | {
      type: "address_review";
      idempotencyKey: string;
      expectedRevision: number;
      reviewId: string;
      implementationSummary: string;
    }
  | {
      type: "propose_completion";
      idempotencyKey: string;
      expectedRevision: number;
      summary: string;
      caveats?: string[];
    }
  | {
      type: "create_thread";
      idempotencyKey: string;
      expectedRevision: number;
      title: string;
      workItemId: string;
    };

export type TaskDirectiveResult = {
  task: TaskRecord;
  continuation: "continue" | "pause_for_input";
};

export type TaskQuestionAnswerInput = {
  questionId: string;
  optionId?: string;
  text?: string;
};

export type TaskQuestionResumeStatus = "queued" | "steered" | "not_needed" | "failed";

export type TaskCreationRequirementInput = z.input<typeof taskCreationRequirementInputSchema>;
export type TaskCreationWorkItemInput = z.input<typeof taskCreationWorkItemInputSchema>;
export type TaskCreationDecisionInput = z.input<typeof taskCreationDecisionInputSchema>;
export type TaskCreationInput = z.input<typeof taskCreationInputSchema>;

export type TaskCreationResult = {
  task: TaskRecord;
  workspaceDisposition: "existing_project" | "promote_one_off";
};
