#!/usr/bin/env bun

import { parseCliArgs } from "./cli/args";

// Keep output clean by default.
const globalSettings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalSettings.AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log("Usage: cowork [--dir <directory_path>] [--yolo] [--cli]");
  console.log("       cowork migrate-agent-config [--dir <directory_path>]");
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

  if (args.command === "migrate-agent-config") {
    const [{ migrateAgentConfig, formatAgentConfigMigrationReport }, { resolveAndValidateDir }] =
      await Promise.all([import("./migrateAgentConfig"), import("./cli/repl")]);
    const cwd = args.dir ? await resolveAndValidateDir(args.dir) : process.cwd();
    const result = await migrateAgentConfig({ cwd });
    console.log(formatAgentConfigMigrationReport(result));
    return;
  }

  const [{ runCliRepl }, { DEFAULT_PROVIDER_OPTIONS }] = await Promise.all([
    import("./cli/repl"),
    import("./providers/providerOptions"),
  ]);

  await runCliRepl({
    dir: args.dir,
    port: args.port,
    providerOptions: DEFAULT_PROVIDER_OPTIONS,
    yolo: args.yolo,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
