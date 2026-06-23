import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withCoworkRuntimeBootstrapLock } from "./bootstrapLock";
import { cleanupLegacyCoworkRuntimes } from "./cleanup";
import { checksumFromText, downloadRuntimeRelease } from "./download";
import {
  activateInstalledRuntime,
  installedRuntimeDir,
  installRuntimeArchive,
  listInstalledRuntimes,
  pruneInstalledRuntimes,
  readCurrentRuntimePointer,
  resolveCurrentRuntime,
} from "./install";
import type { TrustedRuntimeKeys } from "./integrity";
import { readRuntimeManifest } from "./manifest";
import { assertRuntimeVersion, resolveRuntimeAssetForHost } from "./platform";
import { buildRuntimeEnv, verifyRuntime } from "./runtime";
import { TRUSTED_COWORK_RUNTIME_KEYS } from "./trustedKeys";
import type {
  CoworkRuntimeBootstrapProgress,
  CoworkRuntimeSetupResult,
  RuntimeHost,
} from "./types";

export const DEFAULT_COWORK_RUNTIME_REPOSITORY = "mweinbach/cowork-runtime";
export const DEFAULT_COWORK_RUNTIME_VERSION = "2026-06-22";
export const COWORK_RUNTIME_INSTRUCTIONS_HEADING = "## Cowork Runtime";

const DISABLE_ENV = "COWORK_DISABLE_RUNTIME";
const ALLOW_NETWORK_ENV = "COWORK_RUNTIME_ALLOW_NETWORK";
const ARCHIVE_PATH_ENV = "COWORK_RUNTIME_ARCHIVE_PATH";
const ARCHIVE_SHA256_ENV = "COWORK_RUNTIME_ARCHIVE_SHA256";
const REPOSITORY_ENV = "COWORK_RUNTIME_REPOSITORY";
const RELEASE_TAG_ENV = "COWORK_RUNTIME_RELEASE_TAG";
const FORCE_ENV = "COWORK_RUNTIME_FORCE";

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey ? env[actualKey] : undefined;
}

async function setupResult(opts: {
  runtimeDir: string;
  baseEnv: Record<string, string | undefined>;
  source: CoworkRuntimeSetupResult["source"];
  trustedKeys: TrustedRuntimeKeys;
}): Promise<CoworkRuntimeSetupResult> {
  const manifest = await readRuntimeManifest(opts.runtimeDir);
  return {
    runtimeDir: opts.runtimeDir,
    manifest,
    runtimeEnv: await buildRuntimeEnv(
      opts.runtimeDir,
      opts.baseEnv,
      process.platform,
      opts.trustedKeys,
    ),
    source: opts.source,
  };
}

async function verifyInstalledRuntime(opts: {
  runtimeDir: string;
  host?: RuntimeHost;
  env: Record<string, string | undefined>;
  execute: boolean;
  trustedKeys: TrustedRuntimeKeys;
}): Promise<boolean> {
  const verification = await verifyRuntime({
    runtimeDir: opts.runtimeDir,
    execute: opts.execute,
    host: opts.host,
    env: opts.env,
    trustedKeys: opts.trustedKeys,
    cacheTrust: true,
  });
  return verification.ok;
}

async function expectedChecksumForArchive(
  archivePath: string,
  configuredChecksum: string | undefined,
): Promise<string> {
  const configured = configuredChecksum?.trim();
  if (configured) return configured;
  const checksumPath = `${archivePath}.sha256`;
  const raw = await fs.readFile(checksumPath, "utf8").catch(() => null);
  if (!raw) {
    throw new Error(
      `No checksum configured for ${archivePath}. Set ${ARCHIVE_SHA256_ENV} or provide ${checksumPath}.`,
    );
  }
  return checksumFromText(raw, path.basename(archivePath));
}

async function confirmAndActivate(opts: {
  runtimeDir: string;
  home: string;
  host?: RuntimeHost;
  env: Record<string, string | undefined>;
  execute: boolean;
  trustedKeys: TrustedRuntimeKeys;
}): Promise<boolean> {
  if (!(await verifyInstalledRuntime(opts))) return false;
  const manifest = await readRuntimeManifest(opts.runtimeDir);
  await activateInstalledRuntime(manifest.version, opts.home, true);
  await pruneInstalledRuntimes(opts.home, 2);
  return true;
}

