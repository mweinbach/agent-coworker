import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { canonicalizeSync, coworkHome } from "../platform/paths";

/**
 * Cross-process advisory lock for short read-modify-write cycles.
 *
 * Every target maps to private SQLite databases under a Cowork lock cache. An
 * open `BEGIN IMMEDIATE` transaction is the mutex, so the operating system and
 * SQLite release it automatically when a process exits. This deliberately
 * avoids owner-file stale cleanup: deleting or renaming a reusable lock path
 * after inspecting its contents cannot be made into a portable filesystem CAS
 * and can otherwise remove a successor lock (an ABA race).
 *
 * We lock both the stable lexical path and one canonical-path snapshot. The
 * lexical identity keeps the same spelling serialized across a symlink swap;
 * the canonical identity merges static aliases to the same file. Security-
 * sensitive callers must still revalidate descriptors around path mutation,
 * because no path lock can freeze an independently mutable alias graph.
 *
 * Calls with the same lock set within one process are additionally serialized
 * on an in-process queue, avoiding needless SQLite contention.
 */

/**
 * Longest a `withFileLock` caller waits to acquire its complete lock set,
 * including an in-process queue. Exported so bounded request handlers can use
 * the same end-to-end budget.
 */
export const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const LOCK_CACHE_DIR_SEGMENTS = ["locks", "files"] as const;

type LockDatabase = Pick<Database, "close" | "exec">;

export type FileLockOptions = {
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  /**
   * Override the private cache root. Callers using an explicitly configured
   * Cowork home should pass that home's lock root.
   */
  lockRoot?: string;
  /** @deprecated SQLite transaction locks do not require stale-owner timers. */
  staleLockMs?: number;
};

type FileLockDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openDatabase?: (filePath: string) => LockDatabase;
};

