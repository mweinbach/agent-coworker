import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const RUN_ROOT_PREFIX = "raw-agent-loop_mixed_";
const unknownRecordSchema = z.record(z.string(), z.unknown());
const unknownRecordArraySchema = z.array(unknownRecordSchema);

export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface HarnessRunSummary {
  runId: string;
  runDirName: string;
  provider: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  attemptsTotal: number;
  attemptsSucceeded: number;
  lastError: string | null;
  finalPreview: string;
  observabilityEnabled: boolean;
  observabilityHealthStatus: string | null;
  observabilityHealthReason: string | null;
  observabilityHealthMessage: string | null;
  updatedAtMs: number;
}

export interface HarnessRunRootSummary {
  runRootName: string;
  createdAt: string | null;
  harness: {
    reportOnly: boolean;
    strictMode: boolean;
  } | null;
  runs: HarnessRunSummary[];
  updatedAtMs: number;
}

export interface HarnessRunsSnapshot {
  repoRoot: string;
  outputDirectory: string;
  generatedAt: string;
  roots: HarnessRunRootSummary[];
}

export interface HarnessRunDetail {
  repoRoot: string;
  runRootName: string;
  runDirName: string;
  manifest: Record<string, unknown> | null;
  runMeta: Record<string, unknown> | null;
  prompt: string;
  system: string;
  final: string;
  finalReasoning: string;
  attempts: Array<Record<string, unknown>>;
  traceSummary: {
    startedAt: string | null;
    finishedAt: string | null;
    stepCount: number;
    askEvents: number;
    approvalEvents: number;
    todoEvents: number;
    error: string | null;
    responseMessages: number;
  };
  traceStepPreview: {
    first: Array<Record<string, unknown>>;
    last: Array<Record<string, unknown>>;
  };
  artifactsIndex: Array<Record<string, unknown>>;
  toolLogTail: string[];
  files: string[];
  updatedAtMs: number;
}

function isSafeSegment(input: string): boolean {
  return !!input && !input.includes("/") && !input.includes("\\") && !input.includes("..") && input !== ".";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getNowIso(): string {
  return new Date().toISOString();
}

function getPreview(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function maxMtimeMs(paths: string[]): Promise<number> {
  let max = 0;
  await Promise.all(
    paths.map(async (filePath) => {
      try {
        const st = await fs.stat(filePath);
        if (st.mtimeMs > max) max = st.mtimeMs;
      } catch {
        // ignore missing files
      }
    })
  );
  return max;
}

export async function resolveRepoRoot(): Promise<string> {
  const fromEnv = process.env.HARNESS_REPO_ROOT;
  if (fromEnv && (await pathExists(path.join(fromEnv, "package.json")))) {
    return path.resolve(fromEnv);
  }

  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "../.."),
    path.resolve(cwd, "../../.."),
  ];

  for (const candidate of candidates) {
    const pkg = await readJsonFile(
      path.join(candidate, "package.json"),
      z.object({ name: z.string().optional() }).passthrough(),
    );
    if (pkg?.name === "agent-coworker") {
      return candidate;
    }
  }

  return path.resolve(cwd, "../..");
}

function outputDirectory(repoRoot: string): string {
  return path.join(repoRoot, "output");
}

async function listRunRootNames(repoRoot: string): Promise<string[]> {
  const outputDir = outputDirectory(repoRoot);
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_ROOT_PREFIX))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

