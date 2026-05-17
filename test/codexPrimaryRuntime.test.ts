import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal, ensureCodexPrimaryRuntimeReady } from "../src/codexPrimaryRuntime";
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
    ["documents", "documents", "doc", "documents"],
    ["presentations", "presentations", "slides", "Presentations"],
    ["spreadsheets", "spreadsheets", "spreadsheet", "Spreadsheets"],
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
    ["documents", "documents", "doc", "documents"],
    ["presentations", "presentations", "slides", "Presentations"],
    ["spreadsheets", "spreadsheets", "spreadsheet", "Spreadsheets"],
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
  test("downloads curated Codex skills and installs artifact-tool into the workspace", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-home-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-workspace-"));
    const builtInSkillsDir = path.join(workspace, "built-in-skills");
    const globalSkillsDir = path.join(home, ".cowork", "skills");
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
        fetchImpl,
        force: true,
        extractZipArchive: async (_archivePath, destinationDir) => {
          await writeFakeCuratedArchive(destinationDir);
        },
      });

      expect(result?.archive.status).toBe("downloaded");
      expect(result?.artifactTool).toMatchObject({
        status: "installed",
        source: oaiSource,
        destination: path.join(workspace, "node_modules", "@oai"),
      });
      expect(
        await fs.readFile(
          path.join(workspace, "node_modules", "@oai", "artifact-tool", "package.json"),
          "utf-8",
        ),
      ).toContain("@oai/artifact-tool");
      expect(await fs.readFile(path.join(builtInSkillsDir, "doc", "SKILL.md"), "utf-8")).toContain(
        "doc body",
      );
      expect(
        await fs.readFile(path.join(builtInSkillsDir, "slides", "SKILL.md"), "utf-8"),
      ).toContain("name: slides");
      expect(
        await fs.readFile(path.join(globalSkillsDir, "spreadsheet", "SKILL.md"), "utf-8"),
      ).toContain("spreadsheet body");
      expect(
        await fs.readFile(path.join(globalSkillsDir, "spreadsheet", ".cowork-skill.json"), "utf-8"),
      ).toContain("bootstrap-codex-primary-runtime-spreadsheet");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
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
      expect(result?.artifactTool).toMatchObject({
        status: "installed",
        source: oaiSource,
        destination: path.join(workspace, "node_modules", "@oai"),
      });
      expect(
        await fs.readFile(path.join(builtInRoot, "skills", "slides", "SKILL.md"), "utf-8"),
      ).toContain("name: slides");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(builtInRoot, { recursive: true, force: true });
    }
  });

  test("overwrites managed bootstrap skills but preserves manual global skills", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-runtime-global-"));
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    const managedSpreadsheet = path.join(globalSkillsDir, "spreadsheet");
    const manualDoc = path.join(globalSkillsDir, "doc");

    await fs.mkdir(managedSpreadsheet, { recursive: true });
    await fs.writeFile(path.join(managedSpreadsheet, "SKILL.md"), "old spreadsheet\n", "utf-8");
    await writeSkillInstallManifest({
      skillRoot: managedSpreadsheet,
      installationId: "bootstrap-spreadsheet",
      origin: { kind: "bootstrap", url: "https://github.com/openai/skills" },
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
        fetchImpl,
        extractZipArchive: async (_archivePath, destinationDir) => {
          await writeFakeCuratedArchive(destinationDir);
        },
      });

      expect(await fs.readFile(path.join(managedSpreadsheet, "SKILL.md"), "utf-8")).toContain(
        "spreadsheet body",
      );
      expect(await fs.readFile(path.join(manualDoc, "SKILL.md"), "utf-8")).toBe("manual doc\n");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
