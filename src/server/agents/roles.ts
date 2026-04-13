import type { AgentMode, AgentReasoningEffort, AgentRole } from "../../shared/agents";

import type { AgentShellPolicy } from "./commandPolicy";

export type AgentRoleDefinition = {
  id: AgentRole;
  description: string;
  promptFile: string;
  defaultMode: AgentMode;
  readOnly: boolean;
  shellPolicy?: AgentShellPolicy;
  allowTools: string[];
  canAskUser: boolean;
  canSpawnChildren: boolean;
  maxDepth: number;
  modelPolicy?: {
    fixedModel?: string;
    fixedReasoningEffort?: AgentReasoningEffort;
  };
};

export const SPAWN_AGENT_PROMPT_OVERVIEW =
  "Launch a collaborative child agent for a well-scoped task. It returns a durable child handle to use with follow-up agent tools; use inspectAgent to read the child agent's full result.";

export const SPAWN_AGENT_WHEN_TO_USE = [
  {
    label: "Parallelization",
    description: "Independent work that can proceed concurrently.",
  },
  {
    label: "Context isolation",
    description: "Large codebase reads, heavy research, or deep analysis that would bloat the parent context.",
  },
  {
    label: "Verification",
    description: "Focused review, testing, or validation after implementation.",
  },
] as const;

export const SPAWN_AGENT_ORCHESTRATION_RULES = [
  "Provide detailed, self-contained prompts with the exact files, ownership, and expected output.",
  "Child-agent results are not visible to the user unless you summarize them.",
  "Child agents should stay bounded; do not use them for vague or open-ended delegation.",
] as const;

export const SPAWN_AGENT_COORDINATION_RULES = [
  "Use multiple child agents in parallel when research tasks are independent.",
  "After launching child agents, report only what was launched; do not predict their results.",
  "After research completes, synthesize the findings yourself into a concrete follow-up prompt.",
  "Continue with the same child when the next task has high context overlap.",
  "Spawn a fresh child when the next task is narrow and the previous child carried broad context.",
  "After non-trivial implementation, run an independent read-only verifier role for validation.",
  "Prefer one write-capable child per file area at a time to avoid edit collisions.",
] as const;

export const SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE = [
  "If `model` is omitted, the child inherits the live parent provider/model unless the role has a fixed model policy.",
  "`model` may be a same-provider model id or a full `provider:modelId` child target ref.",
  "`preferredChildModelRef` is only a workspace/UI suggestion; it does not override the spawn request automatically.",
  "If a cross-provider target is disallowed for this workspace or its provider is disconnected, the child falls back to the live parent provider/model.",
] as const;

export const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  default: {
    id: "default",
    description: "General child agent for bounded collaborative work.",
    promptFile: "default.md",
    defaultMode: "collaborative",
    readOnly: false,
    shellPolicy: "full",
    allowTools: ["bash", "read", "write", "edit", "glob", "grep", "webSearch", "webFetch", "notebookEdit", "skill", "memory", "usage", "todoWrite"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 2,
  },
  explorer: {
    id: "explorer",
    description: "Specific, well-scoped codebase questions.",
    promptFile: "explorer.md",
    defaultMode: "collaborative",
    readOnly: true,
    shellPolicy: "no_project_write",
    allowTools: ["bash", "read", "glob", "grep"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 2,
  },
  research: {
    id: "research",
    description: "Web and docs research with sourced summaries.",
    promptFile: "research.md",
    defaultMode: "collaborative",
    readOnly: true,
    shellPolicy: "no_project_write",
    allowTools: ["read", "webSearch", "webFetch"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 2,
  },
  worker: {
    id: "worker",
    description: "Execution and production work with bounded ownership.",
    promptFile: "worker.md",
    defaultMode: "collaborative",
    readOnly: false,
    shellPolicy: "full",
    allowTools: ["bash", "read", "write", "edit", "glob", "grep", "webSearch", "webFetch", "notebookEdit", "skill", "memory", "usage", "todoWrite"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 2,
  },
  reviewer: {
    id: "reviewer",
    description: "Read-only validation and review of assigned work.",
    promptFile: "reviewer.md",
    defaultMode: "delegate",
    readOnly: true,
    shellPolicy: "no_project_write",
    allowTools: ["bash", "read", "glob", "grep"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 2,
  },
};

export function getAgentRoleDefinition(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLE_DEFINITIONS[role];
}

export function getAgentRoleShellPolicy(role: AgentRole | null | undefined): AgentShellPolicy {
  if (!role) return "full";
  return AGENT_ROLE_DEFINITIONS[role].shellPolicy ?? "full";
}

function formatRoleCapabilities(role: AgentRoleDefinition): string[] {
  const capabilities = [
    role.description,
    `Default mode: ${role.defaultMode}.`,
    role.readOnly ? "Read-only." : "Write-capable.",
    role.canAskUser ? "Can ask the user directly." : "Cannot ask the user directly.",
    role.canSpawnChildren
      ? `Can spawn child agents up to depth ${role.maxDepth}.`
      : `Cannot spawn child agents; max depth ${role.maxDepth}.`,
  ];

  if (role.modelPolicy?.fixedModel) {
    capabilities.push(`Fixed model: \`${role.modelPolicy.fixedModel}\`.`);
  }
  if (role.modelPolicy?.fixedReasoningEffort) {
    capabilities.push(`Fixed reasoning effort: \`${role.modelPolicy.fixedReasoningEffort}\`.`);
  }

  return capabilities;
}

export function buildSpawnAgentRolePromptLine(role: AgentRoleDefinition): string {
  return `- **${role.id}**: ${formatRoleCapabilities(role).join(" ")}`;
}

export function buildSpawnAgentRolePromptLines(): string[] {
  return Object.values(AGENT_ROLE_DEFINITIONS).map((role) => buildSpawnAgentRolePromptLine(role));
}
