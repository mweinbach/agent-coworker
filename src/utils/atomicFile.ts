import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

type FsLike = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink">;

const WINDOWS_RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_INITIAL_DELAY_MS = 20;
const DEFAULT_MAX_DELAY_MS = 500;
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRenameError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const parsedCode = errorWithCodeSchema.safeParse(error);
  const code = parsedCode.success ? parsedCode.data.code : undefined;
  return typeof code === "string" && WINDOWS_RETRYABLE_RENAME_CODES.has(code);
}

async function renameWithRetry(
  from: string,
  to: string,
  opts: {
    fsImpl: FsLike;
    platform: NodeJS.Platform;
    sleepImpl: (ms: number) => Promise<void>;
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  }
): Promise<void> {
  let delayMs = opts.initialDelayMs;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      await opts.fsImpl.rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error, opts.platform) || attempt >= opts.maxAttempts) {
        throw error;
      }
      await opts.sleepImpl(delayMs);
      delayMs = Math.min(opts.maxDelayMs, delayMs * 2);
    }
  }
}

export async function writeTextFileAtomic(
  filePath: string,
  payload: string,
  opts: {
    mode?: number;
    maxRenameAttempts?: number;
    initialRetryDelayMs?: number;
    maxRetryDelayMs?: number;
  } = {},
  deps: {
    fsImpl?: FsLike;
    platform?: NodeJS.Platform;
    sleepImpl?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const fsImpl = deps.fsImpl ?? fs;
  const platform = deps.platform ?? process.platform;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const maxAttempts = Math.max(1, opts.maxRenameAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const initialDelayMs = Math.max(1, opts.initialRetryDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, opts.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS);

  await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  if (opts.mode === undefined) {
    await fsImpl.writeFile(tempPath, payload, "utf-8");
  } else {
    await fsImpl.writeFile(tempPath, payload, { encoding: "utf-8", mode: opts.mode });
  }

  try {
    await renameWithRetry(tempPath, filePath, {
      fsImpl,
      platform,
      sleepImpl,
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
    });
  } finally {
    try {
      await fsImpl.unlink(tempPath);
    } catch (error) {
      const parsedCode = errorWithCodeSchema.safeParse(error);
      if (!parsedCode.success || parsedCode.data.code !== "ENOENT") {
        // ignore best-effort cleanup failures
      }
    }
  }
}

export const __internal = {
  isRetryableRenameError,
};
