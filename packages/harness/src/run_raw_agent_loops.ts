#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parseArgs as parseNodeArgs } from "node:util";

import { binaryName, resolveSpawn, which } from "../../../src/platform/exec";
import { coworkHome, home } from "../../../src/platform/paths";
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
  assertRawLoopToolOrder,
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
import {
  type FinalContractValidationResult,
  validateWithOptionalRepair,
} from "./rawLoopValidation";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/** Old in-process runner defaults, kept so a scenario that omits them behaves the same. */
const DEFAULT_MAX_ATTEMPTS = 5;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_STOP_GRACE_MS = 5_000;

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

/** `as_bool_like_str` parity (cowork-config `merge.rs`). */
function parseBoolLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function readJsonObjectSync(filePath: string): JsonRecord {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf-8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the configured `harness` settings the way the server config loader does
 * (`AGENT_HARNESS_*` env, then the project > user > built-in `harness` object), reading the
 * developer's real config rather than the isolated per-run server home.
 */
export function loadRawLoopHarnessSettings(opts: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  userCoworkHome?: string;
}): NonNullable<AgentConfig["harness"]> {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const userCoworkHome = opts.userCoworkHome ?? coworkHome(env);
  const tiers = [
    readJsonObjectSync(path.join(repoRoot, ".cowork", "config.json")),
    readJsonObjectSync(path.join(userCoworkHome, "config", "config.json")),
    readJsonObjectSync(path.join(repoRoot, "config", "defaults.json")),
  ].map((tier) => (isPlainObject(tier.harness) ? tier.harness : {}));
  const fromConfig = (key: string): boolean | undefined => {
    // Deep-merge semantics: the highest tier that sets the key decides, even if unparseable.
    const tier = tiers.find((candidate) => Object.hasOwn(candidate, key));
    return tier === undefined ? undefined : parseBoolLike(tier[key]);
  };
  return {
    reportOnly: parseBoolLike(env.AGENT_HARNESS_REPORT_ONLY) ?? fromConfig("reportOnly") ?? true,
    strictMode: parseBoolLike(env.AGENT_HARNESS_STRICT_MODE) ?? fromConfig("strictMode") ?? false,
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

/** A failed server turn, carrying everything the turn recorded before it failed. */
export class RawLoopTurnError extends Error {
  readonly partial: ServerTurnTraceResult;

  constructor(message: string, partial: ServerTurnTraceResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RawLoopTurnError";
    this.partial = partial;
  }
}

/**
 * Environment for the spawned `cowork-server`. Tasks and workflows resolve only from
 * `COWORK_ENABLE_TASKS` / `COWORK_ENABLE_WORKFLOWS` (session `featureFlags` never reach the
 * turn), so they are pinned off here instead of inheriting the developer's shell. User MCP
 * servers and advanced memory are pinned off through their env levers, which outrank the user
 * and project config. `homeDir` points the server at an isolated per-run HOME (the server
 * appends `.cowork`), so session-config writes never reach the developer's user config.
 */
export function buildRawLoopServerEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: { homeDir?: string } = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    COWORK_REPO_ROOT: baseEnv.COWORK_REPO_ROOT?.trim() || REPO_ROOT,
    COWORK_DESKTOP_PARENT_MANAGED: "1",
    COWORK_DISABLE_BUILTIN_SKILLS: baseEnv.COWORK_DISABLE_BUILTIN_SKILLS ?? "1",
    COWORK_ENABLE_TASKS: "0",
    COWORK_ENABLE_WORKFLOWS: "0",
    AGENT_ENABLE_MCP: "0",
    AGENT_ADVANCED_MEMORY: "0",
    ...(opts.homeDir ? { COWORK_HOME_OVERRIDE: opts.homeDir } : {}),
  };
}

/**
 * `~/.cowork` entries the isolated server home links back to the developer's home: provider
 * credentials (`auth/`, incl. the Codex CLI home whose OAuth refresh tokens rotate, so a copy
 * would strand the real one), user skills, and the managed runtimes/binaries/caches. The user
 * `config/`, `sessions.db`, memories, chats and logs stay per-run.
 */
