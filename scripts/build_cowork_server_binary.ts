import fs from "node:fs/promises";
import path from "node:path";

import { WINDOWS_SANDBOX_HELPER_NAME } from "../src/platform/sandbox/windows";
import {
  copyDir,
  pathExists,
  resolveBuildTarget,
  resolveBunCompileTarget,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";
import { syncWindowsSandboxHelper } from "./windowsSandboxBundle";
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
    "scripts",
    ".git",
    "package.json",
    "bun.lock",
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

export async function buildServerBinary(
  options: { root?: string; argv?: string[]; commandRunner?: typeof runCommand } = {},
) {
  const root = options.root ?? defaultRoot;
  const argv = options.argv ?? process.argv.slice(2);
  const target = resolveBuildTarget(argv);
  const compileTarget = resolveBunCompileTarget(target.platform, target.arch);
  const outfile = parseOutfile(root, argv, target);
  const outDir = path.dirname(outfile);
  await validateOutputDirectory(root, outfile);
  await fs.mkdir(outDir, { recursive: true });

  const entry = path.join(root, "src", "server", "index.ts");

  await (options.commandRunner ?? runCommand)(
    [
      process.execPath,
      "build",
      entry,
      "--compile",
      "--target",
      compileTarget,
      "--outfile",
      outfile,
      "--minify",
      "--sourcemap=none",
    ],
    {
      cwd: root,
      env: process.env,
    },
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
