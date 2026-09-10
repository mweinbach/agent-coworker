import crypto from "node:crypto";

import { DelegateRunner } from "../../../src/server/agents/DelegateRunner";
import { routeAgentConfig } from "../../../src/server/agents/modelRouter";
import { inspectChildAgentReport } from "../../../src/server/agents/reportParser";
import { getAgentRoleDefinition } from "../../../src/server/agents/roles";
import { StatusBus } from "../../../src/server/agents/StatusBus";
import {
  type AgentInspectResult,
  type AgentReasoningEffort,
  type AgentRole,
  normalizeAgentTargetPaths,
  type PersistentAgentSummary,
  resolveAgentSpawnContextOptions,
} from "../../../src/shared/agents";
import { createTools, type ToolContext } from "../../../src/tools";
import type {
  AgentConfig,
  HarnessContextState,
  ModelMessage,
  ProviderName,
  TodoItem,
} from "../../../src/types";
import type { RunSpec } from "./rawLoopScenarios";
import { nowIso } from "./rawLoopUtils";

/** A single traced harness step: a tool call, its result, or a nested payload. */
export type TracedStep = {
  scope: string;
  step: unknown;
};

type RawLoopToolDefinition = {
  description?: unknown;
  inputSchema?: unknown;
  execute?: (input: never) => Promise<unknown> | unknown;
};

type PrerequisiteToolGuardConfig = {
  requiredToolName?: string;
  guardedToolNames?: string[];
};

function toolExecute(
  tool: RawLoopToolDefinition | undefined,
): ((input: unknown) => Promise<unknown> | unknown) | undefined {
  const execute = tool?.execute as ((input: unknown) => Promise<unknown> | unknown) | undefined;
  return typeof execute === "function" ? execute : undefined;
}

/** Wraps a tool so successful executions are recorded in the run trace. */
function observeTool(
  tool: RawLoopToolDefinition | undefined,
  onSuccess: (input: unknown, output: unknown) => void,
): RawLoopToolDefinition | undefined {
  const execute = toolExecute(tool);
  if (tool === undefined || execute === undefined) return tool;
  return {
    ...tool,
    execute: async (input: unknown) => {
      const output = await execute(input);
      onSuccess(input, output);
      return output;
    },
  };
}

/** Wraps a tool so calls are rejected while `shouldBlock()` is true. */
function gateTool(
  tool: RawLoopToolDefinition | undefined,
  shouldBlock: () => boolean,
  errorMessage: string,
): RawLoopToolDefinition | undefined {
  const execute = toolExecute(tool);
  if (tool === undefined || execute === undefined) return tool;
  return {
    ...tool,
    execute: async (input: unknown) => {
      if (shouldBlock()) {
        throw new Error(errorMessage);
      }
      return await execute(input);
    },
  };
}

function collectToolCallsFromUnknown(value: unknown, sink: string[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCallsFromUnknown(item, sink);
    }
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (record.type === "tool-call" && typeof record.toolName === "string") {
    sink.push(record.toolName);
  }

  for (const nested of Object.values(record)) {
    collectToolCallsFromUnknown(nested, sink);
  }
}

function collectTracedToolCallNames(steps: TracedStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    collectToolCallsFromUnknown(step.step, names);
  }
  return names;
}

