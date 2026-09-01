/**
 * Node-compatible process-tree termination shared by the harness and Electron.
 * POSIX callers should spawn detached children so each pid names its own
 * process group; Windows uses a bounded `taskkill /T /F` helper.
 *
 * Windows taskkill enumerates descendants by parent pid at kill time. PID
 * reuse and descendants created during enumeration remain best-effort races;
 * the sandboxed lane uses the native helper's Job Object instead.
 *
 * `platform` selects a branch for injected tests. Production callers leave it
 * defaulted when signaling live processes.
 */

import { type ExecFileOptions, execFile } from "node:child_process";

import { hostPlatform } from "./host";

const WIN32_TASKKILL_TIMEOUT_MS = 5000;

type KillFn = (pid: number, signal: NodeJS.Signals) => unknown;
type ExecFileFn = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void,
) => unknown;

const defaultKill: KillFn = (pid, signal) => process.kill(pid, signal);

/**
 * Detached children have pgid equal to pid, so the negative pid reaches the
 * whole group. Fall back to the root when the group is gone or the child was
 * not detached. Errors are swallowed because the target may already be gone.
 */
function killPosixGroup(pid: number, signal: NodeJS.Signals, kill: KillFn): void {
  try {
    kill(-pid, signal);
    return;
  } catch {
    // No such process group (already reaped, or not spawned detached).
  }
  try {
    kill(pid, signal);
  } catch {
    // Already exited.
  }
}

/**
 * Signals only the detached process group. Unlike {@link killTree}, this
 * never falls back to the root pid: delayed escalation can run after the root
 * exits, when its pid may already belong to an unrelated process.
 */
export function killDetachedPosixGroup(
  pid: number,
  signal: NodeJS.Signals,
  kill: KillFn = defaultKill,
): void {
  try {
    kill(-pid, signal);
  } catch {
    // The detached group has already exited.
  }
}

/**
 * The helper is force-killed after 5s. Spawn failures, unsuccessful exits and
 * timeouts fall back to a direct SIGKILL of the root pid.
 */
async function killTreeWin32(
  pid: number,
  opts: { execFile?: ExecFileFn; kill?: KillFn } = {},
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      (opts.execFile ?? execFile)(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: WIN32_TASKKILL_TIMEOUT_MS, killSignal: "SIGKILL" },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  } catch {
    try {
      (opts.kill ?? defaultKill)(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

/**
 * Kills a process tree using a POSIX group signal (default SIGKILL, with a
 * direct-pid fallback) or Windows taskkill (always forceful).
 *
 * A structural handle delegates to its own `killTree()` so that its lifecycle
 * reporting remains authoritative, without importing a runtime-specific
 * spawner. `kill` and `execFile` are test seams for signals and the Windows
 * runner respectively.
 */
export async function killTree(
  target: number | { killTree(): Promise<void> },
  opts: {
    signal?: NodeJS.Signals;
    platform?: NodeJS.Platform;
    kill?: KillFn;
    execFile?: ExecFileFn;
  } = {},
): Promise<void> {
  if (typeof target !== "number") {
    await target.killTree();
    return;
  }
  const platform = opts.platform ?? hostPlatform();
  if (platform === "win32") {
    await killTreeWin32(target, opts);
    return;
  }
  killPosixGroup(target, opts.signal ?? "SIGKILL", opts.kill ?? defaultKill);
}
