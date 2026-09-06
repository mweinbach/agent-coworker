import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import { z } from "zod";

import { resolveAdvancedMemoryWriteRoots } from "./advancedMemory/store";
import {
  COWORK_RUNTIME_INSTRUCTIONS_HEADING,
  prepareCoworkRuntimeToolEnv,
  renderCoworkRuntimeInstructions,
} from "./coworkRuntime";
import { getOrLoadMCPToolsCached, loadMCPServers, loadMCPTools, withMCPTools } from "./mcp";
import { createDeferredMcpTools } from "./mcp/deferredTools";
import { WorkspaceMcpToolCache } from "./mcp/toolCache";
import { buildRuntimeTelemetrySettings } from "./observability/runtime";
import { policyAllowsNetwork, resolveSandboxPolicy } from "./platform/sandbox";
import { buildGooglePrepareStep } from "./providers/googleReplay";
import { createRuntime } from "./runtime";
import { createToolExposure } from "./runtime/toolExposure";
import type {
  RuntimeModelRawEvent,
  RuntimePrepareStep,
  RuntimeRegisterSteerHandler,
  RuntimeRunTurnResult,
  RuntimeStepOverride,
} from "./runtime/types";
import type { AgentShellPolicy } from "./server/agents/commandPolicy";
import { getAgentRoleDefinition, getAgentRoleShellPolicy } from "./server/agents/roles";
import { filterToolsForProfile, filterToolsForRole } from "./server/agents/toolPolicy";
import type { ThreadControl } from "./server/threads/types";
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
import type { WorkflowProgressPayload } from "./shared/workflows";
import type { SkillUsageRecord } from "./skillImprovement/types";
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
import { raceWithAbort } from "./utils/abortSignal";
import { resolveAuthHomeDir } from "./utils/authHome";

const TURN_MCP_CLEANUP_TIMEOUT_MS = 200;
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
  threadControl?: ThreadControl;
  allowThreadManagementTools?: boolean;
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
  onSkillUsed?: (usage: Omit<SkillUsageRecord, "turnId" | "usedAt">) => void | Promise<void>;
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

  /** Stream live progress from a running `workflow` tool call. */
  onWorkflowProgress?: (progress: WorkflowProgressPayload) => void;

  /** Server-authoritative write gate for mutating tool side effects. */
  assertCanMutate?: (toolName: string) => void | Promise<void>;
}

function wrapToolSetWithMutationGate(
  tools: Record<string, any>,
  assertCanMutate: RunTurnParams["assertCanMutate"],
  abortSignal?: AbortSignal,
  signalContext?: AsyncLocalStorage<AbortSignal>,
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      wrapToolWithMutationGate(name, tool, assertCanMutate, abortSignal, signalContext),
    ]),
  );
}

function wrapToolWithMutationGate(
  name: string,
  tool: unknown,
  assertCanMutate: RunTurnParams["assertCanMutate"],
  abortSignal?: AbortSignal,
  signalContext?: AsyncLocalStorage<AbortSignal>,
): unknown {
  if ((typeof tool !== "object" && typeof tool !== "function") || tool === null) return tool;
  const record = tool as Record<string, unknown>;
  if (typeof record.execute !== "function") return tool;
  const execute = record.execute as (...args: unknown[]) => unknown;
  return {
    ...record,
    execute: async (...args: unknown[]) => {
      const suppliedOptions =
        typeof args[1] === "object" && args[1] !== null
          ? (args[1] as Record<string, unknown>)
          : undefined;
      const callSignal =
        suppliedOptions?.abortSignal instanceof AbortSignal
          ? suppliedOptions.abortSignal
          : undefined;
      const signal =
        abortSignal && callSignal && abortSignal !== callSignal
          ? AbortSignal.any([abortSignal, callSignal])
          : (callSignal ?? abortSignal);
      await assertCanMutate?.(name);
      signal?.throwIfAborted();
      const input = args[0];
      const executionOptions =
        suppliedOptions || signal
          ? { ...suppliedOptions, ...(signal ? { abortSignal: signal } : {}) }
          : args[1];
      const invoke = () =>
        execute.call(tool, input, ...(executionOptions === undefined ? [] : [executionOptions]));
      return await (signal && signalContext ? signalContext.run(signal, invoke) : invoke());
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
    env: params.toolEnv,
    log: (line) => params.log?.(`[cowork-runtime] ${line}`),
  });
}