export const RAW_LOOP_SHARED_COWORK_HOME_ENTRIES = [
  "auth",
  "skills",
  "codex-app-server",
  "runtime",
  "bin",
  "cache",
] as const;

/** Creates (idempotently) the isolated per-run HOME the raw-loop server runs against. */
export async function prepareRawLoopServerHome(opts: {
  homeDir: string;
  sourceCoworkHome?: string;
}): Promise<{ homeDir: string; coworkDir: string; linked: string[] }> {
  const sourceCoworkHome = path.resolve(opts.sourceCoworkHome ?? coworkHome());
  const coworkDir = path.join(opts.homeDir, ".cowork");
  await fs.mkdir(coworkDir, { recursive: true });
  const linked: string[] = [];
  for (const name of RAW_LOOP_SHARED_COWORK_HOME_ENTRIES) {
    const source = path.join(sourceCoworkHome, name);
    const target = path.join(coworkDir, name);
    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;
    if ((await fs.lstat(target).catch(() => null)) === null) {
      // `junction` lets Windows link directories without symlink privileges; POSIX ignores it.
      await fs.symlink(source, target, "junction");
    }
    linked.push(name);
  }
  return { homeDir: opts.homeDir, coworkDir, linked };
}

/**
 * Removes the links {@link prepareRawLoopServerHome} created, so the kept run output never
 * points back into the developer's credentials. Real directories are left alone.
 */
export async function releaseRawLoopServerHome(homeDir: string): Promise<void> {
  const coworkDir = path.join(homeDir, ".cowork");
  for (const name of RAW_LOOP_SHARED_COWORK_HOME_ENTRIES) {
    const target = path.join(coworkDir, name);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) await fs.unlink(target);
  }
}

export type RawLoopServerHandle = {
  wsUrl: string;
  stop: () => Promise<void>;
};

