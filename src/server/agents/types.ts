import type {
  AgentInspectResult,
  AgentMode,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
  PersistentAgentSummary,
} from "../../shared/agents";
import type { AgentConfig, ProviderName } from "../../types";
import type { AgentSession } from "../session/AgentSession";
import type { SessionRuntime } from "../session/SessionRuntime";
import type { SeededSessionContext } from "../session/SessionContext";
import type { SessionDb } from "../sessionDb";
import type { SessionBinding } from "../startServer/types";

export type AgentSpawnOptions = AgentSpawnContextOptions & {
  parentSessionId: string;
  parentConfig: AgentConfig;
  message: string;
  role?: AgentRole;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  parentDepth?: number;
};

export type AgentSendInputOptions = {
  parentSessionId: string;
  agentId: string;
  message: string;
  interrupt?: boolean;
};

export const AGENT_WAIT_MODE_VALUES = ["any", "all"] as const;
export type AgentWaitMode = (typeof AGENT_WAIT_MODE_VALUES)[number];

export type AgentWaitResult = {
  timedOut: boolean;
  mode: AgentWaitMode;
  agents: PersistentAgentSummary[];
  readyAgentIds: string[];
};

export type AgentWaitOptions = {
  parentSessionId: string;
  agentIds: string[];
  timeoutMs?: number;
  mode?: AgentWaitMode;
};

export type AgentResumeOptions = {
  parentSessionId: string;
  agentId: string;
};

export type AgentInspectOptions = {
  parentSessionId: string;
  agentId: string;
};

export type AgentCloseOptions = {
  parentSessionId: string;
  agentId: string;
};

export type AgentControlSummaryOverrides = {
  mode?: AgentMode;
  depth?: number;
  requestedModel?: string;
  requestedReasoningEffort?: AgentReasoningEffort;
  effectiveReasoningEffort?: AgentReasoningEffort;
  executionState?: PersistentAgentSummary["executionState"];
  busy?: boolean;
};

export type AgentControlDeps = {
  sessionBindings: Map<string, SessionBinding>;
  sessionDb: SessionDb | null;
  getConnectedProviders: (parentConfig: AgentConfig) => Promise<ProviderName[]>;
  buildSession: (
    binding: SessionBinding,
    persistedSessionId?: string,
    overrides?: {
      config?: AgentConfig;
      system?: string;
      seedContext?: SeededSessionContext;
      sessionInfoPatch?: Record<string, unknown>;
    },
  ) => {
    session: AgentSession;
    runtime: SessionRuntime;
    isResume: boolean;
    resumedFromStorage: boolean;
  };
  loadAgentPrompt: (config: AgentConfig, role: AgentRole) => Promise<string>;
  disposeBinding: (binding: SessionBinding, reason: string) => void;
  emitParentAgentStatus: (parentSessionId: string, agent: PersistentAgentSummary) => void;
  emitParentLog: (parentSessionId: string, line: string) => void;
};

export type AgentInspectRecord = AgentInspectResult;
