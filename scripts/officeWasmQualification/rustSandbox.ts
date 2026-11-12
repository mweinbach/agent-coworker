import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceServerBinary } from "../workspaceRustBinary";

/**
 * `cowork-server __sandbox-exec --print-command` output: the fully transformed
 * backend launch the Rust sandbox (crates/cowork-sandbox) would spawn.
 */
export type PrintedSandboxCommand = {
  sandbox: "linux-bwrap" | "macos-seatbelt" | "windows-sandbox" | "none";
  file: string;
  args: string[];
  cwd: string;
  /** Complete child environment (sandbox allowlist + backend variables). */
  env: Record<string, string>;
  /** Backend-only variables (COWORK_SANDBOX, ...), already merged into `env`. */
  sandboxEnv: Record<string, string>;
  enforcement: { filesystem: boolean; network: boolean; process: boolean; integrity: boolean };
  unsandboxed: boolean;
};

const SANDBOX_TYPES = new Set(["linux-bwrap", "macos-seatbelt", "windows-sandbox", "none"]);

/** Arguments for a network-less workspace-write launch scoped to `root`. Fails closed when no
 * enforcing backend is available (`--require-backend`). */
export function sandboxPrintCommandArgs(opts: {
  root: string;
  file: string;
  args: string[];
}): string[] {
  return [
    "__sandbox-exec",
    "--print-command",
    "--cwd",
    opts.root,
    "--mode",
    "workspace-write",
    "--writable-root",
    opts.root,
    "--no-network",
    "--require-backend",
    "--",
    opts.file,
    ...opts.args,
  ];
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid sandbox launch: ${field} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`Invalid sandbox launch: ${field}.${key}`);
  }
  return value as Record<string, string>;
}

/** Strictly validates the single JSON line printed by `--print-command`. */
export function parsePrintedSandboxCommand(stdout: string): PrintedSandboxCommand {
  const lines = stdout.trim().split("\n");
  if (lines.length !== 1 || !lines[0]) {
    throw new Error("Invalid sandbox launch: expected exactly one JSON line");
  }
  const raw = JSON.parse(lines[0]) as Record<string, unknown>;
  if (typeof raw.sandbox !== "string" || !SANDBOX_TYPES.has(raw.sandbox)) {
    throw new Error(`Invalid sandbox launch: sandbox ${String(raw.sandbox)}`);
  }
  if (typeof raw.file !== "string" || !raw.file) throw new Error("Invalid sandbox launch: file");
  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
    throw new Error("Invalid sandbox launch: args");
  }
  if (typeof raw.cwd !== "string" || !path.isAbsolute(raw.cwd)) {
    throw new Error("Invalid sandbox launch: cwd");
  }
  if (typeof raw.unsandboxed !== "boolean") throw new Error("Invalid sandbox launch: unsandboxed");
  const enforcement = raw.enforcement as Record<string, unknown> | null;
  if (!enforcement || typeof enforcement !== "object") {
    throw new Error("Invalid sandbox launch: enforcement");
  }
  for (const key of ["filesystem", "network", "process", "integrity"]) {
    if (typeof enforcement[key] !== "boolean") {
      throw new Error(`Invalid sandbox launch: enforcement.${key}`);
    }
  }
  return {
    sandbox: raw.sandbox as PrintedSandboxCommand["sandbox"],
    file: raw.file,
    args: raw.args as string[],
    cwd: raw.cwd,
    env: stringRecord(raw.env, "env"),
    sandboxEnv: stringRecord(raw.sandboxEnv, "sandboxEnv"),
    enforcement: enforcement as PrintedSandboxCommand["enforcement"],
    unsandboxed: raw.unsandboxed,
  };
}

/**
 * Canonical path of the `cowork-server` binary that transforms launches. Override with
 * `COWORK_SANDBOX_SERVER_BIN`; otherwise Cargo builds (or confirms freshness of) the workspace
 * binary. Never the staged desktop sidecar, which may be stale.
 */
export function resolveSandboxServerBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COWORK_SANDBOX_SERVER_BIN;
  const repo = path.resolve(import.meta.dir, "../..");
  const binary = override || resolveWorkspaceServerBinary(repo, env, { includeStaged: false });
  if (!path.isAbsolute(binary)) throw new Error("COWORK_SANDBOX_SERVER_BIN must be absolute");
  return fs.realpathSync(binary);
}

/** Asks the Rust sandbox for the backend launch without executing anything. */
export function printSandboxCommand(
  binary: string,
  opts: { root: string; file: string; args: string[]; env: Record<string, string> },
): PrintedSandboxCommand {
  // Hermetic env: no inherited COWORK_SANDBOX_EXEC_PATH, so the seccomp re-exec launcher is
  // `binary` itself (current_exe) and scratch/credential roots derive from the isolated env.
  const result = spawnSync(binary, sandboxPrintCommandArgs(opts), {
    cwd: opts.root,
    env: opts.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Required sandbox unavailable: ${detail}`);
  }
  return parsePrintedSandboxCommand(result.stdout);
}
