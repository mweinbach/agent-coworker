import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "./host";

/**
 * Filesystem primitives with per-platform failure semantics — THE single home for
 * atomic writes/replaces, lock-code retries, cross-device fallbacks, mkdir locks,
 * symlink/junction creation, and private-file hardening. Absorbs the strategy from
 * src/utils/atomicFile.ts (temp-in-same-dir + rename-over + win32 bounded retry);
 * delete-first and copyFile-over stances elsewhere in the tree are retired in favor
 * of these functions.
 *
 * Every function takes an injectable `deps` bag (`fsImpl`, `platform`, `sleepImpl`,
 * retry tuning) so all platform branches are unit-testable on every host.
 */

/** The subset of node:fs/promises these primitives use — injectable for tests. */
export type FsLike = Pick<
  typeof fsPromises,
  | "chmod"
  | "copyFile"
  | "cp"
  | "mkdir"
  | "open"
  | "readdir"
  | "readFile"
  | "rename"
  | "rm"
  | "stat"
  | "symlink"
  | "unlink"
  | "writeFile"
>;

/**
 * Retry tuning for win32 transient-error loops. Retries only ever happen when the
 * (injected or host) platform is win32; POSIX platforms fail on the first error.
 */
export interface RetryTuning {
  /** Total attempts including the first (default 8). */
  maxAttempts?: number;
  /** First backoff delay in ms (default 20); doubles per attempt. */
  initialDelayMs?: number;
  /** Backoff ceiling in ms (default 500). */
  maxDelayMs?: number;
}

