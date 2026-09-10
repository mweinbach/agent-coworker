#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

import { runTurnWithDeps } from "../../../src/agent";
import { loadConfig } from "../../../src/config";
import { getAiCoworkerPaths } from "../../../src/connect";
import { emitObservabilityEvent } from "../../../src/observability/otel";
import { getObservabilityHealth } from "../../../src/observability/runtime";
import { loadSystemPromptWithSkills } from "../../../src/prompt";
import { DEFAULT_PROVIDER_OPTIONS } from "../../../src/providers";
import { getProviderCatalog } from "../../../src/providers/connectionCatalog";
import { normalizeHarnessContextPayload } from "../../../src/sessionContext/HarnessContextStore";
import { ensureDefaultGlobalSkillsReady } from "../../../src/skills/defaultGlobalSkills";
import type { ToolContext } from "../../../src/tools";
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
  isScenario,
  type PromptContext,
  type RunSpec,
  SCENARIO_DEFINITIONS,
  type Scenario,
  selectRawLoopRuns,
} from "./rawLoopScenarios";
import {
  assertRawLoopToolRequirements,
  buildRawLoopBudgetSummary,
  countObservedLoopSteps,
  createRawLoopAgentControl,
  createToolsWithTracing,
  type TracedStep,
} from "./rawLoopTools";
import {
  nowIso,
  safeJsonStringify,
  safePathComponent,
  safeStamp,
  serializeRawLoopTrace,
} from "./rawLoopUtils";
import {
  type FinalContractValidationResult,
  validateWithOptionalRepair,
} from "./rawLoopValidation";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

type JsonRecord = Record<string, unknown>;

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

type DiscoveredSkills = Awaited<ReturnType<typeof loadSystemPromptWithSkills>>["discoveredSkills"];

/** Everything a single attempt records about the turn it ran. */
type AttemptTrace = {
  toolLogLines: string[];
  askEvents: AskEvent[];
  approvalEvents: ApprovalEvent[];
  todoEvents: TodoEvent[];
  steps: TracedStep[];
};

type RunTrace = AttemptTrace & {
  runId: string;
  startedAt: string;
  finishedAt: string;

  config: AgentConfig;
  system: string;
  userPrompt: string;
  inputMessages: ModelMessage[];
  harnessContext: HarnessContextState | null;

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

type RawLoopAttemptOutcome = AttemptTrace & {
  ok: boolean;
  error?: string;
  text: string;
  reasoningText?: string;
  responseMessages: ModelMessage[];
  validation: FinalContractValidationResult | null;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  degraded: boolean;
  budgets: ReturnType<typeof buildRawLoopBudgetSummary>;
};

type AttemptResult =
  | { ok: true; text: string; reasoningText?: string; responseMessages: ModelMessage[] }
  | { ok: false; error: string };

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

function cloneRecord(record: JsonRecord | undefined): JsonRecord {
  if (!record) return {};
  return JSON.parse(JSON.stringify(record)) as JsonRecord;
}

function deepMergeRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = deepMergeRecords(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function positiveRetryNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isFinite(value) === false || value <= 0) {
    return null;
  }
  return value;
}

const RETRY_DELAY_PATTERNS: RegExp[] = [
  /retry in\s+([0-9.]+)s/i,
  /retryDelay"\s*:\s*"(\d+)s"/i,
  /retry-after:\s*(\d+)/i,
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
  for (const pattern of RETRY_DELAY_PATTERNS) {
    const match = raw.match(pattern);
    const seconds = positiveRetryNumber(match === null ? null : Number(match[1]));
    if (seconds !== null) {
      return Math.ceil(seconds * 1000);
    }
  }

  return null;
}

