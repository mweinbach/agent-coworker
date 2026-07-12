import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchWithGitHubAuth } from "../extensions/github";
import { resolveAuthHomeDir } from "../utils/authHome";
import { execFileCompat } from "../utils/execFileCompat";
import { sha256FileHex } from "../utils/hash";
import { type StreamingSubprocess, spawnStreamingSubprocess } from "../utils/subprocess";

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
  pinnedVersion?: string;
  pinMatchesCurrent?: boolean;
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
  promoteManagedInstall?: (
    executablePath: string,
    currentPath: string,
    version: string,
    target: { platform: NodeJS.Platform; arch: string },
  ) => Promise<void>;
  homeDir?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /**
   * Test-only override of the expected per-asset SHA-256 checksums. Production
   * always verifies against the repo-pinned {@link CODEX_APP_SERVER_MANAGED_CHECKSUMS}.
   */
  expectedChecksums?: Record<string, string>;
};

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CODEX_ARGS = ["app-server"] as const;
const CODEX_RELEASES_LATEST_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const CODEX_RELEASE_TAG_URL = "https://api.github.com/repos/openai/codex/releases/tags";
const CODEX_USER_AGENT = "agent-coworker-codex-app-server-runtime";
const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const CODEX_APP_SERVER_MANAGED_VERSION = "0.144.0";
const MANAGED_CODEX_APP_SERVER_ARGS: readonly string[] = [];
const inFlightInstalls = new Map<string, Promise<CodexAppServerCommand>>();

/**
 * Repo-pinned SHA-256 checksums for the managed Codex app-server release assets.
 * The repository is the trust anchor: downloaded release bytes are verified
 * against these BEFORE extraction, promotion, or execution, so a compromised,
 * swapped, or corrupted upstream release asset fails closed instead of being
 * spawned as the Cowork user.
 *
 * Keyed by release version, then by exact platform asset name. When bumping
 * {@link CODEX_APP_SERVER_MANAGED_VERSION}, add the new version's asset checksums
 * here — both the app-server binary and its codex-code-mode-host companion,
 * which the app-server spawns from its own directory for code-mode tool
 * routing. They are the GitHub release asset `digest` values, obtainable with:
 *   gh api repos/openai/codex/releases/tags/rust-v<version> \
 *     --jq '.assets[] | "\(.name) \(.digest)"'
 */
