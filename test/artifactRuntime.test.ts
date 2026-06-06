import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureArtifactRuntimeReady,
  prepareArtifactRuntimeToolEnv,
  renderArtifactRuntimeInstructions,
  shouldBootstrapArtifactRuntime,
} from "../src/artifactRuntime";
import { migrateLegacyArtifactRuntime } from "../src/artifactRuntime/migrate";

function executableBasename(name: "node" | "python"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function writeFakeArtifactRuntime(rootDir: string): Promise<string> {
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "runtime.json"),
    JSON.stringify({ bundleVersion: "test", targetPlatform: process.platform }),
    "utf-8",
  );

  const oaiSource = path.join(rootDir, "node", "node_modules", "@oai");
  await fs.mkdir(path.join(oaiSource, "artifact-tool"), { recursive: true });
  await fs.writeFile(
    path.join(oaiSource, "artifact-tool", "package.json"),
    JSON.stringify({ name: "@oai/artifact-tool", version: "2.7.3" }),
    "utf-8",
  );
  await fs.mkdir(path.join(rootDir, "node", "bin"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "node", "bin", executableBasename("node")), "", "utf-8");
  await fs.mkdir(path.join(rootDir, "python"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "python", executableBasename("python")), "", "utf-8");

  return oaiSource;
}

async function writeFakeLegacyCodexRuntimeAt(root: string): Promise<string> {
  await writeFakeArtifactRuntime(root);
  // Skills that live under the legacy runtime must NOT be migrated into the
  // artifact runtime cache (they are owned by the cowork-skills-plugins
  // marketplace instead).
  const legacySkill = path.join(
    root,
    "plugins",
    "openai-primary-runtime",
    "plugins",
    "spreadsheets",
    "skills",
    "spreadsheets",
  );
  await fs.mkdir(legacySkill, { recursive: true });
  await fs.writeFile(path.join(legacySkill, "SKILL.md"), "---\nname: spreadsheets\n---\nlegacy\n");
  return root;
}

async function writeFakeLegacyCodexRuntime(home: string): Promise<string> {
  return writeFakeLegacyCodexRuntimeAt(
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime"),
  );
}

