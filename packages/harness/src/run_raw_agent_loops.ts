#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

import { z } from "zod";
import { runTurnWithDeps } from "../../../src/agent";
import { loadConfig } from "../../../src/config";
import { getAiCoworkerPaths } from "../../../src/connect";
import { emitObservabilityEvent } from "../../../src/observability/otel";
import { getObservabilityHealth } from "../../../src/observability/runtime";
import { commands as createHarnessPlatformCommands } from "../../../src/platform/shell";
import { loadSystemPromptWithSkills } from "../../../src/prompt";
import { DEFAULT_PROVIDER_OPTIONS } from "../../../src/providers";
import { getProviderCatalog } from "../../../src/providers/connectionCatalog";
import { DelegateRunner } from "../../../src/server/agents/DelegateRunner";
import { routeAgentConfig } from "../../../src/server/agents/modelRouter";
import { inspectChildAgentReport } from "../../../src/server/agents/reportParser";
import { getAgentRoleDefinition } from "../../../src/server/agents/roles";
import { StatusBus } from "../../../src/server/agents/StatusBus";
import { normalizeHarnessContextPayload } from "../../../src/sessionContext/HarnessContextStore";
import {
  type AgentInspectResult,
  type AgentReasoningEffort,
  type AgentRole,
  normalizeAgentTargetPaths,
  type PersistentAgentSummary,
  resolveAgentSpawnContextOptions,
} from "../../../src/shared/agents";
import { ensureDefaultGlobalSkillsReady } from "../../../src/skills/defaultGlobalSkills";
import { createTools, type ToolContext } from "../../../src/tools";
import { maskApiKey } from "../../../src/tools/api-keys";
import type {
  AgentConfig,
  HarnessContextPayload,
  HarnessContextState,
  ModelMessage,
  ProviderName,
  TodoItem,
} from "../../../src/types";
import { isProviderName } from "../../../src/types";
import { isRecord as isPlainObject } from "../../../src/utils/typeGuards";
import {
  nowIso,
  safeJsonStringify,
  safePathComponent,
  safeStamp,
  serializeRawLoopTrace,
} from "./rawLoopUtils";
import {
  buildPathArtifactAssertions,
  type FinalContract,
  type FinalContractValidationResult,
  validateWithOptionalRepair,
} from "./rawLoopValidation";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

type AskEvent = {
  at: string;
  question: string;
  options?: string[];
  answer: string;
};

type ApprovalEvent = {
  at: string;
  command: string;
  approved: boolean;
};

type TodoEvent = {
  at: string;
  todos: TodoItem[];
};

type TracedStep = {
  scope: string;
  step: unknown;
};

type JsonRecord = Record<string, unknown>;

type RawLoopToolDefinition = {
  description?: unknown;
  inputSchema?: unknown;
  execute?: (input: never) => Promise<unknown> | unknown;
};

const SCENARIO_DEFINITIONS = {
  mixed: { runRootPrefix: "raw-agent-loop_mixed", build: () => buildMixedRuns() },
  "dcf-model-matrix": {
    runRootPrefix: "raw-agent-loop_dcf-model-matrix",
    build: () => buildDcfModelMatrixRuns(),
  },
  "gpt-skill-reliability": {
    runRootPrefix: "raw-agent-loop_gpt-skill-reliability",
    build: () => buildGptSkillReliabilityRuns(),
  },
  "google-customtools-tool-coverage": {
    runRootPrefix: "raw-agent-loop_google-customtools-tool-coverage",
    build: () => buildGoogleCustomtoolsToolCoverageRuns(),
  },
  "codex-gpt-5.4-smoke": {
    runRootPrefix: "raw-agent-loop_codex-gpt-5.4-smoke",
    build: () => buildCodexHarnessSmokeRuns(),
  },
} as const;

type Scenario = keyof typeof SCENARIO_DEFINITIONS;

function isScenario(value: string): value is Scenario {
  return Object.hasOwn(SCENARIO_DEFINITIONS, value);
}

type ArtifactEntry = {
  path: string; // path relative to run dir
  bytes: number;
  sha256: string;
  mtimeMs: number;
};

type AttemptMeta = {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
  retryDelayMs?: number;
};

type RawLoopArgs = {
  strictModeOverride: boolean | null;
  scenario: Scenario;
  onlyRunIds: string[];
  onlyModels: string[];
};

function parseArgs(argv: string[]): RawLoopArgs {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: {
        "strict-mode": { type: "boolean" },
        "no-strict-mode": { type: "boolean" },
        scenario: { type: "string" },
        "only-run": { type: "string", multiple: true },
        "only-model": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values as {
    "strict-mode"?: boolean;
    "no-strict-mode"?: boolean;
    scenario?: string;
    "only-run"?: string[];
    "only-model"?: string[];
    help?: boolean;
  };
  if (values.help === true) {
    console.log(
      `Usage: bun run harness:run -- [--strict-mode|--no-strict-mode] [--scenario ${Object.keys(SCENARIO_DEFINITIONS).join("|")}] [--only-run <run-id>] [--only-model <model>]`,
    );
    process.exit(0);
  }

  const scenario = values.scenario ?? "mixed";
  if (isScenario(scenario) === false) {
    throw new Error(`Invalid --scenario value: ${scenario}`);
  }
  if (values["strict-mode"] === true && values["no-strict-mode"] === true) {
    throw new Error("Use either --strict-mode or --no-strict-mode, not both.");
  }

  return {
    strictModeOverride:
      values["strict-mode"] === true ? true : values["no-strict-mode"] === true ? false : null,
    scenario,
    onlyRunIds: values["only-run"] ?? [],
    onlyModels: values["only-model"] ?? [],
  };
}
export function resolveRawLoopHarnessConfig(
  baseHarness: AgentConfig["harness"] | undefined,
  cliArgs: Pick<RawLoopArgs, "strictModeOverride">,
): NonNullable<AgentConfig["harness"]> {
  return {
    reportOnly: baseHarness?.reportOnly ?? true,
    strictMode: cliArgs.strictModeOverride ?? baseHarness?.strictMode ?? false,
  };
}

type RunTrace = {
  runId: string;
  startedAt: string;
  finishedAt: string;

  config: AgentConfig;
  system: string;
  userPrompt: string;
  inputMessages: ModelMessage[];
  harnessContext: HarnessContextState | null;

  toolLogLines: string[];
  askEvents: AskEvent[];
  approvalEvents: ApprovalEvent[];
  todoEvents: TodoEvent[];

  steps: TracedStep[];

  result: {
    text: string;
    reasoningText?: string;
    responseMessages: unknown[];
    error?: string;
  };
};

type RunTraceBase = Pick<
  RunTrace,
  "runId" | "startedAt" | "config" | "system" | "userPrompt" | "inputMessages" | "harnessContext"
>;

type RunTraceAttemptFields = Pick<
  RunTrace,
  "toolLogLines" | "askEvents" | "approvalEvents" | "todoEvents" | "steps"
>;

function buildRunTrace(
  base: RunTraceBase,
  fields: RunTraceAttemptFields,
  result: RunTrace["result"],
  finishedAt = nowIso(),
): RunTrace {
  return { ...base, ...fields, finishedAt, result };
}

type PromptContext = {
  runId: string;
  runDir: string;
  repoDir: string;
};

type RunSpec = {
  id: string;
  provider: ProviderName;
  model: string; // may be an alias; resolved per provider
  maxSteps?: number;
  maxAttempts?: number;
  minIntervalMs?: number;
  providerOptionsOverride?: JsonRecord;
  requiredToolCalls?: string[];
  requiredFirstNonTodoToolCall?: string;
  requiredSkillBeforeTools?: string;
  guardedToolsBeforeSkill?: string[];
  requiredToolBeforeTools?: string;
  guardedToolsBeforeRequiredTool?: string[];
  harnessContext?: (ctx: PromptContext) => HarnessContextPayload;
  finalContract?: FinalContract;
  prompt: (ctx: PromptContext) => string;
};

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

function defaultHarnessContextForRun(
  run: Pick<RunSpec, "id" | "provider" | "model">,
  scenario: RawLoopArgs["scenario"],
): HarnessContextPayload {
  return {
    runId: run.id,
    objective: `Complete raw-loop harness scenario ${run.id} successfully.`,
    acceptanceCriteria: [
      "Satisfy the task requirements expressed in the run prompt.",
      "Produce the required final response contract for this scenario.",
      "Keep required artifacts inside the run directory.",
    ],
    constraints: [
      "Treat this harness context as run intent, not as a safety override.",
      "Do not change required artifact names or output formats unless the prompt requires it.",
      "Use only the necessary tools to complete the scenario.",
    ],
    metadata: {
      provider: run.provider,
      model: run.model,
      scenario,
    },
  };
}

export function applyRawLoopToolSurfaceConfig(config: AgentConfig, provider: ProviderName): void {
  if (provider === "google") {
    // The raw-loop scenarios call the local webSearch/webFetch tools directly,
    // so keep the provider-native web search path from replacing that surface.
    config.providerOptions = deepMergeRecords(cloneRecord(config.providerOptions as JsonRecord), {
      google: { nativeWebSearch: false },
    }) as AgentConfig["providerOptions"];
  }
  // Raw-loop tool coverage expects the local memory/todo surface regardless of
  // the user config that happens to be active on the harness machine.
  config.enableMemory = true;
  config.advancedMemory = false;
  config.tasksEnabled = false;
  config.workflowsEnabled = false;
}

export function buildRawLoopHarnessContext(
  run: Pick<RunSpec, "id" | "provider" | "model"> & {
    harnessContext?: (ctx: PromptContext) => HarnessContextPayload;
  },
  scenario: RawLoopArgs["scenario"],
  promptContext: PromptContext,
  updatedAt = nowIso(),
): HarnessContextState {
  return normalizeHarnessContextPayload(
    run.harnessContext?.(promptContext) ?? defaultHarnessContextForRun(run, scenario),
    updatedAt,
  );
}

const endSentinelSchema = z.literal("<<END_RUN>>");
const absolutePathSchema = z.string().trim().min(1);
const boolSchema = z.boolean();

function buildJsonFileContract(
  fields: Record<string, z.ZodTypeAny>,
  artifactAssertions: ReturnType<typeof buildPathArtifactAssertions> = [],
): FinalContract {
  return {
    format: "json",
    schema: z
      .object({
        ...fields,
        end: endSentinelSchema,
      })
      .strict(),
    artifactAssertions,
  };
}

function artifactAssertionsForPaths(
  entries: Array<{ field: string; ext: string }>,
): ReturnType<typeof buildPathArtifactAssertions> {
  return entries.flatMap(({ field, ext }) => buildPathArtifactAssertions(field, ext));
}

type SkillGuardConfig = {
  requiredSkillName?: string;
  guardedToolNames?: string[];
};

type PrerequisiteToolGuardConfig = {
  requiredToolName?: string;
  guardedToolNames?: string[];
};

function collectToolCallsFromUnknown(value: unknown, sink: string[]) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCallsFromUnknown(item, sink);
    }
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const isToolCall = record.type === "tool-call" && typeof record.toolName === "string";
  if (isToolCall) sink.push(record.toolName as string);

  for (const v of Object.values(record)) {
    collectToolCallsFromUnknown(v, sink);
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
    if (!match?.[1]) continue;
    names.push(match[1]);
  }
  return names;
}

