import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAiCoworkerPaths } from "../store/connections";
import { defaultExtractArchive, downloadArtifactRuntimeArchive } from "./archive";
import {
  ARTIFACT_RUNTIME_ALLOW_NETWORK_ENV,
  ARTIFACT_RUNTIME_ARCHIVE_URL_ENV,
  ARTIFACT_RUNTIME_DISABLE_ENV,
  ARTIFACT_RUNTIME_FORCE_ENV,
} from "./constants";
import { migrateLegacyArtifactRuntime } from "./migrate";
import {
  artifactRuntimeCacheRoot,
  bundledRuntimeDirFromOptions,
  collectRuntimeRoots,
  prepareNodeModuleResolverEnv,
  prependNodePath,
  prependToolPath,
  resolveArtifactTool,
  resolveRuntimeExecutablePaths,
} from "./runtimeDiscovery";
import { artifactRuntimeStateFile, writeState } from "./state";
import type { ArtifactRuntimeSetupResult, EnsureArtifactRuntimeOptions } from "./types";

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function shouldBootstrapArtifactRuntime(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !isTruthy(env[ARTIFACT_RUNTIME_DISABLE_ENV]);
}

export async function ensureArtifactRuntimeReady(
  opts: EnsureArtifactRuntimeOptions = {},
): Promise<ArtifactRuntimeSetupResult | null> {
  const env = opts.env ?? process.env;
  if (!shouldBootstrapArtifactRuntime(env)) return null;

  const home = path.resolve(opts.homedir ?? os.homedir());
  const paths = getAiCoworkerPaths({ homedir: home });
  await fs.mkdir(paths.configDir, { recursive: true });

  const cacheDir = artifactRuntimeCacheRoot(home);
  const stateFile = artifactRuntimeStateFile(home);
  const force = opts.force || isTruthy(env[ARTIFACT_RUNTIME_FORCE_ENV]);
  const allowNetwork =
    opts.allowNetwork ??
    (opts.fetchImpl !== undefined || force || isTruthy(env[ARTIFACT_RUNTIME_ALLOW_NETWORK_ENV]));
  const archiveUrl =
    (opts.archiveUrl ?? env[ARTIFACT_RUNTIME_ARCHIVE_URL_ENV])?.trim() || undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const extractArchive = opts.extractArchive ?? defaultExtractArchive;
  const bundledRuntimeDir = bundledRuntimeDirFromOptions({
    bundledRuntimeDir: opts.bundledRuntimeDir,
    env,
  });

  let runtimeRoots = await collectRuntimeRoots(home, bundledRuntimeDir);
  let artifactTool = await resolveArtifactTool({ runtimeRoots });

  // One-time migration: bridge existing installs that only have the runtime in
  // the legacy Codex cache into the Cowork-owned cache. Never runs once the
  // Cowork cache already has a usable runtime, and is skipped under --force so a
  // refresh download wins.
  let migration: ArtifactRuntimeSetupResult["migration"] = { status: "skipped" };
  if (artifactTool.status !== "available" && !force) {
    const migrated = await migrateLegacyArtifactRuntime({ home, cacheDir, log: opts.log });
    if (migrated.status === "migrated") {
      migration = { status: "migrated", ...(migrated.source ? { source: migrated.source } : {}) };
      runtimeRoots = await collectRuntimeRoots(home, bundledRuntimeDir);
      artifactTool = await resolveArtifactTool({ runtimeRoots });
    } else if (migrated.status === "failed") {
      migration = { status: "failed", ...(migrated.reason ? { reason: migrated.reason } : {}) };
    }
  }

  let archive: ArtifactRuntimeSetupResult["archive"] = {
    status: "skipped",
    ...(archiveUrl ? { endpoint: archiveUrl } : {}),
  };

  const needsDownload = force || artifactTool.status !== "available";
  if (needsDownload && allowNetwork && archiveUrl) {
    const tmpRoot = await fs.mkdtemp(path.join(paths.rootDir, ".artifact-runtime-"));
    try {
      const extractedDir = await downloadArtifactRuntimeArchive({
        fetchImpl,
        extractArchive,
        archiveUrl,
        cacheDir,
        tmpRoot,
        log: opts.log,
      });
      archive = { status: "downloaded", endpoint: archiveUrl, extractedDir };
      runtimeRoots = await collectRuntimeRoots(home, bundledRuntimeDir);
      artifactTool = await resolveArtifactTool({ runtimeRoots });
    } catch (error) {
      archive = {
        status: "failed",
        endpoint: archiveUrl,
        reason: error instanceof Error ? error.message : String(error),
      };
      opts.log?.(`Artifact runtime archive download failed: ${archive.reason}`);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  } else if (needsDownload && !archiveUrl) {
    archive = {
      status: "skipped",
      reason: `No artifact runtime archive URL configured (set ${ARTIFACT_RUNTIME_ARCHIVE_URL_ENV}).`,
    };
  } else if (needsDownload && !allowNetwork) {
    archive = {
      status: "skipped",
      endpoint: archiveUrl,
      reason: "Network bootstrap is disabled for this process.",
    };
  }

  const runtime = await resolveRuntimeExecutablePaths(runtimeRoots);
  const runtimePathDirs = [
    runtime.nodePath ? path.dirname(runtime.nodePath) : "",
    runtime.pythonPath ? path.dirname(runtime.pythonPath) : "",
    runtime.pythonPath ? path.join(path.dirname(runtime.pythonPath), "Scripts") : "",
  ];
  const runtimeEnv = await prepareNodeModuleResolverEnv({
    env,
    runtimeDir: cacheDir,
    runtimeEnv: prependNodePath(
      env,
      prependToolPath(env, runtime.runtimeEnv, runtimePathDirs),
      runtime.nodeModulesPath,
    ),
    nodeModulesPath: runtime.nodeModulesPath,
  });

  await writeState({
    stateFile,
    ...(runtime.source ? { runtimeSource: runtime.source } : {}),
    ...(artifactTool.source ? { artifactSource: artifactTool.source } : {}),
    ...(migration.source ? { migratedFrom: migration.source } : {}),
  });

  return {
    cacheDir,
    stateFile,
    runtimeEnv,
    runtime: {
      status: runtime.status,
      ...(runtime.source ? { source: runtime.source } : {}),
      ...(runtime.nodePath ? { nodePath: runtime.nodePath } : {}),
      ...(runtime.pythonPath ? { pythonPath: runtime.pythonPath } : {}),
      ...(runtime.nodeModulesPath ? { nodeModulesPath: runtime.nodeModulesPath } : {}),
    },
    artifactTool,
    migration,
    archive,
  };
}
