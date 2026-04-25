import { z } from "zod";
import {
  configUpdatedEventSchema,
  sessionConfigEventSchema,
  sessionDefaultsApplyRequestSchema,
  sessionDefaultsApplyResultSchema,
  sessionSettingsEventSchema,
  sessionStateReadRequestSchema,
  sessionStateReadResultSchema,
} from "./schema.sessionRuntime";
import {
  anyObjectSchema,
  sessionEventEnvelope,
  nonEmptyTrimmedStringSchema,
  optionalNonEmptyTrimmedStringSchema,
} from "./schema.shared";

export const sessionInfoEventSchema = z
  .object({
    type: z.literal("session_info"),
    title: z.string(),
  })
  .passthrough();

export const sessionUsageEventSchema = z
  .object({
    type: z.literal("session_usage"),
  })
  .passthrough();

export const steerAcceptedEventSchema = z
  .object({
    type: z.literal("steer_accepted"),
    turnId: nonEmptyTrimmedStringSchema,
    text: z.string(),
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
  })
  .passthrough();

export const turnUsageEventSchema = z
  .object({
    type: z.literal("turn_usage"),
    turnId: nonEmptyTrimmedStringSchema,
  })
  .passthrough();

export const budgetWarningEventSchema = z
  .object({
    type: z.literal("budget_warning"),
    message: z.string(),
  })
  .passthrough();

export const budgetExceededEventSchema = z
  .object({
    type: z.literal("budget_exceeded"),
    message: z.string(),
  })
  .passthrough();

export const sessionBackupStateEventSchema = z
  .object({
    type: z.literal("session_backup_state"),
  })
  .passthrough();

export const harnessContextEventSchema = z
  .object({
    type: z.literal("harness_context"),
  })
  .passthrough();

/** Matches `HarnessContextPayload` — validated before `normalizeHarnessContextPayload`. */
export const harnessContextPayloadSchema = z
  .object({
    runId: nonEmptyTrimmedStringSchema,
    taskId: optionalNonEmptyTrimmedStringSchema,
    objective: nonEmptyTrimmedStringSchema,
    acceptanceCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const sessionDeletedEventSchema = z
  .object({
    type: z.literal("session_deleted"),
  })
  .passthrough();

export const fileUploadedEventSchema = z
  .object({
    type: z.literal("file_uploaded"),
    filename: nonEmptyTrimmedStringSchema,
    path: nonEmptyTrimmedStringSchema,
  })
  .passthrough();

export const jsonRpcSessionRequestSchemas = {
  "cowork/session/title/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      title: z.string(),
    })
    .strict(),
  "cowork/session/state/read": sessionStateReadRequestSchema,
  "cowork/session/model/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      provider: optionalNonEmptyTrimmedStringSchema,
      model: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/session/usageBudget/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      warnAtUsd: z.number().nullable().optional(),
      stopAtUsd: z.number().nullable().optional(),
    })
    .strict(),
  "cowork/session/config/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      config: anyObjectSchema,
    })
    .strict(),
  "cowork/session/harnessContext/get": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/session/harnessContext/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      context: harnessContextPayloadSchema,
    })
    .strict(),
  "cowork/session/defaults/apply": sessionDefaultsApplyRequestSchema,
  "cowork/session/file/upload": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      filename: nonEmptyTrimmedStringSchema,
      contentBase64: z.string().min(1),
    })
    .strict(),
  "cowork/session/delete": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      targetSessionId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
} as const;

export const jsonRpcSessionNotificationSchemas = {
  "cowork/session/settings": sessionSettingsEventSchema,
  "cowork/session/info": sessionInfoEventSchema,
  "cowork/session/configUpdated": configUpdatedEventSchema,
  "cowork/session/config": sessionConfigEventSchema,
  "cowork/session/usage": sessionUsageEventSchema,
  "cowork/session/steerAccepted": steerAcceptedEventSchema,
  "cowork/session/turnUsage": turnUsageEventSchema,
  "cowork/session/budgetWarning": budgetWarningEventSchema,
  "cowork/session/budgetExceeded": budgetExceededEventSchema,
  "cowork/session/backupState": sessionBackupStateEventSchema,
  "cowork/session/harnessContext": harnessContextEventSchema,
} as const;

export const jsonRpcSessionResultSchemas = {
  "cowork/session/title/set": sessionEventEnvelope(sessionInfoEventSchema),
  "cowork/session/state/read": sessionStateReadResultSchema,
  "cowork/session/model/set": sessionEventEnvelope(configUpdatedEventSchema),
  "cowork/session/usageBudget/set": sessionEventEnvelope(sessionUsageEventSchema),
  "cowork/session/config/set": sessionEventEnvelope(sessionConfigEventSchema),
  "cowork/session/harnessContext/get": sessionEventEnvelope(harnessContextEventSchema),
  "cowork/session/harnessContext/set": sessionEventEnvelope(harnessContextEventSchema),
  "cowork/session/defaults/apply": sessionDefaultsApplyResultSchema,
  "cowork/session/file/upload": sessionEventEnvelope(fileUploadedEventSchema),
  "cowork/session/delete": sessionEventEnvelope(sessionDeletedEventSchema),
} as const;
