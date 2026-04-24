import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getInstallationById,
  scanSkillCatalog,
  scanSkillCatalogFromSources,
} from "../src/skills/catalog";
import type { PluginCatalogEntry } from "../src/types";

async function makeTmpDir(prefix = "skills-catalog-test-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillDoc(name: string, description: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Body"].join(
    "\n",
  );
}

async function createSkill(parentDir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillDoc(name, description), "utf-8");
}

function pluginEntry(opts: {
  scope: "workspace" | "user";
  rootDir: string;
  displayName: string;
  skillName: string;
  description: string;
}): PluginCatalogEntry {
  return {
    id: "figma-toolkit",
    name: "figma-toolkit",
    displayName: opts.displayName,
    description: "Figma helpers",
    scope: opts.scope,
    discoveryKind: "direct",
    enabled: true,
    rootDir: opts.rootDir,
    manifestPath: path.join(opts.rootDir, ".codex-plugin", "plugin.json"),
    skillsPath: path.join(opts.rootDir, "skills"),
    skills: [
      {
        name: `figma-toolkit:${opts.skillName}`,
        rawName: opts.skillName,
        description: opts.description,
        enabled: true,
        rootDir: path.join(opts.rootDir, "skills", opts.skillName),
        skillPath: path.join(opts.rootDir, "skills", opts.skillName, "SKILL.md"),
        triggers: [opts.skillName],
      },
    ],
    mcpServers: [],
    apps: [],
    warnings: [],
  };
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

    const catalog = await scanSkillCatalog([project, global, user, builtIn], {
      includeDisabled: true,
    });

    expect(catalog.effectiveSkills.map((skill) => skill.name)).toEqual(["alpha", "gamma", "delta"]);

    const projectAlpha = catalog.installations.find(
      (entry) => entry.scope === "project" && entry.name === "alpha",
    );
    const globalAlpha = catalog.installations.find(
      (entry) => entry.scope === "global" && entry.name === "alpha",
    );
    const disabledBeta = catalog.installations.find(
      (entry) => entry.scope === "global" && entry.name === "beta",
    );

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

  test("ignores escaped icon paths while still embedding in-tree icons", async () => {
    const project = path.join(root, ".agent", "skills");
    const skillDir = path.join(project, "alpha");
    await fs.mkdir(path.join(skillDir, "agents"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("alpha", "Project alpha."),
      "utf-8",
    );
    await fs.writeFile(path.join(skillDir, "assets", "icon.png"), "icon-small", "utf-8");
    await fs.writeFile(path.join(project, "escape.png"), "escaped", "utf-8");
    await fs.writeFile(
      path.join(skillDir, "agents", "openai.yaml"),
      [
        "interface:",
        '  display_name: "Alpha"',
        '  icon_small: "./assets/icon.png"',
        '  icon_large: "../escape.png"',
      ].join("\n"),
      "utf-8",
    );

    const catalog = await scanSkillCatalog([project], { includeDisabled: true });
    const alpha = catalog.installations.find((entry) => entry.name === "alpha");

    expect(alpha?.interface?.displayName).toBe("Alpha");
    expect(alpha?.interface?.iconSmall).toBe(
      `data:image/png;base64,${Buffer.from("icon-small").toString("base64")}`,
    );
    expect(alpha?.interface?.iconLarge).toBeUndefined();
  });

  test("ignores symlinked icon paths that resolve outside the skill root", async () => {
    if (process.platform === "win32") return;

    const project = path.join(root, ".agent", "skills");
    const skillDir = path.join(project, "alpha");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(path.join(skillDir, "agents"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("alpha", "Project alpha."),
      "utf-8",
    );
    await fs.writeFile(path.join(skillDir, "assets", "icon.png"), "icon-small", "utf-8");
    await fs.writeFile(path.join(outsideDir, "escape.png"), "escaped", "utf-8");
    await fs.symlink(
      path.join(outsideDir, "escape.png"),
      path.join(skillDir, "assets", "external.png"),
    );
    await fs.writeFile(
      path.join(skillDir, "agents", "openai.yaml"),
      [
        "interface:",
        '  display_name: "Alpha"',
        '  icon_small: "./assets/icon.png"',
        '  icon_large: "./assets/external.png"',
      ].join("\n"),
      "utf-8",
    );

    const catalog = await scanSkillCatalog([project], { includeDisabled: true });
    const alpha = catalog.installations.find((entry) => entry.name === "alpha");

    expect(alpha?.interface?.displayName).toBe("Alpha");
    expect(alpha?.interface?.iconSmall).toBe(
      `data:image/png;base64,${Buffer.from("icon-small").toString("base64")}`,
    );
    expect(alpha?.interface?.iconLarge).toBeUndefined();
  });

  test("assigns distinct installation ids to plugin skills across scopes", async () => {
    const workspacePluginRoot = path.join(root, "workspace-plugin");
    const userPluginRoot = path.join(root, "user-plugin");
    await createSkill(
      path.join(workspacePluginRoot, "skills"),
      "import-frame",
      "Workspace import.",
    );
    await createSkill(path.join(userPluginRoot, "skills"), "import-frame", "User import.");

    const workspacePlugin = pluginEntry({
      scope: "workspace",
      rootDir: workspacePluginRoot,
      displayName: "Workspace Figma Toolkit",
      skillName: "import-frame",
      description: "Workspace import.",
    });
    const userPlugin = pluginEntry({
      scope: "user",
      rootDir: userPluginRoot,
      displayName: "User Figma Toolkit",
      skillName: "import-frame",
      description: "User import.",
    });

    const catalog = await scanSkillCatalogFromSources(
      [
        {
          kind: "plugin",
          plugin: workspacePlugin,
          skill: workspacePlugin.skills[0]!,
          enabled: true,
        },
        {
          kind: "plugin",
          plugin: userPlugin,
          skill: userPlugin.skills[0]!,
          enabled: true,
        },
      ],
      { includeDisabled: true },
    );

    const workspaceInstallation = catalog.installations.find(
      (entry) => entry.plugin?.scope === "workspace",
    );
    const userInstallation = catalog.installations.find((entry) => entry.plugin?.scope === "user");

    expect(workspaceInstallation).toBeDefined();
    expect(userInstallation).toBeDefined();
    expect(workspaceInstallation?.installationId).not.toBe(userInstallation?.installationId);
    expect(workspaceInstallation?.state).toBe("effective");
    expect(userInstallation?.state).toBe("shadowed");
    expect(userInstallation?.shadowedByInstallationId).toBe(workspaceInstallation?.installationId);
    expect(getInstallationById(catalog, workspaceInstallation!.installationId)?.plugin?.scope).toBe(
      "workspace",
    );
    expect(getInstallationById(catalog, userInstallation!.installationId)?.plugin?.scope).toBe(
      "user",
    );
  });
});
