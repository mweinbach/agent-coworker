import { z } from "zod";

import { nonEmptyTrimmedStringSchema } from "./schema.shared";

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

export const jsonRpcCoreRequestSchemas = {
  initialize: jsonRpcInitializeParamsSchema,
  initialized: jsonRpcInitializedParamsSchema,
} as const;

export const jsonRpcCoreResultSchemas = {
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
} as const;
