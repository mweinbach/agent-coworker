#!/usr/bin/env bun

import { ensureArtifactRuntimeReady } from "../src/artifactRuntime";

const force = process.argv.includes("--force");

const result = await ensureArtifactRuntimeReady({
  allowNetwork: true,
  force,
  log: (line) => console.log(`[artifact-runtime] ${line}`),
});

if (!result) {
  console.log("[artifact-runtime] bootstrap skipped by environment");
  process.exit(0);
}

console.log(JSON.stringify(result, null, 2));

if (result.migration.status === "migrated") {
  console.log(
    `[artifact-runtime] migrated runtime from legacy Codex cache: ${
      result.migration.source ?? "unknown source"
    }`,
  );
}

if (result.artifactTool.status !== "available") {
  console.warn(
    `[artifact-runtime] @oai/artifact-tool is not available: ${
      result.artifactTool.reason ?? "unknown reason"
    }`,
  );
}
