import type { SandboxPolicy } from "../platform/sandbox/policy";
import type { AgentShellPolicy } from "../server/agents/commandPolicy";
import type { AgentWaitMode, AgentWaitResult } from "../server/agents/types";
import type { ThreadControl } from "../server/threads/types";
import type { SessionCostTracker, SessionUsageSnapshot } from "../session/costTracker";
import type { AgentProfileSnapshot } from "../shared/agentProfiles";
import type {
  AgentInspectResult,
  AgentReasoningEffort,
  AgentRole,
  AgentSpawnContextOptions,
  PersistentAgentSummary,
} from "../shared/agents";
import type {
  TaskContextSnapshot,
  TaskCreationInput,
  TaskCreationResult,
  TaskDirective,
  TaskDirectiveResult,
  TaskReviewMaterialReference,
} from "../shared/tasks";
import type { SkillUsageRecord } from "../skillImprovement/types";
import type { AgentConfig, ApproveCommandOptions, HarnessContextState, TodoItem } from "../types";

export interface AgentControl {
  spawn: (
    opts: AgentSpawnContextOptions & {
      message: string;
      role?: AgentRole;
      profileRef?: string;
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
    },
  ) => Promise<PersistentAgentSummary>;
  list: () => Promise<PersistentAgentSummary[]>;
  sendInput: (opts: { agentId: string; message: string; interrupt?: boolean }) => Promise<void>;
  wait: (opts: {
    agentIds: string[];
    timeoutMs?: number;
    mode?: AgentWaitMode;
    includeFinalMessage?: boolean;
    includeReport?: boolean;
  }) => Promise<AgentWaitResult>;
  inspect: (opts: { agentId: string }) => Promise<AgentInspectResult>;
  resume: (opts: { agentId: string }) => Promise<PersistentAgentSummary>;
  close: (opts: { agentId: string }) => Promise<PersistentAgentSummary>;
}

export interface ToolContext {
  config: AgentConfig;

  log: (line: string) => void;

  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string, opts?: ApproveCommandOptions) => Promise<boolean>;

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
  taskContext?: TaskContextSnapshot | null;
  getTaskContext?: () => TaskContextSnapshot | null;
  getTaskReviewMaterial?: () => Promise<TaskReviewMaterialReference | null>;
  applyTaskDirective?: (directive: TaskDirective) => Promise<TaskDirectiveResult>;
  createTask?: (input: TaskCreationInput) => Promise<TaskCreationResult>;

  /** Active session id, used for memory provenance and session-scoped tool state. */
  sessionId?: string;

  /** Optional role for child-agent tool filtering. */
  agentRole?: AgentRole;

  /** Resolved child-agent profile snapshot, persisted at spawn time. */
  agentProfile?: AgentProfileSnapshot;

  /** Optional filesystem scope for child agents spawned with targetPaths. */
  agentTargetPaths?: readonly string[] | null;

  /** Effective shell mutation policy. Defaults to "full" when omitted. */
  shellPolicy?: AgentShellPolicy;

  /**
   * Effective OS sandbox policy for shell command execution. When omitted, the
   * bash tool runs with full access (no sandbox). Enforced at the OS level via
   * `src/platform/sandbox`.
   */
  sandboxPolicy?: SandboxPolicy;

  /**
   * YOLO mode: zero approval prompts, commands run outside the OS sandbox.
   * Consulted by the bash tool's fallback policy resolution so it matches the
   * precomputed sandboxPolicy; hard floors (read-only roles, targetPaths)
   * still hold.
   */
  yolo?: boolean;

  /** Environment variables inherited by child processes launched from tools. */
  toolEnv?: Record<string, string | undefined>;

  /** Session-backed persistent agent lifecycle callbacks. */
  agentControl?: AgentControl;

  /** Session-backed root thread management callbacks. */
  threadControl?: ThreadControl;

  /** Whether this turn is authorized to access other conversation threads. */
  allowThreadManagementTools?: boolean;

  /** Session-level cost tracker. Tools can query and set budget thresholds. */
  costTracker?: SessionCostTracker;

  /** Notify the session when tool-driven budget changes should be persisted/emitted immediately. */
  onSessionUsageBudgetUpdated?: (snapshot: SessionUsageSnapshot) => void;

  /** Notify the session when an advanced-memory tool mutates a memory folder. */
  onAdvancedMemoryChanged?: (folder: string) => void | Promise<void>;

  /** Notify the session when a skill is loaded during the active turn. */
  onSkillUsed?: (usage: Omit<SkillUsageRecord, "turnId" | "usedAt">) => void | Promise<void>;

  /**
   * Server-authoritative write gate for tools with side effects. Mutating tools
   * call this immediately before filesystem/process side effects.
   */
  assertCanMutate?: (toolName: string) => void | Promise<void>;
}
