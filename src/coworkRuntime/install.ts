import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { replaceFileAtomic } from "../platform/fs";
import { extractRuntimeArchive, sha256File } from "./archive";
import { type RuntimeBootstrapLock, withCoworkRuntimeBootstrapLock } from "./bootstrapLock";
import { withUnusedRuntime } from "./consumerLease";
import { clearRuntimeAttestation, releaseRuntimeTrust, type TrustedRuntimeKeys } from "./integrity";
import { readRuntimeManifest } from "./manifest";
import { assertRuntimeVersion } from "./platform";
import { verifyRuntime } from "./runtime";
import { TRUSTED_COWORK_RUNTIME_KEYS } from "./trustedKeys";
import type { InstalledRuntimePointer, RuntimeHost } from "./types";

const CURRENT_RUNTIME_FILE = "current.json";

export function coworkRuntimeRoot(home = os.homedir()): string {
  return path.join(path.resolve(home), ".cowork", "runtime");
}

export function installedRuntimeDir(version: string, home = os.homedir()): string {
  assertRuntimeVersion(version);
  return path.join(coworkRuntimeRoot(home), version);
}

async function writeCurrentPointer(root: string, pointer: InstalledRuntimePointer): Promise<void> {
  const destination = path.join(root, CURRENT_RUNTIME_FILE);
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
    await replaceFileAtomic(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readCurrentRuntimePointer(
  home = os.homedir(),
): Promise<InstalledRuntimePointer | null> {
  const pointerPath = path.join(coworkRuntimeRoot(home), CURRENT_RUNTIME_FILE);
  const raw = await fs.readFile(pointerPath, "utf8").catch(() => null);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<InstalledRuntimePointer>;
  if (parsed.schemaVersion !== 1 || typeof parsed.version !== "string") {
    throw new Error(`Invalid current runtime pointer: ${pointerPath}`);
  }
  assertRuntimeVersion(parsed.version);
  return parsed as InstalledRuntimePointer;
}

export async function activateInstalledRuntime(
  version: string,
  home = os.homedir(),
  confirmed = false,
  lock?: RuntimeBootstrapLock,
): Promise<string> {
  return await withCoworkRuntimeBootstrapLock({ home, version, lock }, async () =>
    activateInstalledRuntimeLocked(version, home, confirmed),
  );
}

async function activateInstalledRuntimeLocked(
  version: string,
  home: string,
  confirmed: boolean,
): Promise<string> {
  const root = coworkRuntimeRoot(home);
  const runtimeDir = installedRuntimeDir(version, home);
  const manifest = await readRuntimeManifest(runtimeDir);
  await fs.mkdir(root, { recursive: true });
  const now = new Date().toISOString();
  await writeCurrentPointer(root, {
    schemaVersion: 1,
    version: manifest.version,
    asset: manifest.asset,
    installedAt: now,
    ...(confirmed ? { confirmedAt: now } : {}),
  });
  return runtimeDir;
}

export async function resolveCurrentRuntime(home = os.homedir()): Promise<string | null> {
  const pointer = await readCurrentRuntimePointer(home);
  if (!pointer) return null;
  const runtimeDir = installedRuntimeDir(pointer.version, home);
  const stat = await fs.stat(runtimeDir).catch(() => null);
  return stat?.isDirectory() ? runtimeDir : null;
}

export async function listInstalledRuntimes(
  home = os.homedir(),
): Promise<Array<{ version: string; path: string; current: boolean }>> {
  const root = coworkRuntimeRoot(home);
  const current = await resolveCurrentRuntime(home).catch(() => null);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => {
      const runtimePath = path.join(root, entry.name);
      return { version: entry.name, path: runtimePath, current: current === runtimePath };
    })
    .sort((left, right) => right.version.localeCompare(left.version));
}

export async function pruneInstalledRuntimes(
  home = os.homedir(),
  keep = 2,
  lock?: RuntimeBootstrapLock,
): Promise<Array<{ version: string; path: string }>> {
  return await withCoworkRuntimeBootstrapLock({ home, version: "retention", lock }, async (held) =>
    pruneInstalledRuntimesLocked(home, keep, held),
  );
}

async function pruneInstalledRuntimesLocked(
  home: string,
  keep: number,
  lock: RuntimeBootstrapLock,
): Promise<Array<{ version: string; path: string }>> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("Runtime retention must keep at least one installed version.");
  }
  const installed = await listInstalledRuntimes(home);
  const current = installed.find((runtime) => runtime.current);
  const retained = new Set<string>();
  if (current) retained.add(current.version);
  for (const runtime of installed) {
    if (retained.size >= keep) break;
    retained.add(runtime.version);
  }

  const removed: Array<{ version: string; path: string }> = [];
  for (const runtime of installed) {
    if (retained.has(runtime.version)) continue;
    const deletion = await withUnusedRuntime({ home, runtimeDir: runtime.path, lock }, async () => {
      const before = await fs.lstat(runtime.path);
      if (!before.isDirectory()) throw new Error(`Runtime directory changed: ${runtime.path}`);
      releaseRuntimeTrust(runtime.path);
      await clearRuntimeAttestation(runtime.path);
      const current = await fs.lstat(runtime.path);
      if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino) {
        throw new Error(`Runtime directory changed during retention: ${runtime.path}`);
      }
      await fs.rm(runtime.path, { recursive: true, force: true });
    });
    if (!deletion.used) removed.push({ version: runtime.version, path: runtime.path });
  }
  return removed;
}

