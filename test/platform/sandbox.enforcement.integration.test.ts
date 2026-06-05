import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import { resolveSandboxPolicy, type SandboxPolicy } from "../../src/platform/sandbox/policy";
import { buildSeatbeltCommand } from "../../src/platform/sandbox/seatbelt";
import { buildWindowsSandboxCommand } from "../../src/platform/sandbox/windows";

/**
 * Real OS-sandbox ENFORCEMENT tests. Unlike the unit tests (which only assert
 * the generated argv/policy text), these spawn the actual platform sandbox —
 * macOS `sandbox-exec`, Linux bubblewrap, the Windows restricted-token helper —
 * and assert writes are allowed/denied as the policy promises.
 *
 * They are gated by platform AND backend availability, so the Linux CI image
 * skips bubblewrap unless it is installed and usable. Run them on macOS / Windows
 * (and a bubblewrap-capable Linux host) before merging to verify the SBPL/bwrap
 * policies are accepted and enforced on real kernels.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function workspacePolicy(ws: string, targetPaths?: string[]): SandboxPolicy {
  return resolveSandboxPolicy({
    config: { mode: "workspace-write", network: false },
    workingDirectory: ws,
    ...(targetPaths ? { targetPaths } : {}),
  });
}

// ---------------------------------------------------------------------------
// macOS — Seatbelt (sandbox-exec)
// ---------------------------------------------------------------------------
const seatbeltDescribe = process.platform === "darwin" ? describe : describe.skip;

function runSeatbelt(ws: string, shellCommand: string, targetPaths?: string[]): number | null {
  const { file, args } = buildSeatbeltCommand(
    { file: "/bin/bash", args: ["-c", shellCommand] },
    workspacePolicy(ws, targetPaths),
  );
  return spawnSync(file, args, { encoding: "utf8", timeout: 30_000 }).status;
}

seatbeltDescribe("seatbelt enforcement (macOS — run before merge)", () => {
  test("allows writes inside the workspace", () => {
    const ws = tmpDir("sbx-ws-");
    try {
      expect(runSeatbelt(ws, `printf hi > '${ws}/ok.txt'`)).toBe(0);
      expect(fs.existsSync(path.join(ws, "ok.txt"))).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("denies writes to top-level .git", () => {
    const ws = tmpDir("sbx-ws-");
    try {
      fs.mkdirSync(path.join(ws, ".git"));
      expect(runSeatbelt(ws, `printf x > '${ws}/.git/config'`)).not.toBe(0);
      expect(fs.existsSync(path.join(ws, ".git", "config"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("denies writes to NESTED .git (recursive metadata exclusion)", () => {
    const ws = tmpDir("sbx-ws-");
    try {
      fs.mkdirSync(path.join(ws, "src", ".git", "hooks"), { recursive: true });
      expect(runSeatbelt(ws, `printf x > '${ws}/src/.git/hooks/pre-commit'`)).not.toBe(0);
      expect(fs.existsSync(path.join(ws, "src", ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("denies writes outside the workspace", () => {
    const ws = tmpDir("sbx-ws-");
    const outside = tmpDir("sbx-out-");
    try {
      expect(runSeatbelt(ws, `printf x > '${outside}/escape.txt'`)).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("allows reading outside the workspace", () => {
    const ws = tmpDir("sbx-ws-");
    try {
      expect(runSeatbelt(ws, "cat /bin/sh > /dev/null")).toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("scopes a child to its targetPaths (sibling write denied)", () => {
    const ws = tmpDir("sbx-ws-");
    try {
      fs.mkdirSync(path.join(ws, "src", "auth"), { recursive: true });
      fs.mkdirSync(path.join(ws, "src", "other"), { recursive: true });
      const target = [path.join(ws, "src", "auth")];
      expect(runSeatbelt(ws, `printf ok > '${ws}/src/auth/x.txt'`, target)).toBe(0);
      expect(runSeatbelt(ws, `printf no > '${ws}/src/other/y.txt'`, target)).not.toBe(0);
      expect(fs.existsSync(path.join(ws, "src", "other", "y.txt"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Linux — bubblewrap
// ---------------------------------------------------------------------------
function findBwrap(): string | null {
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = spawnSync("which", ["bwrap"], { encoding: "utf8" });
  const resolved = which.stdout?.trim();
  return resolved && fs.existsSync(resolved) ? resolved : null;
}

function bwrapUsable(program: string): boolean {
  // Unprivileged user namespaces must work for these tests to be meaningful;
  // many CI containers disable them, in which case we skip rather than fail.
  const probe = spawnSync(
    program,
    [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-user",
      "--unshare-pid",
      "--proc",
      "/proc",
      // Portable probe command (see detect.ts): the runtime binary always exists,
      // unlike /bin/true on e.g. NixOS.
      process.execPath,
      "--version",
    ],
    { timeout: 15_000 },
  );
  return probe.status === 0;
}

const bwrapPath = process.platform === "linux" ? findBwrap() : null;
const bwrapDescribe = bwrapPath && bwrapUsable(bwrapPath) ? describe : describe.skip;

function runBwrap(ws: string, shellCommand: string, targetPaths?: string[]): number | null {
  const { file, args } = buildBwrapCommand(
    { file: "/bin/bash", args: ["-c", shellCommand] },
    workspacePolicy(ws, targetPaths),
    ws,
    { program: bwrapPath as string },
  );
  return spawnSync(file, args, { encoding: "utf8", timeout: 30_000 }).status;
}

bwrapDescribe("bubblewrap enforcement (Linux)", () => {
  test("allows writes inside the workspace", () => {
    const ws = tmpDir("bwx-ws-");
    try {
      expect(runBwrap(ws, `printf hi > '${ws}/ok.txt'`)).toBe(0);
      expect(fs.existsSync(path.join(ws, "ok.txt"))).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("denies writes to top-level .git", () => {
    const ws = tmpDir("bwx-ws-");
    try {
      fs.mkdirSync(path.join(ws, ".git"));
      expect(runBwrap(ws, `printf x > '${ws}/.git/config'`)).not.toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("denies writes outside the workspace", () => {
    const ws = tmpDir("bwx-ws-");
    const outside = tmpDir("bwx-out-");
    try {
      expect(runBwrap(ws, `printf x > '${outside}/escape.txt'`)).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("scopes a child to its targetPaths (sibling write denied)", () => {
    const ws = tmpDir("bwx-ws-");
    try {
      fs.mkdirSync(path.join(ws, "src", "auth"), { recursive: true });
      fs.mkdirSync(path.join(ws, "src", "other"), { recursive: true });
      const target = [path.join(ws, "src", "auth")];
      expect(runBwrap(ws, `printf ok > '${ws}/src/auth/x.txt'`, target)).toBe(0);
      expect(runBwrap(ws, `printf no > '${ws}/src/other/y.txt'`, target)).not.toBe(0);
      expect(fs.existsSync(path.join(ws, "src", "other", "y.txt"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // NOTE: nested `.git` (e.g. /repo/src/.git/hooks) is intentionally NOT asserted
  // here — bwrap masks only the top-level `.git`/`.cowork` under each root
  // (documented limitation in docs/sandbox.md; macOS Seatbelt excludes them
  // recursively via a path regex).
});

// ---------------------------------------------------------------------------
// Windows — restricted-token helper
// ---------------------------------------------------------------------------
const winHelperPath =
  process.env.COWORK_WIN_SANDBOX_PATH ??
  path.resolve("crates/cowork-win-sandbox/target/release/cowork-win-sandbox.exe");
const windowsDescribe =
  process.platform === "win32" && fs.existsSync(winHelperPath) ? describe : describe.skip;

windowsDescribe("windows restricted-token helper (run before merge)", () => {
  // v1 of the helper provides restricted-token + Job Object process containment
  // only; per-root FS ACL scoping and WFP network isolation are tracked TODOs, so
  // FS allow/deny is not asserted yet — this verifies the spawn path works and
  // the handle-cleanup paths don't crash on a real Win32 kernel.
  test("runs a command under the restricted token and returns its output", () => {
    const ws = tmpDir("winx-ws-");
    try {
      const { file, args } = buildWindowsSandboxCommand(
        { file: "cmd.exe", args: ["/c", "echo", "cowork-ok"] },
        workspacePolicy(ws),
        ws,
        winHelperPath,
      );
      const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cowork-ok");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
