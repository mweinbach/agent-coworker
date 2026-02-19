#!/usr/bin/env bun

import { parseArgs, runTui } from "../../apps/TUI/index";

export { parseArgs, runTui };

function printUsage() {
  console.log("Usage: bun src/tui/index.tsx [--server <ws_url>] [--no-mouse]");
  console.log("");
  console.log("Options:");
  console.log("  --server, -s  WebSocket server URL (default: ws://127.0.0.1:7337/ws)");
  console.log("  --mouse, -m   Enable OpenTUI mouse capture (enabled by default)");
  console.log("  --no-mouse    Disable OpenTUI mouse capture");
  console.log("  --help, -h    Show help");
  console.log("");
}

if (import.meta.main) {
  let serverUrl = "ws://127.0.0.1:7337/ws";
  let help = false;
  let useMouse = true;

  try {
    const parsed = parseArgs(process.argv.slice(2));
    serverUrl = parsed.serverUrl;
    help = parsed.help;
    useMouse = parsed.useMouse;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("");
    printUsage();
    process.exitCode = 1;
  }

  if (!help && process.exitCode !== 1) {
    runTui(serverUrl, { useMouse }).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  } else if (help) {
    printUsage();
  }
}
