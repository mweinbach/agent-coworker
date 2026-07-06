import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillImprovementJobStore } from "../src/skillImprovement";
import {
  createPrerunSnapshot,
  discardPrerunSnapshot,
  restorePrerunSnapshot,
  restoreSkillImprovementBackup,
} from "../src/skillImprovement/backups";
import type { SkillImprovementBackupRecord } from "../src/skillImprovement/types";

async function makeRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-backups-"));
}

describe("skill improvement backups", () => {
  test("copy-back restore refuses to delete the live skill when the backup is missing", async () => {
    const root = await makeRoot();
    const skillDir = path.join(root, "skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "live content", "utf-8");
    const backup: SkillImprovementBackupRecord = {
      key: "gone",
      skillName: "alpha",
      sourceRootDir: skillDir,
      backupRootDir: path.join(root, "originals", "gone"),
      createdAt: new Date().toISOString(),
      restoreMode: "copy-back",
    };

    await expect(restoreSkillImprovementBackup({ backup })).rejects.toThrow(/missing/);
    // The live skill must be untouched.
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("live content");
  });

  test("pre-run snapshots round-trip the whole skill directory", async () => {
    const root = await makeRoot();
    const store = new SkillImprovementJobStore(path.join(root, "store"));
    const skillDir = path.join(root, "skill");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "before", "utf-8");
    await fs.writeFile(path.join(skillDir, "references", "notes.md"), "ref before", "utf-8");

    const snapshotDir = await createPrerunSnapshot({
      store,
      key: "alpha-1",
      targetRootDir: skillDir,
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "broken", "utf-8");
    await fs.rm(path.join(skillDir, "references"), { recursive: true, force: true });

    await restorePrerunSnapshot({ snapshotDir, targetRootDir: skillDir });
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("before");
    expect(await fs.readFile(path.join(skillDir, "references", "notes.md"), "utf-8")).toBe(
      "ref before",
    );

    await discardPrerunSnapshot(snapshotDir);
    expect(await fs.exists(snapshotDir)).toBe(false);
  });

  test("restoring from a missing pre-run snapshot fails without deleting the target", async () => {
    const root = await makeRoot();
    const skillDir = path.join(root, "skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "live", "utf-8");

    await expect(
      restorePrerunSnapshot({
        snapshotDir: path.join(root, "does-not-exist"),
        targetRootDir: skillDir,
      }),
    ).rejects.toThrow(/missing/);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("live");
  });
});
