import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ToolContext } from "./context";

import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createMemoryTool } from "./memory";
import { createNotebookEditTool } from "./notebookEdit";
import { createReadTool } from "./read";
import { createSkillTool } from "./skill";
import { createSpawnAgentTool } from "./spawnAgent";
import { createTodoWriteTool } from "./todoWrite";
import { createWebFetchTool } from "./webFetch";
import { createWebSearchTool } from "./webSearch";
import { createWriteTool } from "./write";

/**
 * Creates the full tool set as a name-keyed record of AgentTool objects.
 *
 * Pi's agentLoop expects AgentTool[], but we keep the record format for
 * backward compatibility with MCP tool merging and the sub-agent tool subsetting.
 * Use `Object.values(tools)` to get the array for pi.
 */
export function createTools(ctx: ToolContext): Record<string, AgentTool> {
  const askTool = createAskTool(ctx);

  return {
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    webSearch: createWebSearchTool(ctx),
    webFetch: createWebFetchTool(ctx),
    ask: askTool,
    todoWrite: createTodoWriteTool(ctx),
    spawnAgent: createSpawnAgentTool(ctx),
    notebookEdit: createNotebookEditTool(ctx),
    skill: createSkillTool(ctx),
    memory: createMemoryTool(ctx),
  };
}

export type { ToolContext } from "./context";
