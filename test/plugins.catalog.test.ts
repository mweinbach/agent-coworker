import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeSourceRootHash } from "../src/extensions/sourceFingerprint";
import { readMCPAuthFiles, setMCPServerApiKeyCredential } from "../src/mcp/authStore";
import { loadMCPConfigRegistry } from "../src/mcp/configRegistry/layers";
import {
  buildPluginCatalogSnapshot,
  buildRemoteMarketplacePluginDetail,
  resolvePluginCatalogEntry,
} from "../src/plugins/catalog";
import { discoverPlugins } from "../src/plugins/discovery";
import { readPluginManifest, writePluginInstallMetadata } from "../src/plugins/manifest";
import {
  checkPluginInstallationUpdate,
  deletePluginInstallation,
  installPluginsFromSource,
  __internal as pluginOperationsInternal,
  previewPluginInstall,
  updatePluginInstallation,
} from "../src/plugins/operations";
import { setPluginMcpServerEnabled } from "../src/plugins/overrides";
import { discoverSkillsForConfig } from "../src/skills";
import type {
  AgentConfig,
  InstalledPluginCatalogEntry,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
} from "../src/types";

const OLD_SOURCE_HASH = `sha256:${"1".repeat(64)}`;
const NEW_SOURCE_HASH = `sha256:${"2".repeat(64)}`;

function makeConfig(
  workspaceRoot: string,
  userHome: string,
  builtInConfigDir: string,
): AgentConfig {
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

async function createSymlinkOrSkip(
  target: string,
  linkPath: string,
  type?: Parameters<typeof fs.symlink>[2],
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw err;
  }
}

async function removePathForTest(targetPath: string): Promise<void> {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink()) {
      await fs.unlink(targetPath);
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw err;
  }

  await fs.rm(targetPath, { recursive: true, force: true });
}

