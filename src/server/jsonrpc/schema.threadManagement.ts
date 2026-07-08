import { z } from "zod";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadSchema } from "./schema.threadTurn";

const worktreeStartingStateSchema = z
  .object({
    ref: nonEmptyTrimmedStringSchema.optional(),
    branchName: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const threadEnvironmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }).strict(),
  z
    .object({
      type: z.literal("worktree"),
      ref: nonEmptyTrimmedStringSchema.optional(),
      branchName: nonEmptyTrimmedStringSchema.optional(),
      startingState: worktreeStartingStateSchema.optional(),
    })
    .strict(),
]);

const forkEnvironmentResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("local"),
      cwd: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("worktree"),
      cwd: nonEmptyTrimmedStringSchema,
      branchName: nonEmptyTrimmedStringSchema,
      baseRef: nonEmptyTrimmedStringSchema,
      baseCommit: nonEmptyTrimmedStringSchema,
    })
    .strict(),
]);

const forkThreadResultSchema = z
  .object({
    sourceThreadId: nonEmptyTrimmedStringSchema,
    thread: jsonRpcThreadSchema,
    forked: z.literal(true),
    queued: z.boolean(),
    environment: forkEnvironmentResultSchema,
  })
  .strict();

export const jsonRpcThreadManagementRequestSchemas = {
  "thread/fork": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      environment: threadEnvironmentSchema.optional(),
      title: nonEmptyTrimmedStringSchema.optional(),
      prompt: nonEmptyTrimmedStringSchema.optional(),
      model: nonEmptyTrimmedStringSchema.optional(),
      thinking: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "thread/pinned/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      pinned: z.boolean(),
    })
    .strict(),
  "thread/archived/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      archived: z.boolean(),
    })
    .strict(),
} as const;

export const jsonRpcThreadManagementResultSchemas = {
  "thread/fork": forkThreadResultSchema,
  "thread/pinned/set": z
    .object({
      thread: jsonRpcThreadSchema,
    })
    .strict(),
  "thread/archived/set": z
    .object({
      thread: jsonRpcThreadSchema,
    })
    .strict(),
} as const;
