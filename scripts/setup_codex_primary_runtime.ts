#!/usr/bin/env bun

import path from "node:path";

import { ensureCodexPrimaryRuntimeReady } from "../src/codexPrimaryRuntime";

const force = process.argv.includes("--force");

const result = await ensureCodexPrimaryRuntimeReady({
  workspaceDir: process.cwd(),
  builtInSkillsDir: path.join(process.cwd(), "skills"),
  allowNetwork: true,
  force,
  log: (line) => console.log(`[codex-primary-runtime] ${line}`),
});

if (!result) {
  console.log("[codex-primary-runtime] bootstrap skipped by environment");
  process.exit(0);
}

console.log(JSON.stringify(result, null, 2));