async function writePlugin(
  rootDir: string,
  displayName: string,
  description = "Plugin helpers",
  mcpServerName = "figma",
  pluginId = "figma-toolkit",
) {
  await fs.mkdir(path.join(rootDir, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "skills", "import-frame"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: pluginId,
        description,
        interface: { displayName },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(rootDir, "skills", "import-frame", "SKILL.md"),
    ["---", "name: import-frame", "description: Import a frame", "---", "", "# Import frame"].join(
      "\n",
    ),
    "utf-8",
  );
  await fs.writeFile(
    path.join(rootDir, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          [mcpServerName]: {
            type: "http",
            url: `https://${displayName.toLowerCase().replace(/\s+/g, "-")}.example.com`,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function writeNamedPlugin(
  rootDir: string,
  pluginId: string,
  displayName: string,
  description = "Plugin helpers",
) {
  await fs.mkdir(path.join(rootDir, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "skills", "import-frame"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: pluginId,
        description,
        interface: { displayName },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(rootDir, "skills", "import-frame", "SKILL.md"),
    ["---", "name: import-frame", "description: Import a frame", "---", "", "# Import frame"].join(
      "\n",
    ),
    "utf-8",
  );
}

async function writeBundledSkill(skillsDir: string, name: string, description: string) {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
    "utf-8",
  );
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(payload: string, status = 200): Response {
  return new Response(payload, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function createRemoteMarketplaceFetch(
  opts: { includeMissingPlugin?: boolean; remoteManifestName?: string; sourceHash?: string } = {},
): typeof fetch {
  const tree: Record<string, unknown> = {
    ".agents/plugins/marketplace.json": {
      type: "file",
      name: "marketplace.json",
      path: ".agents/plugins/marketplace.json",
      url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/.agents/plugins/marketplace.json?ref=main",
      download_url: "https://download.test/marketplace.json",
    },
    "plugins/figma-toolkit": [
      {
        type: "dir",
        name: ".cowork-plugin",
        path: "plugins/figma-toolkit/.cowork-plugin",
        url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/figma-toolkit/.cowork-plugin?ref=main",
        download_url: null,
      },
      {
        type: "dir",
        name: "skills",
        path: "plugins/figma-toolkit/skills",
        url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/figma-toolkit/skills?ref=main",
        download_url: null,
      },
    ],
    "plugins/figma-toolkit/.cowork-plugin": [
      {
        type: "file",
        name: "plugin.json",
        path: "plugins/figma-toolkit/.cowork-plugin/plugin.json",
        url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/figma-toolkit/.cowork-plugin/plugin.json?ref=main",
        download_url: "https://download.test/figma-toolkit/plugin.json",
      },
    ],
    "plugins/figma-toolkit/skills": [
      {
        type: "dir",
        name: "import-frame",
        path: "plugins/figma-toolkit/skills/import-frame",
        url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/figma-toolkit/skills/import-frame?ref=main",
        download_url: null,
      },
    ],
    "plugins/figma-toolkit/skills/import-frame": [
      {
        type: "file",
        name: "SKILL.md",
        path: "plugins/figma-toolkit/skills/import-frame/SKILL.md",
        url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/figma-toolkit/skills/import-frame/SKILL.md?ref=main",
        download_url: "https://download.test/figma-toolkit/SKILL.md",
      },
    ],
  };
  const marketplace = {
    name: "cowork-test",
    interface: { displayName: "Cowork Test" },
    plugins: [
      ...(opts.includeMissingPlugin
        ? [
            {
              name: "missing-toolkit",
              source: { source: "local", path: "./plugins/missing-toolkit" },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Design",
            },
          ]
        : []),
      {
        name: "figma-toolkit",
        source: { source: "local", path: "./plugins/figma-toolkit" },
        ...(opts.sourceHash ? { sourceHash: opts.sourceHash } : {}),
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Design",
      },
    ],
  };
  const files: Record<string, string> = {
    "https://download.test/marketplace.json": JSON.stringify(marketplace),
    "https://download.test/figma-toolkit/plugin.json": JSON.stringify({
      name: opts.remoteManifestName ?? "figma-toolkit",
      version: "1.0.0",
      description: "Remote Figma helpers",
      interface: { displayName: "Remote Figma Toolkit" },
    }),
    "https://download.test/figma-toolkit/SKILL.md":
      "---\nname: import-frame\ndescription: Import a frame\n---\n# Import frame\n",
  };

  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      const key = Object.keys(tree)
        .sort((a, b) => b.length - a.length)
        .find((candidate) => url.includes(`/contents/${candidate}`));
      return key ? jsonResponse(tree[key]) : textResponse("not found", 404);
    }
    const file = files[url];
    return file !== undefined ? textResponse(file) : textResponse("not found", 404);
  }) as typeof fetch;
}

const SECOND_MARKETPLACE_REPO = "acme/extra-market";
const BUILT_IN_REPO = "mweinbach/cowork-skills-plugins";

async function writeConfiguredMarketplaces(userHome: string, repos: string[]): Promise<void> {
  const configDir = path.join(userHome, ".cowork", "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "marketplaces.json"),
    `${JSON.stringify({
      version: 1,
      marketplaces: repos.map((repo) => ({
        repo,
        ref: "main",
        marketplacePath: ".agents/plugins/marketplace.json",
        addedAt: "2026-01-01T00:00:00.000Z",
      })),
    })}\n`,
    "utf-8",
  );
}

function pluginMarketplaceDoc(name: string, pluginNames: string[]): unknown {
  return {
    name,
    interface: { displayName: `${name} Display` },
    plugins: pluginNames.map((pluginName) => ({
      name: pluginName,
      source: { source: "local", path: `./plugins/${pluginName}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Design",
    })),
  };
}

// Serves per-repo marketplace.json docs; a `null` doc fails that repo's fetch.
function createMultiRepoMarketplaceFetch(docsByRepo: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [repo, doc] of Object.entries(docsByRepo)) {
      if (
        url ===
        `https://api.github.com/repos/${repo}/contents/.agents/plugins/marketplace.json?ref=main`
      ) {
        if (doc === null) {
          return textResponse("boom", 500);
        }
        return jsonResponse({
          type: "file",
          name: "marketplace.json",
          path: ".agents/plugins/marketplace.json",
          download_url: `https://download.test/${repo}/marketplace.json`,
        });
      }
      if (url === `https://download.test/${repo}/marketplace.json` && doc !== null) {
        return textResponse(JSON.stringify(doc));
      }
    }
    return textResponse("not found", 404);
  }) as typeof fetch;
}

function pluginEntry(scope: "workspace" | "user", rootDir: string): PluginCatalogEntry {
  return {
    id: "figma-toolkit",
    name: "figma-toolkit",
    displayName: scope === "workspace" ? "Workspace Figma Toolkit" : "User Figma Toolkit",
    description: "Figma helpers",
    scope,
    discoveryKind: "direct",
    installed: true,
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
  test("remote marketplace entries appear as available plugins on fresh installs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-remote-market-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-remote-market-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-remote-market-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createRemoteMarketplaceFetch(),
      });

      expect(catalog.warnings).toEqual([]);
      expect(catalog.plugins).toHaveLength(0);
      expect(catalog.availablePlugins).toHaveLength(1);
      const plugin = catalog.availablePlugins[0];
      expect(plugin).toMatchObject({
        id: "figma-toolkit",
        displayName: "figma-toolkit",
        scope: "user",
        discoveryKind: "marketplace",
        enabled: false,
        installed: false,
        installSource:
          "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit",
        marketplace: {
          name: "cowork-test",
          displayName: "Cowork Test",
          category: "Design",
        },
      });
      expect(plugin).not.toHaveProperty("rootDir");
      expect(plugin).not.toHaveProperty("manifestPath");
      expect(plugin).not.toHaveProperty("skillsPath");
      expect(plugin).not.toHaveProperty("skills");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("available plugins aggregate across configured marketplaces with earlier marketplaces winning collisions", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-market-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-market-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-market-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createMultiRepoMarketplaceFetch({
          [BUILT_IN_REPO]: pluginMarketplaceDoc("built-in", ["shared-toolkit"]),
          [SECOND_MARKETPLACE_REPO]: pluginMarketplaceDoc("acme-market", [
            "shared-toolkit",
            "acme-toolkit",
          ]),
        }),
      });

      expect(catalog.remoteMarketplaceFailed).toBeUndefined();
      expect(catalog.warnings).toEqual([]);
      expect(catalog.availablePlugins.map((plugin) => plugin.id).sort()).toEqual([
        "acme-toolkit",
        "shared-toolkit",
      ]);
      const sharedToolkit = catalog.availablePlugins.find(
        (plugin) => plugin.id === "shared-toolkit",
      );
      expect(sharedToolkit).toMatchObject({
        marketplace: { name: "built-in" },
        installSource: `https://github.com/${BUILT_IN_REPO}/tree/main/plugins/shared-toolkit`,
      });
      const acmeToolkit = catalog.availablePlugins.find((plugin) => plugin.id === "acme-toolkit");
      expect(acmeToolkit).toMatchObject({
        marketplace: { name: "acme-market" },
        installSource: `https://github.com/${SECOND_MARKETPLACE_REPO}/tree/main/plugins/acme-toolkit`,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("one failing marketplace sets remoteMarketplaceFailed while the other still loads", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-multi-market-fail-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-market-fail-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-market-fail-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createMultiRepoMarketplaceFetch({
          [BUILT_IN_REPO]: null,
          [SECOND_MARKETPLACE_REPO]: pluginMarketplaceDoc("acme-market", ["acme-toolkit"]),
        }),
      });

      expect(catalog.remoteMarketplaceFailed).toBe(true);
      expect(catalog.availablePlugins.map((plugin) => plugin.id)).toEqual(["acme-toolkit"]);
      expect(catalog.warnings).toEqual([
        expect.stringContaining(`Failed to load remote marketplace ${BUILT_IN_REPO}`),
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("remote marketplace plugin detail searches all configured marketplaces", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-multi-market-detail-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-multi-market-detail-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-multi-market-detail-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
      const fetchImpl = createMultiRepoMarketplaceFetch({
        [BUILT_IN_REPO]: pluginMarketplaceDoc("built-in", []),
        [SECOND_MARKETPLACE_REPO]: pluginMarketplaceDoc("acme-market", ["acme-toolkit"]),
      });

      const detail = await buildRemoteMarketplacePluginDetail({
        config,
        pluginId: "acme-toolkit",
        fetchImpl,
      });
      expect(detail).toMatchObject({
        id: "acme-toolkit",
        installed: false,
        description: "Available from acme-market Display.",
      });

      const missing = await buildRemoteMarketplacePluginDetail({
        config,
        pluginId: "unknown-toolkit",
        fetchImpl,
      });
      expect(missing).toBeNull();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("remote marketplace metadata does not annotate unrelated installed plugins sharing an id", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-market-installed-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-installed-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-installed-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      if (!config.userPluginsDir) {
        throw new Error("Expected user plugin directory");
      }
      await writePlugin(path.join(config.userPluginsDir, "figma-toolkit"), "User Figma Toolkit");
      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createRemoteMarketplaceFetch(),
      });

      expect(catalog.warnings).toEqual([]);
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.availablePlugins).toHaveLength(0);
      expect(catalog.plugins[0]).toMatchObject({
        id: "figma-toolkit",
        installed: true,
      });
      expect(catalog.plugins[0]?.installSource).toBeUndefined();
      expect(catalog.plugins[0]?.marketplace).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("remote marketplace metadata annotates marketplace-installed plugins without duplicating them", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-market-provenance-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-provenance-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-provenance-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      if (!config.userPluginsDir) {
        throw new Error("Expected user plugin directory");
      }
      const marketplacePluginRoot = path.join(config.userPluginsDir, "market", "figma-toolkit");
      await writePlugin(marketplacePluginRoot, "Marketplace Figma Toolkit");
      await fs.mkdir(config.userPluginsDir, { recursive: true });
      await fs.writeFile(
        path.join(config.userPluginsDir, "marketplace.json"),
        `${JSON.stringify(
          {
            name: "cowork-test",
            plugins: [
              {
                name: "figma-toolkit",
                source: { source: "local", path: "./market/figma-toolkit" },
                policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
                category: "Design",
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createRemoteMarketplaceFetch(),
      });

      expect(catalog.warnings).toEqual([]);
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]).toMatchObject({
        id: "figma-toolkit",
        discoveryKind: "marketplace",
        installed: true,
        installSource:
          "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit",
        marketplace: {
          name: "cowork-test",
          category: "Design",
        },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("remote marketplace metadata annotates installed plugins with stale source hashes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-stale-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-stale-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-stale-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      if (!config.userPluginsDir) {
        throw new Error("Expected user plugin directory");
      }
      const pluginRoot = path.join(config.userPluginsDir, "figma-toolkit");
      await writePlugin(pluginRoot, "Marketplace Figma Toolkit");
      await writePluginInstallMetadata(pluginRoot, {
        marketplace: {
          name: "cowork-test",
          sourceInput:
            "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit",
          sourceHash: OLD_SOURCE_HASH,
        },
      });

      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createRemoteMarketplaceFetch({ sourceHash: NEW_SOURCE_HASH }),
      });

      expect(catalog.plugins[0]).toMatchObject({
        id: "figma-toolkit",
        installedSourceHash: OLD_SOURCE_HASH,
        latestSourceHash: NEW_SOURCE_HASH,
        updateAvailable: true,
        marketplace: {
          name: "cowork-test",
          sourceHash: NEW_SOURCE_HASH,
        },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installing a remote marketplace plugin preserves update provenance", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-market-install-provenance-workspace-"),
    );
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-market-install-provenance-home-"),
    );
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-market-install-provenance-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);
    const fetchImpl = createRemoteMarketplaceFetch();
    const sourceInput =
      "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit";

    try {
      await installPluginsFromSource({
        config,
        input: sourceInput,
        targetScope: "user",
        fetchImpl,
      });

      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl,
      });

      expect(catalog.warnings).toEqual([]);
      expect(catalog.plugins).toHaveLength(1);
      const installedPlugin = catalog.plugins[0];
      if (!installedPlugin) {
        throw new Error("Expected installed plugin in catalog");
      }
      const installedSourceHash = installedPlugin.installedSourceHash;
      expect(installedSourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(catalog.plugins[0]).toMatchObject({
        id: "figma-toolkit",
        discoveryKind: "marketplace",
        installed: true,
        installSource: sourceInput,
        marketplace: {
          name: "cowork-test",
          category: "Design",
          sourceHash: installedSourceHash,
        },
      });

      const updateCheck = await checkPluginInstallationUpdate({
        config,
        plugin: installedPlugin,
        fetchImpl,
      });

      expect(updateCheck).toMatchObject({
        pluginId: "figma-toolkit",
        canUpdate: false,
        reason: "This plugin is already up to date.",
        installedSourceHash,
        latestSourceHash: installedSourceHash,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource reuses the materialized source for preview and install", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-reuse-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-reuse-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-reuse-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    const remoteFetch = createRemoteMarketplaceFetch();
    let manifestDownloads = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://download.test/figma-toolkit/plugin.json") {
        manifestDownloads += 1;
      }
      return await remoteFetch(input);
    }) as typeof fetch;

    try {
      const sourceInput =
        "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/figma-toolkit";
      const result = await installPluginsFromSource({
        config,
        input: sourceInput,
        targetScope: "user",
        fetchImpl,
        marketplaceMetadataByPluginId: new Map(),
      });

      expect(manifestDownloads).toBe(1);
      expect(result.preview.candidates.map((candidate) => candidate.pluginId)).toEqual([
        "figma-toolkit",
      ]);
      const manifest = await readPluginManifest(
        path.join(home, ".agents", "plugins", "figma-toolkit"),
      );
      expect(manifest.description).toBe("Remote Figma helpers");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource rejects mismatched marketplace source hashes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-hash-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-hash-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-hash-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source");
      await writeNamedPlugin(sourceRoot, "figma-toolkit", "Figma Toolkit");

      await expect(
        installPluginsFromSource({
          config,
          input: sourceRoot,
          targetScope: "workspace",
          marketplaceMetadataByPluginId: new Map([
            ["figma-toolkit", { name: "cowork-test", sourceHash: OLD_SOURCE_HASH }],
          ]),
        }),
      ).rejects.toThrow(/Marketplace source hash mismatch/);

      await expect(
        fs.access(path.join(config.workspacePluginsDir ?? "", "figma-toolkit")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource rejects sources with multiple valid plugin bundles", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-multi-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-multi-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-install-multi-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source");
      await writeNamedPlugin(path.join(sourceRoot, "alpha"), "alpha", "Alpha Plugin");
      await writeNamedPlugin(path.join(sourceRoot, "beta"), "beta", "Beta Plugin");

      await expect(
        installPluginsFromSource({
          config,
          input: sourceRoot,
          targetScope: "workspace",
        }),
      ).rejects.toThrow("more than one valid plugin bundle");

      await expect(
        fs.access(path.join(config.workspacePluginsDir ?? "", "alpha")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(config.workspacePluginsDir ?? "", "beta")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("remote marketplace detail does not materialize the plugin bundle", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-detail-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-detail-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-detail-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    let manifestDownloads = 0;
    const remoteFetch = createRemoteMarketplaceFetch({ remoteManifestName: "impostor-toolkit" });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://download.test/figma-toolkit/plugin.json") {
        manifestDownloads += 1;
      }
      return await remoteFetch(input);
    }) as typeof fetch;

    try {
      const detail = await buildRemoteMarketplacePluginDetail({
        config,
        pluginId: "figma-toolkit",
        fetchImpl,
      });

      expect(detail).toMatchObject({
        id: "figma-toolkit",
        installed: false,
        description: "Available from Cowork Test.",
      });
      expect(detail?.warnings).toEqual([]);
      expect(manifestDownloads).toBe(0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("remote marketplace catalog keeps entries lightweight even when a source is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-partial-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-partial-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-market-partial-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const catalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createRemoteMarketplaceFetch({ includeMissingPlugin: true }),
      });

      expect(catalog.plugins).toEqual([]);
      expect(catalog.availablePlugins.map((plugin) => plugin.id)).toEqual([
        "figma-toolkit",
        "missing-toolkit",
      ]);
      expect(catalog.warnings).toEqual([]);
      expect(catalog.availablePlugins[0]).not.toHaveProperty("rootDir");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("deletePluginInstallation removes custom plugins without default uninstall tombstones", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-delete-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-delete-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-delete-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      if (!config.userPluginsDir) {
        throw new Error("Expected user plugin directory");
      }
      await writePlugin(path.join(config.userPluginsDir, "figma-toolkit"), "User Figma Toolkit");
      const initial = await buildPluginCatalogSnapshot(config);
      const plugin = initial.plugins[0];
      if (!plugin) {
        throw new Error("Expected installed plugin");
      }
      expect(plugin?.installed).toBe(true);

      const afterDelete = await deletePluginInstallation({ config, plugin });

      expect(afterDelete.plugins).toEqual([]);
      const userPluginsDir = config.userPluginsDir;
      if (!userPluginsDir) {
        throw new Error("Expected user plugin directory");
      }
      await expect(fs.access(path.join(userPluginsDir, "figma-toolkit"))).rejects.toBeDefined();
      const overrides = JSON.parse(
        await fs.readFile(path.join(home, ".cowork", "config", "plugins.json"), "utf-8"),
      ) as {
        plugins?: Record<string, boolean>;
        removedDefaultPlugins?: Record<string, boolean>;
      };
      expect(overrides.plugins?.["figma-toolkit"]).toBeUndefined();
      expect(overrides.removedDefaultPlugins?.["figma-toolkit"]).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("deletePluginInstallation does not tombstone direct plugins with legacy default ids", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-delete-legacy-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-delete-legacy-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-delete-legacy-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      if (!config.userPluginsDir) {
        throw new Error("Expected user plugin directory");
      }
      await Promise.all([
        writePlugin(
          path.join(config.userPluginsDir, "documents"),
          "User Documents",
          "Custom documents plugin",
          "documents-server",
          "documents",
        ),
        writePlugin(
          path.join(config.userPluginsDir, "workspace-tools"),
          "User Workspace Tools",
          "Custom workspace tools plugin",
          "workspace-tools-server",
          "workspace-tools",
        ),
      ]);
      const initial = await buildPluginCatalogSnapshot(config);
      const documentsPlugin = initial.plugins.find((plugin) => plugin.id === "documents");
      const workspaceToolsPlugin = initial.plugins.find(
        (plugin) => plugin.id === "workspace-tools",
      );
      if (!documentsPlugin || !workspaceToolsPlugin) {
        throw new Error("Expected installed plugins");
      }
      expect(documentsPlugin.discoveryKind).toBe("direct");
      expect(workspaceToolsPlugin.discoveryKind).toBe("direct");

      await deletePluginInstallation({ config, plugin: documentsPlugin });
      await deletePluginInstallation({ config, plugin: workspaceToolsPlugin });

      const overrides = JSON.parse(
        await fs.readFile(path.join(home, ".cowork", "config", "plugins.json"), "utf-8"),
      ) as {
        plugins?: Record<string, boolean>;
        removedDefaultPlugins?: Record<string, boolean>;
      };
      expect(overrides.plugins?.documents).toBeUndefined();
      expect(overrides.removedDefaultPlugins?.documents).toBeUndefined();
      expect(overrides.removedDefaultPlugins?.["workspace-tools"]).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("skill-only plugins do not invent missing default MCP or app config paths", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-only-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-only-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-skill-only-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source", "skill-only");
      await fs.mkdir(path.join(sourceRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(sourceRoot, "skills", "example"), { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "skill-only",
            description: "Skills only",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(sourceRoot, "skills", "example", "SKILL.md"),
        ["---", "name: example", "description: Example skill", "---", "", "# Example"].join("\n"),
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
      expect(result.pluginId).toBe("skill-only");

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

      expect(result.pluginId).toBe("figma-toolkit");
      const installedPluginPath = path.join(
        workspace,
        ".agents",
        "plugins",
        "figma-toolkit",
        ".codex-plugin",
        "plugin.json",
      );
      await expect(fs.stat(installedPluginPath)).resolves.toBeDefined();

      const matchingPlugins = result.catalog.plugins.filter(
        (plugin) => plugin.id === "figma-toolkit",
      );
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
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-ops-atomic-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const installedPluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(installedPluginRoot, "Existing Figma Toolkit", "Existing plugin");
      await writePlugin(sourceRoot, "Replacement Figma Toolkit", "Replacement plugin");
      pluginOperationsInternal.setCopyPluginRootImplForTests(async () => {
        throw new Error("simulated copy failure");
      });

      await expect(
        installPluginsFromSource({
          config,
          input: sourceRoot,
          targetScope: "workspace",
        }),
      ).rejects.toThrow("simulated copy failure");

      const installedManifest = JSON.parse(
        await fs.readFile(path.join(installedPluginRoot, ".codex-plugin", "plugin.json"), "utf-8"),
      ) as { description?: string; interface?: { displayName?: string } };
      expect(installedManifest.description).toBe("Existing plugin");
      expect(installedManifest.interface?.displayName).toBe("Existing Figma Toolkit");
    } finally {
      pluginOperationsInternal.resetForTests();
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource removes same-scope marketplace copies before installing", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-ops-marketplace-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-ops-marketplace-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-ops-marketplace-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const marketplacePluginRoot = path.join(
        workspace,
        ".agents",
        "plugins",
        "market",
        "figma-market",
      );
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(marketplacePluginRoot, "Marketplace Figma Toolkit", "Marketplace plugin");
      await fs.mkdir(path.join(workspace, ".agents", "plugins"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".agents", "plugins", "marketplace.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await writePlugin(sourceRoot, "Installed Figma Toolkit", "Workspace install");

      const result = await installPluginsFromSource({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });

      const workspaceMatches = result.catalog.plugins.filter(
        (plugin) => plugin.scope === "workspace" && plugin.id === "figma-toolkit",
      );
      expect(workspaceMatches).toHaveLength(1);
      expect(workspaceMatches[0]?.rootDir).toBe(
        path.join(workspace, ".agents", "plugins", "figma-toolkit"),
      );
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
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-mcp-rename-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const installedPluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const updatedPluginRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(
        installedPluginRoot,
        "Workspace Figma Toolkit",
        "Workspace plugin",
        "figma",
      );
      await writePlugin(
        updatedPluginRoot,
        "Workspace Figma Toolkit",
        "Workspace plugin",
        "figma-renamed",
      );

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
      expect(authFiles.workspace.doc.servers["figma-renamed"]?.apiKey?.value).toBe(
        "workspace-secret",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("installPluginsFromSource prefers the installed plugin copy when migrating renamed MCP credentials", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-mcp-installed-precedence-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-installed-precedence-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-mcp-installed-precedence-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const installedPluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const marketplacePluginRoot = path.join(
        workspace,
        ".agents",
        "plugins",
        "market",
        "figma-market",
      );
      const updatedPluginRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(
        installedPluginRoot,
        "Workspace Figma Toolkit",
        "Workspace plugin",
        "figma",
      );
      await writePlugin(
        marketplacePluginRoot,
        "Marketplace Figma Toolkit",
        "Marketplace plugin",
        "figma-market",
      );
      await fs.mkdir(path.join(workspace, ".agents", "plugins"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".agents", "plugins", "marketplace.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await writePlugin(
        updatedPluginRoot,
        "Workspace Figma Toolkit",
        "Workspace plugin",
        "figma-renamed",
      );

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
      expect(authFiles.workspace.doc.servers["figma-renamed"]?.apiKey?.value).toBe(
        "workspace-secret",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("workspace plugin copies take precedence over user copies for skills and MCP servers", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-precedence-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-precedence-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-precedence-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writePlugin(
        path.join(home, ".agents", "plugins", "figma-toolkit"),
        "User Figma Toolkit",
        "Global plugin",
      );
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
      expect(
        skills.find((skill) => skill.name === "figma-toolkit:import-frame")?.plugin?.displayName,
      ).toBe("Workspace Figma Toolkit");

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

  test("plugin MCP server overrides disable a server without disabling the plugin", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-toggle-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-mcp-toggle-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-mcp-toggle-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writePlugin(
        path.join(workspace, ".agents", "plugins", "figma-toolkit"),
        "Workspace Figma Toolkit",
        "Workspace plugin",
        "figma",
      );

      await setPluginMcpServerEnabled({
        config,
        pluginId: "figma-toolkit",
        scope: "workspace",
        serverName: "figma",
        enabled: false,
      });

      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find(
        (entry) => entry.id === "figma-toolkit" && entry.scope === "workspace",
      );
      expect(plugin?.enabled).toBe(true);

      const mcpRegistry = await loadMCPConfigRegistry(config);
      const figmaServer = mcpRegistry.servers.find((server) => server.name === "figma");
      expect(figmaServer).toMatchObject({
        source: "plugin",
        pluginId: "figma-toolkit",
        enabled: false,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("preview treats disabled workspace plugins as non-blocking for user installs", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-preview-disabled-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-preview-disabled-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-preview-disabled-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const workspacePluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      const sourceRoot = path.join(workspace, "plugin-source", "figma-toolkit");
      await writePlugin(workspacePluginRoot, "Workspace Figma Toolkit", "Workspace override");
      await writePlugin(sourceRoot, "User Figma Toolkit", "Global plugin");
      await fs.mkdir(path.join(workspace, ".cowork"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".cowork", "plugins.json"),
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-01T00:00:00.000Z",
            plugins: {
              "figma-toolkit": false,
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(
        catalog.plugins.find(
          (plugin) => plugin.id === "figma-toolkit" && plugin.scope === "workspace",
        )?.enabled,
      ).toBe(false);

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
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-multi-skills-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "multi-skill");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "skills-a"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "skills-b"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "multi-skill",
            description: "Plugin with multiple bundled skill directories",
            skills: ["./skills-a", "./skills-b"],
          },
          null,
          2,
        )}\n`,
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

  test("plugin catalogs and discovers bundled skill directories through in-root symlinks", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-symlink-skills-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-symlink-skills-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-symlink-skills-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "symlink-skills");
      const actualSkillRoot = path.join(pluginRoot, "shared", "import-frame");
      const linkedSkillsDir = path.join(pluginRoot, "skills");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(actualSkillRoot, { recursive: true });
      await fs.mkdir(linkedSkillsDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "symlink-skills",
            description: "Plugin with symlinked bundled skills",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(actualSkillRoot, "SKILL.md"),
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
      await fs.symlink(
        actualSkillRoot,
        path.join(linkedSkillsDir, "import-frame"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find((entry) => entry.id === "symlink-skills");
      expect(plugin?.warnings).toEqual([]);
      expect(plugin?.skills.map((skill) => skill.name)).toEqual(["symlink-skills:import-frame"]);

      const discoveredSkills = await discoverSkillsForConfig(config);
      expect(discoveredSkills.map((skill) => skill.name)).toContain("symlink-skills:import-frame");
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
        `${JSON.stringify(
          {
            name: "demo-plugin",
            mcpServers: "../outside.json",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        "resolves mcpServers outside the plugin root",
      );

      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "demo-plugin",
            apps: "../outside.json",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        "resolves apps outside the plugin root",
      );
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

      const linkedSkills = await createSymlinkOrSkip(
        outsideSkillsRoot,
        path.join(pluginRoot, "skills"),
        process.platform === "win32" ? "junction" : "dir",
      );
      if (!linkedSkills) return;
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        "resolves skills outside the plugin root",
      );

      await removePathForTest(path.join(pluginRoot, "skills"));
      await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
      const linkedMcp = await createSymlinkOrSkip(outsideFile, path.join(pluginRoot, ".mcp.json"));
      if (!linkedMcp) return;
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        "resolves mcpServers outside the plugin root",
      );

      await removePathForTest(path.join(pluginRoot, ".mcp.json"));
      const linkedApp = await createSymlinkOrSkip(outsideFile, path.join(pluginRoot, ".app.json"));
      if (!linkedApp) return;
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        "resolves apps outside the plugin root",
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("direct plugin discovery follows symlinked plugin directories", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-discovery-symlink-workspace-"),
    );

    try {
      const checkoutRoot = path.join(workspace, "plugin-checkout", "figma-toolkit");
      await writePlugin(checkoutRoot, "Symlinked Figma Toolkit");

      const pluginsDir = path.join(workspace, ".agents", "plugins");
      await fs.mkdir(pluginsDir, { recursive: true });
      const linkedPluginRoot = path.join(pluginsDir, "figma-toolkit");
      await fs.symlink(
        checkoutRoot,
        linkedPluginRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

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

  test("direct plugin discovery keeps workspace and user symlinks to the same checkout as separate scopes", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-discovery-shared-checkout-workspace-"),
    );
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-discovery-shared-checkout-home-"),
    );

    try {
      const checkoutRoot = path.join(workspace, "plugin-checkout", "figma-toolkit");
      await writePlugin(checkoutRoot, "Shared Figma Toolkit");

      const workspacePluginsDir = path.join(workspace, ".agents", "plugins");
      const userPluginsDir = path.join(home, ".agents", "plugins");
      await fs.mkdir(workspacePluginsDir, { recursive: true });
      await fs.mkdir(userPluginsDir, { recursive: true });

      const workspaceLink = path.join(workspacePluginsDir, "figma-toolkit");
      const userLink = path.join(userPluginsDir, "figma-toolkit");
      await fs.symlink(
        checkoutRoot,
        workspaceLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      await fs.symlink(checkoutRoot, userLink, process.platform === "win32" ? "junction" : "dir");

      const discovery = await discoverPlugins({ workspacePluginsDir, userPluginsDir });

      expect(discovery.plugins).toHaveLength(2);
      expect(discovery.plugins).toEqual([
        expect.objectContaining({
          rootDir: workspaceLink,
          realRootDir: await fs.realpath(checkoutRoot),
          scope: "workspace",
          discoveryKind: "direct",
        }),
        expect.objectContaining({
          rootDir: userLink,
          realRootDir: await fs.realpath(checkoutRoot),
          scope: "user",
          discoveryKind: "direct",
        }),
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("direct plugin discovery deduplicates workspace and user plugin directories with the same canonical path", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-discovery-aliased-workspace-"),
    );
    const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-discovery-aliased-home-"));

    try {
      const workspacePluginsDir = path.join(workspace, ".agents", "plugins");
      const userAliasRoot = path.join(aliasParent, "workspace-alias");
      await writePlugin(path.join(workspacePluginsDir, "figma-toolkit"), "Aliased Figma Toolkit");
      const linked = await createSymlinkOrSkip(
        workspace,
        userAliasRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      if (!linked) return;

      const discovery = await discoverPlugins({
        workspacePluginsDir,
        userPluginsDir: path.join(userAliasRoot, ".agents", "plugins"),
      });

      expect(discovery.plugins).toHaveLength(1);
      expect(discovery.plugins[0]).toMatchObject({
        rootDir: path.join(workspacePluginsDir, "figma-toolkit"),
        realRootDir: await fs.realpath(path.join(workspacePluginsDir, "figma-toolkit")),
        scope: "workspace",
        discoveryKind: "direct",
      });
    } finally {
      await fs.rm(aliasParent, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("direct plugin discovery deduplicates same-scope symlinks to the same checkout", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-discovery-duplicate-symlink-workspace-"),
    );

    try {
      const checkoutRoot = path.join(workspace, "plugin-checkout", "figma-toolkit");
      await writePlugin(checkoutRoot, "Shared Figma Toolkit");

      const workspacePluginsDir = path.join(workspace, ".agents", "plugins");
      await fs.mkdir(workspacePluginsDir, { recursive: true });

      const directLink = path.join(workspacePluginsDir, "figma-toolkit");
      const aliasLink = path.join(workspacePluginsDir, "figma-toolkit-alias");
      await fs.symlink(checkoutRoot, directLink, process.platform === "win32" ? "junction" : "dir");
      await fs.symlink(checkoutRoot, aliasLink, process.platform === "win32" ? "junction" : "dir");

      const discovery = await discoverPlugins({ workspacePluginsDir });

      expect(discovery.plugins).toHaveLength(1);
      expect([directLink, aliasLink]).toContain(discovery.plugins[0]?.rootDir);
      expect(discovery.plugins[0]).toMatchObject({
        realRootDir: await fs.realpath(checkoutRoot),
        scope: "workspace",
        discoveryKind: "direct",
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("marketplace discovery rejects symlinked source paths that escape the marketplace root", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-marketplace-symlink-workspace-"),
    );

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
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
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

  test("plugin discovery deduplicates marketplace and direct entries for the same canonical plugin root", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-marketplace-direct-dedupe-workspace-"),
    );

    try {
      const pluginsDir = path.join(workspace, ".agents", "plugins");
      const checkoutRoot = path.join(pluginsDir, "market", "figma-toolkit");
      await writePlugin(checkoutRoot, "Marketplace Figma Toolkit");

      await fs.mkdir(pluginsDir, { recursive: true });
      const directLink = path.join(pluginsDir, "figma-toolkit");
      await fs.symlink(checkoutRoot, directLink, process.platform === "win32" ? "junction" : "dir");
      await fs.writeFile(
        path.join(pluginsDir, "marketplace.json"),
        `${JSON.stringify(
          {
            name: "workspace-market",
            plugins: [
              {
                name: "figma-toolkit",
                source: {
                  source: "local",
                  path: "./market/figma-toolkit",
                },
                policy: {
                  installation: "manual",
                  authentication: "optional",
                },
                category: "design",
                interface: {
                  displayName: "Marketplace Figma Toolkit",
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const discovery = await discoverPlugins({ workspacePluginsDir: pluginsDir });

      expect(discovery.plugins).toHaveLength(1);
      expect(discovery.plugins[0]).toMatchObject({
        rootDir: checkoutRoot,
        realRootDir: await fs.realpath(checkoutRoot),
        scope: "workspace",
        discoveryKind: "marketplace",
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("preview and install reject explicit missing skills directories", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-missing-skills-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-missing-skills-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-missing-skills-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const sourceRoot = path.join(workspace, "plugin-source", "broken-plugin");
      await fs.mkdir(path.join(sourceRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "broken-plugin",
            description: "Broken plugin",
            skills: "./missing-skills",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(readPluginManifest(sourceRoot)).rejects.toThrow("declares skills path");

      const preview = await previewPluginInstall({
        config,
        input: sourceRoot,
        targetScope: "workspace",
      });
      expect(preview.warnings).toEqual([
        "No valid plugin bundles were found in the provided source.",
      ]);
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

      await expect(
        installPluginsFromSource({
          config,
          input: sourceRoot,
          targetScope: "workspace",
        }),
      ).rejects.toThrow("No valid plugin bundles were found in the provided source");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin catalog surfaces warnings for invalid bundled skills", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-skill-catalog-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-catalog-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-skill-catalog-builtin-"),
    );
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
        catalog.plugins[0]?.warnings.some(
          (warning) => warning.includes("import-frame") && warning.includes("SKILL.md"),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin catalog surfaces warnings for invalid bundled MCP manifests on installed plugins", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-installed-mcp-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-installed-mcp-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-installed-mcp-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "figma-toolkit",
            description: "Broken MCP plugin",
            mcpServers: "./missing.mcp.json",
          },
          null,
          2,
        )}\n`,
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
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-skill-source-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-skill-source-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-skill-source-builtin-"),
    );
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
      expect(preview.warnings).toEqual([
        "No valid plugin bundles were found in the provided source.",
      ]);
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

      await expect(
        installPluginsFromSource({
          config,
          input: sourceRoot,
          targetScope: "workspace",
        }),
      ).rejects.toThrow("No valid plugin bundles were found in the provided source");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin install preview and install reject sources with malformed bundled MCP config", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-mcp-source-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-invalid-mcp-source-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-invalid-mcp-source-builtin-"),
    );
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
      expect(preview.warnings).toEqual([
        "No valid plugin bundles were found in the provided source.",
      ]);
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

      await expect(
        installPluginsFromSource({
          config,
          input: sourceRoot,
          targetScope: "workspace",
        }),
      ).rejects.toThrow("No valid plugin bundles were found in the provided source");
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
      availablePlugins: [],
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

  test("plugin skills embed icon data URIs declared in agents yaml", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-icons-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-icons-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-skill-icons-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      await writePlugin(pluginRoot, "Workspace Figma Toolkit", "Workspace override");
      const skillRoot = path.join(pluginRoot, "skills", "import-frame");
      await fs.mkdir(path.join(skillRoot, "agents"), { recursive: true });
      // 1x1 transparent PNG
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      await fs.writeFile(path.join(skillRoot, "icon.png"), pngBytes);
      await fs.writeFile(
        path.join(skillRoot, "agents", "openai.yaml"),
        [
          "interface:",
          '  display_name: "Import Frame"',
          '  short_description: "Import a Figma frame"',
          '  icon_small: "./icon.png"',
          '  icon_large: "./icon.png"',
        ].join("\n"),
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find((entry) => entry.id === "figma-toolkit");
      const skill = plugin?.skills.find((entry) => entry.rawName === "import-frame");

      expect(skill?.interface?.displayName).toBe("Import Frame");
      expect(skill?.interface?.iconSmall).toStartWith("data:image/png;base64,");
      expect(skill?.interface?.iconLarge).toStartWith("data:image/png;base64,");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin skills skip oversized icons declared in agents yaml", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-skill-icons-large-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-skill-icons-large-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-skill-icons-large-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "figma-toolkit");
      await writePlugin(pluginRoot, "Workspace Figma Toolkit", "Workspace override");
      const skillRoot = path.join(pluginRoot, "skills", "import-frame");
      await fs.mkdir(path.join(skillRoot, "agents"), { recursive: true });
      await fs.writeFile(path.join(skillRoot, "huge.png"), Buffer.alloc(256 * 1024 + 1, 1));
      await fs.writeFile(
        path.join(skillRoot, "agents", "openai.yaml"),
        [
          "interface:",
          '  display_name: "Import Frame"',
          '  short_description: "Import a Figma frame"',
          '  icon_small: "./huge.png"',
          '  icon_large: "./huge.png"',
        ].join("\n"),
        "utf-8",
      );

      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find((entry) => entry.id === "figma-toolkit");
      const skill = plugin?.skills.find((entry) => entry.rawName === "import-frame");

      expect(skill?.interface?.displayName).toBe("Import Frame");
      expect(skill?.interface?.shortDescription).toBe("Import a Figma frame");
      expect(skill?.interface?.iconSmall).toBeUndefined();
      expect(skill?.interface?.iconLarge).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("surfaces warnings for malformed bundled plugin skills", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-malformed-skills-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-malformed-skills-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plugins-malformed-skills-builtin-"),
    );
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

describe("commit-pinned plugin updates", () => {
  const PINNED_COMMIT_SHA = "aa".repeat(20);
  const BRANCH_SOURCE_INPUT = `https://github.com/${BUILT_IN_REPO}/tree/main/plugins/figma-toolkit`;

  type RemotePluginFiles = { pluginJson: string; skillMd: string };

  function remotePluginFiles(description: string): RemotePluginFiles {
    return {
      pluginJson: JSON.stringify({
        name: "figma-toolkit",
        version: "1.0.1",
        description,
        interface: { displayName: "Remote Figma Toolkit" },
      }),
      skillMd: "---\nname: import-frame\ndescription: Import a frame\n---\n# Import frame\n",
    };
  }

  /** Replicates the tree downloadGitHubDirectory materializes, for hashing. */
  async function computeRemotePluginTreeHash(files: RemotePluginFiles): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-hash-"));
    try {
      await fs.mkdir(path.join(dir, ".cowork-plugin"), { recursive: true });
      await fs.mkdir(path.join(dir, "skills", "import-frame"), { recursive: true });
      await fs.writeFile(path.join(dir, ".cowork-plugin", "plugin.json"), files.pluginJson);
      await fs.writeFile(path.join(dir, "skills", "import-frame", "SKILL.md"), files.skillMd);
      return await computeSourceRootHash(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  function marketplaceJsonWithHash(sourceHash: string): string {
    return JSON.stringify({
      name: "cowork-test",
      interface: { displayName: "Cowork Test" },
      plugins: [
        {
          name: "figma-toolkit",
          source: { source: "local", path: "./plugins/figma-toolkit" },
          sourceHash,
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Design",
        },
      ],
    });
  }

  /**
   * Serves the built-in marketplace repo with per-ref content, mimicking how
   * GitHub's per-path caches can expose different commits for a moving branch
   * while SHA-addressed reads stay immutable. `commitShaByRef[ref] = null`
   * simulates a failing commits endpoint.
   */
  function refAwareGitHubFetch(opts: {
    commitShaByRef: Record<string, string | null>;
    pluginFilesByRef: Record<string, RemotePluginFiles>;
    marketplaceJsonByRef: Record<string, string>;
  }): typeof fetch {
    const knownRefs = new Set([
      ...Object.keys(opts.pluginFilesByRef),
      ...Object.keys(opts.marketplaceJsonByRef),
    ]);
    const fileEntry = (name: string, contentPath: string, ref: string, downloadName: string) => ({
      type: "file",
      name,
      path: contentPath,
      url: `https://api.github.com/repos/${BUILT_IN_REPO}/contents/${contentPath}?ref=${ref}`,
      download_url: `https://download.test/${ref}/${downloadName}`,
    });
    const dirEntry = (name: string, contentPath: string, ref: string) => ({
      type: "dir",
      name,
      path: contentPath,
      url: `https://api.github.com/repos/${BUILT_IN_REPO}/contents/${contentPath}?ref=${ref}`,
      download_url: null,
    });

    return (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.hostname === "api.github.com") {
        const commitsMatch = url.pathname.match(
          new RegExp(`^/repos/${BUILT_IN_REPO}/commits/(.+)$`),
        );
        if (commitsMatch) {
          const sha = opts.commitShaByRef[decodeURIComponent(commitsMatch[1] ?? "")];
          if (sha === undefined) return textResponse("not found", 404);
          if (sha === null) return textResponse("commit resolution unavailable", 500);
          return jsonResponse({ sha });
        }

        const contentsMatch = url.pathname.match(
          new RegExp(`^/repos/${BUILT_IN_REPO}/contents/(.*)$`),
        );
        if (!contentsMatch) return textResponse("not found", 404);
        const ref = url.searchParams.get("ref") ?? "";
        if (!knownRefs.has(ref)) return textResponse("not found", 404);
        const contentPath = decodeURIComponent(contentsMatch[1] ?? "").replace(/\/+$/, "");
        switch (contentPath) {
          case "":
            return jsonResponse([]);
          case ".agents/plugins/marketplace.json":
            return jsonResponse(
              fileEntry("marketplace.json", contentPath, ref, "marketplace.json"),
            );
          case "plugins/figma-toolkit":
            return jsonResponse([
              dirEntry(".cowork-plugin", "plugins/figma-toolkit/.cowork-plugin", ref),
              dirEntry("skills", "plugins/figma-toolkit/skills", ref),
            ]);
          case "plugins/figma-toolkit/.cowork-plugin":
            return jsonResponse([
              fileEntry("plugin.json", `${contentPath}/plugin.json`, ref, "plugin.json"),
            ]);
          case "plugins/figma-toolkit/skills":
            return jsonResponse([
              dirEntry("import-frame", "plugins/figma-toolkit/skills/import-frame", ref),
            ]);
          case "plugins/figma-toolkit/skills/import-frame":
            return jsonResponse([
              fileEntry("SKILL.md", `${contentPath}/SKILL.md`, ref, "SKILL.md"),
            ]);
          default:
            return textResponse("not found", 404);
        }
      }

      if (url.hostname === "download.test") {
        const [, ref, downloadName] = url.pathname.split("/");
        if (!ref || !downloadName) return textResponse("not found", 404);
        if (downloadName === "marketplace.json") {
          const manifest = opts.marketplaceJsonByRef[ref];
          return manifest !== undefined ? textResponse(manifest) : textResponse("not found", 404);
        }
        const files = opts.pluginFilesByRef[ref];
        if (!files) return textResponse("not found", 404);
        if (downloadName === "plugin.json") return textResponse(files.pluginJson);
        if (downloadName === "SKILL.md") return textResponse(files.skillMd);
        return textResponse("not found", 404);
      }

      return textResponse("not found", 404);
    }) as typeof fetch;
  }

  async function seedInstalledPlugin(config: AgentConfig): Promise<InstalledPluginCatalogEntry> {
    if (!config.userPluginsDir) throw new Error("Expected user plugin directory");
    const pluginRoot = path.join(config.userPluginsDir, "figma-toolkit");
    await writePlugin(pluginRoot, "Installed Figma Toolkit");
    await writePluginInstallMetadata(pluginRoot, {
      marketplace: {
        name: "cowork-test",
        sourceInput: BRANCH_SOURCE_INPUT,
        sourceHash: OLD_SOURCE_HASH,
      },
    });
    const catalog = await buildPluginCatalogSnapshot(config);
    const plugin = catalog.plugins.find((entry) => entry.id === "figma-toolkit");
    if (!plugin || !plugin.installed) throw new Error("Expected installed figma-toolkit entry");
    return plugin;
  }

  test("update reads plugin files and marketplace manifest from the same pinned commit", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-update-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-update-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-update-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const newFiles = remotePluginFiles("New Figma helpers");
      const newFilesHash = await computeRemotePluginTreeHash(newFiles);
      // The branch still serves the previous commit's view — a stale manifest
      // hash AND stale files — while the commits API already points at the new
      // commit. Only a pinned update can succeed here; unpinned reads would
      // compare the stale manifest hash against whichever files they raced to.
      const fetchImpl = refAwareGitHubFetch({
        commitShaByRef: { main: PINNED_COMMIT_SHA },
        pluginFilesByRef: {
          main: remotePluginFiles("Old Figma helpers"),
          [PINNED_COMMIT_SHA]: newFiles,
        },
        marketplaceJsonByRef: {
          main: marketplaceJsonWithHash(OLD_SOURCE_HASH),
          [PINNED_COMMIT_SHA]: marketplaceJsonWithHash(newFilesHash),
        },
      });

      const installedPlugin = await seedInstalledPlugin(config);

      const updateCheck = await checkPluginInstallationUpdate({
        config,
        plugin: installedPlugin,
        fetchImpl,
      });
      expect(updateCheck).toMatchObject({
        pluginId: "figma-toolkit",
        canUpdate: true,
        latestSourceHash: newFilesHash,
      });

      const result = await updatePluginInstallation({
        config,
        plugin: installedPlugin,
        fetchImpl,
      });
      expect(result.pluginId).toBe("figma-toolkit");

      const pluginRoot = path.join(home, ".agents", "plugins", "figma-toolkit");
      const manifest = await readPluginManifest(pluginRoot);
      expect(manifest.description).toBe("New Figma helpers");
      expect(await computeSourceRootHash(pluginRoot)).toBe(newFilesHash);

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(catalog.plugins.find((entry) => entry.id === "figma-toolkit")).toMatchObject({
        installed: true,
        installSource: BRANCH_SOURCE_INPUT,
        installedSourceHash: newFilesHash,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("update falls back to branch refs when commit resolution fails", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-fallback-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-fallback-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-pin-fallback-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const newFiles = remotePluginFiles("New Figma helpers");
      const newFilesHash = await computeRemotePluginTreeHash(newFiles);
      const fetchImpl = refAwareGitHubFetch({
        commitShaByRef: { main: null },
        pluginFilesByRef: { main: newFiles },
        marketplaceJsonByRef: { main: marketplaceJsonWithHash(newFilesHash) },
      });

      const installedPlugin = await seedInstalledPlugin(config);

      const result = await updatePluginInstallation({
        config,
        plugin: installedPlugin,
        fetchImpl,
      });
      expect(result.pluginId).toBe("figma-toolkit");

      const manifest = await readPluginManifest(
        path.join(home, ".agents", "plugins", "figma-toolkit"),
      );
      expect(manifest.description).toBe("New Figma helpers");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