describe("artifact runtime bootstrap", () => {
  test("respects the disable flag", () => {
    expect(shouldBootstrapArtifactRuntime({ COWORK_DISABLE_ARTIFACT_RUNTIME: "1" })).toBe(false);
    expect(shouldBootstrapArtifactRuntime({})).toBe(true);
  });

  test("returns null when bootstrap is disabled", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-disabled-"));
    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: { COWORK_DISABLE_ARTIFACT_RUNTIME: "1" },
      });
      expect(result).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("discovers a bundled runtime and exports artifact runtime env", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-bundled-home-"));
    const bundledRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-artifact-bundled-runtime-"),
    );
    const bundledRuntimeDir = path.join(bundledRoot, "artifact-runtime");
    const oaiSource = await writeFakeArtifactRuntime(bundledRuntimeDir);

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        bundledRuntimeDir,
        allowNetwork: false,
      });

      expect(result?.runtime).toMatchObject({
        status: "available",
        source: bundledRuntimeDir,
        nodeModulesPath: path.join(bundledRuntimeDir, "node", "node_modules"),
      });
      expect(result?.runtimeEnv.COWORK_ARTIFACT_RUNTIME_DIR).toBe(bundledRuntimeDir);
      expect(result?.runtimeEnv.COWORK_ARTIFACT_RUNTIME_NODE).toBe(
        path.join(bundledRuntimeDir, "node", "bin", executableBasename("node")),
      );
      expect(result?.runtimeEnv.COWORK_ARTIFACT_RUNTIME_PYTHON).toBe(
        path.join(bundledRuntimeDir, "python", executableBasename("python")),
      );
      expect(result?.runtimeEnv.COWORK_ARTIFACT_RUNTIME_NODE_MODULES).toBe(
        path.join(bundledRuntimeDir, "node", "node_modules"),
      );
      expect(result?.runtimeEnv.NODE_PATH?.split(path.delimiter)[0]).toBe(
        path.join(bundledRuntimeDir, "node", "node_modules"),
      );
      expect(result?.runtimeEnv.COWORK_ARTIFACT_RUNTIME_NODE_RESOLVER).toBe(
        path.join(home, ".cache", "cowork", "artifact-runtime", "node-resolver", "register.mjs"),
      );
      expect(result?.runtimeEnv.NODE_OPTIONS).toContain("--import=file://");
      await expect(
        fs.readFile(result?.runtimeEnv.COWORK_ARTIFACT_RUNTIME_NODE_RESOLVER ?? "", "utf-8"),
      ).resolves.toContain("register(new URL");
      expect(result?.artifactTool).toMatchObject({
        status: "available",
        source: oaiSource,
      });
      expect(result?.migration.status).toBe("skipped");

      const stateRaw = await fs.readFile(result?.stateFile ?? "", "utf-8");
      const state = JSON.parse(stateRaw);
      expect(state.runtimeSource).toBe(bundledRuntimeDir);
      expect(state.artifactSource).toBe(oaiSource);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(bundledRoot, { recursive: true, force: true });
    }
  });

  test("migrates a legacy Codex artifact runtime into the Cowork cache without skills", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-migrate-"));
    const legacyRoot = await writeFakeLegacyCodexRuntime(home);
    const cacheDir = path.join(home, ".cache", "cowork", "artifact-runtime");

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        allowNetwork: false,
      });

      expect(result?.migration).toMatchObject({ status: "migrated", source: legacyRoot });
      expect(result?.runtime.status).toBe("available");
      expect(result?.runtime.source).toBe(cacheDir);
      expect(result?.artifactTool).toMatchObject({
        status: "available",
        source: path.join(cacheDir, "node", "node_modules", "@oai"),
      });
      await expect(
        fs.stat(
          path.join(cacheDir, "node", "node_modules", "@oai", "artifact-tool", "package.json"),
        ),
      ).resolves.toBeDefined();
      // Skills must not be carried into the artifact runtime cache.
      await expect(fs.stat(path.join(cacheDir, "plugins"))).rejects.toThrow();

      const state = JSON.parse(await fs.readFile(result?.stateFile ?? "", "utf-8"));
      expect(state.migratedFrom).toBe(legacyRoot);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("migrates a legacy Codex artifact runtime from an install payload directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-install-migrate-"));
    const legacyRoot = await writeFakeLegacyCodexRuntimeAt(
      path.join(
        home,
        ".cache",
        "codex-runtimes",
        "codex-runtime-install-42",
        "payload",
        "codex-primary-runtime",
      ),
    );
    const cacheDir = path.join(home, ".cache", "cowork", "artifact-runtime");

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        allowNetwork: false,
      });

      expect(result?.migration).toMatchObject({ status: "migrated", source: legacyRoot });
      expect(result?.runtime.status).toBe("available");
      expect(result?.runtime.source).toBe(cacheDir);
      expect(result?.artifactTool).toMatchObject({
        status: "available",
        source: path.join(cacheDir, "node", "node_modules", "@oai"),
      });
      await expect(fs.stat(path.join(cacheDir, "plugins"))).rejects.toThrow();

      const state = JSON.parse(await fs.readFile(result?.stateFile ?? "", "utf-8"));
      expect(state.migratedFrom).toBe(legacyRoot);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("migrates a symlinked legacy runtime by dereferencing (Windows-safe)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-symlink-"));
    const legacyRoot = await writeFakeLegacyCodexRuntime(home);

    // Mimic a pnpm-style symlink/junction inside the runtime payload. `fs.cp` must
    // dereference it (copy the target's content) rather than recreate the link,
    // which fails on Windows with EPERM. Skip if the OS forbids creating the fixture.
    const realDir = path.join(legacyRoot, "node", "node_modules", "real-pkg");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "index.js"), "module.exports = 1;\n", "utf-8");
    const linkPath = path.join(legacyRoot, "node", "node_modules", "linked-pkg");
    let symlinkCreated = false;
    try {
      if (process.platform === "win32") {
        await fs.symlink(realDir, linkPath, "junction");
      } else {
        await fs.symlink("real-pkg", linkPath);
      }
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    try {
      if (!symlinkCreated) return; // environment cannot create symlinks; nothing to assert

      const cacheDir = path.join(home, ".cache", "cowork", "artifact-runtime");
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        allowNetwork: false,
      });

      expect(result?.migration.status).toBe("migrated");
      const migratedLink = path.join(cacheDir, "node", "node_modules", "linked-pkg");
      const stat = await fs.lstat(migratedLink);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      await expect(fs.readFile(path.join(migratedLink, "index.js"), "utf-8")).resolves.toContain(
        "module.exports = 1;",
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("never throws when the legacy migration copy fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-migrate-fail-"));
    await writeFakeLegacyCodexRuntime(home);
    // Point the cache at a path whose parent is a regular file so the copy cannot
    // succeed; a best-effort migration must degrade gracefully, not crash startup.
    const blocker = path.join(home, "blocker-file");
    await fs.writeFile(blocker, "not a directory", "utf-8");
    const cacheDir = path.join(blocker, "artifact-runtime");

    try {
      const result = await migrateLegacyArtifactRuntime({ home, cacheDir });
      expect(result.status).toBe("failed");
      expect(result.reason).toBeTruthy();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("surfaces legacy migration failure through bootstrap without crashing startup", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-bootstrap-fail-"));
    await writeFakeLegacyCodexRuntime(home);
    const coworkCacheParent = path.join(home, ".cache", "cowork");
    await fs.writeFile(coworkCacheParent, "not a directory", "utf-8");
    const logs: string[] = [];

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        allowNetwork: false,
        log: (line) => logs.push(line),
      });

      expect(result?.migration.status).toBe("failed");
      expect(result?.migration.reason).toBeTruthy();
      expect(result?.runtime.status).toBe("missing");
      expect(result?.artifactTool.status).toBe("missing");
      expect(result?.archive).toMatchObject({
        status: "skipped",
      });
      expect(result?.archive.reason).toContain("COWORK_ARTIFACT_RUNTIME_ARCHIVE_URL");
      expect(logs.some((line) => line.includes("Artifact runtime migration failed"))).toBe(true);

      const state = JSON.parse(await fs.readFile(result?.stateFile ?? "", "utf-8"));
      expect(state.migratedFrom).toBeUndefined();
      expect(state.runtimeSource).toBeUndefined();
      expect(state.artifactSource).toBeUndefined();
      await expect(fs.readFile(coworkCacheParent, "utf-8")).resolves.toBe("not a directory");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("prefers a fresh download over legacy migration under force", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-migrate-force-"));
    await writeFakeLegacyCodexRuntime(home);
    const archiveUrl = "https://download.test/artifact-runtime.zip";
    const fetchImpl = mock(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ) as typeof fetch;

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        force: true,
        archiveUrl,
        fetchImpl,
        extractArchive: async (_archivePath, destinationDir) => {
          await writeFakeArtifactRuntime(destinationDir);
        },
      });

      expect(result?.migration.status).toBe("skipped");
      expect(result?.archive.status).toBe("downloaded");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("downloads and installs the artifact runtime archive into the cache", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-download-home-"));
    const archiveUrl = "https://download.test/artifact-runtime.zip";
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      if (String(input) === archiveUrl) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        archiveUrl,
        fetchImpl,
        extractArchive: async (_archivePath, destinationDir) => {
          await writeFakeArtifactRuntime(destinationDir);
        },
      });

      const cacheDir = path.join(home, ".cache", "cowork", "artifact-runtime");
      expect(result?.archive).toMatchObject({ status: "downloaded", endpoint: archiveUrl });
      expect(result?.runtime.status).toBe("available");
      expect(result?.runtime.source).toBe(cacheDir);
      expect(result?.artifactTool).toMatchObject({
        status: "available",
        source: path.join(cacheDir, "node", "node_modules", "@oai"),
      });
      await expect(
        fs.stat(
          path.join(cacheDir, "node", "node_modules", "@oai", "artifact-tool", "package.json"),
        ),
      ).resolves.toBeDefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("reports failed archive setup when extraction does not contain a runtime root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-bad-archive-"));
    const archiveUrl = "https://download.test/bad-artifact-runtime.zip";
    const fetchImpl = mock(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ) as typeof fetch;

    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        archiveUrl,
        fetchImpl,
        extractArchive: async (_archivePath, destinationDir) => {
          await fs.mkdir(path.join(destinationDir, "not-a-runtime"), { recursive: true });
        },
      });

      expect(result?.archive).toMatchObject({
        status: "failed",
        endpoint: archiveUrl,
      });
      expect(result?.archive.reason).toContain("Could not locate an artifact runtime root");
      expect(result?.runtime.status).toBe("missing");
      expect(result?.artifactTool.status).toBe("missing");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("reports a setup blocker when nothing is cached and no archive URL is configured", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-missing-"));
    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        allowNetwork: false,
      });
      expect(result?.runtime.status).toBe("missing");
      expect(result?.artifactTool.status).toBe("missing");
      expect(result?.archive.status).toBe("skipped");
      expect(result?.archive.reason).toContain("COWORK_ARTIFACT_RUNTIME_ARCHIVE_URL");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("skips download when network bootstrap is disabled", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-offline-"));
    const fetchImpl = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;
    try {
      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        archiveUrl: "https://download.test/artifact-runtime.zip",
        fetchImpl,
        allowNetwork: false,
      });
      expect(result?.archive).toMatchObject({
        status: "skipped",
        reason: "Network bootstrap is disabled for this process.",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("artifact runtime instructions and tool env", () => {
  test("renders provider-neutral instructions when the runtime env is present", () => {
    const instructions = renderArtifactRuntimeInstructions({
      COWORK_ARTIFACT_RUNTIME_NODE_MODULES: "/runtime/node/node_modules",
      COWORK_ARTIFACT_RUNTIME_NODE: "/runtime/node/bin/node",
      COWORK_ARTIFACT_RUNTIME_NODE_RESOLVER: "/runtime/node-resolver/register.mjs",
    });
    expect(instructions).toContain("## Artifact Runtime Dependencies");
    expect(instructions).toContain('import "@oai/artifact-tool"');
    expect(instructions).toContain("/runtime/node/bin/node");
  });

  test("returns null instructions when no runtime is available", () => {
    expect(renderArtifactRuntimeInstructions({})).toBeNull();
  });

  test("leaves the env untouched when runtime keys are already present", async () => {
    const env = {
      COWORK_ARTIFACT_RUNTIME_NODE_MODULES: "/runtime/node/node_modules",
      COWORK_ARTIFACT_RUNTIME_NODE: "/runtime/node/bin/node",
    };
    const result = await prepareArtifactRuntimeToolEnv({ env });
    expect(result.COWORK_ARTIFACT_RUNTIME_NODE_MODULES).toBe("/runtime/node/node_modules");
  });

  test("injects discovered runtime env when none is set yet", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-prepare-home-"));
    const bundledRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-artifact-prepare-runtime-"),
    );
    const bundledRuntimeDir = path.join(bundledRoot, "artifact-runtime");
    await writeFakeArtifactRuntime(bundledRuntimeDir);

    try {
      const result = await prepareArtifactRuntimeToolEnv({
        homedir: home,
        env: {},
        bundledRuntimeDir,
      });
      expect(result.COWORK_ARTIFACT_RUNTIME_NODE_MODULES).toBe(
        path.join(bundledRuntimeDir, "node", "node_modules"),
      );
      expect(result.NODE_OPTIONS).toContain("--import=file://");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(bundledRoot, { recursive: true, force: true });
    }
  });
});
