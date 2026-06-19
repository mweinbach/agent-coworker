import { z } from "zod";

import {
  REQUIREMENT_KINDS,
  TASK_STATUSES,
  taskActivitySchema,
  taskArtifactDetailSchema,
  taskArtifactRevisionSchema,
  taskCheckpointSchema,
  taskCreationInputSchema,
  taskRecordSchema,
  taskSummarySchema,
  WORK_ITEM_STATUSES,
} from "../../shared/tasks";
import { artifactDiffSchema, artifactPreviewSchema } from "../artifacts/types";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadSchema } from "./schema.threadTurn";

const cwdSchema = nonEmptyTrimmedStringSchema.optional();
const taskIdentitySchema = {
  cwd: cwdSchema,
  taskId: nonEmptyTrimmedStringSchema,
};
const expectedRevisionSchema = z.number().int().nonnegative();

const requirementInputSchema = z
  .object({
    kind: z.enum(REQUIREMENT_KINDS),
    text: nonEmptyTrimmedStringSchema,
    permanence: z.enum(["fixed", "temporary"]).optional(),
    source: z.enum(["user", "agent", "policy"]).optional(),
  })
  .strict();

const workItemInputSchema = z
  .object({
    id: nonEmptyTrimmedStringSchema.optional(),
    title: nonEmptyTrimmedStringSchema,
    description: z.string().optional(),
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    dependsOn: z.array(nonEmptyTrimmedStringSchema).optional(),
    expectedOutputs: z.array(nonEmptyTrimmedStringSchema).optional(),
  })
  .strict();