const CODEX_APP_SERVER_MANAGED_CHECKSUMS: Record<string, Record<string, string>> = {
  "0.144.0": {
    "codex-app-server-aarch64-apple-darwin.tar.gz":
      "982f3a687dc8266580770da68dfe661d7a4825773737f23a7e74e15ab0866da9",
    "codex-app-server-x86_64-apple-darwin.tar.gz":
      "e358b666be9f0d9dd2b0c1678ec0b9b0ef621df68ba0a4f91e7879a4da400561",
    "codex-app-server-aarch64-unknown-linux-musl.tar.gz":
      "eebfa18d883c76874dd3c16ecc2cf914ba22c89418e97a6a5ef81c3b9786ac92",
    "codex-app-server-x86_64-unknown-linux-musl.tar.gz":
      "3ea7c729d7c5107ba53fef17ba1f74ed19078b79f7bafd16eafc4a3576362187",
    "codex-app-server-aarch64-pc-windows-msvc.exe":
      "3eee2fbd3b9ec94709a84699dc86d39b2ba6d895882f42b3809aaabb9530b3a2",
    "codex-app-server-x86_64-pc-windows-msvc.exe":
      "197f96d25723726cfc060a7accdba3708d3fc38dbbb11c46c96fd217b8595fb3",
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz":
      "6cf9282430befe541369c7cb2804604a7f0dd9416f3a3241e3676db22022a246",
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz":
      "6fd2b21d9737f90d9cd047da717d378e58009c0c069b5ecd4fb86ebcfef52d1f",
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz":
      "2ab25695f61ac23a71e467425322a1f197ea52e9da9aa8e0cbc339d661c6d16a",
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz":
      "26d9c65c5a947c2bf489513ef7f81e027b0c96dc15e2781de6eed5e02a18993d",
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe":
      "21d78b37b846ef2557bd4eb2e73ee48daf9fdea71cf2a7c41c048ff2064631a7",
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe":
      "66c351f09fb6a28d71c3186252293e2e410820f07d38bfbdc9e6bf6e2c47c510",
  },
  "0.142.3": {
    "codex-app-server-aarch64-apple-darwin.tar.gz":
      "69167dbcbfa6c2bfa6cffd9f3aab785fbf5f7ea655e1b2ac5a47fa5aec0bb6ed",
    "codex-app-server-x86_64-apple-darwin.tar.gz":
      "e487988361d6f8989dad27b90d3e46e1fcb166ea2829110568a46ed25e88dab9",
    "codex-app-server-aarch64-unknown-linux-musl.tar.gz":
      "9b740bac5a60ddef384bb1d059ed35ebfbc654b383d4d1b0efa1d8acfad53b9c",
    "codex-app-server-x86_64-unknown-linux-musl.tar.gz":
      "ddae454998bd40ddd76fa53a5cdf6ef29f99486596ce29fd00a8a153e73a1574",
    "codex-app-server-aarch64-pc-windows-msvc.exe":
      "881b27a314232586bf6d5b9ad0a2b5a914aec878f33403776eb61eae24177174",
    "codex-app-server-x86_64-pc-windows-msvc.exe":
      "2acff195682a52bbcccb19a1e67c8f0cdc1850e98c58b1d2bde4d52c36b13680",
  },
  "0.136.0": {
    "codex-app-server-aarch64-apple-darwin.tar.gz":
      "408ebc00ce914f4130a831a1c3f3f06f6be635992dc37432ed25fd294446d8d1",
    "codex-app-server-x86_64-apple-darwin.tar.gz":
      "00841273e0d6a01f8380e9c33ffd80a2ccbd889b123ee87e49f7ccf5d855570e",
    "codex-app-server-aarch64-unknown-linux-musl.tar.gz":
      "3fea169ff5b150862d298bd862da927a8fb864cf0e9e521fb9d409c27ae5b443",
    "codex-app-server-x86_64-unknown-linux-musl.tar.gz":
      "bf80cb4437f87cc8f724e62f48c0b7e7279e1d44ec8e85cf60fa95450be9970b",
    "codex-app-server-aarch64-pc-windows-msvc.exe":
      "5973564695689f7b5251e87460c31695ba12c855ad5280e8eeeb9e4b3166e58d",
    "codex-app-server-x86_64-pc-windows-msvc.exe":
      "cdb0df36287c24c8f0a037087ec5fc0bb85cebb8d1433951969ce7cd56e8a972",
  },
};

function expectedCodexAssetChecksum(
  version: string,
  assetName: string,
  overrides: CodexAppServerResolverOverrides,
): string | undefined {
  return (
    overrides.expectedChecksums?.[assetName] ??
    CODEX_APP_SERVER_MANAGED_CHECKSUMS[version]?.[assetName]
  );
}