function collectToolCallNamesFromToolLog(toolLogLines: string[]): string[] {
  const names: string[] = [];
  for (const line of toolLogLines) {
    const match = /^tool>\s+([a-zA-Z0-9_]+)/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

export function assertRawLoopToolRequirements(
  run: Pick<RunSpec, "requiredToolCalls">,
  steps: TracedStep[],
  toolLogLines: string[],
): void {
  const requiredToolCalls = run.requiredToolCalls;
  if (!Array.isArray(requiredToolCalls) || requiredToolCalls.length === 0) return;

  const tracedToolCalls = collectTracedToolCallNames(steps);
  const loggedToolCalls = collectToolCallNamesFromToolLog(toolLogLines);
  const missing = requiredToolCalls.filter((toolName) => {
    if (loggedToolCalls.includes(toolName)) return false;
    return !tracedToolCalls.includes(toolName);
  });
  if (missing.length > 0) {
    throw new Error(`Missing required tool call(s): ${missing.join(", ")}`);
  }
}

export function summarizeRawLoopBudgets(toolCallNames: string[]) {
  return {
    toolCalls: toolCallNames.length,
    bashCalls: toolCallNames.filter((name) => name === "bash").length,
    webCalls: toolCallNames.filter((name) => name === "webSearch" || name === "webFetch").length,
    spawnedAgents: toolCallNames.filter((name) => name === "spawnAgent").length,
  };
}

export function countObservedLoopSteps(stepNumbers: number[]): number {
  if (stepNumbers.length === 0) return 0;
  return Math.max(...stepNumbers);
}

export function buildRawLoopBudgetSummary(
  toolLogLines: string[],
  totalSteps: number,
  repairPassCount: number,
) {
  return {
    ...summarizeRawLoopBudgets(collectToolCallNamesFromToolLog(toolLogLines)),
    totalSteps,
    repairPassCount,
  };
}

function traceToolExecution(
  steps: TracedStep[],
  toolName: string,
  input: unknown,
  output: unknown,
): void {
  steps.push({ scope: "tool-call", step: { type: "tool-call", toolName, input } });
  steps.push({ scope: "tool-result", step: { type: "tool-result", toolName, output } });
}

/**
 * Builds the tool surface for a run: every tool is traced, and the optional
 * prerequisite guard refuses guarded tools until the prerequisite has been
 * called. Tracing is applied first so guarded calls still land in the trace.
 */
export function createToolsWithTracing(
  ctx: ToolContext,
  steps: TracedStep[],
  prerequisiteToolGuard?: PrerequisiteToolGuardConfig,
): Record<string, RawLoopToolDefinition> {
  const tools: Record<string, RawLoopToolDefinition | undefined> = {
    ...(createTools(ctx) as Record<string, RawLoopToolDefinition | undefined>),
  };

  for (const [toolName, toolDef] of Object.entries(tools)) {
    tools[toolName] = observeTool(toolDef, (input, output) =>
      traceToolExecution(steps, toolName, input, output),
    );
  }

  applyPrerequisiteToolGuard(tools, prerequisiteToolGuard);

  return Object.fromEntries(
    Object.entries(tools).filter((entry): entry is [string, RawLoopToolDefinition] =>
      Boolean(entry[1]),
    ),
  );
}

function applyPrerequisiteToolGuard(
  tools: Record<string, RawLoopToolDefinition | undefined>,
  guard: PrerequisiteToolGuardConfig | undefined,
): void {
  const requiredTool = guard?.requiredToolName;
  const guardedToolNames = guard?.guardedToolNames;
  if (
    requiredTool === undefined ||
    guardedToolNames === undefined ||
    guardedToolNames.length === 0
  ) {
    return;
  }

  let requiredToolCalled = false;
  const prerequisite = tools[requiredTool];
  if (prerequisite) {
    tools[requiredTool] = observeTool(prerequisite, () => {
      requiredToolCalled = true;
    });
  }

  for (const toolName of guardedToolNames) {
    if (toolName === requiredTool) continue;
    const guarded = tools[toolName];
    if (!guarded) continue;
    tools[toolName] = gateTool(
      guarded,
      () => requiredToolCalled === false,
      `Tool "${requiredTool}" must be called before "${toolName}".`,
    );
  }
}

type RawLoopAgentControlState = {
  summary: PersistentAgentSummary;
  role: AgentRole;
  requestedModel?: string;
  requestedReasoningEffort?: AgentReasoningEffort;
  routedConfig: AgentConfig;
  connectedProviders: readonly ProviderName[];
  historyMessages: ModelMessage[];
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
  abortController: AbortController | null;
  runPromise: Promise<void> | null;
  runToken: number;
  latestAssistantText: string | null;
};

type RawLoopAgentControlDeps = {
  createDelegateRunner?: () => Pick<DelegateRunner, "run">;
  makeId?: () => string;
  now?: () => string;
  getConnectedProviders?: () => Promise<readonly ProviderName[]>;
};

type RoutedAgentConfig = ReturnType<typeof routeAgentConfig>;
type ResolvedAgentSpawnContext = ReturnType<typeof resolveAgentSpawnContextOptions>;

type RawLoopChildStateArgs = {
  effectiveRole: AgentRole;
  connectedProviders: readonly ProviderName[];
  routed: RoutedAgentConfig;
  targetPaths: ReturnType<typeof normalizeAgentTargetPaths>;
  resolvedContext: ResolvedAgentSpawnContext;
  parentMessages: ModelMessage[] | undefined;
  getParentTodos: (() => TodoItem[]) | undefined;
  harnessContext: HarnessContextState | null | undefined;
  timestamp: string;
  agentId: string;
  spawnDepth: number | undefined;
};

function buildRawLoopSeedMessages(
  resolvedContext: ResolvedAgentSpawnContext,
  parentMessages: ModelMessage[] | undefined,
): ModelMessage[] {
  if (resolvedContext.contextMode === "full" && parentMessages !== undefined) {
    return structuredClone(parentMessages);
  }
  if (resolvedContext.contextMode === "brief") {
    return [{ role: "user", content: `Parent briefing:\n${resolvedContext.briefing}` }];
  }
  return [];
}

function buildRawLoopChildHarnessContext(
  resolvedContext: ResolvedAgentSpawnContext,
  harnessContext: HarnessContextState | null | undefined,
): HarnessContextState | null {
  const wantsHarnessContext =
    resolvedContext.contextMode === "full" || resolvedContext.includeHarnessContext;
  if (wantsHarnessContext && harnessContext !== undefined && harnessContext !== null) {
    return structuredClone(harnessContext);
  }
  return null;
}

function buildRawLoopAgentSummary(args: RawLoopChildStateArgs): PersistentAgentSummary {
  return {
    agentId: args.agentId,
    parentSessionId: "raw-loop",
    role: args.effectiveRole,
    mode: "delegate",
    depth: (args.spawnDepth ?? 0) + 1,
    ...(args.targetPaths !== undefined ? { targetPaths: args.targetPaths } : {}),
    ...(args.routed.requestedModel ? { requestedModel: args.routed.requestedModel } : {}),
    effectiveModel: args.routed.effectiveModel,
    ...(args.routed.requestedReasoningEffort
      ? { requestedReasoningEffort: args.routed.requestedReasoningEffort }
      : {}),
    ...(args.routed.effectiveReasoningEffort
      ? { effectiveReasoningEffort: args.routed.effectiveReasoningEffort }
      : {}),
    provider: args.routed.config.provider,
    title: `Raw ${args.effectiveRole} agent`,
    createdAt: args.timestamp,
    updatedAt: args.timestamp,
    lifecycleState: "active",
    executionState: "pending_init",
    busy: false,
  };
}

function buildRawLoopChildState(args: RawLoopChildStateArgs): RawLoopAgentControlState {
  const seededTodos =
    args.resolvedContext.includeParentTodos && args.getParentTodos !== undefined
      ? structuredClone(args.getParentTodos())
      : [];
  return {
    routedConfig: args.routed.config,
    summary: buildRawLoopAgentSummary(args),
    role: args.effectiveRole,
    requestedModel: args.routed.requestedModel,
    requestedReasoningEffort: args.routed.requestedReasoningEffort,
    connectedProviders: args.connectedProviders,
    historyMessages: buildRawLoopSeedMessages(args.resolvedContext, args.parentMessages),
    todos: seededTodos,
    harnessContext: buildRawLoopChildHarnessContext(args.resolvedContext, args.harnessContext),
    abortController: null,
    runPromise: null,
    runToken: 0,
    latestAssistantText: null,
  };
}

/**
 * In-process `agentControl` for raw-loop runs. The product's `AgentControl`
 * needs session bindings, a session DB, and a session factory, so the harness
 * keeps a minimal implementation that owns just the child agent summaries.
 */
export function createRawLoopAgentControl(
  opts: Pick<
    ToolContext,
    | "config"
    | "log"
    | "askUser"
    | "approveCommand"
    | "availableSkills"
    | "spawnDepth"
    | "abortSignal"
  > & {
    parentMessages?: ModelMessage[];
    getParentTodos?: () => TodoItem[];
    harnessContext?: HarnessContextState | null;
  },
  deps: RawLoopAgentControlDeps = {},
): NonNullable<ToolContext["agentControl"]> {
  const statusBus = new StatusBus();
  const delegateRunner = deps.createDelegateRunner?.() ?? new DelegateRunner();
  const makeId = deps.makeId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => nowIso());
  const getConnectedProviders = deps.getConnectedProviders ?? (async () => [opts.config.provider]);
  const states = new Map<string, RawLoopAgentControlState>();

  const publish = (
    state: RawLoopAgentControlState,
    patch: Partial<PersistentAgentSummary>,
  ): PersistentAgentSummary => {
    state.summary = { ...state.summary, ...patch, updatedAt: now() };
    statusBus.publish(state.summary);
    return state.summary;
  };

  const getState = (agentId: string): RawLoopAgentControlState => {
    const state = states.get(agentId);
    if (!state) {
      throw new Error(`Unknown child agent: ${agentId}`);
    }
    return state;
  };

  const startRun = (state: RawLoopAgentControlState, message: string): void => {
    state.runToken += 1;
    const runToken = state.runToken;
    const controller = new AbortController();
    const priorMessages = structuredClone(state.historyMessages);
    state.historyMessages.push({ role: "user", content: message });
    state.abortController = controller;
    publish(state, { lifecycleState: "active", executionState: "running", busy: true });

    const run = delegateRunner
      .run({
        config: state.routedConfig,
        role: state.role,
        message,
        spawnDepth: opts.spawnDepth,
        log: opts.log,
        askUser: opts.askUser,
        approveCommand: opts.approveCommand,
        abortSignal: controller.signal,
        discoveredSkills: opts.availableSkills,
        ...(priorMessages.length > 0 ? { seedMessages: priorMessages } : {}),
        ...(state.todos.length > 0 ? { initialTodos: structuredClone(state.todos) } : {}),
        ...(state.harnessContext ? { harnessContext: state.harnessContext } : {}),
        ...(state.summary.targetPaths ? { targetPaths: state.summary.targetPaths } : {}),
        updateTodos: (todos) => {
          state.todos = structuredClone(todos);
        },
        ...(state.requestedModel ? { model: state.requestedModel } : {}),
        ...(state.requestedReasoningEffort
          ? { reasoningEffort: state.requestedReasoningEffort }
          : {}),
        ...(state.connectedProviders.length > 0
          ? { connectedProviders: state.connectedProviders }
          : {}),
      })
      .then((result) => {
        if (
          state.runToken !== runToken ||
          state.abortController !== controller ||
          state.summary.lifecycleState === "closed"
        ) {
          return;
        }
        state.historyMessages.push(...structuredClone(result.responseMessages));
        const trimmed = result.text.trim();
        state.latestAssistantText = trimmed || null;
        publish(state, {
          executionState: "completed",
          busy: false,
          ...(trimmed ? { lastMessagePreview: trimmed } : {}),
        });
      })
      .catch((err) => {
        if (
          state.runToken !== runToken ||
          state.abortController !== controller ||
          state.summary.lifecycleState === "closed"
        ) {
          return;
        }
        state.latestAssistantText = controller.signal.aborted ? null : String(err);
        publish(state, {
          executionState: controller.signal.aborted ? "closed" : "errored",
          busy: false,
          ...(controller.signal.aborted ? {} : { lastMessagePreview: String(err) }),
        });
      })
      .finally(() => {
        if (state.runToken === runToken && state.abortController === controller) {
          state.abortController = null;
          state.runPromise = null;
        }
      });

    state.runPromise = run;
  };

  const reopenClosed = (state: RawLoopAgentControlState): void => {
    if (state.summary.lifecycleState !== "closed") return;
    publish(state, {
      lifecycleState: "active",
      ...(state.summary.executionState === "closed" ? { executionState: "completed" } : {}),
    });
  };

  return {
    spawn: async (spawnOpts) => {
      const { message, role, model, reasoningEffort } = spawnOpts;
      const effectiveRole = role ?? "default";
      const resolvedContext = resolveAgentSpawnContextOptions(spawnOpts);
      const targetPaths = normalizeAgentTargetPaths(spawnOpts.targetPaths);
      const connectedProviders = await getConnectedProviders();
      const routed = routeAgentConfig(opts.config, {
        role: getAgentRoleDefinition(effectiveRole),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        connectedProviders,
      });
      const state = buildRawLoopChildState({
        effectiveRole,
        connectedProviders,
        routed,
        targetPaths,
        resolvedContext,
        parentMessages: opts.parentMessages,
        getParentTodos: opts.getParentTodos,
        harnessContext: opts.harnessContext,
        timestamp: now(),
        agentId: makeId(),
        spawnDepth: opts.spawnDepth,
      });
      states.set(state.summary.agentId, state);
      statusBus.publish(state.summary);
      startRun(state, message);
      return state.summary;
    },
    list: async () =>
      [...states.values()]
        .map((state) => state.summary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    sendInput: async ({ agentId, message, interrupt }) => {
      const state = getState(agentId);
      reopenClosed(state);
      if (state.summary.busy) {
        if (!interrupt) {
          throw new Error(`Child agent ${agentId} is busy`);
        }
        state.runToken += 1;
        state.abortController?.abort();
        await state.runPromise;
      }
      startRun(state, message);
    },
    wait: async ({ agentIds, timeoutMs, mode, includeFinalMessage, includeReport }) => {
      for (const agentId of agentIds) {
        getState(agentId);
      }
      const result = await statusBus.wait(agentIds, timeoutMs, mode);
      if (includeFinalMessage !== true && includeReport !== true) {
        return result;
      }
      return {
        ...result,
        inspections: result.agents.map((agent) => {
          const state = getState(agent.agentId);
          const inspection = {
            agentId: agent.agentId,
            ...(includeFinalMessage ? { latestAssistantText: state.latestAssistantText } : {}),
          };
          if (!includeReport) return inspection;
          const reportInspection = inspectChildAgentReport(state.latestAssistantText);
          return {
            ...inspection,
            parsedReport: reportInspection.parsedReport,
            reportRequired: reportInspection.reportRequired,
            reportFound: reportInspection.reportFound,
            reportValid: reportInspection.reportValid,
            reportBlockCount: reportInspection.reportBlockCount,
            reportDiagnostic: reportInspection.reportDiagnostic,
          };
        }),
      };
    },
    inspect: async ({ agentId }): Promise<AgentInspectResult> => {
      const state = getState(agentId);
      const reportInspection = inspectChildAgentReport(state.latestAssistantText);
      return {
        agent: state.summary,
        latestAssistantText: state.latestAssistantText,
        parsedReport: reportInspection.parsedReport,
        reportRequired: reportInspection.reportRequired,
        reportFound: reportInspection.reportFound,
        reportValid: reportInspection.reportValid,
        reportBlockCount: reportInspection.reportBlockCount,
        reportDiagnostic: reportInspection.reportDiagnostic,
        sessionUsage: null,
        lastTurnUsage: null,
      };
    },
    resume: async ({ agentId }) => {
      const state = getState(agentId);
      reopenClosed(state);
      return state.summary;
    },
    close: async ({ agentId }) => {
      const state = getState(agentId);
      state.runToken += 1;
      state.abortController?.abort();
      await state.runPromise;
      return publish(state, {
        lifecycleState: "closed",
        executionState: "closed",
        busy: false,
      });
    },
  };
}
