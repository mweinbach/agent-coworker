import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getAiCoworkerPaths } from "../connect";
import { binaryName, classifyExecutable, which } from "../platform/exec";
import { replaceExecutableAtomic } from "../platform/fs";
import { hostPlatform } from "../platform/host";
import { canonicalizeSync, home } from "../platform/paths";
import { raceWithAbort, withRequestTimeout } from "./abortSignal";
import { execFileCompat } from "./execFileCompat";
import { fileLockRootForCoworkHome, withFileLock } from "./fileLock";
import { sha256FileHex } from "./hash";

export interface EnsureRipgrepOptions {
  homedir?: string;
  log?: (line: string) => void;
  disableDownload?: boolean;
  signal?: AbortSignal;
  /** Bounds this caller's resolution/install wait, without cancelling other callers. */
  timeoutMs?: number;
}

type RipgrepArchiveKind = "zip" | "tar.gz";

type RipgrepAsset = {
  version: string;
  archiveName: string;
  archiveKind: RipgrepArchiveKind;
};

const DEFAULT_RIPGREP_VERSION = "15.1.0";
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

type InstallFlight = {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
};

const inFlight = new Map<string, InstallFlight>();

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function resolveRipgrepAssets(): RipgrepAsset[] {
  const version = (process.env.COWORK_RIPGREP_VERSION || "").trim() || DEFAULT_RIPGREP_VERSION;

  const arch = process.arch;
  const platform = process.platform;

  // Prefer musl builds on Linux for maximum portability.
  if (platform === "linux") {
    if (arch === "x64") {
      return [
        {
          version,
          archiveName: `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`,
          archiveKind: "tar.gz",
        },
        {
          version,
          archiveName: `ripgrep-${version}-x86_64-unknown-linux-gnu.tar.gz`,
          archiveKind: "tar.gz",
        },
      ];
    }
    if (arch === "arm64") {
      return [
        {
          version,
          archiveName: `ripgrep-${version}-aarch64-unknown-linux-musl.tar.gz`,
          archiveKind: "tar.gz",
        },
        {
          version,
          archiveName: `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`,
          archiveKind: "tar.gz",
        },
      ];
    }
  }

  if (platform === "darwin") {
    if (arch === "x64") {
      return [
        {
          version,
          archiveName: `ripgrep-${version}-x86_64-apple-darwin.tar.gz`,
          archiveKind: "tar.gz",
        },
      ];
    }
    if (arch === "arm64") {
      return [
        {
          version,
          archiveName: `ripgrep-${version}-aarch64-apple-darwin.tar.gz`,
          archiveKind: "tar.gz",
        },
      ];
    }
  }

  if (platform === "win32") {
    if (arch === "x64") {
      return [
        {
          version,
          archiveName: `ripgrep-${version}-x86_64-pc-windows-msvc.zip`,
          archiveKind: "zip",
        },
      ];
    }
    if (arch === "arm64") {
      return [
        {
          version,
          archiveName: `ripgrep-${version}-aarch64-pc-windows-msvc.zip`,
          archiveKind: "zip",
        },
      ];
    }
  }

  throw new Error(`Unsupported platform/arch for ripgrep auto-download: ${platform}/${arch}`);
}

const sha256File = sha256FileHex;

function parseSha256File(text: string): string | null {
  const m = text.match(/[0-9a-f]{64}/i);
  return m ? m[0].toLowerCase() : null;
}

function psQuoteSingle(s: string): string {
  // PowerShell single-quoted strings escape ' as ''.
  return `'${s.replace(/'/g, "''")}'`;
}

