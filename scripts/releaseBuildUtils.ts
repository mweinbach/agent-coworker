import fs from "node:fs/promises";
import path from "node:path";

export type BuildTarget = {
  platform: NodeJS.Platform;
  arch: string;
};

const RM_MAX_RETRIES = 10;
const RM_RETRY_DELAY_MS = 100;

export interface RmrfDeps {
  rmImpl?: (target: string, options: Parameters<typeof fs.rm>[1]) => Promise<void>;
}

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

export function resolveBunCompileTarget(platform: NodeJS.Platform, arch: string): string {
  let bunPlatform: "darwin" | "windows" | "linux";
  switch (platform) {
    case "darwin":
      bunPlatform = "darwin";
      break;
    case "win32":
      bunPlatform = "windows";
      break;
    case "linux":
      bunPlatform = "linux";
      break;
    default:
      throw new Error(
        `Unsupported Bun executable target platform: ${platform}; supported platforms are darwin, win32, and linux`,
      );
  }

  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(
      `Unsupported Bun executable target architecture: ${arch}; supported architectures are x64 and arm64`,
    );
  }

  return `bun-${bunPlatform}-${arch}`;
}

export async function rmrf(target: string, deps: RmrfDeps = {}): Promise<void> {
  await (deps.rmImpl ?? fs.rm)(target, {
    recursive: true,
    force: true,
    maxRetries: RM_MAX_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
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

export async function extractZipArchive(archivePath: string, destDir: string): Promise<void> {
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

export async function findFileRecursive(
  dir: string,
  wantedBasename: string,
): Promise<string | null> {
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
