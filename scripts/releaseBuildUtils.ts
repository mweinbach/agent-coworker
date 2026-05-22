import fs from "node:fs/promises";
import path from "node:path";

export type BuildTarget = {
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

function parseFlagValue(argv: string[], ...flagNames: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!flagNames.includes(arg)) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    return value;
  }
  return null;
}

function normalizeBuildPlatform(platform: string): NodeJS.Platform {
  const normalized = platform.trim().toLowerCase();
  if (normalized === "windows" || normalized === "win") {
    return "win32";
  }
  if (normalized === "mac" || normalized === "macos" || normalized === "osx") {
    return "darwin";
  }
  if (normalized === "linux") {
    return "linux";
  }
  if (normalized === "win32" || normalized === "darwin") {
    return normalized;
  }
  throw new Error(`Unsupported build platform: ${platform}`);
}

function normalizeBuildArch(arch: string): string {
  const normalized = arch.trim().toLowerCase();
  if (normalized === "amd64") {
    return "x64";
  }
  if (normalized === "aarch64") {
    return "arm64";
  }
  if (normalized === "x64" || normalized === "arm64") {
    return normalized;
  }
  throw new Error(`Unsupported build architecture: ${arch}`);
}

export function resolveBuildTarget(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): BuildTarget {
  const envPlatform = env.COWORK_BUILD_PLATFORM?.trim() ? env.COWORK_BUILD_PLATFORM : undefined;
  const envArch = env.COWORK_BUILD_ARCH?.trim() ? env.COWORK_BUILD_ARCH : undefined;
  const explicitPlatform =
    parseFlagValue(argv, "--target-platform", "--platform") ??
    (argv.includes("--windows") ? "win32" : null) ??
    (argv.includes("--mac") ? "darwin" : null) ??
    (argv.includes("--linux") ? "linux" : null);
  const explicitArch =
    parseFlagValue(argv, "--target-arch", "--arch") ??
    (argv.includes("--arm64") ? "arm64" : null) ??
    (argv.includes("--x64") ? "x64" : null);

  return {
    platform: normalizeBuildPlatform(explicitPlatform ?? envPlatform ?? process.platform),
    arch: normalizeBuildArch(explicitArch ?? envArch ?? process.arch),
  };
}

export async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

export async function runCommand(
  command: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: options.env ?? process.env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

function psQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function extractZipArchive(archivePath: string, destDir: string): Promise<void> {
  if (process.platform === "win32") {
    const command = `Expand-Archive -Path ${psQuoteSingle(archivePath)} -DestinationPath ${psQuoteSingle(destDir)} -Force`;
    await runCommand(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      { cwd: path.dirname(destDir) },
    );
    return;
  }

  await runCommand(["unzip", "-oq", archivePath, "-d", destDir], { cwd: path.dirname(destDir) });
}

async function extractTarGzArchive(archivePath: string, destDir: string): Promise<void> {
  await runCommand(["tar", "-xzf", archivePath, "-C", destDir], { cwd: path.dirname(destDir) });
}

async function findFileRecursive(dir: string, wantedBasename: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === wantedBasename) {
      return path.join(dir, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const found = await findFileRecursive(path.join(dir, entry.name), wantedBasename);
    if (found) {
      return found;
    }
  }

  return null;
}

function resolveBunRuntimeAssetName(target: BuildTarget): string {
  if (target.platform === "win32" && target.arch === "x64") {
    return "bun-windows-x64.zip";
  }
  if (target.platform === "win32" && target.arch === "arm64") {
    return "bun-windows-aarch64.zip";
  }
  if (target.platform === "darwin" && target.arch === "x64") {
    return "bun-darwin-x64.zip";
  }
  if (target.platform === "darwin" && target.arch === "arm64") {
    return "bun-darwin-aarch64.zip";
  }
  if (target.platform === "linux" && target.arch === "x64") {
    return "bun-linux-x64.zip";
  }
  if (target.platform === "linux" && target.arch === "arm64") {
    return "bun-linux-aarch64.zip";
  }
  throw new Error(`Unsupported Bun runtime bundle target: ${target.platform}/${target.arch}`);
}

function codexReleaseTag(version: string): string {
  const normalized = version.trim();
  if (!normalized) {
    throw new Error("Codex app-server version cannot be empty");
  }
  return normalized.startsWith("rust-v") ? normalized : `rust-v${normalized}`;
}

function normalizeCodexReleaseVersion(tagName: string): string {
  return tagName.startsWith("rust-v") ? tagName.slice("rust-v".length) : tagName;
}

function resolveCodexAppServerAssetName(target: BuildTarget): string {
  if (target.platform === "darwin" && target.arch === "x64") {
    return "codex-app-server-x86_64-apple-darwin.tar.gz";
  }
  if (target.platform === "darwin" && target.arch === "arm64") {
    return "codex-app-server-aarch64-apple-darwin.tar.gz";
  }
  if (target.platform === "linux" && target.arch === "x64") {
    return "codex-app-server-x86_64-unknown-linux-musl.tar.gz";
  }
  if (target.platform === "linux" && target.arch === "arm64") {
    return "codex-app-server-aarch64-unknown-linux-musl.tar.gz";
  }
  if (target.platform === "win32" && target.arch === "x64") {
    return "codex-app-server-x86_64-pc-windows-msvc.exe";
  }
  if (target.platform === "win32" && target.arch === "arm64") {
    return "codex-app-server-aarch64-pc-windows-msvc.exe";
  }
  throw new Error(`Unsupported Codex app-server bundle target: ${target.platform}/${target.arch}`);
}

async function fetchCodexRelease(opts: { version?: string }): Promise<{
  tagName: string;
  version: string;
  assets: GitHubReleaseAsset[];
}> {
  const url = opts.version
    ? `https://api.github.com/repos/openai/codex/releases/tags/${codexReleaseTag(opts.version)}`
    : "https://api.github.com/repos/openai/codex/releases/latest";
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-coworker-desktop-build",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to read Codex release metadata from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const release = (await response.json()) as GitHubReleaseResponse;
  const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!tagName) {
    throw new Error(`Codex release metadata from ${url} did not include a tag_name`);
  }
  const assets = Array.isArray(release.assets)
    ? release.assets.filter((asset): asset is GitHubReleaseAsset => Boolean(asset))
    : [];
  return { tagName, version: normalizeCodexReleaseVersion(tagName), assets };
}

