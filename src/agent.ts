import { z } from "zod";

import { renderCodexPrimaryRuntimeInstructions } from "./codexPrimaryRuntime";
import { getModel as realGetModel } from "./config";
import {
  prepareManagedSofficeToolEnv,
  renderManagedSofficeRuntimeInstructions,
} from "./managedSofficeRuntime";
import { getOrLoadMCPToolsCached, loadMCPServers, loadMCPTools } from "./mcp";
import { buildRuntimeTelemetrySettings } from "./observability/runtime";
import { buildGooglePrepareStep } from "./providers/googleReplay";
import { createRuntime } from "./runtime";
import type {
  RuntimeModelRawEvent,
  RuntimePrepareStep,
  RuntimeRegisterSteerHandler,
  RuntimeStepOverride,
} from "./runtime/types";
import type { AgentShellPolicy } from "./server/agents/commandPolicy";
import { getAgentRoleDefinition, getAgentRoleShellPolicy } from "./server/agents/roles";
import { filterToolsForRole } from "./server/agents/toolPolicy";
import type { SessionCostTracker, SessionUsageSnapshot } from "./session/costTracker";
import type { AgentRole } from "./shared/agents";
import type { ProviderContinuationState } from "./shared/providerContinuation";
import type { AgentControl } from "./tools";
import { createTools, filterToolsForCodexDynamicBoundary } from "./tools";
import { buildTurnSystemPrompt } from "./turnSystemPrompt";
import type { AgentConfig, HarnessContextState, ModelMessage, TodoItem } from "./types";
import { resolveAuthHomeDir } from "./utils/authHome";

/** Maximum time (ms) to wait for the legacy stream to drain after response promises settle. */
let STREAM_DRAIN_TIMEOUT_MS = 30_000;
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const messageRecordSchema = z
  .object({
    role: z.string(),
    content: z.unknown(),
  })
  .passthrough();
const messageContentPartSchema = z.union([
  z.string(),
  z
    .object({
      text: z.string().optional(),
      inputText: z.string().optional(),
    })
    .passthrough(),
]);
const messageContentSchema = z.array(messageContentPartSchema);
const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  cachedPromptTokens: z.number().optional(),
  cacheWritePromptTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
});
const responseMessagesSchema = z.array(z.unknown());
const stringSchema = z.string();
const asyncIterableSchema = z.custom<AsyncIterable<unknown>>((value) => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const iterable = value as { [Symbol.asyncIterator]?: unknown };
  return typeof iterable[Symbol.asyncIterator] === "function";
});
const streamResultWithFullStreamSchema = z
  .object({
    fullStream: asyncIterableSchema.optional(),
  })
  .passthrough();

export interface RunTurnParams {
  config: AgentConfig;
  system: string;
  messages: ModelMessage[];
  allMessages?: ModelMessage[];
  providerState?: ProviderContinuationState | null;
  harnessContext?: HarnessContextState | null;
  agentControl?: AgentControl;
  prepareStep?: RuntimePrepareStep;
  registerSteerHandler?: RuntimeRegisterSteerHandler;