async function readRunSummary(runRootPath: string, runDirName: string): Promise<HarnessRunSummary | null> {
  const runDir = path.join(runRootPath, runDirName);
  const runMeta = await readJsonFile(path.join(runDir, "run_meta.json"), unknownRecordSchema);
  const attempts = (await readJsonFile(path.join(runDir, "attempts.json"), unknownRecordArraySchema)) ?? [];
  const trace = await readJsonFile(path.join(runDir, "trace.json"), unknownRecordSchema);
  const finalText = await readTextFile(path.join(runDir, "final.txt"));

  const runId = asString(runMeta?.runId) ?? runDirName;
  const provider = asString(runMeta?.provider) ?? "unknown";
  const requestedModel = asString(runMeta?.requestedModel);
  const resolvedModel = asString(runMeta?.resolvedModel);

  const traceResult = toRecord(trace?.result);
  const traceError = asString(traceResult?.error);
  const startedAt = asString(runMeta?.startedAt) ?? asString(trace?.startedAt);
  const finishedAt = asString(runMeta?.finishedAt) ?? asString(trace?.finishedAt);
  const observabilityEnabled = asBoolean(runMeta?.observabilityEnabled, false);
  const observability = toRecord(runMeta?.observability);
  const observabilityEndHealth = toRecord(observability?.endHealth);
  const observabilityHealthStatus = asString(observabilityEndHealth?.status);
  const observabilityHealthReason = asString(observabilityEndHealth?.reason);
  const observabilityHealthMessage = asString(observabilityEndHealth?.message);

  const attemptSucceeded = attempts.filter((attempt) => asBoolean(attempt.ok, false)).length;
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const attemptError = asString(lastAttempt?.error);
  const lastError = traceError ?? attemptError;

  let status: RunStatus = "pending";
  if (finishedAt) status = lastError ? "failed" : "completed";
  else if (attempts.length > 0 || (await pathExists(path.join(runDir, "trace_attempt-01.json")))) status = "running";

  const updatedAtMs = await maxMtimeMs([
    runDir,
    path.join(runDir, "run_meta.json"),
    path.join(runDir, "attempts.json"),
    path.join(runDir, "trace.json"),
    path.join(runDir, "final.txt"),
  ]);

  return {
    runId,
    runDirName,
    provider,
    requestedModel,
    resolvedModel,
    startedAt,
    finishedAt,
    status,
    attemptsTotal: attempts.length,
    attemptsSucceeded: attemptSucceeded,
    lastError,
    finalPreview: getPreview(finalText),
    observabilityEnabled,
    observabilityHealthStatus,
    observabilityHealthReason,
    observabilityHealthMessage,
    updatedAtMs,
  };
}

async function readRunRootSummary(repoRoot: string, runRootName: string): Promise<HarnessRunRootSummary | null> {
  if (!isSafeSegment(runRootName)) return null;

  const runRootPath = path.join(outputDirectory(repoRoot), runRootName);
  const manifest = await readJsonFile(path.join(runRootPath, "manifest.json"), unknownRecordSchema);

  let runDirNames: string[] = [];
  try {
    const entries = await fs.readdir(runRootPath, { withFileTypes: true });
    runDirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    runDirNames = [];
  }

  const runs = (
    await Promise.all(runDirNames.map((runDirName) => readRunSummary(runRootPath, runDirName)))
  ).filter((run): run is HarnessRunSummary => run !== null);

  runs.sort((a, b) => {
    const left = a.startedAt ?? "";
    const right = b.startedAt ?? "";
    if (left !== right) return right.localeCompare(left);
    return b.runDirName.localeCompare(a.runDirName);
  });

  const harness = toRecord(manifest?.harness);
  const updatedAtMs = Math.max(
    await maxMtimeMs([runRootPath, path.join(runRootPath, "manifest.json")]),
    ...runs.map((run) => run.updatedAtMs)
  );

  return {
    runRootName,
    createdAt: asString(manifest?.createdAt),
    harness: harness
      ? {
          reportOnly: asBoolean(harness.reportOnly, true),
          strictMode: asBoolean(harness.strictMode, false),
        }
      : null,
    runs,
    updatedAtMs,
  };
}

export async function getHarnessRunsSnapshot(opts?: { limitRoots?: number }): Promise<HarnessRunsSnapshot> {
  const repoRoot = await resolveRepoRoot();
  const outputDir = outputDirectory(repoRoot);
  const limitRoots = Math.max(1, Math.min(100, opts?.limitRoots ?? 30));

  const runRootNames = await listRunRootNames(repoRoot);
  const roots = (
    await Promise.all(runRootNames.slice(0, limitRoots).map((runRootName) => readRunRootSummary(repoRoot, runRootName)))
  ).filter((root): root is HarnessRunRootSummary => root !== null);

  return {
    repoRoot,
    outputDirectory: outputDir,
    generatedAt: getNowIso(),
    roots,
  };
}