function computeRetryDelayMs(err: unknown, attempt: number): number {
  const extracted = extractRetryDelayMs(err);
  const backoffBaseMs = 12_000;
  const backoffMs = Math.min(180_000, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  const target = extracted ? Math.max(extracted, backoffMs) : backoffMs;
  const jitterMs = Math.floor(Math.random() * 1500);
  return target + jitterMs;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeTraceFile(filePath: string, trace: RunTrace): Promise<void> {
  await fs.writeFile(filePath, serializeRawLoopTrace(trace), "utf-8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(entryPath)));
      continue;
    }
    if (entry.isFile()) out.push(entryPath);
  }
  return out;
}

async function collectArtifacts(runDir: string): Promise<ArtifactEntry[]> {
  const absFiles = (await listFilesRecursive(runDir)).sort();
  const entries: ArtifactEntry[] = [];
  for (const absPath of absFiles) {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) continue;
    const buffer = await fs.readFile(absPath);
    entries.push({
      path: path.relative(runDir, absPath),
      bytes: stat.size,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      mtimeMs: stat.mtimeMs,
    });
  }
  return entries;
}

function buildRunTrace(
  base: RunTraceBase,
  fields: AttemptTrace,
  result: RunTrace["result"],
  finishedAt = nowIso(),
): RunTrace {
  return { ...base, ...fields, finishedAt, result };
}

async function writeRunInputs(
  runDir: string,
  inputs: {
    userPrompt: string;
    system: string;
    inputMessages: ModelMessage[];
    harnessContext: HarnessContextState;
  },
): Promise<void> {
  await fs.writeFile(path.join(runDir, "prompt.txt"), inputs.userPrompt, "utf-8");
  await fs.writeFile(path.join(runDir, "system.txt"), inputs.system, "utf-8");
  await fs.writeFile(
    path.join(runDir, "input_messages.json"),
    safeJsonStringify(inputs.inputMessages),
    "utf-8",
  );
  await fs.writeFile(
    path.join(runDir, "harness_context.json"),
    safeJsonStringify(inputs.harnessContext),
    "utf-8",
  );
}

async function writeAttemptTrace(
  runDir: string,
  attempt: number,
  base: RunTraceBase,
  outcome: RawLoopAttemptOutcome,
): Promise<void> {
  await writeTraceFile(
    path.join(runDir, `trace_attempt-${String(attempt).padStart(2, "0")}.json`),
    buildRunTrace(base, outcome, {
      text: outcome.text,
      reasoningText: outcome.reasoningText,
      responseMessages: outcome.responseMessages,
      error: outcome.error,
    }),
  );
}

async function writeRunArtifacts(
  runDir: string,
  trace: RunTrace,
  attempts: AttemptMeta[],
): Promise<void> {
  await writeTraceFile(path.join(runDir, "trace.json"), trace);
  await fs.writeFile(path.join(runDir, "attempts.json"), safeJsonStringify(attempts), "utf-8");
  await fs.writeFile(path.join(runDir, "tool-log.txt"), trace.toolLogLines.join("\n"), "utf-8");
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
  await fs.writeFile(
    path.join(runDir, "artifacts_index.json"),
    safeJsonStringify(await collectArtifacts(runDir)),
    "utf-8",
  );
}

