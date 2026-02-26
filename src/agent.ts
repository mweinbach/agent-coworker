import type { ModelMessage } from "ai";
import { z } from "zod";

import { getModel } from "./config";
import { loadMCPServers, loadMCPTools } from "./mcp";
import { convertLegacyMessages } from "./pi/messageAdapter";
import { toolRecordToArray } from "./pi/toolAdapter";
import {
  agentLoop as piAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type ToolCall as PiToolCall,
  type Usage as PiUsage,
} from "./pi/types";
import { resolveCodexApiKey } from "./providers/codex-cli";
import { buildGoogleTransformContext } from "./providers/googleReplay";
import { DEFAULT_STREAM_OPTIONS } from "./providers";
import { createTools } from "./tools";
import type { AgentConfig, TodoItem } from "./types";

const MCP_NAMESPACING_TOKEN = "`mcp__{serverName}__{toolName}`";
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const messageRecordSchema = z.object({
  role: z.string(),
  content: z.unknown(),
}).passthrough();
const messageContentPartSchema = z.union([
  z.string(),
  z.object({
    text: z.string().optional(),
    inputText: z.string().optional(),
  }).passthrough(),
]);
const messageContentSchema = z.array(messageContentPartSchema);

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
  telemetryContext?: {
    functionId?: string;
    metadata?: Record<string, string | number | boolean | null | undefined>;
  };
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

function extractTurnUserPrompt(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messageRecordSchema.safeParse(messages[i]);
    if (!raw.success || raw.data.role !== "user") continue;

    const content = raw.data.content;
    const directContent = nonEmptyTrimmedStringSchema.safeParse(content);
    if (directContent.success) {
      return directContent.data;
    }

    const parsedContent = messageContentSchema.safeParse(content);
    if (!parsedContent.success) continue;

    const parts: string[] = [];
    for (const part of parsedContent.data) {
      if (typeof part === "string") {
        const text = nonEmptyTrimmedStringSchema.safeParse(part);
        if (text.success) parts.push(text.data);
        continue;
      }
      const text = nonEmptyTrimmedStringSchema.safeParse(part.text);
      if (text.success) {
        parts.push(text.data);
        continue;
      }
      const inputText = nonEmptyTrimmedStringSchema.safeParse(part.inputText);
      if (inputText.success) parts.push(inputText.data);
    }

    if (parts.length > 0) return parts.join("\n");
  }

  return undefined;
}

// ── Pi AgentEvent → synthetic AI SDK stream part mapping ────────────────────

function extractToolCallAtIndex(partial: PiAssistantMessage, index: number): PiToolCall | undefined {
  if (!partial?.content || index < 0 || index >= partial.content.length) return undefined;
  const item = partial.content[index];
  if (item && typeof item === "object" && "type" in item && item.type === "toolCall") {
    return item as PiToolCall;
  }
  return undefined;
}

/**
 * Maps a pi AgentEvent to synthetic AI SDK-like stream part objects.
 *
 * These synthetic objects have the same `{ type: "..." }` shape that
 * `normalizeModelStreamPart` in the session layer expects, providing
 * backward compatibility during the migration.
 */
function mapAgentEventToStreamParts(event: AgentEvent): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];

  switch (event.type) {
    case "agent_start":
      parts.push({ type: "start" });
      break;
    case "agent_end":
      parts.push({ type: "finish", finishReason: "stop" });
      break;
    case "turn_start":
      parts.push({ type: "start-step" });
      break;
    case "turn_end":
      parts.push({ type: "finish-step", finishReason: "stop" });
      break;
    case "message_update":
      mapAssistantEventToStreamParts(event.assistantMessageEvent, parts);
      break;
    case "tool_execution_end":
      if (event.isError) {
        parts.push({
          type: "tool-error",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          error: event.result,
        });
      } else {
        parts.push({
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.result,
        });
      }
      break;
    // agent_start, message_start, message_end, tool_execution_start,
    // tool_execution_update: no direct AI SDK equivalents
  }

  return parts;
}

function mapAssistantEventToStreamParts(
  ame: AssistantMessageEvent,
  parts: Record<string, unknown>[]
): void {
  switch (ame.type) {
    case "text_start":
      parts.push({ type: "text-start", id: `text-${ame.contentIndex}` });
      break;
    case "text_delta":
      parts.push({ type: "text-delta", text: ame.delta, id: `text-${ame.contentIndex}` });
      break;
    case "text_end":
      parts.push({ type: "text-end", id: `text-${ame.contentIndex}` });
      break;
    case "thinking_start":
      parts.push({ type: "reasoning-start", id: `thinking-${ame.contentIndex}` });
      break;
    case "thinking_delta":
      parts.push({ type: "reasoning-delta", text: ame.delta, id: `thinking-${ame.contentIndex}` });
      break;
    case "thinking_end":
      parts.push({ type: "reasoning-end", id: `thinking-${ame.contentIndex}` });
      break;
    case "toolcall_start": {
      const tc = extractToolCallAtIndex(ame.partial, ame.contentIndex);
      parts.push({
        type: "tool-input-start",
        toolCallId: tc?.id ?? "",
        toolName: tc?.name ?? "",
      });
      break;
    }
    case "toolcall_delta": {
      const tc = extractToolCallAtIndex(ame.partial, ame.contentIndex);
      parts.push({
        type: "tool-input-delta",
        toolCallId: tc?.id ?? "",
        delta: ame.delta,
      });
      break;
    }
    case "toolcall_end":
      parts.push({
        type: "tool-input-end",
        toolCallId: ame.toolCall.id,
      });
      parts.push({
        type: "tool-call",
        toolCallId: ame.toolCall.id,
        toolName: ame.toolCall.name,
        input: ame.toolCall.arguments,
      });
      break;
    case "error":
      parts.push({ type: "error", error: ame.reason });
      break;
    // "start", "done": no direct AI SDK stream part equivalents
  }
}

