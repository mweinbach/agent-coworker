import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillImprovementJobStore, SkillImprovementService } from "../src/skillImprovement";
import type { CompletedTurnSkillUsage, SkillImproverRunInput } from "../src/skillImprovement/types";
import type { AgentConfig } from "../src/types";
import { makeConfig } from "./session/agentSession.harness";

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

function completedUsage(skillName: string): CompletedTurnSkillUsage {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    workingDirectory: "/workspace",
    messageStartIndex: 0,
    messageEndIndex: 2,
    transcript: "USER: improve this\nASSISTANT: done",
    usages: [
      {
        skillName,
        kind: "tool",
        source: "skill-tool",
        turnId: "turn-1",
        usedAt: "2026-07-05T12:00:00.000Z",
      },
    ],
  };
}

describe("SkillImprovementService", () => {
  test("debounces usage events into a pending job", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-job-store-"));
    const store = new SkillImprovementJobStore(root);

    await store.enqueueUsageEvents([
      {
        ...completedUsage("alpha").usages[0]!,
        sessionId: "session-1",
        workingDirectory: "/workspace",
        messageStartIndex: 0,
        messageEndIndex: 2,
        transcript: "first",
      },
      {
        ...completedUsage("alpha").usages[0]!,
        turnId: "turn-2",
        usedAt: "2026-07-05T12:02:00.000Z",
        sessionId: "session-1",
        workingDirectory: "/workspace",
        messageStartIndex: 2,
        messageEndIndex: 4,
        transcript: "second",
      },
    ]);

    const state = await store.read();
    expect(state.pendingJobs.alpha?.usageEvents).toHaveLength(2);
    expect(state.pendingJobs.alpha?.runAt).toBe("2026-07-05T12:12:00.000Z");
  });

  test("reschedules a run while sessions are busy", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    await createSkill(skillsDir, "alpha");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const run = mock(async () => ({ ok: true, changed: false, message: "no changes" }));
    const service = new SkillImprovementService({
      config,
      getConfig: () => config,
      store,
      improver: { run },
      hasBusySessions: () => true,
      signalSkillMutation: async () => {},
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");

    const state = await store.read();
    expect(run).not.toHaveBeenCalled();
    expect(state.pendingJobs.alpha?.status).toBe("pending");
    expect(state.runHistory[0]?.status).toBe("skipped");
    expect(state.runHistory[0]?.message).toContain("paused");
  });

  test("backs up, improves, and restores a writable skill", async () => {
    const { root, config, skillsDir } = await makeTmpConfig();
    const skillRoot = await createSkill(skillsDir, "alpha");
    const skillPath = path.join(skillRoot, "SKILL.md");
    const original = await fs.readFile(skillPath, "utf-8");
    const store = new SkillImprovementJobStore(path.join(root, "state"));
    const signalSkillMutation = mock(async () => {});
    const run = mock(async (opts: { input: SkillImproverRunInput }) => {
      await fs.writeFile(opts.input.skillPath, `${original}\nAdded instruction.\n`, "utf-8");
      return { ok: true, changed: true, message: "updated skill" };
    });
    const service = new SkillImprovementService({
      config,
      getConfig: () => config,
      store,
      improver: { run },
      hasBusySessions: () => false,
      signalSkillMutation,
    });

    await service.recordCompletedTurnUsage(completedUsage("alpha"));
    await service.runNow("alpha");

    expect(await fs.readFile(skillPath, "utf-8")).toContain("Added instruction.");
    expect(signalSkillMutation).toHaveBeenCalledTimes(1);
    let status = await service.getStatus("session-1");
    expect(status.backups.some((backup) => backup.skillName === "alpha")).toBe(true);
    expect(status.runHistory[0]).toMatchObject({ skillName: "alpha", status: "completed" });

    await service.restore("alpha");

    expect(await fs.readFile(skillPath, "utf-8")).toBe(original);
    status = await service.getStatus("session-1");
    expect(status.backups.some((backup) => backup.skillName === "alpha")).toBe(false);
    expect(signalSkillMutation).toHaveBeenCalledTimes(2);
  });
});
