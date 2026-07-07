/**
 * Process lifecycle for the platform layer — the ONE implementation of
 * buffered child execution, streaming children, tree kill, graceful-shutdown
 * escalation, PID liveness, and shutdown-signal registration.
 *
 * Contracts at a glance:
 * - {@link run} is the exec engine (ports src/utils/execFileCompat.ts): fully
 *   buffered stdout/stderr with a byte cap, stable errorCode instead of
 *   throws, and — unlike the old engine — timeout/abort/overflow terminate
 *   the child's whole PROCESS TREE. POSIX children are spawned detached (own
 *   session/process group) so `kill(-pid)` reaches grandchildren; win32 uses
 *   `taskkill /PID <pid> /T /F`.
 * - {@link spawnStreaming} absorbs src/utils/subprocess.ts and returns a
 *   {@link ChildHandle} with tree-aware `killTree()` and a
 *   Windows-functional `terminateGracefully()`.
 * - {@link terminateGracefully}: POSIX SIGTERM → grace → killTree; win32
 *   `requestShutdown` RPC hook or stdin-EOF sentinel → grace → killTree.
 * - {@link isAlive} is the single documented liveness policy for all lock and
 *   job-owner probes.
 * - {@link registerShutdownSignals} / {@link onShutdownRequest} wire process
 *   shutdown handlers; the stdin-EOF watcher is opt-in per entrypoint so
 *   headless servers with a closed stdin do not exit at boot.
 *
 * Functions that operate on REAL processes (spawning, killing, watching the
 * host's stdin) are inherently host-bound: the `platform` parameter selects
 * the branch (unit-testable everywhere via injected kill fns / fake handles /
 * injected streams), but passing a non-host platform to a function that then
 * touches a live process is a test-only technique — production callers must
 * leave `platform` defaulted.
 *
 * Honest win32 caveat (critique amendment 4): pure Bun has no Job Object
 * API, so win32 tree kill is `taskkill /T`, which enumerates the child tree
 * by parent PID at kill time. That enumeration is racy against PID reuse and
 * against grandchildren spawned mid-kill — a grandchild that starts after
 * enumeration, or a PID recycled between exit and kill, can be missed or
 * (extremely unlikely, PID reuse within the window) wrongly targeted. The
 * sandboxed lane gets true Job-Object kill via the native helper; this module
 * is the best-effort unsandboxed fallback.
 */

import { resolveSpawn, UnsafeShimArgumentError } from "./exec";
import { hostPlatform } from "./host";
import { decodeChildOutput } from "./text";

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
 * (including in response to a graceful poke: SIGTERM, stdin EOF, or a
 * requestShutdown call). `reason: "terminated"` — a hard tree kill was
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
const DEFAULT_GRACE_MS = 3000;
/** Delay before a lingering POSIX group gets SIGKILL after the initial killSignal. */
const POSIX_HARD_KILL_ESCALATION_MS = 3000;

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

type KillFn = (pid: number, signal: NodeJS.Signals) => unknown;

const defaultKill: KillFn = (pid, signal) => process.kill(pid, signal);

/**
 * POSIX group kill: children of this module are spawned detached (setsid), so
 * their pgid equals their pid and `kill(-pid)` reaches the whole tree. Falls
 * back to a direct `kill(pid)` when the group is already gone (ESRCH) or the
 * pid was not a group leader. All errors are swallowed — the target may
 * already have exited.
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
 * win32 tree kill: `taskkill /PID <pid> /T /F`. Waits for taskkill to finish
 * (child enumeration happens inside it). If taskkill itself cannot be spawned
 * (or on non-win32 hosts exercising this branch in tests), falls back to a
 * direct SIGKILL of the root pid. PID-reuse raciness is documented in the
 * module docstring. Failures are swallowed — the target may already be gone.
 */
