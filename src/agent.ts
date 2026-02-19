import { stepCountIs, streamText } from "ai";
import type { ModelMessage } from "ai";

import { getModel } from "./config";
import type { AgentConfig, TodoItem } from "./types";
import { loadMCPServers, loadMCPTools } from "./mcp";
import { createTools } from "./tools";

const DEFAULT_MODEL_STALL_TIMEOUT_MS = 90_000;
const MCP_NAMESPACING_TOKEN = "`mcp__{serverName}__{toolName}`";

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
  onModelStreamPart?: (part: unknown) => void | Promise<void>;
  onModelError?: (error: unknown) => void | Promise<void>;
  onModelAbort?: () => void | Promise<void>;
  includeRawChunks?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function stripStaticMcpNamespacingGuidance(system: string): string {
  return system
    .split("\n")
    .filter((line) => !line.includes(MCP_NAMESPACING_TOKEN))
    .join("\n");
}

function buildTurnSystemPrompt(system: string, mcpToolNames: string[]): string {
  const base = stripStaticMcpNamespacingGuidance(system);
  if (mcpToolNames.length === 0) return base;

  return [
    base,
    "",
    "## Active MCP Tools",
    "MCP tools are active in this turn. Their names follow `mcp__{serverName}__{toolName}`.",
    "Only call MCP tools that are present in the current tool list.",
  ].join("\n");
}

function getGoogleThoughtSignature(part: Record<string, unknown>): unknown {
  const providerOptions = part.providerOptions;
  if (!isRecord(providerOptions)) return undefined;
  const googleOptions = isRecord(providerOptions.google)
    ? providerOptions.google
    : isRecord(providerOptions.vertex)
      ? providerOptions.vertex
      : undefined;
  if (!googleOptions) return undefined;
  return (googleOptions as Record<string, unknown>).thoughtSignature ?? googleOptions.thought_signature;
}

function collectInvalidGoogleToolCallIds(messages: ModelMessage[]): Set<string> {
  const invalidToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-call") continue;
      const signature = getGoogleThoughtSignature(part);
      if (signature !== undefined && signature !== null && String(signature).length > 0) continue;
      if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
        invalidToolCallIds.add(part.toolCallId);
      }
    }
  }
  return invalidToolCallIds;
}

function sanitizeGoogleReplayMessages(messages: ModelMessage[], log: (line: string) => void): ModelMessage[] {
  const invalidToolCallIds = collectInvalidGoogleToolCallIds(messages);
  let removedToolCalls = 0;
  let removedToolResults = 0;
  let changed = false;
  const sanitized: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const filtered = message.content.filter((part) => {
        if (!isRecord(part) || part.type !== "tool-call") return true;

        const signature = getGoogleThoughtSignature(part);
        if (signature !== undefined && signature !== null && String(signature).length > 0) return true;

        removedToolCalls += 1;
        changed = true;
        return false;
      });
      if (filtered.length === 0) continue;
      if (filtered.length !== message.content.length) {
        sanitized.push({ ...message, content: filtered } as ModelMessage);
      } else {
        sanitized.push(message);
      }
      continue;
    }

    if (message.role === "tool" && Array.isArray(message.content) && invalidToolCallIds.size > 0) {
      const filtered = message.content.filter((part) => {
        if (!isRecord(part) || part.type !== "tool-result" || typeof part.toolCallId !== "string") return true;
        if (!invalidToolCallIds.has(part.toolCallId)) return true;
        removedToolResults += 1;
        changed = true;
        return false;
      });
      if (filtered.length === 0) continue;
      if (filtered.length !== message.content.length) {
        sanitized.push({ ...message, content: filtered } as ModelMessage);
      } else {
        sanitized.push(message);
      }
      continue;
    }

    sanitized.push(message);
  }

  if (removedToolCalls > 0) {
    log(
      `[warn] Dropped ${removedToolCalls} prior Gemini tool call(s) without thought signatures` +
        (removedToolResults > 0 ? ` and ${removedToolResults} orphaned tool result(s)` : "") +
        "."
    );
  }

  return changed ? sanitized : messages;
}

function mergeToolSets(
  builtInTools: Record<string, any>,
  mcpTools: Record<string, any>,
  log: (line: string) => void
): Record<string, any> {
  const merged: Record<string, any> = { ...builtInTools };
  for (const [name, toolDef] of Object.entries(mcpTools)) {
    if (!(name in merged)) {
      merged[name] = toolDef;
      continue;
    }

    const baseAlias = `mcp__${name}`;
    let alias = baseAlias;
    let i = 2;
    while (alias in merged) {
      alias = `${baseAlias}_${i}`;
      i += 1;
    }
    log(`[warn] MCP tool name collision: "${name}" remapped to "${alias}"`);
    merged[alias] = toolDef;
  }
  return merged;
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
      abortSignal,
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

    const tools = mergeToolSets(builtInTools, mcpTools, log);
    const mcpToolNames = Object.keys(mcpTools).sort();
    const turnSystem = buildTurnSystemPrompt(system, mcpToolNames);
    const turnMessages =
      config.provider === "google" ? sanitizeGoogleReplayMessages(messages, log) : messages;

    const result = await (async () => {
      try {
        const timeoutCfg = config.modelSettings?.timeout;
        const hasExplicitTimeout =
          typeof timeoutCfg?.totalMs === "number" ||
          typeof timeoutCfg?.stepMs === "number" ||
          typeof timeoutCfg?.chunkMs === "number";
        const timeout = hasExplicitTimeout
          ? {
              ...(typeof timeoutCfg?.totalMs === "number" ? { totalMs: timeoutCfg.totalMs } : {}),
              ...(typeof timeoutCfg?.stepMs === "number" ? { stepMs: timeoutCfg.stepMs } : {}),
              ...(typeof timeoutCfg?.chunkMs === "number" ? { chunkMs: timeoutCfg.chunkMs } : {}),
            }
          : { chunkMs: DEFAULT_MODEL_STALL_TIMEOUT_MS };
        const streamResult = await deps.streamText({
          model: deps.getModel(config),
          system: turnSystem,
          messages: turnMessages,
          tools,
          providerOptions: config.providerOptions,
          stopWhen: deps.stepCountIs(params.maxSteps ?? 100),
          abortSignal,
          timeout,
          ...(typeof config.modelSettings?.maxRetries === "number"
            ? { maxRetries: config.modelSettings.maxRetries }
            : {}),
          onError: async ({ error }: { error: unknown }) => {
            log(`[model:error] ${String(error)}`);
            await params.onModelError?.(error);
          },
          onAbort: async () => {
            log("[model:abort]");
            await params.onModelAbort?.();
          },
          includeRawChunks: params.includeRawChunks ?? true,
        } as any);

        const streamConsumption = (async () => {
          if (!params.onModelStreamPart) return;
          const fullStream = (streamResult as any).fullStream;
          if (!fullStream || typeof fullStream[Symbol.asyncIterator] !== "function") return;
          for await (const part of fullStream as AsyncIterable<unknown>) {
            await params.onModelStreamPart(part);
          }
        })();

        const [, text, reasoningText, response] = await Promise.all([
          streamConsumption,
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
