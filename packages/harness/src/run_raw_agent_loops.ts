#!/usr/bin/env bun

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parseArgs as parseNodeArgs } from "node:util";

import { hostPlatform } from "../../../src/platform/host";
import type {
  AgentConfig,
  HarnessContextPayload,
  HarnessContextState,
  ProviderName,
  TodoItem,
} from "../../../src/types";
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
  type TracedStep,
} from "./rawLoopTools";
import {
  nowIso,
  safeJsonStringify,
  safePathComponent,
  safeStamp,
  serializeRawLoopTrace,
} from "./rawLoopUtils";
import { validateWithOptionalRepair } from "./rawLoopValidation";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

type JsonRecord = Record<string, unknown>;

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

export function applyRawLoopToolSurfaceConfig(config: AgentConfig, provider: ProviderName): void {
  if (provider === "google") {
    config.providerOptions = deepMergeRecords(cloneRecord(config.providerOptions as JsonRecord), {
      google: { nativeWebSearch: false },
    }) as AgentConfig["providerOptions"];
  }
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

function normalizeHarnessContextPayload(
  payload: HarnessContextPayload,
  updatedAt: string,
): HarnessContextState {
  return {
    runId: payload.runId.trim(),
    ...(payload.taskId ? { taskId: payload.taskId.trim() } : {}),
    objective: payload.objective.trim(),
    acceptanceCriteria: payload.acceptanceCriteria.map((item) => item.trim()),
    constraints: payload.constraints.map((item) => item.trim()),
    ...(payload.metadata ? { metadata: { ...payload.metadata } } : {}),
    updatedAt,
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

function resolveCoworkServerBinary(): string {
  const exe = hostPlatform() === "win32" ? "cowork-server.exe" : "cowork-server";
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(REPO_ROOT, "target", profile, exe);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Compiled ${exe} binary not found in target/{release,debug}. Run \`cargo build -p cowork-server\` first.`,
  );
}

export type ServerTurnTraceResult = {
  text: string;
  steps: TracedStep[];
  toolLogLines: string[];
  todos: TodoItem[];
  totalSteps: number;
};

export async function runRawLoopTurnViaServer(opts: {
  wsUrl: string;
  cwd: string;
  provider: ProviderName;
  model: string;
  prompt: string;
  harnessContext?: HarnessContextState;
  providerOptions?: Record<string, unknown>;
}): Promise<ServerTurnTraceResult> {
  const ws = new WebSocket(opts.wsUrl, "cowork.jsonrpc.v1");
  const steps: TracedStep[] = [];
  const toolLogLines: string[] = [];
  let todos: TodoItem[] = [];
  let finalText = "";
  let totalSteps = 0;

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  let turnDoneResolve: (() => void) | null = null;
  let turnDoneReject: ((err: Error) => void) | null = null;
  const turnDonePromise = new Promise<void>((resolve, reject) => {
    turnDoneResolve = resolve;
    turnDoneReject = reject;
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (typeof msg.id === "number" && !("method" in msg)) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message ?? "JSON-RPC error"));
        else waiter.resolve(msg.result);
      }
      return;
    }
    if ("id" in msg && typeof msg.method === "string") {
      if (msg.method === "item/commandExecution/requestApproval") {
        ws.send(JSON.stringify({ id: msg.id, result: { decision: "accept" } }));
      } else if (msg.method === "item/tool/requestUserInput") {
        ws.send(JSON.stringify({ id: msg.id, result: { answers: {} } }));
      }
      return;
    }
    if (msg.method === "item/started" && msg.params?.item?.type === "toolCall") {
      const toolName = String(msg.params.item.name ?? "tool");
      const input = msg.params.item.input ?? {};
      steps.push({ scope: "tool-call", step: { type: "tool-call", toolName, input } });
      toolLogLines.push(`tool> ${toolName} ${JSON.stringify(input)}`);
      totalSteps += 1;
    } else if (msg.method === "item/completed" && msg.params?.item?.type === "agentMessage") {
      finalText = String(msg.params.item.text ?? finalText);
      totalSteps = Math.max(totalSteps, 1);
    } else if (msg.method === "cowork/todos" && Array.isArray(msg.params?.todos)) {
      todos = msg.params.todos as TodoItem[];
    } else if (msg.method === "turn/completed") {
      if (msg.params?.turn?.status === "failed") {
        turnDoneReject?.(new Error(msg.params?.turn?.error?.message ?? "Turn failed"));
      } else {
        turnDoneResolve?.();
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to connect to cowork-server WebSocket"));
  });

  const rpc = <T = Record<string, unknown>>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolve as (val: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    });

  try {
    await rpc("initialize", {
      clientInfo: { name: "cowork-raw-loop-harness", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));

    await rpc("cowork/session/defaults/apply", {
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
      config: {
        advancedMemory: false,
        ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      },
    });
    const started = await rpc<{ thread: { id: string } }>("thread/start", {
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
    });
    const threadId = String(started.thread.id);
    if (opts.harnessContext) {
      const { updatedAt: _omitUpdatedAt, ...contextPayload } = opts.harnessContext;
      await rpc("cowork/session/harnessContext/set", {
        threadId,
        context: contextPayload,
      });
    }
    await rpc("turn/start", {
      threadId,
      clientMessageId: crypto.randomUUID(),
      input: [{ type: "text", text: opts.prompt }],
    });
    await turnDonePromise;
    return { text: finalText, steps, toolLogLines, todos, totalSteps };
  } finally {
    ws.close();
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const selectedRuns = selectRawLoopRuns({
    scenario: cliArgs.scenario,
    onlyRunIds: cliArgs.onlyRunIds,
    onlyModels: cliArgs.onlyModels,
  });

  const sessionStamp = safeStamp();
  const rootOutDir = path.join(REPO_ROOT, "output", "raw-loop-runs", sessionStamp);
  await fs.mkdir(rootOutDir, { recursive: true });

  const serverBin = resolveCoworkServerBinary();
  const serverProc = spawn(
    serverBin,
    ["--dir", rootOutDir, "--host", "127.0.0.1", "--port", "0", "--yolo", "--json"],
    {
      cwd: rootOutDir,
      env: { ...process.env, COWORK_DESKTOP_PARENT_MANAGED: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );

  const wsUrl = await new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProc.stdout });
    rl.on("line", (line) => {
      if (!line.trim().startsWith("{")) return;
      const evt = JSON.parse(line) as { type?: string; wsUrl?: string };
      if (evt.type === "server_listening" && evt.wsUrl) {
        rl.close();
        resolve(evt.wsUrl);
      }
    });
    serverProc.once("exit", (code) =>
      reject(new Error(`cowork-server exited early (${String(code)})`)),
    );
  });

  try {
    for (const run of selectedRuns) {
      const runDir = path.join(rootOutDir, safePathComponent(run.id));
      await fs.mkdir(runDir, { recursive: true });
      const promptContext: PromptContext = { runId: run.id, runDir, repoDir: REPO_ROOT };
      const harnessContext = buildRawLoopHarnessContext(run, cliArgs.scenario, promptContext);
      const prompt = run.prompt(promptContext);
      const startedAt = nowIso();

      const turnResult = await runRawLoopTurnViaServer({
        wsUrl,
        cwd: runDir,
        provider: run.provider,
        model: run.model,
        prompt,
        harnessContext,
        ...(run.provider === "google"
          ? { providerOptions: { google: { nativeWebSearch: false } } }
          : {}),
      });

      assertRawLoopToolRequirements(run, turnResult.steps, turnResult.toolLogLines);
      const contractOut = await validateWithOptionalRepair({
        finalText: turnResult.text,
        runDir,
        trace: turnResult,
        contract: run.finalContract,
        strictMode: cliArgs.strictModeOverride ?? false,
      });
      const budgets = buildRawLoopBudgetSummary(
        turnResult.toolLogLines,
        turnResult.totalSteps,
        contractOut.repairAttempted ? 1 : 0,
      );
      await fs.writeFile(
        path.join(runDir, "trace.json"),
        serializeRawLoopTrace({
          runId: run.id,
          startedAt,
          finishedAt: nowIso(),
          harnessContext,
          budgets,
          validation: contractOut.validationResult,
          result: { text: contractOut.finalText },
        }),
        "utf-8",
      );
      console.log(
        safeJsonStringify({ runId: run.id, ok: contractOut.validationResult.ok, budgets }),
      );
    }
  } finally {
    serverProc.stdin.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
