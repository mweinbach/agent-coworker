#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import {
  createLocalObservabilityStack,
  getLocalObservabilityStackStatus,
  startLocalObservabilityStack,
  stopLocalObservabilityStack,
  type LocalObservabilityStack,
} from "../src/observability/runtime";

type Command = "up" | "down" | "status" | "endpoints";

type CliArgs = {
  command: Command;
  runId: string;
  json: boolean;
};

type SavedStack = {
  runId: string;
  cwd: string;
  stack: LocalObservabilityStack;
  createdAt: string;
};

function printUsage() {
  console.log("Usage: bun scripts/observability_stack.ts <up|down|status|endpoints> [--run-id <id>] [--json]");
}

function parseArgs(argv: string[]): CliArgs {
  const first = argv[0];
  if (first !== "up" && first !== "down" && first !== "status" && first !== "endpoints") {
    throw new Error(`Unknown or missing command: ${String(first)}`);
  }

  let runId = "default";
  let json = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-id") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --run-id");
      runId = value;
      i++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command: first, runId, json };
}

function stateFilePath(cwd: string, runId: string): string {
  return path.join(cwd, ".agent", "observability-stack", `${runId}.json`);
}

async function readState(cwd: string, runId: string): Promise<SavedStack | null> {
  const file = stateFilePath(cwd, runId);
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as SavedStack;
  } catch {
    return null;
  }
}

async function writeState(cwd: string, runId: string, stack: LocalObservabilityStack) {
  const file = stateFilePath(cwd, runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const state: SavedStack = { cwd, runId, stack, createdAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf-8");
}

async function deleteState(cwd: string, runId: string) {
  await fs.rm(stateFilePath(cwd, runId), { force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (args.command === "up") {
    const stack = await createLocalObservabilityStack({ repoDir: cwd, runId: args.runId });
    await startLocalObservabilityStack(stack);
    await writeState(cwd, args.runId, stack);
    const out = {
      command: "up",
      runId: args.runId,
      endpoints: stack.endpoints,
      composeFile: stack.composeFile,
      projectName: stack.projectName,
    };
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else console.log(`[obs] started ${stack.projectName} (${stack.endpoints.otlpHttpEndpoint})`);
    return;
  }

  const saved = await readState(cwd, args.runId);
  if (!saved) throw new Error(`No observability stack state found for runId=${args.runId}`);

  if (args.command === "down") {
    await stopLocalObservabilityStack(saved.stack);
    await deleteState(cwd, args.runId);
    if (args.json) {
      console.log(JSON.stringify({ command: "down", runId: args.runId, stopped: true }, null, 2));
    } else {
      console.log(`[obs] stopped ${saved.stack.projectName}`);
    }
    return;
  }

  if (args.command === "status") {
    const statusText = await getLocalObservabilityStackStatus(saved.stack);
    if (args.json) {
      console.log(JSON.stringify({ command: "status", runId: args.runId, status: statusText }, null, 2));
    } else {
      console.log(statusText.trim() || "(no status output)");
    }
    return;
  }

  const out = {
    command: "endpoints",
    runId: args.runId,
    endpoints: saved.stack.endpoints,
  };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else console.log(JSON.stringify(out.endpoints, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    if (String(err).includes("Unknown or missing command")) printUsage();
    console.error(err);
    process.exitCode = 1;
  });
}