async function execFileOk(command: string, args: string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const result = await execFileCompat(command, args, {
    maxBuffer: 1024 * 1024 * 10,
    signal,
  });
  signal.throwIfAborted();
  if (result.exitCode !== 0 || result.errorCode) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.errorCode ?? `exit ${result.exitCode}`}): ${result.stderr.trim()}`,
    );
  }
}

async function extractArchive(
  archiveKind: RipgrepArchiveKind,
  archivePath: string,
  destDir: string,
  signal: AbortSignal,
): Promise<void> {
  if (archiveKind === "zip") {
    const cmd = `Expand-Archive -Path ${psQuoteSingle(archivePath)} -DestinationPath ${psQuoteSingle(destDir)} -Force`;
    await execFileOk(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
      signal,
    );
    return;
  }

  await execFileOk("tar", ["-xzf", archivePath, "-C", destDir], signal);
}

async function findFileRecursive(
  dir: string,
  wantedBasename: string,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  signal.throwIfAborted();
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === wantedBasename) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    const found = await findFileRecursive(p, wantedBasename, signal);
    if (found) return found;
  }
  return null;
}

function cancelDiscardedBody(response: Response): void {
  try {
    // An uncooperative cancellation promise must not delay fallback or failure.
    void response.body?.cancel().catch(() => {
      // Keep the original HTTP result when discarded-body cleanup rejects.
    });
  } catch {
    // Preserve the HTTP result if cleanup fails synchronously as well.
  }
}

async function fetchTextAllow404(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  signal.throwIfAborted();
  const res = await fetch(url, { redirect: "follow", signal });
  signal.throwIfAborted();
  if (!res.ok) {
    cancelDiscardedBody(res);
    if (res.status === 404) return { ok: false, status: 404 };
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const text = await res.text();
  signal.throwIfAborted();
  return { ok: true, text };
}

async function fetchToFileAllow404(
  url: string,
  filePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const res = await fetch(url, { redirect: "follow", signal });
  signal.throwIfAborted();
  if (!res.ok) {
    cancelDiscardedBody(res);
    if (res.status === 404) return false;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  signal.throwIfAborted();
  await fs.writeFile(filePath, buf, { signal });
  signal.throwIfAborted();
  return true;
}

async function installRipgrepFromGitHub(
  opts: EnsureRipgrepOptions & { signal: AbortSignal },
  installPath: string,
): Promise<void> {
  const { signal } = opts;
  const assets = resolveRipgrepAssets();
  const lockRoot = fileLockRootForCoworkHome(path.dirname(path.dirname(installPath)));
  let lastErr: unknown = null;

  for (const asset of assets) {
    signal.throwIfAborted();
    const baseUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${asset.version}`;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-rg-"));
    const archivePath = path.join(tmpRoot, asset.archiveName);
    const extractDir = path.join(tmpRoot, "extract");
    let tmpInstall: string | undefined;

    try {
      signal.throwIfAborted();
      await fs.mkdir(extractDir, { recursive: true });
      signal.throwIfAborted();
      opts.log?.(`[ripgrep] downloading ${asset.archiveName}...`);

      const checksumUrl = `${baseUrl}/${asset.archiveName}.sha256`;
      const checksumRes = await fetchTextAllow404(checksumUrl, signal);
      if (!checksumRes.ok) continue;
      const expected = parseSha256File(checksumRes.text);
      if (!expected) throw new Error(`Invalid sha256 file for ${asset.archiveName}`);

      const ok = await fetchToFileAllow404(`${baseUrl}/${asset.archiveName}`, archivePath, signal);
      if (!ok) continue;

      const actual = await sha256File(archivePath);
      signal.throwIfAborted();
      if (actual !== expected) {
        throw new Error(
          `Checksum mismatch for ${asset.archiveName}: expected ${expected}, got ${actual}`,
        );
      }

      opts.log?.(`[ripgrep] extracting...`);
      await extractArchive(asset.archiveKind, archivePath, extractDir, signal);

      const wanted = binaryName("rg");
      const found = await findFileRecursive(extractDir, wanted, signal);
      if (!found) throw new Error(`Failed to locate ${wanted} in extracted ripgrep archive`);

      await fs.mkdir(path.dirname(installPath), { recursive: true, mode: 0o700 });
      signal.throwIfAborted();

      tmpInstall = `${installPath}.tmp-${randomUUID()}`;
      await fs.copyFile(found, tmpInstall, fsConstants.COPYFILE_EXCL);
      signal.throwIfAborted();
      if (hostPlatform() !== "win32") {
        await fs.chmod(tmpInstall, 0o755);
      }

      const candidatePath = tmpInstall;
      await withFileLock(
        installPath,
        async () => {
          signal.throwIfAborted();
          // Another process may have installed the binary while we downloaded.
          if (await isFile(installPath)) return;
          signal.throwIfAborted();
          await replaceExecutableAtomic(candidatePath, installPath, {
            fsImpl: {
              ...fs,
              rename: async (from, to) => {
                // Rollback (an aside -> destination rename) must remain possible
                // after cancellation. Only forward publication is abortable.
                if (from === candidatePath || from === installPath) signal.throwIfAborted();
                await fs.rename(from, to);
              },
            },
            sleepImpl: async (ms) => {
              await delay(ms, undefined, { signal });
            },
          });
        },
        { lockRoot },
      );
      signal.throwIfAborted();
      return;
    } catch (err) {
      signal.throwIfAborted();
      lastErr = err;
    } finally {
      if (tmpInstall) {
        await fs.rm(tmpInstall, { force: true }).catch((error) => {
          opts.log?.(`[ripgrep] failed to clean up ${tmpInstall}: ${String(error)}`);
        });
      }
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      } catch (error) {
        opts.log?.(`[ripgrep] failed to clean up ${tmpRoot}: ${String(error)}`);
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("ripgrep auto-download failed: no matching release asset found");
}

