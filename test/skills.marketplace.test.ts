import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePluginMarketplace, parseRemotePluginMarketplace } from "../src/plugins/marketplace";
import {
  BUILT_IN_MARKETPLACE_REPO,
  buildRemoteMarketplaceCatalogEntry,
  buildRemoteMarketplaceSkillCatalogEntry,
} from "../src/plugins/remoteMarketplace";
import { writeSkillInstallManifest } from "../src/skills/manifest";
import { getSkillCatalog } from "../src/skills/operations";
import type { AgentConfig } from "../src/types";

const OLD_SOURCE_HASH = `sha256:${"1".repeat(64)}`;
const NEW_SOURCE_HASH = `sha256:${"2".repeat(64)}`;

function makeConfig(workspaceRoot: string, userHome: string, skillsDir: string): AgentConfig {
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
    skillsDirs: [skillsDir],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

async function writeSkill(skillsDir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
    "utf-8",
  );
}

function marketplaceDoc(skillNames: string[]): unknown {
  return {
    name: "cowork-test",
    interface: { displayName: "Cowork Test" },
    plugins: [],
    skills: skillNames.map((name) => ({
      name,
      source: { source: "local", path: `./skills/${name}` },
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Authoring",
    })),
  };
}

// Minimal GitHub fetch that serves only the built-in marketplace.json (contents API + raw download).
function createSkillMarketplaceFetch(doc: unknown): typeof fetch {
  const contents = {
    type: "file",
    name: "marketplace.json",
    path: ".agents/plugins/marketplace.json",
    download_url: "https://download.test/marketplace.json",
  };
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (
      url.startsWith("https://api.github.com/") &&
      url.includes("/contents/.agents/plugins/marketplace.json")
    ) {
      return new Response(JSON.stringify(contents), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://download.test/marketplace.json") {
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const SECOND_MARKETPLACE_REPO = "acme/extra-market";

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

// Serves per-repo marketplace.json docs; a `null` doc fails that repo's fetch.
function createMultiMarketplaceFetch(docsByRepo: Record<string, unknown>): typeof fetch {
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
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function namedMarketplaceDoc(
  name: string,
  skills: Array<{ name: string; sourceHash?: string }>,
): unknown {
  return {
    name,
    interface: { displayName: `${name} Display` },
    plugins: [],
    skills: skills.map((skill) => ({
      name: skill.name,
      source: { source: "local", path: `./skills/${skill.name}` },
      ...(skill.sourceHash ? { sourceHash: skill.sourceHash } : {}),
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Authoring",
    })),
  };
}

function createRawFallbackMarketplaceFetch(doc: unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (
      url.startsWith("https://api.github.com/") &&
      url.includes("/contents/.agents/plugins/marketplace.json")
    ) {
      return new Response("rate limited", { status: 403 });
    }
    if (
      url ===
      "https://raw.githubusercontent.com/mweinbach/cowork-skills-plugins/main/.agents/plugins/marketplace.json"
    ) {
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("skill marketplace", () => {
  test("parseRemotePluginMarketplace builds skill sourceInput URLs alongside plugins", () => {
    const doc = parseRemotePluginMarketplace(
      JSON.stringify({
        name: "cowork-test",
        plugins: [
          {
            name: "workspace-tools",
            source: { source: "local", path: "./plugins/workspace-tools" },
            sourceHash: NEW_SOURCE_HASH,
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity",
          },
        ],
        skills: [
          {
            name: "create-skill",
            source: { source: "local", path: "./skills/create-skill" },
            sourceHash: NEW_SOURCE_HASH,
            policy: { installation: "AVAILABLE", authentication: "NONE" },
            category: "Authoring",
          },
        ],
      }),
      {
        marketplacePath:
          "https://github.com/mweinbach/cowork-skills-plugins/blob/main/.agents/plugins/marketplace.json",
        repo: "mweinbach/cowork-skills-plugins",
        ref: "main",
      },
    );

    expect(doc.plugins).toHaveLength(1);
    expect(doc.skills).toHaveLength(1);
    expect(doc.skills[0]).toMatchObject({
      name: "create-skill",
      sourcePath: "skills/create-skill",
      sourceHash: NEW_SOURCE_HASH,
      sourceInput:
        "https://github.com/mweinbach/cowork-skills-plugins/tree/main/skills/create-skill",
      category: "Authoring",
    });
  });

  test("marketplace entries carry interface icon metadata into catalog entries", () => {
    const doc = parseRemotePluginMarketplace(
      JSON.stringify({
        name: "cowork-test",
        plugins: [
          {
            name: "iconized-plugin",
            source: { source: "local", path: "./plugins/iconized-plugin" },
            policy: { installation: "AVAILABLE", authentication: "NONE" },
            category: "Productivity",
            interface: {
              displayName: "Iconized Plugin",
              logo: "https://example.com/plugin.png",
              brandColor: "#ff6600",
            },
          },
        ],
        skills: [
          {
            name: "iconized-skill",
            source: { source: "local", path: "./skills/iconized-skill" },
            policy: { installation: "AVAILABLE", authentication: "NONE" },
            category: "Authoring",
            interface: {
              displayName: "Iconized Skill",
              icon: "https://example.com/skill.png",
            },
          },
        ],
      }),
      {
        marketplacePath:
          "https://github.com/mweinbach/cowork-skills-plugins/blob/main/.agents/plugins/marketplace.json",
        repo: "mweinbach/cowork-skills-plugins",
        ref: "main",
      },
    );

    expect(doc.plugins[0]).toMatchObject({
      icon: "https://example.com/plugin.png",
      brandColor: "#ff6600",
    });
    expect(doc.skills[0]).toMatchObject({ icon: "https://example.com/skill.png" });

    const pluginEntry = buildRemoteMarketplaceCatalogEntry({
      marketplace: doc,
      plugin: doc.plugins[0] as NonNullable<(typeof doc.plugins)[number]>,
    });
    expect(pluginEntry?.interface?.logo).toBe("https://example.com/plugin.png");
    expect(pluginEntry?.interface?.brandColor).toBe("#ff6600");

    const skillEntry = buildRemoteMarketplaceSkillCatalogEntry({
      marketplace: doc,
      skill: doc.skills[0] as NonNullable<(typeof doc.skills)[number]>,
    });
    expect(skillEntry?.interface?.iconSmall).toBe("https://example.com/skill.png");
    expect(skillEntry?.interface?.iconLarge).toBe("https://example.com/skill.png");
  });

  test("parsePluginMarketplace resolves local skill paths and tolerates a missing skills key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-local-"));
    try {
      await fs.mkdir(path.join(root, "skills", "s1"), { recursive: true });
      const marketplacePath = path.join(root, "marketplace.json");

      const withSkills = parsePluginMarketplace(
        JSON.stringify({
          name: "local",
          plugins: [],
          skills: [
            {
              name: "s1",
              source: { source: "local", path: "./skills/s1" },
              policy: { installation: "AVAILABLE", authentication: "NONE" },
              category: "Authoring",
            },
          ],
        }),
        marketplacePath,
      );
      expect(withSkills.skills).toHaveLength(1);
      expect(withSkills.skills[0]?.sourcePath).toBe(path.join(root, "skills", "s1"));

      // Backward compatibility: a manifest with no `skills` key still parses.
      const withoutSkills = parsePluginMarketplace(
        JSON.stringify({ name: "local", plugins: [] }),
        marketplacePath,
      );
      expect(withoutSkills.skills).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog surfaces marketplace skills and dedups installed ones", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "already-installed", "Already here");
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createSkillMarketplaceFetch(
          marketplaceDoc(["create-skill", "already-installed"]),
        ),
      });

      expect(catalog.remoteMarketplaceFailed).toBeUndefined();
      expect(catalog.availableSkills.map((skill) => skill.id)).toEqual(["create-skill"]);
      expect(catalog.availableSkills[0]).toMatchObject({
        name: "create-skill",
        installed: false,
        enabled: false,
        discoveryKind: "marketplace",
        scope: "user",
        category: "Authoring",
        installSource:
          "https://github.com/mweinbach/cowork-skills-plugins/tree/main/skills/create-skill",
        marketplace: { name: "cowork-test", displayName: "Cowork Test", category: "Authoring" },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog annotates installed marketplace skills with stale hashes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-stale-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-stale-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "create-skill", "Installed");
    await writeSkillInstallManifest({
      skillRoot: path.join(skillsDir, "create-skill"),
      installationId: "installed-create-skill",
      origin: {
        kind: "github",
        repo: "mweinbach/cowork-skills-plugins",
        ref: "main",
        subdir: "skills/create-skill",
        sourceHash: OLD_SOURCE_HASH,
      },
    });
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createSkillMarketplaceFetch({
          name: "cowork-test",
          interface: { displayName: "Cowork Test" },
          plugins: [],
          skills: [
            {
              name: "create-skill",
              source: { source: "local", path: "./skills/create-skill" },
              sourceHash: NEW_SOURCE_HASH,
              policy: { installation: "AVAILABLE", authentication: "NONE" },
              category: "Authoring",
            },
          ],
        }),
      });

      expect(catalog.availableSkills).toEqual([]);
      expect(catalog.installations[0]).toMatchObject({
        name: "create-skill",
        installedSourceHash: OLD_SOURCE_HASH,
        latestSourceHash: NEW_SOURCE_HASH,
        updateAvailable: true,
      });
      expect(catalog.effectiveSkills[0]).toMatchObject({
        installedSourceHash: OLD_SOURCE_HASH,
        latestSourceHash: NEW_SOURCE_HASH,
        updateAvailable: true,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog falls back to raw GitHub marketplace JSON when contents API is rate limited", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-raw-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-raw-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createRawFallbackMarketplaceFetch(marketplaceDoc(["apple-native-transcribe"])),
      });

      expect(catalog.remoteMarketplaceFailed).toBeUndefined();
      expect(catalog.availableSkills.map((skill) => skill.name)).toEqual([
        "apple-native-transcribe",
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog omits availableSkills unless remote marketplace is requested", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-local-only-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-local-only-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config);
      expect(catalog.availableSkills).toEqual([]);
      expect(catalog.remoteMarketplaceFailed).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog aggregates available skills across configured marketplaces", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-multi-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-multi-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createMultiMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: namedMarketplaceDoc("built-in", [{ name: "builtin-skill" }]),
          [SECOND_MARKETPLACE_REPO]: namedMarketplaceDoc("acme-market", [{ name: "acme-skill" }]),
        }),
      });

      expect(catalog.remoteMarketplaceFailed).toBeUndefined();
      expect(catalog.availableSkills.map((skill) => skill.name)).toEqual([
        "builtin-skill",
        "acme-skill",
      ]);
      expect(catalog.availableSkills[1]).toMatchObject({
        installSource: `https://github.com/${SECOND_MARKETPLACE_REPO}/tree/main/skills/acme-skill`,
        marketplace: { name: "acme-market", displayName: "acme-market Display" },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog dedupes same-name available skills with earlier marketplaces winning", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-dedupe-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-dedupe-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createMultiMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: namedMarketplaceDoc("built-in", [{ name: "shared-skill" }]),
          [SECOND_MARKETPLACE_REPO]: namedMarketplaceDoc("acme-market", [{ name: "shared-skill" }]),
        }),
      });

      expect(catalog.availableSkills).toHaveLength(1);
      expect(catalog.availableSkills[0]).toMatchObject({
        name: "shared-skill",
        marketplace: { name: "built-in" },
        installSource: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main/skills/shared-skill`,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog keeps a healthy marketplace's entries when another marketplace fails", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-partial-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-partial-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createMultiMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: null,
          [SECOND_MARKETPLACE_REPO]: namedMarketplaceDoc("acme-market", [{ name: "acme-skill" }]),
        }),
      });

      expect(catalog.remoteMarketplaceFailed).toBe(true);
      expect(catalog.availableSkills.map((skill) => skill.name)).toEqual(["acme-skill"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog annotates updates for installations sourced from a second marketplace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-second-update-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-second-update-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await writeConfiguredMarketplaces(home, [SECOND_MARKETPLACE_REPO]);
    await writeSkill(skillsDir, "acme-skill", "Installed from the second marketplace");
    await writeSkillInstallManifest({
      skillRoot: path.join(skillsDir, "acme-skill"),
      installationId: "installed-acme-skill",
      origin: {
        kind: "github",
        repo: SECOND_MARKETPLACE_REPO,
        ref: "main",
        subdir: "skills/acme-skill",
        sourceHash: OLD_SOURCE_HASH,
      },
    });
    const config = makeConfig(workspace, home, skillsDir);

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: createMultiMarketplaceFetch({
          [BUILT_IN_MARKETPLACE_REPO]: namedMarketplaceDoc("built-in", []),
          [SECOND_MARKETPLACE_REPO]: namedMarketplaceDoc("acme-market", [
            { name: "acme-skill", sourceHash: NEW_SOURCE_HASH },
          ]),
        }),
      });

      expect(catalog.remoteMarketplaceFailed).toBeUndefined();
      expect(catalog.availableSkills).toEqual([]);
      expect(catalog.installations[0]).toMatchObject({
        name: "acme-skill",
        installedSourceHash: OLD_SOURCE_HASH,
        latestSourceHash: NEW_SOURCE_HASH,
        updateAvailable: true,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("getSkillCatalog reports remoteMarketplaceFailed when the fetch fails", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-fail-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-market-fail-home-"));
    const skillsDir = path.join(home, ".cowork", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const config = makeConfig(workspace, home, skillsDir);
    const failingFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    try {
      const catalog = await getSkillCatalog(config, {
        includeRemoteMarketplace: true,
        fetchImpl: failingFetch,
      });
      expect(catalog.remoteMarketplaceFailed).toBe(true);
      expect(catalog.availableSkills).toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
