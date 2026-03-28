import { z } from "zod";

import {
  getAttachmentCountValidationMessage,
  getAttachmentValidationMessage,
  MAX_ATTACHMENT_BASE64_SIZE,
} from "../../shared/attachments";
import { projectedItemSchema } from "../../shared/projectedItems";
import { sessionSnapshotSchema } from "../../shared/sessionSnapshot";
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

const textInputPart = z.object({
  type: z.literal("text"),
  text: z.string(),
}).strict();

const legacyInputTextPart = z.object({
  type: z.literal("inputText"),
  text: z.string(),
}).strict();

const fileInputPart = z.object({
  type: z.literal("file"),
  filename: z.string().min(1),
  contentBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_SIZE),
  mimeType: z.string().min(1),
}).strict();

const uploadedFileInputPart = z.object({
  type: z.literal("uploadedFile"),
  filename: z.string().min(1),
  path: z.string().min(1),
  mimeType: z.string().min(1),
}).strict();

const inputPart = z.discriminatedUnion("type", [textInputPart, legacyInputTextPart, fileInputPart, uploadedFileInputPart]);
const turnInputPartsSchema = z.array(inputPart).superRefine((input, ctx) => {
  const attachments = input.filter((part): part is z.infer<typeof fileInputPart> | z.infer<typeof uploadedFileInputPart> => (
    part.type === "file" || part.type === "uploadedFile"
  ));
  const countMessage = getAttachmentCountValidationMessage(attachments.length);
  if (countMessage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: countMessage,
    });
    return;
  }
  const inlineAttachments = attachments.filter((part): part is z.infer<typeof fileInputPart> => part.type === "file");
  const message = getAttachmentValidationMessage(inlineAttachments);
  if (!message) {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
  });
});
const turnInputSchema = z.union([z.string(), turnInputPartsSchema]);

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
    input: turnInputSchema,
  }).strict(),
  "turn/steer": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema.optional(),
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
    input: turnInputSchema,
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
      items: z.array(projectedItemSchema),
    }).strict(),
  }).strict(),
  "item/started": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema.nullable(),
    item: projectedItemSchema,
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
    turnId: nonEmptyTrimmedStringSchema.nullable(),
    item: projectedItemSchema,
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
      turns: z.array(z.object({
        id: nonEmptyTrimmedStringSchema,
        status: z.string(),
        items: z.array(projectedItemSchema),
      }).strict()).optional(),
    }),
    coworkSnapshot: sessionSnapshotSchema.nullable(),
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