export async function ensureRipgrep(opts: EnsureRipgrepOptions = {}): Promise<string> {
  opts.signal?.throwIfAborted();
  const signal = withRequestTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);

  const resolution = (async (): Promise<string> => {
    const envPathOverride = (process.env.COWORK_RIPGREP_PATH || "").trim();
    if (envPathOverride) {
      if (!(await isFile(envPathOverride))) {
        throw new Error(`COWORK_RIPGREP_PATH does not exist or is not a file: ${envPathOverride}`);
      }
      signal.throwIfAborted();
      return envPathOverride;
    }

    // A PATH-discovered rg that is a .cmd/.bat shim (npm wrappers etc.) cannot be
    // spawned shell-less by the grep tool; prefer the managed native binary instead
    // of handing callers a shim. `.ps1` is equally non-native and skipped too.
    const fromPath = which("rg");
    if (fromPath) {
      if (classifyExecutable(fromPath) === "native") return fromPath;
      opts.log?.(`[ripgrep] ignoring non-native rg shim at ${fromPath}`);
    }

    const homedir = opts.homedir ?? home();
    const coworkPaths = getAiCoworkerPaths({ homedir });
    const binDir = path.join(coworkPaths.rootDir, "bin");

    // The managed install is always the native binary ("rg.exe" on win32, "rg"
    // elsewhere) — .cmd/.bat shims are never installed, so never probed.
    const installPath = path.join(binDir, binaryName("rg"));
    const key = canonicalizeSync(installPath);
    // Register an eligible follower before yielding to filesystem preflight;
    // otherwise cancelling the leader could abort a job the follower needs.
    let flight = opts.disableDownload ? undefined : inFlight.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const installed = await isFile(installPath);
      signal.throwIfAborted();
      if (installed) return installPath;
      if (opts.disableDownload) {
        throw new Error("ripgrep (rg) not found and downloads are disabled");
      }
      flight = inFlight.get(key);
    }
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const promise: Promise<string> = (async () => {
        await installRipgrepFromGitHub({ ...opts, signal: controller.signal }, installPath);
        controller.signal.throwIfAborted();
        if (!(await isFile(installPath))) {
          throw new Error("ripgrep download completed but install path is missing or not a file");
        }
        return installPath;
      })().finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      });
      flight = { promise, controller, waiters: 0 };
      inFlight.set(key, flight);
    }

    flight.waiters += 1;
    try {
      return await raceWithAbort(flight.promise, signal, "ripgrep installation aborted.");
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0) {
        if (inFlight.get(key) === flight) inFlight.delete(key);
        flight.controller.abort();
      }
    }
  })();

  try {
    const result = await raceWithAbort(resolution, signal, "ripgrep installation aborted.");
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}
