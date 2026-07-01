/**
 * Bun-native long-lived subprocess handle used by harness services that
 * previously consumed Node's ChildProcess event API (line-oriented stdout and
 * stderr, liveness checks, graceful kill escalation, stdin writes).
 */

export type SubprocessExit = {
  exitCode: number | null;
  signalCode: string | null;
};

export type StreamingSubprocess = {
  pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  /** Resolves once the process exits. Never rejects. */
  readonly exited: Promise<SubprocessExit>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals | number): void;
  /** Present when spawned with `stdin: "pipe"`. */
  writeStdin?: (data: string | Uint8Array) => void;
  endStdin?: () => void;
};

export type SpawnStreamingOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: "ignore" | "pipe";
};

/** Spawns a child with piped stdout/stderr. Throws on spawn failure (ENOENT). */
export function spawnStreamingSubprocess(
  cmd: string[],
  opts: SpawnStreamingOptions = {},
): StreamingSubprocess {
  const stdinMode = opts.stdin ?? "ignore";
  const proc = Bun.spawn(cmd, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    stdin: stdinMode,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const exited: Promise<SubprocessExit> = proc.exited.then(
    () => ({ exitCode: proc.exitCode, signalCode: proc.signalCode }),
    () => ({ exitCode: proc.exitCode, signalCode: proc.signalCode }),
  );

  const handle: StreamingSubprocess = {
    pid: proc.pid,
    get exitCode() {
      return proc.exitCode;
    },
    get signalCode() {
      return proc.signalCode;
    },
    exited,
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill(signal?: NodeJS.Signals | number) {
      try {
        proc.kill(signal as never);
      } catch {
        // already exited
      }
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

export type LineSubscription = {
  /** Stops reading. Safe to call multiple times. */
  close(): void;
  /** Resolves when the stream is fully drained or the subscription closes. */
  done: Promise<void>;
};

/**
 * Reads a byte stream as UTF-8 text lines (LF or CRLF) and invokes `onLine`
 * for each complete line. A trailing unterminated line is flushed at EOF.
 */
export function subscribeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): LineSubscription {
  const reader = stream.getReader();
  let closed = false;

  const done = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffered += decoder.decode(value, { stream: true });
        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
          buffered = buffered.slice(newlineIndex + 1);
          if (!closed) onLine(line);
          newlineIndex = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      if (buffered && !closed) onLine(buffered.replace(/\r$/, ""));
    } catch {
      // Reader cancelled or stream errored; treat as drained.
    }
  })();

  return {
    close() {
      closed = true;
      void reader.cancel().catch(() => {});
    },
    done,
  };
}