export function runDirectoryPath(repoRoot: string, runRootName: string, runDirName: string): string | null {
  if (!isSafeSegment(runRootName) || !isSafeSegment(runDirName)) return null;
  return path.join(outputDirectory(repoRoot), runRootName, runDirName);
}

function tailLines(text: string, maxLines = 200): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function normalizeTracePreview(steps: unknown[]): { first: Array<Record<string, unknown>>; last: Array<Record<string, unknown>> } {
  const first = steps.slice(0, 5).map((step) => (toRecord(step) ?? { value: step }));
  const last = steps.slice(Math.max(0, steps.length - 5)).map((step) => (toRecord(step) ?? { value: step }));
  return { first, last };
}

export async function getHarnessRunDetail(runRootName: string, runDirName: string): Promise<HarnessRunDetail | null> {
  if (!isSafeSegment(runRootName) || !isSafeSegment(runDirName)) return null;

  const repoRoot = await resolveRepoRoot();
  const runDir = runDirectoryPath(repoRoot, runRootName, runDirName);
  if (!runDir) return null;
  if (!(await pathExists(runDir))) return null;

  const runRootPath = path.dirname(runDir);
  const manifest = await readJsonFile(path.join(runRootPath, "manifest.json"), unknownRecordSchema);
  const runMeta = await readJsonFile(path.join(runDir, "run_meta.json"), unknownRecordSchema);

  const [prompt, system, final, finalReasoning, toolLogText] = await Promise.all([
    readTextFile(path.join(runDir, "prompt.txt")),
    readTextFile(path.join(runDir, "system.txt")),
    readTextFile(path.join(runDir, "final.txt")),
    readTextFile(path.join(runDir, "final_reasoning.txt")),
    readTextFile(path.join(runDir, "tool-log.txt")),
  ]);

  const attempts = (await readJsonFile(path.join(runDir, "attempts.json"), unknownRecordArraySchema)) ?? [];
  const trace = await readJsonFile(path.join(runDir, "trace.json"), unknownRecordSchema);
  const artifactsIndex =
    (await readJsonFile(path.join(runDir, "artifacts_index.json"), unknownRecordArraySchema)) ?? [];

  const traceRecord = toRecord(trace) ?? {};
  const traceResult = toRecord(traceRecord.result) ?? {};
  const traceSteps = toArray(traceRecord.steps);
  const traceAskEvents = toArray(traceRecord.askEvents);
  const traceApprovalEvents = toArray(traceRecord.approvalEvents);
  const traceTodoEvents = toArray(traceRecord.todoEvents);
  const traceResponseMessages = toArray(traceResult.responseMessages);

  let files: string[] = [];
  try {
    files = await fs.readdir(runDir);
  } catch {
    files = [];
  }

  const updatedAtMs = await maxMtimeMs([
    runDir,
    path.join(runDir, "run_meta.json"),
    path.join(runDir, "trace.json"),
    path.join(runDir, "attempts.json"),
    path.join(runDir, "artifacts_index.json"),
    path.join(runDir, "tool-log.txt"),
  ]);

  return {
    repoRoot,
    runRootName,
    runDirName,
    manifest,
    runMeta,
    prompt,
    system,
    final,
    finalReasoning,
    attempts,
    traceSummary: {
      startedAt: asString(traceRecord.startedAt),
      finishedAt: asString(traceRecord.finishedAt),
      stepCount: traceSteps.length,
      askEvents: traceAskEvents.length,
      approvalEvents: traceApprovalEvents.length,
      todoEvents: traceTodoEvents.length,
      error: asString(traceResult.error),
      responseMessages: traceResponseMessages.length,
    },
    traceStepPreview: normalizeTracePreview(traceSteps),
    artifactsIndex,
    toolLogTail: tailLines(toolLogText, 220),
    files: files.sort((a, b) => a.localeCompare(b)),
    updatedAtMs,
  };
}
