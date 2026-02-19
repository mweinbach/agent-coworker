#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { generateText as realGenerateText, stepCountIs as realStepCountIs, tool as aiTool } from "ai";
import type { ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import { loadConfig, getModel as realGetModel } from "../src/config";
import { runTurnWithDeps } from "../src/agent";
import { DEFAULT_PROVIDER_OPTIONS } from "../src/providers";
import { loadSubAgentPrompt, loadSystemPromptWithSkills } from "../src/prompt";
import type { AgentConfig, ProviderName, TodoItem } from "../src/types";
import type { ToolContext } from "../src/tools";
import { createAskTool } from "../src/tools/ask";
import { createBashTool } from "../src/tools/bash";
import { createEditTool } from "../src/tools/edit";
import { createGlobTool } from "../src/tools/glob";
import { createGrepTool } from "../src/tools/grep";
import { createMemoryTool } from "../src/tools/memory";
import { createNotebookEditTool } from "../src/tools/notebookEdit";
import { createReadTool } from "../src/tools/read";
import { createSkillTool } from "../src/tools/skill";
import { createSpawnAgentTool } from "../src/tools/spawnAgent";
import { createTodoWriteTool } from "../src/tools/todoWrite";
import { createWebFetchTool } from "../src/tools/webFetch";
import { createWebSearchTool } from "../src/tools/webSearch";
import { createWriteTool } from "../src/tools/write";
import { classifyCommand } from "../src/utils/approval";
import { emitObservabilityEvent } from "../src/observability/otel";
import { buildAiSdkTelemetrySettings, getObservabilityHealth } from "../src/observability/runtime";

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
  reportOnly: boolean;
  scenario: "mixed" | "dcf-model-matrix" | "gpt-skill-reliability";
  onlyRunIds: string[];
  onlyModels: string[];
};

function parseArgs(argv: string[]): RawLoopArgs {
  const args: RawLoopArgs = {
    reportOnly: true,
    scenario: "mixed",
    onlyRunIds: [],
    onlyModels: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report-only") {
      args.reportOnly = true;
      continue;
    }
    if (a === "--scenario") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --scenario");
      if (next !== "mixed" && next !== "dcf-model-matrix" && next !== "gpt-skill-reliability") {
        throw new Error(`Invalid --scenario value: ${next}`);
      }
      args.scenario = next;
      i += 1;
      continue;
    }
    if (a === "--only-run") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --only-run");
      args.onlyRunIds.push(next);
      i += 1;
      continue;
    }
    if (a === "--only-model") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --only-model");
      args.onlyModels.push(next);
      i += 1;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun scripts/run_raw_agent_loops.ts [--report-only] [--scenario mixed|dcf-model-matrix|gpt-skill-reliability] [--only-run <run-id>] [--only-model <model>]"
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  return args;
}

class RateLimiter {
  private nextAllowedAtMs = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait() {
    const now = Date.now();
    const waitMs = this.nextAllowedAtMs - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.nextAllowedAtMs = Date.now() + this.minIntervalMs;
  }
}

type RunTrace = {
  runId: string;
  startedAt: string;
  finishedAt: string;

  config: AgentConfig;
  system: string;
  userPrompt: string;
  inputMessages: ModelMessage[];

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
  providerOptionsOverride?: Record<string, any>;
  requiredToolCalls?: string[];
  requiredFirstNonTodoToolCall?: string;
  requiredSkillBeforeTools?: string;
  guardedToolsBeforeSkill?: string[];
  requiredToolBeforeTools?: string;
  guardedToolsBeforeRequiredTool?: string[];
  prompt: (ctx: PromptContext) => string;
};

function isoSafeNow() {
  return new Date().toISOString();
}

function safeStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function safeJsonStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    v,
    (_k, value) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    },
    2
  );
}