// ── Abort detection ─────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (obj.name === "AbortError") return true;
    if (obj.code === "ABORT_ERR") return true;
  }
  const msg = String(err).toLowerCase();
  return msg.includes("abort") || msg.includes("cancel");
}

// ── Usage conversion ────────────────────────────────────────────────────────

function convertPiUsage(
  totalUsage: { input: number; output: number; totalTokens: number }
): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  if (totalUsage.input === 0 && totalUsage.output === 0 && totalUsage.totalTokens === 0) {
    return undefined;
  }
  return {
    promptTokens: totalUsage.input,
    completionTokens: totalUsage.output,
    totalTokens: totalUsage.totalTokens || (totalUsage.input + totalUsage.output),
  };
}

// ── Dependencies ────────────────────────────────────────────────────────────

type RunTurnDeps = {
  agentLoop: typeof piAgentLoop;
  getModel: typeof getModel;
  createTools: typeof createTools;
  loadMCPServers: typeof loadMCPServers;
  loadMCPTools: typeof loadMCPTools;
};

export function createRunTurn(overrides: Partial<RunTurnDeps> = {}) {
  const deps: RunTurnDeps = {
    agentLoop: piAgentLoop,
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
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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
      turnUserPrompt: extractTurnUserPrompt(messages),
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

    // Convert input messages to pi format (handles both legacy AI SDK and pi messages).
    const piMessages = convertLegacyMessages(messages as unknown[]);

    // Build pi agent context.
    const toolArray = toolRecordToArray(tools);
    const agentContext: AgentContext = {
      systemPrompt: turnSystem,
      messages: piMessages as AgentMessage[],
      tools: toolArray,
    };

    // Build agent loop config with provider-specific stream options.
    const model = deps.getModel(config);
    const providerStreamOpts = DEFAULT_STREAM_OPTIONS[config.provider] ?? {};
    const googleTransform = config.provider === "google"
      ? buildGoogleTransformContext(log)
      : undefined;

    const loopConfig: AgentLoopConfig = {
      model,
      convertToLlm: (msgs: AgentMessage[]) => msgs as Message[],
      ...(googleTransform ? {
        transformContext: async (msgs: AgentMessage[]) =>
          googleTransform(msgs as Message[]) as AgentMessage[],
      } : {}),
      ...(config.provider === "codex-cli" ? {
        getApiKey: async () => {
          try {
            return await resolveCodexApiKey(config);
          } catch (e) {
            log(`[warn] Failed to resolve Codex API key: ${e}`);
            return undefined;
          }
        },
      } : {}),
      ...providerStreamOpts,
    };

    const maxSteps = params.maxSteps ?? 100;

    try {
      const eventStream = deps.agentLoop([], agentContext, loopConfig, abortSignal);

      let text = "";
      let reasoningText = "";
      let turnCount = 0;
      const totalUsage = { input: 0, output: 0, totalTokens: 0 };
      const responseMessages: Message[] = [];

      try {
        for await (const event of eventStream) {
          // Forward events as synthetic AI SDK stream parts for backward compat.
          if (params.onModelStreamPart) {
            const streamParts = mapAgentEventToStreamParts(event);
            for (const part of streamParts) {
              await params.onModelStreamPart(part);
            }
          }

          // Collect text and reasoning from deltas.
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              text += ame.delta;
            } else if (ame.type === "thinking_delta") {
              reasoningText += ame.delta;
            } else if (ame.type === "done") {
              // Aggregate usage from each LLM call.
              const u = ame.message.usage;
              if (u) {
                totalUsage.input += u.input;
                totalUsage.output += u.output;
                totalUsage.totalTokens += u.totalTokens;
              }
            } else if (ame.type === "error") {
              if (ame.reason === "aborted") {
                log("[model:abort]");
                await params.onModelAbort?.();
              } else {
                log(`[model:error] ${ame.reason}`);
                await params.onModelError?.(ame.error);
              }
            }
          }

          // Collect response messages from turn_end events.
          if (event.type === "turn_end") {
            responseMessages.push(event.message as Message);
            for (const tr of event.toolResults) {
              responseMessages.push(tr as Message);
            }
            turnCount++;
            if (turnCount >= maxSteps) {
              log(`[warn] Maximum step count (${maxSteps}) reached. Stopping agent loop.`);
              break;
            }
          }
        }
      } catch (loopError) {
        if (isAbortError(loopError)) {
          log("[model:abort]");
          await params.onModelAbort?.();
        } else {
          log(`[model:error] ${String(loopError)}`);
          await params.onModelError?.(loopError);
          throw loopError;
        }
      }

      // If text wasn't collected from deltas, try to extract from final messages.
      if (!text.trim()) {
        for (const msg of responseMessages) {
          if (msg.role === "assistant") {
            const assistMsg = msg as PiAssistantMessage;
            for (const part of assistMsg.content) {
              if (part.type === "text") {
                text += part.text;
              }
            }
          }
        }
      }

      return {
        text: text || "",
        reasoningText: reasoningText || undefined,
        responseMessages: responseMessages as unknown as ModelMessage[],
        usage: convertPiUsage(totalUsage),
      };
    } finally {
      try {
        await closeMcp?.();
      } catch {
        // ignore MCP close errors
      }
    }
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
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  return await createRunTurn(overrides)(params);
}
