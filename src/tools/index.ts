import { getAgentRoleDefinition } from "../server/agents/roles";
import { filterToolsForRole } from "../server/agents/toolPolicy";
import { resolveTasksFeatureEnabled } from "../server/tasks/flags";
import {
  getCodexWebSearchBackendFromProviderOptions,
  getGoogleNativeWebSearchFromProviderOptions,
} from "../shared/openaiCompatibleOptions";
import type { AgentConfig } from "../types";
import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import type { ToolContext } from "./context";
import { createTaskCreationTool } from "./createTask";
import { createEditTool } from "./edit";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createManageMemoryTool } from "./manageMemory";
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
import { createReadPastConversationTool } from "./readPastConversation";
import { createRecallMemoryTool } from "./recallMemory";
import { createSkillTool } from "./skill";
import { createSpawnAgentTool } from "./spawnAgent";
import { createTaskReviewTool } from "./taskReview";
import { createTaskUpdateTool } from "./taskUpdate";
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
  config: Pick<AgentConfig, "provider" | "providerOptions" | "enableMemory" | "advancedMemory"> &
    Partial<Pick<AgentConfig, "featureFlags" | "experimentalFeatures" | "tasksEnabled">>,
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
    ...(resolveTasksFeatureEnabled(config) ? ["createTask"] : []),
    "skill",
    ...(config.advancedMemory
      ? ["recallMemory", "readPastConversation", "manageMemory"]
      : (config.enableMemory ?? true)
        ? ["memory"]
        : []),
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
  const codexDynamicLocalToolNames = providerIsCodex && includeLegacyWebSearch ? ["webSearch"] : [];
  const names = providerIsCodex
    ? [...codexDynamicLocalToolNames, ...coworkToolNames]
    : [...localToolNames, ...coworkToolNames];

  return [...names].sort((left, right) => left.localeCompare(right));
}

export function createTools(ctx: ToolContext): Record<string, any> {
  const askTool = createAskTool(ctx);
  const taskCreationTool = createTaskCreationTool(ctx);
  const taskReviewTool = createTaskReviewTool(ctx);
  const taskUpdateTool = createTaskUpdateTool(ctx);
  const includeLegacyWebSearch =
    !usesGoogleNativeWebTools(ctx) &&
    (ctx.config.provider !== "codex-cli" || usesLegacyCodexWebSearch(ctx));
  const scopedChild = (ctx.agentTargetPaths?.length ?? 0) > 0;
  const baseTools = {
    // Scoped child agents get path-scoped read/write/edit/glob/grep tools. Do
    // not expose bash there: the OS sandboxes can constrain writes, but their
    // practical shell profiles still allow broad filesystem reads.
    ...(scopedChild ? {} : { bash: createBashTool(ctx) }),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    ...(includeLegacyWebSearch ? { webSearch: createWebSearchTool(ctx) } : {}),
    webFetch: createWebFetchTool(ctx),
    ...(ctx.taskContext ? {} : { AskUserQuestion: askTool }),
    ...(taskUpdateTool ? { taskUpdate: taskUpdateTool } : { todoWrite: createTodoWriteTool(ctx) }),
    ...(taskReviewTool ? { reviewTask: taskReviewTool } : {}),
    ...(taskCreationTool ? { createTask: taskCreationTool } : {}),
    ...(ctx.agentControl ? { spawnAgent: createSpawnAgentTool(ctx) } : {}),
    skill: createSkillTool(ctx),
    ...(scopedChild
      ? {}
      : ctx.config.advancedMemory
        ? {
            recallMemory: createRecallMemoryTool(ctx),
            readPastConversation: createReadPastConversationTool(ctx),
            manageMemory: createManageMemoryTool(ctx),
          }
        : (ctx.config.enableMemory ?? true)
          ? { memory: createMemoryTool(ctx) }
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
