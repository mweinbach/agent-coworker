import type { AgentSession } from "../session/AgentSession";
import type { SessionDb } from "../sessionDb";
import type { AgentConfig } from "../../types";
import type { ProviderName } from "../../types";
import type {
  AgentSpawnContextOptions,
  AgentInspectResult,
  AgentMode,
  AgentReasoningEffort,
  AgentRole,
  PersistentAgentSummary,
} from "../../shared/agents";
import type { SessionBinding } from "../startServer/types";
import type { SeededSessionContext } from "../session/SessionContext";

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

export type AgentWaitOptions = {
  parentSessionId: string;
  agentIds: string[];
  timeoutMs?: number;
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
    isResume: boolean;
    resumedFromStorage: boolean;
  };
  loadAgentPrompt: (config: AgentConfig, role: AgentRole) => Promise<string>;
  disposeBinding: (binding: SessionBinding, reason: string) => void;
  emitParentAgentStatus: (parentSessionId: string, agent: PersistentAgentSummary) => void;
  emitParentLog: (parentSessionId: string, line: string) => void;
};

export type AgentInspectRecord = AgentInspectResult;
