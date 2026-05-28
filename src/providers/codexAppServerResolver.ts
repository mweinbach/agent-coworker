import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveAuthHomeDir } from "../utils/authHome";

type CodexAppServerSource = "override" | "system" | "managed";

export type CodexAppServerCommand = {
  command: string;
  args: string[];
  source: CodexAppServerSource;
  version?: string;
};

export type CodexAppServerInstallStatus = {
  available: boolean;
  source: CodexAppServerSource | "missing";
  command?: string;
  args?: string[];
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  managedPath?: string;
  message: string;
};

type BuildTarget = {
  platform: NodeJS.Platform;
  arch: string;
};

type GitHubReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GitHubReleaseResponse = {
  tag_name?: unknown;
  assets?: unknown;
};

type ProcessResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

export type CodexAppServerResolverOverrides = {
  fetchImpl?: typeof fetch;
  spawnForResult?: (command: string, args: string[]) => Promise<ProcessResult>;
  spawnAppServer?: typeof spawn;
  homeDir?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CODEX_ARGS = ["app-server"] as const;
const CODEX_RELEASES_LATEST_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const CODEX_RELEASE_TAG_URL = "https://api.github.com/repos/openai/codex/releases/tags";
const CODEX_USER_AGENT = "agent-coworker-codex-app-server-runtime";
const inFlightInstalls = new Map<string, Promise<CodexAppServerCommand>>();

function normalizeBuildArch(arch: string): string {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new Error(`Unsupported Codex app-server architecture: ${arch}`);
}

function currentTarget(overrides: CodexAppServerResolverOverrides = {}): BuildTarget {
  return {
    platform: overrides.platform ?? process.platform,
    arch: normalizeBuildArch(overrides.arch ?? process.arch),
  };
}

function resolveTargetTriple(target: BuildTarget): string {
  if (target.platform === "win32") {
    if (target.arch === "x64") return "x86_64-pc-windows-msvc";
    if (target.arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  if (target.platform === "darwin") {
    if (target.arch === "x64") return "x86_64-apple-darwin";
    if (target.arch === "arm64") return "aarch64-apple-darwin";
  }
  if (target.platform === "linux") {
    if (target.arch === "x64") return "x86_64-unknown-linux-musl";
    if (target.arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  throw new Error(`Unsupported Codex app-server target: ${target.platform}/${target.arch}`);
}

function resolveCodexAppServerAssetName(target: BuildTarget): string {
  const triple = resolveTargetTriple(target);
  return target.platform === "win32"
    ? `codex-app-server-${triple}.exe`
    : `codex-app-server-${triple}.tar.gz`;
}

function normalizeCodexReleaseVersion(tagName: string): string {
  return tagName.startsWith("rust-v") ? tagName.slice("rust-v".length) : tagName;
}

function codexReleaseTag(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) throw new Error("Codex app-server version cannot be empty.");
  return trimmed.startsWith("rust-v") ? trimmed : `rust-v${trimmed}`;
}

function managedRoot(homeDir: string): string {
  return path.join(homeDir, ".cowork", "codex-app-server");
}

function managedExecutablePath(homeDir: string, version: string, target: BuildTarget): string {
  const ext = target.platform === "win32" ? ".exe" : "";
  return path.join(
    managedRoot(homeDir),
    "versions",
    version,
    `${target.platform}-${target.arch}`,
    `codex-app-server${ext}`,
  );
}

function managedCurrentPath(homeDir: string, target: BuildTarget): string {
  const ext = target.platform === "win32" ? ".exe" : "";
  return path.join(
    managedRoot(homeDir),
    "current",
    `${target.platform}-${target.arch}`,
    `codex-app-server${ext}`,
  );
}

function parseCodexVersion(output: string): string | undefined {
  const match = output.match(/(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const leftParts = a.split(/[.-]/);
  const rightParts = b.split(/[.-]/);
  const maxLen = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLen; index += 1) {
    const leftRaw = leftParts[index];
    const rightRaw = rightParts[index];
    if (leftRaw === undefined && rightRaw !== undefined) return 1;
    if (leftRaw !== undefined && rightRaw === undefined) return -1;
    const leftNum = Number.parseInt(leftRaw ?? "", 10);
    const rightNum = Number.parseInt(rightRaw ?? "", 10);
    const leftIsNum = !Number.isNaN(leftNum);
    const rightIsNum = !Number.isNaN(rightNum);
    if (leftIsNum && rightIsNum) {
      if (leftNum !== rightNum) return leftNum > rightNum ? 1 : -1;
    } else if (!leftIsNum && !rightIsNum) {
      if (leftRaw !== rightRaw) return (leftRaw ?? "") > (rightRaw ?? "") ? 1 : -1;
    } else {
      return leftIsNum ? 1 : -1;
    }
  }
  return 0;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function isNodeModulesBinPath(candidateDir: string): boolean {
  const parts = path.resolve(candidateDir).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === "node_modules" && parts[index + 1] === ".bin") return true;
  }
  return false;
}

function codexExecutableNames(platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [DEFAULT_CODEX_COMMAND];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return [DEFAULT_CODEX_COMMAND, ...extensions.map((ext) => `${DEFAULT_CODEX_COMMAND}${ext}`)];
}

async function resolveSystemCodexCandidates(
  overrides: CodexAppServerResolverOverrides,
): Promise<string[]> {
  const pathEnv = overrides.pathEnv ?? process.env.PATH ?? "";
  const platform = overrides.platform ?? process.platform;
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const rawDir of pathEnv.split(path.delimiter)) {
    if (!rawDir || isNodeModulesBinPath(rawDir)) continue;
    const dir = path.resolve(rawDir);
    for (const executableName of codexExecutableNames(platform)) {
      const candidate = path.join(dir, executableName);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (await pathExists(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

function defaultSpawnForResult(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr, error: "Timed out." });
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr, error: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function readVersionFile(executablePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(`${executablePath}.version`, "utf8");
    return raw.trim() || undefined;
  } catch {
    return undefined;
  }
}

function splitArgs(raw: string): string[] {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // ignore
    }
  }
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s'"]+)/g;
  const args: string[] = [];
  let match = regex.exec(raw);
  while (match !== null) {
    if (match[1] !== undefined) {
      args.push(match[1].replace(/\\"/g, '"'));
    } else if (match[2] !== undefined) {
      args.push(match[2].replace(/\\'/g, "'"));
    } else if (match[3] !== undefined) {
      args.push(match[3]);
    }
    match = regex.exec(raw);
  }
  return args;
}

async function resolveOverrideCommand(
  _overrides: CodexAppServerResolverOverrides,
): Promise<CodexAppServerCommand | null> {
  const command = process.env.COWORK_CODEX_APP_SERVER_COMMAND?.trim();
  const rawArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS?.trim();
  if (!command) return null;
  return {
    command,
    args: rawArgs ? splitArgs(rawArgs) : [],
    source: "override",
  };
}

async function resolveSystemCommand(
  overrides: CodexAppServerResolverOverrides,
): Promise<CodexAppServerCommand | null> {
  const spawnForResult = overrides.spawnForResult ?? defaultSpawnForResult;
  for (const command of await resolveSystemCodexCandidates(overrides)) {
    const versionResult = await spawnForResult(command, ["--version"]);
    if (!versionResult.ok) continue;
    const appServerResult = await spawnForResult(command, ["app-server", "--help"]);
    if (!appServerResult.ok) continue;
    return {
      command,
      args: [...DEFAULT_CODEX_ARGS],
      source: "system",
      version: parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`),
    };
  }
  return null;
}

async function resolveManagedCommand(
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand | null> {
  const target = currentTarget(overrides);
  const homeDir = overrides.homeDir ?? resolveAuthHomeDir();
  const command = managedCurrentPath(homeDir, target);
  if (!(await pathExists(command))) return null;
  return {
    command,
    args: [],
    source: "managed",
    version: await readVersionFile(command),
  };
}

async function fetchCodexRelease(
  opts: { version?: string },
  overrides: CodexAppServerResolverOverrides = {},
): Promise<{ tagName: string; version: string; assets: GitHubReleaseAsset[] }> {
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const url = opts.version
    ? `${CODEX_RELEASE_TAG_URL}/${codexReleaseTag(opts.version)}`
    : CODEX_RELEASES_LATEST_URL;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": CODEX_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to read Codex app-server release metadata: ${response.status} ${response.statusText}`,
    );
  }

  const release = (await response.json()) as GitHubReleaseResponse;
  const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!tagName) throw new Error("Codex app-server release metadata did not include tag_name.");
  const assets = Array.isArray(release.assets)
    ? release.assets.filter((asset): asset is GitHubReleaseAsset => Boolean(asset))
    : [];
  return { tagName, version: normalizeCodexReleaseVersion(tagName), assets };
}

function findReleaseAsset(assets: GitHubReleaseAsset[], assetName: string): string {
  const asset = assets.find((candidate) => candidate.name === assetName);
  const downloadUrl = asset?.browser_download_url;
  if (typeof downloadUrl !== "string" || !downloadUrl) {
    throw new Error(`Codex app-server release did not include required asset ${assetName}.`);
  }
  return downloadUrl;
}

async function downloadFile(
  url: string,
  dest: string,
  overrides: CodexAppServerResolverOverrides = {},
): Promise<void> {
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": CODEX_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download Codex app-server: ${response.status} ${response.statusText}`,
    );
  }
  await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to extract Codex app-server archive: ${stderr.trim()}`));
      }
    });
  });
}

async function findFileRecursive(dir: string, wantedBasename: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === wantedBasename) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileRecursive(path.join(dir, entry.name), wantedBasename);
    if (found) return found;
  }
  return null;
}

async function pruneManagedVersions(homeDir: string): Promise<void> {
  const versionsDir = path.join(managedRoot(homeDir), "versions");
  try {
    const entries = await fs.readdir(versionsDir, { withFileTypes: true });
    const versionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (versionDirs.length <= 3) return;
    versionDirs.sort(compareVersions);
    const toPrune = versionDirs.slice(0, versionDirs.length - 3);
    for (const v of toPrune) {
      await fs.rm(path.join(versionsDir, v), { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

async function installCodexAppServer(
  opts: { version?: string; force?: boolean } = {},
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand> {
  const target = currentTarget(overrides);
  const homeDir = overrides.homeDir ?? resolveAuthHomeDir();
  const release = await fetchCodexRelease({ version: opts.version }, overrides);
  const executablePath = managedExecutablePath(homeDir, release.version, target);
  const currentPath = managedCurrentPath(homeDir, target);
  const key = `${homeDir}-${target.platform}-${target.arch}-${release.version}`;
  const existing = await pathExists(executablePath);
  if (existing && !opts.force) {
    await promoteManagedInstall(executablePath, currentPath, release.version, target);
    await pruneManagedVersions(homeDir);
    return { command: currentPath, args: [], source: "managed", version: release.version };
  }

  const inFlight = inFlightInstalls.get(key);
  if (inFlight) return await inFlight;

  const installPromise: Promise<CodexAppServerCommand> = (async () => {
    const assetName = resolveCodexAppServerAssetName(target);
    const downloadUrl = findReleaseAsset(release.assets, assetName);
    const parent = path.dirname(executablePath);
    const tempRoot = path.join(os.tmpdir(), `cowork-codex-app-server-${process.pid}-${Date.now()}`);
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(tempRoot, { recursive: true });
    try {
      const assetPath = path.join(tempRoot, assetName);
      await downloadFile(downloadUrl, assetPath, overrides);
      if (assetName.endsWith(".tar.gz")) {
        const extractDir = path.join(tempRoot, "extract");
        await fs.mkdir(extractDir, { recursive: true });
        await extractTarGz(assetPath, extractDir);
        const extracted =
          (await findFileRecursive(extractDir, "codex-app-server")) ??
          (await findFileRecursive(extractDir, assetName.slice(0, -".tar.gz".length)));
        if (!extracted) throw new Error(`Unable to find codex-app-server in ${assetName}.`);
        await fs.copyFile(extracted, executablePath);
        await fs.chmod(executablePath, 0o755);
      } else {
        await fs.copyFile(assetPath, executablePath);
      }
      await fs.writeFile(`${executablePath}.version`, `${release.version}\n`, "utf8");
      await promoteManagedInstall(executablePath, currentPath, release.version, target);
      await pruneManagedVersions(homeDir);
      return {
        command: currentPath,
        args: [],
        source: "managed" as const,
        version: release.version,
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  })();

  inFlightInstalls.set(key, installPromise);
  try {
    return await installPromise;
  } finally {
    inFlightInstalls.delete(key);
  }
}

async function promoteManagedInstall(
  executablePath: string,
  currentPath: string,
  version: string,
  target: BuildTarget,
): Promise<void> {
  await fs.mkdir(path.dirname(currentPath), { recursive: true });
  const tmpPath = `${currentPath}.tmp`;
  await fs.copyFile(executablePath, tmpPath);
  if (target.platform !== "win32") await fs.chmod(tmpPath, 0o755);
  await fs.rename(tmpPath, currentPath);
  const tmpVersionPath = `${currentPath}.version.tmp`;
  await fs.writeFile(tmpVersionPath, `${version}\n`, "utf8");
  await fs.rename(tmpVersionPath, `${currentPath}.version`);
}

export async function resolveCodexAppServerCommand(
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand> {
  const override = await resolveOverrideCommand(overrides);
  if (override) return override;
  const managed = await resolveManagedCommand(overrides);
  if (managed) return managed;
  try {
    return await installCodexAppServer({}, overrides);
  } catch (error) {
    const system = await resolveSystemCommand(overrides);
    if (system) return system;
    throw error;
  }
}

export async function getCodexAppServerInstallStatus(
  opts: { checkLatest?: boolean } = {},
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerInstallStatus> {
  const latest = opts.checkLatest ? await fetchCodexRelease({}, overrides).catch(() => null) : null;
  const command =
    (await resolveOverrideCommand(overrides)) ??
    (await resolveManagedCommand(overrides)) ??
    (await resolveSystemCommand(overrides));
  if (!command) {
    return {
      available: false,
      source: "missing",
      latestVersion: latest?.version,
      message: "Codex app-server is not installed. Cowork will download it before first use.",
    };
  }
  const updateAvailable = compareVersions(command.version, latest?.version) < 0;
  return {
    available: true,
    source: command.source,
    command: command.command,
    args: command.args,
    version: command.version,
    latestVersion: latest?.version,
    updateAvailable,
    ...(command.source === "managed" ? { managedPath: command.command } : {}),
    message:
      command.source === "system"
        ? "Using the Codex installation on PATH."
        : command.source === "managed"
          ? "Using Cowork-managed Codex app-server."
          : "Using explicit Codex app-server override.",
  };
}

export async function updateManagedCodexAppServer(
  opts: { version?: string; force?: boolean } = {},
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerInstallStatus> {
  const command = await installCodexAppServer(opts, overrides);
  const latest = opts.version ? null : await fetchCodexRelease({}, overrides).catch(() => null);
  return {
    available: true,
    source: command.source,
    command: command.command,
    args: command.args,
    version: command.version,
    latestVersion: latest?.version ?? command.version,
    updateAvailable: compareVersions(command.version, latest?.version ?? command.version) < 0,
    managedPath: command.command,
    message: `Installed Cowork-managed Codex app-server ${command.version ?? "latest"}.`,
  };
}

export function spawnCodexAppServer(
  command: CodexAppServerCommand,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
  return spawn(command.command, command.args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export const __internal = {
  parseCodexVersion,
  compareVersions,
  resolveCodexAppServerAssetName,
  managedExecutablePath,
  managedCurrentPath,
  installCodexAppServer,
  resolveSystemCodexCandidates,
  resolveSystemCommand,
  resolveManagedCommand,
} as const;
