import type fs from "node:fs/promises";

import { type FsLike as PlatformFsLike, writeFileAtomic } from "../platform/fs";

type FsLike = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink">;

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
  await writeFileAtomic(filePath, payload, opts.mode === undefined ? {} : { mode: opts.mode }, {
    fsImpl: deps.fsImpl as PlatformFsLike | undefined,
    platform: deps.platform,
    sleepImpl: deps.sleepImpl,
    maxAttempts: opts.maxRenameAttempts,
    initialDelayMs: opts.initialRetryDelayMs,
    maxDelayMs: opts.maxRetryDelayMs,
  });
}
