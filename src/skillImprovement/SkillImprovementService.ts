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
import { prepareSkillImprovementTarget, restoreSkillImprovementBackup } from "./backups";
import { SkillImprovementJobStore } from "./JobStore";
import { SkillImprover } from "./SkillImprover";
import {
  type CompletedTurnSkillUsage,
  SKILL_IMPROVEMENT_SCHEDULER_INTERVAL_MS,
  type SkillImprovementEligibility,
  type SkillImprovementJob,
  type SkillImprovementPendingJobSummary,
  type SkillImprovementStatusEvent,
  type SkillImprovementUsageEvent,
} from "./types";

const RESCHEDULE_WHILE_BUSY_MS = 60_000;

type SkillImprovementRunner = Pick<SkillImprover, "run">;

export type SkillImprovementServiceDeps = {
  config: AgentConfig;
  getConfig: () => AgentConfig;
  store?: SkillImprovementJobStore;
  improver?: SkillImprovementRunner;
  hasBusySessions: () => boolean;
  signalSkillMutation: () => Promise<void>;
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
  if (scope === "all") return sourceKind !== "invalid" && sourceKind !== "plugin";
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
  if (input.sourceKind === "plugin") return "Plugin-owned skills are updated by plugin installs.";
  if (!input.included) return "Outside the configured improvement scope.";
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
    const config = this.deps.getConfig();
    if (!config.skillImprovementEnabled) return;
    if (completed.usages.length === 0) return;
    const events: SkillImprovementUsageEvent[] = completed.usages.map((usage) => ({
      ...usage,
      sessionId: completed.sessionId,
      workingDirectory: completed.workingDirectory,
      messageStartIndex: completed.messageStartIndex,
      messageEndIndex: completed.messageEndIndex,
      transcript: completed.transcript,
    }));
    await this.store.enqueueUsageEvents(events);
  }

  async getStatus(sessionId: string): Promise<SkillImprovementStatusEvent> {
    const config = this.deps.getConfig();
    const state = await this.store.read();
    const scope = config.skillImprovementScope ?? "user";
    const excludedSkills = [...new Set(config.skillImprovementExcludedSkills ?? [])].sort();
    const excluded = new Set(excludedSkills);
    const catalog = await buildSkillCatalog(config);
    const skills = catalog.installations
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
          hasBackup: Object.values(state.backups).some(
            (backup) => backup.skillName === installation.name,
          ),
          ...(installation.plugin ? { pluginName: installation.plugin.displayName } : {}),
        } satisfies SkillImprovementEligibility;
      })
      .sort((left, right) => left.skillName.localeCompare(right.skillName));

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
      const config = this.deps.getConfig();
      if (!config.skillImprovementEnabled) return;
      const job = await this.store.claimDueJob();
      if (!job) return;
      await this.runClaimedJob(job);
    });
  }

  async runNow(skillName?: string): Promise<void> {
    await this.enqueueRun(async () => {
      const config = this.deps.getConfig();
      if (!config.skillImprovementEnabled) return;
      const state = await this.store.read();
      const targetName =
        skillName ??
        summarizePendingJobs(state.pendingJobs).find((job) => job.status === "pending")?.skillName;
      if (!targetName) return;
      const claimed = await this.store.claimJob(targetName);
      const job =
        claimed ??
        ({
          skillName: targetName,
          runAt: new Date().toISOString(),
          lastUsageAt: new Date().toISOString(),
          usageEvents: [],
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies SkillImprovementJob);
      await this.runClaimedJob(job);
    });
  }

  async restore(skillName: string): Promise<void> {
    const state = await this.store.read();
    const backups = Object.values(state.backups).filter((backup) => backup.skillName === skillName);
    for (const backup of backups) {
      await restoreSkillImprovementBackup({ store: this.store, backup });
      await this.store.removeBackup(backup.key);
    }
    if (backups.length > 0) {
      await this.deps.signalSkillMutation();
    }
  }

  private async enqueueRun(operation: () => Promise<void>): Promise<void> {
    const next = this.runQueue.then(operation, operation);
    this.runQueue = next.catch(() => {
      // Keep future scheduler passes alive.
    });
    await next;
  }

  private async runClaimedJob(job: SkillImprovementJob): Promise<void> {
    const startedAt = job.startedAt ?? new Date().toISOString();
    if (this.deps.hasBusySessions()) {
      await this.store.rescheduleJob(
        job.skillName,
        new Date(Date.now() + RESCHEDULE_WHILE_BUSY_MS),
        "Skill improvement paused while a session is running.",
      );
      return;
    }

    const lockHandle = await this.acquireLock(job.skillName);
    if (!lockHandle) {
      await this.store.rescheduleJob(
        job.skillName,
        new Date(Date.now() + RESCHEDULE_WHILE_BUSY_MS),
        "Skill improvement skipped because another process holds the lock.",
      );
      return;
    }

    try {
      const config = this.deps.getConfig();
      const catalog = await buildSkillCatalog(config);
      const status = await this.getStatus("skill-improvement");
      const targetEligibility = status.skills.find((skill) => skill.skillName === job.skillName);
      const installation = catalog.effectiveSkills.find((skill) => skill.name === job.skillName);
      if (!targetEligibility?.eligible || !installation?.skillPath) {
        await this.store.finishJob({
          skillName: job.skillName,
          status: "skipped",
          startedAt,
          finishedAt: new Date().toISOString(),
          message: targetEligibility?.reason ?? "Skill is not eligible for improvement.",
          usageCount: job.usageEvents.length,
        });
        return;
      }

      const target = await prepareSkillImprovementTarget({
        config,
        store: this.store,
        installation,
      });
      const allSkills = await discoverSkillsForConfig(config, { includeDisabled: true });
      const result = await this.improver.run({
        config,
        input: {
          skillName: job.skillName,
          skillRootDir: target.targetRootDir,
          skillPath: target.targetSkillPath,
          sourceKind: targetEligibility.sourceKind,
          usageEvents: job.usageEvents,
          allSkills,
        },
        log: this.log,
      });

      if (!result.ok) {
        await restoreSkillImprovementBackup({ store: this.store, backup: target.backup });
        await this.store.finishJob({
          skillName: job.skillName,
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          message: result.message,
          usageCount: job.usageEvents.length,
          ...(result.error ? { error: result.error } : {}),
        });
        return;
      }

      await this.store.finishJob({
        skillName: job.skillName,
        status: result.changed ? "completed" : "skipped",
        startedAt,
        finishedAt: new Date().toISOString(),
        message: result.message,
        usageCount: job.usageEvents.length,
      });
      if (result.changed) {
        await this.deps.signalSkillMutation();
      }
    } finally {
      await lockHandle.release();
    }
  }

  private async acquireLock(skillName: string): Promise<{ release: () => Promise<void> } | null> {
    const lockPath = path.join(this.store.rootDir, "skill-improvement.lock");
    await fs.mkdir(this.store.rootDir, { recursive: true });
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        return null;
      }
      throw error;
    }
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, skillName, startedAt: new Date().toISOString() }),
      "utf-8",
    );
    return {
      release: async () => {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      },
    };
  }
}
