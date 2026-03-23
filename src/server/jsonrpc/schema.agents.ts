import { z } from "zod";

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
