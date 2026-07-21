import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { removeWithRetry } from "../platform/fs";
import { writeTextFileAtomic } from "../utils/atomicFile";
import {
  type ClaimedSkillImprovementJob,
  type CompletedTurnSkillUsage,
  SKILL_IMPROVEMENT_DEBOUNCE_MS,
  SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB,
  SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB,
  SKILL_IMPROVEMENT_STALE_RUNNING_MS,
  type SkillImprovementBackupRecord,
  type SkillImprovementJob,
  type SkillImprovementRunHistoryEntry,
  type SkillImprovementState,
} from "./types";

const usageEventSchema = z
  .object({
    skillName: z.string(),
    kind: z.enum(["tool", "reference"]),
    source: z.enum(["skill-tool", "at-mention"]),
    turnId: z.string(),
    usedAt: z.string(),
    skillPath: z.string().optional(),
    skillSource: z.enum(["project", "user", "global", "built-in"]).optional(),
    sessionId: z.string(),
    workingDirectory: z.string(),
  })
  .passthrough();

const transcriptRecordSchema = z
  .object({
    sessionId: z.string(),
    turnId: z.string(),
    workingDirectory: z.string(),
    messageStartIndex: z.number().int().nonnegative(),
    messageEndIndex: z.number().int().nonnegative(),
    transcript: z.string(),
  })
  .passthrough();

const jobSchema = z
  .object({
    skillName: z.string(),
    workingDirectory: z.string().optional(),
    runAt: z.string(),
    lastUsageAt: z.string(),
    usageEvents: z.array(usageEventSchema),
    transcripts: z.array(transcriptRecordSchema),
    status: z.enum(["pending", "running"]).optional(),
    startedAt: z.string().optional(),
    updatedAt: z.string(),
  })
  .passthrough();