function makeTracedGenerateText(
  steps: TracedStep[],
  scope: string,
  limiter: RateLimiter,
  config: AgentConfig,
  metadata?: Record<string, string | number | boolean | null | undefined>
): typeof realGenerateText {
  const traced = (async (opts: any) => {
    const callerOnStepFinish = opts?.onStepFinish;
    const callerOnFinish = opts?.onFinish;
    const callerPrepareStep = opts?.prepareStep;
    const callerTelemetry = opts?.experimental_telemetry;
    const telemetry = await buildAiSdkTelemetrySettings(config, {
      functionId: `harness.generateText.${scope}`,
      metadata: {
        scope,
        ...(metadata ?? {}),
      },
    });
    const mergedTelemetry = telemetry
      ? {
          ...telemetry,
          ...(callerTelemetry ?? {}),
          metadata: {
            ...(telemetry.metadata ?? {}),
            ...(callerTelemetry?.metadata ?? {}),
          },
        }
      : callerTelemetry;

    return await realGenerateText({
      ...opts,
      // Avoid internal retries that can blow past free-tier request quotas.
      maxRetries: typeof opts?.maxRetries === "number" ? opts.maxRetries : 0,
      ...(mergedTelemetry ? { experimental_telemetry: mergedTelemetry } : {}),
      experimental_include: {
        requestBody: true,
        responseBody: true,
        ...(opts?.experimental_include ?? {}),
      },
      prepareStep: async (...args: any[]) => {
        await limiter.wait();
        if (typeof callerPrepareStep === "function") {
          return await callerPrepareStep(...args);
        }
        return undefined;
      },
      onStepFinish: (stepResult: unknown) => {
        steps.push({ scope, step: stepResult });
        try {
          return callerOnStepFinish?.(stepResult);
        } catch {
          // ignore caller callback errors
        }
      },
      onFinish: (evt: unknown) => {
        try {
          return callerOnFinish?.(evt);
        } catch {
          // ignore caller callback errors
        }
      },
    });
  }) as typeof realGenerateText;

  return traced;
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

function withExecuteGuard(
  original: any,
  shouldBlock: () => boolean,
  errorMessage: string,
  onSuccess?: (input: any, output: any) => void
): any {
  if (!original || typeof original.execute !== "function") return original;
  return aiTool({
    description: String(original.description ?? ""),
    inputSchema: original.inputSchema,
    execute: async (input: any) => {
      if (shouldBlock()) {
        throw new Error(errorMessage);
      }
      const out = await original.execute(input);
      onSuccess?.(input, out);
      return out;
    },
  });
}

function createToolsWithTracing(
  ctx: ToolContext,
  steps: TracedStep[],
  limiter: RateLimiter,
  getModelImpl: typeof realGetModel,
  skillGuard?: SkillGuardConfig,
  prerequisiteToolGuard?: PrerequisiteToolGuardConfig
): Record<string, any> {
  // Capture sub-agent model calls (spawnAgent uses its own generateText invocation).
  const tracedForSubAgent = makeTracedGenerateText(steps, "spawnAgent", limiter, ctx.config, {
    toolName: "spawnAgent",
  });

  const baseTools = {
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    webSearch: createWebSearchTool(ctx),
    webFetch: createWebFetchTool(ctx),
    ask: createAskTool(ctx),
    todoWrite: createTodoWriteTool(ctx),
    spawnAgent: createSpawnAgentTool(ctx, {
      generateText: tracedForSubAgent,
      stepCountIs: realStepCountIs,
      getModel: getModelImpl,
      loadSubAgentPrompt,
      classifyCommand,
    }),
    notebookEdit: createNotebookEditTool(ctx),
    skill: createSkillTool(ctx),
    memory: createMemoryTool(ctx),
  };

  const wrapped: Record<string, any> = { ...baseTools };

  if (skillGuard?.requiredSkillName && skillGuard.guardedToolNames && skillGuard.guardedToolNames.length > 0) {
    let requiredSkillLoaded = false;
    const required = skillGuard.requiredSkillName;
    const guarded = new Set(skillGuard.guardedToolNames);

    wrapped.skill = withExecuteGuard(
      baseTools.skill,
      () => false,
      "",
      (input) => {
        if (input && typeof input.skillName === "string" && input.skillName === required) {
          requiredSkillLoaded = true;
        }
      }
    );

    for (const toolName of guarded) {
      if (toolName === "skill") continue;
      const original = wrapped[toolName];
      wrapped[toolName] = withExecuteGuard(
        original,
        () => !requiredSkillLoaded,
        `Required skill "${required}" must be loaded via the skill tool before calling "${toolName}".`
      );
    }
  }

  if (
    prerequisiteToolGuard?.requiredToolName &&
    prerequisiteToolGuard.guardedToolNames &&
    prerequisiteToolGuard.guardedToolNames.length > 0
  ) {
    let requiredToolCalled = false;
    const requiredTool = prerequisiteToolGuard.requiredToolName;
    const guardedTools = new Set(prerequisiteToolGuard.guardedToolNames);

    if (wrapped[requiredTool]) {
      wrapped[requiredTool] = withExecuteGuard(
        wrapped[requiredTool],
        () => false,
        "",
        () => {
          requiredToolCalled = true;
        }
      );
    }

    for (const toolName of guardedTools) {
      if (toolName === requiredTool) continue;
      const original = wrapped[toolName];
      wrapped[toolName] = withExecuteGuard(
        original,
        () => !requiredToolCalled,
        `Tool "${requiredTool}" must be called before "${toolName}".`
      );
    }
  }

  return wrapped;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function writeTraceFile(filePath: string, trace: RunTrace) {
  await fs.writeFile(filePath, safeJsonStringify(trace), "utf-8");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryDelayMs(err: unknown): number | null {
  const asAny = err as any;

  // Common structured-ish fields.
  const directMs = asAny?.retryAfterMs ?? asAny?.retryDelayMs ?? asAny?.retry_ms;
  if (typeof directMs === "number" && Number.isFinite(directMs) && directMs > 0) return Math.ceil(directMs);

  const directSeconds = asAny?.retryAfterSeconds ?? asAny?.retryDelaySeconds ?? asAny?.retry_after;
  if (typeof directSeconds === "number" && Number.isFinite(directSeconds) && directSeconds > 0) {
    return Math.ceil(directSeconds * 1000);
  }

  const raw = String(err ?? "");

  // Provider error strings commonly include: "Please retry in 28.009230773s."
  const m = raw.match(/retry in\s+([0-9.]+)s/i);
  if (m?.[1]) {
    const seconds = Number(m[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }

  // Or a JSON-ish fragment: "retryDelay\": \"34s\""
  const m2 = raw.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m2?.[1]) {
    const seconds = Number(m2[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }

  // Sometimes: "Retry-After: 30"
  const m3 = raw.match(/retry-after:\s*(\d+)/i);
  if (m3?.[1]) {
    const seconds = Number(m3[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }

  return null;
}

function maskApiKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function safePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
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

async function fetchAnthropicModels(apiKey: string): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  const bodyText = await res.text();
  return { ok: res.ok, status: res.status, bodyText };
}

function resolveAnthropicAlias(
  requestedModel: string,
  availableIds: string[]
): { requestedModel: string; resolvedModel: string; resolvedFrom: "alias" | "passthrough" | "fallback" } {
  if (requestedModel === "claude-4-6-opus") {
    // Pick newest dated opus-4-6 model id when the alias form is used.
    const candidates = availableIds.filter((id) => id.startsWith("claude-opus-4-6-"));
    if (candidates.length > 0) {
      const resolvedModel = candidates.slice().sort().at(-1)!;
      return { requestedModel, resolvedModel, resolvedFrom: "alias" };
    }
    if (availableIds.includes("claude-opus-4-6")) {
      return { requestedModel, resolvedModel: "claude-opus-4-6", resolvedFrom: "alias" };
    }
    return { requestedModel, resolvedModel: "claude-opus-4-6", resolvedFrom: "fallback" };
  }

  if (requestedModel === "claude-4-6-sonnet") {
    const candidates = availableIds.filter((id) => id.startsWith("claude-sonnet-4-6-"));
    if (candidates.length > 0) {
      const resolvedModel = candidates.slice().sort().at(-1)!;
      return { requestedModel, resolvedModel, resolvedFrom: "alias" };
    }
    if (availableIds.includes("claude-sonnet-4-6")) {
      return { requestedModel, resolvedModel: "claude-sonnet-4-6", resolvedFrom: "alias" };
    }
    return { requestedModel, resolvedModel: "claude-sonnet-4-6", resolvedFrom: "fallback" };
  }

  if (requestedModel !== "claude-4-5-haiku") {
    return { requestedModel, resolvedModel: requestedModel, resolvedFrom: "passthrough" };
  }

  // Pick the newest dated haiku-4-5 model id if present.
  const candidates = availableIds.filter((id) => id.startsWith("claude-haiku-4-5-"));
  if (candidates.length > 0) {
    const resolvedModel = candidates.slice().sort().at(-1)!;
    return { requestedModel, resolvedModel, resolvedFrom: "alias" };
  }

  // Reasonable fallback based on known model catalogs (kept as a last-resort).
  return { requestedModel, resolvedModel: "claude-haiku-4-5-20251001", resolvedFrom: "fallback" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(record: Record<string, any> | undefined): Record<string, any> {
  if (!record) return {};
  return JSON.parse(JSON.stringify(record)) as Record<string, any>;
}

function deepMergeRecords(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMergeRecords(out[k] as Record<string, any>, v as Record<string, any>);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function mergeProviderOptions(
  defaults: Record<string, any>,
  override?: Record<string, any>
): Record<string, any> {
  const merged = cloneRecord(defaults);
  if (!override) return merged;
  return deepMergeRecords(merged, override);
}

function buildNvidiaDcfPrompt(runDir: string, model: string, modelGuidance: string): string {
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
3) Use bash to run: python3 build_nvda_dcf.py
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
  primaryFileRequirements: string
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
- Final response must be raw JSON only (no markdown fences) and include "<<END_RUN>>".

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

Final response must be a JSON object:
{ "primary": "<absolute path>", "check": "<absolute path>", "skillName": "${skillName}", "skillToolCalled": true, "end": "<<END_RUN>>" }`;
}

function buildDcfModelMatrixRuns(): RunSpec[] {
  const profiles: Array<{
    id: string;
    provider: ProviderName;
    model: string;
    modelGuidance: string;
    maxSteps: number;
    maxAttempts: number;
    providerOptionsOverride?: Record<string, any>;
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
      id: "dcf-04-google-gemini-3-pro-preview",
      provider: "google",
      model: "gemini-3-pro-preview",
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
    prompt: ({ runDir }) => buildNvidiaDcfPrompt(runDir, profile.model, profile.modelGuidance),
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
            '- Keep content concise and implementation-oriented.',
          ].join("\n")
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
      prompt: ({ runDir }) =>
        buildSkillReliabilityPrompt(
          runDir,
          model,
          "doc",
          "Create a DOCX execution brief as plain text guidance.",
          "docx_execution_brief.txt",
          [
            '- Include a title and exactly 5 numbered implementation steps.',
            '- Mention both "python-docx" and "render_docx.py" explicitly.',
            '- End with a short "Verification" paragraph.',
          ].join("\n")
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
      prompt: ({ runDir }) =>
        buildSkillReliabilityPrompt(
          runDir,
          model,
          "slides",
          "Create a slide deck outline with speaker notes guidance.",
          "slides_outline.md",
          [
            '- Include 6 slides as a numbered list with title + one-line purpose.',
            '- Add a "Speaker Notes Strategy" section with 3 bullets.',
            '- Keep tone internal and practical.',
          ].join("\n")
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
          ].join("\n")
        ),
    },
  ];
}

function computeRetryDelayMs(err: unknown, attempt: number): number {
  const extracted = extractRetryDelayMs(err);
  const backoffBaseMs = 12_000;
  const backoffMs = Math.min(180_000, backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
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
  durationMs?: number
) {
  await emitObservabilityEvent(config, {
    name,
    at,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    attributes: attrs,
  });
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const repoDir = process.cwd();

  const googleApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
  const openaiApiKey = process.env.OPENAI_API_KEY || "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";

  // Force API keys from env so we don't accidentally use older stored keys from ~/.cowork/auth/connections.json.
  const googleProvider = googleApiKey ? createGoogleGenerativeAI({ apiKey: googleApiKey }) : null;
  const openaiProvider = openaiApiKey ? createOpenAI({ apiKey: openaiApiKey }) : null;
  const anthropicProvider = anthropicApiKey ? createAnthropic({ apiKey: anthropicApiKey }) : null;

  const forcedGetModel: typeof realGetModel = (config: AgentConfig, id?: string) => {
    const modelId = id || config.model;
    if (config.provider === "google") {
      if (!googleProvider) {
        throw new Error("Missing GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY env var (required for Gemini runs).");
      }
      return googleProvider(modelId);
    }
    if (config.provider === "openai") {
      if (!openaiProvider) {
        throw new Error("Missing OPENAI_API_KEY env var (required for GPT runs).");
      }
      return openaiProvider(modelId);
    }
    if (config.provider === "anthropic") {
      if (!anthropicProvider) {
        throw new Error("Missing ANTHROPIC_API_KEY env var (required for Claude runs).");
      }
      return anthropicProvider(modelId);
    }
    return realGetModel(config, modelId);
  };

  const baseConfig = await loadConfig({
    cwd: repoDir,
    env: {
      ...process.env,
      AGENT_WORKING_DIR: repoDir,
    },
  });

  const runRootPrefix =
    cliArgs.scenario === "mixed"
      ? "raw-agent-loop_mixed"
      : cliArgs.scenario === "dcf-model-matrix"
        ? "raw-agent-loop_dcf-model-matrix"
        : "raw-agent-loop_gpt-skill-reliability";
  const runRoot = path.join(baseConfig.outputDirectory, `${runRootPrefix}_${safeStamp()}`);
  await ensureDir(runRoot);

  let anthropicModelIds: string[] = [];

  const limiter = new RateLimiter(1000);

  const mixedRuns: RunSpec[] = [
    {
      id: "run-01",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 60,
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

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
      prompt: ({ runDir, repoDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Produce an internal note explaining how command approvals and the bash tool work in this repo.

Steps (must use tools):
1) Use bash to run: pwd
2) Use grep to search for pattern "approveCommand" in path "${repoDir}/src" (caseSensitive=true).
3) Use read to read "${repoDir}/src/tools/bash.ts" (limit=200, offset=1).
4) Use read to read "${repoDir}/src/utils/approval.ts" (limit=240, offset=1).
5) Use write to create "bash_tool_notes.md" with:
- A short overview
- A table listing: approval hook, working directory behavior, timeout defaults, stdout/stderr truncation
- A "Gotchas" section
6) Use edit to replace the exact string "TODO_REPLACE_ME" in "bash_tool_notes.md" with a concrete gotcha you found.
7) Use bash to run: ls -la

Final response must be exactly two lines:
bash_tool_notes: <absolute path>
<<END_RUN>>`,
    },
    {
      id: "run-03",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      maxSteps: 90,
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

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
3) Use bash to run: python3 build_amortization.py
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
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a professional DOCX brief and a text extract for quick inspection.

Steps (must use tools):
1) Use skill to load skillName="doc".
2) Use write to create "build_brief_docx.py" that generates "brief.docx" with:
- Title
- 2 headings
- A bulleted list
- A 2x3 table
The script must also extract plain text from the DOCX into "brief_excerpt.txt".
3) Use bash to run: python3 build_brief_docx.py
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
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

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
3) Use bash to run: python3 build_deck.py
4) Use glob to confirm "deck.pptx" and "deck_outline.txt" exist.
5) Use read to read back "deck_outline.txt" (limit=50, offset=1).

Final response must be exactly three lines:
deck: <absolute path>
outline: <absolute path>
<<END_RUN>>`,
    },
    {
      id: "run-06",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      maxSteps: 110,
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a PDF report and write a small verification file describing it.

Steps (must use tools):
1) Use skill to load skillName="pdf".
2) Use write to create "build_report_pdf.py" that generates "report.pdf" with:
- Title, date, and a short paragraph
- A small table (at least 4 rows)
Also have the script write "report_meta.json" with:
- page_count
- sha256 of the PDF
3) Use bash to run: python3 build_report_pdf.py
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
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Exercise ask + notebookEdit + memory in one run.

Steps (must use tools):
1) Use ask with question "Pick a dataset name" and options ["alpha","beta","gamma","delta"].
2) Use write to create "nb.ipynb" (a minimal notebook JSON) with exactly 1 markdown cell that says "Notebook for <dataset>".
3) Use notebookEdit with editMode="insert" at cellIndex=1 to insert a code cell whose source prints the dataset name.
4) Use memory with action="write", key="runs/run07", content="dataset=<dataset>".
5) Use memory with action="read", key="runs/run07".
6) Use memory with action="search", query="dataset=".
7) Use read to read back "nb.ipynb" (limit=200, offset=1).

Final response must be exactly two lines:
dataset: <dataset>
<<END_RUN>>`,
    },
    {
      id: "run-08",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 120,
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Use a research sub-agent, then write and lightly edit a short report.

Steps (must use tools):
1) Use spawnAgent with agentType="research" and task:
"Find the latest stable Bun release version (as of today) and one authoritative URL. Return JSON: {version, url}."
2) Use webFetch on the returned URL (maxLength=6000).
3) Use write to create "bun_release_report.md" with:
- version and URL
- 3 bullet summary
- A short 'Limitations' section
4) Use edit to replace the exact string "LIMITATIONS_TODO" with a concrete limitation.
5) Use glob with pattern "*.md".
6) Use read to read back "bun_release_report.md" (limit=220, offset=1).

