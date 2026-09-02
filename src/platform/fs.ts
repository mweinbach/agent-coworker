import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { hostPlatform } from "./host";

/**
 * Filesystem primitives with per-platform failure semantics — THE single home for
 * atomic writes/replaces, lock-code retries, cross-device fallbacks,
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

export type PrivatePathCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
};

export interface PrivatePathDeps extends FsDeps {
  currentUserSid?: string;
  runCommand?: (file: string, args: string[]) => Promise<PrivatePathCommandResult>;
}

export interface PrivatePathSyncDeps {
  chmodSync?: typeof fsSync.chmodSync;
  currentUserSid?: string;
  platform?: NodeJS.Platform;
  runCommandSync?: (file: string, args: string[]) => PrivatePathCommandResult;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_INITIAL_DELAY_MS = 20;
const DEFAULT_MAX_DELAY_MS = 500;

/** Windows codes a rename-over can transiently throw while AV/indexers/readers hold the file. */
const WIN32_RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Windows codes rm can transiently throw (ENOTEMPTY: a child delete is still pending). */
const WIN32_REMOVE_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
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
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
}

async function fsyncPath(p: string, ctx: ResolvedDeps): Promise<void> {
  // POSIX can flush a read-only descriptor, including when the published mode
  // deliberately has no write bits. Retain the existing Windows open mode.
  const handle = await ctx.fsImpl.open(p, ctx.platform === "win32" ? "r+" : "r");
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
 * `append: true` stages a copy of the current file before appending, using a
 * copy-on-write clone when supported, so appends are atomic without buffering
 * the existing file in memory. `beforeCommit` runs before each rename attempt;
 * callers can recheck authorization and detect concurrent external changes.
 * `fsync: true` syncs the temp file before the rename (and the directory on POSIX,
 * best-effort). Strings are written UTF-8. The temp file is removed on failure.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: {
    mode?: number;
    fsync?: boolean;
    append?: boolean;
    beforeCommit?: (stagedPath: string) => void | Promise<void>;
  } = {},
  deps: FsDeps = {},
): Promise<void> {
  const ctx = resolveDeps(deps);
  const dir = path.dirname(filePath);
  await ctx.fsImpl.mkdir(dir, { recursive: true });
  const tempPath = tempSiblingPath(filePath);
  try {
    let copied = false;
    if (opts.append) {
      try {
        await ctx.fsImpl.copyFile(
          filePath,
          tempPath,
          fsSync.constants.COPYFILE_EXCL | fsSync.constants.COPYFILE_FICLONE,
        );
        copied = true;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    if (copied && opts.mode !== undefined) {
      // copyFile preserves source permissions, while writeFile's mode option
      // only applies when creating a file. Make the stage writable first and
      // restore the requested final mode after its payload is complete.
      await ctx.fsImpl.chmod(tempPath, opts.mode | 0o600);
    }
    await ctx.fsImpl.writeFile(tempPath, data, {
      flag: copied ? "a" : "wx",
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    });
    if (copied && opts.mode !== undefined) await ctx.fsImpl.chmod(tempPath, opts.mode);
    if (opts.fsync) {
      await fsyncPath(tempPath, ctx);
    }
    await withWin32Retry(
      async () => {
        await opts.beforeCommit?.(tempPath);
        await ctx.fsImpl.rename(tempPath, filePath);
      },
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
    await fsyncPath(tempPath, ctx);
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

const WIN32_USER_SID_PATTERN = /^S-\d+(?:-\d+)+$/i;
const WIN32_USER_SID_SEARCH_PATTERN = /\bS-\d+(?:-\d+)+\b/i;

let cachedWin32UserSid: string | undefined;
let pendingWin32UserSid: Promise<string> | undefined;

function normalizeWin32UserSid(sid: string): string {
  const trimmed = sid.trim();
  if (!WIN32_USER_SID_PATTERN.test(trimmed)) {
    throw new Error(`platform.fs: invalid Windows user SID: ${JSON.stringify(sid)}`);
  }
  return `S${trimmed.slice(1)}`;
}

function commandFailure(operation: string, file: string, result: PrivatePathCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || result.errorCode || "no details";
  return new Error(
    `platform.fs: ${operation}: ${file} failed with exit code ${result.exitCode}: ${detail}`,
  );
}

function parseWin32UserSid(result: PrivatePathCommandResult): string {
  if (result.exitCode !== 0) {
    throw commandFailure("resolve current Windows user SID", "whoami.exe", result);
  }
  const match = result.stdout.match(WIN32_USER_SID_SEARCH_PATTERN);
  if (!match) {
    throw new Error(
      `platform.fs: resolve current Windows user SID: whoami.exe returned no SID: ${JSON.stringify(result.stdout.trim())}`,
    );
  }
  return normalizeWin32UserSid(match[0]);
}

async function defaultPrivatePathCommand(
  file: string,
  args: string[],
): Promise<PrivatePathCommandResult> {
  return await new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
        ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
      });
    });
  });
}

