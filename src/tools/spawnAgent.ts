import { stepCountIs as realStepCountIs, streamText as realStreamText, tool } from "ai";
import { z } from "zod";

import { getModel as realGetModel } from "../config";
import { loadSubAgentPrompt as realLoadSubAgentPrompt } from "../prompt";
import { classifyCommand as realClassifyCommand } from "../utils/approval";

import type { ToolContext } from "./context";
import { createBashTool } from "./bash";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createReadTool } from "./read";
import { createWebFetchTool } from "./webFetch";
import { createWebSearchTool } from "./webSearch";
import { createEditTool } from "./edit";
import { createWriteTool } from "./write";
import { createMemoryTool } from "./memory";
import { createSkillTool } from "./skill";
import { createNotebookEditTool } from "./notebookEdit";

type AgentType = "explore" | "research" | "general";

export type SpawnAgentDeps = Partial<{
  streamText: typeof realStreamText;
  stepCountIs: typeof realStepCountIs;
  getModel: typeof realGetModel;
  loadSubAgentPrompt: typeof realLoadSubAgentPrompt;
  classifyCommand: typeof realClassifyCommand;
}>;

function createSubAgentTools(
  parent: ToolContext,
  agentType: AgentType,
  safeApprove: (command: string) => boolean
): Record<string, any> {
  const subCtx: ToolContext = {
    config: parent.config,
    log: (line) => parent.log(`[sub:${agentType}] ${line}`),
    askUser: async () => {
      throw new Error("Sub-agent cannot ask the user directly.");
    },
    approveCommand: async (command) => safeApprove(command),
  };

  if (agentType === "explore") {
    return {
      read: createReadTool(subCtx),
      glob: createGlobTool(subCtx),
      grep: createGrepTool(subCtx),
      bash: createBashTool(subCtx),
    };
  }

  if (agentType === "research") {
    return {
      read: createReadTool(subCtx),
      webSearch: createWebSearchTool(subCtx),
      webFetch: createWebFetchTool(subCtx),
    };
  }

  // general
  return {
    read: createReadTool(subCtx),
    write: createWriteTool(subCtx),
    edit: createEditTool(subCtx),
    glob: createGlobTool(subCtx),
    grep: createGrepTool(subCtx),
    webSearch: createWebSearchTool(subCtx),
    webFetch: createWebFetchTool(subCtx),
    notebookEdit: createNotebookEditTool(subCtx),
    skill: createSkillTool(subCtx),
    memory: createMemoryTool(subCtx),
  };
}

export function createSpawnAgentTool(ctx: ToolContext, deps: SpawnAgentDeps = {}) {
  const streamText = deps.streamText ?? realStreamText;
  const stepCountIs = deps.stepCountIs ?? realStepCountIs;
  const getModel = deps.getModel ?? realGetModel;
  const loadSubAgentPrompt = deps.loadSubAgentPrompt ?? realLoadSubAgentPrompt;
  const classifyCommand = deps.classifyCommand ?? realClassifyCommand;

  const safeApprove = (command: string) => classifyCommand(command).kind === "auto";

  return tool({
    description:
      "Launch a sub-agent for a focused task (explore, research, or general). Sub-agents run with their own prompt and restricted tools and return their result.",
    inputSchema: z.object({
      task: z.string().describe("What the sub-agent should accomplish"),
      agentType: z.enum(["explore", "research", "general"]).optional().default("general"),
    }),
    execute: async ({ task, agentType }) => {
      ctx.log(`tool> spawnAgent ${JSON.stringify({ agentType })}`);

      const system = await loadSubAgentPrompt(ctx.config, agentType);
      const modelId = agentType === "research" ? ctx.config.model : ctx.config.subAgentModel;

      const tools = createSubAgentTools(ctx, agentType, safeApprove);

      const streamResult = await streamText({
        model: getModel(ctx.config, modelId),
        system,
        tools,
        stopWhen: stepCountIs(50),
        providerOptions: ctx.config.providerOptions,
        prompt: task,
      } as any);
      const text = await streamResult.text;

      ctx.log(`tool< spawnAgent ${JSON.stringify({ chars: text.length })}`);
      return text;
    },
  });
}
