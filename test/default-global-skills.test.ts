import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPluginCatalogSnapshot } from "../src/plugins/catalog";
import { deletePluginInstallation } from "../src/plugins/operations";
import { setPluginEnabled } from "../src/plugins/overrides";
import {
  type DefaultSkillSpec,
  defaultGlobalSkillsFailureFile,
  __internal as defaultGlobalSkillsInternal,
  defaultGlobalSkillsStateFile,
  ensureDefaultGlobalSkillsInstalled,
  ensureDefaultGlobalSkillsReady,
  shouldBootstrapDefaultGlobalSkills,
} from "../src/skills/defaultGlobalSkills";
import type { AgentConfig } from "../src/types";
import { isInstalledPluginCatalogEntry } from "../src/types";

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
    workspacePluginsDir: path.join(workspaceRoot, ".cowork", "plugins"),
    userPluginsDir: path.join(userHome, ".cowork", "plugins"),
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

function createMarketplaceFixture(
  pluginIds: string[],
  skillsByPlugin: Record<string, string[]> = Object.fromEntries(pluginIds.map((id) => [id, [id]])),
) {
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
    const skillIds = skillsByPlugin[id] ?? [id];
    tree[`plugins/${id}/skills`] = skillIds.map((skillId) => ({
      type: "dir",
      name: skillId,
      path: `plugins/${id}/skills/${skillId}`,
      url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/skills/${skillId}?ref=main`,
      download_url: null,
    }));
    for (const skillId of skillIds) {
      tree[`plugins/${id}/skills/${skillId}`] = [
        {
          type: "file",
          name: "SKILL.md",
          path: `plugins/${id}/skills/${skillId}/SKILL.md`,
          url: `https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/plugins/${id}/skills/${skillId}/SKILL.md?ref=main`,
          download_url: `https://download.test/${id}/${skillId}/SKILL.md`,
        },
      ];
      files[`https://download.test/${id}/${skillId}/SKILL.md`] =
        `---\nname: ${skillId}\ndescription: ${skillId} skill\n---\n${skillId} body\n`;
    }
    files[`https://download.test/${id}/plugin.json`] = JSON.stringify({
      name: id,
      version: "1.0.0",
      description: `${id} plugin`,
      skills: "./skills",
    });
  }
  return { tree, files };
}