type ResolvedLockSet = {
  paths: string[];
  primaryPath: string;
  queueKey: string;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isSqliteContention(error: unknown): boolean {
  const code = errorCode(error);
  return code?.startsWith("SQLITE_BUSY") === true || code?.startsWith("SQLITE_LOCKED") === true;
}

export function fileLockRootForCoworkHome(coworkRoot: string): string {
  return path.join(canonicalizeSync(coworkRoot), ...LOCK_CACHE_DIR_SEGMENTS);
}

function stablePathIdentity(targetPath: string): string {
  // Case folding on every platform only adds conservative serialization on a
  // case-sensitive volume; it never grants access or merges file contents.
  return path.normalize(targetPath).toLowerCase();
}

function databasePathForIdentity(identity: string, lockRoot: string): string {
  const targetHash = createHash("sha256").update(identity).digest("hex");
  return path.join(lockRoot, `${targetHash}.sqlite`);
}

function resolvedLockRoot(lockRoot?: string): string {
  return canonicalizeSync(lockRoot ?? fileLockRootForCoworkHome(coworkHome()));
}

export function lockDatabasePathFor(targetPath: string, lockRoot?: string): string {
  const canonicalSnapshot = canonicalizeSync(targetPath);
  return databasePathForIdentity(stablePathIdentity(canonicalSnapshot), resolvedLockRoot(lockRoot));
}

/** @deprecated The lock is now a SQLite file, not a directory. */
export const lockDirPathFor = lockDatabasePathFor;

function resolveLockSet(targetPath: string, lockRoot?: string): ResolvedLockSet {
  const root = resolvedLockRoot(lockRoot);
  const lexicalIdentity = stablePathIdentity(path.resolve(targetPath));
  // Resolve exactly once. Root selection is independent of target spelling,
  // and hashing below never re-reads the mutable filesystem.
  const canonicalIdentity = stablePathIdentity(canonicalizeSync(targetPath));
  const primaryPath = databasePathForIdentity(canonicalIdentity, root);
  const paths = [
    ...new Set([
      databasePathForIdentity(lexicalIdentity, root),
      databasePathForIdentity(canonicalIdentity, root),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  return { paths, primaryPath, queueKey: paths.join("\0") };
}

function openLockDatabase(filePath: string): LockDatabase {
  const database = new Database(filePath, { create: true, strict: false });
  database.exec("PRAGMA busy_timeout = 0");
  return database;
}

function closeAfterFailedAcquire(database: LockDatabase): void {
  try {
    database.close(true);
  } catch {
    // There are no prepared statements, but a non-strict close is still a safe
    // final fallback if a runtime reports an unexpected strict-close error.
    database.close();
  }
}

function releaseTransaction(database: LockDatabase): void {
  let rollbackError: unknown;
  try {
    database.exec("ROLLBACK");
  } catch (error) {
    rollbackError = error;
  }

  let closeError: unknown;
  try {
    database.close(true);
  } catch (error) {
    closeError = error;
    try {
      database.close();
    } catch {
      // Preserve the strict-close error below. Closing an active SQLite
      // connection also rolls its transaction back at the native layer.
    }
  }

  if (rollbackError !== undefined) throw rollbackError;
  if (closeError !== undefined) throw closeError;
}

function acquisitionTimeoutError(lockPath: string, startedAt: number, now: () => number): Error {
  const waitedMs = Math.max(0, Math.round(now() - startedAt));
  return new Error(`Timed out acquiring file lock at ${lockPath} after ${waitedMs}ms`);
}

async function acquireCrossProcessLock(
  lockPath: string,
  startedAt: number,
  deadline: number,
  retryDelayMs: number,
  isCancelled: () => boolean,
  deps: Required<FileLockDeps>,
): Promise<() => void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  // Pre-create with private POSIX permissions. SQLite opens the existing empty
  // file and initializes it under its own locking protocol.
  await (await fs.open(lockPath, "a", 0o600)).close();

  if (isCancelled() || deps.now() >= deadline) {
    throw acquisitionTimeoutError(lockPath, startedAt, deps.now);
  }

  const database = deps.openDatabase(lockPath);
  while (true) {
    if (isCancelled() || deps.now() >= deadline) {
      closeAfterFailedAcquire(database);
      throw acquisitionTimeoutError(lockPath, startedAt, deps.now);
    }

    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!isSqliteContention(error)) {
        closeAfterFailedAcquire(database);
        throw error;
      }

      const remainingMs = deadline - deps.now();
      if (isCancelled() || remainingMs <= 0) {
        closeAfterFailedAcquire(database);
        throw acquisitionTimeoutError(lockPath, startedAt, deps.now);
      }
      await deps.sleep(Math.min(retryDelayMs, remainingMs));
      continue;
    }

    if (isCancelled() || deps.now() > deadline) {
      try {
        releaseTransaction(database);
      } catch {
        // The connection was still closed; preserve the timeout contract.
      }
      throw acquisitionTimeoutError(lockPath, startedAt, deps.now);
    }
    return () => releaseTransaction(database);
  }
}

function releaseAll(releases: Array<() => void>): void {
  let firstError: unknown;
  for (const release of [...releases].reverse()) {
    try {
      release();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function acquireLockSet(
  lockSet: ResolvedLockSet,
  startedAt: number,
  deadline: number,
  retryDelayMs: number,
  isCancelled: () => boolean,
  deps: Required<FileLockDeps>,
): Promise<() => void> {
  const releases: Array<() => void> = [];
  try {
    for (const lockPath of lockSet.paths) {
      releases.push(
        await acquireCrossProcessLock(
          lockPath,
          startedAt,
          deadline,
          retryDelayMs,
          isCancelled,
          deps,
        ),
      );
    }
  } catch (error) {
    try {
      releaseAll(releases);
    } catch {
      // Every connection was closed; preserve the acquisition error.
    }
    throw error;
  }
  return () => releaseAll(releases);
}

const inProcessQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding exclusive advisory locks scoped to `targetPath`.
 * Throws if the complete lock set is not acquired within `acquireTimeoutMs`.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
  deps: FileLockDeps = {},
): Promise<T> {
  const acquireTimeoutMs = Math.max(1, opts.acquireTimeoutMs ?? FILE_LOCK_ACQUIRE_TIMEOUT_MS);
  const retryDelayMs = Math.max(1, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const resolvedDeps: Required<FileLockDeps> = {
    now: deps.now ?? (() => performance.now()),
    sleep: deps.sleep ?? defaultSleep,
    openDatabase: deps.openDatabase ?? openLockDatabase,
  };
  const startedAt = resolvedDeps.now();
  const deadline = startedAt + acquireTimeoutMs;
  const lockSet = resolveLockSet(targetPath, opts.lockRoot);
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const clearAcquisitionTimeout = (): void => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  };
  const acquisitionTimeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => {
        cancelled = true;
        reject(acquisitionTimeoutError(lockSet.primaryPath, startedAt, resolvedDeps.now));
      },
      Math.max(0, Math.ceil(deadline - resolvedDeps.now())),
    );
  });

  const runLocked = async (): Promise<T> => {
    if (cancelled || resolvedDeps.now() >= deadline) {
      clearAcquisitionTimeout();
      throw acquisitionTimeoutError(lockSet.primaryPath, startedAt, resolvedDeps.now);
    }

    let release: () => void;
    try {
      release = await acquireLockSet(
        lockSet,
        startedAt,
        deadline,
        retryDelayMs,
        () => cancelled,
        resolvedDeps,
      );
    } catch (error) {
      clearAcquisitionTimeout();
      throw error;
    }
    clearAcquisitionTimeout();

    try {
      return await fn();
    } finally {
      release();
    }
  };

  const tail = inProcessQueues.get(lockSet.queueKey) ?? Promise.resolve();
  const run = tail.then(runLocked, runLocked);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inProcessQueues.set(lockSet.queueKey, settled);
  void settled.then(() => {
    if (inProcessQueues.get(lockSet.queueKey) === settled) {
      inProcessQueues.delete(lockSet.queueKey);
    }
  });
  return await Promise.race([run, acquisitionTimeout]);
}
