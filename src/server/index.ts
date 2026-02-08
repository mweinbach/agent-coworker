#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import { startAgentServer } from "./startServer";

// Keep server output clean by default.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log("Usage: bun src/server/index.ts [--dir <directory_path>] [--port <port>]");
}

async function resolveAndValidateDir(dirArg: string): Promise<string> {
  const resolved = path.resolve(dirArg);
  const st = await fs.stat(resolved);
  if (!st.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
  return resolved;
}

function parseArgs(argv: string[]): { dir?: string; port: number } {
  let dir: string | undefined;
  let port = 7337;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exitCode = 0;
      throw new Error("help");
    }
    if (a === "--dir" || a === "-d") {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${a}`);
      dir = v;
      i++;
      continue;
    }
    if (a === "--port" || a === "-p") {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${a}`);
      port = Number(v);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(`Invalid port: ${v}`);
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  return { dir, port };
}

async function main() {
  const { dir, port } = parseArgs(process.argv.slice(2));

  const cwd = dir ? await resolveAndValidateDir(dir) : process.cwd();
  if (dir) process.chdir(cwd);

  const { server, config } = await startAgentServer({
    cwd,
    hostname: "127.0.0.1",
    port,
    env: { ...process.env, AGENT_WORKING_DIR: cwd },
  });

  console.log(`[server] ws://127.0.0.1:${server.port}/ws (cwd=${config.workingDirectory})`);
}

if (import.meta.main) {
  main().catch((err) => {
    if (String(err) === "Error: help") return;
    console.error(err);
    process.exitCode = 1;
  });
}
