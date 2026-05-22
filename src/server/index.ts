#!/usr/bin/env bun

import "reflect-metadata";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Keep server output clean by default.
const globalSettings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalSettings.AI_SDK_LOG_WARNINGS = false;

function printUsage() {
  console.log(
    "Usage: bun src/server/index.ts [--dir <directory_path>] [--host <hostname>] [--port <port>] [--yolo] [--json]",
  );
}

async function resolveAndValidateDir(dirArg: string): Promise<string> {
  const resolved = path.resolve(dirArg);
  let st: { isDirectory: () => boolean } | null = null;
  try {
    st = await fs.stat(resolved);
  } catch {
    st = null;
  }
  if (!st?.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
  return resolved;
}

function parseArgs(argv: string[]): {
  dir?: string;
  host: string;
  port: number;
  yolo: boolean;
  json: boolean;
  mobileH3: boolean;
  mobileH3Host: string;
  mobileH3Port: number;
} {
  let dir: string | undefined;
  let host = "127.0.0.1";
  let port = 7337;
  let yolo = false;
  let json = false;
  let mobileH3 = false;
  let mobileH3Host = "0.0.0.0";
  let mobileH3Port = 0;

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
    if (a === "--host" || a === "-H") {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${a}`);
      host = v;
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
    if (a === "--mobile-h3") {
      mobileH3 = true;
      continue;
    }
    if (a === "--mobile-h3-host") {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${a}`);
      mobileH3Host = v;
      i++;
      continue;
    }
    if (a === "--mobile-h3-port") {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${a}`);
      mobileH3Port = Number(v);
      if (!Number.isFinite(mobileH3Port) || mobileH3Port < 0 || mobileH3Port > 65535) {
        throw new Error(`Invalid mobile H3 port: ${v}`);
      }
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  return { dir, host, port, yolo, json, mobileH3, mobileH3Host, mobileH3Port };
}

export function resolveListeningHintsFromInterfaces(
  host: string,
  interfaces: ReturnType<typeof os.networkInterfaces>,
): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [host];

  const hints = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family !== "IPv4" && address.family !== "IPv6") continue;
      hints.add(address.address);
    }
  }

  return hints.size > 0 ? [...hints] : [host === "::" ? "::1" : "127.0.0.1"];
}

export function resolveListeningHints(host: string): string[] {
  return resolveListeningHintsFromInterfaces(host, os.networkInterfaces());
}

async function main() {
  const { dir, host, port, yolo, json, mobileH3, mobileH3Host, mobileH3Port } = parseArgs(
    process.argv.slice(2),
  );

  const cwd = dir ? await resolveAndValidateDir(dir) : process.cwd();
  if (dir) process.chdir(cwd);

  const [{ DEFAULT_PROVIDER_OPTIONS }, { startAgentServer }] = await Promise.all([
    import("../providers/providerOptions"),
    import("./startServer"),
  ]);

  const { server, mobileServer, config, url, browserAccessToken } = await startAgentServer({
    cwd,
    hostname: host,
    port,
    env: { ...process.env, AGENT_WORKING_DIR: cwd },
    providerOptions: DEFAULT_PROVIDER_OPTIONS,
    yolo,
    preloadSystemPrompt: false,
    ...(mobileH3
      ? {
          mobileH3: {
            hostname: mobileH3Host,
            port: mobileH3Port,
            hostHints: resolveListeningHints(mobileH3Host),
          },
        }
      : {}),
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
    const hostHints = resolveListeningHints(host);
    console.log(
      JSON.stringify({
        type: "server_listening",
        url,
        host,
        hostHints,
        port: server.port,
        cwd: config.workingDirectory,
        browserAccessToken: browserAccessToken ?? null,
        mobileH3: mobileServer
          ? {
              url: mobileServer.url,
              port: mobileServer.port,
              hostHints: mobileServer.hostHints,
              ticket: mobileServer.ticketUrl,
              adminToken: mobileServer.adminToken,
              certSha256: mobileServer.certSha256,
              spkiSha256: mobileServer.spkiSha256,
              identityPub: mobileServer.identityPub,
              nonce: mobileServer.nonce,
              expiresAt: mobileServer.expiresAt,
              trustedDevice: mobileServer.trustedDevice,
            }
          : null,
      }),
    );
    return;
  }

  const hostHints = resolveListeningHints(host);
  console.log(`[cowork-server] listening on ${url} (cwd=${config.workingDirectory})`);
  if (host === "0.0.0.0") {
    console.log(
      `[cowork-server] reachable on: ${hostHints.map((ip) => `ws://${ip}:${server.port}/ws`).join(", ")}`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    if (String(err) === "Error: help") return;
    console.error(err);
    process.exitCode = 1;
  });
}
