import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillImprovementJobStore, SkillImprovementService } from "../src/skillImprovement";
import type {
  CompletedTurnSkillUsage,
  SkillImproverRunInput,
  SkillImproverRunResult,
} from "../src/skillImprovement/types";
import type { AgentConfig } from "../src/types";
import { makeConfig } from "./session/agentSession.harness";

const PAST_USED_AT = "2020-01-01T00:00:00.000Z";

function skillDoc(name: string, description = "Test skill."): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Skill"].join(
    "\n",
  );
}

async function makeTmpConfig(): Promise<{ root: string; config: AgentConfig; skillsDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-improvement-"));
  const skillsDir = path.join(root, "skills");
  const config = {
    ...makeConfig(root),
    userCoworkDir: path.join(root, ".cowork-user"),
    skillsDirs: [skillsDir],
    skillImprovementEnabled: true,
    skillImprovementScope: "user" as const,
    skillImprovementExcludedSkills: [],
  };
  return { root, config, skillsDir };
}

async function createSkill(skillsDir: string, name: string): Promise<string> {
  const skillRoot = path.join(skillsDir, name);
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), skillDoc(name), "utf-8");
  return skillRoot;
}

function completedUsage(skillName: string, turnId = "turn-1"): CompletedTurnSkillUsage {
  return {
    sessionId: "session-1",
    turnId,
    workingDirectory: "/workspace",
    messageStartIndex: 0,
    messageEndIndex: 2,
    transcript: "USER: improve this\nASSISTANT: done",
    usages: [
      {
        skillName,
        kind: "tool",
        source: "skill-tool",
        turnId,
        usedAt: PAST_USED_AT,
      },
    ],
  };
}

type ServiceOverrides = {
  hasBusySessions?: () => boolean;
  improverRun?: (opts: { input: SkillImproverRunInput }) => Promise<SkillImproverRunResult>;
  broadcastStatus?: (event: unknown) => void;
};

function makeService(
  config: AgentConfig,
  store: SkillImprovementJobStore,
  overrides: ServiceOverrides = {},
) {
  const signalSkillMutation = mock(async () => {});
  const run = mock(
    overrides.improverRun ??
      (async () => ({ ok: true, changed: false, message: "no changes" }) as SkillImproverRunResult),
  );
  const service = new SkillImprovementService({
    config,
    getConfig: () => config,
    store,
    improver: { run: run as never },
    hasBusySessions: overrides.hasBusySessions ?? (() => false),
    signalSkillMutation,
    ...(overrides.broadcastStatus ? { broadcastStatus: overrides.broadcastStatus } : {}),
  });
  return { service, run, signalSkillMutation };
}

