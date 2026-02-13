import { stepCountIs, streamText } from "ai";
import type { ModelMessage } from "ai";

import { getModel } from "./config";
import type { AgentConfig, TodoItem } from "./types";
import { loadMCPServers, loadMCPTools } from "./mcp";
import { createTools } from "./tools";

function sanitizeGeminiToolCallReplay(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    // Gemini CLI currently drops function-call thought signatures when AI SDK
    // replays assistant tool-call parts. Keep only non-tool-call assistant parts.
    const filtered = message.content.filter((part: any) => part?.type !== "tool-call");
    if (filtered.length === 0) continue;
    out.push({ ...message, content: filtered } as ModelMessage);
  }

  return out;
}

function unifiedFinishReason(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && typeof (v as any).unified === "string") {
    return (v as any).unified;
  }
  return undefined;
}

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

    const toolCtx = { config, log, askUser, approveCommand, updateTodos, availableSkills: discoveredSkills };
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
        if (config.provider === "gemini-cli") {
          // Workaround for Gemini CLI provider tool-call replay:
          // keep model calls single-step and manually continue with sanitized history.
          const maxSteps = params.maxSteps ?? 100;
          const rollingMessages = sanitizeGeminiToolCallReplay(messages);
          const responseMessages: ModelMessage[] = [];
          const reasoningChunks: string[] = [];
          let text = "";

          for (let step = 0; step < maxSteps; step++) {
            const stepResult = await deps.streamText({
              model: deps.getModel(config),
              system,
              messages: rollingMessages,
              tools,
              providerOptions: config.providerOptions,
              stopWhen: deps.stepCountIs(1),
              abortSignal,
            } as any);

            const stepResponse = await stepResult.response;
            const stepResponseMessages = sanitizeGeminiToolCallReplay(
              (stepResponse?.messages || []) as ModelMessage[]
            );
            if (stepResponseMessages.length > 0) {
              responseMessages.push(...stepResponseMessages);
              rollingMessages.push(...stepResponseMessages);
            }

            const stepReasoningText = await stepResult.reasoningText;
            const stepReasoning = typeof stepReasoningText === "string" ? stepReasoningText.trim() : "";
            if (stepReasoning) reasoningChunks.push(stepReasoning);

            const stepText = String((await stepResult.text) ?? "").trim();
            if (stepText) text = text ? `${text}\n${stepText}` : stepText;

            const finish = unifiedFinishReason(await stepResult.finishReason);
            const hasToolResult = stepResponseMessages.some((m) => m.role === "tool");
            if (finish !== "tool-calls") break;
            if (!hasToolResult) break;
          }

          return {
            text,
            reasoningText: reasoningChunks.length > 0 ? reasoningChunks.join("\n\n") : undefined,
            response: { messages: responseMessages },
          } as any;
        }

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
