import type { ToolContext } from "./context";
import type { AgentConfig } from "../types";

import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createMemoryTool } from "./memory";
import { createNotebookEditTool } from "./notebookEdit";
import {
  createCloseAgentTool,
  createInspectAgentTool,
  createListAgentsTool,
  createResumeAgentTool,
  createSendAgentInputTool,
  createWaitForAgentTool,
} from "./persistentAgents";
import { createReadTool } from "./read";
import { createSkillTool } from "./skill";
import { createSpawnAgentTool } from "./spawnAgent";
import { createTodoWriteTool } from "./todoWrite";
import { createUsageTool } from "./usage";
import { createWebFetchTool } from "./webFetch";
import { createWebSearchTool } from "./webSearch";
import { createWriteTool } from "./write";
import { filterToolsForRole } from "../server/agents/toolPolicy";
import { getAgentRoleDefinition } from "../server/agents/roles";
import {
  getCodexWebSearchBackendFromProviderOptions,
  getGoogleNativeWebSearchFromProviderOptions,
} from "../shared/openaiCompatibleOptions";

function usesLegacyCodexWebSearch(ctx: ToolContext): boolean {
  if (ctx.config.provider !== "codex-cli") return false;
  return getCodexWebSearchBackendFromProviderOptions(ctx.config.providerOptions) === "exa";
}

function usesGoogleNativeWebTools(ctx: ToolContext): boolean {
  if (ctx.config.provider !== "google") return false;
  return getGoogleNativeWebSearchFromProviderOptions(ctx.config.providerOptions) === true;
}

function usesLegacyCodexWebSearchConfig(config: Pick<AgentConfig, "provider" | "providerOptions">): boolean {
  if (config.provider !== "codex-cli") return false;
  return getCodexWebSearchBackendFromProviderOptions(config.providerOptions) === "exa";
}

function usesGoogleNativeWebToolsConfig(config: Pick<AgentConfig, "provider" | "providerOptions">): boolean {
  if (config.provider !== "google") return false;
  return getGoogleNativeWebSearchFromProviderOptions(config.providerOptions) === true;
}

type ListSessionToolNameOptions = {
  includeAgentControl?: boolean;
};

export function listSessionToolNames(
  config: Pick<AgentConfig, "provider" | "providerOptions" | "enableMemory">,
  opts: ListSessionToolNameOptions = {},
): string[] {
  const includeLegacyWebSearch =
    !usesGoogleNativeWebToolsConfig(config)
    && (config.provider !== "codex-cli" || usesLegacyCodexWebSearchConfig(config));

  const names = [
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    ...(includeLegacyWebSearch ? ["webSearch"] : []),
    "webFetch",
    "ask",
    "AskUserQuestion",
    "todoWrite",
    "notebookEdit",
    "skill",
    ...(config.enableMemory ?? true ? ["memory"] : []),
    "usage",
    ...(opts.includeAgentControl
      ? ["spawnAgent", "listAgents", "sendAgentInput", "waitForAgent", "inspectAgent", "resumeAgent", "closeAgent"]
      : []),
  ];

  return [...names].sort((left, right) => left.localeCompare(right));
}

export function createTools(ctx: ToolContext): Record<string, any> {
  const askTool = createAskTool(ctx);
  const includeLegacyWebSearch =
    !usesGoogleNativeWebTools(ctx)
    && (ctx.config.provider !== "codex-cli" || usesLegacyCodexWebSearch(ctx));
  const baseTools = {
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    ...(includeLegacyWebSearch ? { webSearch: createWebSearchTool(ctx) } : {}),
    webFetch: createWebFetchTool(ctx),
    ask: askTool,
    AskUserQuestion: askTool,
    todoWrite: createTodoWriteTool(ctx),
    ...(ctx.agentControl ? { spawnAgent: createSpawnAgentTool(ctx) } : {}),
    notebookEdit: createNotebookEditTool(ctx),
    skill: createSkillTool(ctx),
    ...(ctx.config.enableMemory ?? true ? { memory: createMemoryTool(ctx) } : {}),
    usage: createUsageTool(ctx),
  };

  const roleFilteredTools = ctx.agentRole
    ? filterToolsForRole(baseTools, getAgentRoleDefinition(ctx.agentRole))
    : baseTools;

  if (!ctx.agentControl || ctx.agentRole) {
    return roleFilteredTools;
  }

  return {
    ...roleFilteredTools,
    listAgents: createListAgentsTool(ctx),
    sendAgentInput: createSendAgentInputTool(ctx),
    waitForAgent: createWaitForAgentTool(ctx),
    inspectAgent: createInspectAgentTool(ctx),
    resumeAgent: createResumeAgentTool(ctx),
    closeAgent: createCloseAgentTool(ctx),
  };
}

export type { AgentControl, AgentWaitResult, ToolContext } from "./context";
