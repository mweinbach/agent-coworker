import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type LibreOfficeCapabilityDiagnostic = {
  status: "available" | "unavailable";
  checkedAt: string;
  message: string;
  version?: string;
  resolvedPath?: string;
  smoke?: {
    ok: boolean;
    durationMs: number;
    sizeBytes?: number;
    error?: string;
  };
};

type ProcessCapture = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type ProcessRunner = (
  command: string,
  args: string[],
  opts: {
    env: Record<string, string | undefined>;
    timeoutMs: number;
  },
) => Promise<ProcessCapture>;

/** Cap accumulated output so a chatty soffice run cannot grow without bound. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

async function runProcessCapture(
  command: string,
  args: string[],
  opts: {
    env: Record<string, string | undefined>;
    timeoutMs: number;
  },
): Promise<ProcessCapture> {
  const proc = Bun.spawn([command, ...args], {
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
      reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  });

  const readCapped = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      if (text.length < MAX_CAPTURE_BYTES) {
        text += decoder.decode(chunk, { stream: true });
      }
    }
    return text.slice(0, MAX_CAPTURE_BYTES);
  };

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([readCapped(proc.stdout), readCapped(proc.stderr), proc.exited]),
      timeoutPromise,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function candidateCommands(env: Record<string, string | undefined>): string[] {
  const managed = envValue(env, "COWORK_RUNTIME_SOFFICE")?.trim();
  return managed ? [managed] : [];
}

function parseVersion(output: string): string | undefined {
  return output.match(/LibreOffice\s+([^\s]+)/i)?.[1];
}

function processErrorMessage(result: ProcessCapture): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
}

async function checkLibreOfficeCapabilityWithRunner(
  opts: {
    env?: Record<string, string | undefined>;
    smoke?: boolean;
    candidates?: string[];
  },
  runProcess: ProcessRunner,
): Promise<LibreOfficeCapabilityDiagnostic> {
  const checkedAt = new Date().toISOString();
  const env = { ...(opts.env ?? process.env) };
  const candidates = opts.candidates ?? candidateCommands(env);
  let command: string | undefined;
  let version: string | undefined;
  let lastError = "";

  for (const candidate of candidates) {
    try {
      const result = await runProcess(candidate, ["--version"], { env, timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        lastError = processErrorMessage(result);
        continue;
      }
      command = candidate;
      version = parseVersion(`${result.stdout}\n${result.stderr}`);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!command) {
    return {
      status: "unavailable",
      checkedAt,
      message:
        "The active Cowork runtime does not provide a working managed headless soffice launcher. Reinstall or roll back the runtime before document rendering.",
      ...(opts.smoke === true && lastError
        ? { smoke: { ok: false, durationMs: 0, error: lastError } }
        : {}),
    };
  }

  let smoke: LibreOfficeCapabilityDiagnostic["smoke"];
  if (opts.smoke === true) {
    const startedAt = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-smoke-"));
    const inputPath = path.join(tempDir, "cowork-soffice-smoke.html");
    const outputPath = path.join(tempDir, "cowork-soffice-smoke.pdf");
    try {
      await fs.writeFile(
        inputPath,
        "<!doctype html><title>Cowork LibreOffice Smoke</title><p>Cowork LibreOffice smoke test.</p>\n",
        "utf8",
      );
      const result = await runProcess(
        command,
        ["--convert-to", "pdf", "--outdir", tempDir, inputPath],
        { env, timeoutMs: 180_000 },
      );
      const stat = await fs.stat(outputPath).catch(() => null);
      smoke =
        stat?.isFile() && stat.size > 0
          ? {
              ok: true,
              durationMs: Date.now() - startedAt,
              sizeBytes: stat.size,
            }
          : {
              ok: false,
              durationMs: Date.now() - startedAt,
              error:
                processErrorMessage(result) ||
                `Managed headless LibreOffice did not produce ${outputPath}.`,
            };
    } catch (error) {
      smoke = {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  return {
    status: smoke?.ok === false ? "unavailable" : "available",
    checkedAt,
    message:
      smoke?.ok === false
        ? (smoke.error ?? "Managed headless LibreOffice conversion smoke test failed.")
        : "Cowork's managed headless LibreOffice launcher is available; UI and printing modes are blocked.",
    version,
    resolvedPath: command,
    ...(smoke ? { smoke } : {}),
  };
}

export async function checkLibreOfficeCapability(
  opts: { env?: Record<string, string | undefined>; smoke?: boolean } = {},
): Promise<LibreOfficeCapabilityDiagnostic> {
  return await checkLibreOfficeCapabilityWithRunner(opts, runProcessCapture);
}

export const __libreOfficeInternal = {
  candidateCommands,
  checkLibreOfficeCapabilityWithRunner,
  parseVersion,
};
