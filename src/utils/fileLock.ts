import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Cross-process advisory file lock for read-modify-write cycles on shared
 * JSON stores (e.g. ~/.cowork/config/*.json used by one server process per
 * workspace). Uses an atomically-created sidecar lock directory next to the
 * target file, with pid-based stale-lock takeover and a bounded retry loop —
 * the same pattern as SessionDbWriteCoordinator, minus heartbeat/telemetry,
 * sized for millisecond-scale critical sections.
 *
 * Calls for the same target within one process are additionally serialized
 * on an in-process queue so they never contend on the filesystem loop.
 */

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 10_000;

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

const lockOwnerSchema = z
  .object({
    pid: z.number().int(),
    createdAt: z.string(),
  })
  .passthrough();

type LockOwner = z.infer<typeof lockOwnerSchema>;

export type FileLockOptions = {
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
};

type FileLockDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
};

function errorCode(error: unknown): string | undefined {
  const parsed = errorWithCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export function lockDirPathFor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.lock`);
}

async function readLockOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    const parsed = lockOwnerSchema.safeParse(JSON.parse(await fs.readFile(ownerPath, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function cleanupStaleLock(
  lockDir: string,
  staleLockMs: number,
  now: () => number,
  processAlive: (pid: number) => boolean,
): Promise<boolean> {
  const staleCutoff = now() - staleLockMs;
  const owner = await readLockOwner(path.join(lockDir, "owner.json"));
  if (owner) {
    // Never steal a lock whose owner process is still alive — a slow write or
    // GC pause must not reopen the lost-update race this lock exists to close.
    // A live-but-slow owner instead surfaces as an acquire timeout upstream.
    if (processAlive(owner.pid)) return false;
    await fs.rm(lockDir, { recursive: true, force: true });
    return true;
  }

  // No readable owner metadata: fall back to the lock directory's mtime so a
  // crash between mkdir and the owner write cannot wedge the lock forever.
  try {
    const stat = await fs.stat(lockDir);
    if (stat.mtimeMs <= staleCutoff) {
      await fs.rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    // Lock directory vanished; treat as recovered contention.
    return true;
  }
  return false;
}

async function acquireCrossProcessLock(
  lockDir: string,
  opts: Required<FileLockOptions>,
  deps: Required<FileLockDeps>,
): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const ownerPath = path.join(lockDir, "owner.json");
  const startedAt = deps.now();

  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      const owner: LockOwner = {
        pid: process.pid,
        createdAt: new Date(deps.now()).toISOString(),
      };
      await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      return async () => {
        const liveOwner = await readLockOwner(ownerPath);
        if (!liveOwner || liveOwner.pid === process.pid) {
          await fs.rm(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      const code = errorCode(error);
      // Windows can surface transient EPERM/EACCES while a competing writer
      // creates or removes the lock directory; treat those like contention.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }

      if (code === "EEXIST") {
        const recovered = await cleanupStaleLock(
          lockDir,
          opts.staleLockMs,
          deps.now,
          deps.processAlive,
        );
        if (recovered) continue;
      }

      const waitedMs = deps.now() - startedAt;
      if (waitedMs >= opts.acquireTimeoutMs) {
        throw new Error(`Timed out acquiring file lock at ${lockDir} after ${waitedMs}ms`);
      }
      await deps.sleep(opts.retryDelayMs);
    }
  }
}

const inProcessQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding an exclusive advisory lock scoped to `targetPath`.
 * Throws if the lock cannot be acquired within `acquireTimeoutMs`.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
  deps: FileLockDeps = {},
): Promise<T> {
  const lockDir = lockDirPathFor(targetPath);
  const resolvedOpts: Required<FileLockOptions> = {
    acquireTimeoutMs: Math.max(1, opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS),
    retryDelayMs: Math.max(1, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
    staleLockMs: Math.max(1, opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS),
  };
  const resolvedDeps: Required<FileLockDeps> = {
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? defaultSleep,
    processAlive: deps.processAlive ?? defaultProcessAlive,
  };

  const runLocked = async (): Promise<T> => {
    const release = await acquireCrossProcessLock(lockDir, resolvedOpts, resolvedDeps);
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  const tail = inProcessQueues.get(lockDir) ?? Promise.resolve();
  const run = tail.then(runLocked, runLocked);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inProcessQueues.set(lockDir, settled);
  try {
    return await run;
  } finally {
    if (inProcessQueues.get(lockDir) === settled) {
      inProcessQueues.delete(lockDir);
    }
  }
}