/** Injectable dependencies shared by every function in this module. */
export interface FsDeps extends RetryTuning {
  fsImpl?: FsLike;
  platform?: NodeJS.Platform;
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_INITIAL_DELAY_MS = 20;
const DEFAULT_MAX_DELAY_MS = 500;

/** Windows codes a rename-over can transiently throw while AV/indexers/readers hold the file. */
const WIN32_RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Windows codes rm can transiently throw (ENOTEMPTY: a child delete is still pending). */
const WIN32_REMOVE_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
/** Windows codes that mean "the file is locked by another process" for moveWithFallback. */
const WIN32_LOCK_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Typed error thrown by {@link moveWithFallback} when a win32 rename keeps failing
 * with lock codes (EPERM/EACCES/EBUSY) after the bounded retry budget. Callers can
 * catch THIS instead of blanket-catching; `cause` carries the final fs error.
 * Never thrown on POSIX platforms (those codes are real permission errors there).
 */
export class FileLockedError extends Error {
  readonly code = "FILE_LOCKED";
  readonly lockedPath: string;
  constructor(lockedPath: string, opts: { cause?: unknown } = {}) {
    super(`File is locked by another process after retries: ${lockedPath}`, {
      cause: opts.cause,
    });
    this.name = "FileLockedError";
    this.lockedPath = lockedPath;
  }
}

/**
 * Typed error thrown by {@link symlink} when creating a FILE symlink on win32 fails
 * with EPERM/EACCES: file symlinks require Developer Mode or elevation, and junctions
 * (the privilege-free fallback) only cover directories. Never thrown for dir links
 * (those fall back to junctions) and never thrown on POSIX platforms.
 */
export class SymlinkPrivilegeError extends Error {
  readonly code = "SYMLINK_PRIVILEGE";
  readonly linkPath: string;
  constructor(linkPath: string, opts: { cause?: unknown } = {}) {
    super(
      `Creating a file symlink at ${linkPath} requires Developer Mode or elevation on Windows; ` +
        "junctions only substitute for directory links",
      { cause: opts.cause },
    );
    this.name = "SymlinkPrivilegeError";
    this.linkPath = linkPath;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResolvedDeps {
  fsImpl: FsLike;
  platform: NodeJS.Platform;
  sleepImpl: (ms: number) => Promise<void>;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

function resolveDeps(deps: FsDeps): ResolvedDeps {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const initialDelayMs = Math.max(1, deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  return {
    fsImpl: deps.fsImpl ?? fsPromises,
    platform: deps.platform ?? hostPlatform(),
    sleepImpl: deps.sleepImpl ?? defaultSleep,
    maxAttempts,
    initialDelayMs,
    maxDelayMs: Math.max(initialDelayMs, deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
  };
}

/**
 * Runs `op`, retrying with exponential backoff ONLY when the platform is win32 and
 * the thrown code is in `retryableCodes`. POSIX platforms get exactly one attempt —
 * EPERM there is a real answer, not a transient lock.
 */
async function withWin32Retry<T>(
  op: () => Promise<T>,
  retryableCodes: ReadonlySet<string>,
  ctx: ResolvedDeps,
): Promise<T> {
  let delayMs = ctx.initialDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      const code = errorCode(error);
      const retryable = ctx.platform === "win32" && code !== undefined && retryableCodes.has(code);
      if (!retryable || attempt >= ctx.maxAttempts) {
        throw error;
      }
      await ctx.sleepImpl(delayMs);
      delayMs = Math.min(ctx.maxDelayMs, delayMs * 2);
    }
  }
}

/** Unique sibling temp path so the final step is always a SAME-DIRECTORY rename. */
function tempSiblingPath(filePath: string): string {
  const random = Math.random().toString(16).slice(2);
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${random}.tmp`,
  );
}

async function fsyncPath(p: string, fsImpl: FsLike): Promise<void> {
  const handle = await fsImpl.open(p, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best-effort directory fsync (POSIX only — win32 cannot open directories). */
async function fsyncDirBestEffort(dir: string, ctx: ResolvedDeps): Promise<void> {
  if (ctx.platform === "win32") return;
  try {
    const handle = await ctx.fsImpl.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is a durability nicety; never fail the write over it.
  }
}

async function unlinkBestEffort(p: string, fsImpl: FsLike): Promise<void> {
  try {
    await fsImpl.unlink(p);
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Atomically writes `data` to `filePath`: parent dirs are created, the payload goes
 * to a unique temp file IN THE SAME DIRECTORY, then a rename-over publishes it, so
 * concurrent readers see either the old or the new complete content — never a
 * partial file. Identical strategy on all platforms; on win32 the rename is retried
 * with bounded backoff on EPERM/EACCES/EBUSY (AV scanners/indexers/readers briefly
 * lock the destination), on POSIX it is a single atomic rename(2). `mode` applies to
 * the temp file at creation (effective on POSIX; win32 has no POSIX modes).
 * `fsync: true` syncs the temp file before the rename (and the directory on POSIX,
 * best-effort). Strings are written UTF-8. The temp file is removed on failure.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: { mode?: number; fsync?: boolean } = {},
  deps: FsDeps = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  const dir = path.dirname(filePath);
  await ctx.fsImpl.mkdir(dir, { recursive: true });
  const tempPath = tempSiblingPath(filePath);
  try {
    if (opts.mode === undefined) {
      await ctx.fsImpl.writeFile(tempPath, data);
    } else {
      await ctx.fsImpl.writeFile(tempPath, data, { mode: opts.mode });
    }
    if (opts.fsync) {
      await fsyncPath(tempPath, ctx.fsImpl);
    }
    await withWin32Retry(
      () => ctx.fsImpl.rename(tempPath, filePath),
      WIN32_RENAME_RETRY_CODES,
      ctx,
    );
    if (opts.fsync) {
      await fsyncDirBestEffort(dir, ctx);
    }
  } finally {
    await unlinkBestEffort(tempPath, ctx.fsImpl);
  }
}

/**
 * Atomically replaces `destPath` with the FILE at `sourcePath` (move semantics: the
 * source is gone afterwards). Primary path is rename-over — atomic on POSIX, retried
 * on win32 lock codes. On EXDEV (cross-device/cross-drive) it falls back to
 * copy-to-temp-in-dest-dir + fsync + rename-over + unlink source, so `destPath`
 * NEVER has a missing/zero-length window on any platform (no delete-first, ever).
 * Files only — the EXDEV fallback uses copyFile.
 */
export async function replaceFileAtomic(
  sourcePath: string,
  destPath: string,
  deps: FsDeps = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  try {
    await withWin32Retry(
      () => ctx.fsImpl.rename(sourcePath, destPath),
      WIN32_RENAME_RETRY_CODES,
      ctx,
    );
    return;
  } catch (error) {
    if (errorCode(error) !== "EXDEV") {
      throw error;
    }
  }
  // EXDEV: stage a copy next to dest so the publish step is a same-volume rename.
  await ctx.fsImpl.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = tempSiblingPath(destPath);
  try {
    await ctx.fsImpl.copyFile(sourcePath, tempPath);
    await fsyncPath(tempPath, ctx.fsImpl);
    await withWin32Retry(
      () => ctx.fsImpl.rename(tempPath, destPath),
      WIN32_RENAME_RETRY_CODES,
      ctx,
    );
  } finally {
    await unlinkBestEffort(tempPath, ctx.fsImpl);
  }
  await withWin32Retry(() => ctx.fsImpl.unlink(sourcePath), WIN32_REMOVE_RETRY_CODES, ctx);
}

/** Best-effort removal of stale `<dest>.old-*` aside files from previous swaps. */
async function cleanupAsideFilesBestEffort(destPath: string, fsImpl: FsLike): Promise<void> {
  const dir = path.dirname(destPath);
  const prefix = `${path.basename(destPath)}.old-`;
  let entries: string[];
  try {
    entries = await fsImpl.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    await unlinkBestEffort(path.join(dir, entry), fsImpl);
  }
}

/**
 * Atomically replaces a possibly-RUNNING executable at `destPath` with the one at
 * `sourcePath`, converging the codex/ripgrep installers on one promoted path.
 *
 * - POSIX: a plain rename — replacing a running executable's directory entry is
 *   legal; the running image keeps its unlinked inode. Stage the new file on the
 *   same volume (no EXDEV fallback here by design).
 * - win32: you cannot rename OVER a running exe, but you can rename it ASIDE. The
 *   existing dest is renamed to `<dest>.old-<pid>` (retried on lock codes), the new
 *   file is renamed into place (retried; rolled back to the aside on failure,
 *   best-effort), then the aside and any stale `<dest>.old-*` leftovers from prior
 *   swaps are removed best-effort (a still-running old image keeps its aside file
 *   until a later call sweeps it).
 *
 * Returns `{ finalPath }` — always `destPath` — so callers pin ONE promoted path on
 * every platform.
 */
export async function replaceExecutableAtomic(
  sourcePath: string,
  destPath: string,
  deps: FsDeps = {},
): Promise<{ finalPath: string }> {
  const ctx = resolveDeps(deps);
  if (ctx.platform !== "win32") {
    await ctx.fsImpl.rename(sourcePath, destPath);
    return { finalPath: destPath };
  }
  await cleanupAsideFilesBestEffort(destPath, ctx.fsImpl);
  const asidePath = `${destPath}.old-${process.pid}`;
  let movedAside = false;
  try {
    await withWin32Retry(
      () => ctx.fsImpl.rename(destPath, asidePath),
      WIN32_RENAME_RETRY_CODES,
      ctx,
    );
    movedAside = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    // No existing dest — nothing to move aside.
  }
  try {
    await withWin32Retry(
      () => ctx.fsImpl.rename(sourcePath, destPath),
      WIN32_RENAME_RETRY_CODES,
      ctx,
    );
  } catch (error) {
    if (movedAside) {
      // Best-effort rollback so dest is not left missing.
      try {
        await ctx.fsImpl.rename(asidePath, destPath);
      } catch {
        // The aside file remains for the next cleanup sweep.
      }
    }
    throw error;
  }
  if (movedAside) {
    await unlinkBestEffort(asidePath, ctx.fsImpl);
  }
  return { finalPath: destPath };
}

/**
 * Moves `src` (file OR directory) to `dest` with honest per-platform failure
 * handling — the ONE implementation for the five hand-rolled move/rename sites:
 *
 * - Primary path: rename. On win32, lock codes (EPERM/EACCES/EBUSY) are retried
 *   with bounded backoff; if they persist, a typed {@link FileLockedError} is
 *   thrown (never a blanket catch — callers distinguish "locked" from "broken").
 * - EXDEV (cross-device/drive) on any platform: copy (recursive, dereferencing
 *   nothing — `fs.cp` with force) then remove the source via
 *   {@link removeWithRetry}.
 * - Every other error propagates untouched on every platform (POSIX EPERM is a
 *   real permission error, not a lock).
 */
export async function moveWithFallback(
  src: string,
  dest: string,
  deps: FsDeps = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  try {
    await withWin32Retry(() => ctx.fsImpl.rename(src, dest), WIN32_LOCK_CODES, ctx);
    return;
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && code === "EXDEV") {
      // Fall through to copy+remove below.
    } else if (ctx.platform === "win32" && code !== undefined && WIN32_LOCK_CODES.has(code)) {
      throw new FileLockedError(src, { cause: error });
    } else {
      throw error;
    }
  }
  await ctx.fsImpl.mkdir(path.dirname(dest), { recursive: true });
  await ctx.fsImpl.cp(src, dest, { recursive: true, force: true });
  await removeWithRetry(src, { recursive: true }, deps);
}

/**
 * Removes a file or directory with per-platform retry semantics. Missing targets
 * are always OK (`force`). On win32, transient EPERM/EBUSY/ENOTEMPTY (AV scanners,
 * lagging child deletes) are retried with bounded backoff; POSIX gets one attempt.
 * `recursive: true` removes directory trees. `bestEffort: true` swallows whatever
 * error remains after the retry budget — cleanup-path semantics for callers that
 * must not fail their own teardown (the mutationGuard/test-loop convergence point).
 */
export async function removeWithRetry(
  p: string,
  opts: { recursive?: boolean; bestEffort?: boolean } = {},
  deps: FsDeps = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  try {
    await withWin32Retry(
      () => ctx.fsImpl.rm(p, { recursive: opts.recursive ?? false, force: true, maxRetries: 0 }),
      WIN32_REMOVE_RETRY_CODES,
      ctx,
    );
  } catch (error) {
    if (opts.bestEffort) {
      return;
    }
    throw error;
  }
}

/** Shape of the `owner.json` record kept inside a lock directory. */
export interface LockDirOwner {
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

/** Handle returned by {@link acquireLockDir}. */
export interface LockHandle {
  /** Removes the lock directory (best-effort, idempotent, never throws). */
  release(): Promise<void>;
  /** Rewrites owner.json with a fresh heartbeatAt. No-op after release. */
  heartbeat(): Promise<void>;
}

const OWNER_FILE_NAME = "owner.json";

/**
 * PID-liveness probe — the ONE documented policy (mirrors the planned
 * `platform.proc.isAlive`; switch to that import once proc.ts lands):
 * `kill(pid, 0)` success → alive; ESRCH → dead; EPERM → alive (exists, not ours);
 * ANY other error (win32 OpenProcess EINVAL, bad input) → alive. The conservative
 * direction: when in doubt, NEVER steal the lock.
 */
function isAliveConservative(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("acquireLockDir aborted", { cause: signal.reason });
  }
}

interface LockDeps extends FsDeps {
  /** Test seam: PID-liveness probe (defaults to the conservative kill(pid,0) policy). */
  isAliveImpl?: (pid: number) => boolean;
  /** Test seam: clock (defaults to Date.now). */
  nowImpl?: () => number;
  /** Delay between contention polls in ms (default 100). */
  pollIntervalMs?: number;
}

/**
 * Decides whether an existing lock dir is stale and breaks it if so. Policy:
 * - owner.json readable with a pid: recorded on ANOTHER host → never break
 *   (liveness is unknowable); this host + pid alive → never break (live-pid
 *   refusal, regardless of heartbeat age); pid dead → break immediately.
 * - owner.json missing/corrupt (crashed mid-acquire): break only once the lock
 *   dir's mtime is older than `staleMs` — a fresh dir may belong to an acquirer
 *   that has not written owner.json yet.
 * Returns true when the caller should immediately retry mkdir.
 */
async function tryBreakStaleLock(
  lockPath: string,
  staleMs: number,
  ctx: ResolvedDeps,
  isAlive: (pid: number) => boolean,
  now: () => number,
  deps: FsDeps,
): Promise<boolean> {
  let owner: LockDirOwner | undefined;
  try {
    const raw = await ctx.fsImpl.readFile(path.join(lockPath, OWNER_FILE_NAME), "utf-8");
    const parsed: unknown = JSON.parse(String(raw));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      Number.isInteger((parsed as { pid: number }).pid) &&
      (parsed as { pid: number }).pid > 0
    ) {
      owner = parsed as LockDirOwner;
    }
  } catch {
    // Missing or corrupt owner.json — handled by the mtime policy below.
  }
  if (owner !== undefined) {
    if (typeof owner.hostname === "string" && owner.hostname !== os.hostname()) {
      return false; // Another host's lock: liveness unknowable, never steal.
    }
    if (isAlive(owner.pid)) {
      return false; // Live owner: refuse, regardless of heartbeat age.
    }
  } else {
    try {
      const stats = await ctx.fsImpl.stat(lockPath);
      if (now() - stats.mtimeMs < staleMs) {
        return false; // Possibly an acquirer mid-write; give it staleMs.
      }
    } catch (error) {
      // Lock vanished between mkdir and stat: retry immediately.
      return errorCode(error) === "ENOENT";
    }
  }
  await removeWithRetry(lockPath, { recursive: true, bestEffort: true }, deps);
  return true;
}

/**
 * Cross-process mutual exclusion via mkdir (atomic on every platform and on network
 * filesystems) — replaces the five divergent lock implementations. Semantics:
 *
 * - Acquisition: `mkdir(lockPath)` wins the race; an `owner.json`
 *   ({@link LockDirOwner}: pid, hostname, acquiredAt, heartbeatAt) is then written
 *   atomically inside. Missing parent directories are created.
 * - Contention: EEXIST means held — poll every `pollIntervalMs`. On win32,
 *   transient EPERM/EACCES from mkdir (AV/indexer interference) also count as
 *   contention-ish and are retried within the bounded budget instead of failing.
 * - Stale break: gated on PID liveness with the conservative policy documented on
 *   the private probe (dead → break; alive/other-host/unknown → NEVER steal);
 *   missing/corrupt owner.json breaks only after the dir is `staleMs` old.
 * - Heartbeat: `heartbeat()` REWRITES owner.json with a fresh `heartbeatAt`
 *   (never utimes — coarse-mtime filesystems); pass `heartbeatMs` for an unref'd
 *   auto-heartbeat interval, cleared on release.
 * - Cancellation: `signal` aborts the wait (rejects with `signal.reason`).
 * - `release()` is idempotent and best-effort (a dead holder is rescued by the
 *   stale-break policy, so release never throws).
 */
export async function acquireLockDir(
  lockPath: string,
  opts: { staleMs?: number; heartbeatMs?: number; signal?: AbortSignal } = {},
  deps: LockDeps = {},
): Promise<LockHandle> {
  const ctx = resolveDeps(deps);
  const staleMs = opts.staleMs ?? 30_000;
  const pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? 100);
  const isAlive = deps.isAliveImpl ?? isAliveConservative;
  const now = deps.nowImpl ?? Date.now;

  let transientAttempts = 0;
  for (;;) {
    throwIfAborted(opts.signal);
    try {
      await ctx.fsImpl.mkdir(lockPath);
      break; // Acquired.
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        await ctx.fsImpl.mkdir(path.dirname(lockPath), { recursive: true });
        continue;
      }
      if (code === "EEXIST") {
        const broke = await tryBreakStaleLock(lockPath, staleMs, ctx, isAlive, now, deps);
        if (!broke) {
          await ctx.sleepImpl(pollIntervalMs);
        }
        continue;
      }
      if (ctx.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        transientAttempts += 1;
        if (transientAttempts >= ctx.maxAttempts) {
          throw error;
        }
        await ctx.sleepImpl(pollIntervalMs);
        continue;
      }
      throw error;
    }
  }

  const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
  const acquiredAt = new Date(now()).toISOString();
  const writeOwner = async (): Promise<void> => {
    const record: LockDirOwner = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt,
      heartbeatAt: new Date(now()).toISOString(),
    };
    await writeFileAtomic(ownerPath, JSON.stringify(record), {}, deps);
  };
  try {
    await writeOwner();
  } catch (error) {
    await removeWithRetry(lockPath, { recursive: true, bestEffort: true }, deps);
    throw error;
  }

  let released = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const inFlightHeartbeats = new Set<Promise<void>>();
  const heartbeat = async (): Promise<void> => {
    if (released) return;
    const pending = writeOwner();
    inFlightHeartbeats.add(pending);
    try {
      await pending;
    } finally {
      inFlightHeartbeats.delete(pending);
    }
  };
  if (opts.heartbeatMs !== undefined && opts.heartbeatMs > 0) {
    timer = setInterval(() => {
      heartbeat().catch(() => {
        // Heartbeat failures are non-fatal; the stale policy tolerates them.
      });
    }, opts.heartbeatMs);
    timer.unref?.();
  }
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    released = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
    releasePromise = (async () => {
      await Promise.allSettled([...inFlightHeartbeats]);
      await removeWithRetry(lockPath, { recursive: true, bestEffort: true }, deps);
    })();
    return releasePromise;
  };
  return {
    heartbeat,
    release,
  };
}

/** How {@link symlink} actually materialized the link. */
export type SymlinkMechanism = "symlink" | "junction";

/**
 * Creates a symbolic link with per-platform privilege handling:
 *
 * - POSIX: plain `symlink(target, linkPath)` — `type` is irrelevant and ignored.
 * - win32 directory links: tries a real symlink first (works with Developer Mode /
 *   elevation); on EPERM/EACCES falls back to a JUNCTION, which is privilege-free.
 *   Junctions require an absolute target, so relative targets are resolved against
 *   the link's directory for the fallback.
 * - win32 file links: junctions cannot cover files, so EPERM/EACCES becomes a typed
 *   {@link SymlinkPrivilegeError} advising Developer Mode/elevation.
 *
 * `type` is inferred by stat-ing the target when omitted (missing target → "file",
 * matching Node's default). Returns the mechanism used so callers/tests can assert
 * which one materialized.
 */
export async function symlink(
  target: string,
  linkPath: string,
  opts: { type?: "file" | "dir" } = {},
  deps: FsDeps = {},
): Promise<{ mechanism: SymlinkMechanism }> {
  const ctx = resolveDeps(deps);
  let type = opts.type;
  if (type === undefined) {
    try {
      const stats = await ctx.fsImpl.stat(
        path.resolve(path.dirname(path.resolve(linkPath)), target),
      );
      type = stats.isDirectory() ? "dir" : "file";
    } catch {
      type = "file";
    }
  }
  if (ctx.platform !== "win32") {
    await ctx.fsImpl.symlink(target, linkPath);
    return { mechanism: "symlink" };
  }
  if (type === "dir") {
    try {
      await ctx.fsImpl.symlink(target, linkPath, "dir");
      return { mechanism: "symlink" };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
    }
    const absoluteTarget = path.resolve(path.dirname(path.resolve(linkPath)), target);
    await ctx.fsImpl.symlink(absoluteTarget, linkPath, "junction");
    return { mechanism: "junction" };
  }
  try {
    await ctx.fsImpl.symlink(target, linkPath, "file");
    return { mechanism: "symlink" };
  } catch (error) {
    const code = errorCode(error);
    if (code === "EPERM" || code === "EACCES") {
      throw new SymlinkPrivilegeError(linkPath, { cause: error });
    }
    throw error;
  }
}

let win32HardenGapLogged = false;

function logWin32HardenGap(
  fnName: string,
  p: string,
  debugLog: ((message: string) => void) | undefined,
): void {
  const message =
    `platform.fs.${fnName}: win32 owner-only ACL hardening is a documented Phase-1 no-op ` +
    `(icacls DACL support is a follow-up); left ${p} with inherited ACLs`;
  if (debugLog !== undefined) {
    debugLog(message);
    return;
  }
  if (!win32HardenGapLogged) {
    win32HardenGapLogged = true;
    // Deliberate once-per-process console.debug so the documented win32 gap stays visible.
    console.debug(message);
  }
}

/**
 * Restricts a directory to the current user. POSIX: `chmod 0o700`. win32: a
 * DOCUMENTED Phase-1 NO-OP with a debug log (once per process, or every call via
 * the injectable `debugLog`) — NTFS ACL hardening via icacls is a follow-up; the
 * log keeps the gap visible instead of silently pretending.
 */
export async function hardenPrivateDir(
  p: string,
  deps: FsDeps & { debugLog?: (message: string) => void } = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  if (ctx.platform === "win32") {
    logWin32HardenGap("hardenPrivateDir", p, deps.debugLog);
    return;
  }
  await ctx.fsImpl.chmod(p, 0o700);
}

/**
 * Restricts a file to the current user. POSIX: `chmod 0o600`. win32: the same
 * documented Phase-1 no-op + debug log as {@link hardenPrivateDir}.
 */
export async function hardenPrivateFile(
  p: string,
  deps: FsDeps & { debugLog?: (message: string) => void } = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  if (ctx.platform === "win32") {
    logWin32HardenGap("hardenPrivateFile", p, deps.debugLog);
    return;
  }
  await ctx.fsImpl.chmod(p, 0o600);
}