/** Spawns a `cowork-server` for one raw-loop attempt and waits until it is listening. */
export async function startRawLoopServer(opts: {
  serverBin: string;
  runDir: string;
  homeDir: string;
  baseEnv?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}): Promise<RawLoopServerHandle> {
  const serverProc = spawn(
    opts.serverBin,
    ["--dir", opts.runDir, "--host", "127.0.0.1", "--port", "0", "--yolo", "--json"],
    {
      cwd: opts.runDir,
      env: buildRawLoopServerEnv(opts.baseEnv ?? process.env, { homeDir: opts.homeDir }),
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  let exited = false;
  const serverExitPromise = new Promise<void>((resolve) => {
    serverProc.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  // Keep draining stdout for the server's lifetime so a full pipe never blocks it.
  const rl = readline.createInterface({ input: serverProc.stdout });

  const stop = async () => {
    if (!exited) {
      serverProc.stdin.end();
      await Promise.race([
        serverExitPromise,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (!exited) serverProc.kill("SIGTERM");
            resolve();
          }, SERVER_STOP_GRACE_MS),
        ),
      ]);
    }
    // Closed only after shutdown: a paused stdout could block the exiting server.
    rl.close();
  };

  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for cowork-server to start listening")),
        opts.startupTimeoutMs ?? SERVER_STARTUP_TIMEOUT_MS,
      );
      rl.on("line", (line) => {
        if (!line.trim().startsWith("{")) return;
        let evt: { type?: string; url?: string; wsUrl?: string };
        try {
          evt = JSON.parse(line) as typeof evt;
        } catch {
          return;
        }
        const resolvedUrl = evt.wsUrl ?? evt.url;
        if (evt.type === "server_listening" && resolvedUrl) {
          clearTimeout(timer);
          resolve(resolvedUrl);
        }
      });
      serverProc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      serverProc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`cowork-server exited early (${String(code)})`));
      });
    });
    return { wsUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export type RawLoopTurnOptions = {
  wsUrl: string;
  cwd: string;
  provider: ProviderName;
  model: string;
  prompt: string;
  threadId?: string;
  harnessContext?: HarnessContextState;
  providerOptions?: Record<string, unknown>;
  /** Session `maxSteps` override; the server falls back to its default when omitted. */
  maxSteps?: number;
};

export async function runRawLoopTurnViaServer(
  opts: RawLoopTurnOptions,
): Promise<ServerTurnTraceResult> {
  // `advancedMemory` is pinned off through the server env (`AGENT_ADVANCED_MEMORY`); sending it
  // here would persist it into the user config tier.
  const sessionConfig = {
    enableMemory: opts.provider !== "lmstudio",
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
  };
  const ws = new WebSocket(opts.wsUrl, "cowork.jsonrpc.v1");
  const steps: TracedStep[] = [];
  const toolLogLines: string[] = [];
  const startedToolsById = new Map<string, { toolName: string; input: unknown }>();
  const completedToolIds = new Set<string>();
  let todos: TodoItem[] = [];
  let finalText = "";
  let totalSteps = 0;
  let threadId = opts.threadId;

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
  turnDonePromise.catch(() => {
    // A socket close can reject the turn before it is awaited; the await below reports it.
  });
  let socketClosedError: Error | null = null;
  let closingByClient = false;

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
      steps.push({
        scope: "tool-result",
        step: { type: "tool-result", toolName, output, ...(state ? { state } : {}) },
      });
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

  const snapshot = (): ServerTurnTraceResult => ({
    threadId: threadId ?? "",
    text: finalText,
    steps,
    toolLogLines,
    todos,
    totalSteps,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Failed to connect to cowork-server WebSocket"));
      ws.onclose = (event) =>
        reject(
          new Error(`cowork-server WebSocket closed before opening (code ${String(event.code)})`),
        );
    });
  } catch (error) {
    throw new RawLoopTurnError(
      error instanceof Error ? error.message : String(error),
      snapshot(),
      error,
    );
  }

  // An unexpected server exit mid-turn must fail the run instead of hanging it.
  ws.onclose = (event) => {
    if (closingByClient) return;
    socketClosedError = new Error(
      `cowork-server WebSocket closed unexpectedly (code ${String(event.code)}${
        event.reason ? `: ${event.reason}` : ""
      })`,
    );
    for (const waiter of pending.values()) waiter.reject(socketClosedError);
    pending.clear();
    turnDoneReject?.(socketClosedError);
  };

  const rpc = <T = Record<string, unknown>>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (socketClosedError) {
        reject(socketClosedError);
        return;
      }
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
      config: sessionConfig,
    });
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
    // `maxSteps` is a session-only override the server reads when the turn starts.
    await rpc("cowork/session/config/set", {
      threadId,
      config: {
        ...sessionConfig,
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
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
    return snapshot();
  } catch (error) {
    throw new RawLoopTurnError(
      error instanceof Error ? error.message : String(error),
      snapshot(),
      error,
    );
  } finally {
    closingByClient = true;
    ws.close();
  }
}

// --- Retry backoff (ported from the in-process runner) ------------------------------------

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
  if (directMs !== null) return Math.ceil(directMs);
  const directSeconds = positiveRetryNumber(
    errorRecord.retryAfterSeconds ?? errorRecord.retryDelaySeconds ?? errorRecord.retry_after,
  );
  if (directSeconds !== null) return Math.ceil(directSeconds * 1000);
  const raw = String(err ?? "");
  for (const pattern of RETRY_DELAY_PATTERNS) {
    const match = raw.match(pattern);
    const seconds = positiveRetryNumber(match === null ? null : Number(match[1]));
    if (seconds !== null) return Math.ceil(seconds * 1000);
  }
  return null;
}

