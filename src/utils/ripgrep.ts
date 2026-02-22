import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../connect";

export interface EnsureRipgrepOptions {
  homedir?: string;
  log?: (line: string) => void;
  disableDownload?: boolean;
}

type RipgrepArchiveKind = "zip" | "tar.gz";

type RipgrepAsset = {
  version: string;
  archiveName: string;
  archiveKind: RipgrepArchiveKind;
};

const DEFAULT_RIPGREP_VERSION = "15.1.0";

const inFlight = new Map<string, Promise<string>>();

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function pathKeyFor(opts: EnsureRipgrepOptions): string {
  const home = opts.homedir ?? os.homedir();
  return home;
}

function which(cmd: string): string | null {
  return Bun.which(cmd) ?? null;
}

function resolveRipgrepAssets(): RipgrepAsset[] {
  const version = (process.env.COWORK_RIPGREP_VERSION || "").trim() || DEFAULT_RIPGREP_VERSION;

  const arch = process.arch;
  const platform = process.platform;

  // Prefer musl builds on Linux for maximum portability.
  if (platform === "linux") {
    if (arch === "x64") {
      return [
        { version, archiveName: `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`, archiveKind: "tar.gz" },
        { version, archiveName: `ripgrep-${version}-x86_64-unknown-linux-gnu.tar.gz`, archiveKind: "tar.gz" },
      ];
    }
    if (arch === "arm64") {
      return [
        { version, archiveName: `ripgrep-${version}-aarch64-unknown-linux-musl.tar.gz`, archiveKind: "tar.gz" },
        { version, archiveName: `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`, archiveKind: "tar.gz" },
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

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function fetchToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function parseSha256File(text: string): string | null {
  const m = text.match(/[0-9a-f]{64}/i);
  return m ? m[0].toLowerCase() : null;
}

function psQuoteSingle(s: string): string {
  // PowerShell single-quoted strings escape ' as ''.
  return `'${s.replace(/'/g, "''")}'`;
}

async function execFileOk(command: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd: opts.cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });
}

async function extractArchive(archiveKind: RipgrepArchiveKind, archivePath: string, destDir: string): Promise<void> {
  if (archiveKind === "zip") {
    const cmd =
      `Expand-Archive -Path ${psQuoteSingle(archivePath)} -DestinationPath ${psQuoteSingle(destDir)} -Force`;
    await execFileOk("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd]);
    return;
  }

  await execFileOk("tar", ["-xzf", archivePath, "-C", destDir]);
}

async function findFileRecursive(dir: string, wantedBasename: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === wantedBasename) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    const found = await findFileRecursive(p, wantedBasename);
    if (found) return found;
  }
  return null;
}

async function fetchTextAllow404(url: string): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  const res = await fetch(url, { redirect: "follow" });
  if (res.status === 404) return { ok: false, status: 404 };
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return { ok: true, text: await res.text() };
}

async function fetchToFileAllow404(url: string, filePath: string): Promise<boolean> {
  const res = await fetch(url, { redirect: "follow" });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
  return true;
}

async function installRipgrepFromGitHub(opts: EnsureRipgrepOptions, installPath: string): Promise<void> {
  const assets = resolveRipgrepAssets();
  let lastErr: unknown = null;

  for (const asset of assets) {
    const baseUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${asset.version}`;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-rg-"));
    const archivePath = path.join(tmpRoot, asset.archiveName);
    const extractDir = path.join(tmpRoot, "extract");
    await fs.mkdir(extractDir, { recursive: true });

    try {
      opts.log?.(`[ripgrep] downloading ${asset.archiveName}...`);

      const checksumUrl = `${baseUrl}/${asset.archiveName}.sha256`;
      const checksumRes = await fetchTextAllow404(checksumUrl);
      if (!checksumRes.ok) continue;
      const expected = parseSha256File(checksumRes.text);
      if (!expected) throw new Error(`Invalid sha256 file for ${asset.archiveName}`);

      const ok = await fetchToFileAllow404(`${baseUrl}/${asset.archiveName}`, archivePath);
      if (!ok) continue;

      const actual = await sha256File(archivePath);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset.archiveName}: expected ${expected}, got ${actual}`);
      }

      opts.log?.(`[ripgrep] extracting...`);
      await extractArchive(asset.archiveKind, archivePath, extractDir);

      const wanted = process.platform === "win32" ? "rg.exe" : "rg";
      const found = await findFileRecursive(extractDir, wanted);
      if (!found) throw new Error(`Failed to locate ${wanted} in extracted ripgrep archive`);

      await fs.mkdir(path.dirname(installPath), { recursive: true, mode: 0o700 });

      const tmpInstall = `${installPath}.tmp`;
      await fs.rm(tmpInstall, { force: true }).catch(() => {});
      await fs.copyFile(found, tmpInstall);
      if (process.platform !== "win32") {
        // Ensure executable bit on Unix.
        await fs.chmod(tmpInstall, 0o755).catch(() => {});
      }

      // Replace atomically-ish.
      await fs.rm(installPath, { force: true }).catch(() => {});
      await fs.rename(tmpInstall, installPath);
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("ripgrep auto-download failed: no matching release asset found");
}

export async function ensureRipgrep(opts: EnsureRipgrepOptions = {}): Promise<string> {
  const key = pathKeyFor(opts);
  const existing = inFlight.get(key);
  if (existing) return await existing;

  const p = (async (): Promise<string> => {
    const envPathOverride = (process.env.COWORK_RIPGREP_PATH || "").trim();
    if (envPathOverride) {
      if (!(await isFile(envPathOverride))) {
        throw new Error(`COWORK_RIPGREP_PATH does not exist or is not a file: ${envPathOverride}`);
      }
      return envPathOverride;
    }

    const fromPath = which("rg");
    if (fromPath) return fromPath;

    const homedir = opts.homedir ?? os.homedir();
    const coworkPaths = getAiCoworkerPaths({ homedir });
    const binDir = path.join(coworkPaths.rootDir, "bin");

    const installedCandidates =
      process.platform === "win32"
        ? [path.join(binDir, "rg.exe"), path.join(binDir, "rg.cmd"), path.join(binDir, "rg.bat")]
        : [path.join(binDir, "rg")];
    for (const candidate of installedCandidates) {
      if (await isFile(candidate)) return candidate;
    }

    if (opts.disableDownload) {
      throw new Error("ripgrep (rg) not found and downloads are disabled");
    }

    const installPath = process.platform === "win32" ? path.join(binDir, "rg.exe") : path.join(binDir, "rg");
    await installRipgrepFromGitHub(opts, installPath);
    if (!(await pathExists(installPath))) throw new Error("ripgrep download completed but install path is missing");
    return installPath;
  })()
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, p);
  return await p;
}