/** Loads config for one run and points every stateful path inside the run dir. */
async function prepareRunConfig(opts: {
  run: RunSpec;
  repoDir: string;
  runDir: string;
  cliArgs: RawLoopArgs;
}): Promise<AgentConfig> {
  const env = {
    ...process.env,
    AGENT_WORKING_DIR: opts.runDir,
    AGENT_PROVIDER: opts.run.provider,
    AGENT_MODEL: opts.run.model,
    COWORK_DISABLE_BUILTIN_SKILLS: process.env.COWORK_DISABLE_BUILTIN_SKILLS ?? "1",
  };

  const config = await loadConfig({ cwd: opts.repoDir, env });
  await ensureDefaultGlobalSkillsReady({
    env,
    config,
    log: (line) => {
      console.warn(`[default-skills] ${line}`);
    },
  });

  // The harness measures harness defaults, not whatever provider options the
  // machine running it happens to have configured.
  config.providerOptions = cloneRecord(
    DEFAULT_PROVIDER_OPTIONS as JsonRecord,
  ) as AgentConfig["providerOptions"];
  applyRawLoopToolSurfaceConfig(config, opts.run.provider);
  config.enableMcp = false;
  config.provider = opts.run.provider;
  config.model = opts.run.model;
  config.preferredChildModel = opts.run.model;
  config.harness = resolveRawLoopHarnessConfig(config.harness, opts.cliArgs);

  // Keep memory local to the run folder so artifacts can be captured per-run.
  const localProjectCoworkDir = path.join(opts.runDir, ".cowork");
  const localUserCoworkDir = path.join(opts.runDir, ".cowork-user");
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
  return config;
}

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
  scenario: Scenario;
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

  const trace: AttemptTrace = {
    toolLogLines: [],
    askEvents: [],
    approvalEvents: [],
    todoEvents: [],
    steps: [],
  };
  const { toolLogLines, askEvents, approvalEvents, todoEvents, steps } = trace;
  let validation: FinalContractValidationResult | null = null;
  let repairAttempted = false;
  let repairSucceeded = false;
  let degraded = false;
  let totalSteps = 0;

  const log = (line: string) => {
    toolLogLines.push(line);
  };

  const askUser = async (question: string, options?: string[]) => {
    const optionCount = options?.length ?? 0;
    const index = optionCount > 0 ? (runIndex - 1) % optionCount : 0;
    const answer = options?.[index] ?? "OK";
    askEvents.push({ at: nowIso(), question, options, answer });
    return answer;
  };

  const approveCommand = async (command: string) => {
    approvalEvents.push({ at: nowIso(), command, approved: true });
    return true;
  };

  const updateTodos = (todos: TodoItem[]) => {
    todoEvents.push({ at: nowIso(), todos });
  };

  const createToolsOverride = (ctx: ToolContext) =>
    createToolsWithTracing(ctx, steps, {
      requiredToolName: run.requiredToolBeforeTools,
      guardedToolNames: run.guardedToolsBeforeRequiredTool,
    });

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

  const buildOutcome = (result: AttemptResult): RawLoopAttemptOutcome => ({
    ...trace,
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    text: result.ok ? result.text : "",
    reasoningText: result.ok ? result.reasoningText : undefined,
    responseMessages: result.ok ? result.responseMessages : [],
    validation,
    repairAttempted,
    repairSucceeded,
    degraded,
    budgets: buildRawLoopBudgetSummary(toolLogLines, totalSteps, repairAttempted ? 1 : 0),
  });

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
              metadata: { runId: run.id, scenario, attempt },
            },
          },
          { createTools: createToolsOverride },
        );
      } finally {
        totalSteps += countObservedLoopSteps(mainStepNumbers);
      }
    })();

    assertRawLoopToolRequirements(run, steps, toolLogLines);

    const validationOutcome = await validateWithOptionalRepair({
      finalText: res.text,
      runDir,
      trace,
      contract: run.finalContract,
      strictMode,
      repairFinalOutput: async () => {
        const finalizeMessages: ModelMessage[] = [
          ...inputMessages,
          ...res.responseMessages,
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
              { createTools: () => ({}) },
            );
          } finally {
            totalSteps += countObservedLoopSteps(repairStepNumbers);
          }
        })();

        return {
          finalText: finalized.text.trim() || res.text,
          data: {
            reasoningText:
              typeof finalized.reasoningText === "string"
                ? finalized.reasoningText
                : res.reasoningText,
            responseMessages: finalized.responseMessages,
          },
        };
      },
    });

    validation = validationOutcome.validationResult;
    repairAttempted = validationOutcome.repairAttempted;
    repairSucceeded = validationOutcome.repairSucceeded;
    degraded = validationOutcome.degraded;

    let reasoningText = res.reasoningText;
    let responseMessages = res.responseMessages;
    const repairData = validationOutcome.repairData;
    if (repairData !== undefined) {
      reasoningText = repairData.reasoningText;
      if (repairData.responseMessages.length > 0) {
        responseMessages = [...responseMessages, ...repairData.responseMessages];
      }
    }

    if (validation.ok === false) {
      return buildOutcome({
        ok: false,
        error: `Final contract validation failed: ${validation.issues
          .map((entry) => entry.message)
          .join("; ")}`,
      });
    }

    return buildOutcome({
      ok: true,
      text: validationOutcome.finalText,
      reasoningText,
      responseMessages,
    });
  } catch (error) {
    return buildOutcome({ ok: false, error: String(error) });
  }
}