async function resolveFallback(opts: {
  home: string;
  host?: RuntimeHost;
  env: Record<string, string | undefined>;
  execute: boolean;
  trustedKeys: TrustedRuntimeKeys;
  log?: (line: string) => void;
}): Promise<string | null> {
  const current = await resolveCurrentRuntime(opts.home).catch(() => null);
  const candidates = [
    ...(current ? [current] : []),
    ...(await listInstalledRuntimes(opts.home)).map((runtime) => runtime.path),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (
      await confirmAndActivate({
        runtimeDir: candidate,
        home: opts.home,
        host: opts.host,
        env: opts.env,
        execute: opts.execute,
        trustedKeys: opts.trustedKeys,
      }).catch(() => false)
    ) {
      opts.log?.(`Using fallback Cowork runtime at ${candidate}`);
      return candidate;
    }
  }
  return null;
}

async function resolveDesiredRuntime(opts: {
  version: string;
  home: string;
  host?: RuntimeHost;
  env: Record<string, string | undefined>;
  execute: boolean;
  force: boolean;
  trustedKeys: TrustedRuntimeKeys;
  log?: (line: string) => void;
}): Promise<CoworkRuntimeSetupResult | null> {
  if (opts.force) return null;
  const runtimeDir = installedRuntimeDir(opts.version, opts.home);
  const stat = await fs.stat(runtimeDir).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const pointer = await readCurrentRuntimePointer(opts.home).catch(() => null);
  const alreadyConfirmed =
    pointer?.version === opts.version && typeof pointer.confirmedAt === "string";
  if (
    !(await confirmAndActivate({
      runtimeDir,
      home: opts.home,
      host: opts.host,
      env: opts.env,
      execute: alreadyConfirmed ? false : opts.execute,
      trustedKeys: opts.trustedKeys,
    }).catch(() => false))
  ) {
    opts.log?.(
      `Installed Cowork runtime ${opts.version} is invalid; attempting a clean replacement.`,
    );
    return null;
  }
  await cleanupLegacyCoworkRuntimes({ home: opts.home, log: opts.log });
  return await setupResult({
    runtimeDir,
    baseEnv: opts.env,
    source: "installed",
    trustedKeys: opts.trustedKeys,
  });
}

