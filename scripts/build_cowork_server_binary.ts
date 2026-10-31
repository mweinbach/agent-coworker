import fs from "node:fs/promises";
import path from "node:path";

import { hostArch, hostPlatform } from "../src/platform/host";
import { WINDOWS_SANDBOX_HELPER_NAME } from "../src/platform/sandbox/windows";
import { isNativeWindowsBinary } from "../src/platform/windowsBinary";
import { SIDECAR_MANIFEST_NAME } from "../src/shared/runtimeProgress";
import {
  copyDir,
  pathExists,
  resolveBuildTarget,
  resolveRustCompileTarget,
  rmrf,
  type runCommand,
} from "./releaseBuildUtils";
import { buildWindowsRustCommandRunner, syncWindowsSandboxHelper } from "./windowsSandboxBundle";
import { computeSourceFingerprint } from "./winSandboxPrebuilt";

const defaultRoot = path.resolve(import.meta.dirname, "..");
const resourceDirs = ["prompts", "config", "docs", "skills", "workflows"] as const;

async function resolveOutputPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await resolveOutputPath(parent), path.basename(target));
  }
}

function containsPath(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function validateOutputDirectory(root: string, outfile: string): Promise<void> {
  const outputDir = await resolveOutputPath(path.dirname(outfile));
  const outputFile = await resolveOutputPath(outfile);
  for (const sourceName of [
    ...resourceDirs,
    "src",
    "crates",
    "scripts",
    "target",
    ".git",
    "package.json",
    "bun.lock",
    "Cargo.toml",
    "Cargo.lock",
  ]) {
    const source = await resolveOutputPath(path.join(root, sourceName));
    if (
      containsPath(source, outputDir) ||
      containsPath(outputDir, source) ||
      containsPath(source, outputFile)
    ) {
      throw new Error(
        `Unsafe server bundle output: ${outfile} overlaps source ${source}. Use dist/ or a separate build directory.`,
      );
    }
  }
}

async function copyBundledResourceDirs(root: string, outDir: string): Promise<string[]> {
  const bundledDirs: string[] = [];
  for (const dir of resourceDirs) {
    const srcDir = path.join(root, dir);
    if (!(await pathExists(srcDir))) {
      continue;
    }
    const dest = path.join(outDir, dir);
    await rmrf(dest);
    await copyDir(srcDir, dest);
    bundledDirs.push(dir);
  }

  return bundledDirs;
}

function parseOutfile(
  root: string,
  argv: string[],
  target: { platform: NodeJS.Platform; arch: string },
): string {
  const defaultName = target.platform === "win32" ? "cowork-server.exe" : "cowork-server";

  const outIndex = argv.findIndex((arg) => arg === "--outfile" || arg === "-o");
  if (outIndex === -1) {
    return path.join(root, "dist", defaultName);
  }

  const value = argv[outIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("Missing value for --outfile");
  }
  return path.isAbsolute(value) ? value : path.join(root, value);
}

async function stageCompiledBinary(opts: {
  src: string;
  dest: string;
  platform: NodeJS.Platform;
  arch: string;
  root: string;
  runner: typeof runCommand;
  isMockedRunner: boolean;
  label: string;
}): Promise<void> {
  await fs.rm(opts.dest, { force: true });
  await fs.copyFile(opts.src, opts.dest);
  if (opts.platform !== "win32") {
    await fs.chmod(opts.dest, 0o755);
  }
  if (!opts.isMockedRunner && opts.platform === "darwin" && hostPlatform() === "darwin") {
    await opts.runner(["codesign", "--force", "--sign", "-", opts.dest], {
      cwd: opts.root,
      env: process.env,
    });
  }
  if (
    !opts.isMockedRunner &&
    opts.platform === "win32" &&
    !isNativeWindowsBinary(opts.dest, opts.arch)
  ) {
    throw new Error(
      `Compiled ${opts.label} is not a native Windows ${opts.arch} executable: ${opts.dest}`,
    );
  }
}

export async function buildServerBinary(
  options: { root?: string; argv?: string[]; commandRunner?: typeof runCommand } = {},
) {
  const root = options.root ?? defaultRoot;
  const argv = options.argv ?? process.argv.slice(2);
  const target = resolveBuildTarget(argv);
  const rustTarget = resolveRustCompileTarget(target.platform, target.arch);
  const outfile = parseOutfile(root, argv, target);
  const outDir = path.dirname(outfile);
  await validateOutputDirectory(root, outfile);
  await fs.mkdir(outDir, { recursive: true });

  const isMockedRunner = Boolean(options.commandRunner);
  const runner = options.commandRunner ?? buildWindowsRustCommandRunner(rustTarget);
  if (target.platform !== hostPlatform() || target.arch !== hostArch()) {
    await runner(["rustup", "target", "add", rustTarget], {
      cwd: root,
      env: process.env,
    });
  }

  await runner(
    [
      "cargo",
      "build",
      "--release",
      "-p",
      "cowork-server",
      "-p",
      "cowork-cli",
      "--target",
      rustTarget,
    ],
    {
      cwd: root,
      env: process.env,
    },
  );

  const cargoTargetDir =
    !isMockedRunner && process.env.CARGO_TARGET_DIR?.trim()
      ? path.resolve(root, process.env.CARGO_TARGET_DIR.trim())
      : path.join(root, "target");
  const releaseDir = path.join(cargoTargetDir, rustTarget, "release");
  const serverExeName = target.platform === "win32" ? "cowork-server.exe" : "cowork-server";
  const cliExeName = target.platform === "win32" ? "cowork.exe" : "cowork";
  const builtServerPath = path.join(releaseDir, serverExeName);
  if (!(await pathExists(builtServerPath))) {
    throw new Error(`Cargo build did not produce ${builtServerPath}`);
  }

  await stageCompiledBinary({
    src: builtServerPath,
    dest: outfile,
    platform: target.platform,
    arch: target.arch,
    root,
    runner,
    isMockedRunner,
    label: "cowork-server",
  });

  const builtCliPath = path.join(releaseDir, cliExeName);
  const cliOutfile = path.join(outDir, cliExeName);
  if (path.resolve(cliOutfile) !== path.resolve(outfile) && (await pathExists(builtCliPath))) {
    await stageCompiledBinary({
      src: builtCliPath,
      dest: cliOutfile,
      platform: target.platform,
      arch: target.arch,
      root,
      runner,
      isMockedRunner,
      label: "cowork",
    });
  }

  const manifest = {
    targetTriple: rustTarget,
    platform: target.platform,
    arch: target.arch,
    launch: {
      kind: "executable" as const,
      path: path.basename(outfile),
    },
  };
  await fs.writeFile(
    path.join(outDir, SIDECAR_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const bundledDirs = await copyBundledResourceDirs(root, outDir);
  if (target.platform === "win32") {
    await syncWindowsSandboxHelper({
      root,
      dest: path.join(outDir, WINDOWS_SANDBOX_HELPER_NAME),
      previousFingerprint: null,
      nextFingerprint: await computeSourceFingerprint(
        path.join(root, "crates", "cowork-win-sandbox"),
      ),
      platform: target.platform,
      arch: target.arch,
      commandRunner: options.commandRunner,
    });
  }

  console.log(`[build] cowork-server binary: ${path.relative(root, outfile)}`);
  console.log(
    `[build] cowork-server resources: ${path.relative(root, outDir)}/{${bundledDirs.join(",")}}`,
  );
}

if (import.meta.main) {
  await buildServerBinary().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