type RunProgress = {
  attempts: AttemptMeta[];
  maxAttempts: number;
  trace: AttemptTrace;
  validation: FinalContractValidationResult | null;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  degraded: boolean;
  budgets: ReturnType<typeof buildRawLoopBudgetSummary>;
  result: { text: string; reasoningText?: string; responseMessages: ModelMessage[] } | null;
  error: unknown;
};

function buildAttemptMeta(opts: {
  attempt: number;
  startedAt: string;
  outcome: RawLoopAttemptOutcome;
  retryDelayMs: number | undefined;
}): AttemptMeta {
  return {
    attempt: opts.attempt,
    startedAt: opts.startedAt,
    finishedAt: nowIso(),
    ok: opts.outcome.ok,
    ...(opts.outcome.error === undefined ? {} : { error: opts.outcome.error }),
    ...(opts.retryDelayMs === undefined ? {} : { retryDelayMs: opts.retryDelayMs }),
  };
}

function recordAttemptOutcome(progress: RunProgress, outcome: RawLoopAttemptOutcome): void {
  progress.trace = outcome;
  progress.validation = outcome.validation;
  progress.repairAttempted = outcome.repairAttempted;
  progress.repairSucceeded = outcome.repairSucceeded;
  progress.degraded = outcome.degraded;
  progress.budgets = outcome.budgets;
  progress.result = outcome.ok
    ? {
        text: outcome.text,
        reasoningText: outcome.reasoningText,
        responseMessages: outcome.responseMessages,
      }
    : null;
  progress.error = outcome.ok ? null : outcome.error;
}

async function executeRunAttempts(
  args: {
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
    scenario: Scenario;
    traceBase: RunTraceBase;
  },
  maxAttempts: number,
): Promise<RunProgress> {
  const progress: RunProgress = {
    attempts: [],
    maxAttempts,
    trace: { toolLogLines: [], askEvents: [], approvalEvents: [], todoEvents: [], steps: [] },
    validation: null,
    repairAttempted: false,
    repairSucceeded: false,
    degraded: false,
    budgets: buildRawLoopBudgetSummary([], 0, 0),
    result: null,
    error: null,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = nowIso();
    const outcome = await executeRawLoopAttempt({ ...args, attempt });
    const retryDelayMs = outcome.ok
      ? undefined
      : computeRetryDelayMs(outcome.error ?? new Error("Raw-loop attempt failed"), attempt);
    progress.attempts.push(buildAttemptMeta({ attempt, startedAt, outcome, retryDelayMs }));
    recordAttemptOutcome(progress, outcome);
    await writeAttemptTrace(args.runDir, attempt, args.traceBase, outcome);

    if (outcome.ok) return progress;
    if (attempt < maxAttempts) {
      await sleep(retryDelayMs ?? 0);
    }
  }

  return progress;
}