export function computeRawLoopRetryDelayMs(
  err: unknown,
  attempt: number,
  random: () => number = Math.random,
): number {
  const extracted = extractRetryDelayMs(err);
  const backoffMs = Math.min(180_000, 12_000 * 2 ** Math.max(0, attempt - 1));
  const target = extracted ? Math.max(extracted, backoffMs) : backoffMs;
  return target + Math.floor(random() * 1500);
}

// --- Attempt / run execution ---------------------------------------------------------------

type RawLoopBudgets = ReturnType<typeof buildRawLoopBudgetSummary>;

export type RawLoopAttemptMeta = {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
  retryDelayMs?: number;
};

export type RawLoopAttemptOutcome = {
  ok: boolean;
  error?: string;
  threadId?: string;
  text: string;
  steps: TracedStep[];
  toolLogLines: string[];
  todos: TodoItem[];
  validation: FinalContractValidationResult | null;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  degraded: boolean;
  budgets: RawLoopBudgets;
};

export type RawLoopRunDeps = {
  /** Starts a fresh server for one attempt. */
  startServer: (ctx: {
    run: RunSpec;
    runDir: string;
    attempt: number;
  }) => Promise<RawLoopServerHandle>;
  runTurn?: (opts: RawLoopTurnOptions) => Promise<ServerTurnTraceResult>;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: (error: unknown, attempt: number) => number;
  /** Progress lines; defaults to stdout. */
  log?: (line: string) => void;
};

export const RAW_LOOP_REPAIR_MAX_STEPS = 1;

export function buildRawLoopRepairPrompt(runDir: string): string {
  return [
    "Your previous final response failed contract validation.",
    `Every file path field must be a complete, unabbreviated absolute path inside "${runDir}" (never shorten paths with "...").`,
    'Do NOT call any tools. Reply with ONLY the raw JSON object matching the requested final response contract, including "end": "<<END_RUN>>".',
  ].join("\n");
}

function rawLoopProviderOptions(run: RunSpec): Record<string, unknown> | undefined {
  if (run.provider === "google") return { google: { nativeWebSearch: false } };
  if (run.provider === "lmstudio") {
    return {
      deferredToolSearch: true,
      lmstudio: {
        baseUrl:
          process.env.LM_STUDIO_BASE_URL ??
          process.env.COWORK_LMSTUDIO_BASE_URL ??
          "http://127.0.0.1:1234",
        temperature: 0,
      },
    };
  }
  return undefined;
}

