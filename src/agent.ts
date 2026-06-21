import path from "node:path";

import { z } from "zod";

import { resolveAdvancedMemoryWriteRoots } from "./advancedMemory/store";
import { getModel as realGetModel } from "./config";
import {
  COWORK_RUNTIME_INSTRUCTIONS_HEADING,
  prepareCoworkRuntimeToolEnv,
  renderCoworkRuntimeInstructions,
} from "./coworkRuntime";
import { getOrLoadMCPToolsCached, loadMCPServers, loadMCPTools } from "./mcp";
import { buildRuntimeTelemetrySettings } from "./observability/runtime";
import { policyAllowsNetwork, resolveSandboxPolicy } from "./platform/sandbox";
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
import { filterToolsForProfile, filterToolsForRole } from "./server/agents/toolPolicy";
import type { SessionCostTracker, SessionUsageSnapshot } from "./session/costTracker";
import type { AgentProfileSnapshot } from "./shared/agentProfiles";
import type { AgentRole } from "./shared/agents";
import type { ProviderContinuationState } from "./shared/providerContinuation";
import type {
  TaskContextSnapshot,
  TaskCreationInput,
  TaskCreationResult,
  TaskDirective,
  TaskDirectiveResult,
  TaskReviewMaterialReference,
} from "./shared/tasks";
import type { AgentControl } from "./tools";
import { createTools, filterToolsForCodexDynamicBoundary } from "./tools";
import { buildTurnSystemPrompt } from "./turnSystemPrompt";
import type {
  AgentConfig,
  ApproveCommandOptions,
  HarnessContextState,
  ModelMessage,
  ReferencedPluginContext,
  TodoItem,
} from "./types";
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
  taskContext?: TaskContextSnapshot | null;
  getTaskContext?: () => TaskContextSnapshot | null;
  getTaskReviewMaterial?: () => Promise<TaskReviewMaterialReference | null>;
  applyTaskDirective?: (directive: TaskDirective) => Promise<TaskDirectiveResult>;
  createTask?: (input: TaskCreationInput) => Promise<TaskCreationResult>;
  /** Plugins the user @-mentioned this turn; rendered as a soft-awareness system block. */
  referencedPlugins?: ReferencedPluginContext[];
  agentControl?: AgentControl;
  prepareStep?: RuntimePrepareStep;
  registerSteerHandler?: RuntimeRegisterSteerHandler;

  log: (line: string) => void;
  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string, opts?: ApproveCommandOptions) => Promise<boolean>;
  updateTodos?: (todos: TodoItem[]) => void;

  /** Lightweight skill metadata for dynamic tool descriptions. */
  discoveredSkills?: Array<{ name: string; description: string }>;

  /** Sub-agent nesting depth (0 for root session turn). */
  spawnDepth?: number;
  agentRole?: AgentRole;
  agentProfile?: AgentProfileSnapshot;
  agentTargetPaths?: readonly string[] | null;
  shellPolicy?: AgentShellPolicy;
  yolo?: boolean;

  maxSteps?: number;
  enableMcp?: boolean;
  abortSignal?: AbortSignal;
  sessionId?: string;
  onAdvancedMemoryChanged?: (folder: string) => void | Promise<void>;
  onModelStreamPart?: (part: unknown) => void | Promise<void>;
  onModelRawEvent?: (event: RuntimeModelRawEvent) => void | Promise<void>;
  onModelError?: (error: unknown) => void | Promise<void>;
  onModelAbort?: () => void | Promise<void>;
  /** Invoked when one or more MCP servers fail to load tools for this turn. */
  onMcpLoadErrors?: (errors: string[]) => void;
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

  /** Server-authoritative write gate for mutating tool side effects. */
  assertCanMutate?: (toolName: string) => void | Promise<void>;

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
    log(
      `[MCP warn] Tool name collision: "${name}" remapped to "${alias}" — reference it by the remapped name`,
    );
    merged[alias] = toolDef;
  }
  return merged;
}