export function assertRawLoopToolRequirements(
  run: Pick<RunSpec, "requiredToolCalls" | "requiredFirstNonTodoToolCall">,
  steps: TracedStep[],
  toolLogLines: string[],
): void {
  const requiredToolCalls = run.requiredToolCalls;
  const hasRequiredTools = Array.isArray(requiredToolCalls) && requiredToolCalls.length > 0;
  if (!hasRequiredTools && !run.requiredFirstNonTodoToolCall) return;

  const tracedToolCalls = collectTracedToolCallNames(steps);
  const loggedToolCalls = collectToolCallNamesFromToolLog(toolLogLines);
  if (hasRequiredTools) {
    const missing = requiredToolCalls.filter((toolName) => {
      if (loggedToolCalls.includes(toolName)) return false;
      return !tracedToolCalls.includes(toolName);
    });
    if (missing.length > 0) {
      throw new Error(`Missing required tool call(s): ${missing.join(", ")}`);
    }
  }

  if (run.requiredFirstNonTodoToolCall) {
    const observedToolCalls = loggedToolCalls.length > 0 ? loggedToolCalls : tracedToolCalls;
    const first = observedToolCalls.find((name) => name !== "todoWrite") ?? "";
    if (first !== run.requiredFirstNonTodoToolCall) {
      throw new Error(
        `First non-todo tool call must be "${run.requiredFirstNonTodoToolCall}", got "${first || "none"}".`,
      );
    }
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

export function countObservedLoopSteps(stepNumbers: number[]) {
  if (stepNumbers.length === 0) return 0;
  return Math.max(...stepNumbers);
}

export function buildRawLoopBudgetSummary(
  toolLogLines: string[],
  totalSteps: number,
  repairPassCount: number,
) {
  const toolCallNames = collectToolCallNamesFromToolLog(toolLogLines);
  return {
    ...summarizeRawLoopBudgets(toolCallNames),
    totalSteps,
    repairPassCount,
  };
}

function traceToolExecution(
  steps: TracedStep[],
  toolName: string,
  input: unknown,
  output: unknown,
) {
  steps.push({
    scope: "tool-call",
    step: {
      type: "tool-call",
      toolName,
      input,
    },
  });
  steps.push({
    scope: "tool-result",
    step: {
      type: "tool-result",
      toolName,
      output,
    },
  });
}

function withExecuteGuard(
  original: RawLoopToolDefinition | undefined,
  shouldBlock: () => boolean,
  errorMessage: string,
  onSuccess?: (input: unknown, output: unknown) => void,
): RawLoopToolDefinition | undefined {
  const executeOriginal = original?.execute as
    | ((input: unknown) => Promise<unknown> | unknown)
    | undefined;
  if (original === undefined || typeof executeOriginal !== "function") {
    return original;
  }
  return {
    ...original,
    execute: async (input: unknown) => {
      if (shouldBlock()) {
        throw new Error(errorMessage);
      }
      const out = await executeOriginal(input);
      onSuccess?.(input, out);
      return out;
    },
  };
}

type RoutedAgentConfig = ReturnType<typeof routeAgentConfig>;
type ResolvedAgentSpawnContext = ReturnType<typeof resolveAgentSpawnContextOptions>;

type RawLoopChildStateArgs = {
  spawnOpts: Parameters<NonNullable<ToolContext["agentControl"]>["spawn"]>[0];
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
    state.summary = {
      ...state.summary,
      ...patch,
      updatedAt: now(),
    };
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
    publish(state, {
      lifecycleState: "active",
      executionState: "running",
      busy: true,
    });

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
        spawnOpts,
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

function applySkillGuard(
  wrapped: Record<string, RawLoopToolDefinition | undefined>,
  skillGuard: SkillGuardConfig | undefined,
): void {
  const required = skillGuard?.requiredSkillName;
  const guardedToolNames = skillGuard?.guardedToolNames;
  if (required === undefined || guardedToolNames === undefined || guardedToolNames.length === 0) {
    return;
  }

  let requiredSkillLoaded = false;
  const guarded = new Set(guardedToolNames);
  const skillTool = withExecuteGuard(
    wrapped.skill,
    () => false,
    "",
    (input) => {
      if (
        isPlainObject(input) &&
        typeof input.skillName === "string" &&
        input.skillName === required
      ) {
        requiredSkillLoaded = true;
      }
    },
  );
  if (skillTool) wrapped.skill = skillTool;

  for (const toolName of guarded) {
    if (toolName === "skill") continue;
    const guardedTool = withExecuteGuard(
      wrapped[toolName],
      () => requiredSkillLoaded === false,
      `Required skill "${required}" must be loaded via the skill tool before calling "${toolName}".`,
    );
    if (guardedTool) wrapped[toolName] = guardedTool;
  }
}

function applyPrerequisiteToolGuard(
  wrapped: Record<string, RawLoopToolDefinition | undefined>,
  prerequisiteToolGuard: PrerequisiteToolGuardConfig | undefined,
): void {
  const requiredTool = prerequisiteToolGuard?.requiredToolName;
  const guardedToolNames = prerequisiteToolGuard?.guardedToolNames;
  if (
    requiredTool === undefined ||
    guardedToolNames === undefined ||
    guardedToolNames.length === 0
  ) {
    return;
  }

  let requiredToolCalled = false;
  const guardedTools = new Set(guardedToolNames);
  const prerequisiteTool = withExecuteGuard(
    wrapped[requiredTool],
    () => false,
    "",
    () => {
      requiredToolCalled = true;
    },
  );
  if (prerequisiteTool) wrapped[requiredTool] = prerequisiteTool;

  for (const toolName of guardedTools) {
    if (toolName === requiredTool) continue;
    const guardedTool = withExecuteGuard(
      wrapped[toolName],
      () => requiredToolCalled === false,
      `Tool "${requiredTool}" must be called before "${toolName}".`,
    );
    if (guardedTool) wrapped[toolName] = guardedTool;
  }
}

export function createToolsWithTracing(
  ctx: ToolContext,
  steps: TracedStep[],
  skillGuard?: SkillGuardConfig,
  prerequisiteToolGuard?: PrerequisiteToolGuardConfig,
): Record<string, RawLoopToolDefinition> {
  const baseTools = createTools(ctx) as Record<string, RawLoopToolDefinition | undefined>;

  const wrapped: Record<string, RawLoopToolDefinition | undefined> = { ...baseTools };

  for (const [toolName, toolDef] of Object.entries(wrapped)) {
    const guardedTool = withExecuteGuard(
      toolDef,
      () => false,
      "",
      (input, output) => {
        traceToolExecution(steps, toolName, input, output);
      },
    );
    if (guardedTool) wrapped[toolName] = guardedTool;
  }

  applySkillGuard(wrapped, skillGuard);
  applyPrerequisiteToolGuard(wrapped, prerequisiteToolGuard);

  return Object.fromEntries(
    Object.entries(wrapped).filter((entry): entry is [string, RawLoopToolDefinition] =>
      Boolean(entry[1]),
    ),
  );
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function writeTraceFile(filePath: string, trace: RunTrace) {
  await fs.writeFile(filePath, serializeRawLoopTrace(trace), "utf-8");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveRetryNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isFinite(value) === false || value <= 0) {
    return null;
  }
  return value;
}

const RETRY_DELAY_PATTERNS: Array<{ pattern: RegExp }> = [
  { pattern: /retry in\s+([0-9.]+)s/i },
  { pattern: /retryDelay"\s*:\s*"(\d+)s"/i },
  { pattern: /retry-after:\s*(\d+)/i },
];

function extractRetryDelayMs(err: unknown): number | null {
  const errorRecord = isPlainObject(err) ? err : {};

  const directMs = positiveRetryNumber(
    errorRecord.retryAfterMs ?? errorRecord.retryDelayMs ?? errorRecord.retry_ms,
  );
  if (directMs !== null) {
    return Math.ceil(directMs);
  }

  const directSeconds = positiveRetryNumber(
    errorRecord.retryAfterSeconds ?? errorRecord.retryDelaySeconds ?? errorRecord.retry_after,
  );
  if (directSeconds !== null) {
    return Math.ceil(directSeconds * 1000);
  }

  const raw = String(err ?? "");
  for (const { pattern } of RETRY_DELAY_PATTERNS) {
    const match = raw.match(pattern);
    const seconds = positiveRetryNumber(match === null ? null : Number(match[1]));
    if (seconds !== null) {
      return Math.ceil(seconds * 1000);
    }
  }

  return null;
}
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(p)));
      continue;
    }
    if (e.isFile()) out.push(p);
  }
  return out;
}

