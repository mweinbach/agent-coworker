import { resolveExperimentalA2uiConfig } from "../experimental/a2ui/flags";
import { getAgentRoleDefinition } from "../server/agents/roles";
import { filterToolsForRole } from "../server/agents/toolPolicy";
import {
  getCodexWebSearchBackendFromProviderOptions,
  getGoogleNativeWebSearchFromProviderOptions,
} from "../shared/openaiCompatibleOptions";
import type { AgentConfig } from "../types";
import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import type { ToolContext } from "./context";
import { createEditTool } from "./edit";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createMemoryTool } from "./memory";
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
import { createWebFetchTool } from "./webFetch";
import { createWebSearchTool } from "./webSearch";
import { createWriteTool } from "./write";

export { filterToolsForCodexDynamicBoundary } from "./codexBoundary";

function usesLegacyCodexWebSearch(ctx: ToolContext): boolean {
  if (ctx.config.provider !== "codex-cli") return false;
  return getCodexWebSearchBackendFromProviderOptions(ctx.config.providerOptions) !== "native";
}

function usesGoogleNativeWebTools(ctx: ToolContext): boolean {
  if (ctx.config.provider !== "google") return false;
  return getGoogleNativeWebSearchFromProviderOptions(ctx.config.providerOptions) === true;
}

function usesLegacyCodexWebSearchConfig(
  config: Pick<AgentConfig, "provider" | "providerOptions">,
): boolean {
  if (config.provider !== "codex-cli") return false;
  return getCodexWebSearchBackendFromProviderOptions(config.providerOptions) !== "native";
}

function usesGoogleNativeWebToolsConfig(
  config: Pick<AgentConfig, "provider" | "providerOptions">,
): boolean {
  if (config.provider !== "google") return false;
  return getGoogleNativeWebSearchFromProviderOptions(config.providerOptions) === true;
}

type ListSessionToolNameOptions = {
  includeAgentControl?: boolean;
};

export function listSessionToolNames(
  config: Pick<AgentConfig, "provider" | "providerOptions" | "enableMemory"> &
    Partial<Pick<AgentConfig, "enableA2ui" | "featureFlags" | "experimentalFeatures">>,
  opts: ListSessionToolNameOptions = {},
): string[] {
  const providerIsCodex = config.provider === "codex-cli";
  const includeLegacyWebSearch =
    !usesGoogleNativeWebToolsConfig(config) &&
    (!providerIsCodex || usesLegacyCodexWebSearchConfig(config));

  const localToolNames = [
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    ...(includeLegacyWebSearch ? ["webSearch"] : []),
    "webFetch",
  ];

  const coworkToolNames = [
    "AskUserQuestion",
    "todoWrite",
    "skill",
    ...((config.enableMemory ?? true) ? ["memory"] : []),
    ...(resolveExperimentalA2uiConfig(config) ? ["a2ui"] : []),
    ...(opts.includeAgentControl
      ? [
          "spawnAgent",
          "listAgents",
          "sendAgentInput",
          "waitForAgent",
          "inspectAgent",
          "resumeAgent",
          "closeAgent",
        ]
      : []),
  ];
  const codexDynamicLocalToolNames =
    providerIsCodex && includeLegacyWebSearch ? ["webSearch"] : [];
  const names = providerIsCodex
    ? [...codexDynamicLocalToolNames, ...coworkToolNames]
    : [...localToolNames, ...coworkToolNames];

  return [...names].sort((left, right) => left.localeCompare(right));
}

export function createTools(ctx: ToolContext): Record<string, any> {
  const askTool = createAskTool(ctx);
  const includeLegacyWebSearch =
    !usesGoogleNativeWebTools(ctx) &&
    (ctx.config.provider !== "codex-cli" || usesLegacyCodexWebSearch(ctx));
  const baseTools = {
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    ...(includeLegacyWebSearch ? { webSearch: createWebSearchTool(ctx) } : {}),
    webFetch: createWebFetchTool(ctx),
    AskUserQuestion: askTool,
    todoWrite: createTodoWriteTool(ctx),
    ...(ctx.agentControl ? { spawnAgent: createSpawnAgentTool(ctx) } : {}),
    skill: createSkillTool(ctx),
    ...((ctx.config.enableMemory ?? true) ? { memory: createMemoryTool(ctx) } : {}),
    ...(resolveExperimentalA2uiConfig(ctx.config) && ctx.applyA2uiEnvelope
      ? {
          a2ui: (
            require("../experimental/a2ui/tool") as typeof import("../experimental/a2ui/tool")
          ).createA2uiTool(ctx),
        }
      : {}),
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

export type { AgentControl, ToolContext } from "./context";