function tracedToolNames(steps: TracedStep[]): string[] {
  return steps.flatMap((entry) => {
    const step = entry.step;
    return isPlainObject(step) && step.type === "tool-call" && typeof step.toolName === "string"
      ? [step.toolName]
      : [];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one attempt end to end. Never throws: failures come back as `ok: false`. */
export async function executeRawLoopAttempt(args: {
  run: RunSpec;
  runDir: string;
  prompt: string;
  harnessContext: HarnessContextState;
  strictMode: boolean;
  attempt: number;
  deps: RawLoopRunDeps;
}): Promise<RawLoopAttemptOutcome> {
  const { run, runDir, prompt, harnessContext, strictMode, attempt, deps } = args;
  const runTurn = deps.runTurn ?? runRawLoopTurnViaServer;
  const providerOptions = rawLoopProviderOptions(run);
  const trace: Pick<
    RawLoopAttemptOutcome,
    "threadId" | "text" | "steps" | "toolLogLines" | "todos"
  > & { totalSteps: number } = {
    text: "",
    steps: [],
    toolLogLines: [],
    todos: [],
    totalSteps: 0,
  };
  const absorb = (turn: ServerTurnTraceResult, scopePrefix = "") => {
    if (turn.threadId) trace.threadId = turn.threadId;
    trace.steps.push(
      ...turn.steps.map((entry) =>
        scopePrefix ? { ...entry, scope: `${scopePrefix}${entry.scope}` } : entry,
      ),
    );
    trace.toolLogLines.push(...turn.toolLogLines);
    if (turn.todos.length > 0) trace.todos = turn.todos;
    trace.totalSteps += turn.totalSteps;
  };

  let validation: FinalContractValidationResult | null = null;
  let repairAttempted = false;
  let repairSucceeded = false;
  let degraded = false;
  const finish = (result: { ok: boolean; error?: string }): RawLoopAttemptOutcome => ({
    ok: result.ok,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(trace.threadId ? { threadId: trace.threadId } : {}),
    text: trace.text,
    steps: trace.steps,
    toolLogLines: trace.toolLogLines,
    todos: trace.todos,
    validation,
    repairAttempted,
    repairSucceeded,
    degraded,
    budgets: buildRawLoopBudgetSummary(
      trace.toolLogLines,
      trace.totalSteps,
      repairAttempted ? 1 : 0,
    ),
  });

  let server: RawLoopServerHandle | null = null;
  try {
    server = await deps.startServer({ run, runDir, attempt });
    const wsUrl = server.wsUrl;
    let turn: ServerTurnTraceResult;
    try {
      turn = await runTurn({
        wsUrl,
        cwd: runDir,
        provider: run.provider,
        model: run.model,
        prompt,
        harnessContext,
        ...(providerOptions ? { providerOptions } : {}),
        ...(run.maxSteps !== undefined ? { maxSteps: run.maxSteps } : {}),
      });
    } catch (error) {
      if (error instanceof RawLoopTurnError) {
        absorb(error.partial);
        trace.text = error.partial.text;
      }
      throw error;
    }
    absorb(turn);
    trace.text = turn.text;

    assertRawLoopToolRequirements(run, trace.steps, trace.toolLogLines);
    assertRawLoopToolOrder(run, trace.steps);

    const contractOut = await validateWithOptionalRepair({
      finalText: turn.text,
      runDir,
      trace,
      contract: run.finalContract,
      strictMode,
      repairFinalOutput: async () => {
        // The old runner repaired with `maxSteps: 1` and an empty tool set. The server bounds
        // the turn to one model step; it has no per-turn tool filter, so a repair that still
        // calls a tool is rejected below instead.
        let repaired: ServerTurnTraceResult;
        try {
          repaired = await runTurn({
            wsUrl,
            cwd: runDir,
            provider: run.provider,
            model: run.model,
            threadId: turn.threadId,
            prompt: buildRawLoopRepairPrompt(runDir),
            ...(providerOptions ? { providerOptions } : {}),
            maxSteps: RAW_LOOP_REPAIR_MAX_STEPS,
          });
        } catch (error) {
          if (error instanceof RawLoopTurnError) absorb(error.partial, "repair-");
          throw error;
        }
        absorb(repaired, "repair-");
        const repairTools = tracedToolNames(repaired.steps);
        if (repairTools.length > 0) {
          throw new Error(
            `Repair pass called tool(s) ${repairTools.join(", ")}; it must answer without tools.`,
          );
        }
        return { finalText: repaired.text.trim() || turn.text };
      },
    });
    validation = contractOut.validationResult;
    repairAttempted = contractOut.repairAttempted;
    repairSucceeded = contractOut.repairSucceeded;
    degraded = contractOut.degraded;
    trace.text = contractOut.finalText;

    if (!validation.ok) {
      return finish({
        ok: false,
        error: `Final contract validation failed: ${validation.issues
          .map((entry) => entry.message)
          .join("; ")}`,
      });
    }
    return finish({ ok: true });
  } catch (error) {
    return finish({ ok: false, error: errorMessage(error) });
  } finally {
    await server?.stop().catch((error: unknown) => {
      console.warn(`[raw-loop] failed to stop cowork-server: ${errorMessage(error)}`);
    });
  }
}

type ArtifactEntry = { path: string; bytes: number; sha256: string; mtimeMs: number };

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
  const entries: ArtifactEntry[] = [];
  for (const absPath of (await listFilesRecursive(runDir)).sort()) {
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

function attemptTraceFileName(attempt: number): string {
  return `trace_attempt-${String(attempt).padStart(2, "0")}.json`;
}

function buildAttemptTrace(base: JsonRecord, outcome: RawLoopAttemptOutcome, finishedAt: string) {
  return {
    ...base,
    finishedAt,
    ok: outcome.ok,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
    steps: outcome.steps,
    toolLogLines: outcome.toolLogLines,
    todos: outcome.todos,
    validation: outcome.validation,
    repairAttempted: outcome.repairAttempted,
    repairSucceeded: outcome.repairSucceeded,
    degraded: outcome.degraded,
    budgets: outcome.budgets,
    result: {
      text: outcome.text,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    },
  };
}

/**
 * Runs every attempt of one scenario run, writing per-attempt traces plus the final run
 * artifacts. Never throws for an attempt failure, so the caller continues with other runs.
 */
export async function executeRawLoopRun(
  run: RunSpec,
  opts: {
    rootOutDir: string;
    scenario: Scenario;
    strictMode: boolean;
    deps: RawLoopRunDeps;
    repoDir?: string;
  },
): Promise<{ ok: boolean; runDir: string; attempts: RawLoopAttemptMeta[] }> {
  const { deps, strictMode } = opts;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelayMs = deps.retryDelayMs ?? computeRawLoopRetryDelayMs;
  const log = deps.log ?? ((line: string) => console.log(line));
  const rawRunDir = path.join(opts.rootOutDir, safePathComponent(run.id));
  await fs.mkdir(rawRunDir, { recursive: true });
  const runDir = fsSync.realpathSync(rawRunDir);
  const promptContext: PromptContext = {
    runId: run.id,
    runDir,
    repoDir: opts.repoDir ?? REPO_ROOT,
  };
  const startedAt = nowIso();
  const harnessContext = buildRawLoopHarnessContext(run, opts.scenario, promptContext, startedAt);
  const prompt = run.prompt(promptContext);
  const maxAttempts = Math.max(1, run.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  await fs.writeFile(
    path.join(runDir, "harness_context.json"),
    safeJsonStringify(harnessContext),
    "utf-8",
  );
  await fs.writeFile(path.join(runDir, "prompt.txt"), prompt, "utf-8");

  const traceBase = {
    runId: run.id,
    provider: run.provider,
    model: run.model,
    scenario: opts.scenario,
    startedAt,
    strictMode,
    userPrompt: prompt,
    harnessContext,
  };
  const attempts: RawLoopAttemptMeta[] = [];
  let last: RawLoopAttemptOutcome | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStartedAt = nowIso();
    const outcome = await executeRawLoopAttempt({
      run,
      runDir,
      prompt,
      harnessContext,
      strictMode,
      attempt,
      deps,
    });
    const finishedAt = nowIso();
    const delay =
      outcome.ok || attempt >= maxAttempts
        ? undefined
        : retryDelayMs(outcome.error ?? "Raw-loop attempt failed", attempt);
    attempts.push({
      attempt,
      startedAt: attemptStartedAt,
      finishedAt,
      ok: outcome.ok,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(delay === undefined ? {} : { retryDelayMs: delay }),
    });
    last = outcome;
    await fs.writeFile(
      path.join(runDir, attemptTraceFileName(attempt)),
      serializeRawLoopTrace(
        buildAttemptTrace(
          { ...traceBase, attempt, startedAt: attemptStartedAt },
          outcome,
          finishedAt,
        ),
      ),
      "utf-8",
    );
    log(
      safeJsonStringify({
        runId: run.id,
        attempt,
        ok: outcome.ok,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }),
    );
    if (outcome.ok) break;
    if (delay !== undefined) await sleep(delay);
  }

  if (last === null) throw new Error(`Run ${run.id} executed no attempts`);
  const final = last;
  const finishedAt = nowIso();
  const runError = final.ok
    ? undefined
    : `Run ${run.id} failed after ${String(attempts.length)} attempt(s): ${final.error ?? "unknown error"}`;
  await fs.writeFile(
    path.join(runDir, "trace.json"),
    serializeRawLoopTrace(buildAttemptTrace(traceBase, final, finishedAt)),
    "utf-8",
  );
  await fs.writeFile(path.join(runDir, "attempts.json"), safeJsonStringify(attempts), "utf-8");
  await fs.writeFile(
    path.join(runDir, "tool-log.txt"),
    `${final.toolLogLines.join("\n")}\n`,
    "utf-8",
  );
  await fs.writeFile(path.join(runDir, "final.txt"), final.text, "utf-8");
  await fs.writeFile(
    path.join(runDir, "run_meta.json"),
    safeJsonStringify({
      runId: run.id,
      provider: run.provider,
      model: run.model,
      maxSteps: run.maxSteps ?? null,
      maxAttempts,
      attempts: attempts.length,
      runDir,
      startedAt,
      finishedAt,
      harnessContext,
      strictMode,
      ok: final.ok,
      repairAttempted: final.repairAttempted,
      repairSucceeded: final.repairSucceeded,
      degraded: final.degraded,
      validation: final.validation ?? {
        ok: false,
        schemaOk: false,
        artifactOk: false,
        semanticOk: false,
        issues: [
          { code: "run_failed", message: runError ?? "Run did not produce a final contract" },
        ],
        warnings: [],
      },
      budgets: final.budgets,
      ...(runError ? { error: runError } : {}),
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(runDir, "artifacts_index.json"),
    safeJsonStringify(await collectArtifacts(runDir)),
    "utf-8",
  );
  log(safeJsonStringify({ runId: run.id, ok: final.ok, budgets: final.budgets }));
  return { ok: final.ok, runDir, attempts };
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const selectedRuns = selectRawLoopRuns({
    scenario: cliArgs.scenario,
    onlyRunIds: cliArgs.onlyRunIds,
    onlyModels: cliArgs.onlyModels,
  });
  const harness = resolveRawLoopHarnessConfig(loadRawLoopHarnessSettings({}), cliArgs);
  const strictMode = harness.strictMode ?? false;
  const developerCoworkHome = coworkHome();

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
      harness: {
        strictModeOverride: cliArgs.strictModeOverride,
        strictMode,
        onlyRunIds: cliArgs.onlyRunIds,
        onlyModels: cliArgs.onlyModels,
      },
      runs: selectedRuns.map((run) => ({ id: run.id, provider: run.provider, model: run.model })),
    }),
    "utf-8",
  );

  const serverBin = resolveCoworkServerBinary();
  // Each run's server gets its own HOME outside the run's working directory, so session
  // config writes stay out of the developer's `~/.cowork/config` and out of the workspace.
  const serverHomesDir = path.join(rootOutDir, ".server-homes");
  const serverHomeFor = (run: RunSpec) => path.join(serverHomesDir, safePathComponent(run.id));
  const deps: RawLoopRunDeps = {
    startServer: async ({ run, runDir }) => {
      const { homeDir } = await prepareRawLoopServerHome({
        homeDir: serverHomeFor(run),
        sourceCoworkHome: developerCoworkHome,
      });
      return await startRawLoopServer({ serverBin, runDir, homeDir });
    },
  };

  let anyRunFailed = false;
  for (const run of selectedRuns) {
    try {
      const result = await executeRawLoopRun(run, {
        rootOutDir,
        scenario: cliArgs.scenario,
        strictMode,
        deps,
      });
      if (!result.ok) anyRunFailed = true;
    } catch (error) {
      // Artifact I/O failures for one run must not skip the remaining runs.
      anyRunFailed = true;
      console.error(`[raw-loop] run ${run.id} aborted: ${errorMessage(error)}`);
    } finally {
      await releaseRawLoopServerHome(serverHomeFor(run)).catch((error: unknown) => {
        console.warn(`[raw-loop] failed to unlink ${run.id} server home: ${errorMessage(error)}`);
      });
    }
  }

  console.log(`[raw-loop] wrote traces to: ${rootOutDir}`);
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