async function sha256File(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function collectArtifacts(runDir: string): Promise<ArtifactEntry[]> {
  const absFiles = await listFilesRecursive(runDir);
  absFiles.sort();
  const entries: ArtifactEntry[] = [];
  for (const absPath of absFiles) {
    const st = await fs.stat(absPath);
    if (!st.isFile()) continue;
    entries.push({
      path: path.relative(runDir, absPath),
      bytes: st.size,
      sha256: await sha256File(absPath),
      mtimeMs: st.mtimeMs,
    });
  }
  return entries;
}

async function fetchAnthropicModels(
  apiKey: string,
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  const bodyText = await res.text();
  return { ok: res.ok, status: res.status, bodyText };
}

type AnthropicAliasTarget = {
  prefixes: string[];
  exactIds: string[];
  fallback: string;
};

const ANTHROPIC_MODEL_ALIASES: Record<string, AnthropicAliasTarget> = {
  "claude-4-7-opus": {
    prefixes: ["claude-opus-4-7-"],
    exactIds: ["claude-opus-4-7"],
    fallback: "claude-opus-4-7",
  },
  "claude-4-6-opus": {
    prefixes: ["claude-opus-4-6-"],
    exactIds: ["claude-opus-4-6"],
    fallback: "claude-opus-4-6",
  },
  "claude-4-6-sonnet": {
    prefixes: ["claude-sonnet-4-6-"],
    exactIds: ["claude-sonnet-4-6"],
    fallback: "claude-sonnet-4-6",
  },
  "claude-4-5-haiku": {
    prefixes: ["claude-haiku-4-5-"],
    exactIds: [],
    fallback: "claude-haiku-4-5-20251001",
  },
};

function resolveAnthropicAlias(
  requestedModel: string,
  availableIds: string[],
): {
  requestedModel: string;
  resolvedModel: string;
  resolvedFrom: "alias" | "passthrough" | "fallback";
} {
  const alias = ANTHROPIC_MODEL_ALIASES[requestedModel];
  if (alias === undefined) {
    return { requestedModel, resolvedModel: requestedModel, resolvedFrom: "passthrough" };
  }

  const datedCandidates = availableIds.filter((id) =>
    alias.prefixes.some((prefix) => id.startsWith(prefix)),
  );
  const newestDated = datedCandidates.slice().sort().at(-1);
  if (newestDated !== undefined) {
    return { requestedModel, resolvedModel: newestDated, resolvedFrom: "alias" };
  }

  const exact = alias.exactIds.find((id) => availableIds.includes(id));
  if (exact !== undefined) {
    return { requestedModel, resolvedModel: exact, resolvedFrom: "alias" };
  }

  return { requestedModel, resolvedModel: alias.fallback, resolvedFrom: "fallback" };
}
function cloneRecord(record: JsonRecord | undefined): JsonRecord {
  if (!record) return {};
  return JSON.parse(JSON.stringify(record)) as JsonRecord;
}

function deepMergeRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMergeRecords(out[k], v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function mergeProviderOptions(defaults: JsonRecord, override?: JsonRecord): JsonRecord {
  const merged = cloneRecord(defaults);
  if (!override) return merged;
  return deepMergeRecords(merged, override);
}

function buildNvidiaDcfPrompt(
  runDir: string,
  model: string,
  modelGuidance: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const shellCommands = createHarnessPlatformCommands(platform);

  return `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Build an NVIDIA DCF valuation workbook (XLSX) and machine-readable validation output.

Model target: "${model}".
Model-specific guidance: ${modelGuidance}

Critical first action:
- Before any other non-todo tool call, call: skill { "skillName": "spreadsheet" }.
- Do not call write/edit/bash/glob/read until the skill call has completed.
- The harness enforces this ordering and will reject write/edit/bash/glob/read calls made before loading the skill.

Hard requirements:
- Your FIRST non-todo tool call MUST be exactly: skill { "skillName": "spreadsheet" }.
- You MUST call tool "skill" with skillName="spreadsheet" before any write/bash/glob/read calls.
- Use realistic but clearly labeled assumptions as placeholders; do not claim live market accuracy.
- Use formulas for all projected values and valuation outputs (do not hardcode projected numeric outcomes).
- Final response must be a raw JSON object (no markdown fences, no extra text) and must end with "<<END_RUN>>" in the "end" field.

Steps (must use tools):
1) As the first non-todo tool call, use skill to load skillName="spreadsheet".
2) Immediately after step 1, continue by using write to create "build_nvda_dcf.py" that generates "nvda_dcf.xlsx" with sheets:
   - "Inputs": assumption labels and values (BaseRevenue, GrowthY1..GrowthY5, OperatingMargin, TaxRate, DA_PctRevenue, Capex_PctRevenue, NWC_PctRevenue, WACC, TerminalGrowth, NetCash, SharesOutstanding).
   - "Forecast": Year 1..5 rows with formula-driven columns (Revenue, EBIT, NOPAT, D&A, Capex, ChangeNWC, UFCF).
   - "DCF": discount factors, PV of each UFCF, terminal value, enterprise value, equity value, implied price per share.
   Add currency/percent formatting, freeze header rows, and include a plain-text source note URL for the terminal value formula.
   The script must also write "dcf_validation.json" with:
   - "workbook": absolute path to xlsx
   - "sheets": workbook sheet names
   - "formulaChecks": object with at least 8 key cells and their formulas (or null if missing)
   - "impliedPricePerShareCell": sheet+cell reference
   - "timestampUtc"
3) Use bash to run: ${shellCommands.runPythonScript("build_nvda_dcf.py")}
4) Use glob to confirm "nvda_dcf.xlsx" and "dcf_validation.json" exist.
5) Use read to read back "dcf_validation.json" (limit=260, offset=1).
6) Ensure your final JSON includes "skillToolCalled": true only if the skill tool call actually happened.

Final response must be a JSON object:
{ "xlsx": "<absolute path>", "validation": "<absolute path>", "skillToolCalled": true, "end": "<<END_RUN>>" }`;
}

function buildSkillReliabilityPrompt(
  runDir: string,
  model: string,
  skillName: "spreadsheet" | "doc" | "slides" | "pdf",
  task: string,
  primaryFileName: string,
  primaryFileRequirements: string,
): string {
  const checkFileName = `${skillName}_skill_check.json`;
  return `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: ${task}

Model target: "${model}".
This run is measuring skill-loading reliability across different task types.

Critical first action:
- Before any other non-todo tool call, call: skill { "skillName": "${skillName}" }.
- Do not call write/edit/bash/glob/read until the skill call has completed.

Hard requirements:
- Your FIRST non-todo tool call MUST be exactly: skill { "skillName": "${skillName}" }.
- You MUST call tool "skill" with skillName="${skillName}" before any write/bash/glob/read calls.
- Keep all output paths absolute and inside workingDirectory.
- Final response must be raw JSON only (no markdown fences) and include "<<END_RUN>>" in the "end" field.

Steps (must use tools):
1) As the first non-todo tool call, use skill to load skillName="${skillName}".
2) Use write to create "${primaryFileName}" with the following requirements:
${primaryFileRequirements}
3) Use write to create "${checkFileName}" with JSON fields:
   - "skillName": "${skillName}"
   - "primaryFile": absolute path to "${primaryFileName}"
   - "checkType": "skill-reliability"
   - "timestampUtc": ISO-8601 timestamp string
4) Use glob to confirm "${primaryFileName}" and "${checkFileName}" exist.
5) Use read to read back "${checkFileName}" (limit=220, offset=1).

Final response must be raw JSON:
{ "primary": "<absolute path>", "check": "<absolute path>", "skillName": "${skillName}", "skillToolCalled": true, "end": "<<END_RUN>>" }`;
}

function buildDcfModelMatrixRuns(platform: NodeJS.Platform = process.platform): RunSpec[] {
  const profiles: Array<{
    id: string;
    provider: ProviderName;
    model: string;
    modelGuidance: string;
    maxSteps: number;
    maxAttempts: number;
    providerOptionsOverride?: JsonRecord;
  }> = [
    {
      id: "dcf-01-openai-gpt-5.2",
      provider: "openai",
      model: "gpt-5.2",
      modelGuidance:
        "Follow user step order exactly. First non-todo tool call must be skill(skillName=spreadsheet), then continue with required steps and fence-free final JSON.",
      maxSteps: 170,
      maxAttempts: 4,
      providerOptionsOverride: {
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
      },
    },
    {
      id: "dcf-02-anthropic-claude-4-6-opus",
      provider: "anthropic",
      model: "claude-4-6-opus",
      modelGuidance:
        "Prefer concise deterministic scripting over exploration, and avoid prose outside the required final JSON.",
      maxSteps: 180,
      maxAttempts: 4,
    },
    {
      id: "dcf-03-google-gemini-3-flash-preview",
      provider: "google",
      model: "gemini-3-flash-preview",
      modelGuidance:
        "Keep the script compact and straightforward; avoid optional enhancements that risk timeout or tool drift.",
      maxSteps: 150,
      maxAttempts: 4,
    },
    {
      id: "dcf-04-google-gemini-3.1-pro-preview",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      modelGuidance:
        "Include explicit formula references in validation output and stay strict about required artifact names.",
      maxSteps: 180,
      maxAttempts: 4,
    },
    {
      id: "dcf-05-anthropic-claude-4-5-haiku",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      modelGuidance:
        "Favor simple, robust formulas and minimize branchy logic in the generated Python script.",
      maxSteps: 150,
      maxAttempts: 4,
    },
  ];

  return profiles.map((profile) => ({
    id: profile.id,
    provider: profile.provider,
    model: profile.model,
    maxSteps: profile.maxSteps,
    maxAttempts: profile.maxAttempts,
    providerOptionsOverride: profile.providerOptionsOverride,
    requiredToolCalls: ["skill"],
    requiredSkillBeforeTools: "spreadsheet",
    guardedToolsBeforeSkill: ["write", "edit", "bash", "glob", "read"],
    finalContract: buildJsonFileContract(
      {
        xlsx: absolutePathSchema,
        validation: absolutePathSchema,
        skillToolCalled: boolSchema,
      },
      artifactAssertionsForPaths([
        { field: "xlsx", ext: ".xlsx" },
        { field: "validation", ext: ".json" },
      ]),
    ),
    prompt: ({ runDir }) =>
      buildNvidiaDcfPrompt(runDir, profile.model, profile.modelGuidance, platform),
  }));
}

function buildGptSkillReliabilityRuns(): RunSpec[] {
  const model = "gpt-5.2";
  const sharedGuardedTools = ["write", "edit", "bash", "glob", "read"];
  const providerOptionsOverride = {
    openai: {
      reasoningEffort: "medium",
      reasoningSummary: "detailed",
      textVerbosity: "medium",
    },
  };

  return [
    {
      id: "gpt-skill-01-spreadsheet",
      provider: "openai",
      model,
      maxSteps: 90,
      maxAttempts: 4,
      providerOptionsOverride,
      requiredToolCalls: ["skill"],
      requiredFirstNonTodoToolCall: "skill",
      requiredSkillBeforeTools: "spreadsheet",
      guardedToolsBeforeSkill: sharedGuardedTools,
      finalContract: buildJsonFileContract(
        {
          primary: absolutePathSchema,
          check: absolutePathSchema,
          skillName: z.literal("spreadsheet"),
          skillToolCalled: boolSchema,
        },
        artifactAssertionsForPaths([
          { field: "primary", ext: ".md" },
          { field: "check", ext: ".json" },
        ]),
      ),
      prompt: ({ runDir }) =>
        buildSkillReliabilityPrompt(
          runDir,
          model,
          "spreadsheet",
          "Create a spreadsheet-planning note with concrete formula examples.",
          "spreadsheet_plan.md",
          [
            '- Include sections: "Objective", "Inputs", and "Formula Skeleton".',
            '- In "Formula Skeleton", include at least 3 Excel-style formulas using cell references (e.g., =B2*(1+C2)).',
            "- Keep content concise and implementation-oriented.",
          ].join("\n"),
        ),
    },
    {
      id: "gpt-skill-02-doc",
      provider: "openai",
      model,
      maxSteps: 90,
      maxAttempts: 4,
      providerOptionsOverride,
      requiredToolCalls: ["skill"],
      requiredFirstNonTodoToolCall: "skill",
      requiredSkillBeforeTools: "doc",
      guardedToolsBeforeSkill: sharedGuardedTools,
      finalContract: buildJsonFileContract(
        {
          primary: absolutePathSchema,
          check: absolutePathSchema,
          skillName: z.literal("doc"),
          skillToolCalled: boolSchema,
        },
        artifactAssertionsForPaths([
          { field: "primary", ext: ".txt" },
          { field: "check", ext: ".json" },
        ]),
      ),
      prompt: ({ runDir }) =>
        buildSkillReliabilityPrompt(
          runDir,
          model,
          "doc",
          "Create a DOCX execution brief as plain text guidance.",
          "docx_execution_brief.txt",
          [
            "- Include a title and exactly 5 numbered implementation steps.",
            '- Mention both "python-docx" and "render_docx.py" explicitly.',
            '- End with a short "Verification" paragraph.',
          ].join("\n"),
        ),
    },
    {
      id: "gpt-skill-03-slides",
      provider: "openai",
      model,
      maxSteps: 90,
      maxAttempts: 4,
      providerOptionsOverride,
      requiredToolCalls: ["skill"],
      requiredFirstNonTodoToolCall: "skill",
      requiredSkillBeforeTools: "slides",
      guardedToolsBeforeSkill: sharedGuardedTools,
      finalContract: buildJsonFileContract(
        {
          primary: absolutePathSchema,
          check: absolutePathSchema,
          skillName: z.literal("slides"),
          skillToolCalled: boolSchema,
        },
        artifactAssertionsForPaths([
          { field: "primary", ext: ".md" },
          { field: "check", ext: ".json" },
        ]),
      ),
      prompt: ({ runDir }) =>
        buildSkillReliabilityPrompt(
          runDir,
          model,
          "slides",
          "Create a slide deck outline with speaker notes guidance.",
          "slides_outline.md",
          [
            "- Include 6 slides as a numbered list with title + one-line purpose.",
            '- Add a "Speaker Notes Strategy" section with 3 bullets.',
            "- Keep tone internal and practical.",
          ].join("\n"),
        ),
    },
    {
      id: "gpt-skill-04-pdf",
      provider: "openai",
      model,
      maxSteps: 90,
      maxAttempts: 4,
      providerOptionsOverride,
      requiredToolCalls: ["skill"],
      requiredFirstNonTodoToolCall: "skill",
      requiredSkillBeforeTools: "pdf",
      guardedToolsBeforeSkill: sharedGuardedTools,
      finalContract: buildJsonFileContract(
        {
          primary: absolutePathSchema,
          check: absolutePathSchema,
          skillName: z.literal("pdf"),
          skillToolCalled: boolSchema,
        },
        artifactAssertionsForPaths([
          { field: "primary", ext: ".md" },
          { field: "check", ext: ".json" },
        ]),
      ),
      prompt: ({ runDir }) =>
        buildSkillReliabilityPrompt(
          runDir,
          model,
          "pdf",
          "Create a PDF layout specification document.",
          "pdf_layout_spec.md",
          [
            '- Include sections: "Page Structure", "Table Rules", and "Quality Checks".',
            '- In "Table Rules", include at least 4 concrete rules.',
            '- In "Quality Checks", include 3 pass/fail checks.',
          ].join("\n"),
        ),
    },
  ];
}

export function buildGoogleCustomtoolsToolCoverageRuns(
  platform: NodeJS.Platform = process.platform,
): RunSpec[] {
  const model = "gemini-3.1-pro-preview-customtools";
  const shellCommands = createHarnessPlatformCommands(platform);

  return [
    {
      id: "gct-01-web-core",
      provider: "google",
      model,
      maxSteps: 90,
      maxAttempts: 4,
      requiredToolCalls: ["todoWrite", "webSearch", "webFetch", "write", "glob", "read"],
      finalContract: buildJsonFileContract(
        { notes: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "notes", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Exercise Google custom-tools web + planning flow.

Steps (must use tools):
1) Use todoWrite to create 4 items and set exactly one item to in_progress.
2) Use webSearch with query "HTTP 429 Retry-After header practical guidance" and maxResults=5.
3) Use webFetch on URL "https://www.rfc-editor.org/rfc/rfc6585.txt" with maxLength=7000.
4) Use write to create "gct01_web_notes.md" with:
- A title
- 3 bullets summarizing findings
- A "Source URL" line
5) Use glob with pattern "gct01_web_notes.md".
6) Use read to read "gct01_web_notes.md" (limit=220, offset=1).
7) Use todoWrite to mark all items completed.