function wrapToolSetWithMutationGate(
  tools: Record<string, any>,
  assertCanMutate: RunTurnParams["assertCanMutate"],
  abortSignal?: AbortSignal,
): Record<string, any> {
  if (!assertCanMutate) return tools;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      wrapToolWithMutationGate(name, tool, assertCanMutate, abortSignal),
    ]),
  );
}

function wrapToolWithMutationGate(
  name: string,
  tool: unknown,
  assertCanMutate: NonNullable<RunTurnParams["assertCanMutate"]>,
  abortSignal?: AbortSignal,
): unknown {
  if ((typeof tool !== "object" && typeof tool !== "function") || tool === null) return tool;
  const record = tool as Record<string, unknown>;
  if (typeof record.execute !== "function") return tool;
  const execute = record.execute as (...args: unknown[]) => unknown;
  return {
    ...record,
    execute: async (...args: unknown[]) => {
      await assertCanMutate(name);
      const input = args[0];
      const executionOptions =
        args.length > 1 && typeof args[1] === "object" && args[1] !== null
          ? { ...(args[1] as Record<string, unknown>), ...(abortSignal ? { abortSignal } : {}) }
          : abortSignal
            ? { abortSignal }
            : args[1];
      const result = await execute.call(
        tool,
        input,
        ...(executionOptions === undefined ? [] : [executionOptions]),
      );
      return result;
    },
  };
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
  const homedir = resolveAuthHomeDir(params.config);
  return await prepareCoworkRuntimeToolEnv({
    homedir,
    env: params.toolEnv ?? { ...process.env },
    log: (line) => params.log?.(`[cowork-runtime] ${line}`),
  });
}

