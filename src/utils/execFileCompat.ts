/**
 * Small replacement for the Node `child_process.execFile` contract the
 * harness tools rely on: fully buffered stdout/stderr with a byte cap, a
 * timeout that SIGTERMs the direct child, AbortSignal support, and stable
 * error codes instead of thrown errors.
 *
 * Error codes mirror what the previous Node-based runners surfaced:
 * - "TIMEOUT"  → the timeout elapsed and the child was terminated (exit 124)
 * - "ABORT_ERR" → the AbortSignal fired (exit 130)
 * - "ENOENT"   → the executable was not found (exit 1)
 * - "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" → a stream exceeded maxBuffer (exit 1)
 */

export type ExecFileCompatOptions = {
  cwd?: string;
  /** Replaces the child environment entirely, like Node execFile's `env`. */
  env?: Record<string, string | undefined>;
  /** Byte cap applied to stdout and stderr independently. Default 1 MiB. */
  maxBuffer?: number;
  /** Kill the child (default SIGTERM) when elapsed. */
  timeoutMs?: number;
  /** Signal used for timeout/abort/overflow termination. Default SIGTERM. */
  killSignal?: NodeJS.Signals;
  signal?: AbortSignal;
};

export type ExecFileCompatResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
};

export type ExecFileCompatRunner = (
  file: string,
  args: string[],
  opts?: ExecFileCompatOptions,
) => Promise<ExecFileCompatResult>;

type KillCause = "timeout" | "abort" | "overflow";

const DEFAULT_MAX_BUFFER = 1024 * 1024;

function spawnErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "SPAWN_ERROR";
}

export async function execFileCompat(
  file: string,
  args: string[],
  opts: ExecFileCompatOptions = {},
): Promise<ExecFileCompatResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([file, ...args], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    return { stdout: "", stderr: "", exitCode: 1, errorCode: spawnErrorCode(error) };
  }
  let cause: KillCause | null = null;
  const terminate = (nextCause: KillCause) => {
    if (cause) return;
    cause = nextCause;
    try {
      proc.kill((opts.killSignal ?? "SIGTERM") as never);
    } catch {
      // already exited
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

  const readCapped = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
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
    return Buffer.concat(chunks, Math.min(total, maxBuffer)).toString("utf8");
  };

  try {
    const [stdout, stderr, exit] = await Promise.all([
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
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
