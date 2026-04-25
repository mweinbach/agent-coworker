import { z } from "zod";

import {
  agentContextModeSchema,
  agentInspectResultSchema,
  agentReasoningEffortSchema,
  agentRoleSchema,
  agentTargetPathsSchema,
  agentTaskTypeSchema,
  persistentAgentSummarySchema,
  resolveAgentSpawnContextOptions,
} from "../../shared/agents";
import { AGENT_WAIT_MODE_VALUES } from "../agents/types";
import {
  sessionEventEnvelope,
  nonEmptyTrimmedStringSchema,
  optionalNonEmptyTrimmedStringSchema,
} from "./schema.shared";

export const agentListEventSchema = z
  .object({
    type: z.literal("agent_list"),
    sessionId: nonEmptyTrimmedStringSchema,
    agents: z.array(persistentAgentSummarySchema),
  })
  .strict();

export const agentSpawnedEventSchema = z
  .object({
    type: z.literal("agent_spawned"),
    sessionId: nonEmptyTrimmedStringSchema,
    agent: persistentAgentSummarySchema,
  })
  .strict();

export const agentStatusEventSchema = z
  .object({
    type: z.literal("agent_status"),
    sessionId: nonEmptyTrimmedStringSchema,
    agent: persistentAgentSummarySchema,
  })
  .strict();

export const agentWaitModeSchema = z.enum(AGENT_WAIT_MODE_VALUES);

export const agentWaitResultEventSchema = z
  .object({
    type: z.literal("agent_wait_result"),
    sessionId: nonEmptyTrimmedStringSchema,
    agentIds: z.array(nonEmptyTrimmedStringSchema).min(1),
    timedOut: z.boolean(),
    mode: agentWaitModeSchema,
    agents: z.array(persistentAgentSummarySchema),
    readyAgentIds: z.array(nonEmptyTrimmedStringSchema),
  })
  .strict();

export const jsonRpcAgentNotificationSchemas = {
  "cowork/session/agentList": agentListEventSchema,
  "cowork/session/agentSpawned": agentSpawnedEventSchema,
  "cowork/session/agentStatus": agentStatusEventSchema,
  "cowork/session/agentWaitResult": agentWaitResultEventSchema,
} as const;

const agentSpawnRequestSchema = z
  .object({
    threadId: nonEmptyTrimmedStringSchema,
    message: nonEmptyTrimmedStringSchema,
    role: agentRoleSchema.optional(),
    model: optionalNonEmptyTrimmedStringSchema,
    reasoningEffort: agentReasoningEffortSchema.optional(),
    nickname: optionalNonEmptyTrimmedStringSchema,
    taskType: agentTaskTypeSchema.optional(),
    targetPaths: agentTargetPathsSchema.optional(),
    contextMode: agentContextModeSchema.optional(),
    briefing: optionalNonEmptyTrimmedStringSchema,
    includeParentTodos: z.boolean().optional(),
    includeHarnessContext: z.boolean().optional(),
    forkContext: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, issueContext) => {
    try {
      resolveAgentSpawnContextOptions(value);
    } catch (error) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const jsonRpcAgentRequestSchemas = {
  // role / reasoningEffort use shared enums so malformed strings fail JSON-RPC invalidParams
  // before createAgentSession (see test/jsonrpc.routes.review-fixes.test.ts).
  "cowork/session/agent/spawn": agentSpawnRequestSchema,
  "cowork/session/agent/list": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/session/agent/input/send": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      agentId: nonEmptyTrimmedStringSchema,
      message: nonEmptyTrimmedStringSchema,
      interrupt: z.boolean().optional(),
    })
    .strict(),
  "cowork/session/agent/wait": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      agentIds: z.array(nonEmptyTrimmedStringSchema).min(1),
      timeoutMs: z.number().int().nonnegative().optional(),
      mode: agentWaitModeSchema.optional(),
    })
    .strict(),
  "cowork/session/agent/inspect": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      agentId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/session/agent/resume": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      agentId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/session/agent/close": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      agentId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
} as const;

export const jsonRpcAgentResultSchemas = {
  "cowork/session/agent/spawn": z.object({}).strict(),
  "cowork/session/agent/list": z.object({}).strict(),
  "cowork/session/agent/input/send": z.object({}).strict(),
  "cowork/session/agent/wait": z.object({}).strict(),
  "cowork/session/agent/inspect": sessionEventEnvelope(agentInspectResultSchema),
  "cowork/session/agent/resume": z.object({}).strict(),
  "cowork/session/agent/close": z.object({}).strict(),
} as const;
