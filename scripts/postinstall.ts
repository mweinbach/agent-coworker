#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { ensureCodexPrimaryRuntimeReady } from "../src/codexPrimaryRuntime";

const APP_DIRS = ["apps/desktop"] as const;

if (process.env.CI || process.env.SKIP_POSTINSTALL) {
  console.log("[postinstall] skipping sub-app installs (CI/SKIP_POSTINSTALL set)");
  process.exit(0);
}

await ensureCodexPrimaryRuntimeReady({
  workspaceDir: process.cwd(),
  builtInSkillsDir: path.join(process.cwd(), "skills"),
  allowNetwork: true,
  log: (line) => console.log(`[postinstall] ${line}`),
});

function runBunInstall(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`bun ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

for (const dir of APP_DIRS) {
  if (!existsSync(dir)) {
    console.log(`[postinstall] skipping ${dir}; directory not present in this package.`);
    continue;
  }

  console.log(`[postinstall] installing dependencies in ${dir}`);
  await runBunInstall(["install", "--cwd", dir]);
}
