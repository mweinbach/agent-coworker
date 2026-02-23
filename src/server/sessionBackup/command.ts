import { spawn } from "node:child_process";
import { z } from "zod";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const errorMessageSchema = z.object({ message: z.string() }).passthrough();

export async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<CommandResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: String(err) };
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const stdoutPromise = (async () => {
    if (!child.stdout) return;
    for await (const chunk of child.stdout) stdoutChunks.push(chunk);
  })();

  const stderrPromise = (async () => {
    if (!child.stderr) return;
    for await (const chunk of child.stderr) stderrChunks.push(chunk);
  })();

  let spawnErr: unknown = null;
  const closePromise = new Promise<number | null>((resolve) => {
    child.once("error", (err) => {
      spawnErr = err;
      resolve(127);
    });
    child.once("close", (exitCode) => resolve(exitCode));
  });

  child.stdin?.end();

  const [exitCode] = await Promise.all([closePromise, stdoutPromise, stderrPromise]);

  const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
  const stderrBase = Buffer.concat(stderrChunks).toString("utf-8");
  const parsedErrorMessage = errorMessageSchema.safeParse(spawnErr);
  const spawnErrorMessage = parsedErrorMessage.success ? parsedErrorMessage.data.message : spawnErr;
  const stderr = spawnErr ? `${stderrBase}\n${String(spawnErrorMessage)}`.trim() : stderrBase;

  return { exitCode, stdout, stderr };
}
