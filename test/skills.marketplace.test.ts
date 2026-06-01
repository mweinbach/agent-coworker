import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePluginMarketplace, parseRemotePluginMarketplace } from "../src/plugins/marketplace";
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
