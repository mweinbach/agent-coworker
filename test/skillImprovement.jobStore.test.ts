import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillImprovementJobStore } from "../src/skillImprovement";
import {
  type CompletedTurnSkillUsage,
  SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB,
  SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB,
  type SkillImprovementBackupRecord,
} from "../src/skillImprovement/types";

async function makeStore(): Promise<SkillImprovementJobStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-jobstore-"));
  return new SkillImprovementJobStore(root);
}

function completedTurn(
  skillName: string,
  turnId: string,
  usedAt = "2020-01-01T00:00:00.000Z",
): CompletedTurnSkillUsage {
  return {
    sessionId: "session-1",
    turnId,
    workingDirectory: "/workspace",
    messageStartIndex: 0,
    messageEndIndex: 2,
    transcript: `transcript for ${turnId}`,
    usages: [{ skillName, kind: "tool", source: "skill-tool", turnId, usedAt }],
  };
}

function backupRecord(key: string): SkillImprovementBackupRecord {
  return {
    key,
    skillName: "alpha",
    sourceRootDir: `/skills/${key}`,
    backupRootDir: `/originals/${key}`,
    createdAt: "2020-01-01T00:00:00.000Z",
    restoreMode: "copy-back",
  };
}

describe("SkillImprovementJobStore", () => {
  test("caps stored transcripts and usage events per job", { timeout: 15_000 }, async () => {
    const store = await makeStore();
    for (let index = 0; index < SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB + 5; index += 1) {
      await store.enqueueCompletedTurn(completedTurn("alpha", `turn-${index}`));
    }
    const manyUsages = completedTurn("alpha", "turn-flood");
    manyUsages.usages = Array.from({ length: SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB + 10 }, () => ({
      ...manyUsages.usages[0]!,
    }));
    await store.enqueueCompletedTurn(manyUsages);

    const state = await store.read();
    const job = state.pendingJobs.alpha;
    expect(job?.transcripts.length).toBeLessThanOrEqual(SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB);
    expect(job?.usageEvents.length).toBeLessThanOrEqual(SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB);
    // Newest transcript survives trimming.
    expect(job?.transcripts.at(-1)?.turnId).toBe("turn-flood");
  });

  test("a corrupt state file is preserved and backups rebuild from sidecar metadata", async () => {
    const store = await makeStore();
    await store.registerBackup(backupRecord("alpha-123"));
    // Simulate corruption after the backup was registered.
    await fs.writeFile(store.statePath, "{ not json", "utf-8");

    const state = await store.read();
    expect(state.backups["alpha-123"]).toMatchObject({ key: "alpha-123", skillName: "alpha" });
    expect(await fs.exists(`${store.statePath}.corrupt`)).toBe(true);
  });

  test("claimDueJob recovers crashed running jobs but skips fresh ones", async () => {
    const store = await makeStore();
    await store.enqueueCompletedTurn(completedTurn("alpha", "turn-1"));
    // Mark as running with an ancient startedAt (a crashed claimer).
    const claimed = await store.claimDueJob();
    expect(claimed?.job.skillName).toBe("alpha");
    // Fresh running job is not claimable again.
    expect(await store.claimDueJob()).toBeNull();
    expect(await store.claimJob("alpha")).toBeNull();

    // Age the running claim beyond the stale threshold and it recovers.
    const state = await store.read();
    state.pendingJobs.alpha!.startedAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(store.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    const reclaimed = await store.claimDueJob();
    expect(reclaimed?.job.skillName).toBe("alpha");
  });

  test("project-scope skills queue per workspace and claim by cwd", async () => {
    const store = await makeStore();
    const turnA = completedTurn("shared-name", "turn-a");
    turnA.workingDirectory = "/workspace-a";
    turnA.usages[0]!.skillSource = "project";
    const turnB = completedTurn("shared-name", "turn-b");
    turnB.workingDirectory = "/workspace-b";
    turnB.usages[0]!.skillSource = "project";
    await store.enqueueCompletedTurn(turnA);
    await store.enqueueCompletedTurn(turnB);

    const state = await store.read();
    expect(Object.keys(state.pendingJobs)).toHaveLength(2);

    const claimed = await store.claimJob("shared-name", { cwd: "/workspace-b" });
    expect(claimed?.job.workingDirectory).toBe("/workspace-b");
    // The other workspace's job stays pending and untouched.
    const after = await store.read();
    const pendingLeft = Object.values(after.pendingJobs).filter(
      (job) => (job.status ?? "pending") === "pending",
    );
    expect(pendingLeft).toHaveLength(1);
    expect(pendingLeft[0]?.workingDirectory).toBe("/workspace-a");
  });

  test("usage recorded during a run survives finishJob as a fresh pending job", async () => {
    const store = await makeStore();
    await store.enqueueCompletedTurn(completedTurn("alpha", "turn-1"));
    const claimed = await store.claimDueJob();
    expect(claimed).not.toBeNull();

    // A second turn completes while the improvement run is in flight.
    await store.enqueueCompletedTurn(completedTurn("alpha", "turn-2", "2020-01-01T00:05:00.000Z"));

    await store.finishJob({
      key: claimed!.key,
      skillName: "alpha",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: "done",
      processedUsageCount: claimed!.job.usageEvents.length,
      processedTranscriptCount: claimed!.job.transcripts.length,
    });

    const state = await store.read();
    const survivor = state.pendingJobs.alpha;
    expect(survivor).toBeDefined();
    expect(survivor?.status).toBe("pending");
    expect(survivor?.usageEvents).toHaveLength(1);
    expect(survivor?.usageEvents[0]?.turnId).toBe("turn-2");
    expect(survivor?.transcripts.map((record) => record.turnId)).toEqual(["turn-2"]);
    expect(survivor?.runAt).toBe("2020-01-01T00:15:00.000Z");
  });

  test("rescheduleJob writes history only when asked", async () => {
    const store = await makeStore();
    await store.enqueueCompletedTurn(completedTurn("alpha", "turn-1"));
    await store.claimJob("alpha");

    await store.rescheduleJob("alpha", new Date(Date.now() + 60_000));
    let state = await store.read();
    expect(state.runHistory).toHaveLength(0);
    expect(state.pendingJobs.alpha?.status).toBe("pending");

    await store.claimJob("alpha");
    await store.rescheduleJob("alpha", new Date(Date.now() + 60_000), {
      historyMessage: "paused for test",
    });
    state = await store.read();
    expect(state.runHistory[0]?.message).toBe("paused for test");
  });

  test("removeBackup deletes the sidecar metadata", async () => {
    const store = await makeStore();
    await store.registerBackup(backupRecord("alpha-456"));
    expect(await fs.exists(store.backupMetaPath("alpha-456"))).toBe(true);
    await store.removeBackup("alpha-456");
    expect(await fs.exists(store.backupMetaPath("alpha-456"))).toBe(false);
    const state = await store.read();
    expect(state.backups["alpha-456"]).toBeUndefined();
  });

  test("concurrent updates from two store instances on the same directory do not lose writes", async () => {
    const store = await makeStore();
    // A second instance simulates another server process sharing ~/.cowork.
    const other = new SkillImprovementJobStore(store.rootDir);
    await Promise.all([
      store.enqueueCompletedTurn(completedTurn("alpha", "turn-a")),
      other.enqueueCompletedTurn(completedTurn("beta", "turn-b")),
    ]);
    const state = await store.read();
    expect(Object.keys(state.pendingJobs).sort()).toEqual(["alpha", "beta"]);
  });
});
