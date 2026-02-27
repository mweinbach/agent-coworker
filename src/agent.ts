import { z } from "zod";

import { getModel as realGetModel } from "./config";
import { buildRuntimeTelemetrySettings } from "./observability/runtime";
import { buildGooglePrepareStep } from "./providers/googleReplay";
import { createRuntime } from "./runtime";
import type { AgentConfig, ModelMessage, TodoItem } from "./types";
import { loadMCPServers, loadMCPTools } from "./mcp";
import { createTools } from "./tools";

const MCP_NAMESPACING_TOKEN = "`mcp__{serverName}__{toolName}`";
const MAX_STREAM_SETTLE_TICKS = 64;
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
const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
});
const responseMessagesSchema = z.array(z.unknown());
const stringSchema = z.string();
const asyncIterableSchema = z.custom<AsyncIterable<unknown>>((value) => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const iterable = value as { [Symbol.asyncIterator]?: unknown };
  return typeof iterable[Symbol.asyncIterator] === "function";
});
const streamResultWithFullStreamSchema = z.object({
  fullStream: asyncIterableSchema.optional(),
}).passthrough();

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

function extractTurnUserPrompt(messages: ModelMessage[]): string | undefined {
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

type RunTurnDeps = {
  createRuntime: typeof createRuntime;
  createTools: typeof createTools;
  loadMCPServers: typeof loadMCPServers;
  loadMCPTools: typeof loadMCPTools;
};

type LegacyStreamTextInput = Record<string, unknown>;
type LegacyStreamTextOutput = {
  text: string | Promise<string>;
  reasoningText?: string | Promise<string | undefined>;
  response?: unknown | Promise<unknown>;
  fullStream?: AsyncIterable<unknown>;
};
type LegacyStreamText = (input: LegacyStreamTextInput) => Promise<LegacyStreamTextOutput>;
type LegacyStepCountIs = (maxSteps: number) => unknown;
type LegacyGetModel = (config: AgentConfig, id?: string) => unknown;

type RunTurnOverrides = Partial<RunTurnDeps> & {
  streamText?: LegacyStreamText;
  stepCountIs?: LegacyStepCountIs;
  getModel?: LegacyGetModel;
};

export function createRunTurn(overrides: RunTurnOverrides = {}) {
  const {
    streamText: legacyStreamText,
    stepCountIs: legacyStepCountIs,
    getModel: legacyGetModel,
    ...runtimeOverrides
  } = overrides;
  const deps: RunTurnDeps = {
    createRuntime,
    createTools,
    loadMCPServers,
    loadMCPTools,
    ...runtimeOverrides,
  };
  const legacyModelResolver = legacyGetModel ?? realGetModel;
  const useLegacyModelApi = Boolean(legacyStreamText && legacyStepCountIs);

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
    const turnProviderOptions = config.providerOptions;
    const googlePrepareStep =
      config.provider === "google" && Object.keys(tools).length > 0
        ? buildGooglePrepareStep(turnProviderOptions, log)
        : undefined;

    const result = await (async (): Promise<{
      text: string;
      reasoningText?: string;
      responseMessages: ModelMessage[];
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }> => {
      try {
        const telemetry = await buildRuntimeTelemetrySettings(config, {
          functionId: params.telemetryContext?.functionId ?? "agent.runTurn",
          metadata: {
            ...(params.telemetryContext?.metadata ?? {}),
          },
        });
        if (useLegacyModelApi && legacyStreamText && legacyStepCountIs) {
          const streamTextInput: LegacyStreamTextInput = {
            model: legacyModelResolver(config),
            system: turnSystem,
            messages,
            tools,
            providerOptions: turnProviderOptions,
            ...(telemetry ? { experimental_telemetry: telemetry } : {}),
            stopWhen: legacyStepCountIs(params.maxSteps ?? 100),
            ...(googlePrepareStep ? { prepareStep: googlePrepareStep } : {}),
            abortSignal,
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
          };

          const streamResult = await legacyStreamText(streamTextInput);
          let streamConsumptionSettled = false;
          let streamPartCount = 0;
          const streamConsumption = (async () => {
            if (!params.onModelStreamPart) return;
            const parsedStream = streamResultWithFullStreamSchema.safeParse(streamResult);
            const fullStream = parsedStream.success ? parsedStream.data.fullStream : undefined;
            if (!fullStream) return;

            const streamIterator = fullStream[Symbol.asyncIterator]();
            while (true) {
              const next = await streamIterator.next();
              if (next.done) break;
              await params.onModelStreamPart(next.value);
              streamPartCount += 1;
            }
          })().finally(() => {
            streamConsumptionSettled = true;
          });

          const [text, reasoningText, response] = await Promise.all([
            Promise.resolve(streamResult.text),
            Promise.resolve(streamResult.reasoningText),
            Promise.resolve(streamResult.response),
          ]);

          if (params.onModelStreamPart) {
            let previousCount = streamPartCount;
            let stableTicks = 0;
            let ticks = 0;
            while (!streamConsumptionSettled && stableTicks < 2 && ticks < MAX_STREAM_SETTLE_TICKS) {
              await Promise.resolve();
              ticks += 1;
              if (streamPartCount === previousCount) {
                stableTicks += 1;
              } else {
                previousCount = streamPartCount;
                stableTicks = 0;
              }
            }
            if (streamConsumptionSettled) {
              try {
                await streamConsumption;
              } catch (error) {
                log(`[warn] Model stream ended with error: ${String(error)}`);
              }
            } else {
              log("[warn] Model stream did not drain after response completion; continuing turn.");
              void streamConsumption.catch((error) => {
                log(`[warn] Model stream ended with error after response completion: ${String(error)}`);
              });
            }
          }

          const parsedResponseMessages = responseMessagesSchema.safeParse((response as any)?.messages);
          const parsedReasoningText = stringSchema.safeParse(reasoningText);
          const parsedUsage = usageSchema.safeParse((response as any)?.usage);

          return {
            text: String(text ?? ""),
            reasoningText: parsedReasoningText.success ? parsedReasoningText.data : undefined,
            responseMessages: (parsedResponseMessages.success ? parsedResponseMessages.data : []) as ModelMessage[],
            usage: parsedUsage.success ? parsedUsage.data : undefined,
          };
        }

        const runtime = deps.createRuntime(config);
        return await runtime.runTurn({
          config,
          system: turnSystem,
          messages,
          tools,
          maxSteps: params.maxSteps ?? 100,
          providerOptions: turnProviderOptions,
          abortSignal,
          includeRawChunks: params.includeRawChunks ?? true,
          telemetry,
          ...(googlePrepareStep ? { prepareStep: googlePrepareStep } : {}),
          onModelStreamPart: params.onModelStreamPart,
          onModelError: params.onModelError,
          onModelAbort: params.onModelAbort,
          log,
        });
      } finally {
        try {
          await closeMcp?.();
        } catch {
          // ignore MCP close errors
        }
      }
    })();
    return result;
  };
}

export const runTurn = createRunTurn();

export async function runTurnWithDeps(
  params: RunTurnParams,
  overrides: RunTurnOverrides = {}
): Promise<{
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  return await createRunTurn(overrides)(params);
}
