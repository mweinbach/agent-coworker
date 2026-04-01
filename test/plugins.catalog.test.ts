import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installPluginsFromSource } from "../src/plugins/operations";
import { resolvePluginCatalogEntry } from "../src/plugins/catalog";
import type { AgentConfig, PluginCatalogEntry, PluginCatalogSnapshot } from "../src/types";

function makeConfig(workspaceRoot: string, userHome: string, builtInConfigDir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: workspaceRoot,
    outputDirectory: path.join(workspaceRoot, "output"),
    uploadsDirectory: path.join(workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(workspaceRoot, ".agent"),
    userAgentDir: path.join(userHome, ".agent"),
    workspaceAgentsDir: path.join(workspaceRoot, ".agents"),
    userAgentsDir: path.join(userHome, ".agents"),
    workspacePluginsDir: path.join(workspaceRoot, ".agents", "plugins"),
    userPluginsDir: path.join(userHome, ".agents", "plugins"),
    builtInDir: path.dirname(builtInConfigDir),
    builtInConfigDir,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

async function writePlugin(rootDir: string, displayName: string, description = "Plugin helpers") {
  await fs.mkdir(path.join(rootDir, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "skills", "import-frame"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "figma-toolkit",
      description,
      interface: { displayName },
    }, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(rootDir, "skills", "import-frame", "SKILL.md"),
    [
      "---",
      "name: import-frame",
      "description: Import a frame",
      "---",
      "",
      "# Import frame",
    ].join("\n"),
    "utf-8",
  );
}

function pluginEntry(scope: "workspace" | "user", rootDir: string): PluginCatalogEntry {
  return {
    id: "figma-toolkit",
    name: "figma-toolkit",
    displayName: scope === "workspace" ? "Workspace Figma Toolkit" : "User Figma Toolkit",
    description: "Figma helpers",
    scope,
    discoveryKind: "direct",
    enabled: true,
    rootDir,
    manifestPath: path.join(rootDir, ".codex-plugin", "plugin.json"),
    skillsPath: path.join(rootDir, "skills"),
    skills: [],
    mcpServers: [],
    apps: [],
    warnings: [],
  };
}

describe("plugin catalog and install operations", () => {
  test("installPluginsFromSource allows a workspace copy to shadow an existing user plugin", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const userPluginRoot = path.join(home, ".agents", "plugins", "figma-toolkit");
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(userPluginRoot, "User Figma Toolkit", "Global plugin");
      await writePlugin(sourceRoot, "Workspace Figma Toolkit", "Workspace override");

      const result = await installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });

      expect(result.pluginIds).toEqual(["figma-toolkit"]);
      const installedPluginPath = path.join(workspace, ".agents", "plugins", "figma-toolkit", ".codex-plugin", "plugin.json");
      await expect(fs.stat(installedPluginPath)).resolves.toBeDefined();

      const matchingPlugins = result.catalog.plugins.filter((plugin) => plugin.id === "figma-toolkit");
      expect(matchingPlugins.map((plugin) => plugin.scope).sort()).toEqual(["user", "workspace"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("resolvePluginCatalogEntry requires scope when the same plugin id exists twice", () => {
    const catalog: PluginCatalogSnapshot = {
      plugins: [
        pluginEntry("workspace", "/tmp/workspace/.agents/plugins/figma-toolkit"),
        pluginEntry("user", "/tmp/home/.agents/plugins/figma-toolkit"),
      ],
      warnings: [],
    };

    const ambiguous = resolvePluginCatalogEntry({
      catalog,
      pluginId: "figma-toolkit",
    });
    expect(ambiguous.plugin).toBeNull();
    expect(ambiguous.error).toContain("multiple scopes");

    const workspacePlugin = resolvePluginCatalogEntry({
      catalog,
      pluginId: "figma-toolkit",
      scope: "workspace",
    });
    expect(workspacePlugin.error).toBeUndefined();
    expect(workspacePlugin.plugin?.rootDir).toBe("/tmp/workspace/.agents/plugins/figma-toolkit");
  });
});