async function writeLocalPlugin(rootDir: string, id: string, skillIds = [id]): Promise<void> {
  await fs.mkdir(path.join(rootDir, ".cowork-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, ".cowork-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: id,
        version: "1.0.0",
        description: `${id} plugin`,
        skills: "./skills",
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  for (const skillId of skillIds) {
    await fs.mkdir(path.join(rootDir, "skills", skillId), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "skills", skillId, "SKILL.md"),
      `---\nname: ${skillId}\ndescription: ${skillId} skill\n---\n${skillId} body\n`,
      "utf-8",
    );
  }
}

describe("default global skills bootstrap", () => {
  test("default marketplace plugin bootstrap is enabled unless explicitly disabled", () => {
    expect(shouldBootstrapDefaultGlobalSkills({})).toBe(true);
    expect(shouldBootstrapDefaultGlobalSkills({ COWORK_BOOTSTRAP_DEFAULT_SKILLS: "1" })).toBe(true);
    expect(shouldBootstrapDefaultGlobalSkills({ COWORK_BOOTSTRAP_DEFAULT_SKILLS: "0" })).toBe(
      false,
    );
    expect(
      shouldBootstrapDefaultGlobalSkills({
        COWORK_BOOTSTRAP_DEFAULT_SKILLS: "1",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
      }),
    ).toBe(false);
  });

  test("installs curated marketplace plugins into the user plugin library and records a one-time state file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-home-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }, { id: "beta" }];
    const { tree, files } = createMarketplaceFixture(["alpha", "beta"]);
    const fetchCalls: string[] = [];
    const baseFetch = createGitHubFetchStub(tree, files);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return await baseFetch(input);
    }) as typeof fetch;
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
          path.join(home, ".cowork", "plugins", "alpha", ".cowork-plugin", "plugin.json"),
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
      expect(
        fetchCalls.filter((url) => url.includes(".agents/plugins/marketplace.json")),
      ).toHaveLength(1);
      expect(
        fetchCalls.filter((url) => url === "https://download.test/marketplace.json"),
      ).toHaveLength(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("repairs a missing default marketplace plugin even when bootstrap state exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-once-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "presentations", "spreadsheets"],
    });
    const fetchImpl = createGitHubFetchStub(tree, files);
    const config = makeConfig(workspace, home);

    try {
      await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl,
      });

      await fs.rm(path.join(home, ".cowork", "plugins", "workspace-tools"), {
        recursive: true,
        force: true,
      });

      const second = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl,
      });

      expect(second.status).toBe("installed");
      expect(second.installed).toEqual(["workspace-tools"]);
      await fs.access(path.join(home, ".cowork", "plugins", "workspace-tools"));
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("ready bootstrap cache is scoped by concurrent requested default plugin ids", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-ready-cache-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const { tree, files } = createMarketplaceFixture(["alpha", "beta"]);
    const baseFetch = createGitHubFetchStub(tree, files);
    let releaseAlphaFetch: (() => void) | undefined;
    let markAlphaFetchBlocked: (() => void) | undefined;
    let markBetaFetchStarted: (() => void) | undefined;
    const alphaFetchGate = new Promise<void>((resolve) => {
      releaseAlphaFetch = resolve;
    });
    const alphaFetchBlocked = new Promise<void>((resolve) => {
      markAlphaFetchBlocked = resolve;
    });
    const betaFetchStarted = new Promise<void>((resolve) => {
      markBetaFetchStarted = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://download.test/alpha/plugin.json") {
        markAlphaFetchBlocked?.();
        await alphaFetchGate;
      }
      if (String(input) === "https://download.test/beta/plugin.json") {
        markBetaFetchStarted?.();
      }
      return await baseFetch(input);
    }) as typeof fetch;
    const config = makeConfig(workspace, home);
    const env = { COWORK_BOOTSTRAP_DEFAULT_SKILLS: "1" };

    try {
      const firstPromise = ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: [{ id: "alpha" }],
        fetchImpl,
        env,
      });
      await alphaFetchBlocked;

      const secondPromise = ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: [{ id: "beta" }],
        fetchImpl,
        env,
      });
      // Synchronize on beta's own work starting. A 100ms Promise.race made this
      // correctness check depend on suite load and failed while unrelated
      // synchronous scans held Bun's event loop.
      await betaFetchStarted;
      const second = await secondPromise;
      expect(second?.installed).toEqual(["beta"]);
      releaseAlphaFetch?.();
      const first = await firstPromise;
      expect(first?.installed).toEqual(["alpha"]);
      await fs.access(path.join(home, ".cowork", "plugins", "alpha"));
      await fs.access(path.join(home, ".cowork", "plugins", "beta"));
      expect(
        (
          JSON.parse(await fs.readFile(defaultGlobalSkillsStateFile(home), "utf-8")) as {
            plugins: string[];
          }
        ).plugins,
      ).toEqual(["alpha", "beta"]);
    } finally {
      releaseAlphaFetch?.();
      defaultGlobalSkillsInternal.resetForTests();
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
      await expect(fs.access(path.join(home, ".cowork", "plugins", "beta"))).rejects.toBeDefined();
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
        path.join(home, ".cowork", "plugins", "beta", ".cowork-plugin", "plugin.json"),
      );
      expect(
        (JSON.parse(await fs.readFile(stateFile, "utf-8")) as { plugins: string[] }).plugins,
      ).toEqual(["alpha", "beta"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("installs Workspace Tools as one default plugin with four bundled skills", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-workspace-tools-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "pdf", "presentations", "spreadsheets"],
    });
    const config = makeConfig(workspace, home);

    try {
      const result = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: createGitHubFetchStub(tree, files),
      });

      expect(result.installed).toEqual(["workspace-tools"]);
      const catalog = await buildPluginCatalogSnapshot(config);
      const plugin = catalog.plugins.find(
        (entry) => entry.id === "workspace-tools" && isInstalledPluginCatalogEntry(entry),
      );
      expect(plugin?.skills.map((skill) => skill.rawName).sort()).toEqual([
        "documents",
        "pdf",
        "presentations",
        "spreadsheets",
      ]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("migrates runtime-owned Workspace Tools before removing every legacy productivity skill", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-runtime-migration-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const pluginRoot = path.join(home, ".cowork", "plugins", "workspace-tools");
    const legacySkillNames = ["documents", "pdf", "presentations", "spreadsheets"];
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": legacySkillNames,
    });
    const config = makeConfig(workspace, home);

    try {
      await writeLocalPlugin(pluginRoot, "workspace-tools", ["documents"]);
      await fs.writeFile(
        path.join(pluginRoot, ".cowork-plugin", "install.json"),
        `${JSON.stringify({
          bootstrap: { name: "codex-primary-runtime", pluginId: "workspace-tools" },
        })}\n`,
        "utf-8",
      );
      for (const name of legacySkillNames) {
        const skillRoot = path.join(home, ".cowork", "skills", name);
        await fs.mkdir(skillRoot, { recursive: true });
        await fs.writeFile(path.join(skillRoot, "legacy.txt"), "legacy\n", "utf-8");
        await fs.writeFile(
          path.join(skillRoot, ".cowork-skill.json"),
          `${JSON.stringify({
            version: 1,
            installationId: `bootstrap-codex-primary-runtime-${name}`,
            origin: { kind: "bootstrap" },
          })}\n`,
          "utf-8",
        );
      }

      const failed = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env: {},
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      });

      expect(failed).toBeNull();
      await fs.access(path.join(pluginRoot, ".cowork-plugin", "plugin.json"));
      for (const name of legacySkillNames) {
        await fs.access(path.join(home, ".cowork", "skills", name, "legacy.txt"));
      }

      // Age the recorded failure past the retry backoff so the next attempt proceeds.
      await fs.writeFile(
        defaultGlobalSkillsFailureFile(home),
        `${JSON.stringify({
          version: 1,
          failedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
          message: "offline",
        })}\n`,
        "utf-8",
      );

      const migrated = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env: {},
        fetchImpl: createGitHubFetchStub(tree, files),
      });

      expect(migrated?.installed).toEqual(["workspace-tools"]);
      const installMetadata = JSON.parse(
        await fs.readFile(path.join(pluginRoot, ".cowork-plugin", "install.json"), "utf-8"),
      ) as { marketplace?: { name?: string }; bootstrap?: unknown };
      expect(installMetadata.marketplace?.name).toBe("test-marketplace");
      expect(installMetadata.bootstrap).toBeUndefined();
      for (const name of legacySkillNames) {
        await expect(fs.stat(path.join(home, ".cowork", "skills", name))).rejects.toThrow();
        await fs.access(path.join(pluginRoot, "skills", name, "SKILL.md"));
      }
    } finally {
      defaultGlobalSkillsInternal.resetForTests();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("skips locally installed defaults without fetching when the state file is stale", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-local-skip-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "presentations", "spreadsheets"],
    });
    const config = makeConfig(workspace, home);

    try {
      await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: createGitHubFetchStub(tree, files),
      });
      await fs.rm(defaultGlobalSkillsStateFile(home), { force: true });

      let fetchCalls = 0;
      const second = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("default bootstrap should not fetch for local skips");
        }) as typeof fetch,
      });

      expect(second.installed).toEqual([]);
      expect(second.skippedExisting).toEqual(["workspace-tools"]);
      expect(fetchCalls).toBe(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("workspace plugins do not satisfy the default global plugin bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-user-scope-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-workspace-scope-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "presentations", "spreadsheets"],
    });
    const config = makeConfig(workspace, home);

    try {
      await writeLocalPlugin(
        path.join(workspace, ".cowork", "plugins", "workspace-tools"),
        "workspace-tools",
        ["documents"],
      );

      const result = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: createGitHubFetchStub(tree, files),
      });

      expect(result.installed).toEqual(["workspace-tools"]);
      expect(result.skippedExisting).toEqual([]);
      await fs.access(path.join(home, ".cowork", "plugins", "workspace-tools"));

      const catalog = await buildPluginCatalogSnapshot(config);
      expect(
        catalog.plugins
          .filter(
            (plugin) => plugin.id === "workspace-tools" && isInstalledPluginCatalogEntry(plugin),
          )
          .map((plugin) => plugin.scope),
      ).toEqual(["workspace", "user"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("legacy default plugin tombstones suppress Workspace Tools bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-legacy-tombstone-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "presentations", "spreadsheets"],
    });
    const fetchImpl = createGitHubFetchStub(tree, files);
    const config = makeConfig(workspace, home);

    try {
      await fs.mkdir(path.join(home, ".cowork", "config"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".cowork", "config", "plugins.json"),
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
            plugins: {
              documents: false,
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const result = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: (async () => {
          throw new Error("default bootstrap should not fetch for tombstones");
        }) as typeof fetch,
      });

      expect(result.installed).toEqual([]);
      expect(result.skippedRemoved).toEqual(["workspace-tools"]);
      await expect(
        fs.access(path.join(home, ".cowork", "plugins", "workspace-tools")),
      ).rejects.toBeDefined();

      const marketplaceCatalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl,
      });
      expect(marketplaceCatalog.plugins).toHaveLength(0);
      expect(marketplaceCatalog.availablePlugins).toHaveLength(1);
      expect(marketplaceCatalog.availablePlugins[0]).toMatchObject({
        id: "workspace-tools",
        installed: false,
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("disabled default plugins are not treated as uninstall tombstones", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-disabled-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "presentations", "spreadsheets"],
    });
    const config = makeConfig(workspace, home);

    try {
      await setPluginEnabled({
        config,
        pluginId: "workspace-tools",
        scope: "user",
        enabled: false,
      });

      const result = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: createGitHubFetchStub(tree, files),
      });

      expect(result.installed).toEqual(["workspace-tools"]);
      expect(result.skippedRemoved).toEqual([]);
      const overrides = JSON.parse(
        await fs.readFile(path.join(home, ".cowork", "config", "plugins.json"), "utf-8"),
      ) as {
        plugins?: Record<string, boolean>;
        removedDefaultPlugins?: Record<string, boolean>;
      };
      expect(overrides.plugins?.["workspace-tools"]).toBe(false);
      expect(overrides.removedDefaultPlugins?.["workspace-tools"]).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("bootstrap failure writes a failure file and skips network retries within the backoff window", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-failure-backoff-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }];
    const config = makeConfig(workspace, home);
    const env = {};

    try {
      let failingFetchCalls = 0;
      const failed = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env,
        fetchImpl: (async () => {
          failingFetchCalls += 1;
          throw new Error("rate limited");
        }) as typeof fetch,
      });

      expect(failed).toBeNull();
      expect(failingFetchCalls).toBeGreaterThan(0);
      const failureFile = defaultGlobalSkillsFailureFile(home);
      const failureState = JSON.parse(await fs.readFile(failureFile, "utf-8")) as {
        version: number;
        failedAt: string;
        message: string;
      };
      expect(failureState.version).toBe(1);
      expect(failureState.message).toContain("rate limited");
      expect(Number.isFinite(Date.parse(failureState.failedAt))).toBe(true);

      defaultGlobalSkillsInternal.resetForTests();

      let retryFetchCalls = 0;
      const logs: string[] = [];
      const skipped = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env,
        log: (line) => logs.push(line),
        fetchImpl: (async () => {
          retryFetchCalls += 1;
          throw new Error("backoff should prevent network fetches");
        }) as typeof fetch,
      });

      expect(retryFetchCalls).toBe(0);
      expect(skipped?.status).toBe("already_installed");
      expect(skipped?.installed).toEqual([]);
      expect(logs.some((line) => line.includes("Default skill bootstrap skipped"))).toBe(true);
      await fs.access(failureFile);
    } finally {
      defaultGlobalSkillsInternal.resetForTests();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("force bypasses the bootstrap failure backoff and success clears the failure file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-failure-force-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }];
    const config = makeConfig(workspace, home);
    const failureFile = defaultGlobalSkillsFailureFile(home);
    const { tree, files } = createMarketplaceFixture(["alpha"]);
    const fetchCalls: string[] = [];
    const baseFetch = createGitHubFetchStub(tree, files);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return await baseFetch(input);
    }) as typeof fetch;

    try {
      await fs.mkdir(path.dirname(failureFile), { recursive: true });
      await fs.writeFile(
        failureFile,
        `${JSON.stringify({
          version: 1,
          failedAt: new Date().toISOString(),
          message: "rate limited",
        })}\n`,
        "utf-8",
      );

      const result = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env: {},
        force: true,
        fetchImpl,
      });

      expect(result?.status).toBe("installed");
      expect(result?.installed).toEqual(["alpha"]);
      expect(fetchCalls.length).toBeGreaterThan(0);
      await expect(fs.access(failureFile)).rejects.toBeDefined();
    } finally {
      defaultGlobalSkillsInternal.resetForTests();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("retries after the backoff window and keeps the state-file fast path unaffected", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-failure-expiry-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "alpha" }];
    const config = makeConfig(workspace, home);
    const failureFile = defaultGlobalSkillsFailureFile(home);
    const { tree, files } = createMarketplaceFixture(["alpha"]);
    const writeFailureFile = async (failedAt: string) => {
      await fs.mkdir(path.dirname(failureFile), { recursive: true });
      await fs.writeFile(
        failureFile,
        `${JSON.stringify({ version: 1, failedAt, message: "rate limited" })}\n`,
        "utf-8",
      );
    };

    try {
      await writeFailureFile(new Date(Date.now() - 31 * 60 * 1000).toISOString());

      const retried = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env: {},
        fetchImpl: createGitHubFetchStub(tree, files),
      });

      expect(retried?.status).toBe("installed");
      expect(retried?.installed).toEqual(["alpha"]);
      await expect(fs.access(failureFile)).rejects.toBeDefined();

      defaultGlobalSkillsInternal.resetForTests();
      await writeFailureFile(new Date().toISOString());

      let fastPathFetchCalls = 0;
      const fastPath = await ensureDefaultGlobalSkillsReady({
        homedir: home,
        config,
        plugins: skills,
        env: {},
        fetchImpl: (async () => {
          fastPathFetchCalls += 1;
          throw new Error("fast path should not fetch");
        }) as typeof fetch,
      });

      expect(fastPathFetchCalls).toBe(0);
      expect(fastPath?.status).toBe("already_installed");
      expect(fastPath?.skippedExisting).toEqual(["alpha"]);
      await expect(fs.access(failureFile)).rejects.toBeDefined();
    } finally {
      defaultGlobalSkillsInternal.resetForTests();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not reinstall default plugins after the user uninstalls them", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-uninstall-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-workspace-"));
    const skills: readonly DefaultSkillSpec[] = [{ id: "workspace-tools" }];
    const { tree, files } = createMarketplaceFixture(["workspace-tools"], {
      "workspace-tools": ["documents", "presentations", "spreadsheets"],
    });
    const fetchImpl = createGitHubFetchStub(tree, files);
    const config = makeConfig(workspace, home);

    try {
      await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl,
      });

      const installedCatalog = await buildPluginCatalogSnapshot(config, { fetchImpl });
      const installedPlugin = installedCatalog.plugins.find(
        (plugin) => plugin.id === "workspace-tools" && isInstalledPluginCatalogEntry(plugin),
      );
      if (!installedPlugin) {
        throw new Error("expected workspace-tools to be installed before uninstall");
      }

      await deletePluginInstallation({ config, plugin: installedPlugin });

      let fetchCalls = 0;
      const second = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        config,
        plugins: skills,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("default bootstrap should not fetch for deleted defaults");
        }) as typeof fetch,
      });

      expect(second.installed).toEqual([]);
      expect(second.skippedRemoved).toEqual(["workspace-tools"]);
      expect(fetchCalls).toBe(0);
      expect(
        (
          JSON.parse(await fs.readFile(defaultGlobalSkillsStateFile(home), "utf-8")) as {
            plugins: string[];
          }
        ).plugins,
      ).toEqual([]);
      await expect(
        fs.access(path.join(home, ".cowork", "plugins", "workspace-tools")),
      ).rejects.toBeDefined();
      const overrides = JSON.parse(
        await fs.readFile(path.join(home, ".cowork", "config", "plugins.json"), "utf-8"),
      ) as {
        plugins?: Record<string, boolean>;
        removedDefaultPlugins?: Record<string, boolean>;
      };
      expect(overrides.plugins?.["workspace-tools"]).toBeUndefined();
      expect(overrides.removedDefaultPlugins?.["workspace-tools"]).toBe(true);

      const marketplaceCatalog = await buildPluginCatalogSnapshot(config, {
        includeRemoteMarketplace: true,
        fetchImpl,
      });
      expect(marketplaceCatalog.plugins).toHaveLength(0);
      expect(marketplaceCatalog.availablePlugins).toHaveLength(1);
      expect(marketplaceCatalog.availablePlugins[0]).toMatchObject({
        id: "workspace-tools",
        installed: false,
        installSource:
          "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/workspace-tools",
      });
      expect(marketplaceCatalog.availablePlugins[0]).not.toHaveProperty("rootDir");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
