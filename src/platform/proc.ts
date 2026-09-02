/**
 * Process lifecycle for the platform layer — the ONE implementation of
 * buffered child execution, streaming children, and PID liveness. Tree-kill
 * policy lives in the Node-compatible processTree module and is re-exported.
 *
 * Contracts at a glance:
 * - {@link run} is the exec engine (ports src/utils/execFileCompat.ts): fully
 *   buffered stdout/stderr with a byte cap, stable errorCode instead of
 *   throws, and — unlike the old engine — timeout/abort/overflow terminate
 *   the child's whole PROCESS TREE. POSIX children are spawned detached (own
 *   session/process group) so `kill(-pid)` reaches grandchildren; win32 uses
 *   `taskkill /PID <pid> /T /F`.
 * - {@link spawnStreaming} absorbs src/utils/subprocess.ts and returns a
 *   {@link ChildHandle} with tree-aware `killTree()`.
 * - {@link isAlive} is the single documented liveness policy for all lock and
 *   job-owner probes.
 *
 * Functions that operate on REAL processes (spawning, killing, watching the
 * host's stdin) are inherently host-bound: the `platform` parameter selects
 * the branch (unit-testable everywhere via injected kill fns / fake handles /
 * injected streams), but passing a non-host platform to a function that then
 * touches a live process is a test-only technique — production callers must
 * leave `platform` defaulted.
 *
 * See processTree.ts for the best-effort Windows descendant-enumeration and
 * PID-reuse caveats outside the native sandbox helper's Job Object.
 */

import { resolveSpawn, UnsafeShimArgumentError } from "./exec";
import { hostPlatform } from "./host";
import { killDetachedPosixGroup, killTree } from "./processTree";
import { decodeChildOutput } from "./text";

export { killTree } from "./processTree";

/**
 * Result of {@link run}. Identical shape and errorCode contract on all
 * platforms (mirrors the retired execFileCompat):
 * - "TIMEOUT" → timeoutMs elapsed, tree killed, exitCode 124
 * - "ABORT_ERR" → the AbortSignal fired, tree killed, exitCode 130
 * - "ENOENT" → executable not found, exitCode 1
 * - "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" → a stream exceeded maxBuffer, exitCode 1
 * - "UNSAFE_SHIM_ARGUMENT" → resolve:true refused a BatBadBut-unsafe batch-shim
 *   argument (win32 only), exitCode 1
 */
export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
};

/**
 * How a child ended. `reason: "exited"` — the child exited on its own
 * (including in response to SIGTERM or stdin EOF). `reason: "terminated"` — a hard tree kill was
 * requested before the exit was observed. `code` is the exit code, or null
 * when the child died to a signal (POSIX).
 */
export type CloseInfo = { reason: "exited" | "terminated"; code: number | null };

export type RunOptions = {
  cwd?: string;
  /** Replaces the child environment entirely, like Node execFile's `env`. */
  env?: Record<string, string | undefined>;
  /** Byte cap applied to stdout and stderr independently. Default 1 MiB. */
  maxBuffer?: number;
  /** Tree-kill the child (default SIGTERM on POSIX; taskkill /F on win32) when elapsed. */
  timeoutMs?: number;
  /**
   * POSIX signal used for timeout/abort/overflow group termination (default
   * SIGTERM, escalating to a SIGKILL group kill after 3s if the child lingers).
   * win32 ignores it — taskkill /F is always forceful.
   */
  killSignal?: NodeJS.Signals;
  signal?: AbortSignal;
  /** Passed through to the spawner (win32); required by exec.resolveSpawn batch shims. */
  windowsVerbatimArguments?: boolean;
  /** Route file/args through exec.resolveSpawn (PATH + PATHEXT + batch-shim wrapping). */
  resolve?: boolean;
  /**
   * Output encoding label decoded via text.decodeChildOutput (default
   * "utf-8"). maxBuffer truncation is code-point safe: a code point split by
   * the byte cap is dropped whole, never emitted as U+FFFD.
   */
  encoding?: string;
  /** Branch selector for tests; production callers leave it defaulted. */
  platform?: NodeJS.Platform;
};

type KillCause = "timeout" | "abort" | "overflow";

const DEFAULT_MAX_BUFFER = 1024 * 1024;
/** Delay before a lingering POSIX group gets SIGKILL after the initial killSignal. */
const POSIX_HARD_KILL_ESCALATION_MS = 3000;

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Single PID-liveness policy for every lock/job-owner probe in the repo:
 * signal-0 probe where ESRCH → dead; EPERM → ALIVE (the process exists, we
 * just may not signal it); ANY other error (win32 OpenProcess EINVAL etc.) →
 * ALIVE. Conservative by design: a probe that cannot prove death must never
 * report it, or lock stealers corrupt live state. `opts.kill` is a test seam.
 */
