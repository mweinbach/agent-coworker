import fs from "node:fs/promises";
import path from "node:path";
import { buildPluginCatalogSnapshot, comparePluginCatalogEntries } from "../plugins";
import { discoverSkillsForConfig } from "../skills";
import {
  getSkillScopeDescriptors,
  type SkillCatalogSource,
  scanSkillCatalogFromSources,
} from "../skills/catalog";
import type { AgentConfig, SkillCatalogSnapshot, SkillInstallationEntry } from "../types";
import {
  createPrerunSnapshot,
  deleteSkillImprovementBackupArtifacts,
  discardPrerunSnapshot,
  prepareSkillImprovementTarget,
  restorePrerunSnapshot,
  restoreSkillImprovementBackup,
} from "./backups";
import { SkillImprovementJobStore } from "./JobStore";
import { SkillImprover } from "./SkillImprover";
import {
  type ClaimedSkillImprovementJob,
  type CompletedTurnSkillUsage,
  SKILL_IMPROVEMENT_SCHEDULER_INTERVAL_MS,
  SKILL_IMPROVEMENT_STALE_LOCK_MS,
  type SkillImprovementEligibility,
  type SkillImprovementJob,
  type SkillImprovementPendingJobSummary,
  type SkillImprovementState,
  type SkillImprovementStatusEvent,
  type SkillImproverRunResult,
} from "./types";

const RESCHEDULE_WHILE_BUSY_MS = 60_000;

type SkillImprovementRunner = Pick<SkillImprover, "run">;

export type SkillImprovementServiceDeps = {
  config: AgentConfig;
  /**
   * Resolve the current effective config, optionally for a specific workspace.
   * Must reflect settings changes made after server startup — configuration
   * applied through workspace control sessions only persists to disk, so the
   * server wiring reloads from disk here rather than serving a boot snapshot.
   */
  getConfig: (cwd?: string) => AgentConfig | Promise<AgentConfig>;
  store?: SkillImprovementJobStore;
  improver?: SkillImprovementRunner;
  hasBusySessions: () => boolean;
  signalSkillMutation: () => Promise<void>;
  /** Push a fresh status event to connected clients after background runs. */
  broadcastStatus?: (event: SkillImprovementStatusEvent) => void;
  log?: (line: string) => void;
};

function resolveStoreRoot(config: AgentConfig): string {
  return path.join(config.userCoworkDir, "skill-improvement");
}

function sourceKindForInstallation(
  installation: SkillInstallationEntry,
): SkillImprovementEligibility["sourceKind"] {
  if (installation.state === "invalid") return "invalid";
  if (installation.plugin) return "plugin";
  if (installation.scope === "built-in") return "built-in";
  const originKind = installation.origin?.kind;
  if (originKind && originKind !== "local" && originKind !== "manual") {
    return "marketplace";
  }
  return "user";
}

function isIncludedByScope(
  sourceKind: SkillImprovementEligibility["sourceKind"],
  scope: SkillImprovementStatusEvent["scope"],
): boolean {
  if (scope === "all") return sourceKind !== "invalid";
  return sourceKind === "user";
}

function eligibilityReason(input: {
  installation: SkillInstallationEntry;
  sourceKind: SkillImprovementEligibility["sourceKind"];
  included: boolean;
  excluded: boolean;
}): string | undefined {
  if (input.installation.state === "invalid") return "Invalid skill installation.";
  if (!input.installation.enabled) return "Skill is disabled.";
  if (!input.installation.effective) return "Skill is shadowed by another installation.";
  if (input.excluded) return "Excluded in settings.";
  if (!input.included) {
    return input.sourceKind === "user"
      ? "Outside the configured improvement scope."
      : "Included only in the all-skills scope.";
  }
  if (!input.installation.skillPath) return "Missing SKILL.md.";
  return undefined;
}

