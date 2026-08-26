import fs from "node:fs/promises";

import { type FsLike as PlatformFsLike, writeFileAtomic } from "../platform/fs";

type FsLike = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink">;

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_INITIAL_DELAY_MS = 20;
const DEFAULT_MAX_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  } = {},
): Promise<void> {
  const fsImpl = deps.fsImpl ?? fs;
  const platform = deps.platform ?? process.platform;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const initialDelayMs = Math.max(1, opts.initialRetryDelayMs ?? DEFAULT_INITIAL_DELAY_MS);

  await writeFileAtomic(filePath, payload, opts.mode === undefined ? {} : { mode: opts.mode }, {
    fsImpl: fsImpl as PlatformFsLike,
    platform,
    sleepImpl,
    maxAttempts: Math.max(1, opts.maxRenameAttempts ?? DEFAULT_MAX_ATTEMPTS),
    initialDelayMs,
    maxDelayMs: Math.max(initialDelayMs, opts.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS),
  });
}
