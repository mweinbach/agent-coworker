#!/usr/bin/env bun

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROVIDER_OPTIONS } from "../providers";
import { startAgentServer } from "./startServer";

// Keep server output clean by default.
const globalSettings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalSettings.AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log("Usage: cowork-server [--dir <directory_path>] [--port <port>] [--yolo] [--json]");
}

async function resolveAndValidateDir(dirArg: string): Promise<string> {
  const resolved = path.resolve(dirArg);
  const st = await fs.stat(resolved);
  if (!st.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
  return resolved;
}

export function parseArgs(argv: string[]): { dir?: string; port: number; yolo: boolean; json: boolean } {
  let dir: string | undefined;
  let port = 7337;
  let yolo = false;
  let json = false;

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
      // port=0 requests an ephemeral port from the OS.
      if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${v}`);
      i++;
      continue;
    }
    if (a === "--yolo" || a === "-y") {
      yolo = true;
      continue;
    }
    if (a === "--json" || a === "-j") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  return { dir, port, yolo, json };
}

export function resolveBundledBuiltInDir(options: {
  execPath?: string;
  existsSync?: (candidate: string) => boolean;
} = {}): string | undefined {
  const execPath = options.execPath ?? process.execPath;
  const existsSync = options.existsSync ?? fsSync.existsSync;
  const execDir = path.dirname(path.resolve(execPath));
  const candidates = [
    path.join(execDir, "dist"),
    path.join(execDir, "..", "dist"),
  ];

  for (const candidate of candidates) {
    const hasConfig = existsSync(path.join(candidate, "config", "defaults.json"));
    const hasPrompts = existsSync(path.join(candidate, "prompts", "system.md"));
    if (hasConfig && hasPrompts) {
      return candidate;
    }
  }

  return undefined;
}

async function main() {
  const { dir, port, yolo, json } = parseArgs(process.argv.slice(2));

  const cwd = dir ? await resolveAndValidateDir(dir) : process.cwd();
  if (dir) process.chdir(cwd);
  const bundledBuiltInDir =
    typeof process.env.COWORK_BUILTIN_DIR === "string" && process.env.COWORK_BUILTIN_DIR.trim()
      ? process.env.COWORK_BUILTIN_DIR
      : resolveBundledBuiltInDir();

  const { server, config, url } = await startAgentServer({
    cwd,
    hostname: "127.0.0.1",
    port,
    env: {
      ...process.env,
      AGENT_WORKING_DIR: cwd,
      ...(bundledBuiltInDir ? { COWORK_BUILTIN_DIR: bundledBuiltInDir } : {}),
    },
    providerOptions: DEFAULT_PROVIDER_OPTIONS,
    yolo,
  });

  // Graceful shutdown on signals so child processes are cleaned up.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      server.stop();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("exit", () => {
    // Last-resort synchronous cleanup.
    try {
      server.stop();
    } catch {
      // ignore
    }
  });

  if (json) {
    console.log(
      JSON.stringify({
        type: "server_listening",
        url,
        port: server.port,
        cwd: config.workingDirectory,
      })
    );
    return;
  }

  console.log(`[cowork-server] listening on ${url} (cwd=${config.workingDirectory})`);
}

if (import.meta.main) {
  main().catch((err) => {
    if (String(err) === "Error: help") return;
    console.error(err);
    process.exitCode = 1;
  });
}