async function buildSkillCatalog(config: AgentConfig): Promise<SkillCatalogSnapshot> {
  const pluginCatalog = await buildPluginCatalogSnapshot(config);
  const orderedPlugins = [...pluginCatalog.plugins].sort(comparePluginCatalogEntries);
  const sources: SkillCatalogSource[] = [
    ...getSkillScopeDescriptors(config.skillsDirs).map((descriptor) => ({
      kind: "standalone" as const,
      descriptor,
    })),
    ...orderedPlugins.flatMap((plugin) =>
      plugin.skills.map((skill) => ({
        kind: "plugin" as const,
        plugin,
        skill,
        enabled: skill.enabled,
      })),
    ),
  ];
  return await scanSkillCatalogFromSources(sources, { includeDisabled: true });
}

function buildEligibilityEntries(input: {
  config: AgentConfig;
  state: SkillImprovementState;
  catalog: SkillCatalogSnapshot;
}): SkillImprovementEligibility[] {
  const scope = input.config.skillImprovementScope ?? "user";
  const excluded = new Set(input.config.skillImprovementExcludedSkills ?? []);
  return input.catalog.installations
    .map((installation) => {
      const sourceKind = sourceKindForInstallation(installation);
      const included = isIncludedByScope(sourceKind, scope);
      const isExcluded = excluded.has(installation.name);
      const reason = eligibilityReason({
        installation,
        sourceKind,
        included,
        excluded: isExcluded,
      });
      const eligible = !reason && included && !isExcluded;
      return {
        skillName: installation.name,
        installationId: installation.installationId,
        scope: installation.scope,
        enabled: installation.enabled,
        effective: installation.effective,
        eligible,
        included,
        excluded: isExcluded,
        writable: installation.writable,
        sourceKind,
        ...(reason ? { reason } : {}),
        rootDir: installation.rootDir,
        skillPath: installation.skillPath ?? path.join(installation.rootDir, "SKILL.md"),
        hasBackup: Object.values(input.state.backups).some(
          (backup) => backup.skillName === installation.name,
        ),
        ...(installation.plugin ? { pluginName: installation.plugin.displayName } : {}),
      } satisfies SkillImprovementEligibility;
    })
    .sort((left, right) => left.skillName.localeCompare(right.skillName));
}

