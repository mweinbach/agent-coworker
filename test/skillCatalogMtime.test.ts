import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config";
import { readSkillCatalogMtimeSnapshot } from "../src/server/skillCatalogMtime";

async function makeConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-mtime-"));
  const cwd = path.join(root, "workspace");
  const homedir = path.join(root, "home");
  await fs.mkdir(path.join(cwd, ".cowork"), { recursive: true });
  await fs.mkdir(homedir, { recursive: true });
  return await loadConfig({ cwd, homedir, env: {} });
}

describe("readSkillCatalogMtimeSnapshot", () => {
  test("changes when a workspace skill is added", async () => {
    const config = await makeConfig();
    const before = await readSkillCatalogMtimeSnapshot(config);

    const skillDir = path.join(config.projectCoworkDir, "skills", "example-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: example-skill", "description: Example skill", "---", ""].join("\n"),
    );

    const after = await readSkillCatalogMtimeSnapshot(config);
    expect(after).not.toBe(before);
  });

  test("changes when a plugin skill is added under a manifest-declared skills path", async () => {
    const config = await makeConfig();
    const workspacePluginsDir = config.workspacePluginsDir;
    if (!workspacePluginsDir) {
      throw new Error("Expected test config to include a workspace plugins directory");
    }
    const pluginRoot = path.join(workspacePluginsDir, "multi-skill-plugin");
    await fs.mkdir(path.join(pluginRoot, ".cowork-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "custom-skills"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".cowork-plugin", "plugin.json"),
      JSON.stringify({
        name: "multi-skill-plugin",
        description: "Plugin with custom skills",
        skills: ["./custom-skills"],
      }),
    );

    const before = await readSkillCatalogMtimeSnapshot(config);

    const skillDir = path.join(pluginRoot, "custom-skills", "example-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: example-skill", "description: Example skill", "---", ""].join("\n"),
    );

    const after = await readSkillCatalogMtimeSnapshot(config);
    expect(after).not.toBe(before);
  });
});
