import type { PersistentSubagentSummary, SubagentAgentType } from "../shared/persistentSubagents";
import type { AgentConfig } from "../types";
import type { TodoItem } from "../types";
import type { SessionCostTracker } from "../session/costTracker";

export type PersistentAgentWaitResult = {
  agentId: string;
  sessionId: string;
  status: "completed" | "running" | "error" | "closed";
  busy: boolean;
  text?: string;
};

export interface PersistentAgentControl {
  spawn: (opts: { task: string; agentType?: SubagentAgentType }) => Promise<PersistentSubagentSummary>;
  list: () => Promise<PersistentSubagentSummary[]>;
  sendInput: (opts: { agentId: string; task: string }) => Promise<void>;
  wait: (opts: { agentId: string; timeoutMs?: number }) => Promise<PersistentAgentWaitResult>;
  close: (opts: { agentId: string }) => Promise<PersistentSubagentSummary>;
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

  /** Session-backed persistent agent lifecycle callbacks. */
  persistentAgentControl?: PersistentAgentControl;

  /** Session-level cost tracker. Tools can query and set budget thresholds. */
  costTracker?: SessionCostTracker;
}