describe("SkillImprovementService", () => {
  test("debounces completed-turn usage into a pending job with deduped transcripts", async () => {
    const { root, config } = await makeTmpConfig();
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const { service } = makeService(config, store);

    await service.recordCompletedTurnUsage({
      ...completedUsage("alpha"),
      usages: [
        completedUsage("alpha").usages[0]!,
        { ...completedUsage("alpha").usages[0]!, kind: "reference", source: "at-mention" },
      ],
    });
    await service.recordCompletedTurnUsage({
      ...completedUsage("alpha", "turn-2"),
      transcript: "second turn",
      usages: [
        {
          ...completedUsage("alpha").usages[0]!,
          turnId: "turn-2",
          usedAt: "2020-01-01T00:02:00.000Z",
        },
      ],
    });

    const state = await store.read();
    const job = state.pendingJobs.alpha;
    expect(job?.usageEvents).toHaveLength(3);
    // Two usages in turn-1 share one transcript record.
    expect(job?.transcripts).toHaveLength(2);
    expect(job?.transcripts.map((record) => record.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(job?.runAt).toBe("2020-01-01T00:12:00.000Z");
  });

  test("manual run while busy reschedules with a visible history entry", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const { service, run } = makeService(config, store, { hasBusySessions: () => true });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");

    const state = await store.read();
    expect(run).not.toHaveBeenCalled();
    expect(state.pendingJobs.alpha?.status).toBe("pending");
    expect(state.runHistory[0]?.status).toBe("skipped");
    expect(state.runHistory[0]?.message).toContain("paused");
    // Summaries expose the unique queue key so clients can key lists by it.
    const status = await service.getStatus("session-1");
    expect(status.pendingJobs[0]).toMatchObject({ key: "alpha", skillName: "alpha" });
  });

  test("scheduler run while busy reschedules silently (no history spam)", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const { service, run } = makeService(config, store, { hasBusySessions: () => true });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runDueJob();
    await service.runDueJob();

    const state = await store.read();
    expect(run).not.toHaveBeenCalled();
    expect(state.pendingJobs.alpha?.status).toBe("pending");
    expect(new Date(state.pendingJobs.alpha?.runAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(state.runHistory).toHaveLength(0);
  });

  test("backs up, improves, restores, and cleans artifacts", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    const skillRoot = await createSkill(skillsDir, "alpha");
    const skillPath = path.join(skillRoot, "SKILL.md");
    const original = await fs.readFile(skillPath, "utf-8");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const { service, signalSkillMutation } = makeService(config, store, {
      improverRun: async (opts) => {
        await fs.writeFile(opts.input.skillPath, `${original}\nAdded instruction.\n`, "utf-8");
        return { ok: true, changed: true, message: "updated skill" };
      },
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");

    expect(await fs.readFile(skillPath, "utf-8")).toContain("Added instruction.");
    expect(signalSkillMutation).toHaveBeenCalledTimes(1);
    let status = await service.getStatus("session-1");
    const backup = status.backups.find((entry) => entry.skillName === "alpha");
    expect(backup).toBeDefined();
    expect(status.runHistory[0]).toMatchObject({ skillName: "alpha", status: "completed" });
    // Sidecar metadata exists for state-loss recovery; pre-run snapshot is gone.
    expect(await fs.exists(store.backupMetaPath(backup!.key))).toBe(true);
    expect(await fs.exists(path.join(store.rootDir, "prerun", backup!.key))).toBe(false);

    await service.restore("alpha");

    expect(await fs.readFile(skillPath, "utf-8")).toBe(original);
    status = await service.getStatus("session-1");
    expect(status.backups.some((entry) => entry.skillName === "alpha")).toBe(false);
    expect(await fs.exists(store.backupMetaPath(backup!.key))).toBe(false);
    expect(await fs.exists(backup!.backupRootDir)).toBe(false);
    expect(signalSkillMutation).toHaveBeenCalledTimes(2);
  });

  test("failed run rolls back only that run's changes, preserving prior improvements and manual edits", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    const skillRoot = await createSkill(skillsDir, "alpha");
    const skillPath = path.join(skillRoot, "SKILL.md");
    const original = await fs.readFile(skillPath, "utf-8");
    const store = new SkillImprovementJobStore(path.join(root, "state"));

    let failNextRun = false;
    const { service } = makeService(config, store, {
      improverRun: async (opts) => {
        if (failNextRun) {
          await fs.writeFile(opts.input.skillPath, "broken beyond repair", "utf-8");
          return { ok: false, changed: true, message: "invalid frontmatter" };
        }
        const current = await fs.readFile(opts.input.skillPath, "utf-8");
        await fs.writeFile(opts.input.skillPath, `${current}\nRun-1 improvement.\n`, "utf-8");
        return { ok: true, changed: true, message: "run 1" };
      },
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");
    expect(await fs.readFile(skillPath, "utf-8")).toContain("Run-1 improvement.");

    // User edits the improved skill by hand between runs.
    await fs.appendFile(skillPath, "Manual edit.\n", "utf-8");

    failNextRun = true;
    await service.recordCompletedTurnUsage(completedUsage("alpha", "turn-2"));
    await service.runNow("alpha");

    const afterFailure = await fs.readFile(skillPath, "utf-8");
    expect(afterFailure).toContain("Run-1 improvement.");
    expect(afterFailure).toContain("Manual edit.");
    expect(afterFailure).not.toContain("broken beyond repair");
    const state = await store.read();
    expect(state.runHistory[0]?.status).toBe("failed");

    // Explicit restore still returns to the true original.
    await service.restore("alpha");
    expect(await fs.readFile(skillPath, "utf-8")).toBe(original);
  });

  test("an improver crash records a failed run, rolls back, and releases the lock", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    const skillRoot = await createSkill(skillsDir, "alpha");
    const skillPath = path.join(skillRoot, "SKILL.md");
    const original = await fs.readFile(skillPath, "utf-8");
    const store = new SkillImprovementJobStore(path.join(root, "state"));

    let crash = true;
    const { service, run } = makeService(config, store, {
      improverRun: async (opts) => {
        if (crash) {
          await fs.writeFile(opts.input.skillPath, "half-written", "utf-8");
          throw new Error("runtime exploded");
        }
        return { ok: true, changed: false, message: "no changes" };
      },
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");

    expect(await fs.readFile(skillPath, "utf-8")).toBe(original);
    let state = await store.read();
    expect(state.runHistory[0]?.status).toBe("failed");
    expect(state.runHistory[0]?.error).toContain("runtime exploded");
    expect(state.pendingJobs.alpha).toBeUndefined();

    // The lock must have been released: a follow-up run executes.
    crash = false;
    await service.recordCompletedTurnUsage(completedUsage("alpha", "turn-2"));
    await service.runNow("alpha");
    state = await store.read();
    expect(run).toHaveBeenCalledTimes(2);
    expect(state.runHistory[0]?.status).toBe("skipped");
  });

  test("runNow with no name drains every queued job", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    await createSkill(skillsDir, "beta");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const processed: string[] = [];
    const { service } = makeService(config, store, {
      improverRun: async (opts) => {
        processed.push(opts.input.skillName);
        return { ok: true, changed: false, message: "no changes" };
      },
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.recordCompletedTurnUsage(completedUsage("beta"));
    await service.runNow();

    const state = await store.read();
    expect(processed.sort()).toEqual(["alpha", "beta"]);
    expect(Object.keys(state.pendingJobs)).toHaveLength(0);
    expect(state.runHistory).toHaveLength(2);
  });

  test("runNow for a skill without usage evidence records a skip instead of fabricating a job", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const { service, run } = makeService(config, store);

    await service.runNow("alpha");

    const state = await store.read();
    expect(run).not.toHaveBeenCalled();
    expect(state.runHistory[0]).toMatchObject({ skillName: "alpha", status: "skipped" });
    expect(state.runHistory[0]?.message).toContain("No recorded usage evidence");
  });

  test("restore refuses to run while sessions are busy or without a backup", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));

    const busy = makeService(config, store, { hasBusySessions: () => true });
    await expect(busy.service.restore("alpha")).rejects.toThrow(/session is running/);

    const idle = makeService(config, store);
    await expect(idle.service.restore("alpha")).rejects.toThrow(/No skill improvement backup/);
  });

  test("a stale lock from a dead process is broken; a live foreign lock reschedules", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const { service, run } = makeService(config, store);
    const lockPath = path.join(store.rootDir, "skill-improvement.lock");
    await fs.mkdir(store.rootDir, { recursive: true });

    // Live foreign process (the test runner's parent) with a fresh lock: gate holds.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
      "utf-8",
    );
    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");
    let state = await store.read();
    expect(run).not.toHaveBeenCalled();
    expect(state.runHistory[0]?.message).toContain("another process holds the lock");

    // Dead pid: the lock is stale and must be broken so the feature self-heals.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }),
      "utf-8",
    );
    await service.runNow("alpha");
    state = await store.read();
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.pendingJobs.alpha).toBeUndefined();
    expect(await fs.exists(lockPath)).toBe(false);
  });

  test("improving a built-in skill shadows it once and restore removes the shadow", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-improvement-builtin-"));
    const projectSkills = path.join(root, "project-skills");
    const globalSkills = path.join(root, "global-skills");
    const builtInSkills = path.join(root, "builtin-skills");
    await fs.mkdir(projectSkills, { recursive: true });
    await fs.mkdir(globalSkills, { recursive: true });
    await createSkill(builtInSkills, "bundled");
    const config = {
      ...makeConfig(root),
      userCoworkDir: path.join(root, ".cowork-user"),
      skillsDirs: [projectSkills, globalSkills, builtInSkills],
      skillImprovementEnabled: true,
      skillImprovementScope: "all" as const,
      skillImprovementExcludedSkills: [],
    };
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const shadowSkillPath = path.join(globalSkills, "bundled", "SKILL.md");
    const { service } = makeService(config, store, {
      improverRun: async (opts) => {
        const current = await fs.readFile(opts.input.skillPath, "utf-8");
        await fs.writeFile(opts.input.skillPath, `${current}\nImproved.\n`, "utf-8");
        return { ok: true, changed: true, message: "improved" };
      },
    });

    await service.recordCompletedTurnUsage(completedUsage("bundled"));
    await service.runNow("bundled");

    // The bundled copy is untouched; the improvement lives in the global shadow.
    expect(
      await fs.readFile(path.join(builtInSkills, "bundled", "SKILL.md"), "utf-8"),
    ).not.toContain("Improved.");
    expect(await fs.readFile(shadowSkillPath, "utf-8")).toContain("Improved.");

    // Improving the (now effective) shadow again must reuse the delete-shadow
    // backup instead of stacking a copy-back of the improved content.
    await service.recordCompletedTurnUsage(completedUsage("bundled", "turn-2"));
    await service.runNow("bundled");
    const state = await store.read();
    const backups = Object.values(state.backups).filter((entry) => entry.skillName === "bundled");
    expect(backups).toHaveLength(1);
    expect(backups[0]?.restoreMode).toBe("delete-shadow");
    expect((await fs.readFile(shadowSkillPath, "utf-8")).match(/Improved\./g)).toHaveLength(2);

    await service.restore("bundled");
    expect(await fs.exists(path.join(globalSkills, "bundled"))).toBe(false);
    expect(await fs.readFile(path.join(builtInSkills, "bundled", "SKILL.md"), "utf-8")).toBe(
      skillDoc("bundled"),
    );
  });

  test("terminal outcomes broadcast a status event", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const broadcasts: unknown[] = [];
    const { service } = makeService(config, store, {
      broadcastStatus: (event) => broadcasts.push(event),
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");
    // Broadcast is fire-and-forget; give the microtask queue a beat.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    expect((broadcasts[0] as { type?: string }).type).toBe("skill_improvement_status");
  });
});
