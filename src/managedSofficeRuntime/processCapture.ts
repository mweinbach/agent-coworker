import { spawn } from "node:child_process";

import type { ProcessCapture } from "./types";

export async function runProcessCapture(
  command: string,
  args: string[],
  opts: {
    env: Record<string, string | undefined>;
    cwd?: string;
    timeoutMs: number;
  },
): Promise<ProcessCapture> {
  return await new Promise<ProcessCapture>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export function processErrorMessage(result: ProcessCapture): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
}
