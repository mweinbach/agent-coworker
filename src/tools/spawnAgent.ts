import path from "node:path";

import {
  Type,
  StringEnum,
  agentLoop,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type Message,
} from "../pi/types";

import { getModel as realGetModel } from "../config";
import { toAgentTool, toolRecordToArray } from "../pi/toolAdapter";
import { loadSubAgentPrompt as realLoadSubAgentPrompt } from "../prompt";
import { classifyCommandDetailed as realClassifyCommandDetailed } from "../utils/approval";

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
const MAX_SUB_AGENT_DEPTH = 2;
const MAX_SUB_AGENT_TASK_CHARS = 20_000;

export type SpawnAgentDeps = Partial<{
  getModel: typeof realGetModel;
  loadSubAgentPrompt: typeof realLoadSubAgentPrompt;
  classifyCommandDetailed: typeof realClassifyCommandDetailed;
}>;

function createSubAgentTools(
  parent: ToolContext,
  agentType: AgentType,
  safeApprove: (command: string) => boolean,
  turnUserPrompt?: string
): Record<string, any> {
  const subCtx: ToolContext = {
    config: parent.config,
    log: (line) => parent.log(`[sub:${agentType}] ${line}`),
    askUser: async () => {
      throw new Error("Sub-agent cannot ask the user directly.");
    },
    approveCommand: async (command) => {
      if (safeApprove(command)) return true;
      return await parent.approveCommand(command);
    },
    spawnDepth: (parent.spawnDepth ?? 0) + 1,
    abortSignal: parent.abortSignal,
    availableSkills: parent.availableSkills,
    turnUserPrompt: turnUserPrompt ?? parent.turnUserPrompt,
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
  const getModel = deps.getModel ?? realGetModel;
  const loadSubAgentPrompt = deps.loadSubAgentPrompt ?? realLoadSubAgentPrompt;
  const classifyCommandDetailed = deps.classifyCommandDetailed ?? realClassifyCommandDetailed;
  const safeApprove = (command: string) =>
    classifyCommandDetailed(command, {
      allowedRoots: [
        path.dirname(ctx.config.projectAgentDir),
        ctx.config.workingDirectory,
        ...(ctx.config.outputDirectory ? [ctx.config.outputDirectory] : []),
      ],
      workingDirectory: ctx.config.workingDirectory,
    }).kind === "auto";

  return toAgentTool({
    name: "spawnAgent",
    description:
      "Launch a sub-agent for a focused task (explore, research, or general). Sub-agents run with their own prompt and restricted tools and return their result.",
    parameters: Type.Object({
      task: Type.String({
        description: "What the sub-agent should accomplish",
        minLength: 1,
        maxLength: MAX_SUB_AGENT_TASK_CHARS,
      }),
      agentType: Type.Optional(StringEnum(["explore", "research", "general"], {
        description: "Agent type",
        default: "general",
      })),
    }),
    execute: async ({ task, agentType: rawAgentType }) => {
      const agentType = (rawAgentType ?? "general") as AgentType;
      ctx.log(`tool> spawnAgent ${JSON.stringify({ agentType })}`);
      if ((ctx.spawnDepth ?? 0) >= MAX_SUB_AGENT_DEPTH) {
        throw new Error(
          `Sub-agent recursion depth exceeded (max depth ${MAX_SUB_AGENT_DEPTH}).`
        );
      }
      const normalizedTask = task.trim();
      if (!normalizedTask) throw new Error("spawnAgent task must not be empty");

      const system = await loadSubAgentPrompt(ctx.config, agentType);
      const modelId =
        agentType === "research" ? ctx.config.model : ctx.config.subAgentModel;

      const toolRecord = createSubAgentTools(ctx, agentType, safeApprove, normalizedTask);
      const tools = toolRecordToArray(toolRecord as Record<string, AgentTool>);

      const model = getModel(ctx.config, modelId);
      const context = {
        systemPrompt: system,
        messages: [] as AgentMessage[],
        tools,
      };
      const config: AgentLoopConfig = {
        model,
        reasoning: "high",
        convertToLlm: (msgs: AgentMessage[]) =>
          msgs.filter((m): m is Message =>
            m.role === "user" || m.role === "assistant" || m.role === "toolResult"
          ),
      };

      const userMessage: AgentMessage = {
        role: "user",
        content: normalizedTask,
        timestamp: Date.now(),
      };

      let text = "";
      const eventStream = agentLoop([userMessage], context, config, ctx.abortSignal);
      for await (const event of eventStream) {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          text += event.assistantMessageEvent.delta;
        }
      }

      ctx.log(`tool< spawnAgent ${JSON.stringify({ chars: text.length })}`);
      return text;
    },
  });
}
