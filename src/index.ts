#!/usr/bin/env bun

import { parseCliArgs } from "./cli/args";
import { runCliRepl } from "./cli/repl";
import { DEFAULT_PROVIDER_OPTIONS } from "./providers";

// Keep output clean by default.
const globalSettings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalSettings.AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log("Usage: cowork [--dir <directory_path>] [--yolo] [--cli]");
  console.log("");
  console.log("This launches the CLI REPL. For the desktop app, use 'bun run start'");
  console.log("or 'bun run desktop:dev'.");
  console.log("");
  console.log("Options:");
  console.log("  --dir, -d   Run the CLI in the specified directory");
  console.log("  --cli, -c   Compatibility alias; CLI is the default terminal interface");
  console.log("  --yolo, -y  Skip command approvals (dangerous; use with care)");
  console.log("  --help, -h  Show help");
  console.log("");
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

  await runCliRepl({ dir: args.dir, providerOptions: DEFAULT_PROVIDER_OPTIONS, yolo: args.yolo });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