Final response must be raw JSON:
{ "notes": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "gct-02-skill-bash",
      provider: "google",
      model,
      maxSteps: 90,
      maxAttempts: 4,
      requiredToolCalls: ["skill", "write", "bash", "glob", "read"],
      finalContract: buildJsonFileContract(
        { file: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "file", ext: ".txt" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Exercise skill loading plus shell execution.

Steps (must use tools):
1) Use skill with skillName="doc".
2) Use write to create "gct02_skill_bash.txt" containing:
- A title
- A line with text "BASH_OUTPUT_TODO"
3) Use bash to run command: ${shellCommands.printWorkingDirectory()}
4) Use glob with pattern "gct02_skill_bash.txt".
5) Use read to read "gct02_skill_bash.txt" (limit=180, offset=1).

Final response must be raw JSON:
{ "file": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "gct-03-ask-edit-memory",
      provider: "google",
      model,
      maxSteps: 110,
      maxAttempts: 4,
      requiredToolCalls: ["AskUserQuestion", "write", "edit", "memory", "read"],
      finalContract: buildJsonFileContract({
        label: z.string().trim().min(1),
      }),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Exercise AskUserQuestion, edit, and memory in one turn.

Steps (must use tools):
1) Use AskUserQuestion with question "Pick a dataset label" and options ["alpha","beta","gamma"].
2) Use write to create "gct03.txt" with a single line: label: PLACEHOLDER
3) Use edit to replace "PLACEHOLDER" in "gct03.txt" with the selected label.
4) Use memory with action="write", key="runs/gct03", content="dataset=<label>".
5) Use memory with action="read", key="runs/gct03".
6) Use memory with action="search", query="dataset=".
7) Use read to read "gct03.txt" (limit=220, offset=1).

