import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePluginInstallMetadata } from "../src/plugins/manifest";
import { buildMarketplaceDetail } from "../src/plugins/marketplaceDetail";
import { BUILT_IN_MARKETPLACE_REPO } from "../src/plugins/remoteMarketplace";
import { writeSkillInstallManifest } from "../src/skills/manifest";
import type { AgentConfig } from "../src/types";

const BUILT_IN_ID = BUILT_IN_MARKETPLACE_REPO.toLowerCase();
const SECOND_MARKETPLACE_REPO = "acme/extra-market";

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
    workspacePluginsDir: path.join(workspaceRoot, ".agents", "plugins"),
    userPluginsDir: path.join(userHome, ".agents", "plugins"),
    builtInDir: path.join(workspaceRoot, "builtin"),
    builtInConfigDir: path.join(workspaceRoot, "builtin", "config"),
    skillsDirs: [path.join(userHome, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

async function writePlugin(rootDir: string, pluginId: string, displayName: string) {
  await fs.mkdir(path.join(rootDir, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "skills", "import-frame"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: pluginId, description: "Plugin helpers", interface: { displayName } }, null, 2)}\n`,
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
      { mcpServers: { figma: { type: "http", url: "https://figma.example.com" } } },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function writeSkill(skillsDir: string, name: string) {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, "SKILL.md"),
    ["---", `name: ${name}`, `description: A ${name} skill`, "---", "", `# ${name}`].join("\n"),
    "utf-8",
  );
}

