import type {
  AgentSpawnContextOptions,
  AgentInspectResult,
  AgentReasoningEffort,
  PersistentAgentSummary,
  AgentRole,
} from "../shared/agents";
import type { AgentShellPolicy } from "../server/agents/commandPolicy";
import type { AgentWaitMode, AgentWaitResult } from "../server/agents/types";
import type { AgentConfig, HarnessContextState } from "../types";
import type { TodoItem } from "../types";
import type { SessionCostTracker, SessionUsageSnapshot } from "../session/costTracker";
export type { AgentWaitMode, AgentWaitResult } from "../server/agents/types";

export interface AgentControl {
  spawn: (opts: AgentSpawnContextOptions & {
    message: string;
    role?: AgentRole;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
  }) => Promise<PersistentAgentSummary>;
  list: () => Promise<PersistentAgentSummary[]>;
  sendInput: (opts: { agentId: string; message: string; interrupt?: boolean }) => Promise<void>;
  wait: (opts: { agentIds: string[]; timeoutMs?: number; mode?: AgentWaitMode }) => Promise<AgentWaitResult>;
  inspect: (opts: { agentId: string }) => Promise<AgentInspectResult>;
  resume: (opts: { agentId: string }) => Promise<PersistentAgentSummary>;
  close: (opts: { agentId: string }) => Promise<PersistentAgentSummary>;
}

export interface ToolContext {
  config: AgentConfig;

  log: (line: string) => void;

  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string) => Promise<boolean>;

  updateTodos?: (todos: TodoItem[]) => void;

  /** Current sub-agent nesting depth (0 = root session). */
  spawnDepth?: number;

  /**
   * Abort signal for the active turn.
   * Tools should honor this signal for long-running operations.
   */
  abortSignal?: AbortSignal;

  /** Lightweight skill metadata for dynamic tool descriptions. Populated from skill discovery. */
  availableSkills?: Array<{ name: string; description: string }>;

  /**
   * Best-effort plain-text user prompt for the active turn.
   * Tools can use this as context when a provider-native-style tool call omits explicit arguments.
   */
  turnUserPrompt?: string;
  getTurnUserPrompt?: () => string | undefined;

  /** Structured run intent for the active session/turn. */
  harnessContext?: HarnessContextState | null;

  /** Optional role for child-agent tool filtering. */
  agentRole?: AgentRole;

  /** Effective shell mutation policy. Defaults to "full" when omitted. */
  shellPolicy?: AgentShellPolicy;

  /** Session-backed persistent agent lifecycle callbacks. */
  agentControl?: AgentControl;

  /** Session-level cost tracker. Tools can query and set budget thresholds. */
  costTracker?: SessionCostTracker;

  /** Notify the session when tool-driven budget changes should be persisted/emitted immediately. */
  onSessionUsageBudgetUpdated?: (snapshot: SessionUsageSnapshot) => void;
}