export function isAlive(
  pid: number,
  opts: { kill?: (pid: number, signal: 0) => unknown } = {},
): boolean {
  const kill = opts.kill ?? ((p: number, s: 0) => process.kill(p, s));
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) !== "ESRCH";
  }
}

/**
 * THE exec engine (ports src/utils/execFileCompat.ts; that module becomes a
 * re-export shim). Buffers stdout/stderr with an independent byte cap and
 * never throws — spawn failures come back as `errorCode` (see
 * {@link RunResult} for the full contract).
 *
 * Improvements over the old engine, identical call shape:
 * - POSIX children spawn detached (own process group), so timeout/abort/
 *   overflow kill the WHOLE TREE via `kill(-pid, killSignal)` with a SIGKILL
 *   group escalation after 3s; win32 uses `taskkill /T /F`. No more orphaned
 *   npm/dev-server grandchildren on bash-tool timeouts.
 * - Output is decoded via text.decodeChildOutput with the caller-declared
 *   `encoding`, and maxBuffer truncation is code-point safe (the old engine
 *   sliced mid-UTF-8-sequence and emitted U+FFFD).
 * - `resolve: true` routes through exec.resolveSpawn (PATH/PATHEXT lookup and
 *   BatBadBut-safe batch-shim wrapping); an unsafe shim argument returns
 *   errorCode "UNSAFE_SHIM_ARGUMENT" instead of throwing.
 */
