import { z } from "zod";

import { type OpenAiReasoningEffort, OPENAI_REASONING_EFFORT_VALUES } from "./openaiCompatibleOptions";
import { PROVIDER_NAMES, type ProviderName } from "../types";

export const SESSION_KIND_VALUES = ["root", "agent"] as const;
export type SessionKind = (typeof SESSION_KIND_VALUES)[number];

export const AGENT_ROLE_VALUES = ["default", "explorer", "research", "worker", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLE_VALUES)[number];

export const AGENT_MODE_VALUES = ["collaborative", "delegate"] as const;
export type AgentMode = (typeof AGENT_MODE_VALUES)[number];

export const AGENT_LIFECYCLE_STATE_VALUES = ["active", "closed"] as const;
export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATE_VALUES)[number];

export const AGENT_EXECUTION_STATE_VALUES = ["pending_init", "running", "completed", "errored", "closed"] as const;
export type AgentExecutionState = (typeof AGENT_EXECUTION_STATE_VALUES)[number];

export type AgentReasoningEffort = OpenAiReasoningEffort;

export const sessionKindSchema = z.enum(SESSION_KIND_VALUES);
export const agentRoleSchema = z.enum(AGENT_ROLE_VALUES);
export const agentModeSchema = z.enum(AGENT_MODE_VALUES);
export const agentLifecycleStateSchema = z.enum(AGENT_LIFECYCLE_STATE_VALUES);
export const agentExecutionStateSchema = z.enum(AGENT_EXECUTION_STATE_VALUES);
export const agentReasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORT_VALUES);

export type PersistentAgentSummary = {
  agentId: string;
  parentSessionId: string;
  role: AgentRole;
  mode: AgentMode;
  depth: number;
  nickname?: string;
  requestedModel?: string;
  effectiveModel: string;
  requestedReasoningEffort?: AgentReasoningEffort;
  effectiveReasoningEffort?: AgentReasoningEffort;
  title: string;
  provider: ProviderName;
  createdAt: string;
  updatedAt: string;
  lifecycleState: AgentLifecycleState;
  executionState: AgentExecutionState;
  busy: boolean;
  lastMessagePreview?: string;
};

export const persistentAgentSummarySchema = z.object({
  agentId: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  role: agentRoleSchema,
  mode: agentModeSchema,
  depth: z.number().int().min(0),
  nickname: z.string().trim().min(1).optional(),
  requestedModel: z.string().trim().min(1).optional(),
  effectiveModel: z.string().trim().min(1),
  requestedReasoningEffort: agentReasoningEffortSchema.optional(),
  effectiveReasoningEffort: agentReasoningEffortSchema.optional(),
  title: z.string().trim().min(1),
  provider: z.enum(PROVIDER_NAMES),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  lifecycleState: agentLifecycleStateSchema,
  executionState: agentExecutionStateSchema,
  busy: z.boolean(),
  lastMessagePreview: z.string().trim().min(1).optional(),
}).strict();

export function mapLegacyAgentTypeToRole(role: string | null | undefined): AgentRole | null {
  if (!role) return null;
  switch (role) {
    case "explore":
      return "explorer";
    case "research":
      return "research";
    case "general":
      return "worker";
    default:
      return null;
  }
}
