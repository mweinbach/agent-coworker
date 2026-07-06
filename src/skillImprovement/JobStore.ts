import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeTextFileAtomic } from "../utils/atomicFile";
import {
  SKILL_IMPROVEMENT_DEBOUNCE_MS,
  type SkillImprovementBackupRecord,
  type SkillImprovementJob,
  type SkillImprovementRunHistoryEntry,
  type SkillImprovementState,
  type SkillImprovementUsageEvent,
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
    messageStartIndex: z.number().int().nonnegative(),
    messageEndIndex: z.number().int().nonnegative(),
    transcript: z.string(),
  })
  .passthrough();

const jobSchema = z
  .object({
    skillName: z.string(),
    runAt: z.string(),
    lastUsageAt: z.string(),
    usageEvents: z.array(usageEventSchema),
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

function emptyState(): SkillImprovementState {
  return {
    version: 1,
    pendingJobs: {},
    runHistory: [],
    backups: {},
  };
}

function jobKey(skillName: string): string {
  return skillName.trim();
}

function maxIso(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

export class SkillImprovementJobStore {
  readonly rootDir: string;
  readonly statePath: string;

  private updateQueue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, "state.json");
  }

  async read(): Promise<SkillImprovementState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      const parsed = stateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return emptyState();
      return {
        version: 1,
        pendingJobs: Object.fromEntries(
          Object.entries(parsed.data.pendingJobs).map(([key, job]) => [
            key,
            {
              ...job,
              status: job.status === "running" ? "pending" : (job.status ?? "pending"),
              startedAt: job.status === "running" ? undefined : job.startedAt,
            },
          ]),
        ),
        runHistory: parsed.data.runHistory.slice(0, RUN_HISTORY_LIMIT),
        backups: parsed.data.backups,
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return emptyState();
      }
      return emptyState();
    }
  }

  async enqueueUsageEvents(events: SkillImprovementUsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.update((state) => {
      for (const event of events) {
        const key = jobKey(event.skillName);
        if (!key) continue;
        const usedAtMs = new Date(event.usedAt).getTime();
        const runAt = new Date(
          Number.isFinite(usedAtMs) ? usedAtMs + SKILL_IMPROVEMENT_DEBOUNCE_MS : Date.now(),
        ).toISOString();
        const current = state.pendingJobs[key];
        if (!current) {
          state.pendingJobs[key] = {
            skillName: event.skillName,
            runAt,
            lastUsageAt: event.usedAt,
            usageEvents: [event],
            status: "pending",
            updatedAt: new Date().toISOString(),
          };
          continue;
        }
        current.runAt = maxIso(current.runAt, runAt);
        current.lastUsageAt = maxIso(current.lastUsageAt, event.usedAt);
        current.usageEvents.push(event);
        current.status = "pending";
        current.startedAt = undefined;
        current.updatedAt = new Date().toISOString();
      }
    });
  }

  async claimDueJob(now = new Date()): Promise<SkillImprovementJob | null> {
    let claimed: SkillImprovementJob | null = null;
    await this.update((state) => {
      const nowMs = now.getTime();
      const due = Object.values(state.pendingJobs)
        .filter((job) => (job.status ?? "pending") === "pending")
        .filter((job) => new Date(job.runAt).getTime() <= nowMs)
        .sort((left, right) => new Date(left.runAt).getTime() - new Date(right.runAt).getTime())[0];
      if (!due) return;
      due.status = "running";
      due.startedAt = now.toISOString();
      due.updatedAt = now.toISOString();
      claimed = structuredClone(due);
    });
    return claimed;
  }

  async claimJob(skillName: string, now = new Date()): Promise<SkillImprovementJob | null> {
    const key = jobKey(skillName);
    let claimed: SkillImprovementJob | null = null;
    await this.update((state) => {
      const job = state.pendingJobs[key];
      if (!job) return;
      job.status = "running";
      job.startedAt = now.toISOString();
      job.updatedAt = now.toISOString();
      claimed = structuredClone(job);
    });
    return claimed;
  }

  async rescheduleJob(skillName: string, runAt: Date, message: string): Promise<void> {
    const key = jobKey(skillName);
    await this.update((state) => {
      const job = state.pendingJobs[key];
      if (!job) return;
      job.status = "pending";
      job.startedAt = undefined;
      job.runAt = runAt.toISOString();
      job.updatedAt = new Date().toISOString();
      state.runHistory.unshift({
        id: crypto.randomUUID(),
        skillName,
        status: "skipped",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message,
        usageCount: job.usageEvents.length,
      });
      state.runHistory = state.runHistory.slice(0, RUN_HISTORY_LIMIT);
    });
  }

  async finishJob(input: {
    skillName: string;
    status: SkillImprovementRunHistoryEntry["status"];
    startedAt: string;
    finishedAt: string;
    message: string;
    usageCount: number;
    error?: string;
  }): Promise<void> {
    const key = jobKey(input.skillName);
    await this.update((state) => {
      delete state.pendingJobs[key];
      state.runHistory.unshift({
        id: crypto.randomUUID(),
        skillName: input.skillName,
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        message: input.message,
        usageCount: input.usageCount,
        ...(input.error ? { error: input.error } : {}),
      });
      state.runHistory = state.runHistory.slice(0, RUN_HISTORY_LIMIT);
    });
  }

  async registerBackup(record: SkillImprovementBackupRecord): Promise<void> {
    await this.update((state) => {
      state.backups[record.key] = record;
    });
  }

  async removeBackup(key: string): Promise<void> {
    await this.update((state) => {
      delete state.backups[key];
    });
  }

  private async update(
    mutator: (state: SkillImprovementState) => void | Promise<void>,
  ): Promise<void> {
    const run = this.updateQueue.then(async () => {
      const state = await this.read();
      await mutator(state);
      await fs.mkdir(this.rootDir, { recursive: true });
      await writeTextFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    });
    this.updateQueue = run.catch(() => undefined);
    await run;
  }
}

export const __internalJobStore = {
  emptyState,
  jobKey,
};