function findReleaseAsset(assets: GitHubReleaseAsset[], assetName: string): string {
  const asset = assets.find((candidate) => candidate.name === assetName);
  const downloadUrl = asset?.browser_download_url;
  if (typeof downloadUrl !== "string" || !downloadUrl) {
    throw new Error(`Codex release did not include required asset ${assetName}`);
  }
  return downloadUrl;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "agent-coworker-desktop-build",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(dest, data);
}

export async function ensureBundledBunRuntime(
  root: string,
  target: BuildTarget,
): Promise<{ executablePath: string; version: string }> {
  const assetName = resolveBunRuntimeAssetName(target);
  const version = Bun.version;
  const cacheDir = path.join(
    root,
    "dist",
    ".bun-runtime-cache",
    `bun-v${version}`,
    `${target.platform}-${target.arch}`,
  );
  const bundledExecutablePath = path.join(
    cacheDir,
    target.platform === "win32" ? "bun.exe" : "bun",
  );

  if (await pathExists(bundledExecutablePath)) {
    return { executablePath: bundledExecutablePath, version };
  }

  const downloadUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${assetName}`;
  const archivePath = path.join(cacheDir, assetName);
  const extractDir = path.join(cacheDir, "extract");

  await rmrf(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download Bun runtime from ${downloadUrl}: ${response.status} ${response.statusText}`,
    );
  }

  await Bun.write(archivePath, response);
  await fs.mkdir(extractDir, { recursive: true });
  await extractZipArchive(archivePath, extractDir);

  const extractedExecutablePath = await findFileRecursive(
    extractDir,
    path.basename(bundledExecutablePath),
  );
  if (!extractedExecutablePath) {
    throw new Error(`Unable to find ${path.basename(bundledExecutablePath)} in ${assetName}`);
  }

  await fs.copyFile(extractedExecutablePath, bundledExecutablePath);
  await rmrf(extractDir);
  await fs.rm(archivePath, { force: true });

  return { executablePath: bundledExecutablePath, version };
}

export async function ensureBundledCodexAppServer(
  root: string,
  target: BuildTarget,
  opts: { version?: string; outputName: string },
): Promise<{ executablePath: string; version: string; assetName: string }> {
  const release = await fetchCodexRelease({ version: opts.version });
  const assetName = resolveCodexAppServerAssetName(target);
  const cacheDir = path.join(
    root,
    "dist",
    ".codex-app-server-cache",
    `codex-v${release.version}`,
    `${target.platform}-${target.arch}`,
  );
  const bundledExecutablePath = path.join(cacheDir, opts.outputName);

  if (await pathExists(bundledExecutablePath)) {
    return { executablePath: bundledExecutablePath, version: release.version, assetName };
  }

  const downloadUrl = findReleaseAsset(release.assets, assetName);
  const assetPath = path.join(cacheDir, assetName);
  const extractDir = path.join(cacheDir, "extract");

  await rmrf(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });
  await downloadFile(downloadUrl, assetPath);

  if (assetName.endsWith(".tar.gz")) {
    await fs.mkdir(extractDir, { recursive: true });
    await extractTarGzArchive(assetPath, extractDir);
    const extractedExecutablePath =
      (await findFileRecursive(extractDir, "codex-app-server")) ??
      (await findFileRecursive(extractDir, assetName.slice(0, -".tar.gz".length)));
    if (!extractedExecutablePath) {
      throw new Error(`Unable to find codex-app-server in ${assetName}`);
    }
    await fs.copyFile(extractedExecutablePath, bundledExecutablePath);
    await fs.chmod(bundledExecutablePath, 0o755);
    await rmrf(extractDir);
    await fs.rm(assetPath, { force: true });
  } else {
    await fs.rename(assetPath, bundledExecutablePath);
  }

  return { executablePath: bundledExecutablePath, version: release.version, assetName };
}
