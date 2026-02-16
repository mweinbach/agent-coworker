#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/solid";
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

export async function runTui(
  serverUrl: string,
  opts?: { onDestroy?: () => void }
): Promise<void> {
  const renderer = createCliRenderer();

  return new Promise<void>((resolve) => {
    const root = createRoot(() => {
      return (
        <ExitProvider>
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
      );
    });

    // Handle cleanup on process exit
    const cleanup = () => {
      opts?.onDestroy?.();
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}

// Allow direct execution: bun apps/TUI/index.tsx [--server <url>]
if (import.meta.main) {
  let serverUrl = "ws://127.0.0.1:7337/ws";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--server" || argv[i] === "-s") {
      serverUrl = argv[++i] ?? serverUrl;
    }
  }
  runTui(serverUrl).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
