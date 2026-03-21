import fs from "node:fs/promises";
import path from "node:path";

export type BuildTarget = {
  platform: NodeJS.Platform;
  arch: string;
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
  env: NodeJS.ProcessEnv = process.env
): BuildTarget {
  const envPlatform = env.COWORK_BUILD_PLATFORM?.trim() ? env.COWORK_BUILD_PLATFORM : undefined;
  const envArch = env.COWORK_BUILD_ARCH?.trim() ? env.COWORK_BUILD_ARCH : undefined;
  const explicitPlatform =
    parseFlagValue(argv, "--target-platform", "--platform")
    ?? (argv.includes("--windows") ? "win32" : null)
    ?? (argv.includes("--mac") ? "darwin" : null)
    ?? (argv.includes("--linux") ? "linux" : null);
  const explicitArch =
    parseFlagValue(argv, "--target-arch", "--arch")
    ?? (argv.includes("--arm64") ? "arm64" : null)
    ?? (argv.includes("--x64") ? "x64" : null);

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
  const anyFs = fs as typeof fs & {
    cp?: (src: string, dest: string, options?: { recursive?: boolean }) => Promise<void>;
  };
  if (typeof anyFs.cp === "function") {
    await anyFs.cp(src, dest, { recursive: true });
    return;
  }

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
  }
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
    const command =
      `Expand-Archive -Path ${psQuoteSingle(archivePath)} -DestinationPath ${psQuoteSingle(destDir)} -Force`;
    await runCommand(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: path.dirname(destDir) }
    );
    return;
  }

  await runCommand(["unzip", "-oq", archivePath, "-d", destDir], { cwd: path.dirname(destDir) });
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

export async function ensureBundledBunRuntime(
  root: string,
  target: BuildTarget
): Promise<{ executablePath: string; version: string }> {
  const assetName = resolveBunRuntimeAssetName(target);
  const version = Bun.version;
  const cacheDir = path.join(root, "dist", ".bun-runtime-cache", `bun-v${version}`, `${target.platform}-${target.arch}`);
  const bundledExecutablePath = path.join(cacheDir, target.platform === "win32" ? "bun.exe" : "bun");

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
    throw new Error(`Failed to download Bun runtime from ${downloadUrl}: ${response.status} ${response.statusText}`);
  }

  await Bun.write(archivePath, response);
  await fs.mkdir(extractDir, { recursive: true });
  await extractZipArchive(archivePath, extractDir);

  const extractedExecutablePath = await findFileRecursive(extractDir, path.basename(bundledExecutablePath));
  if (!extractedExecutablePath) {
    throw new Error(`Unable to find ${path.basename(bundledExecutablePath)} in ${assetName}`);
  }

  await fs.copyFile(extractedExecutablePath, bundledExecutablePath);
  await rmrf(extractDir);
  await fs.rm(archivePath, { force: true });

  return { executablePath: bundledExecutablePath, version };
}
