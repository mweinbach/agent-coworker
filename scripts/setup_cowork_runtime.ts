#!/usr/bin/env bun

import { ensureCoworkRuntimeReady } from "../src/coworkRuntime";

const result = await ensureCoworkRuntimeReady({
  allowNetwork: true,
  force: process.argv.includes("--force"),
  log: (line) => console.log(`[cowork-runtime] ${line}`),
});

if (!result) {
  throw new Error("Cowork runtime setup did not resolve a usable runtime.");
}

console.log(
  JSON.stringify(
    {
      runtimeDir: result.runtimeDir,
      version: result.manifest.version,
      asset: result.manifest.asset,
      source: result.source,
    },
    null,
    2,
  ),
);
