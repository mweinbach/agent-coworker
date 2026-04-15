import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";

import fg from "fast-glob";
import { z } from "zod";

import type { GlobResult, ReadTextRangeResult, ShellExecutionResult, ToolExecutionBackend } from "./types";

type ExecRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; maxBuffer: number; signal?: AbortSignal }
) => Promise<ShellExecutionResult>;

const abortByNameSchema = z.object({ name: z.literal("AbortError") }).passthrough();
const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();
const globEntrySchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    stats: z.object({
      mtimeMs: z.number().finite().optional(),
    }).optional(),
  }).passthrough(),
]);
const destroyableStreamSchema = z.object({
  destroy: z.unknown().optional(),
}).passthrough();

function execFileAsync(
  file: string,
  args: string[],
  opts: { cwd: string; maxBuffer: number; signal?: AbortSignal }
): Promise<ShellExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        const isAbortByName = abortByNameSchema.safeParse(err).success;
        const parsedErrorCode = errorCodeSchema.safeParse(err);
        const code = parsedErrorCode.success ? parsedErrorCode.data.code : undefined;
        if (isAbortByName || code === "ABORT_ERR") {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || "Command aborted.",
            exitCode: 130,
            errorCode: "ABORT_ERR",
          });
          return;
        }
        const errorCode = typeof code === "string" ? code : undefined;
        const exitCode = typeof code === "number" ? code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode, errorCode });
      }
    );
  });
}

function buildShellExecutionPlan(platform: NodeJS.Platform, command: string): Array<{ file: string; args: string[] }> {
  if (platform === "win32") {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
    return [
      { file: "pwsh", args },
      { file: "powershell.exe", args },
    ];
  }

  return [
    { file: "/bin/bash", args: ["-lc", command] },
    { file: "/bin/sh", args: ["-lc", command] },
    { file: "bash", args: ["-lc", command] },
    { file: "sh", args: ["-lc", command] },
  ];
}

async function runShellCommandWithExec(opts: {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
  platform: NodeJS.Platform;
  execRunner: ExecRunner;
}): Promise<ShellExecutionResult> {
  const maxBuffer = 1024 * 1024 * 10;
  const plan = buildShellExecutionPlan(opts.platform, opts.command);

  for (const candidate of plan) {
    const result = await opts.execRunner(candidate.file, candidate.args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
    });
    if (result.errorCode !== "ENOENT") return result;
  }

  return {
    stdout: "",
    stderr: `No compatible shell executable was found for platform ${opts.platform}.`,
    exitCode: 1,
    errorCode: "ENOENT",
  };
}

async function runShellCommand(opts: {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
}): Promise<ShellExecutionResult> {
  return await runShellCommandWithExec({
    ...opts,
    platform: process.platform,
    execRunner: execFileAsync,
  });
}

let runShellCommandOverrideForTests:
  | ((opts: { command: string; cwd: string; abortSignal?: AbortSignal }) => Promise<ShellExecutionResult>)
  | null = null;

async function readTextRange(opts: {
  filePath: string;
  offset?: number;
  limit: number;
  abortSignal?: AbortSignal;
}): Promise<ReadTextRangeResult> {
  const start = (opts.offset || 1) - 1;
  const end = start + opts.limit;
  const lines: ReadTextRangeResult["lines"] = [];

  let lineNumber = 0;
  const stream = createReadStream(opts.filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNumber += 1;
      if (lineNumber <= start) continue;
      if (lineNumber > end) break;
      if (opts.abortSignal?.aborted) throw new Error("Cancelled by user");
      lines.push({ lineNumber, text: line });
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { lines, totalLineCount: lineNumber };
}

async function globMatches(opts: {
  pattern: string;
  cwd: string;
  maxResults: number;
  abortSignal?: AbortSignal;
}): Promise<GlobResult> {
  const matches: GlobResult["matches"] = [];
  const stream = fg.stream(opts.pattern, {
    cwd: opts.cwd,
    dot: false,
    objectMode: true,
    stats: true,
    braceExpansion: false,
    followSymbolicLinks: false,
  });

  let truncated = false;
  for await (const entry of stream as AsyncIterable<unknown>) {
    if (opts.abortSignal?.aborted) throw new Error("Cancelled by user");
    const parsedEntry = globEntrySchema.safeParse(entry);
    if (!parsedEntry.success) continue;

    if (typeof parsedEntry.data === "string") {
      matches.push({ path: parsedEntry.data, mtimeMs: 0 });
    } else {
      matches.push({
        path: parsedEntry.data.path,
        mtimeMs: parsedEntry.data.stats?.mtimeMs ?? 0,
      });
    }

    if (matches.length >= opts.maxResults) {
      truncated = true;
      const destroyableStream = destroyableStreamSchema.safeParse(stream);
      if (destroyableStream.success && typeof destroyableStream.data.destroy === "function") {
        destroyableStream.data.destroy?.();
      }
      break;
    }
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return { matches, truncated };
}

export function createLocalToolExecutionBackend(): ToolExecutionBackend {
  return {
    kind: "local",
    displayName: "local filesystem and process host",
    runShellCommand: async ({ command, cwd, abortSignal }) =>
      await (runShellCommandOverrideForTests ?? runShellCommand)({ command, cwd, abortSignal }),
    runRipgrep: async ({ rgPath, args, cwd, abortSignal }) =>
      await execFileAsync(rgPath, args, {
        cwd,
        maxBuffer: 1024 * 1024 * 10,
        signal: abortSignal,
      }),
    readTextFile: async ({ filePath }) => await fs.readFile(filePath, "utf-8"),
    readTextRange: async ({ filePath, offset, limit, abortSignal }) =>
      await readTextRange({ filePath, offset, limit, abortSignal }),
    readBinaryFile: async ({ filePath }) => await fs.readFile(filePath),
    writeTextFile: async ({ filePath, content }) => {
      await fs.writeFile(filePath, content, "utf-8");
    },
    makeDirectory: async ({ dirPath }) => {
      await fs.mkdir(dirPath, { recursive: true });
    },
    glob: async ({ pattern, cwd, maxResults, abortSignal }) =>
      await globMatches({ pattern, cwd, maxResults, abortSignal }),
  };
}

export const defaultLocalToolExecutionBackend = createLocalToolExecutionBackend();

export const __internal = {
  buildShellExecutionPlan,
  runShellCommandWithExec,
  setRunShellCommandForTests(
    runner: (opts: { command: string; cwd: string; abortSignal?: AbortSignal }) => Promise<ShellExecutionResult>
  ) {
    runShellCommandOverrideForTests = runner;
  },
  resetRunShellCommandForTests() {
    runShellCommandOverrideForTests = null;
  },
};