function appendRuntimeInstructions(
  system: string,
  env: Record<string, string | undefined> | undefined,
): string {
  let nextSystem = system;
  if (!nextSystem.includes(COWORK_RUNTIME_INSTRUCTIONS_HEADING)) {
    const coworkRuntimeInstructions = renderCoworkRuntimeInstructions(env);
    if (coworkRuntimeInstructions) {
      nextSystem = `${nextSystem}\n\n${coworkRuntimeInstructions}`;
    }
  }
  return nextSystem;
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
    const shellPolicy = params.shellPolicy ?? getAgentRoleShellPolicy(params.agentRole);
    const turnSandboxPolicy = resolveSandboxPolicy({
      config: config.sandbox,
      // Honor an explicit `no_project_write` shell policy even without an
      // agentRole; otherwise this precomputed policy (preferred by the bash
      // tool over deriving from shellPolicy) would run mutating commands with
      // project write access despite the no-project-write shell policy.
      readOnlyRole:
        (params.agentRole ? getAgentRoleDefinition(params.agentRole).readOnly : false) ||
        shellPolicy === "no_project_write",
      workingDirectory: config.workingDirectory,
      projectRoot: path.dirname(config.projectCoworkDir),
      outputDirectory: config.outputDirectory,
      uploadsDirectory: config.uploadsDirectory,
      toolRuntimeWritableRoots: [...resolveAdvancedMemoryWriteRoots(config)],
      targetPaths: params.agentTargetPaths,
    });

    let taskPauseRequested = false;
    let taskModeSwitchRequested = false;
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
      taskContext: params.taskContext,
      getTaskContext: params.getTaskContext,
      getTaskReviewMaterial: params.getTaskReviewMaterial,
      applyTaskDirective: params.applyTaskDirective
        ? async (directive: TaskDirective) => {
            const directiveResult = await params.applyTaskDirective?.(directive);
            if (!directiveResult) throw new Error("Task directive handler is unavailable");
            if (directiveResult.continuation === "pause_for_input") taskPauseRequested = true;
            return directiveResult;
          }
        : undefined,
      createTask: params.createTask
        ? async (input: TaskCreationInput) => {
            const result = await params.createTask?.(input);
            if (!result) throw new Error("Task creation handler is unavailable");
            taskModeSwitchRequested = true;
            return result;
          }
        : undefined,
      agentRole: params.agentRole,
      agentProfile: params.agentProfile,
      agentTargetPaths: params.agentTargetPaths,
      sessionId: params.sessionId,
      shellPolicy,
      sandboxPolicy: turnSandboxPolicy,
      agentControl: params.agentControl,
      costTracker: params.costTracker,
      toolEnv: turnToolEnv,
      onSessionUsageBudgetUpdated: params.onSessionUsageBudgetUpdated,
      onAdvancedMemoryChanged: params.onAdvancedMemoryChanged,
      assertCanMutate: params.assertCanMutate,
      applyA2uiEnvelope: params.applyA2uiEnvelope,
    };
    const useProviderNativeTools = providerOwnsExecutableTools(config);
    const rawBuiltInTools = deps.createTools(toolCtx);
    const builtInTools = useProviderNativeTools
      ? filterToolsForCodexDynamicBoundary(rawBuiltInTools, {
          preserveScopedFileReadTools: (params.agentTargetPaths?.length ?? 0) > 0,
        })
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
        if (loaded.errors.length > 0) params.onMcpLoadErrors?.(loaded.errors);
      } else {
        const servers = await deps.loadMCPServers(config, { log });
        if (servers.length > 0) {
          const loaded = await deps.loadMCPTools(servers, { log });
          mcpTools = loaded.tools;
          closeMcp = loaded.close;
          if (loaded.errors.length > 0) params.onMcpLoadErrors?.(loaded.errors);
        }
      }
    }

    const mergedTools = mergeToolSets(builtInTools, mcpTools, log);
    const roleFilteredTools = params.agentRole
      ? filterToolsForRole(mergedTools, getAgentRoleDefinition(params.agentRole), {
          allowProfileMcp: !!params.agentProfile,
        })
      : mergedTools;
    const filteredTools = params.agentProfile
      ? filterToolsForProfile(roleFilteredTools, params.agentProfile)
      : roleFilteredTools;
    const tools = wrapToolSetWithMutationGate(filteredTools, params.assertCanMutate, abortSignal);
    const mcpToolNames = Object.keys(tools)
      .filter((name) => name.startsWith("mcp__"))
      .sort();
    const turnSystem = appendRuntimeInstructions(
      buildTurnSystemPrompt(
        system,
        config,
        mcpToolNames,
        params.harnessContext,
        params.referencedPlugins,
        params.taskContext,
      ),
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
          const stepLimitStop = legacyStepCountIs(params.maxSteps ?? 100);
          const streamTextInput: LegacyStreamTextInput = {
            model: legacyModelResolver(config),
            system: turnSystem,
            messages,
            tools,
            providerOptions: turnProviderOptions,
            ...(telemetry ? { experimental_telemetry: telemetry } : {}),
            stopWhen:
              params.applyTaskDirective || params.createTask
                ? [stepLimitStop, () => taskPauseRequested || taskModeSwitchRequested]
                : stepLimitStop,
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
          shellPolicy,
          networkAllowed: policyAllowsNetwork(turnSandboxPolicy),
          providerOptions: turnProviderOptions,
          providerState: params.providerState,
          toolEnv: turnToolEnv,
          abortSignal,
          includeRawChunks: params.includeRawChunks ?? true,
          telemetry,
          ...(prepareStep ? { prepareStep } : {}),
          shouldStopAfterToolStep: () => taskPauseRequested || taskModeSwitchRequested,
          ...(params.registerSteerHandler
            ? { registerSteerHandler: params.registerSteerHandler }
            : {}),
          agentTargetPaths: params.agentTargetPaths,
          askUser,
          approveCommand,
          updateTodos,
          assertCanMutate: params.assertCanMutate,
          onModelStreamPart: params.onModelStreamPart,
          onModelRawEvent: params.onModelRawEvent,
          onModelError: params.onModelError,
          onModelAbort: params.onModelAbort,
          log,
        });
      } finally {
        try {
          await closeMcp?.();
        } catch (err) {
          log(`[MCP] Error closing MCP connections: ${String(err)}`);
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
