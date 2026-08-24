import fs from "node:fs/promises";
import path from "node:path";

import {
  copyDir,
  pathExists,
  resolveBuildTarget,
  resolveBunCompileTarget,
  rmrf,
  runCommand,
} from "./releaseBuildUtils";

const root = path.resolve(import.meta.dirname, "..");

async function copyBundledResourceDirs(outDir: string): Promise<string[]> {
  const bundledDirs: string[] = [];
  for (const dir of ["prompts", "config", "docs", "skills", "workflows"] as const) {
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

function parseOutfile(argv: string[], target: { platform: NodeJS.Platform; arch: string }): string {
  const defaultName = target.platform === "win32" ? "cowork-server.exe" : "cowork-server";

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

async function main() {
  const argv = process.argv.slice(2);
  const target = resolveBuildTarget(argv);
  const compileTarget = resolveBunCompileTarget(target.platform, target.arch);
  const outfile = parseOutfile(argv, target);
  const outDir = path.dirname(outfile);
  await fs.mkdir(outDir, { recursive: true });

  const entry = path.join(root, "src", "server", "index.ts");

  await runCommand(
    [
      "bun",
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

  const bundledDirs = await copyBundledResourceDirs(outDir);

  console.log(`[build] cowork-server binary: ${path.relative(root, outfile)}`);
  console.log(
    `[build] cowork-server resources: ${path.relative(root, outDir)}/{${bundledDirs.join(",")}}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
