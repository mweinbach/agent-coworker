import type { ToolContext } from "./context";

import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createMemoryTool } from "./memory";
import { createNotebookEditTool } from "./notebookEdit";
import {
  createCloseAgentTool,
  createListPersistentAgentsTool,
  createSendAgentInputTool,
  createSpawnPersistentAgentTool,
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

export function createTools(ctx: ToolContext): Record<string, any> {
  const askTool = createAskTool(ctx);
  const baseTools = {
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    webSearch: createWebSearchTool(ctx),
    webFetch: createWebFetchTool(ctx),
    ask: askTool,
    AskUserQuestion: askTool,
    todoWrite: createTodoWriteTool(ctx),
    spawnAgent: createSpawnAgentTool(ctx),
    notebookEdit: createNotebookEditTool(ctx),
    skill: createSkillTool(ctx),
    memory: createMemoryTool(ctx),
    usage: createUsageTool(ctx),
  };

  if (!ctx.persistentAgentControl) {
    return baseTools;
  }

  return {
    ...baseTools,
    spawnPersistentAgent: createSpawnPersistentAgentTool(ctx),
    listPersistentAgents: createListPersistentAgentsTool(ctx),
    sendAgentInput: createSendAgentInputTool(ctx),
    waitForAgent: createWaitForAgentTool(ctx),
    closeAgent: createCloseAgentTool(ctx),
  };
}

export type { PersistentAgentControl, PersistentAgentWaitResult, ToolContext } from "./context";
