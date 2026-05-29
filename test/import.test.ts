import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  importPlugin,
  importSkill,
  listImportable,
  resolveExternalHome,
  stageClaudePluginForInstall,
} from "../src/import";
import { listImportablePlugins, listImportableSkills } from "../src/import/discovery";
import { readPluginManifest } from "../src/plugins/manifest";
import { getSkillCatalog } from "../src/skills/operations";
import type { AgentConfig } from "../src/types";

async function mkTmp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeConfig(workspaceRoot: string, userHome: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: workspaceRoot,
    outputDirectory: path.join(workspaceRoot, "output"),
    uploadsDirectory: path.join(workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(workspaceRoot, ".cowork"),
    userCoworkDir: path.join(userHome, ".cowork"),
    workspaceAgentsDir: path.join(workspaceRoot, ".agents"),
    userAgentsDir: path.join(userHome, ".agents"),
    workspacePluginsDir: path.join(workspaceRoot, ".cowork", "plugins"),
    userPluginsDir: path.join(userHome, ".cowork", "plugins"),
    builtInDir: path.join(userHome, "builtin"),
    builtInConfigDir: path.join(userHome, "builtin", "config"),
    skillsDirs: [
      path.join(workspaceRoot, ".cowork", "skills"),
      path.join(userHome, ".cowork", "skills"),
      path.join(userHome, "builtin", "skills"),
    ],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  } as AgentConfig;
}

