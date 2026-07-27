import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkflowAgentOptions, WorkflowJournalEntry } from "./types";

/**
 * Append-only run journal backing resume-with-cached-prefix.
 *
 * Lives under `<projectCoworkDir>/workflows/runs/<runId>/journal.jsonl`.
 * `.cowork/` is gitignored and is in `PROTECTED_METADATA_DIR_NAMES`, so child
 * agents cannot write there — a child cannot forge a cached result. That property
 * does NOT hold under `--yolo`/`danger-full-access`, where `resolveSandboxPolicy`
 * grants full access; resume is best-effort in that configuration.
 */

/** Run ids are host-minted (`wf_` + 12 hex chars) or caller-supplied resume keys. */
const WORKFLOW_RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertSafeWorkflowRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!WORKFLOW_RUN_ID_RE.test(trimmed)) {
    throw new Error(
      `invalid workflow run id "${runId}": expected wf_ followed by letters, digits, _ or -`,
    );
  }
  return trimmed;
}

function workflowRunsDir(projectCoworkDir: string): string {
  return path.join(projectCoworkDir, "workflows", "runs");
}

/**
 * Resolve `<runs>/<runId>` and refuse anything that escapes the runs root
 * (path separators, `..`, alternate roots). Defense in depth on top of the
 * run-id charset check.
 */
export function workflowRunDir(projectCoworkDir: string, runId: string): string {
  const safeId = assertSafeWorkflowRunId(runId);
  const root = path.resolve(workflowRunsDir(projectCoworkDir));
  const resolved = path.resolve(root, safeId);
  const relative = path.relative(root, resolved);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes("..")
  ) {
    throw new Error(`workflow run id escapes the runs directory: ${runId}`);
  }
  return resolved;
}

/**
 * Content digest of an `agent()` call: prompt, options, and the run's args.
 *
 * Two things are deliberately EXCLUDED.
 *
 * **The script source hash.** Including it would make any edit anywhere
 * invalidate the whole journal, defeating the purpose — resume exists so that
 * fixing a late stage does not re-pay for the early ones.
 *
 * **The call index.** `pipeline()` has no barrier between stages, so the order in
 * which calls reach the host depends on how long each agent happened to take.
 * Index-keyed caching would therefore break resume for exactly the control flow
 * workflows are built around: a rerun whose timings shift would slide every call
 * onto a different index and match nothing. Content-addressing makes replay
 * order-independent, and it is the stricter rule — a cached result is reused only
 * when the call is byte-for-byte the same request.
 *
 * `args` is included because prompts are usually derived from it, so a different
 * args payload must not silently replay results computed for the old one.
 *
 * Hand-rolled rather than reusing `digestToolInput`: `hashCanonicalValue`
 * (`src/shared/toolInputDigestHasher.ts`) returns null for ANY nested `undefined`,
 * not just a top-level one, so an options object with one absent field would
 * silently never cache. Here undefined-valued keys are dropped during
 * canonicalization, which is exactly the semantics resume wants.
 */
export function digestAgentCall(input: {
  argsHash: string;
  prompt: string;
  opts: WorkflowAgentOptions;
}): string {
  const canonical = canonicalize({
    argsHash: input.argsHash,
    prompt: input.prompt,
    opts: input.opts,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Hash of the run's `args` payload, used as part of every call digest. */
export function hashWorkflowArgs(args: unknown): string {
  return createHash("sha256")
    .update(canonicalize(args ?? {}))
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export class WorkflowJournal {
  private readonly entries: WorkflowJournalEntry[] = [];
  /**
   * Prior results keyed by content digest. A multiset, not a map: a script may
   * legitimately issue the same call twice, and each occurrence should consume
   * one recorded result rather than both replaying the first.
   */
  private readonly cached = new Map<string, WorkflowJournalEntry[]>();
  private buffer = "";

  private constructor(
    private readonly filePath: string,
    prior: WorkflowJournalEntry[],
  ) {
    for (const entry of prior) {
      const bucket = this.cached.get(entry.digest);
      if (bucket) bucket.push(entry);
      else this.cached.set(entry.digest, [entry]);
    }
  }

  /**
   * Open a journal for `runId`, optionally seeding the replay cache from a prior
   * run's journal.
   */
  static async open(opts: {
    projectCoworkDir: string;
    runId: string;
    resumeFromRunId?: string;
  }): Promise<WorkflowJournal> {
    const dir = workflowRunDir(opts.projectCoworkDir, opts.runId);
    await mkdir(dir, { recursive: true });
    const prior = opts.resumeFromRunId
      ? await readJournal(workflowRunDir(opts.projectCoworkDir, opts.resumeFromRunId))
      : [];
    return new WorkflowJournal(path.join(dir, "journal.jsonl"), prior);
  }

  /**
   * Consume a recorded result for an identical call, if one remains.
   *
   * Order-independent by design (see `digestAgentCall`): a call replays when the
   * prior run made the byte-for-byte same request, wherever it happened to fall in
   * the sequence. Each recorded result is handed out at most once.
   */
  lookup(digest: string): WorkflowJournalEntry | null {
    const bucket = this.cached.get(digest);
    if (!bucket || bucket.length === 0) return null;
    return bucket.shift() ?? null;
  }

  append(entry: WorkflowJournalEntry): void {
    this.entries.push(entry);
    this.buffer += `${JSON.stringify(entry)}\n`;
  }

  get recorded(): readonly WorkflowJournalEntry[] {
    return this.entries;
  }

  /**
   * Persist buffered entries.
   *
   * Buffered rather than written per call: journal writes go through the same
   * filesystem the turn's mutation gate guards, and during cancellation teardown
   * that gate throws. Flushing once at the end keeps a cancelled run from failing
   * inside its own cleanup path.
   */
  async flush(): Promise<void> {
    if (!this.buffer) return;
    const pending = this.buffer;
    this.buffer = "";
    await writeFile(this.filePath, pending, { encoding: "utf8", flag: "a" });
  }
}

async function readJournal(dir: string): Promise<WorkflowJournalEntry[]> {
  try {
    const raw = await readFile(path.join(dir, "journal.jsonl"), "utf8");
    const out: WorkflowJournalEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as WorkflowJournalEntry);
      } catch {
        // A torn final line (killed mid-write) truncates the replay prefix rather
        // than failing the resume outright.
        break;
      }
    }
    return out;
  } catch {
    return [];
  }
}