  log: (line: string) => void;
  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string) => Promise<boolean>;
  updateTodos?: (todos: TodoItem[]) => void;

  /** Lightweight skill metadata for dynamic tool descriptions. */
  discoveredSkills?: Array<{ name: string; description: string }>;

  /** Sub-agent nesting depth (0 for root session turn). */
  spawnDepth?: number;
  agentRole?: AgentRole;
  shellPolicy?: AgentShellPolicy;
  yolo?: boolean;

  maxSteps?: number;
  enableMcp?: boolean;
  abortSignal?: AbortSignal;
  sessionId?: string;
  onModelStreamPart?: (part: unknown) => void | Promise<void>;
  onModelRawEvent?: (event: RuntimeModelRawEvent) => void | Promise<void>;
  onModelError?: (error: unknown) => void | Promise<void>;
  onModelAbort?: () => void | Promise<void>;
  includeRawChunks?: boolean;
  telemetryContext?: {
    functionId?: string;
    metadata?: Record<string, string | number | boolean | null | undefined>;
  };

  /** Session cost tracker instance, if available. */
  costTracker?: SessionCostTracker;

  /** Environment variables inherited by child processes launched from tools. */
  toolEnv?: Record<string, string | undefined>;

  /** Persist/emit session usage when a tool mutates budget thresholds mid-turn. */
  onSessionUsageBudgetUpdated?: (snapshot: SessionUsageSnapshot) => void;

  /**
   * Apply an A2UI v0.9 envelope to the session's surface state, returning a
   * per-envelope outcome. Plumbed into the `a2ui` tool's ToolContext when
   * provided. Only set when the harness enables generative UI for the turn.
   */
  applyA2uiEnvelope?: (
    envelope: unknown,
    meta?: { reason?: string; toolCallId?: string },
  ) => {
    ok: boolean;
    surfaceId?: string;
    change?: "created" | "updated" | "deleted" | "noop";
    error?: string;
    warning?: string;
  };
}

