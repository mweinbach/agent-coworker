import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readMCPAuthFiles, setMCPServerApiKeyCredential } from "../src/mcp/authStore";
import { loadMCPConfigRegistry } from "../src/mcp/configRegistry/layers";
import { installPluginsFromSource, previewPluginInstall } from "../src/plugins/operations";
import { buildPluginCatalogSnapshot, resolvePluginCatalogEntry } from "../src/plugins/catalog";
import { discoverPlugins } from "../src/plugins/discovery";
import { readPluginManifest } from "../src/plugins/manifest";
import { discoverSkillsForConfig } from "../src/skills";
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

async function writePlugin(
  rootDir: string,
  displayName: string,
  description = "Plugin helpers",
  mcpServerName = "figma",
) {
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
  await fs.writeFile(
    path.join(rootDir, ".mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        [mcpServerName]: {
          type: "http",
          url: `https://${displayName.toLowerCase().replace(/\s+/g, "-")}.example.com`,
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );
}

async function writeBundledSkill(skillsDir: string, name: string, description: string) {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
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
  test("skill-only plugins do not invent missing default MCP or app config paths", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-only-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-only-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-only-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source", "skill-only");
      await fs.mkdir(path.join(sourceRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(sourceRoot, "skills", "example"), { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "skill-only",
          description: "Skills only",
        }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(sourceRoot, "skills", "example", "SKILL.md"),
        [
          "---",
          "name: example",
          "description: Example skill",
          "---",
          "",
          "# Example",
        ].join("\n"),
        "utf-8",
      );

      const manifest = await readPluginManifest(sourceRoot);
      expect(manifest.mcpPath).toBeUndefined();
      expect(manifest.appPath).toBeUndefined();

      const preview = await previewPluginInstall({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });
      expect(preview.warnings).toEqual([]);
      expect(preview.candidates).toEqual([
        expect.objectContaining({
          pluginId: "skill-only",
          diagnostics: [],
        }),
      ]);

      const result = await installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });
      expect(result.pluginIds).toEqual(["skill-only"]);

      const mcpRegistry = await loadMCPConfigRegistry(config);
      expect(mcpRegistry.servers).toEqual([]);
      expect(mcpRegistry.warnings).toEqual([]);
      expect(mcpRegistry.files.some((file) => file.source === "plugin")).toBe(false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

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

  test("installPluginsFromSource preserves the existing install when the replacement copy fails", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-atomic-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-atomic-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-atomic-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    const unreadablePath = path.join(workspace, "plugin-source", "figma-toolkit", "secret.bin");

    try {
      const installedPluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(installedPluginRoot, "Existing Figma Toolkit", "Existing plugin");
      await writePlugin(sourceRoot, "Replacement Figma Toolkit", "Replacement plugin");
      await fs.writeFile(unreadablePath, "secret\n", "utf-8");
      await fs.chmod(unreadablePath, 0o000);

      await expect(installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      })).rejects.toThrow();

      const installedManifest = JSON.parse(
        await fs.readFile(path.join(installedPluginRoot, ".codex-plugin", "plugin.json"), "utf-8"),
      ) as { description?: string; interface?: { displayName?: string } };
      expect(installedManifest.description).toBe("Existing plugin");
      expect(installedManifest.interface?.displayName).toBe("Existing Figma Toolkit");
    } finally {
      await fs.chmod(unreadablePath, 0o644).catch(() => {});
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource removes same-scope marketplace copies before installing", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-marketplace-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-marketplace-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-marketplace-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const marketplacePluginRoot = path.join(workspace, ".agents", "plugins", "market", "figma-market");
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(marketplacePluginRoot, "Marketplace Figma Toolkit", "Marketplace plugin");
      await fs.mkdir(path.join(workspace, ".agents", "plugins"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".agents", "plugins", "marketplace.json"),
        `${JSON.stringify({
          name: "workspace-market",
          plugins: [
            {
              name: "figma-toolkit",
              source: {
                source: "local",
                path: "./market/figma-market",
              },
              policy: {
                installation: "manual",
                authentication: "optional",
              },
              category: "design",
            },
          ],
        }, null, 2)}\n`,
        "utf-8",
      );
      await writePlugin(sourceRoot, "Installed Figma Toolkit", "Workspace install");

      const result = await installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });

      const workspaceMatches = result.catalog.plugins.filter((plugin) => plugin.scope === "workspace" && plugin.id === "figma-toolkit");
      expect(workspaceMatches).toHaveLength(1);
      expect(workspaceMatches[0]?.rootDir).toBe(path.join(workspace, ".agents", "plugins", "figma-toolkit"));
      expect(
        resolvePluginCatalogEntry({
          catalog: result.catalog,
          pluginId: "figma-toolkit",
          scope: "workspace",
        }),
      ).toEqual({
        plugin: expect.objectContaining({
          id: "figma-toolkit",
          scope: "workspace",
        }),
      });
      await expect(fs.access(marketplacePluginRoot)).rejects.toBeDefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource preserves bundled MCP credentials when a plugin renames its server", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-rename-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-rename-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-rename-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const installedPluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const updatedPluginRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(installedPluginRoot, "Workspace Figma Toolkit", "Workspace plugin", "figma");
      await writePlugin(updatedPluginRoot, "Workspace Figma Toolkit", "Workspace plugin", "figma-renamed");

      await setMCPServerApiKeyCredential({
        config,
        server: {
          name: "figma",
          source: "plugin",
          inherited: false,
          pluginId: "figma-toolkit",
          pluginName: "figma-toolkit",
          pluginDisplayName: "Workspace Figma Toolkit",
          pluginScope: "workspace",
          transport: { type: "http", url: "https://workspace-figma-toolkit.example.com" },
          auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
        },
        apiKey: "workspace-secret",
      });

      await installPluginsFromSource({
        config,
        input: updatedPluginRoot,
        targetScope: "workspace",
      });

      const authFiles = await readMCPAuthFiles(config);
      expect(authFiles.workspace.doc.servers.figma).toBeUndefined();
      expect(authFiles.workspace.doc.servers["figma-renamed"]?.apiKey?.value).toBe("workspace-secret");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource prefers the installed plugin copy when migrating renamed MCP credentials", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-installed-precedence-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-installed-precedence-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-installed-precedence-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const installedPluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const marketplacePluginRoot = path.join(workspace, ".agents", "plugins", "market", "figma-market");
      const updatedPluginRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(installedPluginRoot, "Workspace Figma Toolkit", "Workspace plugin", "figma");
      await writePlugin(marketplacePluginRoot, "Marketplace Figma Toolkit", "Marketplace plugin", "figma-market");
      await fs.mkdir(path.join(workspace, ".agents", "plugins"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".agents", "plugins", "marketplace.json"),
        `${JSON.stringify({
          name: "workspace-market",
          plugins: [
            {
              name: "figma-toolkit",
              source: {
                source: "local",
                path: "./market/figma-market",
              },
              policy: {
                installation: "manual",
                authentication: "optional",
              },
              category: "design",
            },
          ],
        }, null, 2)}\n`,
        "utf-8",
      );
      await writePlugin(updatedPluginRoot, "Workspace Figma Toolkit", "Workspace plugin", "figma-renamed");

      await setMCPServerApiKeyCredential({
        config,
        server: {
          name: "figma",
          source: "plugin",
          inherited: false,
          pluginId: "figma-toolkit",
          pluginName: "figma-toolkit",
          pluginDisplayName: "Workspace Figma Toolkit",
          pluginScope: "workspace",
          transport: { type: "http", url: "https://workspace-figma-toolkit.example.com" },
          auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
        },
        apiKey: "workspace-secret",
      });

      await installPluginsFromSource({
        config,
        input: updatedPluginRoot,
        targetScope: "workspace",
      });

      const authFiles = await readMCPAuthFiles(config);
      expect(authFiles.workspace.doc.servers.figma).toBeUndefined();
      expect(authFiles.workspace.doc.servers["figma-renamed"]?.apiKey?.value).toBe("workspace-secret");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("workspace plugin copies take precedence over user copies for skills and MCP servers", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-precedence-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-precedence-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-precedence-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writePlugin(path.join(home, ".agents", "plugins", "figma-toolkit"), "User Figma Toolkit", "Global plugin");
      await writePlugin(
        path.join(workspace, ".agents", "plugins", "figma-toolkit"),
        "Workspace Figma Toolkit",
        "Workspace override",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(catalog.plugins.map((plugin) => `${plugin.scope}:${plugin.displayName}`)).toEqual([
        "workspace:Workspace Figma Toolkit",
        "user:User Figma Toolkit",
      ]);

      const skills = await discoverSkillsForConfig(config, { pluginCatalog: catalog });
      expect(skills.find((skill) => skill.name === "figma-toolkit:import-frame")?.plugin?.displayName)
        .toBe("Workspace Figma Toolkit");

      const mcpRegistry = await loadMCPConfigRegistry(config);
      const figmaServer = mcpRegistry.servers.find((server) => server.name === "figma");
      expect(figmaServer?.pluginScope).toBe("workspace");
      expect(figmaServer?.transport.type).toBe("http");
      if (figmaServer?.transport.type === "http") {
        expect(figmaServer.transport.url).toBe("https://workspace-figma-toolkit.example.com");
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("preview treats disabled workspace plugins as non-blocking for user installs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-preview-disabled-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-preview-disabled-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-preview-disabled-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const workspacePluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(workspacePluginRoot, "Workspace Figma Toolkit", "Workspace override");
      await writePlugin(sourceRoot, "User Figma Toolkit", "Global plugin");
      await fs.mkdir(path.join(workspace, ".cowork"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".cowork", "plugins.json"),
        `${JSON.stringify({
          version: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
          plugins: {
            "figma-toolkit": false,
          },
        }, null, 2)}\n`,
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(catalog.plugins.find((plugin) => plugin.id === "figma-toolkit" && plugin.scope === "workspace")?.enabled).toBe(false);

      const preview = await previewPluginInstall({
        config,
        input: sourceRoot,
        targetScope: "user",
      });

      expect(preview.candidates).toEqual([
        expect.objectContaining({
          pluginId: "figma-toolkit",
          wouldBePrimary: true,
        }),
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin manifests can declare multiple bundled skills directories", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-skills-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-skills-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-skills-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "multi-skill");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "skills-a"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "skills-b"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "multi-skill",
          description: "Plugin with multiple bundled skill directories",
          skills: ["./skills-a", "./skills-b"],
        }, null, 2)}\n`,
        "utf-8",
      );
      await writeBundledSkill(path.join(pluginRoot, "skills-a"), "alpha", "Alpha skill");
      await writeBundledSkill(path.join(pluginRoot, "skills-b"), "beta", "Beta skill");

      const manifest = await readPluginManifest(pluginRoot);
      expect(manifest.skillsPath).toBe(path.join(pluginRoot, "skills-a"));
      expect(manifest.skillsPaths).toEqual([
        path.join(pluginRoot, "skills-a"),
        path.join(pluginRoot, "skills-b"),
      ]);

      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find((entry) => entry.id === "multi-skill");
      expect(plugin?.skills.map((skill) => skill.rawName)).toEqual(["alpha", "beta"]);

      const discoveredSkills = await discoverSkillsForConfig(config, { pluginCatalog: catalog });
      expect(
        discoveredSkills
          .filter((skill) => skill.plugin?.pluginId === "multi-skill")
          .map((skill) => skill.name)
          .sort(),
      ).toEqual(["multi-skill:alpha", "multi-skill:beta"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("readPluginManifest rejects MCP and app paths outside the plugin root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-manifest-bounds-"));
    const pluginRoot = path.join(tempRoot, "plugin");
    const outsidePath = path.join(tempRoot, "outside.json");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(outsidePath, "{}\n", "utf-8");

    try {
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "demo-plugin",
          mcpServers: "../outside.json",
        }, null, 2)}\n`,
        "utf-8",
      );
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow("resolves mcpServers outside the plugin root");

      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "demo-plugin",
          apps: "../outside.json",
        }, null, 2)}\n`,
        "utf-8",
      );
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow("resolves apps outside the plugin root");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("readPluginManifest rejects symlinked plugin assets that escape the plugin root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-manifest-symlink-bounds-"));
    const pluginRoot = path.join(tempRoot, "plugin");
    const outsideSkillsRoot = path.join(tempRoot, "outside-skills");
    const outsideFile = path.join(tempRoot, "outside.json");

    try {
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({ name: "demo-plugin" }, null, 2)}\n`,
        "utf-8",
      );

      await fs.mkdir(path.join(outsideSkillsRoot, "external-skill"), { recursive: true });
      await fs.writeFile(
        path.join(outsideSkillsRoot, "external-skill", "SKILL.md"),
        [
          "---",
          "name: external-skill",
          "description: Outside plugin root",
          "---",
          "",
          "# External skill",
        ].join("\n"),
        "utf-8",
      );
      await fs.writeFile(outsideFile, "{}\n", "utf-8");

      await fs.symlink(outsideSkillsRoot, path.join(pluginRoot, "skills"));
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow("resolves skills outside the plugin root");

      await fs.rm(path.join(pluginRoot, "skills"), { force: true });
      await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
      await fs.symlink(outsideFile, path.join(pluginRoot, ".mcp.json"));
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow("resolves mcpServers outside the plugin root");

      await fs.rm(path.join(pluginRoot, ".mcp.json"), { force: true });
      await fs.symlink(outsideFile, path.join(pluginRoot, ".app.json"));
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow("resolves apps outside the plugin root");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("direct plugin discovery follows symlinked plugin directories", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-discovery-symlink-workspace-"));

    try {
      const checkoutRoot = path.join(workspace, "plugin-checkout", "figma-toolkit");
      await writePlugin(checkoutRoot, "Symlinked Figma Toolkit");

      const pluginsDir = path.join(workspace, ".agents", "plugins");
      await fs.mkdir(pluginsDir, { recursive: true });
      const linkedPluginRoot = path.join(pluginsDir, "figma-toolkit");
      await fs.symlink(checkoutRoot, linkedPluginRoot, process.platform === "win32" ? "junction" : "dir");

      const discovery = await discoverPlugins({ workspacePluginsDir: pluginsDir });

      expect(discovery.plugins).toHaveLength(1);
      expect(discovery.plugins[0]).toMatchObject({
        rootDir: linkedPluginRoot,
        realRootDir: await fs.realpath(checkoutRoot),
        scope: "workspace",
        discoveryKind: "direct",
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("marketplace discovery rejects symlinked source paths that escape the marketplace root", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-marketplace-symlink-workspace-"));

    try {
      const outsidePluginRoot = path.join(workspace, "external-plugin", "figma-toolkit");
      await writePlugin(outsidePluginRoot, "External Figma Toolkit");

      const pluginsDir = path.join(workspace, ".agents", "plugins");
      const linkedPluginRoot = path.join(pluginsDir, "market", "bundle-link");
      await fs.mkdir(path.dirname(linkedPluginRoot), { recursive: true });
      await fs.symlink(
        outsidePluginRoot,
        linkedPluginRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      await fs.writeFile(
        path.join(pluginsDir, "marketplace.json"),
        `${JSON.stringify({
          name: "workspace-market",
          plugins: [
            {
              name: "figma-toolkit",
              source: {
                source: "local",
                path: "./market/bundle-link",
              },
              policy: {
                installation: "manual",
                authentication: "optional",
              },
              category: "design",
            },
          ],
        }, null, 2)}\n`,
        "utf-8",
      );

      const discovery = await discoverPlugins({ workspacePluginsDir: pluginsDir });

      expect(discovery.plugins).toEqual([]);
      expect(discovery.warnings).toEqual([
        expect.stringContaining("Ignoring malformed marketplace"),
      ]);
      expect(discovery.warnings[0]).toContain("resolves outside marketplace root");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("preview and install reject explicit missing skills directories", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-missing-skills-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-missing-skills-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-missing-skills-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source", "broken-plugin");
      await fs.mkdir(path.join(sourceRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "broken-plugin",
          description: "Broken plugin",
          skills: "./missing-skills",
        }, null, 2)}\n`,
        "utf-8",
      );

      await expect(readPluginManifest(sourceRoot)).rejects.toThrow("declares skills path");

      const preview = await previewPluginInstall({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });
      expect(preview.warnings).toEqual(["No valid plugin bundles were found in the provided source."]);
      expect(preview.candidates).toEqual([
        expect.objectContaining({
          pluginId: "broken-plugin",
          diagnostics: [
            expect.objectContaining({
              code: "invalid_plugin_manifest",
              severity: "error",
              message: expect.stringContaining("declares skills path"),
            }),
          ],
        }),
      ]);

      await expect(installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      })).rejects.toThrow("No valid plugin bundles were found in the provided source");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin catalog surfaces warnings for invalid bundled skills", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-catalog-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-catalog-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-catalog-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      await writePlugin(pluginRoot, "Broken Figma Toolkit");
      await fs.writeFile(
        path.join(pluginRoot, "skills", "import-frame", "SKILL.md"),
        "# Missing frontmatter\n",
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]?.skills).toEqual([]);
      expect(
        catalog.plugins[0]?.warnings.some((warning) =>
          warning.includes("import-frame") && warning.includes("SKILL.md")),
      ).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin catalog surfaces warnings for invalid bundled MCP manifests on installed plugins", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-installed-mcp-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-installed-mcp-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-installed-mcp-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "figma-toolkit",
          description: "Broken MCP plugin",
          mcpServers: "./missing.mcp.json",
        }, null, 2)}\n`,
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]?.mcpServers).toEqual([]);
      expect(catalog.plugins[0]?.warnings).toEqual([
        expect.stringContaining("Invalid or unreadable bundled MCP config"),
      ]);
      expect(catalog.plugins[0]?.warnings[0]).toContain("missing.mcp.json");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin install preview and install reject sources with invalid bundled skills", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-source-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-source-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-source-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(sourceRoot, "Broken Figma Toolkit");
      await fs.writeFile(
        path.join(sourceRoot, "skills", "import-frame", "SKILL.md"),
        "# Missing frontmatter\n",
        "utf-8",
      );

      const preview = await previewPluginInstall({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });
      expect(preview.warnings).toEqual(["No valid plugin bundles were found in the provided source."]);
      expect(preview.candidates).toEqual([
        expect.objectContaining({
          pluginId: "figma-toolkit",
          diagnostics: [
            expect.objectContaining({
              code: "invalid_plugin_skill",
              severity: "error",
              message: expect.stringContaining("invalid or missing frontmatter"),
            }),
          ],
        }),
      ]);

      await expect(installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      })).rejects.toThrow("No valid plugin bundles were found in the provided source");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin install preview and install reject sources with malformed bundled MCP config", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-mcp-source-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-mcp-source-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-mcp-source-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(sourceRoot, "Broken Figma Toolkit");
      await fs.writeFile(path.join(sourceRoot, ".mcp.json"), "{\n", "utf-8");

      const preview = await previewPluginInstall({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });
      expect(preview.warnings).toEqual(["No valid plugin bundles were found in the provided source."]);
      expect(preview.candidates).toEqual([
        expect.objectContaining({
          pluginId: "figma-toolkit",
          diagnostics: [
            expect.objectContaining({
              code: "invalid_plugin_mcp",
              severity: "error",
              message: expect.stringContaining(".mcp.json"),
            }),
          ],
        }),
      ]);

      await expect(installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      })).rejects.toThrow("No valid plugin bundles were found in the provided source");
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

  test("surfaces warnings for malformed bundled plugin skills", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-malformed-skills-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-malformed-skills-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-malformed-skills-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      await writePlugin(pluginRoot, "Workspace Figma Toolkit", "Workspace override");
      await fs.mkdir(path.join(pluginRoot, "skills", "broken-skill"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "skills", "broken-skill", "SKILL.md"),
        [
          "---",
          "name: broken-skill",
          "description: [not valid yaml",
          "---",
          "",
          "# Broken skill",
        ].join("\n"),
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find((entry) => entry.id === "figma-toolkit");

      expect(plugin).toBeDefined();
      expect(plugin?.skills.map((skill) => skill.rawName)).toEqual(["import-frame"]);
      expect(plugin?.warnings).toHaveLength(1);
      expect(plugin?.warnings[0]).toContain("broken-skill");
      expect(plugin?.warnings[0]).toContain("SKILL.md");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
