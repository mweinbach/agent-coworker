import { stepCountIs, streamText } from "ai";
import type { ModelMessage } from "ai";

import { getModel } from "./config";
import type { AgentConfig, TodoItem } from "./types";
import { loadMCPServers, loadMCPTools } from "./mcp";
import { createTools } from "./tools";

export interface RunTurnParams {
  config: AgentConfig;
  system: string;
  messages: ModelMessage[];

  log: (line: string) => void;
  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string) => Promise<boolean>;
  updateTodos?: (todos: TodoItem[]) => void;

  /** Lightweight skill metadata for dynamic tool descriptions. */
  discoveredSkills?: Array<{ name: string; description: string }>;

  /** Sub-agent nesting depth (0 for root session turn). */
  spawnDepth?: number;

  maxSteps?: number;
  enableMcp?: boolean;
  abortSignal?: AbortSignal;
}

type RunTurnDeps = {
  streamText: typeof streamText;
  stepCountIs: typeof stepCountIs;
  getModel: typeof getModel;
  createTools: typeof createTools;
  loadMCPServers: typeof loadMCPServers;
  loadMCPTools: typeof loadMCPTools;
};

export function createRunTurn(overrides: Partial<RunTurnDeps> = {}) {
  const deps: RunTurnDeps = {
    streamText,
    stepCountIs,
    getModel,
    createTools,
    loadMCPServers,
    loadMCPTools,
    ...overrides,
  };

  return async function runTurn(params: RunTurnParams): Promise<{
    text: string;
    reasoningText?: string;
    responseMessages: ModelMessage[];
  }> {
    const { config, system, messages, log, askUser, approveCommand, updateTodos, discoveredSkills, abortSignal } = params;

    const toolCtx = {
      config,
      log,
      askUser,
      approveCommand,
      updateTodos,
      spawnDepth: params.spawnDepth ?? 0,
      availableSkills: discoveredSkills,
    };
    const builtInTools = deps.createTools(toolCtx);

    let mcpTools: Record<string, any> = {};
    const enableMcp = params.enableMcp ?? config.enableMcp ?? false;
    let closeMcp: undefined | (() => Promise<void>);
    if (enableMcp) {
      const servers = await deps.loadMCPServers(config);
      if (servers.length > 0) {
        const loaded = await deps.loadMCPTools(servers, { log });
        mcpTools = loaded.tools;
        closeMcp = loaded.close;
      }
    }

    const tools = { ...builtInTools, ...mcpTools };

    const result = await (async () => {
      try {
        const streamResult = await deps.streamText({
          model: deps.getModel(config),
          system,
          messages,
          tools,
          providerOptions: config.providerOptions,
          stopWhen: deps.stepCountIs(params.maxSteps ?? 100),
          abortSignal,
        } as any);

        const [text, reasoningText, response] = await Promise.all([
          streamResult.text,
          streamResult.reasoningText,
          streamResult.response,
        ]);

        return { text, reasoningText, response } as any;
      } finally {
        try {
          await closeMcp?.();
        } catch {
          // ignore MCP close errors
        }
      }
    })();

    const responseMessages = (result.response?.messages || []) as ModelMessage[];
    return {
      text: String(result.text ?? ""),
      reasoningText: typeof result.reasoningText === "string" ? result.reasoningText : undefined,
      responseMessages,
    };
  };
}

export const runTurn = createRunTurn();

export async function runTurnWithDeps(
  params: RunTurnParams,
  overrides: Partial<RunTurnDeps> = {}
): Promise<{
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
}> {
  return await createRunTurn(overrides)(params);
}
