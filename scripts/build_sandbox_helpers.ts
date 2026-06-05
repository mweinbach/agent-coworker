import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./releaseBuildUtils";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "dist", "sandbox");

function helperNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === "win32") return "cowork-windows-sandbox.exe";
  if (platform === "darwin") return "cowork-macos-sandbox";
  return "cowork-linux-sandbox";
}

async function buildLinuxHelper(): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await runCommand(
    [
      "cc",
      "-O2",
      "-Wall",
      "-Wextra",
      path.join(root, "native", "sandbox", "cowork-linux-sandbox.c"),
      "-o",
      path.join(outDir, helperNameForPlatform("linux")),
    ],
    { cwd: root, env: process.env },
  );
}

async function main(): Promise<void> {
  if (process.platform === "linux") {
    await buildLinuxHelper();
    console.log(`[build] sandbox helper: ${path.relative(root, outDir)}/cowork-linux-sandbox`);
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  console.log(
    `[build] sandbox helper: ${helperNameForPlatform(
      process.platform,
    )} is provided by the platform-specific native package step`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
