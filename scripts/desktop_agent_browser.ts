import { spawn, spawnSync } from "node:child_process";

const DEFAULT_REMOTE_DEBUG_PORT = "9222";

function resolveRunner(): { command: string; prefixArgs: string[] } {
  if (process.env.COWORK_DESKTOP_BROWSER_FORCE_BUNX?.trim() === "1") {
    return { command: "bunx", prefixArgs: ["agent-browser"] };
  }

  const probe = spawnSync("agent-browser", ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  if (probe.status === 0) {
    return { command: "agent-browser", prefixArgs: [] };
  }

  return { command: "bunx", prefixArgs: ["agent-browser"] };
}

function printHelp() {
  console.log(
    [
      "Control the Electron desktop app with agent-browser over CDP.",
      "",
      "Usage:",
      "  bun run desktop:browser -- <agent-browser args>",
      "",
      "Examples:",
      "  bun run desktop:browser -- snapshot -i",
      "  bun run desktop:browser -- click @e2",
      "  bun run desktop:browser -- screenshot tmp/desktop.png",
      "",
      "Notes:",
      `  - Uses --cdp ${DEFAULT_REMOTE_DEBUG_PORT} by default (or COWORK_ELECTRON_REMOTE_DEBUG_PORT).`,
      "  - Prefers global `agent-browser`; falls back to `bunx agent-browser` if missing.",
      "  - Pass --cdp explicitly or use `connect` to override default behavior.",
    ].join("\n")
  );
}

const userArgs = process.argv.slice(2);
if (userArgs.length === 0 || userArgs.includes("--help") || userArgs.includes("-h")) {
  printHelp();
  process.exit(userArgs.length === 0 ? 1 : 0);
}

const remoteDebugPort =
  process.env.COWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() || DEFAULT_REMOTE_DEBUG_PORT;
const hasExplicitCdp = userArgs.includes("--cdp");
const usesConnectCommand = userArgs[0] === "connect";

const args = hasExplicitCdp || usesConnectCommand ? userArgs : ["--cdp", remoteDebugPort, ...userArgs];
const runner = resolveRunner();
if (runner.command !== "agent-browser") {
  console.warn(
    "[desktop:browser] `agent-browser` not found in PATH. Falling back to `bunx agent-browser`."
  );
}

const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error(`[desktop:browser] Failed to launch agent-browser: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
