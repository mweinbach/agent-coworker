import type { AgentMode, AgentReasoningEffort, AgentRole } from "../../shared/agents";

export type AgentRoleDefinition = {
  id: AgentRole;
  description: string;
  promptFile: string;
  defaultMode: AgentMode;
  readOnly: boolean;
  allowTools: string[];
  canAskUser: boolean;
  canSpawnChildren: boolean;
  maxDepth: number;
  modelPolicy?: {
    fixedModel?: string;
    fixedReasoningEffort?: AgentReasoningEffort;
  };
};

export const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  default: {
    id: "default",
    description: "General child agent for bounded collaborative work.",
    promptFile: "default.md",
    defaultMode: "collaborative",
    readOnly: false,
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
    allowTools: ["bash", "read", "glob", "grep"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 2,
  },
};

export function getAgentRoleDefinition(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLE_DEFINITIONS[role];
}
