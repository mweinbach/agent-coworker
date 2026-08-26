import { type RunResult, run } from "../platform/proc";

/**
 * Legacy `child_process.execFile` compatibility entrypoint.
 *
 * The implementation lives in `src/platform/proc.ts` so subprocess execution
 * has one Bun-native host boundary. This shim intentionally preserves the old
 * argument and result shape for existing call sites.
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
  /** Preserve a pre-quoted win32 command line, as required by cmd.exe batch-shim plans. */
  windowsVerbatimArguments?: boolean;
};

export type ExecFileCompatResult = RunResult;

export type ExecFileCompatRunner = (
  file: string,
  args: string[],
  opts?: ExecFileCompatOptions,
) => Promise<ExecFileCompatResult>;

export async function execFileCompat(
  file: string,
  args: string[],
  opts: ExecFileCompatOptions = {},
): Promise<ExecFileCompatResult> {
  return run(file, args, opts);
}