function summarizePendingJobs(
  jobs: Record<string, SkillImprovementJob>,
): SkillImprovementPendingJobSummary[] {
  return Object.values(jobs)
    .map((job) => ({
      skillName: job.skillName,
      runAt: job.runAt,
      lastUsageAt: job.lastUsageAt,
      usageCount: job.usageEvents.length,
      status: job.status ?? "pending",
      sources: [...new Set(job.usageEvents.map((event) => event.source))].sort(),
      kinds: [...new Set(job.usageEvents.map((event) => event.kind))].sort(),
    }))
    .sort((left, right) => new Date(left.runAt).getTime() - new Date(right.runAt).getTime());
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export class SkillImprovementService {
  private readonly store: SkillImprovementJobStore;
  private readonly improver: SkillImprovementRunner;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SkillImprovementServiceDeps) {
    this.store = deps.store ?? new SkillImprovementJobStore(resolveStoreRoot(deps.config));
    this.improver = deps.improver ?? new SkillImprover();
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    // Jobs claimed by a process that crashed mid-run stay "running" in the
    // shared state file; recover them once at startup so they reschedule.
    void this.store.recoverStaleRunning().catch(() => {});
    this.timer = setInterval(() => {
      void this.runDueJob().catch((error) => {
        this.log(`[skill-improvement] scheduler failed: ${String(error)}`);
      });
    }, SKILL_IMPROVEMENT_SCHEDULER_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async recordCompletedTurnUsage(completed: CompletedTurnSkillUsage): Promise<void> {
    const config = await this.deps.getConfig();
    if (!config.skillImprovementEnabled) return;
    if (completed.usages.length === 0) return;
    await this.store.enqueueCompletedTurn(completed);
  }

  async getStatus(sessionId: string, cwd?: string): Promise<SkillImprovementStatusEvent> {
    const config = await this.deps.getConfig(cwd);
    const state = await this.store.read();
    const scope = config.skillImprovementScope ?? "user";
    const excludedSkills = [...new Set(config.skillImprovementExcludedSkills ?? [])].sort();
    const catalog = await buildSkillCatalog(config);
    const skills = buildEligibilityEntries({ config, state, catalog });

    const busy = this.deps.hasBusySessions();
    return {
      type: "skill_improvement_status",
      sessionId,
      enabled: config.skillImprovementEnabled ?? false,
      ...(config.skillImprovementModel ? { model: config.skillImprovementModel } : {}),
      scope,
      excludedSkills,
      busy,
      blockReason: busy ? "Skill improvement is paused while a session is running." : null,
      pendingJobs: summarizePendingJobs(state.pendingJobs),
      runHistory: state.runHistory,
      backups: Object.values(state.backups).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
      skills,
    };
  }

  async runDueJob(): Promise<void> {
    await this.enqueueRun(async () => {
      const config = await this.deps.getConfig();
      if (!config.skillImprovementEnabled) return;
      const claimed = await this.store.claimDueJob();
      if (!claimed) return;
      const outcome = await this.runClaimedJob(claimed, { manual: false });
      if (outcome === "done") {
        this.broadcastStatusSafe();
      }
    });
  }

  /**
   * Run improvements immediately: a specific skill by name, or every queued
   * job when no name is given. Debounce windows are ignored; the busy and
   * cross-process gates still apply.
   */
  async runNow(skillName?: string, cwd?: string): Promise<void> {
    await this.enqueueRun(async () => {
      const config = await this.deps.getConfig(cwd);
      if (!config.skillImprovementEnabled) return;

      try {
        if (skillName) {
          await this.runNamedSkillNow(skillName, cwd);
          return;
        }
        for (;;) {
          const state = await this.store.read();
          const nextPendingKey = Object.entries(state.pendingJobs)
            .filter(([, job]) => (job.status ?? "pending") === "pending")
            .sort(
              ([, left], [, right]) =>
                new Date(left.runAt).getTime() - new Date(right.runAt).getTime(),
            )[0]?.[0];
          if (!nextPendingKey) return;
          const claimed = await this.store.claimJobByKey(nextPendingKey);
          if (!claimed) return;
          const outcome = await this.runClaimedJob(claimed, { manual: true });
          if (outcome === "rescheduled") return;
        }
      } finally {
        // Every manual run mutates queue or history state, so always push the
        // refreshed status to connected clients.
        this.broadcastStatusSafe();
      }
    });
  }

  private async runNamedSkillNow(skillName: string, cwd?: string): Promise<void> {
    const state = await this.store.read();
    const running = Object.values(state.pendingJobs).find(
      (job) => job.skillName.trim() === skillName.trim() && (job.status ?? "pending") === "running",
    );
    if (running) {
      await this.store.recordHistory({
        skillName,
        status: "skipped",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: "An improvement run for this skill is already in progress.",
        usageCount: running.usageEvents.length,
      });
      return;
    }
    const claimed = await this.store.claimJob(skillName, { cwd });
    if (!claimed) {
      // Never fabricate an evidence-free job: improving without transcripts
      // invites hallucinated edits. Record why nothing happened instead.
      await this.store.recordHistory({
        skillName,
        status: "skipped",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: "No recorded usage evidence for this skill yet; use it in a turn first.",
        usageCount: 0,
      });
      return;
    }
    await this.runClaimedJob(claimed, { manual: true });
  }

  async restore(skillName: string): Promise<void> {
    await this.enqueueRun(async () => {
      if (this.deps.hasBusySessions()) {
        throw new Error(
          "Cannot restore a skill while a session is running. Try again when the workspace is idle.",
        );
      }
      const lockHandle = await this.acquireLock(`restore:${skillName}`);
      if (!lockHandle) {
        throw new Error("Skill improvement is busy in another process. Try again in a moment.");
      }
      try {
        const state = await this.store.read();
        const backups = Object.values(state.backups)
          .filter((backup) => backup.skillName === skillName)
          // Copy-backs must land before delete-shadow removes a shadow dir a
          // copy-back might otherwise recreate.
          .sort((left, right) =>
            left.restoreMode === right.restoreMode ? 0 : left.restoreMode === "copy-back" ? -1 : 1,
          );
        if (backups.length === 0) {
          throw new Error(`No skill improvement backup found for "${skillName}".`);
        }
        for (const backup of backups) {
          await restoreSkillImprovementBackup({ backup });
          await deleteSkillImprovementBackupArtifacts({ store: this.store, backup });
          await this.store.removeBackup(backup.key);
        }
        await this.deps.signalSkillMutation();
      } finally {
        await lockHandle.release();
      }
    });
    this.broadcastStatusSafe();
  }

  private async enqueueRun(operation: () => Promise<void>): Promise<void> {
    const next = this.runQueue.then(operation, operation);
    this.runQueue = next.catch(() => {
      // Keep future scheduler passes alive.
    });
    await next;
  }

  private async runClaimedJob(
    claimed: ClaimedSkillImprovementJob,
    opts: { manual: boolean },
  ): Promise<"done" | "rescheduled"> {
    const { key, job } = claimed;
    const startedAt = job.startedAt ?? new Date().toISOString();
    const processedCounts = {
      processedUsageCount: job.usageEvents.length,
      processedTranscriptCount: job.transcripts.length,
    };
    // Manual runs get a visible history entry when gated; scheduler retries
    // stay silent so a busy hour cannot flood the history with reschedules.
    const gateHistory = (message: string) => (opts.manual ? { historyMessage: message } : {});
    if (this.deps.hasBusySessions()) {
      await this.store.rescheduleJob(
        key,
        new Date(Date.now() + RESCHEDULE_WHILE_BUSY_MS),
        gateHistory("Skill improvement paused while a session is running."),
      );
      return "rescheduled";
    }

    const lockHandle = await this.acquireLock(job.skillName);
    if (!lockHandle) {
      await this.store.rescheduleJob(
        key,
        new Date(Date.now() + RESCHEDULE_WHILE_BUSY_MS),
        gateHistory("Skill improvement skipped because another process holds the lock."),
      );
      return "rescheduled";
    }

    let snapshotDir: string | null = null;
    let targetRootDir: string | null = null;
    try {
      // Resolve against the workspace the usage came from: project-scope
      // skills only exist there, and settings changes since server startup
      // must be honored.
      const config = await this.deps.getConfig(job.workingDirectory);
      const catalog = await buildSkillCatalog(config);
      const state = await this.store.read();
      const eligibility = buildEligibilityEntries({ config, state, catalog });
      // Prefer the exact SKILL.md the conversation actually loaded; fall back
      // to effective-by-name resolution when the recorded path is gone.
      const latestUsagePath = [...job.usageEvents]
        .reverse()
        .find((usage) => usage.skillPath)?.skillPath;
      const installation =
        (latestUsagePath
          ? catalog.installations.find(
              (entry) => entry.effective && entry.skillPath === latestUsagePath,
            )
          : undefined) ?? catalog.effectiveSkills.find((skill) => skill.name === job.skillName);
      const targetEligibility = installation
        ? eligibility.find((entry) => entry.installationId === installation.installationId)
        : undefined;
      if (!installation?.skillPath || !targetEligibility?.eligible) {
        await this.store.finishJob({
          key,
          skillName: job.skillName,
          status: "skipped",
          startedAt,
          finishedAt: new Date().toISOString(),
          message: targetEligibility?.reason ?? "Skill is not eligible for improvement.",
          ...processedCounts,
        });
        return "done";
      }

      const target = await prepareSkillImprovementTarget({
        config,
        store: this.store,
        installation,
      });
      targetRootDir = target.targetRootDir;
      snapshotDir = await createPrerunSnapshot({
        store: this.store,
        key: target.backup.key,
        targetRootDir: target.targetRootDir,
      });
      const allSkills = await discoverSkillsForConfig(config, { includeDisabled: true });
      let result: SkillImproverRunResult;
      try {
        result = await this.improver.run({
          config,
          input: {
            skillName: job.skillName,
            skillRootDir: target.targetRootDir,
            skillPath: target.targetSkillPath,
            sourceKind: targetEligibility.sourceKind,
            usageEvents: job.usageEvents,
            transcripts: job.transcripts,
            allSkills,
          },
          log: this.log,
        });
      } catch (error) {
        result = {
          ok: false,
          changed: true,
          message: "Skill improvement runtime failed.",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (!result.ok) {
        const rollbackError = await this.rollbackRun(snapshotDir, target.targetRootDir);
        await this.store.finishJob({
          key,
          skillName: job.skillName,
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          message: rollbackError
            ? `${result.message} Rollback also failed: ${rollbackError}`
            : result.message,
          ...processedCounts,
          ...(result.error ? { error: result.error } : {}),
        });
        return "done";
      }

      await this.store.finishJob({
        key,
        skillName: job.skillName,
        status: result.changed ? "completed" : "skipped",
        startedAt,
        finishedAt: new Date().toISOString(),
        message: result.message,
        ...processedCounts,
      });
      if (result.changed) {
        await this.deps.signalSkillMutation();
      }
      return "done";
    } catch (error) {
      // Failures outside the improver (catalog scan, backup copy, disk) must
      // still roll back and record a terminal outcome — otherwise the claimed
      // job would retry forever with no visible trace.
      const rollbackError =
        snapshotDir && targetRootDir ? await this.rollbackRun(snapshotDir, targetRootDir) : null;
      const message = error instanceof Error ? error.message : String(error);
      await this.store
        .finishJob({
          key,
          skillName: job.skillName,
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          message: rollbackError
            ? `Skill improvement failed: ${message}. Rollback also failed: ${rollbackError}`
            : `Skill improvement failed: ${message}`,
          ...processedCounts,
          error: message,
        })
        .catch(() => {});
      return "done";
    } finally {
      if (snapshotDir) {
        await discardPrerunSnapshot(snapshotDir);
      }
      await lockHandle.release();
    }
  }

  private async rollbackRun(snapshotDir: string, targetRootDir: string): Promise<string | null> {
    try {
      await restorePrerunSnapshot({ snapshotDir, targetRootDir });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[skill-improvement] rollback failed: ${message}`);
      return message;
    }
  }

  private broadcastStatusSafe(): void {
    const broadcast = this.deps.broadcastStatus;
    if (!broadcast) return;
    void this.getStatus("skill-improvement")
      .then((event) => broadcast(event))
      .catch((error) => {
        this.log(`[skill-improvement] status broadcast failed: ${String(error)}`);
      });
  }

  private async acquireLock(label: string): Promise<{ release: () => Promise<void> } | null> {
    const lockPath = path.join(this.store.rootDir, "skill-improvement.lock");
    await fs.mkdir(this.store.rootDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, label, startedAt: new Date().toISOString() }),
          "utf-8",
        );
        return {
          release: async () => {
            await handle.close().catch(() => {});
            await fs.rm(lockPath, { force: true }).catch(() => {});
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
          throw error;
        }
      }
      if (!(await this.isLockStale(lockPath))) {
        return null;
      }
      // A crashed process left the lock behind; break it and retry once.
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
    return null;
  }

  private async isLockStale(lockPath: string): Promise<boolean> {
    let startedAtMs: number | null = null;
    let pid: number | null = null;
    try {
      const raw = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
        pid?: unknown;
        startedAt?: unknown;
      };
      if (typeof raw.startedAt === "string") {
        const parsed = new Date(raw.startedAt).getTime();
        startedAtMs = Number.isFinite(parsed) ? parsed : null;
      }
      if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0) {
        pid = raw.pid;
      }
    } catch {
      // Unreadable lock contents: fall back to file mtime below.
    }
    if (startedAtMs === null) {
      startedAtMs = await fs
        .stat(lockPath)
        .then((stat) => stat.mtimeMs)
        .catch(() => null);
      if (startedAtMs === null) return true;
    }
    // Our own pid on disk means a leaked lock from this process — always stale.
    if (pid === process.pid) return true;
    if (pid !== null && !isPidAlive(pid)) return true;
    return Date.now() - startedAtMs >= SKILL_IMPROVEMENT_STALE_LOCK_MS;
  }
}