async function writePluginBundle(opts: {
  root: string;
  manifestDir: ".codex-plugin" | ".cowork-plugin" | ".claude-plugin";
  manifest: Record<string, unknown>;
  withSkill?: { name: string; description: string };
}): Promise<void> {
  await fs.mkdir(path.join(opts.root, opts.manifestDir), { recursive: true });
  await fs.writeFile(
    path.join(opts.root, opts.manifestDir, "plugin.json"),
    JSON.stringify(opts.manifest, null, 2),
    "utf-8",
  );
  if (opts.withSkill) {
    const skillDir = path.join(opts.root, "skills", opts.withSkill.name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${opts.withSkill.name}\ndescription: ${opts.withSkill.description}\n---\n\nBody\n`,
      "utf-8",
    );
  }
}

async function writeSkillDir(
  skillsDir: string,
  name: string,
  frontmatter: string,
): Promise<string> {
  const dir = path.join(skillsDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody\n`, "utf-8");
  return dir;
}

describe("import/externalHomes", () => {
  test("resolves scan roots per source and tolerates missing home", async () => {
    const home = await mkTmp("import-home-");
    const claude = await resolveExternalHome("claude", { homeOverride: home });
    expect(claude.exists).toBe(true);
    expect(claude.pluginScanRoots).toEqual([
      path.join(home, "plugins", "cache"),
      path.join(home, "plugins", "marketplaces"),
    ]);
    expect(claude.skillsDir).toBe(path.join(home, "skills"));

    const codex = await resolveExternalHome("codex", { homeOverride: home });
    expect(codex.pluginScanRoots).toEqual([path.join(home, "plugins", "cache")]);

    const missing = await resolveExternalHome("codex", {
      homeOverride: path.join(home, "does-not-exist"),
    });
    expect(missing.exists).toBe(false);
  });
});

describe("import/discovery plugins", () => {
  test("discovers codex (native) and claude (conversion) bundles, skips manifest-less dirs", async () => {
    const codexHome = await mkTmp("import-codex-");
    const claudeHome = await mkTmp("import-claude-");
    const workspace = await mkTmp("import-ws-");
    const userHome = await mkTmp("import-user-");
    const config = makeConfig(workspace, userHome);

    const alphaRoot = path.join(codexHome, "plugins", "cache", "openai-curated", "alpha", "1.0.0");
    await writePluginBundle({
      root: alphaRoot,
      manifestDir: ".codex-plugin",
      manifest: {
        name: "alpha",
        version: "1.0.0",
        description: "Alpha plugin",
        skills: "./skills/",
      },
      withSkill: { name: "alpha-skill", description: "Alpha skill" },
    });
    const zetaRoot = path.join(codexHome, "plugins", "cache", "openai-curated", "zeta", "1.0.0");
    await writePluginBundle({
      root: zetaRoot,
      manifestDir: ".codex-plugin",
      manifest: {
        name: "zeta",
        version: "1.0.0",
        description: "Zeta plugin",
        skills: "./skills/",
      },
      withSkill: { name: "zeta-skill", description: "Zeta skill" },
    });
    // Install/backup scratch dirs can contain stale manifests and sort before
    // the canonical cache entry for the same plugin id.
    await writePluginBundle({
      root: path.join(
        codexHome,
        "plugins",
        "cache",
        "openai-curated",
        "plugin-backup-aaaa",
        "zeta",
        "0.1.0",
      ),
      manifestDir: ".codex-plugin",
      manifest: {
        name: "zeta",
        version: "0.1.0",
        description: "Stale zeta backup",
        skills: "./skills/",
      },
      withSkill: { name: "zeta-skill", description: "Stale zeta skill" },
    });
    await writePluginBundle({
      root: path.join(claudeHome, "plugins", "cache", "mkt", "beta", "2.0.0"),
      manifestDir: ".claude-plugin",
      manifest: {
        name: "beta",
        version: "2.0.0",
        description: "Beta plugin",
        commands: ["x"],
        $schema: "https://example/schema.json",
      },
    });
    // Cache entry with no manifest at all — must be excluded.
    await fs.mkdir(path.join(claudeHome, "plugins", "cache", "mkt", "lsp-only", "1.0.0"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(claudeHome, "plugins", "cache", "mkt", "lsp-only", "1.0.0", "README.md"),
      "no manifest here",
      "utf-8",
    );

    const codexHomeResolved = await resolveExternalHome("codex", { homeOverride: codexHome });
    const claudeHomeResolved = await resolveExternalHome("claude", { homeOverride: claudeHome });
    const items = await listImportablePlugins({
      config,
      homes: [codexHomeResolved, claudeHomeResolved],
    });

    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.has("alpha")).toBe(true);
    expect(byId.get("alpha")?.conversionRequired).toBeFalsy();
    expect(byId.get("alpha")?.source).toBe("codex");
    expect(byId.get("zeta")?.version).toBe("1.0.0");
    expect(byId.get("zeta")?.sourcePath).toBe(zetaRoot);
    expect(byId.has("beta")).toBe(true);
    expect(byId.get("beta")?.conversionRequired).toBe(true);
    expect(byId.get("beta")?.diagnostics).toHaveLength(0);
    // lsp-only never produced a row.
    expect(items.some((i) => i.id === "lsp-only")).toBe(false);
  });
});

describe("import/discovery skills", () => {
  test("valid, empty-dir skip, name mismatch diagnostic", async () => {
    const claudeHome = await mkTmp("import-cskill-");
    const workspace = await mkTmp("import-ws-");
    const userHome = await mkTmp("import-user-");
    const config = makeConfig(workspace, userHome);
    const skillsDir = path.join(claudeHome, "skills");

    await writeSkillDir(skillsDir, "good-skill", "name: good-skill\ndescription: A good skill");
    // empty dir → no SKILL.md → skipped
    await fs.mkdir(path.join(skillsDir, "empty-skill"), { recursive: true });
    // name mismatch → diagnostic
    await writeSkillDir(skillsDir, "mismatch-dir", "name: other-name\ndescription: Mismatched");

    const home = await resolveExternalHome("claude", { homeOverride: claudeHome });
    const items = await listImportableSkills({ config, homes: [home] });
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get("good-skill")?.diagnostics).toHaveLength(0);
    expect(items.some((i) => i.id === "empty-skill")).toBe(false);
    expect(byId.get("mismatch-dir")?.diagnostics?.[0]?.code).toBe("name_mismatch");
  });
});

