import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type BuildTarget = {
  platform: NodeJS.Platform;
  arch: string;
};

const WINDOWS_ARM64_BUNDLED_BUN_RUNTIME_VERSION = "1.3.13";

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

function formatBuildLogs(logs: Bun.BuildMessage[]): string {
  return logs.map((log) => log.message).join("\n");
}

function isDotNotationEnvName(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name);
}

function buildEnvDefines(
  mode: "inline" | "disable" | `${string}*`,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (mode === "disable") {
    return undefined;
  }

  const prefix = mode === "inline" ? "" : mode.slice(0, -1);
  const defines: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(prefix) || !isDotNotationEnvName(name)) {
      continue;
    }
    defines[`process.env.${name}`] = JSON.stringify(value);
  }

  return Object.keys(defines).length > 0 ? defines : undefined;
}

export async function buildBunBundle(options: {
  entry: string;
  outfile: string;
  env: "inline" | "disable" | `${string}*`;
  minify?: boolean;
}): Promise<void> {
  const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-bun-bundle-"));
  try {
    const result = await Bun.build({
      define: buildEnvDefines(options.env),
      entrypoints: [options.entry],
      env: options.env,
      minify: options.minify ?? true,
      outdir,
      sourcemap: "none",
      splitting: true,
      target: "bun",
    });
    if (!result.success) {
      const logs = formatBuildLogs(result.logs);
      throw new Error(`Bun bundle failed${logs ? `:\n${logs}` : ""}`);
    }

    const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
    if (!output) {
      throw new Error(`Bun bundle did not produce an entry-point output for ${options.entry}`);
    }

    await fs.mkdir(path.dirname(options.outfile), { recursive: true });
    await fs.copyFile(output.path, options.outfile);
    await Promise.all(
      result.outputs
        .filter((artifact) => artifact.path !== output.path)
        .map(async (artifact) => {
          const dest = path.join(
            path.dirname(options.outfile),
            path.relative(outdir, artifact.path),
          );
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(artifact.path, dest);
        }),
    );
  } finally {
    await rmrf(outdir);
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

export function resolveBundledBunRuntimeVersion(
  target: BuildTarget,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.COWORK_BUNDLED_BUN_RUNTIME_VERSION?.trim();
  if (override) {
    return override;
  }
  if (target.platform === "win32" && target.arch === "arm64") {
    return WINDOWS_ARM64_BUNDLED_BUN_RUNTIME_VERSION;
  }
  return Bun.version;
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
  const version = resolveBundledBunRuntimeVersion(target);
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

  await downloadFile(downloadUrl, archivePath);
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
