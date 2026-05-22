import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  copyDir,
  ensureBundledBunRuntime,
  pathExists,
  resolveBuildTarget,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";

const SIDECAR_BUN_EXECUTABLE_NAME = "bun.exe";
const SIDECAR_BUN_ENTRYPOINT_PATH = "server/index.js";

function shouldUseBundledBunRuntime(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "win32" && arch === "arm64";
}

const root = path.resolve(import.meta.dirname, "..");

async function resolveCodexPrimaryRuntimeSource(): Promise<string | null> {
  const fromEnv = process.env.COWORK_CODEX_PRIMARY_RUNTIME_DIR?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!(await pathExists(path.join(resolved, "runtime.json")))) {
      throw new Error(
        `COWORK_CODEX_PRIMARY_RUNTIME_DIR does not contain runtime.json: ${resolved}`,
      );
    }
    return resolved;
  }

  const defaultRuntimeDir = path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
  );
  return (await pathExists(path.join(defaultRuntimeDir, "runtime.json")))
    ? defaultRuntimeDir
    : null;
}

async function copyBundledResourceDirs(outDir: string): Promise<string[]> {
  const bundledDirs: string[] = [];
  for (const dir of ["prompts", "config", "docs", "skills"] as const) {
    const srcDir = path.join(root, dir);
    if (!(await pathExists(srcDir))) {
      continue;
    }
    const dest = path.join(outDir, dir);
    await rmrf(dest);
    await copyDir(srcDir, dest);
    bundledDirs.push(dir);
  }

  if (process.env.COWORK_BUNDLE_CODEX_PRIMARY_RUNTIME === "1") {
    const runtimeSource = await resolveCodexPrimaryRuntimeSource();
    if (!runtimeSource) {
      throw new Error(
        "COWORK_BUNDLE_CODEX_PRIMARY_RUNTIME=1 but no Codex primary runtime cache was found. Set COWORK_CODEX_PRIMARY_RUNTIME_DIR or run the Codex runtime setup first.",
      );
    }
    const dest = path.join(outDir, "codex-primary-runtime");
    await rmrf(dest);
    await copyDir(runtimeSource, dest);
    bundledDirs.push("codex-primary-runtime");
  }

  return bundledDirs;
}

function parseOutfile(argv: string[], target: { platform: NodeJS.Platform; arch: string }): string {
  const defaultName =
    target.platform === "win32"
      ? shouldUseBundledBunRuntime(target.platform, target.arch)
        ? "cowork-server.cmd"
        : "cowork-server.exe"
      : "cowork-server";

  const outIndex = argv.findIndex((arg) => arg === "--outfile" || arg === "-o");
  if (outIndex === -1) {
    return path.join(root, "dist", defaultName);
  }

  const value = argv[outIndex + 1];
  if (!value) {
    throw new Error("Missing value for --outfile");
  }
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function resolveBundleLauncherPath(
  outfile: string,
  target: { platform: NodeJS.Platform; arch: string },
): string {
  if (!shouldUseBundledBunRuntime(target.platform, target.arch)) {
    return outfile;
  }

  const parsed = path.parse(outfile);
  const launcherBaseName = parsed.ext ? parsed.name : parsed.base;
  return path.join(path.dirname(outfile), `${launcherBaseName}.cmd`);
}

function buildWindowsBundleLauncher(): string {
  return [
    "@echo off",
    "setlocal",
    'set "SCRIPT_DIR=%~dp0"',
    '"%SCRIPT_DIR%bun.exe" "%SCRIPT_DIR%server\\index.js" %*',
    "",
  ].join("\r\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const target = resolveBuildTarget(argv);
  const outfile = parseOutfile(argv, target);
  const useBundledRuntime = shouldUseBundledBunRuntime(target.platform, target.arch);
  const resolvedOutfile = resolveBundleLauncherPath(outfile, target);
  const outDir = path.dirname(resolvedOutfile);
  await fs.mkdir(outDir, { recursive: true });

  const entry = path.join(root, "src", "server", "index.ts");

  if (useBundledRuntime) {
    const serverEntrypointPath = path.join(outDir, SIDECAR_BUN_ENTRYPOINT_PATH);
    const serverEntrypointDir = path.dirname(serverEntrypointPath);

    await rmrf(outDir);
    await fs.mkdir(serverEntrypointDir, { recursive: true });

    await runCommand(
      [
        "bun",
        "build",
        entry,
        "--outfile",
        serverEntrypointPath,
        "--target",
        "bun",
        "--minify",
        "--sourcemap=none",
      ],
      {
        cwd: root,
        env: process.env,
      },
    );

    const { executablePath, version } = await ensureBundledBunRuntime(root, target);
    await fs.copyFile(executablePath, path.join(outDir, SIDECAR_BUN_EXECUTABLE_NAME));
    await fs.writeFile(resolvedOutfile, buildWindowsBundleLauncher(), "utf8");

    const bundledDirs = await copyBundledResourceDirs(outDir);

    console.log(`[build] cowork-server launcher: ${path.relative(root, resolvedOutfile)}`);
    console.log(
      `[build] cowork-server Bun runtime: ${path.relative(root, path.join(outDir, SIDECAR_BUN_EXECUTABLE_NAME))} (v${version})`,
    );
    console.log(`[build] cowork-server entrypoint: ${path.relative(root, serverEntrypointPath)}`);
    console.log(
      `[build] cowork-server resources: ${path.relative(root, outDir)}/{${bundledDirs.join(",")}}`,
    );
    return;
  }

  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `Cross-compiling cowork-server is unsupported for ${target.platform}/${target.arch} on ${process.platform}/${process.arch}`,
    );
  }

  await runCommand(
    [
      "bun",
      "build",
      entry,
      "--compile",
      "--target",
      "bun",
      "--outfile",
      resolvedOutfile,
      "--minify",
      "--sourcemap=none",
    ],
    {
      cwd: root,
      env: process.env,
    },
  );

  const bundledDirs = await copyBundledResourceDirs(outDir);

  console.log(`[build] cowork-server binary: ${path.relative(root, resolvedOutfile)}`);
  console.log(
    `[build] cowork-server resources: ${path.relative(root, outDir)}/{${bundledDirs.join(",")}}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