export const jsonRpcTaskRequestSchemas = {
  "task/create": taskCreationInputSchema.safeExtend({
    cwd: cwdSchema,
    provider: nonEmptyTrimmedStringSchema.optional(),
    model: nonEmptyTrimmedStringSchema.optional(),
  }),
  "task/list": z.object({ cwd: cwdSchema }).strict(),
  "task/read": z.object(taskIdentitySchema).strict(),
  "task/updateBrief": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      title: nonEmptyTrimmedStringSchema.optional(),
      objective: nonEmptyTrimmedStringSchema.optional(),
      requirements: z.array(requirementInputSchema).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.title !== undefined ||
        value.objective !== undefined ||
        value.requirements !== undefined,
      "At least one brief field is required",
    ),
  "task/updateGraph": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      workItems: z.array(workItemInputSchema),
    })
    .strict(),
  "task/workItem/claim": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      workItemId: nonEmptyTrimmedStringSchema,
      taskThreadId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "task/workItem/mark": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      workItemId: nonEmptyTrimmedStringSchema,
      status: z.enum(WORK_ITEM_STATUSES),
      completionEvidence: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/decision/record": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      question: nonEmptyTrimmedStringSchema,
      resolution: nonEmptyTrimmedStringSchema,
      source: z.enum(["user", "agent", "policy"]).default("user"),
      scope: z.enum(["task", "project"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      supersedes: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/questions/resolve": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      answers: z
        .array(
          z
            .object({
              questionId: nonEmptyTrimmedStringSchema,
              optionId: nonEmptyTrimmedStringSchema.optional(),
              text: nonEmptyTrimmedStringSchema.optional(),
            })
            .strict()
            .refine(
              (answer) => Boolean(answer.optionId) !== Boolean(answer.text),
              "Provide exactly one of optionId or text",
            ),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  "task/blocker/report": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      description: nonEmptyTrimmedStringSchema,
      blocking: z.boolean(),
      workItemId: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/blocker/resolve": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      blockerId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "task/artifact/register": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      path: nonEmptyTrimmedStringSchema,
      title: nonEmptyTrimmedStringSchema,
      kind: nonEmptyTrimmedStringSchema,
      artifactId: nonEmptyTrimmedStringSchema.optional(),
      baseVersionId: nonEmptyTrimmedStringSchema.optional(),
      changeSummary: nonEmptyTrimmedStringSchema.optional(),
      workItemId: nonEmptyTrimmedStringSchema.optional(),
      provenance: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  "task/artifact/read": z
    .object(taskIdentitySchema)
    .extend({
      artifactId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "task/artifact/version/capture": z
    .object({
      ...taskIdentitySchema,
      artifactId: nonEmptyTrimmedStringSchema,
      expectedRevision: expectedRevisionSchema,
      changeSummary: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/artifact/version/compare": z
    .object({
      ...taskIdentitySchema,
      artifactId: nonEmptyTrimmedStringSchema,
      baseVersionId: nonEmptyTrimmedStringSchema,
      targetVersionId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "task/artifact/version/preview": z
    .object({
      ...taskIdentitySchema,
      artifactId: nonEmptyTrimmedStringSchema,
      versionId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "task/artifact/version/restore": z
    .object({
      ...taskIdentitySchema,
      artifactId: nonEmptyTrimmedStringSchema,
      versionId: nonEmptyTrimmedStringSchema,
      expectedRevision: expectedRevisionSchema,
      changeSummary: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/artifact/version/accept": z
    .object({
      ...taskIdentitySchema,
      artifactId: nonEmptyTrimmedStringSchema,
      versionId: nonEmptyTrimmedStringSchema.optional(),
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
  "task/artifact/revision/start": z
    .object({
      ...taskIdentitySchema,
      artifactId: nonEmptyTrimmedStringSchema,
      baseVersionId: nonEmptyTrimmedStringSchema,
      expectedRevision: expectedRevisionSchema,
      instruction: nonEmptyTrimmedStringSchema,
      title: nonEmptyTrimmedStringSchema.optional(),
      provider: nonEmptyTrimmedStringSchema.optional(),
      model: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/thread/create": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      title: nonEmptyTrimmedStringSchema,
      workItemId: nonEmptyTrimmedStringSchema.optional(),
      provider: nonEmptyTrimmedStringSchema.optional(),
      model: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/proposeCompletion": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      summary: nonEmptyTrimmedStringSchema,
      caveats: z.array(nonEmptyTrimmedStringSchema).optional(),
    })
    .strict(),
  "task/cancel": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      reason: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "task/accept": z
    .object({ ...taskIdentitySchema, expectedRevision: expectedRevisionSchema })
    .strict(),
  "task/requestChanges": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      feedback: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "task/reopen": z
    .object({
      ...taskIdentitySchema,
      expectedRevision: expectedRevisionSchema,
      reason: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
} as const;

const taskResultSchema = z.object({ task: taskRecordSchema }).strict();

export const jsonRpcTaskResultSchemas = {
  "task/create": z.object({ task: taskRecordSchema, thread: jsonRpcThreadSchema }).strict(),
  "task/list": z
    .object({ tasks: z.array(taskSummarySchema), total: z.number().int().nonnegative() })
    .strict(),
  "task/read": z.object({ task: taskRecordSchema.nullable() }).strict(),
  "task/updateBrief": taskResultSchema,
  "task/updateGraph": taskResultSchema,
  "task/workItem/claim": taskResultSchema,
  "task/workItem/mark": taskResultSchema,
  "task/decision/record": taskResultSchema,
  "task/questions/resolve": z
    .object({
      task: taskRecordSchema,
      resumeStatus: z.enum(["queued", "steered", "not_needed", "failed"]),
    })
    .strict(),
  "task/blocker/report": taskResultSchema,
  "task/blocker/resolve": taskResultSchema,
  "task/artifact/register": taskResultSchema,
  "task/artifact/read": z.object({ detail: taskArtifactDetailSchema }).strict(),
  "task/artifact/version/capture": z
    .object({ task: taskRecordSchema, detail: taskArtifactDetailSchema })
    .strict(),
  "task/artifact/version/compare": z.object({ comparison: artifactDiffSchema }).strict(),
  "task/artifact/version/preview": z
    .object({ versionId: nonEmptyTrimmedStringSchema, preview: artifactPreviewSchema })
    .strict(),
  "task/artifact/version/restore": z
    .object({ task: taskRecordSchema, detail: taskArtifactDetailSchema })
    .strict(),
  "task/artifact/version/accept": z
    .object({ task: taskRecordSchema, detail: taskArtifactDetailSchema })
    .strict(),
  "task/artifact/revision/start": z
    .object({
      task: taskRecordSchema,
      detail: taskArtifactDetailSchema,
      revision: taskArtifactRevisionSchema,
      thread: jsonRpcThreadSchema,
    })
    .strict(),
  "task/thread/create": z.object({ task: taskRecordSchema, thread: jsonRpcThreadSchema }).strict(),
  "task/proposeCompletion": taskResultSchema,
  "task/cancel": taskResultSchema,
  "task/accept": taskResultSchema,
  "task/requestChanges": taskResultSchema,
  "task/reopen": taskResultSchema,
} as const;

export const jsonRpcTaskNotificationSchemas = {
  "task/created": z
    .object({
      cwd: nonEmptyTrimmedStringSchema,
      task: taskRecordSchema,
      sourceSessionId: nonEmptyTrimmedStringSchema.nullable(),
      takeover: z.boolean(),
      workspaceDisposition: z.enum(["existing_project", "promote_one_off"]),
    })
    .strict(),
  "task/updated": z.object({ cwd: nonEmptyTrimmedStringSchema, task: taskRecordSchema }).strict(),
  "task/activity": z
    .object({
      cwd: nonEmptyTrimmedStringSchema,
      taskId: nonEmptyTrimmedStringSchema,
      activity: taskActivitySchema,
    })
    .strict(),
  "task/checkpointCreated": z
    .object({
      cwd: nonEmptyTrimmedStringSchema,
      taskId: nonEmptyTrimmedStringSchema,
      checkpoint: taskCheckpointSchema,
    })
    .strict(),
} as const;

export const __taskSchemaInternals = {
  taskStatusSchema: z.enum(TASK_STATUSES),
};