Final response must be raw JSON:
{ "label": "<selected label>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "gct-04-gapfill-edit-grep-spawn",
      provider: "google",
      model,
      maxSteps: 110,
      maxAttempts: 4,
      requiredToolCalls: ["spawnAgent", "waitForAgent", "write", "grep", "edit", "read"],
      finalContract: buildJsonFileContract(
        { report: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "report", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Exercise spawnAgent + grep + edit deterministically.

Steps (must use tools):
1) Use spawnAgent with role="worker" and message: "Reply with exactly SUBAGENT_OK".
2) Use waitForAgent with the returned agentId and timeoutMs=5000. Check erroredAgentIds first — if the agentId is listed there, treat it as failed and do not use its text. Only when it is absent from erroredAgentIds, use the completed agent's lastMessagePreview as the sub-agent output.
3) Use write to create "gct04_source.txt" containing lines:
- alpha
- beta
- gamma
4) Use grep with pattern "beta", path "gct04_source.txt", caseSensitive=false.
5) Use write to create "gct04_report.md" with lines:
- SUBAGENT_PLACEHOLDER
- GREP_PLACEHOLDER
6) Use edit to replace exact string "SUBAGENT_PLACEHOLDER" with the completed agent's lastMessagePreview.
7) Use edit to replace exact string "GREP_PLACEHOLDER" with a concise grep summary.
8) Use read to read "gct04_report.md" (limit=220, offset=1).

Final response must be raw JSON:
{ "report": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
  ];
}

export function buildMixedRuns(platform: NodeJS.Platform = process.platform): RunSpec[] {
  const shellCommands = createHarnessPlatformCommands(platform);

  return [
    {
      id: "run-01",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 60,
      finalContract: buildJsonFileContract(
        {
          run_id: z.string().trim().min(1),
          memo_file: absolutePathSchema,
          tool_summary: z.string().trim().min(1),
        },
        artifactAssertionsForPaths([{ field: "memo_file", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Research HTTP 418 ("I'm a teapot") and RFC 2324, then write a short memo.

Steps (must use tools):
1) Call todoWrite with a 4-item plan; set exactly one item to in_progress.
2) Use webSearch with query "HTTP 418 I'm a teapot RFC 2324" and maxResults=5.
3) Pick the single most authoritative URL from the results and use webFetch on it (maxLength=8000).
4) Use write to create "memo.md" containing:
- A title
- 3 bullet points with citations (URL inline)
- 1 short paragraph on why 418 appears in real systems
5) Use glob to confirm "memo.md" exists (pattern: "memo.md").
6) Use read to read back "memo.md" (limit=200, offset=1).
7) Update todoWrite marking all items completed.

Final response must be a JSON object:
{ "run_id": "...", "memo_file": "<absolute path>", "tool_summary": "<one sentence>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-02",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 80,
      finalContract: buildJsonFileContract(
        { bash_tool_notes: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "bash_tool_notes", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
        repoDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Produce an internal note explaining how command approvals and the bash tool work in this repo.

Steps (must use tools):
1) Use bash to run: ${shellCommands.printWorkingDirectory()}
2) Use grep to search for pattern "approveCommand" in path "${repoDir}/src" (caseSensitive=true).
3) Use read to read "${repoDir}/src/tools/bash.ts" (limit=200, offset=1).
4) Use read to read "${repoDir}/src/utils/approval.ts" (limit=240, offset=1).
5) Use write to create "bash_tool_notes.md" with:
- A short overview
- A table listing: approval hook, working directory behavior, timeout defaults, stdout/stderr truncation
- A "Gotchas" section
6) Use edit to replace the exact string "TODO_REPLACE_ME" in "bash_tool_notes.md" with a concrete gotcha you found.
7) Use bash to run: ${shellCommands.listDirectory()}

Final response must be raw JSON:
{ "bash_tool_notes": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-03",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      maxSteps: 90,
      finalContract: buildJsonFileContract(
        {
          xlsx: absolutePathSchema,
          verify: absolutePathSchema,
        },
        artifactAssertionsForPaths([
          { field: "xlsx", ext: ".xlsx" },
          { field: "verify", ext: ".txt" },
        ]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Build a real Excel amortization model (XLSX) for a loan and save verification output.

Steps (must use tools):
1) Use skill to load skillName="spreadsheet".
2) Use write to create "build_amortization.py" that generates "amortization.xlsx" with:
- Sheet "Inputs" (Principal=25000, APR=6%, TermMonths=36) with clear labels
- Sheet "Schedule" with columns: Period, Payment, Interest, Principal, Balance
- Use Excel formulas (do not hardcode results); payment should reference Inputs
- Basic formatting (currency/percent) and frozen header row
- Add a Source note in the sheet (plain URL) for the PMT formula reference (any authoritative URL)
Also have the script write "verify.txt" with:
- workbook sheet names
- first 5 schedule lines (values or formulas)
3) Use bash to run: ${shellCommands.runPythonScript("build_amortization.py")}
4) Use glob to confirm both files exist: "amortization.xlsx" and "verify.txt".
5) Use read to read back "verify.txt" (limit=200, offset=1).

Final response must be a JSON object:
{ "xlsx": "<absolute path>", "verify": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-04",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 90,
      finalContract: buildJsonFileContract(
        {
          docx: absolutePathSchema,
          excerpt: absolutePathSchema,
        },
        artifactAssertionsForPaths([
          { field: "docx", ext: ".docx" },
          { field: "excerpt", ext: ".txt" },
        ]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a professional DOCX brief and a text extract for quick inspection.

Steps (must use tools):
1) Use skill to load skillName="doc".
2) Use write to create "build_brief_docx.py" that generates "brief.docx" with:
- Title
- 2 headings
- A bulleted list
- A 2x3 table
The script must also extract plain text from the DOCX into "brief_excerpt.txt".
3) Use bash to run: ${shellCommands.runPythonScript("build_brief_docx.py")}
4) Use glob to confirm "brief.docx" and "brief_excerpt.txt" exist.
5) Use read to read back "brief_excerpt.txt" (limit=200, offset=1).

Final response must be a JSON object:
{ "docx": "<absolute path>", "excerpt": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-05",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 110,
      finalContract: buildJsonFileContract(
        {
          deck: absolutePathSchema,
          outline: absolutePathSchema,
        },
        artifactAssertionsForPaths([
          { field: "deck", ext: ".pptx" },
          { field: "outline", ext: ".txt" },
        ]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a PPTX deck and a machine-readable outline of its slides.

Steps (must use tools):
1) Use skill to load skillName="slides".
2) Use write to create "build_deck.py" that generates "deck.pptx" with 5 slides:
- Slide 1: title slide
- Slide 2: agenda bullets
- Slide 3: a table
- Slide 4: a simple bar chart (if charting is too hard, include a labeled bar chart as shapes)
- Slide 5: conclusion
Also have the script write "deck_outline.txt" with one line per slide: "<index> - <title>".
3) Use bash to run: ${shellCommands.runPythonScript("build_deck.py")}
4) Use glob to confirm "deck.pptx" and "deck_outline.txt" exist.
5) Use read to read back "deck_outline.txt" (limit=50, offset=1).

Final response must be raw JSON:
{ "deck": "<absolute path>", "outline": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-06",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      maxSteps: 110,
      finalContract: buildJsonFileContract(
        {
          pdf: absolutePathSchema,
          meta: absolutePathSchema,
        },
        artifactAssertionsForPaths([
          { field: "pdf", ext: ".pdf" },
          { field: "meta", ext: ".json" },
        ]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a PDF report and write a small verification file describing it.

Steps (must use tools):
1) Use skill to load skillName="pdf".
2) Use write to create "build_report_pdf.py" that generates "report.pdf" with:
- Title, date, and a short paragraph
- A small table (at least 4 rows)
Also have the script write "report_meta.json" with:
- page_count
- sha256 of the PDF
3) Use bash to run: ${shellCommands.runPythonScript("build_report_pdf.py")}
4) Use glob to confirm "report.pdf" and "report_meta.json" exist.
5) Use read to read back "report_meta.json" (limit=80, offset=1).

Final response must be a JSON object:
{ "pdf": "<absolute path>", "meta": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-07",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 90,
      finalContract: buildJsonFileContract({
        dataset: z.string().trim().min(1),
      }),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Exercise AskUserQuestion + edit + memory in one run.

Steps (must use tools):
1) Use AskUserQuestion with question "Pick a dataset name" and options ["alpha","beta","gamma","delta"].
2) Use write to create "notes.txt" with a single line: dataset: PLACEHOLDER
3) Use edit to replace "PLACEHOLDER" in "notes.txt" with the selected dataset name.
4) Use memory with action="write", key="runs/run07", content="dataset=<dataset>".
5) Use memory with action="read", key="runs/run07".
6) Use memory with action="search", query="dataset=".
7) Use read to read back "notes.txt" (limit=200, offset=1).

Final response must be raw JSON:
{ "dataset": "<dataset>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-08",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 120,
      requiredToolCalls: [
        "spawnAgent",
        "waitForAgent",
        "webFetch",
        "write",
        "edit",
        "glob",
        "read",
      ],
      finalContract: buildJsonFileContract(
        { report: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "report", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Use a research sub-agent, then write and lightly edit a short report.

Steps (must use tools):
1) Use spawnAgent with role="research" and message:
"Find the latest stable Bun release version (as of today) and one authoritative URL. Return JSON only: {\\"version\\":\\"...\\",\\"url\\":\\"...\\"}."
2) Use waitForAgent with the returned agentId and timeoutMs=10000. Check erroredAgentIds first — if the agentId is listed there, treat it as failed and do not use its text. Only when it is absent from erroredAgentIds, extract version and URL from the completed agent's lastMessagePreview JSON.
3) Use webFetch on the returned URL (maxLength=6000).
4) Use write to create "bun_release_report.md" with:
- version and URL
- 3 bullet summary
- A short 'Limitations' section
5) Use edit to replace the exact string "LIMITATIONS_TODO" with a concrete limitation.
6) Use glob with pattern "*.md".
7) Use read to read back "bun_release_report.md" (limit=220, offset=1).

