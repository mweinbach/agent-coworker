import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal, ensureCodexPrimaryRuntimeReady } from "../src/codexPrimaryRuntime";
import { readPluginInstallMetadata } from "../src/plugins/manifest";
import { __internal as pluginOperationsInternal } from "../src/plugins/operations";
import { writeSkillInstallManifest } from "../src/skills/manifest";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(payload: Uint8Array): Response {
  return new Response(payload, { status: 200 });
}

async function writeFakeOaiNamespace(home: string): Promise<string> {
  const source = path.join(
    home,
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "node",
    "node_modules",
    "@oai",
  );
  await fs.mkdir(path.join(source, "artifact-tool"), { recursive: true });
  await fs.writeFile(
    path.join(source, "artifact-tool", "package.json"),
    JSON.stringify({ name: "@oai/artifact-tool" }),
    "utf-8",
  );
  return source;
}

function executableBasename(name: "node" | "python"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function writeFakeCuratedArchive(destinationDir: string): Promise<void> {
  const repoRoot = path.join(destinationDir, "openai-plugins-main");
  await fs.mkdir(path.join(repoRoot, ".agents", "plugins"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
    "{}\n",
    "utf-8",
  );

  const specs = [
    ["documents", "documents", "documents", "documents"],
    ["presentations", "presentations", "presentations", "Presentations"],
    ["spreadsheets", "spreadsheets", "spreadsheets", "Spreadsheets"],
  ] as const;
  for (const [pluginName, sourceSkillName, targetName, sourceName] of specs) {
    const skillRoot = path.join(
      repoRoot,
      "plugins",
      "openai-primary-runtime",
      "plugins",
      pluginName,
      "skills",
      sourceSkillName,
    );
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---\nname: ${sourceName}\ndescription: ${targetName} skill\n---\n${targetName} body\n`,
      "utf-8",
    );
  }
}

async function writeFakeBundledRuntime(runtimeRoot: string): Promise<string> {
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, "runtime.json"),
    JSON.stringify({ bundleVersion: "test", targetPlatform: process.platform }),
    "utf-8",
  );

  const oaiSource = path.join(runtimeRoot, "node", "node_modules", "@oai");
  await fs.mkdir(path.join(oaiSource, "artifact-tool"), { recursive: true });
  await fs.writeFile(
    path.join(oaiSource, "artifact-tool", "package.json"),
    JSON.stringify({ name: "@oai/artifact-tool" }),
    "utf-8",
  );
  await fs.mkdir(path.join(runtimeRoot, "node", "bin"), { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, "node", "bin", executableBasename("node")),
    "",
    "utf-8",
  );
  await fs.mkdir(path.join(runtimeRoot, "python"), { recursive: true });
  await fs.writeFile(path.join(runtimeRoot, "python", executableBasename("python")), "", "utf-8");

  const specs = [
    ["documents", "documents", "documents", "documents"],
    ["presentations", "presentations", "presentations", "Presentations"],
    ["spreadsheets", "spreadsheets", "spreadsheets", "Spreadsheets"],
  ] as const;
  for (const [pluginName, sourceSkillName, targetName, sourceName] of specs) {
    const skillRoot = path.join(
      runtimeRoot,
      "plugins",
      "openai-primary-runtime",
      "plugins",
      pluginName,
      "skills",
      sourceSkillName,
    );
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---\nname: ${sourceName}\ndescription: ${targetName} skill\n---\n${targetName} body\n`,
      "utf-8",
    );
  }

  return oaiSource;
}

describe("Codex primary runtime bootstrap", () => {
  test("downloads curated Codex skills and exposes artifact-tool from the runtime cache", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-home-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-workspace-"));
    const builtInSkillsDir = path.join(workspace, "built-in-skills");
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const oaiSource = await writeFakeOaiNamespace(home);

    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === __internal.CODEX_CURATED_PLUGINS_EXPORT_URL) {
        return jsonResponse({ download_url: "https://download.test/curated.zip" });
      }
      if (url === "https://download.test/curated.zip") {
        return bytesResponse(new Uint8Array([1, 2, 3]));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir,
        globalSkillsDir,
        globalPluginsDir,
        fetchImpl,
        force: true,
        extractZipArchive: async (_archivePath, destinationDir) => {
          await writeFakeCuratedArchive(destinationDir);
        },
      });

      expect(result?.archive.status).toBe("downloaded");
      expect(result?.artifactTool).toMatchObject({
        status: "available",
        source: oaiSource,
      });
      await expect(fs.stat(path.join(workspace, "node_modules"))).rejects.toThrow();
      expect(
        await fs.readFile(path.join(builtInSkillsDir, "documents", "SKILL.md"), "utf-8"),
      ).toContain("documents body");
      expect(
        await fs.readFile(path.join(builtInSkillsDir, "presentations", "SKILL.md"), "utf-8"),
      ).toContain("name: presentations");
      expect(
        await fs.readFile(
          path.join(globalPluginsDir, "workspace-tools", "skills", "spreadsheets", "SKILL.md"),
          "utf-8",
        ),
      ).toContain("spreadsheets body");
      expect(
        await fs.readFile(
          path.join(
            globalPluginsDir,
            "workspace-tools",
            "skills",
            "spreadsheets",
            ".cowork-skill.json",
          ),
          "utf-8",
        ),
      ).toContain("bootstrap-codex-primary-runtime-spreadsheets");
      await expect(
        readPluginInstallMetadata(path.join(globalPluginsDir, "workspace-tools")),
      ).resolves.toMatchObject({
        bootstrap: {
          name: "codex-primary-runtime",
          pluginId: "workspace-tools",
        },
      });
      await expect(fs.access(path.join(globalSkillsDir, "spreadsheets"))).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("preserves the existing Workspace Tools plugin when atomic replacement copy fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-atomic-home-"));
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-atomic-workspace-"),
    );
    const builtInRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-atomic-builtin-"),
    );
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    await writeFakeBundledRuntime(bundledRuntimeDir);
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const existingPluginRoot = path.join(globalPluginsDir, "workspace-tools");
    const existingSkillRoot = path.join(existingPluginRoot, "skills", "spreadsheets");
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;

    try {
      await fs.mkdir(path.join(existingPluginRoot, ".cowork-plugin"), { recursive: true });
      await fs.mkdir(existingSkillRoot, { recursive: true });
      await fs.writeFile(
        path.join(existingPluginRoot, ".cowork-plugin", "plugin.json"),
        JSON.stringify({
          name: "workspace-tools",
          version: "0.0.1",
          description: "Existing Workspace Tools plugin",
          skills: "./skills/",
        }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(existingSkillRoot, "SKILL.md"),
        "---\nname: spreadsheets\ndescription: Old spreadsheets skill\n---\nold body\n",
        "utf-8",
      );
      await writeSkillInstallManifest({
        skillRoot: existingSkillRoot,
        installationId: "bootstrap-codex-primary-runtime-spreadsheets",
        origin: {
          kind: "bootstrap",
          url: __internal.CODEX_CURATED_PLUGINS_EXPORT_URL,
          subdir: "plugins/openai-primary-runtime/plugins/spreadsheets/skills/spreadsheets",
        },
      });
      pluginOperationsInternal.setCopyPluginRootImplForTests(async () => {
        throw new Error("simulated workspace tools copy failure");
      });

      await expect(
        ensureCodexPrimaryRuntimeReady({
          homedir: home,
          workspaceDir: workspace,
          builtInSkillsDir: path.join(builtInRoot, "skills"),
          globalSkillsDir: path.join(home, ".cowork", "skills"),
          globalPluginsDir,
          bundledRuntimeDir,
          fetchImpl,
          allowNetwork: false,
          force: true,
        }),
      ).rejects.toThrow("simulated workspace tools copy failure");

      expect(
        await fs.readFile(path.join(existingPluginRoot, ".cowork-plugin", "plugin.json"), "utf-8"),
      ).toContain("Existing Workspace Tools plugin");
      expect(await fs.readFile(path.join(existingSkillRoot, "SKILL.md"), "utf-8")).toContain(
        "old body",
      );
    } finally {
      pluginOperationsInternal.resetForTests();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("keeps managed global runtime skills when Workspace Tools replacement fails", async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-global-atomic-home-"),
    );
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-global-atomic-workspace-"),
    );
    const builtInRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-global-atomic-builtin-"),
    );
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    await writeFakeBundledRuntime(bundledRuntimeDir);
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const managedSpreadsheets = path.join(globalSkillsDir, "spreadsheets");
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;

    try {
      await fs.mkdir(managedSpreadsheets, { recursive: true });
      await fs.writeFile(
        path.join(managedSpreadsheets, "SKILL.md"),
        "---\nname: spreadsheets\ndescription: old spreadsheets\n---\nold global spreadsheets\n",
        "utf-8",
      );
      await writeSkillInstallManifest({
        skillRoot: managedSpreadsheets,
        installationId: "bootstrap-codex-primary-runtime-spreadsheets",
        origin: {
          kind: "bootstrap",
          url: __internal.CODEX_CURATED_PLUGINS_EXPORT_URL,
          subdir: "plugins/openai-primary-runtime/plugins/spreadsheets/skills/spreadsheets",
        },
      });
      pluginOperationsInternal.setCopyPluginRootImplForTests(async () => {
        throw new Error("simulated workspace tools copy failure");
      });

      await expect(
        ensureCodexPrimaryRuntimeReady({
          homedir: home,
          workspaceDir: workspace,
          builtInSkillsDir: path.join(builtInRoot, "skills"),
          globalSkillsDir,
          globalPluginsDir,
          bundledRuntimeDir,
          fetchImpl,
          allowNetwork: false,
          force: true,
        }),
      ).rejects.toThrow("simulated workspace tools copy failure");

      expect(await fs.readFile(path.join(managedSpreadsheets, "SKILL.md"), "utf-8")).toContain(
        "old global spreadsheets",
      );
    } finally {
      pluginOperationsInternal.resetForTests();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("keeps global fallback skills when their Workspace Tools skill is missing", async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-partial-global-home-"),
    );
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-partial-global-workspace-"),
    );
    const builtInRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-partial-global-builtin-"),
    );
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    await writeFakeBundledRuntime(bundledRuntimeDir);
    await fs.rm(
      path.join(
        bundledRuntimeDir,
        "plugins",
        "openai-primary-runtime",
        "plugins",
        "spreadsheets",
        "skills",
        "spreadsheets",
      ),
      { recursive: true, force: true },
    );
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const managedSpreadsheets = path.join(globalSkillsDir, "spreadsheets");
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;

    try {
      await fs.mkdir(managedSpreadsheets, { recursive: true });
      await fs.writeFile(
        path.join(managedSpreadsheets, "SKILL.md"),
        "---\nname: spreadsheets\ndescription: fallback spreadsheets\n---\nglobal fallback\n",
        "utf-8",
      );
      await writeSkillInstallManifest({
        skillRoot: managedSpreadsheets,
        installationId: "bootstrap-codex-primary-runtime-spreadsheets",
        origin: {
          kind: "bootstrap",
          url: __internal.CODEX_CURATED_PLUGINS_EXPORT_URL,
          subdir: "plugins/openai-primary-runtime/plugins/spreadsheets/skills/spreadsheets",
        },
      });

      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir: path.join(builtInRoot, "skills"),
        globalSkillsDir,
        globalPluginsDir,
        bundledRuntimeDir,
        fetchImpl,
        allowNetwork: false,
      });

      expect(
        result?.skills
          .filter((skill) => skill.destination.includes("workspace-tools"))
          .map((skill) => [skill.name, skill.status]),
      ).toEqual([
        ["documents", "installed"],
        ["presentations", "installed"],
        ["spreadsheets", "missing"],
      ]);
      expect(await fs.readFile(path.join(managedSpreadsheets, "SKILL.md"), "utf-8")).toContain(
        "global fallback",
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("preserves existing Workspace Tools skills during partial replacement", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-overlay-home-"));
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-overlay-workspace-"),
    );
    const builtInRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-codex-runtime-overlay-builtin-"),
    );
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    await writeFakeBundledRuntime(bundledRuntimeDir);
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const existingPluginRoot = path.join(globalPluginsDir, "workspace-tools");
    const manualDocuments = path.join(existingPluginRoot, "skills", "documents");
    const currentSpreadsheets = path.join(existingPluginRoot, "skills", "spreadsheets");
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;

    try {
      await fs.mkdir(path.join(existingPluginRoot, ".cowork-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(existingPluginRoot, ".cowork-plugin", "plugin.json"),
        JSON.stringify({
          name: "workspace-tools",
          version: "0.0.1",
          description: "Existing Workspace Tools plugin",
          skills: "./skills/",
        }),
        "utf-8",
      );
      await fs.mkdir(manualDocuments, { recursive: true });
      await fs.writeFile(
        path.join(manualDocuments, "SKILL.md"),
        "---\nname: documents\ndescription: Manual documents skill\n---\nmanual documents body\n",
        "utf-8",
      );
      await fs.mkdir(currentSpreadsheets, { recursive: true });
      await fs.writeFile(
        path.join(currentSpreadsheets, "SKILL.md"),
        "---\nname: spreadsheets\ndescription: Current spreadsheets skill\n---\ncurrent spreadsheets body\n",
        "utf-8",
      );
      await writeSkillInstallManifest({
        skillRoot: currentSpreadsheets,
        installationId: "bootstrap-codex-primary-runtime-spreadsheets",
        origin: {
          kind: "bootstrap",
          url: __internal.CODEX_CURATED_PLUGINS_EXPORT_URL,
          subdir: "plugins/openai-primary-runtime/plugins/spreadsheets/skills/spreadsheets",
        },
      });

      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir: path.join(builtInRoot, "skills"),
        globalSkillsDir: path.join(home, ".cowork", "skills"),
        globalPluginsDir,
        bundledRuntimeDir,
        fetchImpl,
        allowNetwork: false,
      });

      expect(
        result?.skills
          .filter((skill) => skill.destination.includes("workspace-tools"))
          .map((skill) => [skill.name, skill.status]),
      ).toEqual([
        ["documents", "already_installed"],
        ["presentations", "installed"],
        ["spreadsheets", "already_installed"],
      ]);
      expect(await fs.readFile(path.join(manualDocuments, "SKILL.md"), "utf-8")).toContain(
        "manual documents body",
      );
      expect(await fs.readFile(path.join(currentSpreadsheets, "SKILL.md"), "utf-8")).toContain(
        "current spreadsheets body",
      );
      expect(
        await fs.readFile(
          path.join(existingPluginRoot, "skills", "presentations", "SKILL.md"),
          "utf-8",
        ),
      ).toContain("presentations body");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("skips curated archive download when network bootstrap is disabled", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-offline-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-workspace-"));
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;

    try {
      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        globalSkillsDir: path.join(home, ".cowork", "skills"),
        globalPluginsDir: path.join(home, ".cowork", "plugins"),
        fetchImpl,
        allowNetwork: false,
      });

      expect(result?.archive).toMatchObject({
        status: "skipped",
        reason: "Network bootstrap is disabled for this process.",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result?.skills.every((skill) => skill.status === "missing")).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("uses bundled runtime assets for clean packaged startup", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-packaged-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-workspace-"));
    const builtInRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-built-in-"));
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    const oaiSource = await writeFakeBundledRuntime(bundledRuntimeDir);
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;

    try {
      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir: path.join(builtInRoot, "skills"),
        globalSkillsDir: path.join(home, ".cowork", "skills"),
        globalPluginsDir: path.join(home, ".cowork", "plugins"),
        fetchImpl,
        allowNetwork: false,
      });

      expect(result?.runtime).toMatchObject({
        status: "available",
        source: bundledRuntimeDir,
        nodeModulesPath: path.join(bundledRuntimeDir, "node", "node_modules"),
      });
      expect(result?.runtimeEnv.COWORK_CODEX_PRIMARY_RUNTIME_DIR).toBe(bundledRuntimeDir);
      expect(result?.runtimeEnv.COWORK_CODEX_RUNTIME_NODE).toBe(
        path.join(bundledRuntimeDir, "node", "bin", executableBasename("node")),
      );
      expect(result?.runtimeEnv.COWORK_CODEX_RUNTIME_PYTHON).toBe(
        path.join(bundledRuntimeDir, "python", executableBasename("python")),
      );
      expect(result?.runtimeEnv.COWORK_CODEX_RUNTIME_NODE_MODULES).toBe(
        path.join(bundledRuntimeDir, "node", "node_modules"),
      );
      expect(result?.runtimeEnv.NODE_PATH?.split(path.delimiter)[0]).toBe(
        path.join(bundledRuntimeDir, "node", "node_modules"),
      );
      expect(result?.runtimeEnv.COWORK_CODEX_RUNTIME_NODE_RESOLVER).toBe(
        path.join(
          home,
          ".cache",
          "codex-runtimes",
          "codex-primary-runtime",
          "node-resolver",
          "register.mjs",
        ),
      );
      expect(result?.runtimeEnv.NODE_OPTIONS).toContain("--import=file://");
      await expect(
        fs.readFile(result?.runtimeEnv.COWORK_CODEX_RUNTIME_NODE_RESOLVER ?? "", "utf-8"),
      ).resolves.toContain("register(new URL");
      expect(result?.artifactTool).toMatchObject({
        status: "available",
        source: oaiSource,
      });
      await expect(fs.stat(path.join(workspace, "node_modules"))).rejects.toThrow();
      expect(
        await fs.readFile(path.join(builtInRoot, "skills", "presentations", "SKILL.md"), "utf-8"),
      ).toContain("name: presentations");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("does not reinstall current managed runtime skills on later startup", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-repeat-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-workspace-"));
    const builtInRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-built-in-"));
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    await writeFakeBundledRuntime(bundledRuntimeDir);
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const builtInSkillsDir = path.join(builtInRoot, "skills");

    try {
      await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir,
        globalSkillsDir,
        globalPluginsDir,
        fetchImpl,
        allowNetwork: false,
      });
      const documentsManifestPath = path.join(
        globalPluginsDir,
        "workspace-tools",
        "skills",
        "documents",
        ".cowork-skill.json",
      );
      const firstDocumentsManifest = await fs.readFile(documentsManifestPath, "utf-8");
      const secondLogs: string[] = [];

      const second = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir,
        globalSkillsDir,
        globalPluginsDir,
        fetchImpl,
        allowNetwork: false,
        log: (line) => secondLogs.push(line),
      });

      expect(second?.skills.every((skill) => skill.status === "already_installed")).toBe(true);
      expect(secondLogs.filter((line) => line.startsWith("Installing Codex "))).toEqual([]);
      await expect(fs.readFile(documentsManifestPath, "utf-8")).resolves.toBe(
        firstDocumentsManifest,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("skips Workspace Tools plugin bootstrap when the user removed it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-skip-plugin-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-workspace-"));
    const builtInRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-built-in-"));
    const bundledRuntimeDir = path.join(builtInRoot, "codex-primary-runtime");
    await writeFakeBundledRuntime(bundledRuntimeDir);
    const globalPluginsDir = path.join(home, ".cowork", "plugins");

    try {
      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        globalPluginsDir,
        skipGlobalWorkspaceToolsPlugin: true,
        allowNetwork: false,
      });

      expect(
        result?.skills.filter((skill) => skill.status === "skipped").map((skill) => skill.name),
      ).toEqual(["documents", "presentations", "spreadsheets"]);
      await expect(fs.access(path.join(globalPluginsDir, "workspace-tools"))).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("overwrites managed bootstrap skills but preserves manual global skills", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-global-"));
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    const globalPluginsDir = path.join(home, ".cowork", "plugins");
    const managedSpreadsheet = path.join(globalSkillsDir, "spreadsheet");
    const managedSpreadsheets = path.join(globalSkillsDir, "spreadsheets");
    const manualDoc = path.join(globalSkillsDir, "doc");

    await fs.mkdir(managedSpreadsheet, { recursive: true });
    await fs.writeFile(path.join(managedSpreadsheet, "SKILL.md"), "old spreadsheet\n", "utf-8");
    await writeSkillInstallManifest({
      skillRoot: managedSpreadsheet,
      installationId: "bootstrap-spreadsheet",
      origin: { kind: "bootstrap", url: "https://github.com/mweinbach/cowork-skills-plugins" },
    });
    await fs.mkdir(managedSpreadsheets, { recursive: true });
    await fs.writeFile(
      path.join(managedSpreadsheets, "SKILL.md"),
      "---\nname: spreadsheets\ndescription: old spreadsheets\n---\nold spreadsheets\n",
      "utf-8",
    );
    await writeSkillInstallManifest({
      skillRoot: managedSpreadsheets,
      installationId: "bootstrap-codex-primary-runtime-spreadsheets",
      origin: {
        kind: "bootstrap",
        url: __internal.CODEX_CURATED_PLUGINS_EXPORT_URL,
        subdir: "plugins/openai-primary-runtime/plugins/spreadsheets/skills/spreadsheets",
      },
    });
    await fs.mkdir(manualDoc, { recursive: true });
    await fs.writeFile(path.join(manualDoc, "SKILL.md"), "manual doc\n", "utf-8");

    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === __internal.CODEX_CURATED_PLUGINS_EXPORT_URL) {
        return jsonResponse({ download_url: "https://download.test/curated.zip" });
      }
      if (url === "https://download.test/curated.zip") {
        return bytesResponse(new Uint8Array([1]));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        globalSkillsDir,
        globalPluginsDir,
        fetchImpl,
        extractZipArchive: async (_archivePath, destinationDir) => {
          await writeFakeCuratedArchive(destinationDir);
        },
      });

      await expect(fs.access(managedSpreadsheet)).rejects.toThrow();
      await expect(fs.access(managedSpreadsheets)).rejects.toThrow();
      expect(
        await fs.readFile(
          path.join(globalPluginsDir, "workspace-tools", "skills", "spreadsheets", "SKILL.md"),
          "utf-8",
        ),
      ).toContain("spreadsheets body");
      expect(await fs.readFile(path.join(manualDoc, "SKILL.md"), "utf-8")).toBe("manual doc\n");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