export async function ensureCoworkRuntimeReady(
  opts: {
    homedir?: string;
    env?: Record<string, string | undefined>;
    version?: string;
    repository?: string;
    archivePath?: string;
    expectedSha256?: string;
    releaseTag?: string;
    allowNetwork?: boolean;
    force?: boolean;
    execute?: boolean;
    host?: RuntimeHost;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
    onProgress?: (progress: CoworkRuntimeBootstrapProgress) => void;
    trustedKeys?: TrustedRuntimeKeys;
  } = {},
): Promise<CoworkRuntimeSetupResult | null> {
  const env = { ...(opts.env ?? process.env) };
  if (isTruthy(env[DISABLE_ENV])) return null;
  const home = path.resolve(opts.homedir ?? os.homedir());
  const host = opts.host ?? process;
  const execute = opts.execute !== false;
  const trustedKeys = opts.trustedKeys ?? TRUSTED_COWORK_RUNTIME_KEYS;
  const explicitRuntimeDir = env.COWORK_RUNTIME_DIR?.trim();

  if (explicitRuntimeDir) {
    const runtimeDir = path.resolve(explicitRuntimeDir);
    if (!(await verifyInstalledRuntime({ runtimeDir, host, env, execute, trustedKeys }))) {
      throw new Error(`Explicit Cowork runtime failed verification: ${runtimeDir}`);
    }
    await cleanupLegacyCoworkRuntimes({ home, log: opts.log });
    return await setupResult({ runtimeDir, baseEnv: env, source: "explicit", trustedKeys });
  }

  const version = (
    opts.version ??
    env.COWORK_RUNTIME_VERSION ??
    DEFAULT_COWORK_RUNTIME_VERSION
  ).trim();
  assertRuntimeVersion(version);
  let latestProgress: CoworkRuntimeBootstrapProgress | null = null;
  const reportProgress = (progress: CoworkRuntimeBootstrapProgress): void => {
    latestProgress = progress;
    opts.onProgress?.(progress);
  };
  const reportReady = (): void => {
    reportProgress({
      phase: "ready",
      version,
      transferredBytes: latestProgress?.transferredBytes ?? null,
      totalBytes: latestProgress?.totalBytes ?? null,
      percent: latestProgress?.totalBytes ? 100 : (latestProgress?.percent ?? null),
    });
  };
  const desiredDir = installedRuntimeDir(version, home);
  const forceRequested = opts.force === true || isTruthy(env[FORCE_ENV]);
  const existing = await resolveDesiredRuntime({
    version,
    home,
    host,
    env,
    execute,
    force: forceRequested,
    trustedKeys,
    log: opts.log,
  });
  if (existing) return existing;

  const asset = resolveRuntimeAssetForHost(host);
  const archivePath = (opts.archivePath ?? env[ARCHIVE_PATH_ENV])?.trim();
  const repository = (
    opts.repository ??
    env[REPOSITORY_ENV] ??
    DEFAULT_COWORK_RUNTIME_REPOSITORY
  ).trim();
  const releaseTag = (opts.releaseTag ?? env[RELEASE_TAG_ENV])?.trim() || undefined;
  try {
    const result = await withCoworkRuntimeBootstrapLock(
      {
        home,
        version,
        onWait: (owner) => {
          opts.log?.(
            `Waiting for Cowork runtime ${version} bootstrap${owner ? ` owned by process ${owner.pid}` : ""}.`,
          );
          reportProgress({
            phase: "waiting",
            version,
            transferredBytes: null,
            totalBytes: null,
            percent: null,
          });
        },
      },
      async () => {
        const installedByPeer = await resolveDesiredRuntime({
          version,
          home,
          host,
          env,
          execute,
          force: forceRequested,
          trustedKeys,
          log: opts.log,
        });
        if (installedByPeer) return installedByPeer;

        const desiredExists = await fs.stat(desiredDir).catch(() => null);
        const force = forceRequested || Boolean(desiredExists);
        let installed: Awaited<ReturnType<typeof installRuntimeArchive>>;
        if (archivePath) {
          const resolvedArchive = path.resolve(archivePath);
          const archiveBytes = (await fs.stat(resolvedArchive)).size;
          const expectedSha256 = await expectedChecksumForArchive(
            resolvedArchive,
            opts.expectedSha256 ?? env[ARCHIVE_SHA256_ENV],
          );
          reportProgress({
            phase: "installing",
            version,
            transferredBytes: archiveBytes,
            totalBytes: archiveBytes,
            percent: 100,
          });
          installed = await installRuntimeArchive({
            archivePath: resolvedArchive,
            expectedSha256,
            expectedVersion: version,
            expectedAsset: asset,
            home,
            force,
            execute,
            host,
            env,
            log: opts.log,
            trustedKeys,
          });
        } else {
          const allowNetwork =
            opts.allowNetwork ??
            (isTruthy(env[ALLOW_NETWORK_ENV]) || env.COWORK_DESKTOP_BUNDLE === "1");
          if (!allowNetwork) {
            const fallback = await resolveFallback({
              home,
              host,
              env,
              execute,
              trustedKeys,
              log: opts.log,
            });
            if (!fallback)
              opts.log?.("Cowork runtime is unavailable and network bootstrap is disabled.");
            if (!fallback) return null;
            await cleanupLegacyCoworkRuntimes({ home, log: opts.log });
            return await setupResult({
              runtimeDir: fallback,
              baseEnv: env,
              source: "fallback",
              trustedKeys,
            });
          }

          const downloaded = await downloadRuntimeRelease({
            repository,
            version,
            tag: releaseTag,
            asset,
            host,
            fetchImpl: opts.fetchImpl,
            log: opts.log,
            onProgress: reportProgress,
          });
          try {
            reportProgress({
              phase: "installing",
              version,
              transferredBytes: downloaded.downloadedBytes,
              totalBytes: downloaded.totalBytes,
              percent: downloaded.totalBytes ? 100 : null,
            });
            installed = await installRuntimeArchive({
              archivePath: downloaded.archivePath,
              expectedSha256: downloaded.expectedSha256,
              expectedVersion: version,
              expectedAsset: asset,
              home,
              force,
              execute,
              host,
              env,
              log: opts.log,
              trustedKeys,
            });
          } finally {
            await downloaded.cleanup();
          }
        }

        await cleanupLegacyCoworkRuntimes({ home, log: opts.log });
        return await setupResult({
          runtimeDir: installed.runtimeDir,
          baseEnv: env,
          source: "downloaded",
          trustedKeys,
        });
      },
    );
    if (result) reportReady();
    return result;
  } catch (error) {
    opts.log?.(
      `Cowork runtime ${version} could not be installed: ${error instanceof Error ? error.message : String(error)}`,
    );
    const fallback = await resolveFallback({
      home,
      host,
      env,
      execute,
      trustedKeys,
      log: opts.log,
    });
    if (!fallback) return null;
    await cleanupLegacyCoworkRuntimes({ home, log: opts.log });
    const result = await setupResult({
      runtimeDir: fallback,
      baseEnv: env,
      source: "fallback",
      trustedKeys,
    });
    reportReady();
    return result;
  }
}