function mergeToolSets(
  builtInTools: Record<string, any>,
  mcpTools: Record<string, any>,
  log: (line: string) => void,
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

function mergePrepareStepOverrides(
  base: RuntimeStepOverride | undefined,
  next: RuntimeStepOverride | undefined,
): RuntimeStepOverride | undefined {
  if (!base) return next;
  if (!next) return base;

  const merged: RuntimeStepOverride = {
    ...base,
    ...next,
  };

  if (base.messages !== undefined || next.messages !== undefined) {
    merged.messages = next.messages ?? base.messages;
  }
  if (base.providerOptions || next.providerOptions) {
    merged.providerOptions = {
      ...(base.providerOptions ?? {}),
      ...(next.providerOptions ?? {}),
    };
  }
  if (base.streamOptions || next.streamOptions) {
    merged.streamOptions = {
      ...(base.streamOptions ?? {}),
      ...(next.streamOptions ?? {}),
    };
  }

  return merged;
}

function composePrepareSteps(
  first: RuntimePrepareStep | undefined,
  second: RuntimePrepareStep | undefined,
  onMessagesUpdated?: (messages: ModelMessage[]) => void,
): RuntimePrepareStep | undefined {
  if (!first && !second) return undefined;

  return async ({ stepNumber, messages }) => {
    let currentMessages = messages;
    onMessagesUpdated?.(currentMessages);

    let mergedOverride: RuntimeStepOverride | undefined;
    for (const prepareStep of [first, second]) {
      if (!prepareStep) continue;
      const override = await prepareStep({ stepNumber, messages: currentMessages });
      mergedOverride = mergePrepareStepOverrides(mergedOverride, override);
      if (override?.messages) {
        currentMessages = override.messages;
        onMessagesUpdated?.(currentMessages);
      }
    }

    return mergedOverride;
  };
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

function providerOwnsExecutableTools(config: AgentConfig): boolean {
  return config.provider === "codex-cli";
}

async function prepareTurnToolEnv(
  params: Pick<RunTurnParams, "config" | "toolEnv" | "log">,
): Promise<Record<string, string | undefined> | undefined> {
  return await prepareManagedSofficeToolEnv({
    homedir: resolveAuthHomeDir(params.config),
    env: params.toolEnv ?? { ...process.env },
    log: (line) => params.log?.(`[managed-soffice] ${line}`),
  });
}

function appendManagedSofficeInstructions(
  system: string,
  env: Record<string, string | undefined> | undefined,
): string {
  if (system.includes("## Managed LibreOffice Runtime")) return system;
  const instructions = renderManagedSofficeRuntimeInstructions(env);
  return instructions ? `${system}\n\n${instructions}` : system;
}

function appendRuntimeInstructions(
  system: string,
  env: Record<string, string | undefined> | undefined,
): string {
  let nextSystem = system;
  if (!nextSystem.includes("## Codex Workspace Dependencies")) {
    const codexRuntimeInstructions = renderCodexPrimaryRuntimeInstructions(env);
    if (codexRuntimeInstructions) {
      nextSystem = `${nextSystem}\n\n${codexRuntimeInstructions}`;
    }
  }
  return appendManagedSofficeInstructions(nextSystem, env);
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
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedPromptTokens?: number;
      cacheWritePromptTokens?: number;
      reasoningOutputTokens?: number;
      estimatedCostUsd?: number;
    };
    providerState?: ProviderContinuationState;
  }> {
    const {
      config,
      system,
      messages,
      log,
      askUser,
      approveCommand,
      updateTodos,
      discoveredSkills,
      abortSignal,
    } = params;
    let latestTurnMessages = messages;
    const turnToolEnv = await prepareTurnToolEnv(params);

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
      getTurnUserPrompt: () => extractTurnUserPrompt(latestTurnMessages),
      harnessContext: params.harnessContext,
      agentRole: params.agentRole,
      shellPolicy: params.shellPolicy ?? getAgentRoleShellPolicy(params.agentRole),
      agentControl: params.agentControl,
      costTracker: params.costTracker,
      toolEnv: turnToolEnv,
      onSessionUsageBudgetUpdated: params.onSessionUsageBudgetUpdated,
      applyA2uiEnvelope: params.applyA2uiEnvelope,
    };
    const useProviderNativeTools = providerOwnsExecutableTools(config);
    const rawBuiltInTools = deps.createTools(toolCtx);
    const builtInTools = useProviderNativeTools
      ? filterToolsForCodexDynamicBoundary(rawBuiltInTools)
      : rawBuiltInTools;

    let mcpTools: Record<string, any> = {};
    const enableMcp = params.enableMcp ?? config.enableMcp ?? false;
    let closeMcp: undefined | (() => Promise<void>);
    if (enableMcp) {
      if (params.sessionId) {
        const loaded = await getOrLoadMCPToolsCached(config, params.sessionId, {
          log,
          loadMCPServers: deps.loadMCPServers,
          loadMCPTools: deps.loadMCPTools,
        });
        mcpTools = loaded.tools;
      } else {
        const servers = await deps.loadMCPServers(config);
        if (servers.length > 0) {
          const loaded = await deps.loadMCPTools(servers, { log });
          mcpTools = loaded.tools;
          closeMcp = loaded.close;
        }
      }
    }

    const mergedTools = mergeToolSets(builtInTools, mcpTools, log);
    const tools = params.agentRole
      ? filterToolsForRole(mergedTools, getAgentRoleDefinition(params.agentRole))
      : mergedTools;
    const mcpToolNames = Object.keys(tools)
      .filter((name) => name.startsWith("mcp__"))
      .sort();
    const turnSystem = appendRuntimeInstructions(
      buildTurnSystemPrompt(system, config, mcpToolNames, params.harnessContext),
      turnToolEnv,
    );
    const turnProviderOptions = config.providerOptions;
    const googlePrepareStep =
      config.provider === "google" && Object.keys(tools).length > 0
        ? buildGooglePrepareStep(turnProviderOptions, log)
        : undefined;
    const prepareStep = composePrepareSteps(
      params.prepareStep,
      googlePrepareStep,
      (nextMessages) => {
        latestTurnMessages = nextMessages;
      },
    );

    const result = await (async (): Promise<{
      text: string;
      reasoningText?: string;
      responseMessages: ModelMessage[];
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedPromptTokens?: number;
        cacheWritePromptTokens?: number;
        reasoningOutputTokens?: number;
        estimatedCostUsd?: number;
      };
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
            ...(prepareStep ? { prepareStep } : {}),
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
            }
          })();

          const [text, reasoningText, response] = await Promise.all([
            Promise.resolve(streamResult.text),
            Promise.resolve(streamResult.reasoningText),
            Promise.resolve(streamResult.response),
          ]);

          if (params.onModelStreamPart) {
            // Wait for the stream consumption to fully drain rather than
            // guessing completion via micro-tick counting (which can fire
            // prematurely on a loaded event loop and silently drop output).
            const drainTimeout = new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), STREAM_DRAIN_TIMEOUT_MS),
            );

            const drainResult = await Promise.race([
              streamConsumption
                .then(() => "drained" as const)
                .catch((error) => ({ error }) as { error: unknown }),
              drainTimeout,
            ]);

            if (drainResult === "timeout") {
              log(
                `[warn] Model stream did not drain within ${STREAM_DRAIN_TIMEOUT_MS}ms after response completion; continuing turn.`,
              );
              void streamConsumption.catch((error) => {
                log(
                  `[warn] Model stream ended with error after response completion: ${String(error)}`,
                );
              });
            } else if (typeof drainResult === "object" && "error" in drainResult) {
              log(`[warn] Model stream ended with error: ${String(drainResult.error)}`);
            }
            // else: drained successfully, nothing to log
          }

          const parsedResponseMessages = responseMessagesSchema.safeParse(
            (response as any)?.messages,
          );
          const parsedReasoningText = stringSchema.safeParse(reasoningText);
          const parsedUsage = usageSchema.safeParse((response as any)?.usage);

          return {
            text: String(text ?? ""),
            reasoningText: parsedReasoningText.success ? parsedReasoningText.data : undefined,
            responseMessages: (parsedResponseMessages.success
              ? parsedResponseMessages.data
              : []) as ModelMessage[],
            usage: parsedUsage.success
              ? {
                  promptTokens: parsedUsage.data.promptTokens,
                  completionTokens: parsedUsage.data.completionTokens,
                  totalTokens: parsedUsage.data.totalTokens,
                  ...(typeof parsedUsage.data.cachedPromptTokens === "number"
                    ? { cachedPromptTokens: parsedUsage.data.cachedPromptTokens }
                    : {}),
                  ...(typeof parsedUsage.data.cacheWritePromptTokens === "number"
                    ? { cacheWritePromptTokens: parsedUsage.data.cacheWritePromptTokens }
                    : {}),
                  ...(typeof parsedUsage.data.reasoningOutputTokens === "number"
                    ? { reasoningOutputTokens: parsedUsage.data.reasoningOutputTokens }
                    : {}),
                  ...(typeof parsedUsage.data.estimatedCostUsd === "number"
                    ? { estimatedCostUsd: parsedUsage.data.estimatedCostUsd }
                    : {}),
                }
              : undefined,
          };
        }

        const runtime = deps.createRuntime(config);
        return await runtime.runTurn({
          config,
          system: turnSystem,
          messages,
          allMessages: params.allMessages,
          tools,
          maxSteps: params.maxSteps ?? 100,
          yolo: params.yolo,
          shellPolicy: params.shellPolicy ?? getAgentRoleShellPolicy(params.agentRole),
          providerOptions: turnProviderOptions,
          providerState: params.providerState,
          toolEnv: turnToolEnv,
          abortSignal,
          includeRawChunks: params.includeRawChunks ?? true,
          telemetry,
          ...(prepareStep ? { prepareStep } : {}),
          ...(params.registerSteerHandler
            ? { registerSteerHandler: params.registerSteerHandler }
            : {}),
          askUser,
          approveCommand,
          updateTodos,
          onModelStreamPart: params.onModelStreamPart,
          onModelRawEvent: params.onModelRawEvent,
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
  overrides: RunTurnOverrides = {},
): Promise<{
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    cacheWritePromptTokens?: number;
    reasoningOutputTokens?: number;
    estimatedCostUsd?: number;
  };
  providerState?: ProviderContinuationState;
}> {
  return await createRunTurn(overrides)(params);
}

/** @internal Test-only hooks — not part of the public API. */
export const __internal = {
  setStreamDrainTimeoutMs(ms: number) {
    STREAM_DRAIN_TIMEOUT_MS = ms;
  },
  resetStreamDrainTimeoutMs() {
    STREAM_DRAIN_TIMEOUT_MS = 30_000;
  },
};
