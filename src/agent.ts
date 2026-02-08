import { generateText, stepCountIs } from "ai";
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

  maxSteps?: number;
  enableMcp?: boolean;
}

export async function runTurn(params: RunTurnParams): Promise<{
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
}> {
  const { config, system, messages, log, askUser, approveCommand, updateTodos } = params;

  const toolCtx = { config, log, askUser, approveCommand, updateTodos };
  const builtInTools = createTools(toolCtx);

  let mcpTools: Record<string, any> = {};
  const enableMcp = params.enableMcp ?? config.enableMcp ?? false;
  let closeMcp: undefined | (() => Promise<void>);
  if (enableMcp) {
    const servers = await loadMCPServers(config);
    if (servers.length > 0) {
      const loaded = await loadMCPTools(servers, { log });
      mcpTools = loaded.tools;
      closeMcp = loaded.close;
    }
  }

  const tools = { ...builtInTools, ...mcpTools };

  const result = await (async () => {
    try {
      return await generateText({
        model: getModel(config),
        system,
        messages,
        tools,
        providerOptions: config.providerOptions,
        stopWhen: stepCountIs(params.maxSteps ?? 100),
      } as any);
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
}
