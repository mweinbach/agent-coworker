import { spawnStreaming } from "../platform/proc";
import { subscribeLines } from "../platform/text";

/**
 * Legacy long-lived subprocess compatibility entrypoint.
 *
 * Streaming process lifecycle lives in `src/platform/proc.ts`, and line
 * decoding lives in `src/platform/text.ts`. This module keeps the historical
 * command-array API and exit shape for existing harness services.
 */

type SubprocessExit = {
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
  const [file, ...args] = cmd;
  if (!file) {
    throw new TypeError("spawnStreamingSubprocess requires a command");
  }
  const child = spawnStreaming(file, args, opts);

  const exited: Promise<SubprocessExit> = child.exited.then(() => ({
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  }));

  const handle: StreamingSubprocess = {
    pid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    exited,
    stdout: child.stdout,
    stderr: child.stderr,
    kill(signal?: NodeJS.Signals | number) {
      child.kill(signal);
    },
  };

  if (child.writeStdin) {
    handle.writeStdin = child.writeStdin;
  }
  if (child.endStdin) {
    handle.endStdin = child.endStdin;
  }

  return handle;
}

export { subscribeLines };