Final response must be exactly two lines:
report: <absolute path>
<<END_RUN>>`,
    },
    {
      id: "run-09",
      provider: "anthropic",
      model: "claude-4-5-haiku",
      maxSteps: 90,
      prompt: ({ runDir, repoDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Create a WebSocket protocol quick reference based on the repo docs.

Steps (must use tools):
1) Use read to read "${repoDir}/docs/websocket-protocol.md" (limit=260, offset=1).
2) Use grep to find lines matching pattern "type: \\\"(client_|server_)\" in path "${repoDir}/docs/websocket-protocol.md".
3) Use write to create "ws_quickref.md" that includes:
- A short introduction
- A table of message/event types you found (name + one-sentence meaning)
4) Use bash to run: wc -l ws_quickref.md

Final response must be exactly two lines:
ws_quickref: <absolute path>
<<END_RUN>>`,
    },
    {
      id: "run-10",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 140,
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

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
5) Use bash to run: python3 build_bundle.py
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
      prompt: ({ runDir }) => `You are running inside workingDirectory="${runDir}". Keep ALL created files inside this working directory.

Task: Demonstrate Claude 4.6 Sonnet tool use with web research.

Steps (must use tools):
1) Use todoWrite to create 3 items and mark exactly one in_progress.
2) Use webSearch for query "HTTP 418 RFC 2324" with maxResults=4.
3) Use write to create "sonnet_web_research.md" containing: title + 3 bullets from search results with URL citations.
4) Use read to read "sonnet_web_research.md" (limit=200, offset=1).
5) Use todoWrite to mark all items completed.

Final response must be JSON with keys run_id, memo, and end="<<END_RUN>>".`,
    },
  ];

  const scenarioRuns =
    cliArgs.scenario === "mixed"
      ? mixedRuns
      : cliArgs.scenario === "dcf-model-matrix"
        ? buildDcfModelMatrixRuns()
        : buildGptSkillReliabilityRuns();
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
      `No runs selected for scenario="${cliArgs.scenario}". Try --only-run/--only-model values that exist in this scenario.`
    );
  }

  const requiredProviders = new Set(runs.map((run) => run.provider));
  if (requiredProviders.has("google") && !googleApiKey) {
    throw new Error("Missing GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY env var (required for Gemini runs).");
  }
  if (requiredProviders.has("openai") && !openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY env var (required for GPT runs).");
  }
  if (requiredProviders.has("anthropic") && !anthropicApiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY env var (required for Claude runs).");
  }

  if (requiredProviders.has("anthropic")) {
    // Cache Anthropic model ids for alias resolution and persist the raw response.
    try {
      const modelsRes = await fetchAnthropicModels(anthropicApiKey);
      await fs.writeFile(path.join(runRoot, "anthropic_models_raw.json"), modelsRes.bodyText, "utf-8");
      if (modelsRes.ok) {
        const parsed = JSON.parse(modelsRes.bodyText) as any;
        anthropicModelIds = Array.isArray(parsed?.data)
          ? parsed.data.map((m: any) => String(m?.id || "")).filter(Boolean)
          : [];
      }
    } catch (err) {
      await fs.writeFile(path.join(runRoot, "anthropic_models_raw_error.txt"), String(err), "utf-8");
      anthropicModelIds = [];
    }
  }

  for (let i = 0; i < runs.length; i++) {
    const runIndex = i + 1;
    const run = runs[i]!;

    const resolved =
      run.provider === "anthropic"
        ? resolveAnthropicAlias(run.model, anthropicModelIds)
        : { requestedModel: run.model, resolvedModel: run.model, resolvedFrom: "passthrough" as const };

    const runDirName = `${run.id}_${run.provider}_${safePathComponent(resolved.resolvedModel)}`;
    const runDir = path.join(runRoot, runDirName);
    await ensureDir(runDir);

    const minIntervalMs = typeof run.minIntervalMs === "number" ? run.minIntervalMs : 1000;
    const runLimiter = run.minIntervalMs ? new RateLimiter(minIntervalMs) : limiter;
    const startedAt = isoSafeNow();
    const startedAtMs = Date.now();

    const env = {
      ...process.env,
      AGENT_WORKING_DIR: runDir,
      AGENT_PROVIDER: run.provider,
      AGENT_MODEL: resolved.resolvedModel,
      AGENT_HARNESS_REPORT_ONLY: cliArgs.reportOnly ? "true" : "false",
    };

    const config = await loadConfig({ cwd: repoDir, env });
    config.providerOptions = mergeProviderOptions(DEFAULT_PROVIDER_OPTIONS as Record<string, any>, run.providerOptionsOverride);
    config.enableMcp = false;
    config.provider = run.provider;
    config.model = resolved.resolvedModel;
    config.subAgentModel = resolved.resolvedModel;
    config.harness = { reportOnly: cliArgs.reportOnly, strictMode: false };

    // Keep memory local to the run folder so artifacts can be captured per-run.
    const localProjectAgentDir = path.join(runDir, ".agent");
    const localUserAgentDir = path.join(runDir, ".agent-user");
    const coworkSkillsDir = config.skillsDirs[1] || "";
    const builtInSkillsDir = path.join(config.builtInDir, "skills");
    config.projectAgentDir = localProjectAgentDir;
    config.userAgentDir = localUserAgentDir;
    config.skillsDirs = [
      path.join(localProjectAgentDir, "skills"),
      coworkSkillsDir,
      path.join(localUserAgentDir, "skills"),
      builtInSkillsDir,
    ].filter(Boolean);
    config.memoryDirs = [path.join(localProjectAgentDir, "memory"), path.join(localUserAgentDir, "memory")];
    config.configDirs = [localProjectAgentDir, localUserAgentDir, config.builtInConfigDir];

    await ensureDir(config.projectAgentDir);
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
      0
    );
    const observabilityStartHealth = getObservabilityHealth(config);

    const { prompt: system, discoveredSkills } = await loadSystemPromptWithSkills(config);

    const userPrompt = run.prompt({ runId: run.id, runDir, repoDir });
    const inputMessages: ModelMessage[] = [{ role: "user", content: userPrompt }];

    await fs.writeFile(path.join(runDir, "prompt.txt"), userPrompt, "utf-8");
    await fs.writeFile(path.join(runDir, "system.txt"), system, "utf-8");
    await fs.writeFile(path.join(runDir, "input_messages.json"), safeJsonStringify(inputMessages), "utf-8");

    const attempts: AttemptMeta[] = [];
    const maxAttempts = run.maxAttempts ?? 5;

    let finalToolLogLines: string[] = [];
    let finalAskEvents: AskEvent[] = [];
    let finalApprovalEvents: ApprovalEvent[] = [];
    let finalTodoEvents: TodoEvent[] = [];
    let finalSteps: TracedStep[] = [];
    let finalRes:
      | {
          text: string;
          reasoningText?: string;
          responseMessages: ModelMessage[];
        }
      | null = null;
    let finalError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStartedAt = isoSafeNow();

      const toolLogLines: string[] = [];
      const askEvents: AskEvent[] = [];
      const approvalEvents: ApprovalEvent[] = [];
      const todoEvents: TodoEvent[] = [];
      const steps: TracedStep[] = [];

      const log = (line: string) => {
        toolLogLines.push(line);
      };

      const askUser = async (question: string, options?: string[]) => {
        const idx = options && options.length > 0 ? (runIndex - 1) % options.length : 0;
        const answer = options && options.length > 0 ? options[idx]! : "OK";
        askEvents.push({ at: isoSafeNow(), question, options, answer });
        return answer;
      };

      const approveCommand = async (command: string) => {
        const approved = true;
        approvalEvents.push({ at: isoSafeNow(), command, approved });
        return approved;
      };

      const updateTodos = (todos: TodoItem[]) => {
        todoEvents.push({ at: isoSafeNow(), todos });
      };

      const tracedMainGenerateText = makeTracedGenerateText(steps, "main", runLimiter, config, {
        runId: run.id,
        scenario: cliArgs.scenario,
      });
      const tracedFinalizeGenerateText = makeTracedGenerateText(steps, "finalize", runLimiter, config, {
        runId: run.id,
        scenario: cliArgs.scenario,
      });

      const createToolsOverride = (ctx: ToolContext) =>
        createToolsWithTracing(
          ctx,
          steps,
          runLimiter,
          forcedGetModel,
          {
            requiredSkillName: run.requiredSkillBeforeTools,
            guardedToolNames: run.guardedToolsBeforeSkill,
          },
          {
            requiredToolName: run.requiredToolBeforeTools,
            guardedToolNames: run.guardedToolsBeforeRequiredTool,
          }
        );

      try {
        const res = await runTurnWithDeps(
          {
            config,
            system,
            messages: inputMessages,
            log,
            askUser,
            approveCommand,
            updateTodos,
            discoveredSkills,
            maxSteps: run.maxSteps ?? 100,
            enableMcp: false,
            telemetryContext: {
              functionId: "harness.runTurn",
              metadata: {
                runId: run.id,
                scenario: cliArgs.scenario,
                attempt,
              },
            },
          },
          {
            generateText: tracedMainGenerateText as any,
            createTools: createToolsOverride as any,
            getModel: forcedGetModel as any,
          }
        );

        if (Array.isArray(run.requiredToolCalls) && run.requiredToolCalls.length > 0) {
          const tracedToolCalls = collectTracedToolCallNames(steps);
          const missing = run.requiredToolCalls.filter((toolName) => {
            const prefix = `tool> ${toolName} `;
            if (toolLogLines.some((line) => line.startsWith(prefix))) return false;
            return !tracedToolCalls.includes(toolName);
          });
          if (missing.length > 0) {
            throw new Error(`Missing required tool call(s): ${missing.join(", ")}`);
          }
        }

        if (run.requiredFirstNonTodoToolCall) {
          const tracedToolCalls = collectTracedToolCallNames(steps);
          const nonTodoCalls = tracedToolCalls.filter((name) => name !== "todoWrite");
          const first = nonTodoCalls[0] ?? "";
          if (first !== run.requiredFirstNonTodoToolCall) {
            throw new Error(
              `First non-todo tool call must be "${run.requiredFirstNonTodoToolCall}", got "${first || "none"}".`
            );
          }
        }

        let finalText = String(res?.text ?? "");
        let finalReasoningText = res?.reasoningText;
        let finalResponseMessages = (res?.responseMessages ?? []) as ModelMessage[];

        // Ensure we always end with a final response (some runs may stop mid-tool-loop).
        if (!finalText.includes("<<END_RUN>>")) {
          const finalizeMessages: ModelMessage[] = [
            ...inputMessages,
            ...finalResponseMessages,
            {
              role: "user",
              content:
                "You did not provide the required final response. Provide the final response now, do NOT call tools, and end with <<END_RUN>>.",
            },
          ];

          const finalized = await tracedFinalizeGenerateText({
            model: forcedGetModel(config),
            system,
            messages: finalizeMessages,
            providerOptions: config.providerOptions,
            stopWhen: realStepCountIs(1),
          } as any);

          const finalizedText = String(finalized?.text ?? "");
          if (finalizedText.trim()) finalText = finalizedText;
          if (typeof finalized?.reasoningText === "string") finalReasoningText = finalized.reasoningText;
          const moreMsgs = (finalized?.response?.messages || []) as ModelMessage[];
          if (moreMsgs.length > 0) finalResponseMessages = [...finalResponseMessages, ...moreMsgs];
        }

        finalRes = {
          text: finalText,
          reasoningText: finalReasoningText,
          responseMessages: finalResponseMessages,
        };
        finalError = null;

        finalToolLogLines = toolLogLines;
        finalAskEvents = askEvents;
        finalApprovalEvents = approvalEvents;
        finalTodoEvents = todoEvents;
        finalSteps = steps;

        attempts.push({
          attempt,
          startedAt: attemptStartedAt,
          finishedAt: isoSafeNow(),
          ok: true,
        });

        // Save an attempt trace as well for completeness.
        const attemptTrace: RunTrace = {
          runId: run.id,
          startedAt,
          finishedAt: isoSafeNow(),
          config,
          system,
          userPrompt,
          inputMessages,
          toolLogLines,
          askEvents,
          approvalEvents,
          todoEvents,
          steps,
          result: {
            text: finalRes.text,
            reasoningText: finalRes.reasoningText,
            responseMessages: finalRes.responseMessages as any[],
            error: undefined,
          },
        };
        await writeTraceFile(path.join(runDir, `trace_attempt-${pad2(attempt)}.json`), attemptTrace);
        break;
      } catch (err) {
        finalRes = null;
        finalError = err;

        const delayMs = computeRetryDelayMs(err, attempt);
        attempts.push({
          attempt,
          startedAt: attemptStartedAt,
          finishedAt: isoSafeNow(),
          ok: false,
          error: String(err),
          retryDelayMs: delayMs,
        });

        const attemptTrace: RunTrace = {
          runId: run.id,
          startedAt,
          finishedAt: isoSafeNow(),
          config,
          system,
          userPrompt,
          inputMessages,
          toolLogLines,
          askEvents,
          approvalEvents,
          todoEvents,
          steps,
          result: {
            text: "",
            reasoningText: undefined,
            responseMessages: [],
            error: String(err),
          },
        };
        await writeTraceFile(path.join(runDir, `trace_attempt-${pad2(attempt)}.json`), attemptTrace);

        await sleep(delayMs);
      }
    }

    const finishedAt = isoSafeNow();

    const trace: RunTrace = {
      runId: run.id,
      startedAt,
      finishedAt,
      config,
      system,
      userPrompt,
      inputMessages,
      toolLogLines: finalToolLogLines,
      askEvents: finalAskEvents,
      approvalEvents: finalApprovalEvents,
      todoEvents: finalTodoEvents,
      steps: finalSteps,
      result: {
        text: finalRes?.text ?? "",
        reasoningText: finalRes?.reasoningText,
        responseMessages: (finalRes?.responseMessages ?? []) as any[],
        error: finalError ? String(finalError) : undefined,
      },
    };

    await writeTraceFile(path.join(runDir, "trace.json"), trace);

    await fs.writeFile(path.join(runDir, "attempts.json"), safeJsonStringify(attempts), "utf-8");
    await fs.writeFile(path.join(runDir, "tool-log.txt"), finalToolLogLines.join("\n"), "utf-8");
    await fs.writeFile(path.join(runDir, "final.txt"), trace.result.text ?? "", "utf-8");
    await fs.writeFile(path.join(runDir, "final_reasoning.txt"), trace.result.reasoningText ?? "", "utf-8");
    await fs.writeFile(path.join(runDir, "response_messages.json"), safeJsonStringify(trace.result.responseMessages), "utf-8");

    const artifacts = await collectArtifacts(runDir);
    await fs.writeFile(path.join(runDir, "artifacts_index.json"), safeJsonStringify(artifacts), "utf-8");

    const runFailureError =
      !finalRes && finalError ? new Error(`Run ${run.id} failed after ${maxAttempts} attempts: ${String(finalError)}`) : undefined;

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
        Date.now() - startedAtMs
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
        Date.now() - startedAtMs
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

  const manifest = {
    createdAt: isoSafeNow(),
    cwd: repoDir,
    runRoot,
    harness: {
      scenario: cliArgs.scenario,
      reportOnly: cliArgs.reportOnly,
      onlyRunIds: cliArgs.onlyRunIds,
      onlyModels: cliArgs.onlyModels,
    },
    apiKeys: {
      google: maskApiKey(googleApiKey),
      openai: maskApiKey(openaiApiKey),
      anthropic: maskApiKey(anthropicApiKey),
    },
    runs: runs.map((r) => ({ id: r.id, provider: r.provider, model: r.model })),
  };
  await fs.writeFile(path.join(runRoot, "manifest.json"), safeJsonStringify(manifest), "utf-8");

  console.log(`[raw-loop] wrote traces to: ${runRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