type RuntimeArchiveInstallOptions = {
  archivePath: string;
  expectedSha256: string;
  home?: string;
  force?: boolean;
  activate?: boolean;
  execute?: boolean;
  expectedVersion?: string;
  expectedAsset?: string;
  host?: RuntimeHost;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  trustedKeys?: TrustedRuntimeKeys;
  lock?: RuntimeBootstrapLock;
};

export async function installRuntimeArchive(
  opts: RuntimeArchiveInstallOptions,
): Promise<{ runtimeDir: string; version: string; activated: boolean }> {
  const home = path.resolve(opts.home ?? os.homedir());
  return await withCoworkRuntimeBootstrapLock(
    { home, version: opts.expectedVersion ?? "installation", lock: opts.lock },
    async (lock) => installRuntimeArchiveLocked({ ...opts, home, lock }),
  );
}

async function installRuntimeArchiveLocked(
  opts: RuntimeArchiveInstallOptions & { home: string; lock: RuntimeBootstrapLock },
): Promise<{ runtimeDir: string; version: string; activated: boolean }> {
  const archivePath = path.resolve(opts.archivePath);
  const expected = opts.expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("Expected SHA-256 must be 64 hex characters.");
  }
  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    throw new Error(`Runtime archive checksum mismatch (expected ${expected}, got ${actual}).`);
  }

  const home = opts.home;
  const root = coworkRuntimeRoot(home);
  await fs.mkdir(root, { recursive: true });
  const staging = path.join(root, `.staging-${crypto.randomUUID()}`);
  opts.log?.(`Extracting ${archivePath} into ${staging}`);
  await extractRuntimeArchive({ archivePath, destinationDir: staging });

  let backup: string | null = null;
  let destination: string | null = null;
  let promoted = false;
  let result: { runtimeDir: string; version: string; activated: boolean };
  try {
    const stagedVerification = await verifyRuntime({
      runtimeDir: staging,
      deep: true,
      host: opts.host,
      trustedKeys: opts.trustedKeys ?? TRUSTED_COWORK_RUNTIME_KEYS,
    });
    if (!stagedVerification.ok || !stagedVerification.manifest) {
      throw new Error(
        `Extracted runtime failed verification:\n${stagedVerification.errors.join("\n")}`,
      );
    }
    const manifest = stagedVerification.manifest;
    if (opts.expectedVersion && manifest.version !== opts.expectedVersion) {
      throw new Error(
        `Runtime archive contains version ${manifest.version}, expected ${opts.expectedVersion}.`,
      );
    }
    if (opts.expectedAsset && manifest.asset !== opts.expectedAsset) {
      throw new Error(
        `Runtime archive contains asset ${manifest.asset}, expected ${opts.expectedAsset}.`,
      );
    }
    destination = installedRuntimeDir(manifest.version, home);
    const existing = await fs.stat(destination).catch(() => null);
    if (existing && !opts.force) {
      throw new Error(`Runtime ${manifest.version} is already installed at ${destination}.`);
    }
    if (existing) {
      const runtimeDir = destination;
      const replacement = await withUnusedRuntime(
        { home, runtimeDir, lock: opts.lock },
        async () => {
          backup = `${runtimeDir}.replaced-${crypto.randomUUID()}`;
          releaseRuntimeTrust(runtimeDir);
          await clearRuntimeAttestation(runtimeDir);
          await fs.rename(runtimeDir, backup);
        },
      );
      if (replacement.used) {
        throw new Error(
          `Runtime ${manifest.version} is in use by a live Cowork process; stop its consumers before replacing it.`,
        );
      }
    }
    await fs.rename(staging, destination);
    promoted = true;

    const executableVerification = await verifyRuntime({
      runtimeDir: destination,
      deep: true,
      execute: opts.execute !== false,
      host: opts.host,
      env: opts.env,
      trustedKeys: opts.trustedKeys ?? TRUSTED_COWORK_RUNTIME_KEYS,
    });
    if (!executableVerification.ok) {
      throw new Error(
        `Installed runtime failed executable verification:\n${executableVerification.errors.join("\n")}`,
      );
    }

    const activate = opts.activate !== false;
    if (activate) await activateInstalledRuntime(manifest.version, home, true, opts.lock);
    result = { runtimeDir: destination, version: manifest.version, activated: activate };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {
      // Preserve the install failure if its unpromoted staging tree cannot be removed.
    });
    if (destination && promoted) {
      releaseRuntimeTrust(destination);
      await clearRuntimeAttestation(destination);
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {
        // Preserve the install failure if the promoted destination cannot be removed.
      });
    }
    if (destination && backup) {
      await fs.rename(backup, destination).catch(() => {
        // The original install failure remains primary if rollback restoration also fails.
      });
      backup = null;
    }
    throw error;
  } finally {
    // The staging tree is verified before promotion, which leaves an attestation
    // beside a directory that no longer exists once it is renamed or discarded.
    await clearRuntimeAttestation(staging);
  }

  // The verified installation is committed. Retention is housekeeping and must
  // never remove the active runtime if an older executable is still in use.
  try {
    if (backup) await fs.rm(backup, { recursive: true, force: true });
    const removed = await pruneInstalledRuntimes(home, 2, opts.lock);
    for (const runtime of removed) {
      opts.log?.(`Removed expired Cowork runtime ${runtime.version} from ${runtime.path}`);
    }
  } catch (error) {
    opts.log?.(
      `Cowork runtime ${result.version} is installed, but cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  opts.log?.(`Installed Cowork runtime ${result.version} at ${result.runtimeDir}`);
  return result;
}