Final response must be raw JSON:
{ "report": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-09",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      maxSteps: 90,
      finalContract: buildJsonFileContract(
        { ws_quickref: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "ws_quickref", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
        repoDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a WebSocket protocol quick reference based on the repo docs.

Steps (must use tools):
1) Use read to read "${repoDir}/docs/websocket-protocol.md" (limit=260, offset=1).
2) Use grep to find lines matching pattern "type: \\"(client_|server_)" in path "${repoDir}/docs/websocket-protocol.md".
3) Use write to create "ws_quickref.md" that includes:
- A short introduction
- A table of message/event types you found (name + one-sentence meaning)
4) Use bash to run: ${shellCommands.countLines("ws_quickref.md")}

Final response must be raw JSON:
{ "ws_quickref": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-10",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 140,
      finalContract: buildJsonFileContract(
        { manifest: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "manifest", ext: ".json" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a small bundle of artifacts: XLSX + DOCX + PPTX derived from one tiny dataset.

Steps (must use tools):
1) Use skill to load skillName="spreadsheet".
2) Use skill to load skillName="doc".
3) Use skill to load skillName="slides".
4) Use write to create "build_bundle.py" that:
- Creates "dataset.csv" with 12 rows: month, revenue, cost
- Creates "bundle.xlsx" that imports the dataset into a sheet and computes gross profit and margin with formulas
- Creates "bundle.docx" that contains a short narrative summary and a table of the dataset
- Creates "bundle.pptx" with 4 slides: title, key metrics, table, conclusion
- Writes "bundle_manifest.json" listing filenames and sha256 hashes
5) Use bash to run: ${shellCommands.runPythonScript("build_bundle.py")}
6) Use glob with pattern "bundle_*.*".
7) Use read to read back "bundle_manifest.json" (limit=200, offset=1).

Final response must be a JSON object:
{ "manifest": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
    {
      id: "run-11",
      provider: "anthropic",
      model: "claude-4-6-sonnet",
      maxSteps: 40,
      maxAttempts: 2,
      requiredToolCalls: ["todoWrite", "webSearch", "write", "read"],
      requiredToolBeforeTools: "webSearch",
      guardedToolsBeforeRequiredTool: ["write", "read"],
      finalContract: buildJsonFileContract(
        {
          run_id: z.string().trim().min(1),
          memo: absolutePathSchema,
        },
        artifactAssertionsForPaths([{ field: "memo", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Demonstrate Claude 4.6 Sonnet tool use with web research.

Steps (must use tools):
1) Use todoWrite to create 3 items and mark exactly one in_progress.
2) Use webSearch for query "HTTP 418 RFC 2324" with maxResults=4.
3) Use write to create "sonnet_web_research.md" containing: title + 3 bullets from search results with URL citations.
4) Use read to read "sonnet_web_research.md" (limit=200, offset=1).
5) Use todoWrite to mark all items completed.

Final response must be raw JSON:
{ "run_id": "run-11", "memo": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
  ];
}

function buildCodexHarnessSmokeRuns(platform: NodeJS.Platform = process.platform): RunSpec[] {
  const model = "gpt-5.4";
  const shellCommands = createHarnessPlatformCommands(platform);

  return [
    {
      id: "codex-smoke-01-core-tools",
      provider: "codex-cli",
      model,
      maxSteps: 90,
      maxAttempts: 3,
      requiredToolCalls: ["todoWrite", "bash", "grep", "read", "write", "glob"],
      finalContract: buildJsonFileContract(
        { report: absolutePathSchema },
        artifactAssertionsForPaths([{ field: "report", ext: ".md" }]),
      ),
      prompt: ({
        runDir,
      }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Smoke-test the harness against the current repo using a focused local tool loop.

Steps (must use tools):
1) Use todoWrite to create 4 items and set exactly one item to in_progress.
2) Use bash to run: ${shellCommands.printWorkingDirectory()}
3) Use write to create "harness_source.txt" containing at least 3 lines, and one line must include the exact text "runTurnWithDeps".
4) Use grep with pattern "runTurnWithDeps" in path "harness_source.txt".
5) Use read to read "harness_source.txt" (limit=120, offset=1).
6) Use write to create "codex_harness_smoke.md" with:
- A title
- A short paragraph explaining what the harness run validated
- 3 bullets summarizing what you observed from the repo/tooling
7) Use glob with pattern "codex_harness_smoke.md".
8) Use read to read "codex_harness_smoke.md" (limit=220, offset=1).
9) Use todoWrite to mark all items completed.

