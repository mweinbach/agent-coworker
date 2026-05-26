import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type DefaultSkillSpec,
  defaultGlobalSkillsStateFile,
  ensureDefaultGlobalSkillsInstalled,
} from "../src/skills/defaultGlobalSkills";
import type { AgentConfig } from "../src/types";

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

function createGitHubFetchStub(
  tree: Record<string, unknown>,
  files: Record<string, string>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.startsWith("https://api.github.com/")) {
      const key = Object.keys(tree)
        .sort((a, b) => b.length - a.length)
        .find((candidate) => url.includes(`/contents/${candidate}`));
      if (!key) return textResponse("not found", 404);
      return jsonResponse(tree[key]);
    }

    const file = files[url];
    if (file !== undefined) {
      return textResponse(file);
    }

    return textResponse("not found", 404);
  }) as typeof fetch;
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
    workspacePluginsDir: path.join(workspaceRoot, ".agents", "plugins"),
    userPluginsDir: path.join(userHome, ".agents", "plugins"),
    builtInDir: workspaceRoot,
    builtInConfigDir: path.join(workspaceRoot, "config"),
    skillsDirs: [
      path.join(workspaceRoot, ".cowork", "skills"),
      path.join(userHome, ".cowork", "skills"),
    ],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

function createMarketplaceFixture(pluginIds: string[]) {
  const marketplace = {
    name: "test-marketplace",
    interface: { displayName: "Test Marketplace" },
    plugins: pluginIds.map((id) => ({
      name: id,
      source: { source: "local", path: `./plugins/${id}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    })),
  };
  const tree: Record<string, unknown> = {
    ".agents/plugins/marketplace.json": {
      type: "file",
      name: "marketplace.json",
      path: ".agents/plugins/marketplace.json",
      url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/.agents/plugins/marketplace.json?ref=main",
      download_url: "https://download.test/marketplace.json",
    },
  };
  const files: Record<string, string> = {
    "https://download.test/marketplace.json": JSON.stringify(marketplace),
  };
  for (const id of pluginIds) {
    tree[`plugins/${id}`] = [
      {
        type: "dir",
        name: ".cowork-plugin",
        path: `plugins/${id}/.cowork-plugin`,
        url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/.cowork-plugin?ref=main`,
        download_url: null,
      },
      {
        type: "dir",
        name: "skills",
        path: `plugins/${id}/skills`,
        url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/skills?ref=main`,
        download_url: null,
      },
    ];
    tree[`plugins/${id}/.cowork-plugin`] = [
      {
        type: "file",
        name: "plugin.json",
        path: `plugins/${id}/.cowork-plugin/plugin.json`,
        url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/.cowork-plugin/plugin.json?ref=main`,
        download_url: `https://download.test/${id}/plugin.json`,
      },
    ];
    tree[`plugins/${id}/skills`] = [
      {
        type: "dir",
        name: id,
        path: `plugins/${id}/skills/${id}`,
        url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/skills/${id}?ref=main`,
        download_url: null,
      },
    ];
    tree[`plugins/${id}/skills/${id}`] = [
      {
        type: "file",
        name: "SKILL.md",
        path: `plugins/${id}/skills/${id}/SKILL.md`,
        url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/skills/${id}/SKILL.md?ref=main`,
        download_url: `https://download.test/${id}/SKILL.md`,
      },
    ];
    files[`https://download.test/${id}/plugin.json`] = JSON.stringify({
      name: id,
      version: "1.0.0",
      description: `${id} plugin`,
      skills: "./skills",
    });
    files[`https://download.test/${id}/SKILL.md`] =
      `---\nname: ${id}\ndescription: ${id} skill\n---\n${id} body\n`;
  }
  return { tree, files };
}

describe("default global skills bootstrap", () => {
  test("installs curated marketplace plugins into the user plugin library and records a one-time state file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-home-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }, { id: "beta" }];
    const { tree, files } = createMarketplaceFixture(["alpha", "beta"]);
    const fetchImpl = createGitHubFetchStub(tree, files);
    const config = makeConfig(workspace, home);

    try {
      const result = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl,
      });

      expect(result.status).toBe("installed");
      expect(result.installed).toEqual(["alpha", "beta"]);
      expect(
        await fs.readFile(
          path.join(home, ".agents", "plugins", "alpha", ".cowork-plugin", "plugin.json"),
          "utf-8",
        ),
      ).toContain('"name":"alpha"');

      const stateFile = defaultGlobalSkillsStateFile(home);
      const state = JSON.parse(await fs.readFile(stateFile, "utf-8")) as {
        marketplace: string;
        plugins: string[];
      };
      expect(state.marketplace).toBe("mweinbach/cowork-skills-plugins");
      expect(state.plugins).toEqual(["alpha", "beta"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not reinstall on later runs once the bootstrap state file exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-once-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }];
    const { tree, files } = createMarketplaceFixture(["alpha"]);
    const fetchImpl = createGitHubFetchStub(tree, files);
    const config = makeConfig(workspace, home);

    try {
      await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl,
      });

      await fs.rm(path.join(home, ".agents", "plugins", "alpha"), {
        recursive: true,
        force: true,
      });

      const second = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: (async () => {
          throw new Error("should not fetch after one-time bootstrap");
        }) as typeof fetch,
      });

      expect(second.status).toBe("already_installed");
      await expect(fs.access(path.join(home, ".agents", "plugins", "alpha"))).rejects.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not record unavailable default marketplace plugins as complete", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-missing-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }, { id: "beta" }];
    const initialFixture = createMarketplaceFixture(["alpha"]);
    const config = makeConfig(workspace, home);

    try {
      const first = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: createGitHubFetchStub(initialFixture.tree, initialFixture.files),
      });

      expect(first.installed).toEqual(["alpha"]);
      const stateFile = defaultGlobalSkillsStateFile(home);
      await expect(fs.access(path.join(home, ".agents", "plugins", "beta"))).rejects.toBeDefined();
      expect(
        (JSON.parse(await fs.readFile(stateFile, "utf-8")) as { plugins: string[] }).plugins,
      ).toEqual(["alpha"]);

      const retryFixture = createMarketplaceFixture(["alpha", "beta"]);
      const second = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: createGitHubFetchStub(retryFixture.tree, retryFixture.files),
      });

      expect(second.installed).toEqual(["beta"]);
      await fs.access(
        path.join(home, ".agents", "plugins", "beta", ".cowork-plugin", "plugin.json"),
      );
      expect(
        (JSON.parse(await fs.readFile(stateFile, "utf-8")) as { plugins: string[] }).plugins,
      ).toEqual(["alpha", "beta"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
