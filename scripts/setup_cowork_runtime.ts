#!/usr/bin/env bun

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { hostPlatform } from "../src/platform/host";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

function resolveCoworkServerBinary(): string {
  const exe = hostPlatform() === "win32" ? "cowork-server.exe" : "cowork-server";
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(REPO_ROOT, "target", profile, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Compiled ${exe} binary not found in target/{release,debug}. Run \`cargo build -p cowork-server\` first.`,
  );
}

const bin = resolveCoworkServerBinary();
const proc = spawn(bin, ["--host", "127.0.0.1", "--port", "0", "--json"], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    COWORK_DESKTOP_PARENT_MANAGED: "1",
    COWORK_RUNTIME_ALLOW_NETWORK: "1",
    ...(process.argv.includes("--force") ? { COWORK_RUNTIME_FORCE: "1" } : {}),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = readline.createInterface({ input: proc.stdout });
const wsUrl = await new Promise<string>((resolve, reject) => {
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    const evt = JSON.parse(trimmed) as { type?: string; wsUrl?: string };
    if (evt.type === "server_listening" && evt.wsUrl) {
      rl.close();
      resolve(evt.wsUrl);
    }
  });
  proc.once("exit", (code) => reject(new Error(`cowork-server exited early (${String(code)})`)));
});

try {
  const ws = new WebSocket(wsUrl, "cowork.jsonrpc.v1");
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket connect failed"));
  });

  let nextId = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const listener = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== id) return;
        ws.removeEventListener("message", listener);
        if (msg.error) reject(new Error(msg.error.message ?? "JSON-RPC error"));
        else resolve(msg.result);
      };
      ws.addEventListener("message", listener);
      ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    });

  await request("initialize", { clientInfo: { name: "setup-cowork-runtime", version: "1.0.0" } });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const diag = await request("cowork/runtime/diagnostics/read", {});
    if (diag?.startup?.ready) {
      console.log(JSON.stringify(diag, null, 2));
      ws.close();
      break;
    }
    if (diag?.startup?.error) {
      ws.close();
      throw new Error(`Cowork runtime setup failed: ${String(diag.startup.error)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
} finally {
  proc.stdin.end();
}
