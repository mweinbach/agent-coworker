#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import { parseCliArgs } from "./cli/args";
import { runCliRepl } from "./cli/repl";
import { DEFAULT_PROVIDER_OPTIONS } from "./providers";
import { startAgentServer } from "./server/startServer";
import { runTui } from "./tui/index";

// Keep output clean by default.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log("Usage: cowork [--dir <directory_path>] [--cli] [--yolo]");
  console.log("");
  console.log("By default, cowork launches the TUI (and starts the agent server in the background).");
  console.log("");
  console.log("Options:");
  console.log("  --dir, -d   Run the agent in the specified directory");
  console.log("  --cli, -c   Run the plain CLI instead of the TUI");
  console.log("  --yolo, -y  Skip command approvals (dangerous; use with care)");
  console.log("  --help, -h  Show help");
  console.log("");
}

async function resolveAndValidateDir(dirArg: string): Promise<string> {
  const resolved = path.resolve(dirArg);
  let st: { isDirectory: () => boolean } | null = null;
  try {
    st = await fs.stat(resolved);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
  return resolved;
}

async function main() {
  const { args, errors } = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error("");
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (args.cli) {
    await runCliRepl({ dir: args.dir, providerOptions: DEFAULT_PROVIDER_OPTIONS, yolo: args.yolo });
    return;
  }

  const cwd = args.dir ? await resolveAndValidateDir(args.dir) : process.cwd();
  if (args.dir) process.chdir(cwd);

  const { server, url } = await startAgentServer({
    cwd,
    hostname: "127.0.0.1",
    port: 0, // ephemeral port; avoids collisions and keeps launch simple
    providerOptions: DEFAULT_PROVIDER_OPTIONS,
    yolo: args.yolo,
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      server.stop();
    } catch {
      // ignore
    }
  };

  try {
    await runTui(url, { onDestroy: stop });
  } finally {
    stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