function marketplaceDoc(opts: {
  name: string;
  displayName?: string;
  pluginNames?: string[];
  skillNames?: string[];
}): unknown {
  return {
    name: opts.name,
    interface: { displayName: opts.displayName ?? `${opts.name} Display` },
    plugins: (opts.pluginNames ?? []).map((pluginName) => ({
      name: pluginName,
      source: { source: "local", path: `./plugins/${pluginName}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Design",
      interface: { displayName: `${pluginName} Pretty`, logo: `https://icons.test/${pluginName}` },
    })),
    skills: (opts.skillNames ?? []).map((skillName) => ({
      name: skillName,
      source: { source: "local", path: `./skills/${skillName}` },
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Authoring",
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
          return new Response("boom", { status: 500 });
        }
        return new Response(
          JSON.stringify({
            type: "file",
            name: "marketplace.json",
            path: ".agents/plugins/marketplace.json",
            download_url: `https://download.test/${repo}/marketplace.json`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `https://download.test/${repo}/marketplace.json` && doc !== null) {
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    // Raw fallback must also fail for failing repos.
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function withTempDirs<T>(run: (workspace: string, home: string) => Promise<T>): Promise<T> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "marketplace-detail-ws-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "marketplace-detail-home-"));
  try {
    return await run(workspace, home);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("buildMarketplaceDetail", () => {
  test("assembles plugins, skills, and connectors with installed-state annotations", async () => {
    await withTempDirs(async (workspace, home) => {
      const config = makeConfig(workspace, home);
      const skillsDir = path.join(home, ".cowork", "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      // Installed plugin whose install metadata records this marketplace.
      const pluginRoot = path.join(home, ".agents", "plugins", "figma-toolkit");
      await writePlugin(pluginRoot, "figma-toolkit", "Figma Toolkit");
      await writePluginInstallMetadata(pluginRoot, {
        marketplace: {
          name: "cowork-test",
          sourceInput: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/plugins/figma-toolkit`,
        },
      });

      // Installed standalone skill matched by origin repo + name.
      await writeSkill(skillsDir, "create-skill");
      await writeSkillInstallManifest({
        skillRoot: path.join(skillsDir, "create-skill"),
        installationId: "installed-create-skill",
        origin: {
          kind: "github",
          repo: BUILT_IN_MARKETPLACE_REPO,
          ref: "main",
          subdir: "skills/create-skill",
        },
      });

      const detail = await buildMarketplaceDetail({
        config,
        id: BUILT_IN_ID,
        fetchImpl: createMultiRepoMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc({
            name: "cowork-test",
            displayName: "Cowork Test",
            pluginNames: ["figma-toolkit", "missing-toolkit"],
            skillNames: ["create-skill", "absent-skill"],
          }),
        }),
      });

      expect(detail.source).toMatchObject({
        id: BUILT_IN_ID,
        repo: BUILT_IN_MARKETPLACE_REPO,
        ref: "main",
        builtIn: true,
        displayName: "Cowork Test",
        pluginCount: 2,
        skillCount: 2,
      });

      expect(detail.plugins).toHaveLength(2);
      expect(detail.plugins[0]).toMatchObject({
        name: "figma-toolkit",
        displayName: "figma-toolkit Pretty",
        category: "Design",
        icon: "https://icons.test/figma-toolkit",
        installed: true,
        enabled: true,
        skills: ["import-frame"],
        mcpServers: ["figma"],
      });
      expect(detail.plugins[0]?.installSource).toBeUndefined();
      expect(detail.plugins[1]).toMatchObject({
        name: "missing-toolkit",
        displayName: "missing-toolkit Pretty",
        installed: false,
        installSource: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/plugins/missing-toolkit`,
        skills: [],
        mcpServers: [],
      });
      expect(detail.plugins[1]?.enabled).toBeUndefined();

      expect(detail.skills).toHaveLength(2);
      expect(detail.skills[0]).toMatchObject({
        name: "create-skill",
        displayName: "create-skill",
        category: "Authoring",
        installed: true,
        enabled: true,
      });
      expect(detail.skills[0]?.installSource).toBeUndefined();
      expect(detail.skills[1]).toMatchObject({
        name: "absent-skill",
        installed: false,
        installSource: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/skills/absent-skill`,
      });

      expect(detail.connectors).toEqual([
        {
          name: "figma",
          pluginName: "figma-toolkit",
          pluginDisplayName: "Figma Toolkit",
          installed: true,
        },
      ]);
    });
  });

  test("does not mark same-id plugins or same-name skills from other sources as installed", async () => {
    await withTempDirs(async (workspace, home) => {
      const config = makeConfig(workspace, home);
      const skillsDir = path.join(home, ".cowork", "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      // A direct (non-marketplace) install sharing the plugin id.
      await writePlugin(
        path.join(home, ".agents", "plugins", "figma-toolkit"),
        "figma-toolkit",
        "Direct Figma Toolkit",
      );

      // A same-name skill installed from a different repo.
      await writeSkill(skillsDir, "create-skill");
      await writeSkillInstallManifest({
        skillRoot: path.join(skillsDir, "create-skill"),
        installationId: "installed-create-skill",
        origin: {
          kind: "github",
          repo: "someone/else",
          ref: "main",
          subdir: "skills/create-skill",
        },
      });

      const detail = await buildMarketplaceDetail({
        config,
        id: BUILT_IN_ID,
        fetchImpl: createMultiRepoMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc({
            name: "cowork-test",
            pluginNames: ["figma-toolkit"],
            skillNames: ["create-skill"],
          }),
        }),
      });

      expect(detail.plugins[0]).toMatchObject({
        name: "figma-toolkit",
        installed: false,
        installSource: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/plugins/figma-toolkit`,
      });
      expect(detail.skills[0]).toMatchObject({
        name: "create-skill",
        installed: false,
        installSource: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/skills/create-skill`,
      });
      expect(detail.connectors).toEqual([]);
    });
  });

  test("falls back to matching the recorded install source when origin has no repo", async () => {
    await withTempDirs(async (workspace, home) => {
      const config = makeConfig(workspace, home);
      const skillsDir = path.join(home, ".cowork", "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      await writeSkill(skillsDir, "create-skill");
      await writeSkillInstallManifest({
        skillRoot: path.join(skillsDir, "create-skill"),
        installationId: "installed-create-skill",
        origin: {
          kind: "github",
          // Trailing slash exercises install-source normalization.
          url: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/skills/create-skill/`,
        },
      });

      const detail = await buildMarketplaceDetail({
        config,
        id: BUILT_IN_ID,
        fetchImpl: createMultiRepoMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc({
            name: "cowork-test",
            skillNames: ["create-skill"],
          }),
        }),
      });

      expect(detail.skills[0]).toMatchObject({
        name: "create-skill",
        installed: true,
        enabled: true,
      });
    });
  });

  test("resolves user-added marketplaces by id", async () => {
    await withTempDirs(async (workspace, home) => {
      const config = makeConfig(workspace, home);
      const configDir = path.join(home, ".cowork", "config");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "marketplaces.json"),
        `${JSON.stringify({
          version: 1,
          marketplaces: [
            {
              repo: SECOND_MARKETPLACE_REPO,
              ref: "main",
              marketplacePath: ".agents/plugins/marketplace.json",
              addedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        })}\n`,
        "utf-8",
      );

      const detail = await buildMarketplaceDetail({
        config,
        id: SECOND_MARKETPLACE_REPO.toUpperCase(),
        fetchImpl: createMultiRepoMarketplaceFetch({
          [SECOND_MARKETPLACE_REPO]: marketplaceDoc({
            name: "acme-market",
            skillNames: ["acme-skill"],
          }),
        }),
      });

      expect(detail.source).toMatchObject({
        id: SECOND_MARKETPLACE_REPO,
        builtIn: false,
        displayName: "acme-market Display",
        addedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(detail.skills.map((skill) => skill.name)).toEqual(["acme-skill"]);
    });
  });

  test("throws for unknown marketplace ids", async () => {
    await withTempDirs(async (workspace, home) => {
      const config = makeConfig(workspace, home);
      await expect(
        buildMarketplaceDetail({
          config,
          id: "acme/unknown",
          fetchImpl: createMultiRepoMarketplaceFetch({}),
        }),
      ).rejects.toThrow('Marketplace "acme/unknown" is not configured.');
    });
  });

  test("throws when the manifest fetch fails", async () => {
    await withTempDirs(async (workspace, home) => {
      const config = makeConfig(workspace, home);
      await expect(
        buildMarketplaceDetail({
          config,
          id: BUILT_IN_ID,
          fetchImpl: createMultiRepoMarketplaceFetch({ [BUILT_IN_MARKETPLACE_REPO]: null }),
        }),
      ).rejects.toThrow("Failed to fetch");
    });
  });
});