function defaultPrivatePathCommandSync(file: string, args: string[]): PrivatePathCommandResult {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error
      ? { errorCode: (result.error as NodeJS.ErrnoException).code ?? result.error.message }
      : {}),
  };
}

async function resolveWin32UserSid(deps: PrivatePathDeps): Promise<string> {
  if (deps.currentUserSid !== undefined) {
    return normalizeWin32UserSid(deps.currentUserSid);
  }
  if (deps.runCommand !== undefined) {
    return parseWin32UserSid(await deps.runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]));
  }
  if (cachedWin32UserSid !== undefined) return cachedWin32UserSid;
  pendingWin32UserSid ??= defaultPrivatePathCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"])
    .then(parseWin32UserSid)
    .then((sid) => {
      cachedWin32UserSid = sid;
      return sid;
    })
    .finally(() => {
      pendingWin32UserSid = undefined;
    });
  return await pendingWin32UserSid;
}

function resolveWin32UserSidSync(deps: PrivatePathSyncDeps): string {
  if (deps.currentUserSid !== undefined) {
    return normalizeWin32UserSid(deps.currentUserSid);
  }
  if (cachedWin32UserSid !== undefined) return cachedWin32UserSid;
  const runCommandSync = deps.runCommandSync ?? defaultPrivatePathCommandSync;
  const sid = parseWin32UserSid(runCommandSync("whoami.exe", ["/user", "/fo", "csv", "/nh"]));
  if (deps.runCommandSync === undefined) cachedWin32UserSid = sid;
  return sid;
}

function win32PrivatePathArgs(p: string, sid: string, kind: "directory" | "file"): string[] {
  const permission = kind === "directory" ? "(OI)(CI)F" : "F";
  return [p, "/inheritancelevel:r", "/grant:r", `*${sid}:${permission}`, "/Q"];
}

async function hardenPrivatePathWin32(
  p: string,
  kind: "directory" | "file",
  deps: PrivatePathDeps,
): Promise<void> {
  const sid = await resolveWin32UserSid(deps);
  const result = await (deps.runCommand ?? defaultPrivatePathCommand)(
    "icacls.exe",
    win32PrivatePathArgs(p, sid, kind),
  );
  if (result.exitCode !== 0) {
    throw commandFailure(`harden private ${kind} ${p}`, "icacls.exe", result);
  }
}

function hardenPrivatePathWin32Sync(
  p: string,
  kind: "directory" | "file",
  deps: PrivatePathSyncDeps,
): void {
  const sid = resolveWin32UserSidSync(deps);
  const result = (deps.runCommandSync ?? defaultPrivatePathCommandSync)(
    "icacls.exe",
    win32PrivatePathArgs(p, sid, kind),
  );
  if (result.exitCode !== 0) {
    throw commandFailure(`harden private ${kind} ${p}`, "icacls.exe", result);
  }
}

/**
 * Restricts a directory to the current user. POSIX: `chmod 0o700`. win32:
 * removes inherited ACEs and grants the current user inheritable full control.
 */
export async function hardenPrivateDir(p: string, deps: PrivatePathDeps = {}): Promise<void> {
  const ctx = resolveDeps(deps);
  if (ctx.platform === "win32") {
    await hardenPrivatePathWin32(p, "directory", deps);
    return;
  }
  await ctx.fsImpl.chmod(p, 0o700);
}

/**
 * Restricts a file to the current user. POSIX: `chmod 0o600`. win32: removes
 * inherited ACEs and grants the current user full control.
 */
export async function hardenPrivateFile(p: string, deps: PrivatePathDeps = {}): Promise<void> {
  const ctx = resolveDeps(deps);
  if (ctx.platform === "win32") {
    await hardenPrivatePathWin32(p, "file", deps);
    return;
  }
  await ctx.fsImpl.chmod(p, 0o600);
}

/** Synchronous counterpart for sync-only persistence boundaries such as bun:sqlite. */
export function hardenPrivateDirSync(p: string, deps: PrivatePathSyncDeps = {}): void {
  const platform = deps.platform ?? hostPlatform();
  if (platform === "win32") {
    hardenPrivatePathWin32Sync(p, "directory", deps);
    return;
  }
  (deps.chmodSync ?? fsSync.chmodSync)(p, 0o700);
}

/** Synchronous counterpart for sync-only persistence boundaries such as bun:sqlite. */
export function hardenPrivateFileSync(p: string, deps: PrivatePathSyncDeps = {}): void {
  const platform = deps.platform ?? hostPlatform();
  if (platform === "win32") {
    hardenPrivatePathWin32Sync(p, "file", deps);
    return;
  }
  (deps.chmodSync ?? fsSync.chmodSync)(p, 0o600);
}
