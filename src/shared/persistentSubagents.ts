import { z } from "zod";

import { PROVIDER_NAMES, type ProviderName } from "../types";

export const SESSION_KIND_VALUES = ["root", "subagent"] as const;
export type SessionKind = (typeof SESSION_KIND_VALUES)[number];

export const SUBAGENT_AGENT_TYPE_VALUES = ["explore", "research", "general"] as const;
export type SubagentAgentType = (typeof SUBAGENT_AGENT_TYPE_VALUES)[number];

export const sessionKindSchema = z.enum(SESSION_KIND_VALUES);
export const subagentAgentTypeSchema = z.enum(SUBAGENT_AGENT_TYPE_VALUES);

export type PersistentSubagentSummary = {
  sessionId: string;
  parentSessionId: string;
  agentType: SubagentAgentType;
  title: string;
  provider: ProviderName;
  model: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "closed";
  busy: boolean;
};

export const persistentSubagentSummarySchema = z.object({
  sessionId: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  agentType: subagentAgentTypeSchema,
  title: z.string().trim().min(1),
  provider: z.enum(PROVIDER_NAMES),
  model: z.string().trim().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  status: z.enum(["active", "closed"]),
  busy: z.boolean(),
}).strict();