describe("import/conversion", () => {
  test("strips Claude-only keys and parses via cowork manifest schema", async () => {
    const claudeHome = await mkTmp("import-conv-");
    const root = path.join(claudeHome, "beta");
    await writePluginBundle({
      root,
      manifestDir: ".claude-plugin",
      manifest: {
        name: "beta",
        version: "2.0.0",
        description: "Beta plugin",
        commands: ["x"],
        agents: ["y"],
        hooks: { pre: "z" },
        $schema: "https://example/schema.json",
        mcpServers: { inline: { command: "node" } },
      },
      withSkill: { name: "beta-skill", description: "Beta skill" },
    });

    const staged = await stageClaudePluginForInstall(root);
    try {
      const manifestRaw = await fs.readFile(
        path.join(staged.stagedRoot, ".cowork-plugin", "plugin.json"),
        "utf-8",
      );
      const parsed = JSON.parse(manifestRaw);
      expect(parsed.commands).toBeUndefined();
      expect(parsed.agents).toBeUndefined();
      expect(parsed.hooks).toBeUndefined();
      expect(parsed.$schema).toBeUndefined();
      expect(parsed.mcpServers).toBeUndefined();
      // Cowork's strict schema accepts the staged bundle.
      const manifest = await readPluginManifest(staged.stagedRoot);
      expect(manifest.name).toBe("beta");
    } finally {
      await staged.cleanup();
    }
  });

  test("preserves a string mcpServers path", async () => {
    const claudeHome = await mkTmp("import-conv2-");
    const root = path.join(claudeHome, "gamma");
    await writePluginBundle({
      root,
      manifestDir: ".claude-plugin",
      manifest: { name: "gamma", description: "Gamma", mcpServers: "./.mcp.json" },
    });
    const staged = await stageClaudePluginForInstall(root);
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(staged.stagedRoot, ".cowork-plugin", "plugin.json"), "utf-8"),
      );
      expect(parsed.mcpServers).toBe("./.mcp.json");
    } finally {
      await staged.cleanup();
    }
  });
});

describe("import/operations end-to-end", () => {
  test("imports a skill into the global scope (idempotent)", async () => {
    const claudeHome = await mkTmp("import-op-skill-");
    const workspace = await mkTmp("import-ws-");
    const userHome = await mkTmp("import-user-");
    const config = makeConfig(workspace, userHome);
    const sourceDir = await writeSkillDir(
      path.join(claudeHome, "skills"),
      "my-skill",
      "name: my-skill\ndescription: My skill",
    );

    const first = await importSkill({ config, sourcePath: sourceDir, targetScope: "user" });
    expect(first.installationIds.length).toBeGreaterThan(0);
    const destPath = path.join(userHome, ".cowork", "skills", "my-skill", "SKILL.md");
    expect(await fs.exists(destPath)).toBe(true);
    const manifestExists = await fs.exists(
      path.join(userHome, ".cowork", "skills", "my-skill", ".cowork-skill.json"),
    );
    expect(manifestExists).toBe(true);

    const catalog = await getSkillCatalog(config);
    expect(catalog.installations.some((i) => i.name === "my-skill" && i.scope === "global")).toBe(
      true,
    );

    // Re-import overwrites cleanly.
    const second = await importSkill({ config, sourcePath: sourceDir, targetScope: "user" });
    expect(second.installationIds.length).toBeGreaterThan(0);
  });

  test("imports a codex plugin into the user scope", async () => {
    const codexHome = await mkTmp("import-op-plugin-");
    const workspace = await mkTmp("import-ws-");
    const userHome = await mkTmp("import-user-");
    const config = makeConfig(workspace, userHome);
    const root = path.join(codexHome, "plugins", "cache", "mkt", "delta", "1.0.0");
    await writePluginBundle({
      root,
      manifestDir: ".codex-plugin",
      manifest: { name: "delta", version: "1.0.0", description: "Delta", skills: "./skills/" },
      withSkill: { name: "delta-skill", description: "Delta skill" },
    });

    const result = await importPlugin({
      config,
      sourcePath: root,
      conversionRequired: false,
      targetScope: "user",
    });
    expect(result.pluginId).toBe("delta");
    expect(result.catalog.plugins.some((p) => p.id === "delta" && p.scope === "user")).toBe(true);
  });

  test("listImportable returns homeExists=false for a missing home", async () => {
    const workspace = await mkTmp("import-ws-");
    const userHome = await mkTmp("import-user-");
    const config = makeConfig(workspace, userHome);
    const result = await listImportable({
      config,
      source: "codex",
      kind: "plugin",
      homeOverride: path.join(userHome, "nope"),
    });
    expect(result.homeExists).toBe(false);
    expect(result.items).toEqual([]);
  });
});