async function executeRawLoopRun(
  run: RunSpec,
  runIndex: number,
  opts: {
    repoDir: string;
    runRoot: string;
    cliArgs: RawLoopArgs;
    connectedProviders: ProviderName[];
  },
): Promise<void> {
  const { repoDir, runRoot, cliArgs, connectedProviders } = opts;
  const runDir = path.join(runRoot, `${run.id}_${run.provider}_${safePathComponent(run.model)}`);
  await ensureDir(runDir);

  const startedAt = nowIso();
  const startedAtMs = Date.now();
  const config = await prepareRunConfig({ run, repoDir, runDir, cliArgs });
  const maxAttempts = run.maxAttempts ?? 5;
  const strictMode = config.harness?.strictMode ?? false;

  const observabilityStartHealthBefore = getObservabilityHealth(config);
  await emitObservabilityEvent(config, {
    name: "harness.run.started",
    at: startedAt,
    status: "ok",
    durationMs: 0,
    attributes: {
      runId: run.id,
      provider: run.provider,
      model: run.model,
      scenario: cliArgs.scenario,
      maxAttempts,
      maxSteps: run.maxSteps ?? 100,
    },
  });
  const observabilityStartHealth = getObservabilityHealth(config);

  const { prompt: system, discoveredSkills } = await loadSystemPromptWithSkills(config);
  const promptContext: PromptContext = { runId: run.id, runDir, repoDir };
  const userPrompt = run.prompt(promptContext);
  const inputMessages: ModelMessage[] = [{ role: "user", content: userPrompt }];
  const harnessContext = buildRawLoopHarnessContext(
    run,
    cliArgs.scenario,
    promptContext,
    startedAt,
  );
  await writeRunInputs(runDir, { userPrompt, system, inputMessages, harnessContext });

  const traceBase: RunTraceBase = {
    runId: run.id,
    startedAt,
    config,
    system,
    userPrompt,
    inputMessages,
    harnessContext,
  };
  const progress = await executeRunAttempts(
    {
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
      traceBase,
    },
    maxAttempts,
  );

  const finishedAt = nowIso();
  const trace = buildRunTrace(
    traceBase,
    progress.trace,
    {
      text: progress.result?.text ?? "",
      reasoningText: progress.result?.reasoningText,
      responseMessages: progress.result?.responseMessages ?? [],
      error: progress.error ? String(progress.error) : undefined,
    },
    finishedAt,
  );
  await writeRunArtifacts(runDir, trace, progress.attempts);

  const runFailureError =
    progress.result === null && progress.error
      ? new Error(`Run ${run.id} failed after ${maxAttempts} attempts: ${String(progress.error)}`)
      : undefined;
  const durationMs = Date.now() - startedAtMs;

  await emitObservabilityEvent(
    config,
    runFailureError
      ? {
          name: "harness.run.failed",
          at: finishedAt,
          status: "error",
          durationMs,
          attributes: {
            runId: run.id,
            provider: run.provider,
            model: run.model,
            scenario: cliArgs.scenario,
            maxAttempts,
          },
        }
      : {
          name: "harness.run.completed",
          at: finishedAt,
          status: "ok",
          durationMs,
          attributes: {
            runId: run.id,
            provider: run.provider,
            model: run.model,
            scenario: cliArgs.scenario,
            attempts: progress.attempts.length,
            successfulAttempts: progress.attempts.filter((entry) => entry.ok).length,
          },
        },
  );

  const runMeta = {
    runId: run.id,
    provider: run.provider,
    model: run.model,
    maxSteps: run.maxSteps ?? 100,
    maxAttempts,
    runDir,
    startedAt,
    finishedAt,
    harnessContext,
    strictMode,
    repairAttempted: progress.repairAttempted,
    repairSucceeded: progress.repairSucceeded,
    degraded: progress.degraded,
    validation: progress.validation ?? {
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
    budgets: progress.budgets,
    observabilityEnabled: config.observabilityEnabled ?? false,
    observability: {
      provider: "langfuse",
      startHealth: observabilityStartHealth,
      endHealth: getObservabilityHealth(config),
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

async function main(): Promise<void> {
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

  const { runRootPrefix } = SCENARIO_DEFINITIONS[cliArgs.scenario];
  const runRoot = path.join(
    baseConfig.outputDirectory || path.join(repoDir, "tmp"),
    `${runRootPrefix}_${safeStamp()}`,
  );
  await ensureDir(runRoot);

  const apiKeys = readRawLoopApiKeys();
  const runs = selectRawLoopRuns(cliArgs);
  assertRawLoopApiKeys(runs, apiKeys);

  const connectedProviders: ProviderName[] = (
    await getProviderCatalog({ paths: getAiCoworkerPaths() })
  ).connected.filter(isProviderName);

  for (const [index, run] of runs.entries()) {
    await executeRawLoopRun(run, index + 1, {
      repoDir,
      runRoot,
      cliArgs,
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
    runs: runs.map((run) => ({ id: run.id, provider: run.provider, model: run.model })),
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