export async function prepareCoworkRuntimeToolEnv(opts: {
  homedir?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}): Promise<Record<string, string | undefined>> {
  const env = { ...(opts.env ?? process.env) };
  if (isTruthy(env[DISABLE_ENV])) return env;
  const home = path.resolve(opts.homedir ?? os.homedir());
  const explicit = envValue(env, "COWORK_RUNTIME_DIR")?.trim();
  const runtimeDir = explicit
    ? path.resolve(explicit)
    : await resolveCurrentRuntime(home).catch(() => null);
  if (!runtimeDir) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith("COWORK_RUNTIME_")) delete env[key];
    }
    return env;
  }
  try {
    Object.assign(
      env,
      await buildRuntimeEnv(runtimeDir, env, process.platform, TRUSTED_COWORK_RUNTIME_KEYS),
    );
  } catch (error) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith("COWORK_RUNTIME_")) delete env[key];
    }
    opts.log?.(
      `Blocked untrusted Cowork runtime at ${runtimeDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return env;
  }
  opts.log?.(
    `Wired Cowork runtime ${env.COWORK_RUNTIME_VERSION ?? "unknown"} into the tool environment.`,
  );
  return env;
}

export function renderCoworkRuntimeInstructions(
  env: Record<string, string | undefined> | undefined,
): string | null {
  const source = env ?? {};
  const nodeModules = envValue(source, "COWORK_RUNTIME_NODE_MODULES")?.trim();
  if (!nodeModules) return null;
  const node = envValue(source, "COWORK_RUNTIME_NODE")?.trim();
  const python = envValue(source, "COWORK_RUNTIME_PYTHON")?.trim();
  return [
    COWORK_RUNTIME_INSTRUCTIONS_HEADING,
    "",
    "Cowork's versioned runtime is already active for this turn. Its tools and dependencies are immutable shared runtime files; create artifacts in a writable workspace or scratch directory.",
    "Bare Node imports such as `@oai/artifact-tool` resolve through the configured runtime resolver; do not install, copy, link, or search for a second copy.",
    ...(node
      ? [`Use bundled Node at \`${node}\` for document, presentation, and spreadsheet builders.`]
      : []),
    ...(python ? [`Use bundled Python at \`${python}\` when a skill requires Python.`] : []),
    ...(envValue(source, "COWORK_RUNTIME_SOFFICE")?.trim()
      ? [
          `Use the managed headless-only soffice launcher at \`${envValue(source, "COWORK_RUNTIME_SOFFICE")?.trim()}\` for document conversion and visual QA. It blocks UI and printing modes; never bypass it by invoking LibreOffice's private program files.`,
        ]
      : []),
    "Presentations and spreadsheets use `@oai/artifact-tool`; any soffice fallback resolves through the same managed runtime launcher.",
  ].join("\n");
}
