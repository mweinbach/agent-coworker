import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MACOS_SEATBELT_EXECUTABLE } from "./seatbelt";
import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "./windows";

export type SandboxEnforcement = {
  filesystem: boolean;
  network: boolean;
  process: boolean;
  integrity: boolean;
};

export type WindowsSandboxProbe = {
  helperPath: string | null;
  setupPath: string | null;
  commandRunnerPath: string | null;
  sandboxHome: string;
  enforcement: SandboxEnforcement;
  setupRequired: boolean;
  warning?: string;
};

const NO_ENFORCEMENT: SandboxEnforcement = {
  filesystem: false,
  network: false,
  process: false,
  integrity: false,
};

function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function configuredBundlePath(
  env: NodeJS.ProcessEnv,
  envName: string,
  helperPath: string,
  fileName: string,
): string {
  const configured = env[envName]?.trim();
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(path.dirname(helperPath), fileName);
}

function verifyConfiguredHash(
  filePath: string,
  expected: string | undefined,
  requireAuthenticode = false,
): { ok: boolean; reason?: string } {
  const normalized = expected?.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9]{64}$/.test(normalized)) {
    return { ok: false, reason: `trusted SHA-256 is missing for ${path.basename(filePath)}` };
  }
  try {
    if (!fs.statSync(filePath).isFile()) return { ok: false, reason: `${filePath} is not a file` };
    const actual = sha256FileSync(filePath);
    if (actual !== normalized) {
      return { ok: false, reason: `SHA-256 mismatch for ${path.basename(filePath)}` };
    }
    if (requireAuthenticode) {
      const signature = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]; if ($signature.Status -eq 'Valid') { 'Valid'; exit 0 }; $signature.Status; exit 1",
          filePath,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
      );
      if (signature.status !== 0 || signature.stdout.trim() !== "Valid") {
        return {
          ok: false,
          reason: `Authenticode signature is not valid for ${path.basename(filePath)}`,
        };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `${path.basename(filePath)} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function probeWindowsSandboxBundle(
  helperPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): WindowsSandboxProbe {
  const sandboxHome = path.resolve(
    env.COWORK_WIN_SANDBOX_HOME?.trim() || path.join(os.homedir(), ".cowork"),
  );
  if (!helperPath) {
    return {
      helperPath: null,
      setupPath: null,
      commandRunnerPath: null,
      sandboxHome,
      enforcement: { ...NO_ENFORCEMENT },
      setupRequired: true,
      warning: "Windows sandbox helper (cowork-win-sandbox.exe) not found",
    };
  }
  const setupPath = configuredBundlePath(
    env,
    "COWORK_WIN_SANDBOX_SETUP",
    helperPath,
    WINDOWS_SANDBOX_SETUP_NAME,
  );
  const commandRunnerPath = configuredBundlePath(
    env,
    "COWORK_WIN_SANDBOX_COMMAND_RUNNER",
    helperPath,
    WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  );
  const requireAuthenticode = env.COWORK_WIN_SANDBOX_REQUIRE_AUTHENTICODE === "1";
  const checks = [
    verifyConfiguredHash(helperPath, env.COWORK_WIN_SANDBOX_HELPER_SHA256, requireAuthenticode),
    verifyConfiguredHash(setupPath, env.COWORK_WIN_SANDBOX_SETUP_SHA256, requireAuthenticode),
    verifyConfiguredHash(
      commandRunnerPath,
      env.COWORK_WIN_SANDBOX_COMMAND_RUNNER_SHA256,
      requireAuthenticode,
    ),
  ];
  const failed = checks.find((check) => !check.ok);
  if (failed) {
    return {
      helperPath,
      setupPath,
      commandRunnerPath,
      sandboxHome,
      enforcement: { ...NO_ENFORCEMENT },
      setupRequired: true,
      warning: `Windows sandbox integrity verification failed: ${failed.reason}. Reinstall or repair Cowork.`,
    };
  }

  const probe = spawnSync(
    helperPath,
    ["probe", "--sandbox-home", sandboxHome, "--cwd", process.cwd()],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  try {
    const parsed = JSON.parse(probe.stdout.trim()) as {
      ready?: unknown;
      filesystem?: unknown;
      network?: unknown;
      process?: unknown;
      integrity?: unknown;
      setup_required?: unknown;
    };
    const enforcement = {
      filesystem: parsed.filesystem === true,
      network: parsed.network === true,
      process: parsed.process === true,
      integrity: parsed.integrity === true,
    };
    const ready = parsed.ready === true && Object.values(enforcement).every(Boolean);
    return {
      helperPath,
      setupPath,
      commandRunnerPath,
      sandboxHome,
      enforcement,
      setupRequired: !ready || parsed.setup_required === true,
      ...(ready
        ? {}
        : {
            warning:
              "Windows sandbox setup is missing, stale, or failed its enforcement probe; run the one-time sandbox setup/repair.",
          }),
    };
  } catch {
    return {
      helperPath,
      setupPath,
      commandRunnerPath,
      sandboxHome,
      enforcement: { ...NO_ENFORCEMENT, integrity: true },
      setupRequired: true,
      warning: `Windows sandbox probe failed (exit ${probe.status ?? "unknown"}): ${probe.stderr.trim() || "invalid probe output"}`,
    };
  }
}

/**
 * Runtime capability probes for the available sandbox backends. Kept separate
 * from the {@link SandboxManager} so they can be injected/mocked in tests.
 */

let macosSeatbeltTrusted: boolean | undefined;

/** Whether the fixed macOS Seatbelt executable is owned and signed by Apple. */
export function hasSeatbelt(): boolean {
  if (macosSeatbeltTrusted !== undefined) return macosSeatbeltTrusted;
  let trusted = false;
  try {
    const stat = fs.statSync(MACOS_SEATBELT_EXECUTABLE);
    const signature = spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "-R=anchor apple", MACOS_SEATBELT_EXECUTABLE],
      { stdio: "ignore", timeout: 15_000 },
    );
    trusted =
      stat.isFile() &&
      stat.uid === 0 &&
      (stat.mode & 0o022) === 0 &&
      fs.realpathSync(MACOS_SEATBELT_EXECUTABLE) === MACOS_SEATBELT_EXECUTABLE &&
      signature.status === 0;
  } catch {
    trusted = false;
  }
  macosSeatbeltTrusted = trusted;
  return trusted;
}

/**
 * Trusted absolute locations to look for `bwrap`. We deliberately do NOT search
 * `$PATH`: a workspace-write command could plant an executable at a
 * workspace-controlled PATH entry (e.g. `node_modules/.bin/bwrap`) and, since
 * that wrapper runs as `argv[0]` of the next bash call, escape the sandbox. Only
 * root-owned system directories (or an explicit `COWORK_BWRAP_PATH`) are trusted.
 */
const TRUSTED_BWRAP_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
  "/run/current-system/sw/bin", // NixOS
];

const BWRAP_PROBE_COMMANDS = [
  "/usr/bin/true",
  "/bin/true",
  "/run/current-system/sw/bin/true",
  "/usr/bin/env",
  "/bin/env",
  "/run/current-system/sw/bin/env",
];

const bwrapUsabilityCache = new Map<string, boolean>();

/** Find a tiny host command that should exit successfully inside `--ro-bind / /`. */
export function findBwrapProbeCommand(
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  for (const candidate of BWRAP_PROBE_COMMANDS) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // ignore unreadable paths and keep trying trusted candidates
    }
  }
  return null;
}

/**
 * Whether `bwrap` at `program` can actually create the namespaces the sandbox
 * relies on. On hosts where bubblewrap is installed but unprivileged user
 * namespaces are disabled, the binary exists yet every `--unshare-user`
 * invocation fails — so the backend is effectively unavailable and commands
 * would error during sandbox setup instead of taking the configured
 * fail-closed/fallback path. Probes a trivial namespace command once and caches
 * the result (host capability is stable for the process lifetime).
 */
export function isBwrapUsable(program: string): boolean {
  const cached = bwrapUsabilityCache.get(program);
  if (cached !== undefined) return cached;
  let usable = false;
  try {
    const probeCommand = findBwrapProbeCommand();
    if (!probeCommand) {
      bwrapUsabilityCache.set(program, false);
      return false;
    }
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
        "--unshare-ipc",
        "--proc",
        "/proc",
        // Use a tiny host utility that exits 0. Do not probe with process.execPath:
        // in packaged desktop builds that is the cowork-server sidecar, which
        // rejects `--version` and makes a usable bwrap look unavailable.
        probeCommand,
      ],
      { timeout: 10_000, stdio: "ignore" },
    );
    usable = probe.status === 0;
  } catch {
    usable = false;
  }
  bwrapUsabilityCache.set(program, usable);
  return usable;
}

/** Locate the `bwrap` executable in a trusted system location, or `null`. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.COWORK_BWRAP_PATH;
  if (override && path.isAbsolute(override)) {
    try {
      if (fs.existsSync(override)) return override;
    } catch {
      // fall through to the trusted-dir search
    }
  }
  for (const dir of TRUSTED_BWRAP_DIRS) {
    const candidate = path.join(dir, "bwrap");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable directories
    }
  }
  return null;
}

/**
 * Locate the bundled Windows sandbox helper (`cowork-win-sandbox.exe`).
 * Honors the `COWORK_WIN_SANDBOX_HELPER` override first, then searches the
 * provided candidate directories (typically the app resources dir and the
 * directory next to the running binary).
 */
export function findWindowsHelper(
  candidateDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Require an absolute override path (like COWORK_BWRAP_PATH) so a relative
  // value can't resolve a workspace-controlled executable as the sandbox wrapper.
  const override = env.COWORK_WIN_SANDBOX_HELPER;
  if (override && path.isAbsolute(override)) {
    try {
      if (fs.existsSync(override)) return override;
    } catch {
      // fall through to candidate search
    }
  }
  for (const dir of candidateDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, WINDOWS_SANDBOX_HELPER_NAME);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}
