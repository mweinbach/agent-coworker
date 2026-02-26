import path from "node:path";
import { z } from "zod";

import { getModel as realGetModel } from "../config";
import { buildRuntimeTelemetrySettings } from "../observability/runtime";
import { buildGooglePrepareStep } from "../providers/googleReplay";
import { loadSubAgentPrompt as realLoadSubAgentPrompt } from "../prompt";
import { createRuntime as realCreateRuntime } from "../runtime";
import type { AgentConfig } from "../types";
import { classifyCommandDetailed as realClassifyCommandDetailed } from "../utils/approval";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
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

type LegacyStreamTextResult = {
  text: string | Promise<string>;
};

type LegacyStreamTextInput = Record<string, unknown>;
type LegacyStreamText = (input: LegacyStreamTextInput) => Promise<LegacyStreamTextResult>;
type LegacyStepCountIs = (maxSteps: number) => unknown;
type LegacyGetModel = (config: AgentConfig, modelId?: string) => unknown;

export type SpawnAgentDeps = Partial<{
  createRuntime: typeof realCreateRuntime;
  streamText: LegacyStreamText;
  stepCountIs: LegacyStepCountIs;
  getModel: LegacyGetModel;
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
  const createRuntime = deps.createRuntime ?? realCreateRuntime;
  const streamText = deps.streamText;
  const stepCountIs = deps.stepCountIs;
  const getModel = deps.getModel ?? realGetModel;
  const loadSubAgentPrompt = deps.loadSubAgentPrompt ?? realLoadSubAgentPrompt;
  const classifyCommandDetailed = deps.classifyCommandDetailed ?? realClassifyCommandDetailed;
  const useLegacyModelApi = Boolean(streamText && stepCountIs && deps.getModel);
  const safeApprove = (command: string) =>
    classifyCommandDetailed(command, {
      allowedRoots: [
        path.dirname(ctx.config.projectAgentDir),
        ctx.config.workingDirectory,
        ...(ctx.config.outputDirectory ? [ctx.config.outputDirectory] : []),
      ],
      workingDirectory: ctx.config.workingDirectory,
    }).kind === "auto";

  return defineTool({
    description:
      "Launch a sub-agent for a focused task (explore, research, or general). Sub-agents run with their own prompt and restricted tools and return their result.",
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .max(MAX_SUB_AGENT_TASK_CHARS)
        .describe("What the sub-agent should accomplish"),
      agentType: z.enum(["explore", "research", "general"]).optional().default("general"),
    }),
    execute: async ({ task, agentType }) => {
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

      const tools = createSubAgentTools(ctx, agentType, safeApprove, normalizedTask);
      const googlePrepareStep =
        ctx.config.provider === "google" && Object.keys(tools).length > 0
          ? buildGooglePrepareStep(ctx.config.providerOptions, ctx.log)
          : undefined;
      const telemetry = await buildRuntimeTelemetrySettings(ctx.config, {
        functionId: "tool.spawnAgent",
        metadata: {
          agentType,
          modelId,
          spawnDepth: (ctx.spawnDepth ?? 0) + 1,
        },
      });

      let text = "";
      if (useLegacyModelApi && streamText && stepCountIs) {
        const streamTextInput = {
          model: getModel(ctx.config, modelId),
          system,
          tools,
          stopWhen: stepCountIs(50),
          providerOptions: ctx.config.providerOptions,
          ...(telemetry ? { experimental_telemetry: telemetry } : {}),
          ...(googlePrepareStep ? { prepareStep: googlePrepareStep } : {}),
          ...(typeof ctx.config.modelSettings?.maxRetries === "number"
            ? { maxRetries: ctx.config.modelSettings.maxRetries }
            : {}),
          abortSignal: ctx.abortSignal,
          prompt: normalizedTask,
        } as LegacyStreamTextInput;
        const streamResult = await streamText(streamTextInput);
        text = await streamResult.text;
      } else {
        const runtimeConfig = {
          ...ctx.config,
          model: modelId,
        };
        const runtime = createRuntime(runtimeConfig);
        const runtimeResult = await runtime.runTurn({
          config: runtimeConfig,
          system,
          messages: [{ role: "user", content: normalizedTask }] as any,
          tools,
          maxSteps: 50,
          providerOptions: runtimeConfig.providerOptions,
          abortSignal: ctx.abortSignal,
          ...(telemetry ? { telemetry } : {}),
          ...(googlePrepareStep ? { prepareStep: googlePrepareStep } : {}),
          log: ctx.log,
        });
        text = runtimeResult.text;
      }

      ctx.log(`tool< spawnAgent ${JSON.stringify({ chars: text.length })}`);
      return text;
    },
  });
}
