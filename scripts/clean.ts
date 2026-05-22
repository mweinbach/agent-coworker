#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanTargets = [
  "dist",
  path.join("apps", "desktop", "out"),
  path.join("apps", "desktop", "release"),
  path.join("apps", "desktop", "resources", "binaries"),
  ".tsbuildinfo-harness",
  path.join("apps", "desktop", ".tsbuildinfo-desktop"),
] as const;

const dryRun = process.argv.includes("--dry-run");

for (const target of cleanTargets) {
  const absoluteTarget = path.join(repoRoot, target);
  if (dryRun) {
    console.log(`[clean] would remove ${path.relative(repoRoot, absoluteTarget)}`);
    continue;
  }
  await fs.rm(absoluteTarget, { recursive: true, force: true });
  console.log(`[clean] removed ${path.relative(repoRoot, absoluteTarget)}`);
}
