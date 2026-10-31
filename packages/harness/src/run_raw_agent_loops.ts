#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parseArgs as parseNodeArgs } from "node:util";

import { binaryName, resolveSpawn, which } from "../../../src/platform/exec";
import { home } from "../../../src/platform/paths";
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
  const explicit = process.env.COWORK_SERVER_BINARY?.trim();
  if (explicit && fsSync.existsSync(explicit)) return explicit;

  const exe = binaryName("cowork-server");
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(REPO_ROOT, "target", profile, exe);
    if (fsSync.existsSync(candidate)) return candidate;
  }

  const userHome = home();
  const env = {
    ...process.env,
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(userHome, ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(userHome, ".rustup"),
  };
  const cargoPath = which("cargo", { env });
  if (cargoPath) {
    const plan = resolveSpawn(cargoPath, ["build", "-p", "cowork-server"], {
      env,
      cwd: REPO_ROOT,
    });
    execFileSync(plan.file, plan.args, {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    const debugCandidate = path.join(REPO_ROOT, "target", "debug", exe);
    if (fsSync.existsSync(debugCandidate)) return debugCandidate;
  }

  throw new Error(
    `Compiled ${exe} binary not found in target/{release,debug}. Run \`cargo build -p cowork-server\` first.`,
  );
}

export type ServerTurnTraceResult = {
  threadId: string;
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
  threadId?: string;
  harnessContext?: HarnessContextState;
  providerOptions?: Record<string, unknown>;
}): Promise<ServerTurnTraceResult> {
  const ws = new WebSocket(opts.wsUrl, "cowork.jsonrpc.v1");
  const steps: TracedStep[] = [];
  const toolLogLines: string[] = [];
  const startedToolsById = new Map<string, { toolName: string; input: unknown }>();
  const completedToolIds = new Set<string>();
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
        const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
        const answer =
          typeof options[0] === "string" && options[0].trim().length > 0 ? options[0] : "alpha";
        ws.send(JSON.stringify({ id: msg.id, result: { answer } }));
      }
      return;
    }
    if (msg.method === "item/started" && msg.params?.item?.type === "toolCall") {
      const itemId = String(msg.params.item.id ?? `tool-${String(startedToolsById.size + 1)}`);
      const rawToolName = String(msg.params.item.toolName ?? msg.params.item.name ?? "tool");
      const rawInput = msg.params.item.args ?? msg.params.item.input ?? {};
      const unwrappedName =
        rawToolName === "toolCall" &&
        isPlainObject(rawInput) &&
        typeof rawInput.name === "string" &&
        rawInput.name.trim().length > 0
          ? rawInput.name.trim()
          : rawToolName;
      const unwrappedInput =
        unwrappedName !== rawToolName && isPlainObject(rawInput)
          ? (rawInput.arguments ?? {})
          : rawInput;
      startedToolsById.set(itemId, { toolName: unwrappedName, input: unwrappedInput });
      totalSteps += 1;
    } else if (msg.method === "item/completed" && msg.params?.item?.type === "toolCall") {
      const state = typeof msg.params.item.state === "string" ? msg.params.item.state : "";
      if (state === "input-streaming" || state === "input-available") {
        return;
      }
      const itemId = String(msg.params.item.id ?? "");
      const started = startedToolsById.get(itemId);
      const rawToolName = String(
        msg.params.item.toolName ?? msg.params.item.name ?? started?.toolName ?? "tool",
      );
      const rawInput = msg.params.item.args ?? msg.params.item.input ?? started?.input ?? {};
      const toolName =
        rawToolName === "toolCall" &&
        isPlainObject(rawInput) &&
        typeof rawInput.name === "string" &&
        rawInput.name.trim().length > 0
          ? rawInput.name.trim()
          : (started?.toolName ?? rawToolName);
      const input =
        toolName !== rawToolName && isPlainObject(rawInput)
          ? (rawInput.arguments ?? started?.input ?? {})
          : rawInput;
      const output = msg.params.item.result ?? null;
      if (itemId) completedToolIds.add(itemId);
      steps.push({ scope: "tool-call", step: { type: "tool-call", toolName, input } });
      steps.push({ scope: "tool-result", step: { type: "tool-result", toolName, output } });
      toolLogLines.push(`tool> ${toolName} ${JSON.stringify(input)}`);
      if (!started) totalSteps += 1;
    } else if (msg.method === "item/completed" && msg.params?.item?.type === "agentMessage") {
      finalText = String(msg.params.item.text ?? finalText);
      totalSteps += 1;
    } else if (msg.method === "cowork/todos" && Array.isArray(msg.params?.todos)) {
      todos = msg.params.todos as TodoItem[];
    } else if (msg.method === "turn/completed") {
      if (completedToolIds.size === 0) {
        for (const started of startedToolsById.values()) {
          steps.push({
            scope: "tool-call",
            step: { type: "tool-call", toolName: started.toolName, input: started.input },
          });
          toolLogLines.push(`tool> ${started.toolName} ${JSON.stringify(started.input)}`);
        }
      }
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
        enableMemory: opts.provider !== "lmstudio",
        advancedMemory: false,
        tasksEnabled: false,
        workflowsEnabled: false,
        ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      },
    });
    let threadId = opts.threadId;
    if (threadId) {
      await rpc("thread/resume", { threadId });
    } else {
      const started = await rpc<{ thread: { id: string } }>("thread/start", {
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
      });
      threadId = String(started.thread.id);
    }
    await rpc("cowork/session/config/set", {
      threadId,
      config: {
        enableMemory: opts.provider !== "lmstudio",
        advancedMemory: false,
        tasksEnabled: false,
        workflowsEnabled: false,
        ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      },
    });
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
    return { threadId, text: finalText, steps, toolLogLines, todos, totalSteps };
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
  const rootPrefix = SCENARIO_DEFINITIONS[cliArgs.scenario].runRootPrefix;
  const configuredOutRoot = process.env.AGENT_OUTPUT_DIR?.trim();
  const rootOutDir = configuredOutRoot
    ? path.join(path.resolve(configuredOutRoot), `${rootPrefix}_${sessionStamp}`)
    : path.join(REPO_ROOT, "output", "raw-loop-runs", `${rootPrefix}_${sessionStamp}`);
  await fs.mkdir(rootOutDir, { recursive: true });

  await fs.writeFile(
    path.join(rootOutDir, "manifest.json"),
    safeJsonStringify({
      scenario: cliArgs.scenario,
      startedAt: nowIso(),
      runs: selectedRuns.map((run) => ({ id: run.id, provider: run.provider, model: run.model })),
    }),
    "utf-8",
  );

  const serverBin = resolveCoworkServerBinary();
  let anyRunFailed = false;

  for (const run of selectedRuns) {
    const rawRunDir = path.join(rootOutDir, safePathComponent(run.id));
    await fs.mkdir(rawRunDir, { recursive: true });
    const runDir = fsSync.realpathSync(rawRunDir);
    const promptContext: PromptContext = { runId: run.id, runDir, repoDir: REPO_ROOT };
    const harnessContext = buildRawLoopHarnessContext(run, cliArgs.scenario, promptContext);
    const prompt = run.prompt(promptContext);
    const startedAt = nowIso();
    const providerOptions: Record<string, unknown> | undefined =
      run.provider === "google"
        ? { google: { nativeWebSearch: false } }
        : run.provider === "lmstudio"
          ? {
              deferredToolSearch: true,
              lmstudio: {
                baseUrl:
                  process.env.LM_STUDIO_BASE_URL ??
                  process.env.COWORK_LMSTUDIO_BASE_URL ??
                  "http://127.0.0.1:1234",
                temperature: 0,
              },
            }
          : undefined;

    await fs.writeFile(
      path.join(runDir, "harness_context.json"),
      safeJsonStringify(harnessContext),
      "utf-8",
    );
    await fs.writeFile(path.join(runDir, "prompt.txt"), prompt, "utf-8");

    const serverProc = spawn(
      serverBin,
      ["--dir", runDir, "--host", "127.0.0.1", "--port", "0", "--yolo", "--json"],
      {
        cwd: runDir,
        env: {
          ...process.env,
          COWORK_DESKTOP_PARENT_MANAGED: "1",
          COWORK_DISABLE_BUILTIN_SKILLS: process.env.COWORK_DISABLE_BUILTIN_SKILLS ?? "1",
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const serverExitPromise = new Promise<void>((resolve) => {
      serverProc.once("exit", () => resolve());
    });

    try {
      const wsUrl = await new Promise<string>((resolve, reject) => {
        const rl = readline.createInterface({ input: serverProc.stdout });
        rl.on("line", (line) => {
          if (!line.trim().startsWith("{")) return;
          const evt = JSON.parse(line) as { type?: string; url?: string; wsUrl?: string };
          const resolvedUrl = evt.wsUrl ?? evt.url;
          if (evt.type === "server_listening" && resolvedUrl) {
            rl.close();
            resolve(resolvedUrl);
          }
        });
        serverProc.once("exit", (code) =>
          reject(new Error(`cowork-server exited early (${String(code)})`)),
        );
      });

      const turnResult = await runRawLoopTurnViaServer({
        wsUrl,
        cwd: runDir,
        provider: run.provider,
        model: run.model,
        prompt,
        harnessContext,
        ...(providerOptions ? { providerOptions } : {}),
      });

      assertRawLoopToolRequirements(run, turnResult.steps, turnResult.toolLogLines);
      const strictMode = cliArgs.strictModeOverride ?? false;
      const contractOut = await validateWithOptionalRepair({
        finalText: turnResult.text,
        runDir,
        trace: turnResult,
        contract: run.finalContract,
        strictMode,
        repairFinalOutput: async () => {
          const repairPrompt = [
            "Your previous final response failed contract validation.",
            `Every file path field must be a complete, unabbreviated absolute path inside "${runDir}" (never shorten paths with "...").`,
            "Without calling any more tools unless strictly required, emit ONLY the valid JSON object matching the requested final response contract.",
          ].join("\n");
          const repaired = await runRawLoopTurnViaServer({
            wsUrl,
            cwd: runDir,
            provider: run.provider,
            model: run.model,
            threadId: turnResult.threadId,
            prompt: repairPrompt,
            ...(providerOptions ? { providerOptions } : {}),
          });
          turnResult.toolLogLines.push(...repaired.toolLogLines);
          turnResult.totalSteps += repaired.totalSteps;
          return { finalText: repaired.text };
        },
      });
      const budgets = buildRawLoopBudgetSummary(
        turnResult.toolLogLines,
        turnResult.totalSteps,
        contractOut.repairAttempted ? 1 : 0,
      );
      const finishedAt = nowIso();
      await fs.writeFile(
        path.join(runDir, "tool-log.txt"),
        `${turnResult.toolLogLines.join("\n")}\n`,
        "utf-8",
      );
      await fs.writeFile(path.join(runDir, "final.txt"), contractOut.finalText, "utf-8");
      await fs.writeFile(
        path.join(runDir, "run_meta.json"),
        safeJsonStringify({
          runId: run.id,
          provider: run.provider,
          model: run.model,
          strictMode,
          repairAttempted: contractOut.repairAttempted,
          repairSucceeded: contractOut.repairSucceeded,
          validation: contractOut.validationResult,
          budgets,
          startedAt,
          finishedAt,
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(runDir, "trace.json"),
        serializeRawLoopTrace({
          runId: run.id,
          startedAt,
          finishedAt,
          harnessContext,
          budgets,
          validation: contractOut.validationResult,
          result: { text: contractOut.finalText },
        }),
        "utf-8",
      );
      if (!contractOut.validationResult.ok) {
        anyRunFailed = true;
      }
      console.log(
        safeJsonStringify({ runId: run.id, ok: contractOut.validationResult.ok, budgets }),
      );
    } finally {
      serverProc.stdin.end();
      await Promise.race([
        serverExitPromise,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            serverProc.kill("SIGTERM");
            resolve();
          }, 5_000),
        ),
      ]);
    }
  }

  if (anyRunFailed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