async function killTreeWin32(pid: number): Promise<void> {
  try {
    const proc = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    await proc.exited;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

/**
 * Kills a process TREE, identically callable on all platforms.
 * - POSIX: `kill(-pid, signal)` (children spawned by this module are detached
 *   group leaders), falling back to a direct `kill(pid, signal)`; `signal`
 *   defaults to SIGKILL — this is the hard phase, use
 *   {@link terminateGracefully} for a graceful window.
 * - win32: `taskkill /PID <pid> /T /F` (signal is ignored; taskkill is always
 *   forceful). See the module docstring for the PID-reuse caveat.
 *
 * Passing a {@link ChildHandle} delegates to `handle.killTree()` so the
 * handle's `exited` promise reports `reason: "terminated"`. `opts.kill` is a
 * test seam for the POSIX branch.
 */
export async function killTree(
  target: number | ChildHandle,
  opts: { signal?: NodeJS.Signals; platform?: NodeJS.Platform; kill?: KillFn } = {},
): Promise<void> {
  if (typeof target !== "number") {
    await target.killTree();
    return;
  }
  const platform = opts.platform ?? hostPlatform();
  if (platform === "win32") {
    await killTreeWin32(target);
    return;
  }
  killPosixGroup(target, opts.signal ?? "SIGKILL", opts.kill ?? defaultKill);
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
  const killSignal = opts.killSignal ?? "SIGTERM";
  const terminate = (nextCause: KillCause) => {
    if (cause) return;
    cause = nextCause;
    if (platform === "win32") {
      void killTreeWin32(proc.pid);
      return;
    }
    killPosixGroup(proc.pid, killSignal, defaultKill);
    if (killSignal !== "SIGKILL") {
      escalationTimer = setTimeout(
        () => killPosixGroup(proc.pid, "SIGKILL", defaultKill),
        POSIX_HARD_KILL_ESCALATION_MS,
      );
    }
  };

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
  /** Graceful escalation — see {@link terminateGracefully}. */
  terminateGracefully(opts?: TerminateGracefullyOptions): Promise<CloseInfo>;
  /** Present when spawned with `stdin: "pipe"`. */
  writeStdin?: (data: string | Uint8Array) => void;
  /**
   * Present when spawned with `stdin: "pipe"`. Closing stdin is the win32
   * graceful-shutdown sentinel — see {@link terminateGracefully}.
   */
  endStdin?: () => void;
}

export type SpawnStreamingOptions = {
  cwd?: string;
  /** Replaces the child environment entirely. */
  env?: Record<string, string | undefined>;
  /**
   * "pipe" is REQUIRED for the stdin-EOF graceful-shutdown mechanism on
   * win32; default "ignore" (matching the old subprocess.ts spawns).
   */
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
      if (platform === "win32") {
        await killTreeWin32(proc.pid);
        return;
      }
      killPosixGroup(proc.pid, "SIGKILL", defaultKill);
    },
    terminateGracefully(o: TerminateGracefullyOptions = {}) {
      return terminateGracefully(handle, { platform, ...o });
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

export type TerminateGracefullyOptions = {
  /** Graceful window before the hard tree kill. Default 3000ms. */
  graceMs?: number;
  /**
   * win32 graceful channel: a signal-free shutdown request the caller wires
   * (e.g. the child's `server/shutdown` JSON-RPC method). Takes precedence
   * over the stdin-EOF sentinel. Errors are swallowed and the grace window
   * still runs — the child may already be acting on the request.
   */
  requestShutdown?: () => Promise<void>;
  /** Branch selector for tests; production callers leave it defaulted. */
  platform?: NodeJS.Platform;
};

/**
 * Structural subset of {@link ChildHandle} that {@link terminateGracefully}
 * needs — fake handles satisfy it so every platform branch is unit-testable
 * on every host.
 */
export type TerminableHandle = {
  exited: Promise<CloseInfo>;
  kill(signal?: NodeJS.Signals | number): void;
  killTree(): Promise<void>;
  endStdin?: () => void;
};

/**
 * THE graceful-kill escalation (replaces the four divergent copies).
 *
 * - POSIX: SIGTERM to the direct child → wait `graceMs` → {@link killTree}.
 * - win32 (finally a REAL graceful phase instead of two TerminateProcess
 *   calls): call `opts.requestShutdown` when provided; else close the
 *   child's stdin when it was spawned with `stdin: "pipe"` (the EOF
 *   sentinel — see registerShutdownSignals/onShutdownRequest on the child
 *   side); then wait `graceMs` → killTree. When NEITHER channel exists the
 *   child cannot be asked to exit, so the grace wait is skipped and the tree
 *   is killed immediately.
 *
 * Returns `{ reason: "exited", code }` when the child exited within the
 * graceful window (including a POSIX signal death, where `code` is null) and
 * `{ reason: "terminated", code }` when the hard kill was required.
 */
export async function terminateGracefully(
  handle: TerminableHandle,
  opts: TerminateGracefullyOptions = {},
): Promise<CloseInfo> {
  const platform = opts.platform ?? hostPlatform();
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  let requested = false;
  if (platform === "win32") {
    if (opts.requestShutdown) {
      try {
        await opts.requestShutdown();
      } catch {
        // Channel failed; the child may still be shutting down — keep the grace window.
      }
      requested = true;
    } else if (handle.endStdin) {
      try {
        handle.endStdin();
      } catch {
        // stdin already closed.
      }
      requested = true;
    }
  } else {
    handle.kill("SIGTERM");
    requested = true;
  }

  if (requested && graceMs > 0) {
    const timedOut = Symbol("graceTimeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), graceMs);
    });
    const winner = await Promise.race([handle.exited, grace]);
    clearTimeout(timer);
    if (winner !== timedOut) {
      return { reason: "exited", code: (winner as CloseInfo).code };
    }
  }

  await handle.killTree();
  const close = await handle.exited;
  return { reason: "terminated", code: close.code };
}

export type ShutdownSignalOptions = {
  /**
   * Also fire the handler when this process's stdin reaches EOF (the
   * parent-side sentinel used by terminateGracefully on win32). STRICTLY
   * opt-in per entrypoint: a headless server started with a closed stdin
   * (`bun run serve < /dev/null`, service managers) must NOT exit at boot.
   * The watcher consumes (discards) stdin, so only opt in for processes that
   * do not otherwise read it.
   */
  stdinEof?: boolean;
  /** Branch selector for tests; production callers leave it defaulted. */
  platform?: NodeJS.Platform;
  /** Test seam: stdin byte stream to watch instead of the real Bun.stdin. */
  stdinStream?: ReadableStream<Uint8Array>;
};

/**
 * Registers a process shutdown handler and returns an unregister function.
 *
 * - POSIX: SIGINT, SIGTERM, SIGHUP.
 * - win32: SIGINT only (console Ctrl+C — the only signal Windows actually
 *   delivers to a handler; SIGTERM there is TerminateProcess and never runs
 *   code).
 * - stdin-EOF watcher on ANY platform when `opts.stdinEof === true`
 *   (explicit opt-in; see {@link ShutdownSignalOptions.stdinEof}).
 *
 * The handler fires AT MOST ONCE per registration, regardless of how many
 * sources trigger; register again for repeat notifications. Unregistering
 * removes the signal listeners and cancels the stdin watcher.
 */
export function registerShutdownSignals(
  handler: () => Promise<void> | void,
  opts: ShutdownSignalOptions = {},
): () => void {
  const platform = opts.platform ?? hostPlatform();
  let fired = false;
  let closed = false;
  const fire = () => {
    if (fired || closed) return;
    fired = true;
    void handler();
  };

  const signals: NodeJS.Signals[] =
    platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const listener = () => fire();
  for (const signal of signals) {
    process.on(signal, listener);
  }

  let cancelStdinWatch: (() => void) | undefined;
  if (opts.stdinEof === true) {
    const stream = opts.stdinStream ?? Bun.stdin.stream();
    const reader = stream.getReader();
    cancelStdinWatch = () => {
      void reader.cancel().catch(() => {});
    };
    void (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        return; // Cancelled or stream errored: not an EOF.
      }
      fire();
    })();
  }

  return () => {
    closed = true;
    for (const signal of signals) {
      process.off(signal, listener);
    }
    cancelStdinWatch?.();
  };
}

/**
 * Child-side alias of {@link registerShutdownSignals}: a child that wants to
 * honor its parent's terminateGracefully must call this and — when its stdin
 * is a dedicated shutdown channel — opt into `stdinEof: true` so the win32
 * stdin-EOF sentinel works. Same at-most-once and opt-in semantics.
 */
export function onShutdownRequest(
  handler: () => Promise<void> | void,
  opts: ShutdownSignalOptions = {},
): () => void {
  return registerShutdownSignals(handler, opts);
}
