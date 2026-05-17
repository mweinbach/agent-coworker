#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { parseArgs, requireArg } from "./artifact_tool_utils.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/cleanup_presentation_workspace.mjs --workspace <dir> --output-dir <dir>",
    "",
    "Deletes a thread-scoped presentation workspace while preserving final PPTX files.",
    "",
    "Options:",
    "  --workspace <dir>           Thread-scoped task workspace to clean.",
    "  --output-dir <dir>          Directory containing final PPTX deliverables.",
    "  --dry-run                   Print the paths that would be removed.",
  ].join("\n");
}

function pathSegments(filePath) {
  return path.resolve(filePath).split(path.sep).filter(Boolean);
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafePathSegment(segment) {
  return typeof segment === "string" && /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..";
}

function safePathSegment(value) {
  if (typeof value !== "string") return undefined;
  const segment = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return isSafePathSegment(segment) ? segment : undefined;
}

function assertSafeWorkspace(workspace) {
  const resolvedWorkspace = path.resolve(workspace);
  const segments = pathSegments(resolvedWorkspace);
  const threadId = safePathSegment(process.env.CODEX_THREAD_ID);
  const outputsIndex = segments.lastIndexOf("outputs");
  const threadSegment = outputsIndex >= 0 ? segments[outputsIndex + 1] : undefined;
  const artifactSegment = outputsIndex >= 0 ? segments[outputsIndex + 2] : undefined;
  const taskSegment = outputsIndex >= 0 ? segments[outputsIndex + 3] : undefined;

  if (artifactSegment !== "presentations" || !isSafePathSegment(taskSegment)) {
    throw new Error(
      [
        `Refusing to clean unsafe Presentations workspace: ${resolvedWorkspace}`,
        "Expected a task workspace under outputs/<CODEX_THREAD_ID-or-manual-id>/presentations/<task-slug>.",
      ].join("\n"),
    );
  }

  if (threadId && isSafePathSegment(threadId) && threadSegment === threadId) {
    return;
  }
  if (/^manual-[A-Za-z0-9._-]+$/.test(threadSegment || "")) {
    return;
  }

  throw new Error(
    [
      `Refusing to clean unsafe Presentations workspace: ${resolvedWorkspace}`,
      "Expected a task workspace under outputs/<CODEX_THREAD_ID-or-manual-id>/presentations/<task-slug>.",
    ].join("\n"),
  );
}

async function removePath(target, dryRun, removed) {
  removed.push(target);
  if (dryRun) return;
  await fs.rm(target, { recursive: true, force: true });
}

async function cleanOutputDir(outputDir, dryRun, removed) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  for (const entry of entries) {
    const entryPath = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      await cleanOutputDir(entryPath, dryRun, removed);
      const remaining = await fs.readdir(entryPath).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      if (remaining.length === 0) {
        await removePath(entryPath, dryRun, removed);
      }
    } else if (path.extname(entry.name).toLowerCase() !== ".pptx") {
      await removePath(entryPath, dryRun, removed);
    }
  }
}

async function cleanWorkspaceDir(workspace, outputDir, dryRun, removed) {
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  for (const entry of entries) {
    const entryPath = path.join(workspace, entry.name);
    if (isWithin(outputDir, entryPath)) {
      if (path.resolve(entryPath) === outputDir) {
        await cleanOutputDir(entryPath, dryRun, removed);
      } else {
        await cleanWorkspaceDir(entryPath, outputDir, dryRun, removed);
      }
    } else {
      await removePath(entryPath, dryRun, removed);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const workspace = path.resolve(requireArg(args, "workspace"));
  const outputDir = path.resolve(requireArg(args, "output-dir"));
  const dryRun = Boolean(args["dry-run"]);
  assertSafeWorkspace(workspace);

  const removed = [];
  if (isWithin(outputDir, workspace)) {
    if (outputDir === workspace) {
      await cleanOutputDir(outputDir, dryRun, removed);
    } else {
      await cleanWorkspaceDir(workspace, outputDir, dryRun, removed);
    }
  } else {
    await removePath(workspace, dryRun, removed);
  }

  console.log(
    JSON.stringify(
      {
        workspace,
        outputDir,
        dryRun,
        removed,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  console.error(usage());
  process.exit(1);
});
