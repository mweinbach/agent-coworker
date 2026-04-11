import { z } from "zod";

import { agentInspectResultSchema, agentReasoningEffortSchema, agentRoleSchema } from "../../shared/agents";
import { legacyEventEnvelope, nonEmptyTrimmedStringSchema, optionalNonEmptyTrimmedStringSchema } from "./schema.shared";

export const agentListEventSchema = z.object({
  type: z.literal("agent_list"),
  agents: z.array(z.unknown()),
}).passthrough();

export const agentSpawnedEventSchema = z.object({
  type: z.literal("agent_spawned"),
  agent: z.unknown(),
}).passthrough();

export const agentStatusEventSchema = z.object({
  type: z.literal("agent_status"),
  agent: z.unknown(),
}).passthrough();

export const agentWaitResultEventSchema = z.object({
  type: z.literal("agent_wait_result"),
  agentIds: z.array(z.string()),
  agents: z.array(z.unknown()),
}).passthrough();

export const jsonRpcAgentNotificationSchemas = {
  "cowork/session/agentList": agentListEventSchema,
  "cowork/session/agentSpawned": agentSpawnedEventSchema,
  "cowork/session/agentStatus": agentStatusEventSchema,
  "cowork/session/agentWaitResult": agentWaitResultEventSchema,
} as const;

export const jsonRpcAgentRequestSchemas = {
  // role / reasoningEffort use shared enums so malformed strings fail JSON-RPC invalidParams
  // before createAgentSession (see test/jsonrpc.routes.review-fixes.test.ts).
  "cowork/session/agent/spawn": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    message: nonEmptyTrimmedStringSchema,
    role: agentRoleSchema.optional(),
    model: optionalNonEmptyTrimmedStringSchema,
    reasoningEffort: agentReasoningEffortSchema.optional(),
    forkContext: z.boolean().optional(),
  }).strict(),
  "cowork/session/agent/list": z.object({
    threadId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/agent/input/send": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    agentId: nonEmptyTrimmedStringSchema,
    message: nonEmptyTrimmedStringSchema,
    interrupt: z.boolean().optional(),
  }).strict(),
  "cowork/session/agent/wait": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    agentIds: z.array(nonEmptyTrimmedStringSchema).min(1),
    timeoutMs: z.number().int().nonnegative().optional(),
  }).strict(),
  "cowork/session/agent/inspect": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    agentId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/agent/resume": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    agentId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/agent/close": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    agentId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcAgentResultSchemas = {
  "cowork/session/agent/spawn": z.object({}).strict(),
  "cowork/session/agent/list": z.object({}).strict(),
  "cowork/session/agent/input/send": z.object({}).strict(),
  "cowork/session/agent/wait": z.object({}).strict(),
  "cowork/session/agent/inspect": legacyEventEnvelope(agentInspectResultSchema),
  "cowork/session/agent/resume": z.object({}).strict(),
  "cowork/session/agent/close": z.object({}).strict(),
} as const;
