import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";
import { jsonRpcRuntimeResultSchemas } from "../src/shared/jsonrpcControlSchemas";
import { resolveRustBinaryPath } from "./helpers/rustServerHarness";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SETUP_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "setup_cowork_runtime.ts");

const createdTempDirs: string[] = [];
const spawnedChildPids = new Set<number>();

async function makeIsolatedTempRoot(): Promise<string> {
  const rawScratch = scratchRoots()[0] ?? "/tmp";
  const canonicalBase = fs.existsSync(rawScratch) ? fs.realpathSync(rawScratch) : rawScratch;
  const dir = await fsp.mkdtemp(path.join(canonicalBase, "cowork-setup-rt-test-"));
  createdTempDirs.push(dir);
  return dir;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeMockServerExecutable(tempRoot: string): Promise<{
  binPath: string;
  pidFile: string;
  stdinExitMarker: string;
}> {
  const pidFile = path.join(tempRoot, "mock-server.pid");
  const stdinExitMarker = path.join(tempRoot, "mock-server-stdin-exit.txt");
  const scriptPath = path.join(tempRoot, "mock-cowork-server.mjs");

  const scriptBody = [
    `#!${process.execPath}`,
    `import fs from "node:fs";`,
    ``,
    `const pidFile = ${JSON.stringify(pidFile)};`,
    `const stdinExitMarker = ${JSON.stringify(stdinExitMarker)};`,
    `fs.writeFileSync(pidFile, String(process.pid), "utf8");`,
    ``,
    `const ignoreStdinEof = process.env.MOCK_SERVER_IGNORE_STDIN_EOF === "1";`,
    `const startupError = (() => {`,
    `  if (process.env.COWORK_DISABLE_RUNTIME !== "0") {`,
    `    return \`expected COWORK_DISABLE_RUNTIME=0, got \${String(process.env.COWORK_DISABLE_RUNTIME)}\`;`,
    `  }`,
    `  if (process.env.COWORK_DESKTOP_PARENT_MANAGED !== "1") {`,
    `    return "expected COWORK_DESKTOP_PARENT_MANAGED=1";`,
    `  }`,
    `  if (process.env.COWORK_RUNTIME_ALLOW_NETWORK !== "1") {`,
    `    return "expected COWORK_RUNTIME_ALLOW_NETWORK=1";`,
    `  }`,
    `  if (process.env.MOCK_EXPECT_FORCE === "1" && process.env.COWORK_RUNTIME_FORCE !== "1") {`,
    `    return "expected COWORK_RUNTIME_FORCE=1 when --force is passed";`,
    `  }`,
    `  return process.env.MOCK_STARTUP_ERROR ?? "";`,
    `})();`,
    ``,
    `let diagnosticsReads = 0;`,
    `const server = Bun.serve({`,
    `  hostname: "127.0.0.1",`,
    `  port: 0,`,
    `  fetch(req, srv) {`,
    `    if (srv.upgrade(req)) return undefined;`,
    `    return new Response("ok", { status: 200 });`,
    `  },`,
    `  websocket: {`,
    `    message(ws, raw) {`,
    `      const msg = JSON.parse(String(raw));`,
    `      if (msg.method === "initialize") {`,
    `        ws.send(JSON.stringify({`,
    `          id: msg.id,`,
    `          result: {`,
    `            protocolVersion: "0.1",`,
    `            transport: { type: "websocket", protocolMode: "jsonrpc" },`,
    `          },`,
    `        }));`,
    `        return;`,
    `      }`,
    `      if (msg.method === "cowork/runtime/diagnostics/read") {`,
    `        diagnosticsReads += 1;`,
    `        const basePayload = {`,
    `          sendQueue: {`,
    `            queuedSends: 0,`,
    `            droppedDeltas: 0,`,
    `            droppedImportant: 0,`,
    `            serializationFailures: 0,`,
    `            sendFailures: 0,`,
    `            externalSinkFailures: 0,`,
    `            maxQueueDepth: 0,`,
    `            queueDepthByConnection: {},`,
    `          },`,
    `          journal: {`,
    `            untrustedThreadCount: 0,`,
    `            failedWriteCount: 0,`,
    `            droppedEventCount: 0,`,
    `            pendingThreadCount: 0,`,
    `          },`,
    `          dbLocks: {`,
    `            waitCount: 0,`,
    `            timeoutCount: 0,`,
    `            sqliteLockErrorCount: 0,`,
    `            staleRecoveryCount: 0,`,
    `            lastWaitMs: 0,`,
    `            maxWaitMs: 0,`,
    `          },`,
    `        };`,
    `        if (startupError) {`,
    `          ws.send(JSON.stringify({`,
    `            id: msg.id,`,
    `            result: {`,
    `              diagnostics: {`,
    `                ...basePayload,`,
    `                startup: { ready: false, error: startupError },`,
    `              },`,
    `            },`,
    `          }));`,
    `          return;`,
    `        }`,
    `        const ready = diagnosticsReads >= 2;`,
    `        ws.send(JSON.stringify({`,
    `          id: msg.id,`,
    `          result: {`,
    `            diagnostics: {`,
    `              ...basePayload,`,
    `              startup: {`,
    `                ready,`,
    `                progress: {`,
    `                  phase: ready ? "ready" : "downloading",`,
    `                  version: "2026-03-01",`,
    `                  transferredBytes: ready ? 1024 : 512,`,
    `                  totalBytes: 1024,`,
    `                  percent: ready ? 100 : 50,`,
    `                },`,
    `              },`,
    `            },`,
    `          },`,
    `        }));`,
    `      }`,
    `    },`,
    `  },`,
    `});`,
    ``,
    `process.stdout.write(JSON.stringify({`,
    `  type: "server_listening",`,
    `  wsUrl: \`ws://127.0.0.1:\${server.port}/ws\`,`,
    `}) + "\\n");`,
    ``,
    `process.stdin.resume();`,
    `process.stdin.once("end", () => {`,
    `  if (ignoreStdinEof) return;`,
    `  setTimeout(() => {`,
    `    fs.writeFileSync(stdinExitMarker, "graceful-exit", "utf8");`,
    `    server.stop(true);`,
    `    process.exit(0);`,
    `  }, 120);`,
    `});`,
    ``,
  ].join("\n");

  await fsp.writeFile(scriptPath, scriptBody, { mode: 0o755 });

  if (hostPlatform() === "win32") {
    const cmdPath = path.join(tempRoot, "mock-cowork-server.cmd");
    await fsp.writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return { binPath: cmdPath, pidFile, stdinExitMarker };
  }

  return { binPath: scriptPath, pidFile, stdinExitMarker };
}

async function runSetupScript(options: {
  tempRoot: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const homeDir = path.join(options.tempRoot, "home");
  await fsp.mkdir(homeDir, { recursive: true });

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    COWORK_HOME_OVERRIDE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
  };

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = value;
    }
  }

  const child = spawn(process.execPath, [SETUP_SCRIPT_PATH, ...(options.args ?? [])], {
    cwd: REPO_ROOT,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  for (const pid of spawnedChildPids) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }
  }
  spawnedChildPids.clear();

  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (dir) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("scripts/setup_cowork_runtime.ts", () => {
  test("exits 0, prints validated diagnostics JSON, overrides caller COWORK_DISABLE_RUNTIME=1, and awaits child exit", async () => {
    const tempRoot = await makeIsolatedTempRoot();
    const { binPath, pidFile, stdinExitMarker } = await writeMockServerExecutable(tempRoot);

    const outcome = await runSetupScript({
      tempRoot,
      args: ["--force"],
      env: {
        COWORK_DISABLE_RUNTIME: "1",
        COWORK_SETUP_RUNTIME_SERVER_BIN: binPath,
        MOCK_EXPECT_FORCE: "1",
      },
    });

    const childPid = fs.existsSync(pidFile)
      ? Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
      : Number.NaN;
    if (Number.isInteger(childPid)) {
      spawnedChildPids.add(childPid);
    }

    expect(outcome.exitCode).toBe(0);
    const parsed = jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].parse(
      JSON.parse(outcome.stdout),
    );
    expect(parsed.diagnostics.startup.ready).toBe(true);
    expect(parsed.diagnostics.startup.progress).toEqual({
      phase: "ready",
      version: "2026-03-01",
      transferredBytes: 1024,
      totalBytes: 1024,
      percent: 100,
    });
    expect(fs.existsSync(stdinExitMarker)).toBe(true);
    expect(isPidAlive(childPid)).toBe(false);
  });

  test("exits non-zero when real cowork-server reports diagnostics.startup.error even with caller COWORK_DISABLE_RUNTIME=1", async () => {
    const tempRoot = await makeIsolatedTempRoot();
    const brokenRuntimeDir = path.join(tempRoot, "broken-runtime");
    await fsp.mkdir(brokenRuntimeDir, { recursive: true });
    await fsp.writeFile(path.join(brokenRuntimeDir, "runtime.json"), "{ invalid json", "utf8");

    const outcome = await runSetupScript({
      tempRoot,
      env: {
        COWORK_DISABLE_RUNTIME: "1",
        COWORK_RUNTIME_DIR: brokenRuntimeDir,
        COWORK_SETUP_RUNTIME_SERVER_BIN: resolveRustBinaryPath("cowork-server"),
      },
    });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("Cowork runtime setup failed:");
    expect(outcome.stderr).toContain("runtime.json");
  });

  test("exits non-zero on timeout when COWORK_SETUP_RUNTIME_TIMEOUT_MS expires before startup.ready", async () => {
    const tempRoot = await makeIsolatedTempRoot();
    const openSockets = new Set<net.Socket>();
    const stalledServer = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      stalledServer.once("error", reject);
      stalledServer.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = stalledServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected bound TCP port for stalled server");
      }

      const outcome = await runSetupScript({
        tempRoot,
        env: {
          COWORK_DISABLE_RUNTIME: "1",
          COWORK_RUNTIME_DIR: undefined,
          COWORK_RUNTIME_ARCHIVE_PATH: undefined,
          COWORK_RUNTIME_BASE_URL: `http://127.0.0.1:${address.port}`,
          COWORK_SETUP_RUNTIME_TIMEOUT_MS: "400",
          COWORK_SETUP_RUNTIME_SERVER_BIN: resolveRustBinaryPath("cowork-server"),
        },
      });

      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.stderr).toContain("Timed out");
    } finally {
      for (const socket of openSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
    }
  });

  test("reaps child server via SIGTERM fallback when child ignores stdin EOF", async () => {
    const tempRoot = await makeIsolatedTempRoot();
    const { binPath, pidFile } = await writeMockServerExecutable(tempRoot);

    const outcome = await runSetupScript({
      tempRoot,
      env: {
        COWORK_SETUP_RUNTIME_SERVER_BIN: binPath,
        COWORK_SETUP_RUNTIME_SHUTDOWN_GRACE_MS: "150",
        MOCK_SERVER_IGNORE_STDIN_EOF: "1",
      },
    });

    const childPid = fs.existsSync(pidFile)
      ? Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
      : Number.NaN;
    if (Number.isInteger(childPid)) {
      spawnedChildPids.add(childPid);
    }

    expect(outcome.exitCode).toBe(0);
    expect(isPidAlive(childPid)).toBe(false);
  });
});