export async function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (opts.signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: 130, errorCode: "ABORT_ERR" };
  }

  const platform = opts.platform ?? hostPlatform();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  let spawnFile = file;
  let spawnArgs = [...args];
  let verbatim = opts.windowsVerbatimArguments === true;
  if (opts.resolve) {
    try {
      const plan = resolveSpawn(file, args, {
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        platform,
      });
      spawnFile = plan.file;
      spawnArgs = plan.args;
      if (plan.windowsVerbatimArguments) verbatim = true;
    } catch (error) {
      if (error instanceof UnsafeShimArgumentError) {
        return {
          stdout: "",
          stderr: error.message,
          exitCode: 1,
          errorCode: "UNSAFE_SHIM_ARGUMENT",
        };
      }
      throw error;
    }
  }

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([spawnFile, ...spawnArgs], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      // Own session + process group on POSIX so the tree handle exists at
      // kill time. win32 stays attached; taskkill /T walks the tree instead.
      detached: platform !== "win32",
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    return { stdout: "", stderr: "", exitCode: 1, errorCode: errorCodeOf(error) ?? "SPAWN_ERROR" };
  }

  let cause: KillCause | null = null;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let rootExited = false;
  const killSignal = opts.killSignal ?? "SIGTERM";
  const hardKillDetachedGroup = () => {
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      escalationTimer = undefined;
    }
    killDetachedPosixGroup(proc.pid, "SIGKILL");
  };
  const terminate = (nextCause: KillCause) => {
    if (cause) return;
    cause = nextCause;
    void killTree(proc.pid, { platform, signal: killSignal });
    if (platform === "win32") return;
    if (killSignal !== "SIGKILL") {
      if (rootExited) {
        hardKillDetachedGroup();
        return;
      }
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        killDetachedPosixGroup(proc.pid, "SIGKILL");
      }, POSIX_HARD_KILL_ESCALATION_MS);
      escalationTimer.unref?.();
    }
  };

  const onRootExited = () => {
    rootExited = true;
    if (platform !== "win32" && cause && killSignal !== "SIGKILL") {
      // Once the root has exited, there is no useful graceful window left.
      // Reap any surviving descendants immediately and disarm the stale timer.
      hardKillDetachedGroup();
    }
  };
  void proc.exited.then(onRootExited, onRootExited);

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => terminate("timeout"), opts.timeoutMs);
  }

  const onAbort = () => terminate("abort");
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const readCapped = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let processExited = false;
    void proc.exited.finally(() => {
      processExited = true;
      if (cause) {
        void reader.cancel().catch(() => {});
      }
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (total < maxBuffer) {
          chunks.push(chunk.subarray(0, maxBuffer - total));
        }
        total += chunk.byteLength;
        if (total > maxBuffer) {
          terminate("overflow");
          if (processExited) {
            void reader.cancel().catch(() => {});
          }
        }
      }
    } catch (error) {
      if (!cause) throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, Math.min(total, maxBuffer));
  };

  try {
    const [stdoutBytes, stderrBytes, exit] = await Promise.all([
      readCapped(proc.stdout),
      readCapped(proc.stderr),
      proc.exited.then(
        (exitCode) => ({
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          signalCode: proc.signalCode,
        }),
        () => ({
          exitCode: typeof proc.exitCode === "number" ? proc.exitCode : 1,
          signalCode: proc.signalCode,
        }),
      ),
    ]);

    const decodeOpts = opts.encoding ? { encoding: opts.encoding } : {};
    const stdout = decodeChildOutput(stdoutBytes, decodeOpts);
    const stderr = decodeChildOutput(stderrBytes, decodeOpts);

    if (cause === "timeout") {
      return { stdout, stderr, exitCode: 124, errorCode: "TIMEOUT" };
    }
    if (cause === "abort") {
      return { stdout, stderr, exitCode: 130, errorCode: "ABORT_ERR" };
    }
    if (cause === "overflow") {
      return { stdout, stderr, exitCode: 1, errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" };
    }
    if (exit.signalCode) {
      // Terminated by an external signal: Node execFile surfaced this as a
      // generic failure with no numeric exit code.
      return { stdout, stderr, exitCode: 1 };
    }
    return { stdout, stderr, exitCode: exit.exitCode };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (escalationTimer) clearTimeout(escalationTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Long-lived streaming child handle (absorbs StreamingSubprocess from
 * src/utils/subprocess.ts, plus tree-aware termination). `exited` never
 * rejects; its `reason` is "terminated" only when `killTree()` was requested
 * before the exit was observed (a natural exit racing a hard kill may still
 * report "terminated" — the kill was already in flight).
 */
export interface ChildHandle {
  pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  /** Resolves once the process exits. Never rejects. */
  readonly exited: Promise<CloseInfo>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Direct-child signal (POSIX) / TerminateProcess (win32). Never throws. */
  kill(signal?: NodeJS.Signals | number): void;
  /** Hard tree kill — see {@link killTree}. */
  killTree(): Promise<void>;
  /** Present when spawned with `stdin: "pipe"`. */
  writeStdin?: (data: string | Uint8Array) => void;
  /** Present when spawned with `stdin: "pipe"`. */
  endStdin?: () => void;
}

export type SpawnStreamingOptions = {
  cwd?: string;
  /** Replaces the child environment entirely. */
  env?: Record<string, string | undefined>;
  /** Default "ignore" (matching the old subprocess.ts spawns). */
  stdin?: "ignore" | "pipe";
  /** Route file/args through exec.resolveSpawn (throws UnsafeShimArgumentError). */
  resolve?: boolean;
  windowsVerbatimArguments?: boolean;
  /** Branch selector for tests; production callers leave it defaulted. */
  platform?: NodeJS.Platform;
};

/**
 * Spawns a streaming child with piped stdout/stderr. Throws on spawn failure
 * (ENOENT) — same contract as the old spawnStreamingSubprocess. POSIX
 * children are spawned detached (own process group) so `killTree()` reaches
 * grandchildren; win32 tree kill goes through taskkill.
 */
export function spawnStreaming(
  file: string,
  args: string[],
  opts: SpawnStreamingOptions = {},
): ChildHandle {
  const platform = opts.platform ?? hostPlatform();
  const stdinMode = opts.stdin ?? "ignore";

  let spawnFile = file;
  let spawnArgs = [...args];
  let verbatim = opts.windowsVerbatimArguments === true;
  if (opts.resolve) {
    const plan = resolveSpawn(file, args, {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      platform,
    });
    spawnFile = plan.file;
    spawnArgs = plan.args;
    if (plan.windowsVerbatimArguments) verbatim = true;
  }

  const proc = Bun.spawn([spawnFile, ...spawnArgs], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    stdin: stdinMode,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    detached: platform !== "win32",
    ...(verbatim ? { windowsVerbatimArguments: true } : {}),
  });

  let forced = false;
  const exited: Promise<CloseInfo> = proc.exited.then(
    () => ({ reason: forced ? "terminated" : "exited", code: proc.exitCode }),
    () => ({ reason: forced ? "terminated" : "exited", code: proc.exitCode }),
  );

  const handle: ChildHandle = {
    pid: proc.pid,
    get exitCode() {
      return proc.exitCode;
    },
    get signalCode() {
      return proc.signalCode;
    },
    exited,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    kill(signal?: NodeJS.Signals | number) {
      try {
        proc.kill(signal as never);
      } catch {
        // already exited
      }
    },
    async killTree() {
      forced = true;
      await killTree(proc.pid, { platform });
    },
  };

  if (stdinMode === "pipe") {
    const stdin = proc.stdin as unknown as {
      write: (data: string | Uint8Array) => void;
      end: () => void;
    };
    handle.writeStdin = (data) => {
      stdin.write(data);
    };
    handle.endStdin = () => {
      try {
        stdin.end();
      } catch {
        // already closed
      }
    };
  }

  return handle;
}

export const __internal = {
  killDetachedPosixGroup,
};