type TurnMcpLoad = {
  tools: Record<string, any>;
  errors: string[];
  withTools?: <T>(
    operation: (tools: Record<string, unknown>, errors: string[]) => Promise<T>,
  ) => Promise<T>;
  close?: () => Promise<void>;
};

async function cleanupTurnMcp(
  mcpLoadPromise: Promise<TurnMcpLoad>,
  params: Pick<RunTurnParams, "log" | "abortSignal">,
): Promise<void> {
  // Keep ownership of late-created connections and late cleanup failures even
  // when a connector ignores cancellation or never settles.
  const cleanup = mcpLoadPromise
    .then(async (loaded) => {
      await loaded.close?.();
    })
    .catch((error: unknown) => {
      params.log(`[MCP] Error closing MCP connections: ${String(error)}`);
    });
  if (params.abortSignal?.aborted) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceWithAbort(
      Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, TURN_MCP_CLEANUP_TIMEOUT_MS);
        }),
      ]),
      params.abortSignal,
    );
  } catch {
    // Cancellation stops waiting, not cleanup. Preserve the turn's result/error.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Loads this turn's MCP tools. Per-server failures degrade gracefully into
 * `errors`; loader failures themselves reject and abort the turn.
 */
async function loadTurnMcpTools(
  params: RunTurnParams,
  deps: RunTurnDeps,
  log: (line: string) => void,
): Promise<TurnMcpLoad> {
  const enableMcp = params.enableMcp ?? params.config.enableMcp ?? false;
  if (!enableMcp) return { tools: {}, errors: [] };

  const options = { log, loadMCPServers: deps.loadMCPServers, loadMCPTools: deps.loadMCPTools };
  if (params.sessionId) {
    const sessionId = params.sessionId;
    const loaded = await getOrLoadMCPToolsCached(params.config, sessionId, options);
    return {
      ...loaded,
      withTools: (operation) => withMCPTools(params.config, sessionId, operation, options),
    };
  }

  // CLI callers without a session still use a live catalog, owned by this turn.
  const cache = new WorkspaceMcpToolCache(deps);
  const loaded = await cache.load(params.config, "turn", options);
  return {
    ...loaded,
    withTools: (operation) => cache.withTools(params.config, "turn", operation, options),
    get close() {
      // An empty catalog needs no cleanup timer, but a server discovered later
      // in this turn (or still connecting at cancellation) must be released.
      return cache.hasResources() ? () => cache.closeSession("turn", log) : undefined;
    },
  };
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

export function createRunTurn(overrides: Partial<RunTurnDeps> = {}) {
  const deps: RunTurnDeps = {
    createRuntime,
    createTools,
    loadMCPServers,
    loadMCPTools,
    ...overrides,
  };

  return async function runTurn(params: RunTurnParams): Promise<RuntimeRunTurnResult> {
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
    if (abortSignal?.aborted) {
      throw new Error("Model turn aborted.");
    }
    let latestTurnMessages = messages;
    // Cold-start steps with no data dependencies between them — each reads
    // only `params`/`config`, and none mutates state another one reads
    // (`prepareCoworkRuntimeToolEnv` copies `process.env` rather than writing
    // it) — so they run concurrently to cut first-turn latency.
    const mcpLoadPromise = loadTurnMcpTools(params, deps, log);
    const startup = Promise.all([
      prepareTurnToolEnv(params),
      mcpLoadPromise,
      buildRuntimeTelemetrySettings(config, {
        functionId: params.telemetryContext?.functionId ?? "agent.runTurn",
        metadata: {
          ...(params.telemetryContext?.metadata ?? {}),
        },
      }),
    ]);
    const [turnToolEnv, mcpLoad, telemetry] = await raceWithAbort(startup, abortSignal).catch(
      async (error: unknown): Promise<never> => {
        await cleanupTurnMcp(mcpLoadPromise, params);
        throw error;
      },
    );
    const toolExecutionSignals = new AsyncLocalStorage<AbortSignal>();
    try {
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
        yolo: params.yolo,
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
        get abortSignal() {
          return toolExecutionSignals.getStore() ?? abortSignal;
        },
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
        yolo: params.yolo,
        agentControl: params.agentControl,
        threadControl: params.threadControl,
        allowThreadManagementTools: params.allowThreadManagementTools,
        costTracker: params.costTracker,
        toolEnv: turnToolEnv,
        onSessionUsageBudgetUpdated: params.onSessionUsageBudgetUpdated,
        onWorkflowProgress: params.onWorkflowProgress,
        onAdvancedMemoryChanged: params.onAdvancedMemoryChanged,
        onSkillUsed: params.onSkillUsed,
        assertCanMutate: params.assertCanMutate,
      };
      const useProviderNativeTools = providerOwnsExecutableTools(config);
      const rawBuiltInTools = deps.createTools(toolCtx);
      const builtInTools = useProviderNativeTools
        ? filterToolsForCodexDynamicBoundary(rawBuiltInTools, {
            preserveScopedFileReadTools: (params.agentTargetPaths?.length ?? 0) > 0,
          })
        : rawBuiltInTools;

      if (mcpLoad.errors.length > 0) params.onMcpLoadErrors?.(mcpLoad.errors);
      const filterTools = (available: Record<string, any>): Record<string, any> => {
        const roleTools = params.agentRole
          ? filterToolsForRole(available, getAgentRoleDefinition(params.agentRole), {
              allowProfileMcp: true,
            })
          : available;
        return params.agentProfile
          ? filterToolsForProfile(roleTools, params.agentProfile)
          : roleTools;
      };
      let tools = wrapToolSetWithMutationGate(
        filterTools(builtInTools),
        params.assertCanMutate,
        abortSignal,
        toolExecutionSignals,
      );
      const catalogBuiltInTools = { ...tools };
      const mcpEnabled =
        Boolean(mcpLoad.withTools) &&
        (!params.agentProfile || params.agentProfile.allowedMcpServers.length > 0);
      if (mcpEnabled && mcpLoad.withTools) {
        Object.assign(
          tools,
          createDeferredMcpTools({
            withTools: mcpLoad.withTools,
            filterTools,
            assertCanMutate: params.assertCanMutate,
            abortSignal,
          }),
        );
      }
      const exposure = createToolExposure({
        tools,
        config: config.toolCalling,
        withTools: async (operation) => {
          if (mcpEnabled && mcpLoad.withTools) {
            return await mcpLoad.withTools(async (catalog, errors) =>
              operation({ ...filterTools(catalog), ...catalogBuiltInTools }, errors),
            );
          }
          return await operation(catalogBuiltInTools, []);
        },
        assertCanMutate: params.assertCanMutate,
        abortSignal,
      });
      tools = exposure.tools;
      const baseTurnSystem = appendRuntimeInstructions(
        buildTurnSystemPrompt(
          system,
          config,
          mcpEnabled,
          params.harnessContext,
          params.referencedPlugins,
          params.taskContext,
        ),
        turnToolEnv,
      );
      const turnSystem = exposure.instructions
        ? `${baseTurnSystem}\n\n${exposure.instructions}`
        : baseTurnSystem;
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

      const runtime = deps.createRuntime(config);
      return await runtime.runTurn({
        config,
        sessionId: params.sessionId,
        system: turnSystem,
        authorizedToolNames: Object.keys(catalogBuiltInTools),
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
      toolExecutionSignals.disable();
      if (mcpLoad.close) await cleanupTurnMcp(mcpLoadPromise, params);
    }
  };
}

export const runTurn = createRunTurn();

export async function runTurnWithDeps(
  params: RunTurnParams,
  overrides: Partial<RunTurnDeps> = {},
): Promise<RuntimeRunTurnResult> {
  return await createRunTurn(overrides)(params);
}