async function verifyDownloadedAssetChecksum(opts: {
  assetPath: string;
  assetName: string;
  version: string;
  overrides: CodexAppServerResolverOverrides;
}): Promise<void> {
  const expected = expectedCodexAssetChecksum(opts.version, opts.assetName, opts.overrides);
  if (!expected) {
    throw new Error(
      `Refusing to install Codex app-server ${opts.version}: no pinned SHA-256 checksum for asset ${opts.assetName}.`,
    );
  }
  const actual = await sha256FileHex(opts.assetPath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Codex app-server asset ${opts.assetName} failed checksum verification ` +
        `(expected ${expected}, got ${actual}).`,
    );
  }
}

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

const CODE_MODE_HOST_BASENAME = "codex-code-mode-host";

function resolveCodeModeHostAssetName(target: BuildTarget): string {
  const triple = resolveTargetTriple(target);
  return target.platform === "win32"
    ? `${CODE_MODE_HOST_BASENAME}-${triple}.exe`
    : `${CODE_MODE_HOST_BASENAME}-${triple}.tar.gz`;
}

/**
 * The app-server spawns codex-code-mode-host from its own directory, so the
 * host binary must live next to whichever app-server executable gets spawned
 * (the versioned path on win32, the promoted current path elsewhere).
 */
function codeModeHostSiblingPath(appServerExecutablePath: string, target: BuildTarget): string {
  const ext = target.platform === "win32" ? ".exe" : "";
  return path.join(path.dirname(appServerExecutablePath), `${CODE_MODE_HOST_BASENAME}${ext}`);
}

function normalizeCodexReleaseVersion(tagName: string): string {
  return tagName.startsWith("rust-v") ? tagName.slice("rust-v".length) : tagName;
}

function normalizeCodexVersionInput(version: string): string {
  const normalized = normalizeCodexReleaseVersion(version.trim());
  if (!CODEX_VERSION_PATTERN.test(normalized)) {
    throw new Error("Codex app-server version must look like 0.144.0.");
  }
  return normalized;
}

function codexReleaseTag(version: string): string {
  return `rust-v${normalizeCodexVersionInput(version)}`;
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

function managedCommand(command: string, version?: string): CodexAppServerCommand {
  return {
    command,
    args: [...MANAGED_CODEX_APP_SERVER_ARGS],
    source: "managed",
    ...(version ? { version } : {}),
  };
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

async function defaultSpawnForResult(command: string, args: string[]): Promise<ProcessResult> {
  const result = await execFileCompat(command, args, {
    env: process.env,
    timeoutMs: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.errorCode === "TIMEOUT") {
    return { ok: false, stdout: result.stdout, stderr: result.stderr, error: "Timed out." };
  }
  if (result.errorCode) {
    return {
      ok: false,
      stdout: result.stdout,
      stderr: result.stderr,
      error: `${command} failed (${result.errorCode}).`,
    };
  }
  return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
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
  if (process.env.NODE_ENV !== "test") return null;
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

async function resolveInstalledManagedVersionCommand(
  version: string,
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand | null> {
  const normalizedVersion = normalizeCodexVersionInput(version);
  const target = currentTarget(overrides);
  const homeDir = overrides.homeDir ?? resolveAuthHomeDir();
  const executablePath = managedExecutablePath(homeDir, normalizedVersion, target);
  if (!(await pathExists(executablePath))) return null;
  return managedCommand(
    executablePath,
    (await readVersionFile(executablePath)) ?? normalizedVersion,
  );
}

async function resolvePinnedManagedCommand(
  version: string,
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand> {
  const normalizedVersion = normalizeCodexVersionInput(version);
  const target = currentTarget(overrides);
  const homeDir = overrides.homeDir ?? resolveAuthHomeDir();
  const existing = await resolveInstalledManagedVersionCommand(normalizedVersion, overrides);
  if (!existing) return await installCodexAppServer({ version: normalizedVersion }, overrides);

  if (await codeModeHostNeedsInstall(existing.command, normalizedVersion, target, overrides)) {
    try {
      return await installCodexAppServer({ version: normalizedVersion }, overrides);
    } catch {
      // Repairing the missing code-mode host needs release metadata; when that
      // fetch fails (e.g. offline), fall back to the verified app-server
      // install rather than blocking runtime startup.
    }
  }

  const currentPath = managedCurrentPath(homeDir, target);
  await promoteManagedInstallBestEffort(
    existing.command,
    currentPath,
    normalizedVersion,
    target,
    overrides,
  );
  await pruneManagedVersions(homeDir);
  return managedCommand(
    target.platform === "win32" ? existing.command : currentPath,
    normalizedVersion,
  );
}

async function resolveManagedCommand(
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand | null> {
  const target = currentTarget(overrides);
  const homeDir = overrides.homeDir ?? resolveAuthHomeDir();
  const versioned = await listManagedVersionCommands(homeDir, target);
  if (target.platform === "win32" && versioned[0]) return versioned[0];

  const command = managedCurrentPath(homeDir, target);
  if (await pathExists(command)) return managedCommand(command, await readVersionFile(command));
  return versioned[0] ?? null;
}

async function fetchCodexRelease(
  opts: { version?: string },
  overrides: CodexAppServerResolverOverrides = {},
): Promise<{ tagName: string; version: string; assets: GitHubReleaseAsset[] }> {
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const url = opts.version
    ? `${CODEX_RELEASE_TAG_URL}/${codexReleaseTag(opts.version)}`
    : CODEX_RELEASES_LATEST_URL;
  const response = await fetchWithGitHubAuth(fetchImpl, url, { "User-Agent": CODEX_USER_AGENT });
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
  const result = await execFileCompat("tar", ["-xzf", archivePath, "-C", destDir], {
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.errorCode) {
    throw new Error(
      `Failed to extract Codex app-server archive: ${result.stderr.trim() || (result.errorCode ?? `exit ${result.exitCode}`)}`,
    );
  }
}

let installTmpCounter = 0;

/**
 * Downloads one release asset, verifies it against the pinned checksum, and
 * installs the contained executable at destPath via an atomic rename so a
 * concurrently running app-server never observes a partially written binary.
 */
async function installReleaseExecutable(opts: {
  assets: GitHubReleaseAsset[];
  assetName: string;
  wantedBasename: string;
  destPath: string;
  version: string;
  tempRoot: string;
  target: BuildTarget;
  overrides: CodexAppServerResolverOverrides;
}): Promise<void> {
  const downloadUrl = findReleaseAsset(opts.assets, opts.assetName);
  const assetPath = path.join(opts.tempRoot, opts.assetName);
  await downloadFile(downloadUrl, assetPath, opts.overrides);
  // Verify the downloaded bytes against the repo-pinned checksum BEFORE the
  // asset is extracted, copied to the managed path, made executable, or
  // promoted for spawn. A mismatch (or a version with no pinned checksum)
  // fails closed so a compromised release asset is never executed.
  await verifyDownloadedAssetChecksum({
    assetPath,
    assetName: opts.assetName,
    version: opts.version,
    overrides: opts.overrides,
  });
  let sourcePath = assetPath;
  if (opts.assetName.endsWith(".tar.gz")) {
    const extractDir = path.join(opts.tempRoot, `extract-${opts.wantedBasename}`);
    await fs.mkdir(extractDir, { recursive: true });
    await extractTarGz(assetPath, extractDir);
    const extracted =
      (await findFileRecursive(extractDir, opts.wantedBasename)) ??
      (await findFileRecursive(extractDir, opts.assetName.slice(0, -".tar.gz".length)));
    if (!extracted) throw new Error(`Unable to find ${opts.wantedBasename} in ${opts.assetName}.`);
    sourcePath = extracted;
  }
  const tmpDest = `${opts.destPath}.tmp-${process.pid}-${++installTmpCounter}`;
  await fs.copyFile(sourcePath, tmpDest);
  if (opts.target.platform !== "win32") await fs.chmod(tmpDest, 0o755);
  await fs.rename(tmpDest, opts.destPath);
}

/**
 * Installs the codex-code-mode-host companion next to the app-server binary.
 * Skipped for release versions with no pinned host checksum (older releases
 * did not ship or need the host); a mismatch on a pinned version fails closed.
 */
async function installCodeModeHost(opts: {
  release: { version: string; assets: GitHubReleaseAsset[] };
  appServerExecutablePath: string;
  tempRoot: string;
  target: BuildTarget;
  overrides: CodexAppServerResolverOverrides;
}): Promise<void> {
  const assetName = resolveCodeModeHostAssetName(opts.target);
  if (!expectedCodexAssetChecksum(opts.release.version, assetName, opts.overrides)) return;
  const destPath = codeModeHostSiblingPath(opts.appServerExecutablePath, opts.target);
  if (await pathExists(destPath)) return;
  await installReleaseExecutable({
    assets: opts.release.assets,
    assetName,
    wantedBasename: CODE_MODE_HOST_BASENAME,
    destPath,
    version: opts.release.version,
    tempRoot: opts.tempRoot,
    target: opts.target,
    overrides: opts.overrides,
  });
}

/**
 * Repairs an already-installed managed version that predates the code-mode
 * host requirement. Best-effort: the app-server binary was already verified
 * and works without the host (code-mode tools degrade), so a failed repair
 * download must not break runtime startup.
 */
async function repairCodeModeHostBestEffort(opts: {
  release: { version: string; assets: GitHubReleaseAsset[] };
  appServerExecutablePath: string;
  target: BuildTarget;
  overrides: CodexAppServerResolverOverrides;
}): Promise<void> {
  const tempRoot = path.join(
    os.tmpdir(),
    `cowork-codex-code-mode-host-${process.pid}-${++installTmpCounter}`,
  );
  try {
    await fs.mkdir(tempRoot, { recursive: true });
    await installCodeModeHost({ ...opts, tempRoot });
  } catch {
    // Best-effort repair only; a checksum mismatch or download failure leaves
    // the host uninstalled (fail closed) without blocking the verified
    // app-server install.
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function codeModeHostNeedsInstall(
  appServerExecutablePath: string,
  version: string,
  target: BuildTarget,
  overrides: CodexAppServerResolverOverrides,
): Promise<boolean> {
  const assetName = resolveCodeModeHostAssetName(target);
  if (!expectedCodexAssetChecksum(version, assetName, overrides)) return false;
  return !(await pathExists(codeModeHostSiblingPath(appServerExecutablePath, target)));
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

async function listManagedVersionCommands(
  homeDir: string,
  target: BuildTarget,
): Promise<CodexAppServerCommand[]> {
  const versionsDir = path.join(managedRoot(homeDir), "versions");
  try {
    const entries = await fs.readdir(versionsDir, { withFileTypes: true });
    const commands: CodexAppServerCommand[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const command = managedExecutablePath(homeDir, entry.name, target);
      if (!(await pathExists(command))) continue;
      commands.push(managedCommand(command, (await readVersionFile(command)) ?? entry.name));
    }
    commands.sort((left, right) => -compareVersions(left.version, right.version));
    return commands;
  } catch {
    return [];
  }
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

function isWindowsPromotionLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function promoteManagedInstallBestEffort(
  executablePath: string,
  currentPath: string,
  version: string,
  target: BuildTarget,
  overrides: CodexAppServerResolverOverrides,
): Promise<void> {
  const promote = overrides.promoteManagedInstall ?? promoteManagedInstall;
  try {
    await promote(executablePath, currentPath, version, target);
  } catch (error) {
    if (target.platform !== "win32" || !isWindowsPromotionLockError(error)) throw error;
    await fs.rm(`${currentPath}.tmp`, { force: true }).catch(() => {});
    await fs.rm(`${currentPath}.version.tmp`, { force: true }).catch(() => {});
    await fs
      .rm(`${codeModeHostSiblingPath(currentPath, target)}.tmp`, { force: true })
      .catch(() => {});
  }
}

async function installCodexAppServer(
  opts: { version?: string; force?: boolean } = {},
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand> {
  const target = currentTarget(overrides);
  const homeDir = overrides.homeDir ?? resolveAuthHomeDir();
  const release = await fetchCodexRelease(
    { ...(opts.version ? { version: normalizeCodexVersionInput(opts.version) } : {}) },
    overrides,
  );
  const executablePath = managedExecutablePath(homeDir, release.version, target);
  const currentPath = managedCurrentPath(homeDir, target);
  const key = `${homeDir}-${target.platform}-${target.arch}-${release.version}`;
  const existing = await pathExists(executablePath);
  if (existing && !opts.force) {
    await repairCodeModeHostBestEffort({
      release,
      appServerExecutablePath: executablePath,
      target,
      overrides,
    });
    await promoteManagedInstallBestEffort(
      executablePath,
      currentPath,
      release.version,
      target,
      overrides,
    );
    await pruneManagedVersions(homeDir);
    return managedCommand(
      target.platform === "win32" ? executablePath : currentPath,
      release.version,
    );
  }

  const inFlight = inFlightInstalls.get(key);
  if (inFlight) return await inFlight;

  const installPromise: Promise<CodexAppServerCommand> = (async () => {
    const parent = path.dirname(executablePath);
    const tempRoot = path.join(os.tmpdir(), `cowork-codex-app-server-${process.pid}-${Date.now()}`);
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(tempRoot, { recursive: true });
    try {
      // Install the code-mode host companion first so a failure never leaves a
      // resolvable app-server binary without its host: if the host install
      // throws, the whole install fails and retries from scratch next time.
      await installCodeModeHost({
        release,
        appServerExecutablePath: executablePath,
        tempRoot,
        target,
        overrides,
      });
      await installReleaseExecutable({
        assets: release.assets,
        assetName: resolveCodexAppServerAssetName(target),
        wantedBasename: "codex-app-server",
        destPath: executablePath,
        version: release.version,
        tempRoot,
        target,
        overrides,
      });
      await fs.writeFile(`${executablePath}.version`, `${release.version}\n`, "utf8");
      await promoteManagedInstallBestEffort(
        executablePath,
        currentPath,
        release.version,
        target,
        overrides,
      );
      await pruneManagedVersions(homeDir);
      return managedCommand(
        target.platform === "win32" ? executablePath : currentPath,
        release.version,
      );
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
  const hostSourcePath = codeModeHostSiblingPath(executablePath, target);
  if (await pathExists(hostSourcePath)) {
    const hostCurrentPath = codeModeHostSiblingPath(currentPath, target);
    const hostTmpPath = `${hostCurrentPath}.tmp`;
    await fs.copyFile(hostSourcePath, hostTmpPath);
    if (target.platform !== "win32") await fs.chmod(hostTmpPath, 0o755);
    await fs.rename(hostTmpPath, hostCurrentPath);
  }
}

export async function resolveCodexAppServerCommand(
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerCommand> {
  const override = await resolveOverrideCommand(overrides);
  if (override) return override;
  return await resolvePinnedManagedCommand(CODEX_APP_SERVER_MANAGED_VERSION, overrides);
}

export async function getCodexAppServerInstallStatus(
  _opts: { checkLatest?: boolean } = {},
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerInstallStatus> {
  const pinnedVersion = CODEX_APP_SERVER_MANAGED_VERSION;
  const command =
    (await resolveOverrideCommand(overrides)) ??
    (await resolveInstalledManagedVersionCommand(pinnedVersion, overrides));
  if (!command) {
    return {
      available: false,
      source: "missing",
      pinnedVersion,
      pinMatchesCurrent: false,
      message: `Cowork-managed Codex runtime ${pinnedVersion} has not been downloaded yet. Account sign-in can still be connected; Cowork will download the runtime before first Codex turn.`,
    };
  }
  const pinMatchesCurrent = command.source === "managed" && command.version === pinnedVersion;
  return {
    available: true,
    source: command.source,
    command: command.command,
    args: command.args,
    version: command.version,
    pinnedVersion,
    pinMatchesCurrent,
    ...(command.source === "managed" ? { managedPath: command.command } : {}),
    message:
      command.source === "system"
        ? "Using the Codex installation on PATH."
        : command.source === "managed"
          ? `Using Cowork-managed Codex runtime ${pinnedVersion}.`
          : "Using explicit Codex runtime override.",
  };
}

export async function updateManagedCodexAppServer(
  opts: { force?: boolean } = {},
  overrides: CodexAppServerResolverOverrides = {},
): Promise<CodexAppServerInstallStatus> {
  const command = await installCodexAppServer(
    { version: CODEX_APP_SERVER_MANAGED_VERSION, force: opts.force },
    overrides,
  );
  const pinMatchesCurrent =
    command.source === "managed" && command.version === CODEX_APP_SERVER_MANAGED_VERSION;
  return {
    available: true,
    source: command.source,
    command: command.command,
    args: command.args,
    version: command.version,
    pinnedVersion: CODEX_APP_SERVER_MANAGED_VERSION,
    pinMatchesCurrent,
    ...(command.source === "managed" ? { managedPath: command.command } : {}),
    message: `Installed Cowork-managed Codex runtime ${
      command.version ?? CODEX_APP_SERVER_MANAGED_VERSION
    }.`,
  };
}

export function spawnCodexAppServer(
  command: CodexAppServerCommand,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): StreamingSubprocess {
  return spawnStreamingSubprocess([command.command, ...command.args], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: opts.env ?? process.env,
    stdin: "pipe",
  });
}

export const __internal = {
  parseCodexVersion,
  compareVersions,
  resolveCodexAppServerAssetName,
  resolveCodeModeHostAssetName,
  codeModeHostSiblingPath,
  expectedCodexAssetChecksum,
  managedExecutablePath,
  managedCurrentPath,
  installCodexAppServer,
  resolveInstalledManagedVersionCommand,
  resolvePinnedManagedCommand,
  resolveSystemCodexCandidates,
  resolveSystemCommand,
  resolveManagedCommand,
} as const;
