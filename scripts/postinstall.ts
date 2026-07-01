#!/usr/bin/env bun

import { existsSync } from "node:fs";

const APP_DIRS = ["apps/desktop"] as const;

if (process.env.CI || process.env.SKIP_POSTINSTALL) {
  console.log("[postinstall] skipping sub-app installs (CI/SKIP_POSTINSTALL set)");
  process.exit(0);
}

async function runBunInstall(args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun ${args.join(" ")} exited with code ${code}`);
  }
}

for (const dir of APP_DIRS) {
  if (!existsSync(dir)) {
    console.log(`[postinstall] skipping ${dir}; directory not present in this package.`);
    continue;
  }

  console.log(`[postinstall] installing dependencies in ${dir}`);
  await runBunInstall(["install", "--cwd", dir]);
}
