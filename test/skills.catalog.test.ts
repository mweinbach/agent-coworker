import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanSkillCatalog } from "../src/skills/catalog";

async function makeTmpDir(prefix = "skills-catalog-test-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillDoc(name: string, description: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Body"].join("\n");
}

async function createSkill(parentDir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillDoc(name, description), "utf-8");
}

describe("scanSkillCatalog", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpDir();
  });

  test("keeps effective, shadowed, and disabled installations without deduping", async () => {
    const project = path.join(root, ".agent", "skills");
    const global = path.join(root, ".cowork", "skills");
    const globalDisabled = path.join(root, ".cowork", "disabled-skills");
    const user = path.join(root, ".agent-user", "skills");
    const builtIn = path.join(root, "builtin", "skills");

    await createSkill(project, "alpha", "Project alpha.");
    await createSkill(global, "alpha", "Global alpha.");
    await createSkill(globalDisabled, "beta", "Disabled beta.");
    await createSkill(user, "gamma", "User gamma.");
    await createSkill(builtIn, "delta", "Built-in delta.");

    const catalog = await scanSkillCatalog([project, global, user, builtIn], { includeDisabled: true });

    expect(catalog.effectiveSkills.map((skill) => skill.name)).toEqual(["alpha", "gamma", "delta"]);

    const projectAlpha = catalog.installations.find((entry) => entry.scope === "project" && entry.name === "alpha");
    const globalAlpha = catalog.installations.find((entry) => entry.scope === "global" && entry.name === "alpha");
    const disabledBeta = catalog.installations.find((entry) => entry.scope === "global" && entry.name === "beta");

    expect(projectAlpha?.state).toBe("effective");
    expect(projectAlpha?.effective).toBe(true);
    expect(globalAlpha?.state).toBe("shadowed");
    expect(globalAlpha?.shadowedByInstallationId).toBe(projectAlpha?.installationId);
    expect(disabledBeta?.state).toBe("disabled");
    expect(disabledBeta?.enabled).toBe(false);
  });

  test("can lazily adopt unmanaged writable installs with manifests", async () => {
    const project = path.join(root, ".agent", "skills");
    const global = path.join(root, ".cowork", "skills");

    await createSkill(project, "alpha", "Project alpha.");
    await createSkill(global, "beta", "Global beta.");

    const catalog = await scanSkillCatalog([project, global], {
      includeDisabled: true,
      adoptManagedWritableInstalls: true,
    });

    const alpha = catalog.installations.find((entry) => entry.name === "alpha");
    const beta = catalog.installations.find((entry) => entry.name === "beta");

    expect(alpha?.managed).toBe(true);
    expect(beta?.managed).toBe(true);
    await fs.access(path.join(project, "alpha", ".cowork-skill.json"));
    await fs.access(path.join(global, "beta", ".cowork-skill.json"));
  });
});
