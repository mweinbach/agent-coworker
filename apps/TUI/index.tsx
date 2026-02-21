#!/usr/bin/env bun

import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { ExitProvider } from "./context/exit";
import { KVProvider } from "./context/kv";
import { ThemeProvider } from "./context/theme";
import { DialogProvider } from "./context/dialog";
import { SyncProvider } from "./context/sync";
import { KeybindProvider } from "./context/keybind";
import { LocalProvider } from "./context/local";
import { RouteProvider } from "./context/route";
import { PromptProvider } from "./context/prompt";
import { App } from "./app";

// Keep output clean.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log("Usage: bun apps/TUI/index.tsx [--server <ws_url>] [--no-mouse]");
  console.log("");
  console.log("Options:");
  console.log("  --server, -s  WebSocket server URL (default: ws://127.0.0.1:7337/ws)");
  console.log("  --mouse, -m   Enable OpenTUI mouse capture (enabled by default)");
  console.log("  --no-mouse    Disable OpenTUI mouse capture");
  console.log("  --help, -h    Show help");
  console.log("");
}

export function parseArgs(argv: string[]): {
  serverUrl: string;
  help: boolean;
  useMouse: boolean;
} {
  let serverUrl = "ws://127.0.0.1:7337/ws";
  let useMouse = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server" || arg === "-s") {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      serverUrl = value;
      i++;
      continue;
    }
    if (arg === "--mouse" || arg === "-m") {
      useMouse = true;
      continue;
    }
    if (arg === "--no-mouse") {
      useMouse = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { serverUrl, help: true, useMouse };
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { serverUrl, help: false, useMouse };
}

export async function runTui(
  serverUrl: string,
  opts?: { onDestroy?: () => void; useMouse?: boolean }
): Promise<void> {
  const renderer = await createCliRenderer({
    // Mouse capture is enabled by default for scrollbar click/drag support.
    useMouse: opts?.useMouse ?? true,
    // Ctrl+C is handled by app-level keybindings and exit flow.
    exitOnCtrlC: false,
  });

  await render(() => (
    <ExitProvider onExit={() => {
      if (!renderer.isDestroyed) renderer.destroy();
    }}>
      <KVProvider>
        <ThemeProvider>
          <DialogProvider>
            <SyncProvider serverUrl={serverUrl}>
              <KeybindProvider>
                <LocalProvider>
                  <RouteProvider>
                    <PromptProvider>
                      <App />
                    </PromptProvider>
                  </RouteProvider>
                </LocalProvider>
              </KeybindProvider>
            </SyncProvider>
          </DialogProvider>
        </ThemeProvider>
      </KVProvider>
    </ExitProvider>
  ), renderer);

  return new Promise<void>((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      renderer.off(CliRenderEvents.DESTROY, onDestroy);
      opts?.onDestroy?.();
      resolve();
    };
    const onDestroy = () => {
      cleanup();
    };
    const onSignal = () => {
      if (renderer.isDestroyed) {
        cleanup();
        return;
      }
      renderer.destroy();
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    renderer.on(CliRenderEvents.DESTROY, onDestroy);
  });
}

// Allow direct execution: bun apps/TUI/index.tsx [--server <url>]
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
