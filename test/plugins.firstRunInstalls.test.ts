import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearPluginUninstallTombstone,
  ensureFirstRunPluginsInstalled,
  firstRunInstallStateFile,
  recordPluginUninstallTombstone,
} from "../src/plugins/firstRunInstalls";
import type { AgentConfig } from "../src/types";

function makeConfig(homeDir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".cowork"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    workspaceAgentsDir: path.join(homeDir, ".agents"),
    userAgentsDir: path.join(homeDir, ".agents"),
    workspacePluginsDir: path.join(homeDir, ".agents", "plugins"),
    userPluginsDir: path.join(homeDir, ".cowork", "agents", "plugins"),
    builtInDir: path.join(homeDir, "builtin"),
    builtInConfigDir: path.join(homeDir, "builtin", "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

describe("firstRunInstalls", () => {
  let tmpDir: string;
  const originalEnv = process.env.COWORK_SKIP_FIRST_RUN_INSTALLS;
  const originalLegacyEnv = process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-first-run-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.COWORK_SKIP_FIRST_RUN_INSTALLS;
    } else {
      process.env.COWORK_SKIP_FIRST_RUN_INSTALLS = originalEnv;
    }
    if (originalLegacyEnv === undefined) {
      delete process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP;
    } else {
      process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP = originalLegacyEnv;
    }
  });

  test("skips when COWORK_SKIP_FIRST_RUN_INSTALLS is set", async () => {
    const config = makeConfig(tmpDir);
    const result = await ensureFirstRunPluginsInstalled({
      config,
      homedir: tmpDir,
      env: { COWORK_SKIP_FIRST_RUN_INSTALLS: "1" },
    });
    expect(result).toBeNull();
  });

  test("skips when the legacy bootstrap env var is set", async () => {
    const config = makeConfig(tmpDir);
    const result = await ensureFirstRunPluginsInstalled({
      config,
      homedir: tmpDir,
      env: { COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1" },
    });
    expect(result).toBeNull();
  });

  test("respects an existing tombstone for a removed plugin", async () => {
    const config = makeConfig(tmpDir);
    await recordPluginUninstallTombstone({
      homedir: tmpDir,
      marketplaceId: "cowork-personal",
      pluginName: "documents",
    });

    const result = await ensureFirstRunPluginsInstalled({
      config,
      homedir: tmpDir,
      env: {},
      specs: [{ marketplaceId: "cowork-personal", pluginName: "documents" }],
      marketplaces: [],
    });

    expect(result).not.toBeNull();
    expect(result?.installed).toEqual([]);
    expect(result?.removedTombstoned).toContain("cowork-personal:documents");
  });

  test("records and clears tombstone entries", async () => {
    await recordPluginUninstallTombstone({
      homedir: tmpDir,
      marketplaceId: "cowork-personal",
      pluginName: "spreadsheets",
    });

    const stateFile = firstRunInstallStateFile(tmpDir);
    const after = JSON.parse(await fs.readFile(stateFile, "utf-8")) as {
      removed: string[];
    };
    expect(after.removed).toContain("cowork-personal:spreadsheets");

    await clearPluginUninstallTombstone({
      homedir: tmpDir,
      marketplaceId: "cowork-personal",
      pluginName: "spreadsheets",
    });
    const cleared = JSON.parse(await fs.readFile(stateFile, "utf-8")) as {
      removed: string[];
    };
    expect(cleared.removed).not.toContain("cowork-personal:spreadsheets");
  });

  test("reports an error when the requested plugin is not in any provided marketplace", async () => {
    const config = makeConfig(tmpDir);
    const result = await ensureFirstRunPluginsInstalled({
      config,
      homedir: tmpDir,
      env: {},
      specs: [{ marketplaceId: "made-up", pluginName: "nope" }],
      marketplaces: [],
    });
    expect(result?.errors[0]?.error).toContain("not found in marketplace");
  });
});