const historyEntrySchema = z
  .object({
    id: z.string(),
    skillName: z.string(),
    status: z.enum(["completed", "failed", "skipped"]),
    startedAt: z.string(),
    finishedAt: z.string(),
    message: z.string(),
    usageCount: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .passthrough();

const backupRecordSchema = z
  .object({
    key: z.string(),
    skillName: z.string(),
    sourceRootDir: z.string(),
    backupRootDir: z.string(),
    createdAt: z.string(),
    restoreMode: z.enum(["copy-back", "delete-shadow"]),
    shadowRootDir: z.string().optional(),
  })
  .passthrough();

const stateSchema = z
  .object({
    version: z.literal(1),
    pendingJobs: z.record(z.string(), jobSchema),
    runHistory: z.array(historyEntrySchema),
    backups: z.record(z.string(), backupRecordSchema),
  })
  .passthrough();

const RUN_HISTORY_LIMIT = 50;
/** How long a state-file write lock may exist before another writer breaks it. */
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_MAX_WAIT_MS = 5_000;

function emptyState(): SkillImprovementState {
  return {
    version: 1,
    pendingJobs: {},
    runHistory: [],
    backups: {},
  };
}

/**
 * Project-scope skills only exist inside one workspace, so two workspaces can
 * legitimately install different skills under the same name. Their jobs must
 * not collapse into one queue entry; global/user/built-in skills resolve
 * identically everywhere and share a name-only key.
 */
function jobKeyForUsage(usage: {
  skillName: string;
  skillSource?: string;
  workingDirectory: string;
}): string {
  const name = usage.skillName.trim();
  if (!name) return "";
  return usage.skillSource === "project" ? `${name}@@${usage.workingDirectory}` : name;
}

function maxIso(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function isStaleRunning(job: SkillImprovementJob, nowMs: number): boolean {
  if ((job.status ?? "pending") !== "running") return false;
  const startedMs = job.startedAt ? new Date(job.startedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startedMs)) return true;
  return nowMs - startedMs >= SKILL_IMPROVEMENT_STALE_RUNNING_MS;
}

/** Flip crashed "running" jobs back to pending so they become claimable again. */
function recoverStaleRunningJobs(state: SkillImprovementState, nowMs: number): void {
  for (const job of Object.values(state.pendingJobs)) {
    if (isStaleRunning(job, nowMs)) {
      job.status = "pending";
      job.startedAt = undefined;
    }
  }
}

export class SkillImprovementJobStore {
  readonly rootDir: string;
  readonly statePath: string;

  private updateQueue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, "state.json");
  }

  backupMetaPath(key: string): string {
    return path.join(this.rootDir, "originals", `${key}.meta.json`);
  }

  async read(): Promise<SkillImprovementState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return emptyState();
      }
      return await this.recoverFromCorruptState();
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return await this.recoverFromCorruptState();
    }
    const parsed = stateSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return await this.recoverFromCorruptState();
    }
    return {
      version: 1,
      pendingJobs: parsed.data.pendingJobs,
      runHistory: parsed.data.runHistory.slice(0, RUN_HISTORY_LIMIT),
      backups: parsed.data.backups,
    };
  }

  async enqueueCompletedTurn(completed: CompletedTurnSkillUsage): Promise<void> {
    if (completed.usages.length === 0) return;
    const transcriptRecord = {
      sessionId: completed.sessionId,
      turnId: completed.turnId,
      workingDirectory: completed.workingDirectory,
      messageStartIndex: completed.messageStartIndex,
      messageEndIndex: completed.messageEndIndex,
      transcript: completed.transcript,
    };
    await this.update((state) => {
      for (const usage of completed.usages) {
        const key = jobKeyForUsage({ ...usage, workingDirectory: completed.workingDirectory });
        if (!key) continue;
        const usedAtMs = new Date(usage.usedAt).getTime();
        const runAt = new Date(
          Number.isFinite(usedAtMs) ? usedAtMs + SKILL_IMPROVEMENT_DEBOUNCE_MS : Date.now(),
        ).toISOString();
        const event = {
          ...usage,
          sessionId: completed.sessionId,
          workingDirectory: completed.workingDirectory,
        };
        const current = state.pendingJobs[key];
        if (!current) {
          state.pendingJobs[key] = {
            skillName: usage.skillName,
            ...(usage.skillSource === "project"
              ? { workingDirectory: completed.workingDirectory }
              : {}),
            runAt,
            lastUsageAt: usage.usedAt,
            usageEvents: [event],
            transcripts: [transcriptRecord],
            status: "pending",
            updatedAt: new Date().toISOString(),
          };
          continue;
        }
        const running = (current.status ?? "pending") === "running";
        current.runAt = maxIso(current.runAt, runAt);
        current.lastUsageAt = maxIso(current.lastUsageAt, usage.usedAt);
        current.usageEvents.push(event);
        // A turn's transcript is shared by every usage in that turn — store it once.
        if (
          !current.transcripts.some(
            (record) =>
              record.sessionId === transcriptRecord.sessionId &&
              record.turnId === transcriptRecord.turnId,
          )
        ) {
          current.transcripts.push(transcriptRecord);
        }
        // While a run is in flight the head of these arrays is the claimed
        // snapshot finishJob will slice off — trimming now would misalign it.
        if (!running) {
          current.usageEvents = current.usageEvents.slice(-SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB);
          current.transcripts = current.transcripts.slice(
            -SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB,
          );
          current.status = "pending";
          current.startedAt = undefined;
        }
        current.updatedAt = new Date().toISOString();
      }
    });
  }

  async claimDueJob(now = new Date()): Promise<ClaimedSkillImprovementJob | null> {
    let claimed: ClaimedSkillImprovementJob | null = null;
    await this.update((state) => {
      const nowMs = now.getTime();
      recoverStaleRunningJobs(state, nowMs);
      const due = Object.entries(state.pendingJobs)
        .filter(([, job]) => (job.status ?? "pending") === "pending")
        .filter(([, job]) => new Date(job.runAt).getTime() <= nowMs)
        .sort(
          ([, left], [, right]) => new Date(left.runAt).getTime() - new Date(right.runAt).getTime(),
        )[0];
      if (!due) return;
      const [key, job] = due;
      job.status = "running";
      job.startedAt = now.toISOString();
      job.updatedAt = now.toISOString();
      claimed = { key, job: structuredClone(job) };
    });
    return claimed;
  }

  /**
   * Claim a pending job by skill name. When multiple workspaces queued jobs
   * for the same name, `cwd` selects the workspace-scoped one; a job without a
   * workspace binding is the fallback. Returns null when absent or running.
   */
  async claimJob(
    skillName: string,
    opts: { cwd?: string; now?: Date } = {},
  ): Promise<ClaimedSkillImprovementJob | null> {
    const name = skillName.trim();
    const now = opts.now ?? new Date();
    let claimed: ClaimedSkillImprovementJob | null = null;
    await this.update((state) => {
      recoverStaleRunningJobs(state, now.getTime());
      const candidates = Object.entries(state.pendingJobs)
        .filter(([, job]) => job.skillName.trim() === name)
        .filter(([, job]) => (job.status ?? "pending") === "pending")
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
      const entry =
        (opts.cwd ? candidates.find(([, job]) => job.workingDirectory === opts.cwd) : undefined) ??
        candidates.find(([, job]) => !job.workingDirectory) ??
        candidates[0];
      if (!entry) return;
      const [key, job] = entry;
      job.status = "running";
      job.startedAt = now.toISOString();
      job.updatedAt = now.toISOString();
      claimed = { key, job: structuredClone(job) };
    });
    return claimed;
  }

  async claimJobByKey(key: string, now = new Date()): Promise<ClaimedSkillImprovementJob | null> {
    let claimed: ClaimedSkillImprovementJob | null = null;
    await this.update((state) => {
      recoverStaleRunningJobs(state, now.getTime());
      const job = state.pendingJobs[key];
      if (!job || (job.status ?? "pending") === "running") return;
      job.status = "running";
      job.startedAt = now.toISOString();
      job.updatedAt = now.toISOString();
      claimed = { key, job: structuredClone(job) };
    });
    return claimed;
  }

  async rescheduleJob(
    key: string,
    runAt: Date,
    opts: { historyMessage?: string } = {},
  ): Promise<void> {
    await this.update((state) => {
      const job = state.pendingJobs[key];
      if (!job) return;
      job.status = "pending";
      job.startedAt = undefined;
      job.runAt = runAt.toISOString();
      job.updatedAt = new Date().toISOString();
      if (opts.historyMessage) {
        pushHistory(state, {
          id: crypto.randomUUID(),
          skillName: job.skillName,
          status: "skipped",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          message: opts.historyMessage,
          usageCount: job.usageEvents.length,
        });
      }
    });
  }

  async finishJob(input: {
    key: string;
    skillName: string;
    status: SkillImprovementRunHistoryEntry["status"];
    startedAt: string;
    finishedAt: string;
    message: string;
    /** Evidence counts from the claimed snapshot — anything beyond is newer. */
    processedUsageCount: number;
    processedTranscriptCount: number;
    error?: string;
  }): Promise<void> {
    await this.update((state) => {
      const job = state.pendingJobs[input.key];
      if (job) {
        // Usage recorded while the run was in flight must survive as a fresh
        // pending job rather than being deleted with the processed batch.
        const remainingUsages = job.usageEvents.slice(input.processedUsageCount);
        const remainingTranscripts = job.transcripts.slice(input.processedTranscriptCount);
        if (remainingUsages.length === 0) {
          delete state.pendingJobs[input.key];
        } else {
          const lastUsageAt = remainingUsages.reduce(
            (latest, usage) => maxIso(latest, usage.usedAt),
            remainingUsages[0]?.usedAt ?? job.lastUsageAt,
          );
          const lastUsedMs = new Date(lastUsageAt).getTime();
          job.usageEvents = remainingUsages.slice(-SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB);
          job.transcripts = remainingTranscripts.slice(-SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB);
          job.lastUsageAt = lastUsageAt;
          job.runAt = new Date(
            (Number.isFinite(lastUsedMs) ? lastUsedMs : Date.now()) + SKILL_IMPROVEMENT_DEBOUNCE_MS,
          ).toISOString();
          job.status = "pending";
          job.startedAt = undefined;
          job.updatedAt = new Date().toISOString();
        }
      }
      pushHistory(state, {
        id: crypto.randomUUID(),
        skillName: input.skillName,
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        message: input.message,
        usageCount: input.processedUsageCount,
        ...(input.error ? { error: input.error } : {}),
      });
    });
  }

  /** Record an outcome without touching the pending queue (e.g. manual no-op runs). */
  async recordHistory(entry: Omit<SkillImprovementRunHistoryEntry, "id">): Promise<void> {
    await this.update((state) => {
      pushHistory(state, { id: crypto.randomUUID(), ...entry });
    });
  }

  async registerBackup(record: SkillImprovementBackupRecord): Promise<void> {
    await this.update(async (state) => {
      state.backups[record.key] = record;
      // Sidecar metadata lets the backup registry be rebuilt if state.json is lost.
      await fs.mkdir(path.dirname(this.backupMetaPath(record.key)), { recursive: true });
      await writeTextFileAtomic(
        this.backupMetaPath(record.key),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    });
  }

  async removeBackup(key: string): Promise<void> {
    await this.update(async (state) => {
      delete state.backups[key];
      await fs.rm(this.backupMetaPath(key), { force: true }).catch(() => {});
    });
  }

  async recoverStaleRunning(now = new Date()): Promise<void> {
    await this.update((state) => {
      recoverStaleRunningJobs(state, now.getTime());
    });
  }

  private async recoverFromCorruptState(): Promise<SkillImprovementState> {
    // Never silently discard state: park the unreadable file and rebuild what
    // we can. Backups are the critical part — their sidecar meta files under
    // originals/ let restore keep working after state.json corruption.
    await fs
      .rename(this.statePath, `${this.statePath}.corrupt`)
      .catch(() => fs.rm(this.statePath, { force: true }).catch(() => {}));
    const state = emptyState();
    const originalsDir = path.join(this.rootDir, "originals");
    const entries = await fs.readdir(originalsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      try {
        const raw = await fs.readFile(path.join(originalsDir, entry), "utf-8");
        const parsed = backupRecordSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          state.backups[parsed.data.key] = parsed.data;
        }
      } catch {
        // Skip unreadable sidecars; the remaining backups still restore.
      }
    }
    return state;
  }

  private async update(
    mutator: (state: SkillImprovementState) => void | Promise<void>,
  ): Promise<void> {
    const run = this.updateQueue.then(async () => {
      const releaseLock = await this.acquireStateLock();
      try {
        const state = await this.read();
        await mutator(state);
        await fs.mkdir(this.rootDir, { recursive: true });
        await writeTextFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
      } finally {
        await releaseLock();
      }
    });
    this.updateQueue = run.catch(() => undefined);
    await run;
  }

  /**
   * Cross-process advisory lock around read-modify-write of state.json. The
   * state file is shared by every server process (one per workspace), so an
   * unlocked write could clobber a concurrent enqueue/finish from another
   * process. Writers hold the lock for milliseconds; anything older than
   * STATE_LOCK_STALE_MS is treated as a crashed writer and broken.
   */
  private async acquireStateLock(): Promise<() => Promise<void>> {
    const lockPath = path.join(this.rootDir, "state.lock");
    await fs.mkdir(this.rootDir, { recursive: true });
    const deadline = Date.now() + STATE_LOCK_MAX_WAIT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle
          .writeFile(JSON.stringify({ pid: process.pid, lockedAt: new Date().toISOString() }))
          .catch(() => {});
        return async () => {
          await handle.close().catch(() => {});
          await removeWithRetry(lockPath, { bestEffort: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
          throw error;
        }
      }
      let lockAge: number | null = null;
      let isEnoent = false;
      try {
        const stat = await fs.stat(lockPath);
        lockAge = Date.now() - stat.mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          isEnoent = true;
        }
      }
      if (isEnoent) {
        continue;
      }
      if ((lockAge !== null && lockAge >= STATE_LOCK_STALE_MS) || Date.now() >= deadline) {
        await removeWithRetry(lockPath, { bestEffort: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
    }
  }
}

function pushHistory(state: SkillImprovementState, entry: SkillImprovementRunHistoryEntry): void {
  state.runHistory.unshift(entry);
  state.runHistory = state.runHistory.slice(0, RUN_HISTORY_LIMIT);
}