Final response must be raw JSON:
{ "report": "<absolute path>", "end": "<<END_RUN>>" }`,
    },
  ];
}

function computeRetryDelayMs(err: unknown, attempt: number): number {
  const extracted = extractRetryDelayMs(err);
  const backoffBaseMs = 12_000;
  const backoffMs = Math.min(180_000, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  const target = extracted ? Math.max(extracted, backoffMs) : backoffMs;
  const jitterMs = Math.floor(Math.random() * 1500);
  return target + jitterMs;
}

async function emitHarnessRunEvent(
  config: AgentConfig,
  name: string,
  status: "ok" | "error",
  at: string,
  attrs: Record<string, string | number | boolean>,
  durationMs?: number,
) {
  await emitObservabilityEvent(config, {
    name,
    at,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    attributes: attrs,
  });
}

export function selectRawLoopRuns(
  cliArgs: Pick<RawLoopArgs, "scenario" | "onlyRunIds" | "onlyModels">,
): RunSpec[] {
  const scenarioRuns = SCENARIO_DEFINITIONS[cliArgs.scenario].build();
  const runs = scenarioRuns.filter((run) => {
    if (cliArgs.onlyRunIds.length > 0 && !cliArgs.onlyRunIds.includes(run.id)) {
      return false;
    }
    if (cliArgs.onlyModels.length > 0 && !cliArgs.onlyModels.includes(run.model)) {
      return false;
    }
    return true;
  });

  if (runs.length === 0) {
    throw new Error(
      `No runs selected for scenario="${cliArgs.scenario}". Try --only-run/--only-model values that exist in this scenario.`,
    );
  }
  return runs;
}

type DiscoveredSkills = Awaited<ReturnType<typeof loadSystemPromptWithSkills>>["discoveredSkills"];

type RawLoopAttemptOutcome = {
  ok: boolean;
  error?: string;
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  toolLogLines: string[];
  askEvents: AskEvent[];
  approvalEvents: ApprovalEvent[];
  todoEvents: TodoEvent[];
  steps: TracedStep[];
  validation: FinalContractValidationResult | null;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  degraded: boolean;
  budgets: ReturnType<typeof buildRawLoopBudgetSummary>;
};

async function executeRawLoopAttempt(args: {
  run: RunSpec;
  runIndex: number;
  runDir: string;
  config: AgentConfig;
  system: string;
  inputMessages: ModelMessage[];
  harnessContext: HarnessContextState;
  discoveredSkills: DiscoveredSkills;
  connectedProviders: readonly ProviderName[];
  strictMode: boolean;
  scenario: RawLoopArgs["scenario"];
  attempt: number;
}): Promise<RawLoopAttemptOutcome> {
  const {
    run,
    runIndex,
    runDir,
    config,
    system,
    inputMessages,
    harnessContext,
    discoveredSkills,
    connectedProviders,
    strictMode,
    scenario,
    attempt,
  } = args;

  const toolLogLines: string[] = [];
  const askEvents: AskEvent[] = [];
  const approvalEvents: ApprovalEvent[] = [];
  const todoEvents: TodoEvent[] = [];
  const steps: TracedStep[] = [];
  let attemptValidation: FinalContractValidationResult | null = null;
  let attemptRepairAttempted = false;
  let attemptRepairSucceeded = false;
  let attemptDegraded = false;
  let attemptTotalSteps = 0;

  const log = (line: string) => {
    toolLogLines.push(line);
  };

  const askUser = async (question: string, options?: string[]) => {
    const optionCount = options?.length ?? 0;
    const idx = optionCount > 0 ? (runIndex - 1) % optionCount : 0;
    const answer = options?.[idx] ?? "OK";
    askEvents.push({ at: nowIso(), question, options, answer });
    return answer;
  };

  const approveCommand = async (command: string) => {
    const approved = true;
    approvalEvents.push({ at: nowIso(), command, approved });
    return approved;
  };

  const updateTodos = (todos: TodoItem[]) => {
    todoEvents.push({ at: nowIso(), todos });
  };

  const createToolsOverride = (ctx: ToolContext) =>
    createToolsWithTracing(
      ctx,
      steps,
      {
        requiredSkillName: run.requiredSkillBeforeTools,
        guardedToolNames: run.guardedToolsBeforeSkill,
      },
      {
        requiredToolName: run.requiredToolBeforeTools,
        guardedToolNames: run.guardedToolsBeforeRequiredTool,
      },
    );
  const agentControl = createRawLoopAgentControl(
    {
      config,
      log,
      askUser,
      approveCommand,
      availableSkills: discoveredSkills,
      parentMessages: inputMessages,
      getParentTodos: () => structuredClone(todoEvents.at(-1)?.todos ?? []),
      harnessContext,
    },
    {
      getConnectedProviders: async () => connectedProviders,
    },
  );

  try {
    const mainStepNumbers: number[] = [];
    const res = await (async () => {
      try {
        return await runTurnWithDeps(
          {
            config,
            system,
            messages: inputMessages,
            harnessContext,
            log,
            askUser,
            approveCommand,
            updateTodos,
            discoveredSkills,
            agentControl,
            prepareStep: async ({ stepNumber }) => {
              mainStepNumbers.push(stepNumber);
              return undefined;
            },
            maxSteps: run.maxSteps ?? 100,
            enableMcp: false,
            telemetryContext: {
              functionId: "harness.runTurn",
              metadata: {
                runId: run.id,
                scenario,
                attempt,
              },
            },
          },
          {
            createTools: createToolsOverride,
          },
        );
      } finally {
        attemptTotalSteps += countObservedLoopSteps(mainStepNumbers);
      }
    })();

    assertRawLoopToolRequirements(run, steps, toolLogLines);

    let finalText = res.text;
    let finalReasoningText = res.reasoningText;
    let finalResponseMessages = res.responseMessages;
    const validationOutcome = await validateWithOptionalRepair({
      finalText,
      runDir,
      trace: {
        toolLogLines,
        askEvents,
        approvalEvents,
        todoEvents,
        steps,
      },
      contract: run.finalContract,
      strictMode,
      repairFinalOutput: async () => {
        const finalizeMessages: ModelMessage[] = [
          ...inputMessages,
          ...finalResponseMessages,
          {
            role: "user",
            content:
              'You did not provide a valid final JSON response contract. Provide only the final raw JSON object now, do NOT call tools, and include "end": "<<END_RUN>>".',
          },
        ];

        const repairStepNumbers: number[] = [];
        const finalized = await (async () => {
          try {
            return await runTurnWithDeps(
              {
                config,
                system,
                messages: finalizeMessages,
                harnessContext,
                log,
                askUser,
                approveCommand,
                updateTodos,
                discoveredSkills,
                prepareStep: async ({ stepNumber }) => {
                  repairStepNumbers.push(stepNumber);
                  return undefined;
                },
                maxSteps: 1,
                enableMcp: false,
              },
              {
                createTools: () => ({}),
              },
            );
          } finally {
            attemptTotalSteps += countObservedLoopSteps(repairStepNumbers);
          }
        })();

        return {
          finalText: finalized.text.trim() || finalText,
          data: {
            reasoningText:
              typeof finalized.reasoningText === "string"
                ? finalized.reasoningText
                : finalReasoningText,
            responseMessages: finalized.responseMessages,
          },
        };
      },
    });

    const validationResult = validationOutcome.validationResult;
    attemptRepairAttempted = validationOutcome.repairAttempted;
    attemptRepairSucceeded = validationOutcome.repairSucceeded;
    attemptDegraded = validationOutcome.degraded;
    finalText = validationOutcome.finalText;
    const repairData = validationOutcome.repairData;
    if (repairData === undefined) {
      // No repair payload to merge into the successful response.
    } else {
      finalReasoningText = repairData.reasoningText;
      if (repairData.responseMessages.length > 0) {
        finalResponseMessages = [...finalResponseMessages, ...repairData.responseMessages];
      }
    }

    const budgetSummary = buildRawLoopBudgetSummary(
      toolLogLines,
      attemptTotalSteps,
      attemptRepairAttempted ? 1 : 0,
    );
    attemptValidation = validationResult;

    if (validationResult.ok === false) {
      return {
        ok: false,
        error: `Final contract validation failed: ${validationResult.issues
          .map((entry) => entry.message)
          .join("; ")}`,
        text: "",
        responseMessages: [],
        toolLogLines,
        askEvents,
        approvalEvents,
        todoEvents,
        steps,
        validation: attemptValidation,
        repairAttempted: attemptRepairAttempted,
        repairSucceeded: attemptRepairSucceeded,
        degraded: attemptDegraded,
        budgets: budgetSummary,
      };
    }

    return {
      ok: true,
      text: finalText,
      reasoningText: finalReasoningText,
      responseMessages: finalResponseMessages,
      toolLogLines,
      askEvents,
      approvalEvents,
      todoEvents,
      steps,
      validation: attemptValidation,
      repairAttempted: attemptRepairAttempted,
      repairSucceeded: attemptRepairSucceeded,
      degraded: attemptDegraded,
      budgets: budgetSummary,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error),
      text: "",
      responseMessages: [],
      toolLogLines,
      askEvents,
      approvalEvents,
      todoEvents,
      steps,
      validation: attemptValidation,
      repairAttempted: attemptRepairAttempted,
      repairSucceeded: attemptRepairSucceeded,
      degraded: attemptDegraded,
      budgets: buildRawLoopBudgetSummary(
        toolLogLines,
        attemptTotalSteps,
        attemptRepairAttempted ? 1 : 0,
      ),
    };
  }
}

async function executeRawLoopRun(
  run: RunSpec,
  runIndex: number,
  opts: {
    repoDir: string;
    runRoot: string;
    cliArgs: RawLoopArgs;
    anthropicModelIds: string[];
    connectedProviders: ProviderName[];
  },
): Promise<void> {
  const { repoDir, runRoot, cliArgs, anthropicModelIds, connectedProviders } = opts;

  const resolved =
    run.provider === "anthropic"
      ? resolveAnthropicAlias(run.model, anthropicModelIds)
      : {
          requestedModel: run.model,
          resolvedModel: run.model,
          resolvedFrom: "passthrough" as const,
        };

  const runDirName = `${run.id}_${run.provider}_${safePathComponent(resolved.resolvedModel)}`;
  const runDir = path.join(runRoot, runDirName);
  await ensureDir(runDir);

  const startedAt = nowIso();
  const startedAtMs = Date.now();

  const env = {
    ...process.env,
    AGENT_WORKING_DIR: runDir,
    AGENT_PROVIDER: run.provider,
    AGENT_MODEL: resolved.resolvedModel,
    COWORK_DISABLE_BUILTIN_SKILLS: process.env.COWORK_DISABLE_BUILTIN_SKILLS ?? "1",
  };

  const config = await loadConfig({ cwd: repoDir, env });
  await ensureDefaultGlobalSkillsReady({
    env,
    config,
    log: (line) => {
      console.warn(`[default-skills] ${line}`);
    },
  });

  config.providerOptions = mergeProviderOptions(
    DEFAULT_PROVIDER_OPTIONS as JsonRecord,
    run.providerOptionsOverride,
  );
  applyRawLoopToolSurfaceConfig(config, run.provider);
  config.enableMcp = false;
  config.provider = run.provider;
  config.model = resolved.resolvedModel;
  config.preferredChildModel = resolved.resolvedModel;
  config.harness = resolveRawLoopHarnessConfig(config.harness, cliArgs);

  // Keep memory local to the run folder so artifacts can be captured per-run.
  const localProjectCoworkDir = path.join(runDir, ".cowork");
  const localUserCoworkDir = path.join(runDir, ".cowork-user");
  const hasProjectSkillsDir = Boolean(config.skillsDirs[0]);
  const coworkSkillsDir = config.skillsDirs[1] || "";
  const trailingSkillDirs = config.skillsDirs.slice(2);
  config.projectCoworkDir = localProjectCoworkDir;
  config.userCoworkDir = localUserCoworkDir;
  config.skillsDirs = [
    hasProjectSkillsDir ? path.join(localProjectCoworkDir, "skills") : "",
    coworkSkillsDir,
    ...trailingSkillDirs,
  ].filter(Boolean);
  config.memoryDirs = [
    path.join(localProjectCoworkDir, "memory"),
    path.join(localUserCoworkDir, "memory"),
  ];
  config.configDirs = [
    localProjectCoworkDir,
    path.join(localUserCoworkDir, "config"),
    config.builtInConfigDir,
  ];

  await ensureDir(config.projectCoworkDir);
  const observabilityStartHealthBefore = getObservabilityHealth(config);
  await emitHarnessRunEvent(
    config,
    "harness.run.started",
    "ok",
    startedAt,
    {
      runId: run.id,
      provider: run.provider,
      model: resolved.resolvedModel,
      scenario: cliArgs.scenario,
      maxAttempts: run.maxAttempts ?? 5,
      maxSteps: run.maxSteps ?? 100,
    },
    0,
  );
  const observabilityStartHealth = getObservabilityHealth(config);

  const { prompt: system, discoveredSkills } = await loadSystemPromptWithSkills(config);

  const promptContext = { runId: run.id, runDir, repoDir };
  const userPrompt = run.prompt(promptContext);
  const inputMessages: ModelMessage[] = [{ role: "user", content: userPrompt }];
  const harnessContext = buildRawLoopHarnessContext(
    run,
    cliArgs.scenario,
    promptContext,
    startedAt,
  );

  await fs.writeFile(path.join(runDir, "prompt.txt"), userPrompt, "utf-8");
  await fs.writeFile(path.join(runDir, "system.txt"), system, "utf-8");
  await fs.writeFile(
    path.join(runDir, "input_messages.json"),
    safeJsonStringify(inputMessages),
    "utf-8",
  );
  await fs.writeFile(
    path.join(runDir, "harness_context.json"),
    safeJsonStringify(harnessContext),
    "utf-8",
  );

  const traceBase: RunTraceBase = {
    runId: run.id,
    startedAt,
    config,
    system,
    userPrompt,
    inputMessages,
    harnessContext,
  };

  const attempts: AttemptMeta[] = [];
  const maxAttempts = run.maxAttempts ?? 5;
  const strictMode = config.harness.strictMode;

  let finalToolLogLines: string[] = [];
  let finalAskEvents: AskEvent[] = [];
  let finalApprovalEvents: ApprovalEvent[] = [];
  let finalTodoEvents: TodoEvent[] = [];
  let finalSteps: TracedStep[] = [];
  let repairAttempted = false;
  let repairSucceeded = false;
  let degraded = false;
  let finalValidation: FinalContractValidationResult | null = null;
  let finalBudgets = buildRawLoopBudgetSummary([], 0, 0);
  let finalRes: {
    text: string;
    reasoningText?: string;
    responseMessages: ModelMessage[];
  } | null = null;
  let finalError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStartedAt = nowIso();
    const outcome = await executeRawLoopAttempt({
      run,
      runIndex,
      runDir,
      config,
      system,
      inputMessages,
      harnessContext,
      discoveredSkills,
      connectedProviders,
      strictMode,
      scenario: cliArgs.scenario,
      attempt,
    });
    const retryDelayMs =
      outcome.ok === false
        ? computeRetryDelayMs(outcome.error ?? new Error("Raw-loop attempt failed"), attempt)
        : undefined;
    attempts.push({
      attempt,
      startedAt: attemptStartedAt,
      finishedAt: nowIso(),
      ok: outcome.ok,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    });

    finalValidation = outcome.validation;
    repairAttempted = outcome.repairAttempted;
    repairSucceeded = outcome.repairSucceeded;
    degraded = outcome.degraded;
    finalBudgets = outcome.budgets;
    finalToolLogLines = outcome.toolLogLines;
    finalAskEvents = outcome.askEvents;
    finalApprovalEvents = outcome.approvalEvents;
    finalTodoEvents = outcome.todoEvents;
    finalSteps = outcome.steps;

    if (outcome.ok) {
      finalRes = {
        text: outcome.text,
        reasoningText: outcome.reasoningText,
        responseMessages: outcome.responseMessages,
      };
      finalError = null;
      await writeTraceFile(
        path.join(runDir, `trace_attempt-${String(attempt).padStart(2, "0")}.json`),
        buildRunTrace(
          traceBase,
          {
            toolLogLines: outcome.toolLogLines,
            askEvents: outcome.askEvents,
            approvalEvents: outcome.approvalEvents,
            todoEvents: outcome.todoEvents,
            steps: outcome.steps,
          },
          {
            text: outcome.text,
            reasoningText: outcome.reasoningText,
            responseMessages: outcome.responseMessages,
            error: undefined,
          },
        ),
      );
      break;
    }

    finalRes = null;
    finalError = outcome.error;
    await writeTraceFile(
      path.join(runDir, `trace_attempt-${String(attempt).padStart(2, "0")}.json`),
      buildRunTrace(
        traceBase,
        {
          toolLogLines: outcome.toolLogLines,
          askEvents: outcome.askEvents,
          approvalEvents: outcome.approvalEvents,
          todoEvents: outcome.todoEvents,
          steps: outcome.steps,
        },
        {
          text: "",
          reasoningText: undefined,
          responseMessages: [],
          error: outcome.error,
        },
      ),
    );
    if (attempt < maxAttempts) {
      await sleep(retryDelayMs ?? 0);
    }
  }

  const finishedAt = nowIso();

  const trace = buildRunTrace(
    traceBase,
    {
      toolLogLines: finalToolLogLines,
      askEvents: finalAskEvents,
      approvalEvents: finalApprovalEvents,
      todoEvents: finalTodoEvents,
      steps: finalSteps,
    },
    {
      text: finalRes?.text ?? "",
      reasoningText: finalRes?.reasoningText,
      responseMessages: finalRes?.responseMessages ?? [],
      error: finalError ? String(finalError) : undefined,
    },
    finishedAt,
  );
  await writeTraceFile(path.join(runDir, "trace.json"), trace);

  await fs.writeFile(path.join(runDir, "attempts.json"), safeJsonStringify(attempts), "utf-8");
  await fs.writeFile(path.join(runDir, "tool-log.txt"), finalToolLogLines.join("\n"), "utf-8");
  await fs.writeFile(path.join(runDir, "final.txt"), trace.result.text, "utf-8");
  await fs.writeFile(
    path.join(runDir, "final_reasoning.txt"),
    trace.result.reasoningText ?? "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(runDir, "response_messages.json"),
    safeJsonStringify(trace.result.responseMessages),
    "utf-8",
  );

  const artifacts = await collectArtifacts(runDir);
  await fs.writeFile(
    path.join(runDir, "artifacts_index.json"),
    safeJsonStringify(artifacts),
    "utf-8",
  );

  const runFailureError =
    !finalRes && finalError
      ? new Error(`Run ${run.id} failed after ${maxAttempts} attempts: ${String(finalError)}`)
      : undefined;

  if (runFailureError) {
    await emitHarnessRunEvent(
      config,
      "harness.run.failed",
      "error",
      finishedAt,
      {
        runId: run.id,
        provider: run.provider,
        model: resolved.resolvedModel,
        scenario: cliArgs.scenario,
        maxAttempts,
      },
      Date.now() - startedAtMs,
    );
  } else {
    await emitHarnessRunEvent(
      config,
      "harness.run.completed",
      "ok",
      finishedAt,
      {
        runId: run.id,
        provider: run.provider,
        model: resolved.resolvedModel,
        scenario: cliArgs.scenario,
        attempts: attempts.length,
        successfulAttempts: attempts.filter((attempt) => attempt.ok).length,
      },
      Date.now() - startedAtMs,
    );
  }

  const observabilityEndHealth = getObservabilityHealth(config);
  const runMeta = {
    runId: run.id,
    provider: run.provider,
    requestedModel: resolved.requestedModel,
    resolvedModel: resolved.resolvedModel,
    resolvedFrom: resolved.resolvedFrom,
    maxSteps: run.maxSteps ?? 100,
    maxAttempts,
    runDir,
    startedAt,
    finishedAt,
    harnessContext,
    strictMode,
    repairAttempted,
    repairSucceeded,
    degraded,
    validation: finalValidation ?? {
      schemaOk: false,
      artifactOk: false,
      semanticOk: false,
      issues: [
        {
          code: "run_failed",
          message: runFailureError?.message ?? "Run did not produce a valid final contract",
        },
      ],
      warnings: [],
    },
    budgets: finalBudgets,
    observabilityEnabled: config.observabilityEnabled ?? false,
    observability: {
      provider: "langfuse",
      startHealth: observabilityStartHealth,
      endHealth: observabilityEndHealth,
      startHealthBeforeStartEvent: observabilityStartHealthBefore,
    },
    ...(runFailureError ? { error: runFailureError.message } : {}),
  };
  await fs.writeFile(path.join(runDir, "run_meta.json"), safeJsonStringify(runMeta), "utf-8");

  if (runFailureError) {
    throw runFailureError;
  }
}

type RawLoopApiKeys = {
  google: string;
  openai: string;
  anthropic: string;
};

function readRawLoopApiKeys(): RawLoopApiKeys {
  return {
    google: (
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      ""
    ).trim(),
    openai: (process.env.OPENAI_API_KEY ?? "").trim(),
    anthropic: (process.env.ANTHROPIC_API_KEY ?? "").trim(),
  };
}

function assertRawLoopApiKeys(runs: RunSpec[], keys: RawLoopApiKeys): void {
  const requiredProviders = new Set(runs.map((run) => run.provider));
  if (requiredProviders.has("google") && keys.google.length === 0) {
    throw new Error(
      "Missing GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY env var (required for Gemini runs).",
    );
  }
  if (requiredProviders.has("openai") && keys.openai.length === 0) {
    throw new Error("Missing OPENAI_API_KEY env var (required for GPT runs).");
  }
  if (requiredProviders.has("anthropic") && keys.anthropic.length === 0) {
    throw new Error("Missing ANTHROPIC_API_KEY env var (required for Claude runs).");
  }
}

async function loadRawLoopAnthropicModelIds(
  runRoot: string,
  apiKey: string,
  required: boolean,
): Promise<string[]> {
  if (required === false) {
    return [];
  }
  try {
    const modelsRes = await fetchAnthropicModels(apiKey);
    await fs.writeFile(
      path.join(runRoot, "anthropic_models_raw.json"),
      modelsRes.bodyText,
      "utf-8",
    );
    if (modelsRes.ok === false) {
      return [];
    }
    const parsed = JSON.parse(modelsRes.bodyText) as { data?: Array<{ id?: unknown }> };
    return Array.isArray(parsed.data)
      ? parsed.data.map((model) => String(model.id || "")).filter(Boolean)
      : [];
  } catch (err) {
    await fs.writeFile(path.join(runRoot, "anthropic_models_raw_error.txt"), String(err), "utf-8");
    return [];
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const repoDir = REPO_ROOT;

  const baseConfig = await loadConfig({
    cwd: repoDir,
    env: {
      ...process.env,
      AGENT_WORKING_DIR: repoDir,
      COWORK_DISABLE_BUILTIN_SKILLS: process.env.COWORK_DISABLE_BUILTIN_SKILLS ?? "1",
    },
  });

  const runRootPrefix = SCENARIO_DEFINITIONS[cliArgs.scenario].runRootPrefix;
  const runRoot = path.join(
    baseConfig.outputDirectory || path.join(repoDir, "tmp"),
    `${runRootPrefix}_${safeStamp()}`,
  );
  await ensureDir(runRoot);

  const apiKeys = readRawLoopApiKeys();

  const runs = selectRawLoopRuns(cliArgs);
  assertRawLoopApiKeys(runs, apiKeys);
  const requiredProviders = new Set(runs.map((run) => run.provider));
  const anthropicModelIds = await loadRawLoopAnthropicModelIds(
    runRoot,
    apiKeys.anthropic,
    requiredProviders.has("anthropic"),
  );

  const connectedProviders: ProviderName[] = (
    await getProviderCatalog({
      paths: getAiCoworkerPaths(),
    })
  ).connected.filter(isProviderName);

  for (const [i, run] of runs.entries()) {
    await executeRawLoopRun(run, i + 1, {
      repoDir,
      runRoot,
      cliArgs,
      anthropicModelIds,
      connectedProviders,
    });
  }

  const manifest = {
    createdAt: nowIso(),
    cwd: repoDir,
    runRoot,
    harness: {
      scenario: cliArgs.scenario,
      strictModeOverride: cliArgs.strictModeOverride,
      onlyRunIds: cliArgs.onlyRunIds,
      onlyModels: cliArgs.onlyModels,
    },
    apiKeys: {
      google: maskApiKey(apiKeys.google),
      openai: maskApiKey(apiKeys.openai),
      anthropic: maskApiKey(apiKeys.anthropic),
    },
    runs: runs.map((r) => ({ id: r.id, provider: r.provider, model: r.model })),
  };
  await fs.writeFile(path.join(runRoot, "manifest.json"), safeJsonStringify(manifest), "utf-8");

  console.log(`[raw-loop] wrote traces to: ${runRoot}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
