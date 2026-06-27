import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { detectCapabilities } from "../../src/platform/sandbox";
import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import { resolveSandboxPolicy, type SandboxPolicy } from "../../src/platform/sandbox/policy";
import { buildSeatbeltCommand } from "../../src/platform/sandbox/seatbelt";
import { buildWindowsSandboxCommand } from "../../src/platform/sandbox/windows";

/**
 * Real OS-sandbox ENFORCEMENT tests. Unlike the unit tests (which only assert
 * the generated argv/policy text), these spawn the actual platform sandbox —
 * macOS `sandbox-exec`, Linux bubblewrap, or the Windows capability/WFP helper —
 * and assert writes are allowed/denied as the policy promises.
 *
 * They are gated by platform and backend availability. Windows additionally
 * requires RUN_WINDOWS_SANDBOX_INTEGRATION=1 because its one-time setup invokes
 * UAC and installs WFP state. Run them on native target hosts before release.
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
  test("uses the immutable Apple-signed sandbox executable", () => {
    const stat = fs.statSync("/usr/bin/sandbox-exec");
    expect(stat.uid).toBe(0);
    expect(stat.mode & 0o022).toBe(0);
    expect(fs.realpathSync("/usr/bin/sandbox-exec")).toBe("/usr/bin/sandbox-exec");
    expect(
      spawnSync("/usr/bin/codesign", [
        "--verify",
        "--strict",
        "-R=anchor apple",
        "/usr/bin/sandbox-exec",
      ]).status,
    ).toBe(0);
    expect(detectCapabilities("darwin").seatbelt).toBe(true);
  });

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

  test("denies symlink and child-process escapes", () => {
    const ws = tmpDir("sbx-ws-");
    const outside = tmpDir("sbx-out-");
    const link = path.join(ws, "outside-link");
    fs.symlinkSync(outside, link);
    try {
      expect(runSeatbelt(ws, `printf x > '${link}/symlink-escape.txt'`)).not.toBe(0);
      expect(runSeatbelt(ws, `/bin/sh -c "printf x > '${outside}/child-escape.txt'"`)).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "symlink-escape.txt"))).toBe(false);
      expect(fs.existsSync(path.join(outside, "child-escape.txt"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("denies outbound network when policy disables it", async () => {
    const ws = tmpDir("sbx-ws-");
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TCP probe did not bind a port");
      const args = ["-z", "-w", "1", "127.0.0.1", String(address.port)];
      expect(spawnSync("/usr/bin/nc", args).status).toBe(0);
      expect(runSeatbelt(ws, `/usr/bin/nc ${args.join(" ")}`)).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(ws, { recursive: true, force: true });
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

  test("allows reading global skills/plugins (~/.cowork) but keeps them read-only", () => {
    // Global skills and plugins live outside the workspace under `~/.cowork`. A
    // sandboxed command must still read/run them (reads are full-disk), while the
    // `~/.cowork` tree itself stays read-only.
    const ws = tmpDir("sbx-ws-");
    const home = tmpDir("sbx-home-");
    const skillFile = path.join(home, ".cowork", "skills", "demo", "SKILL.md");
    const pluginFile = path.join(home, ".cowork", "plugins", "demo", "skills", "x", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(skillFile, "skill-body-marker");
    fs.writeFileSync(pluginFile, "plugin-skill-marker");
    try {
      expect(runSeatbelt(ws, `cat '${skillFile}' > /dev/null`)).toBe(0);
      expect(runSeatbelt(ws, `cat '${pluginFile}' > /dev/null`)).toBe(0);
      expect(runSeatbelt(ws, `printf x > '${skillFile}'`)).not.toBe(0);
      expect(runSeatbelt(ws, `printf x > '${pluginFile}'`)).not.toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
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

  test("allows writes in a workspace that lives under a .cowork ancestor", () => {
    // The workspace is itself under a `.cowork` ancestor (like ~/.cowork/chats/<id>).
    // The metadata exclusion must be relative to the root, so writes here are NOT
    // denied by the ancestor `.cowork` segment.
    const base = tmpDir("sbx-cowork-");
    const ws = path.join(base, ".cowork", "chats", "abc");
    fs.mkdirSync(ws, { recursive: true });
    try {
      expect(runSeatbelt(ws, `printf hi > '${ws}/note.txt'`)).toBe(0);
      expect(fs.existsSync(path.join(ws, "note.txt"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
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

  test("allows reading global skills/plugins (~/.cowork) but keeps them read-only", () => {
    const ws = tmpDir("bwx-ws-");
    const home = tmpDir("bwx-home-");
    const skillFile = path.join(home, ".cowork", "skills", "demo", "SKILL.md");
    const pluginFile = path.join(home, ".cowork", "plugins", "demo", "skills", "x", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(skillFile, "skill-body-marker");
    fs.writeFileSync(pluginFile, "plugin-skill-marker");
    try {
      expect(runBwrap(ws, `cat '${skillFile}' > /dev/null`)).toBe(0);
      expect(runBwrap(ws, `cat '${pluginFile}' > /dev/null`)).toBe(0);
      expect(runBwrap(ws, `printf x > '${skillFile}'`)).not.toBe(0);
      expect(runBwrap(ws, `printf x > '${pluginFile}'`)).not.toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Existing nested `.git`/`.cowork` metadata is covered by the bwrap argv unit
  // tests. This integration file stays focused on the portable enforcement
  // cases that run quickly under the real backend.
});

// ---------------------------------------------------------------------------
// Windows — capability ACL + WFP + restricted-token/Job Object helper
// ---------------------------------------------------------------------------
const winHelperPath =
  process.env.COWORK_WIN_SANDBOX_HELPER ??
  path.resolve("crates/cowork-win-sandbox/target/release/cowork-win-sandbox.exe");
const windowsDescribe =
  process.platform === "win32" &&
  process.env.RUN_WINDOWS_SANDBOX_INTEGRATION === "1" &&
  fs.existsSync(winHelperPath)
    ? describe
    : describe.skip;
const winSandboxHome = path.resolve(
  process.env.COWORK_WIN_SANDBOX_HOME ?? path.join(os.homedir(), ".cowork"),
);

function winTestDir(prefix: string): string {
  // Windows workspace-write intentionally permits the host TEMP/TMP root. Put
  // denial targets beside the checkout so they remain outside both allowed
  // roots while still being disposable by the test process.
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function runWindowsSandbox(ws: string, file: string, args: string[]): ReturnType<typeof spawnSync> {
  const command = buildWindowsSandboxCommand(
    { file, args },
    workspacePolicy(ws),
    ws,
    winHelperPath,
    winSandboxHome,
  );
  return spawnSync(command.file, command.args, { encoding: "utf8", timeout: 30_000 });
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powershellWriteScript(target: string, value = "ok"): string {
  return `$ErrorActionPreference='Stop'; Set-Content -LiteralPath ${powershellLiteral(target)} -Value ${powershellLiteral(value)}`;
}

windowsDescribe("windows native sandbox enforcement (run before merge)", () => {
  test("reports all requested kernel enforcement dimensions ready", () => {
    const ws = winTestDir(".winx-probe-");
    try {
      const probe = spawnSync(
        winHelperPath,
        ["probe", "--sandbox-home", winSandboxHome, "--cwd", ws],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(probe.status).toBe(0);
      expect(JSON.parse(probe.stdout.trim())).toMatchObject({
        ready: true,
        filesystem: true,
        network: true,
        process: true,
        integrity: true,
        setup_required: false,
      });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("allows workspace writes and denies outside and protected metadata writes", () => {
    const ws = winTestDir(".winx-ws-");
    const outside = winTestDir(".winx-outside-");
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".cowork"), { recursive: true });
    try {
      const allowed = path.join(ws, "allowed.txt");
      expect(
        runWindowsSandbox(ws, "powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powershellWriteScript(allowed),
        ]).status,
      ).toBe(0);
      expect(fs.readFileSync(allowed, "utf8")).toContain("ok");

      const tempAllowed = path.join(
        os.tmpdir(),
        `winx-temp-allowed-${process.pid}-${Date.now()}.txt`,
      );
      try {
        expect(
          runWindowsSandbox(ws, "powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            powershellWriteScript(tempAllowed),
          ]).status,
        ).toBe(0);
        expect(fs.readFileSync(tempAllowed, "utf8")).toContain("ok");
      } finally {
        fs.rmSync(tempAllowed, { force: true });
      }

      for (const denied of [
        path.join(outside, "denied.txt"),
        path.join(ws, ".git", "config"),
        path.join(ws, ".codex", "state.json"),
        path.join(ws, ".cowork", "state.json"),
      ]) {
        expect(
          runWindowsSandbox(ws, "powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            powershellWriteScript(denied),
          ]).status,
        ).not.toBe(0);
        expect(fs.existsSync(denied)).toBe(false);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test("denies junction and child-process filesystem escapes", () => {
    const ws = winTestDir(".winx-ws-");
    const outside = winTestDir(".winx-outside-");
    const junction = path.join(ws, "junction");
    const linked = path.join(junction, "linked-escape.txt");
    const childEscape = path.join(outside, "child-escape.txt");
    const junctionResult = spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", junction, outside], {
      encoding: "utf8",
    });
    expect(junctionResult.status).toBe(0);
    try {
      expect(
        runWindowsSandbox(ws, "powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powershellWriteScript(linked, "escape"),
        ]).status,
      ).not.toBe(0);
      expect(fs.existsSync(linked)).toBe(false);

      const childScript = path.join(ws, "spawn-child.ps1");
      const childMarker = path.join(ws, "child-ran.txt");
      const childCommand = [
        "$ErrorActionPreference='Stop'",
        `Set-Content -LiteralPath ${powershellLiteral(childMarker)} -Value ran`,
        `Set-Content -LiteralPath ${powershellLiteral(childEscape)} -Value escape`,
      ].join("; ");
      fs.writeFileSync(
        childScript,
        [
          `$childCommand = ${powershellLiteral(childCommand)}`,
          "& powershell.exe -NoProfile -NonInteractive -Command $childCommand",
          "exit $LASTEXITCODE",
        ].join("\r\n"),
      );
      const childResult = runWindowsSandbox(ws, "powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        childScript,
      ]);
      expect(childResult.status).not.toBe(0);
      if (!fs.existsSync(childMarker)) {
        throw new Error(
          `Sandbox child did not reach its in-workspace marker. stdout=${childResult.stdout} stderr=${childResult.stderr}`,
        );
      }
      expect(fs.existsSync(childEscape)).toBe(false);
    } finally {
      fs.rmSync(junction, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test("denies outbound network when policy disables it", () => {
    const ws = winTestDir(".winx-ws-");
    try {
      const networkProbe = [
        "$client = [System.Net.Sockets.TcpClient]::new()",
        "try {",
        "  $task = $client.ConnectAsync('1.1.1.1', 443)",
        "  if ($task.Wait(5000) -and $client.Connected) { exit 0 }",
        "  exit 9",
        "} catch { exit 9 } finally { $client.Dispose() }",
      ].join("; ");
      expect(
        runWindowsSandbox(ws, "powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          networkProbe,
        ]).status,
      ).not.toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("runs the conservative managed network-only profile", () => {
    const ws = winTestDir(".winx-network-only-");
    const output = path.join(ws, "network-only.txt");
    try {
      const result = spawnSync(
        winHelperPath,
        [
          "run",
          "--mode",
          "network-only",
          "--sandbox-home",
          winSandboxHome,
          "--cwd",
          ws,
          "--",
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powershellWriteScript(output),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain("ok");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});
