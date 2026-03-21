import { z } from "zod";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

export const jsonRpcInitializeParamsSchema = z.object({
  clientInfo: z.object({
    name: nonEmptyTrimmedStringSchema,
    title: z.string().optional(),
    version: z.string().optional(),
  }).strict(),
  capabilities: z.object({
    experimentalApi: z.boolean().optional(),
    optOutNotificationMethods: z.array(nonEmptyTrimmedStringSchema).optional(),
  }).strict().optional(),
}).strict();

export const jsonRpcInitializedParamsSchema = z.object({}).strict();

export const jsonRpcRequestSchemas = {
  initialize: jsonRpcInitializeParamsSchema,
  initialized: jsonRpcInitializedParamsSchema,
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
    input: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
  }).strict(),
  "turn/steer": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    input: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
  }).strict(),
  "turn/interrupt": z.object({
    threadId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcNotificationSchemas = {
  "thread/started": z.object({
    thread: z.object({
      id: nonEmptyTrimmedStringSchema,
      title: z.string(),
      preview: z.string(),
      modelProvider: z.string(),
      model: z.string(),
      cwd: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      status: z.object({
        type: z.string(),
      }).strict(),
    }).strict(),
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

export const jsonRpcServerRequestSchemas = {
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

export const jsonRpcResultSchemas = {
  initialize: z.object({
    protocolVersion: z.string(),
    serverInfo: z.object({
      name: z.string(),
      subprotocol: z.string().optional(),
    }).strict(),
    capabilities: z.object({
      experimentalApi: z.boolean(),
    }).strict(),
    transport: z.object({
      type: z.literal("websocket"),
      protocolMode: z.enum(["legacy", "jsonrpc"]),
    }).strict(),
  }).strict(),
  "thread/start": z.object({
    thread: jsonRpcNotificationSchemas["thread/started"].shape.thread,
  }).strict(),
  "thread/resume": z.object({
    thread: jsonRpcNotificationSchemas["thread/started"].shape.thread,
  }).strict(),
  "thread/list": z.object({
    threads: z.array(jsonRpcNotificationSchemas["thread/started"].shape.thread),
  }).strict(),
  "thread/read": z.object({
    thread: jsonRpcNotificationSchemas["thread/started"].shape.thread.extend({
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

export const jsonRpcSchemaBundle = {
  requests: jsonRpcRequestSchemas,
  results: jsonRpcResultSchemas,
  notifications: jsonRpcNotificationSchemas,
  serverRequests: jsonRpcServerRequestSchemas,
};

export const jsonRpcSchemaBundleSchema = z.object({
  requests: z.object(jsonRpcRequestSchemas),
  results: z.object(jsonRpcResultSchemas),
  notifications: z.object(jsonRpcNotificationSchemas),
  serverRequests: z.object(jsonRpcServerRequestSchemas),
}).strict();
