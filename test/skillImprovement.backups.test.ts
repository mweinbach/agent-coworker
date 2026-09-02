import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillImprovementJobStore } from "../src/skillImprovement";
import {
  createPrerunSnapshot,
  discardPrerunSnapshot,
  prepareSkillImprovementTarget,
  restorePrerunSnapshot,
  restoreSkillImprovementBackup,
} from "../src/skillImprovement/backups";
import type { SkillImprovementBackupRecord } from "../src/skillImprovement/types";
import { scanSkillCatalog } from "../src/skills/catalog";
import { makeConfig } from "./session/agentSession.harness";

async function makeRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-backups-"));
}

describe("skill improvement backups", () => {
  test("preparation refuses a read-only standalone target before creating a backup", async () => {
    const root = await makeRoot();
    try {
      const config = makeConfig(root);
      const skillsDir = path.join(root, "skills");
      const skillRoot = path.join(skillsDir, "alpha");
      await fs.mkdir(skillRoot, { recursive: true });
      await fs.writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: alpha\ndescription: Read-only skill\n---\nOriginal",
      );
      const catalog = await scanSkillCatalog([skillsDir]);
      const installation = { ...catalog.installations[0]!, writable: false };
      const store = new SkillImprovementJobStore(path.join(root, "state"));

      await expect(prepareSkillImprovementTarget({ config, store, installation })).rejects.toThrow(
        "read-only",
      );
      expect((await store.read()).backups).toEqual({});
      expect(await fs.exists(path.join(store.rootDir, "originals"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.each(["copy-back", "pre-run"] as const)(
    "%s restore preserves live files when copying the replacement fails",
    async (kind) => {
      const root = await makeRoot();
      const skillDir = path.join(root, "skill");
      const backupDir = path.join(root, "backup");
      const originalCp = fs.cp.bind(fs);
      let copySpy: ReturnType<typeof spyOn<typeof fs, "cp">> | undefined;
      try {
        await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "live content");
        await fs.writeFile(path.join(skillDir, "references", "notes.md"), "live reference");
        await fs.mkdir(backupDir, { recursive: true });
        await fs.writeFile(path.join(backupDir, "SKILL.md"), "restored content");
        copySpy = spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
          if (String(source) !== backupDir) return await originalCp(source, destination, options);
          await fs.mkdir(String(destination), { recursive: true });
          await fs.writeFile(path.join(String(destination), "SKILL.md"), "incomplete copy");
          throw new Error("simulated restore copy failure");
        });

        const restore =
          kind === "pre-run"
            ? restorePrerunSnapshot({ snapshotDir: backupDir, targetRootDir: skillDir })
            : restoreSkillImprovementBackup({
                backup: {
                  key: "alpha",
                  skillName: "alpha",
                  sourceRootDir: skillDir,
                  backupRootDir: backupDir,
                  createdAt: "2020-01-01T00:00:00.000Z",
                  restoreMode: "copy-back",
                },
              });
        await expect(restore).rejects.toThrow("simulated restore copy failure");
        expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("live content");
        expect(await fs.readFile(path.join(skillDir, "references", "notes.md"), "utf-8")).toBe(
          "live reference",
        );
        expect(await fs.readdir(root)).toEqual(expect.arrayContaining(["skill", "backup"]));
        expect((await fs.readdir(root)).filter((entry) => entry.includes(".incoming-"))).toEqual(
          [],
        );
      } finally {
        copySpy?.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

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
