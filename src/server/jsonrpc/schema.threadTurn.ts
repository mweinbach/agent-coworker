import { z } from "zod";

import { nonEmptyTrimmedStringSchema } from "./schema.shared";

export const jsonRpcThreadSchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  title: z.string(),
  preview: z.string(),
  modelProvider: z.string(),
  model: z.string(),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  status: z.object({
    type: z.string(),
  }).strict(),
}).strict();

export const jsonRpcThreadTurnRequestSchemas = {
  "thread/start": z.object({
    cwd: nonEmptyTrimmedStringSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
  }).strict(),
  "thread/resume": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    afterSeq: z.number().int().nonnegative().optional(),
  }).strict(),
  "thread/list": z.object({
    cwd: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
  "thread/read": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    includeTurns: z.boolean().optional(),
  }).strict(),
  "thread/unsubscribe": z.object({
    threadId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "turn/start": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
    input: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
  }).strict(),
  "turn/steer": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
    input: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
  }).strict(),
  "turn/interrupt": z.object({
    threadId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcThreadTurnNotificationSchemas = {
  "thread/started": z.object({
    thread: jsonRpcThreadSchema,
  }).strict(),
  "turn/started": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turn: z.object({
      id: nonEmptyTrimmedStringSchema,
      status: z.string(),
      items: z.array(z.unknown()),
    }).strict(),
  }).strict(),
  "item/started": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    item: z.record(z.string(), z.unknown()),
  }).strict(),
  "item/reasoning/delta": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    mode: z.enum(["reasoning", "summary"]),
    delta: z.string(),
  }).strict(),
  "item/agentMessage/delta": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    delta: z.string(),
  }).strict(),
  "item/completed": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    item: z.record(z.string(), z.unknown()),
  }).strict(),
  "turn/completed": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turn: z.object({
      id: nonEmptyTrimmedStringSchema,
      status: z.string(),
    }).strict(),
  }).strict(),
  "serverRequest/resolved": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    requestId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcThreadTurnServerRequestSchemas = {
  "item/tool/requestUserInput": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema.nullable().optional(),
    requestId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    question: z.string(),
    options: z.array(z.string()).optional(),
  }).strict(),
  "item/commandExecution/requestApproval": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema.nullable().optional(),
    requestId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    command: z.string(),
    dangerous: z.boolean(),
    reason: z.string(),
  }).strict(),
} as const;

export const jsonRpcThreadTurnResultSchemas = {
  "thread/start": z.object({
    thread: jsonRpcThreadSchema,
  }).strict(),
  "thread/resume": z.object({
    thread: jsonRpcThreadSchema,
  }).strict(),
  "thread/list": z.object({
    threads: z.array(jsonRpcThreadSchema),
  }).strict(),
  "thread/read": z.object({
    thread: jsonRpcThreadSchema.extend({
      turns: z.array(z.unknown()).optional(),
    }),
    coworkSnapshot: z.unknown().nullable(),
    journalTailSeq: z.number().int().nonnegative().optional(),
  }).strict(),
  "thread/unsubscribe": z.object({
    status: z.enum(["unsubscribed", "notSubscribed", "notLoaded"]),
  }).strict(),
  "turn/start": z.object({
    turn: z.object({
      id: z.string().nullable(),
      threadId: nonEmptyTrimmedStringSchema,
      status: z.string(),
      items: z.array(z.unknown()),
    }).strict(),
  }).strict(),
  "turn/steer": z.object({
    turnId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "turn/interrupt": z.object({}).strict(),
} as const;
