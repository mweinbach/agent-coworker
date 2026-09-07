import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { canonicalizeSync } from "../platform/paths";
import { fileLockRootForCoworkHome, withFileLock } from "../utils/fileLock";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const BARRIER_PROTOCOL = "cowork-runtime-sqlite-v1";
// HEAD's legacy parser accepts strings here. Without a heartbeat file, this
// deliberately non-date value makes its age-based reclaimer inapplicable.
// A live SQLite owner therefore remains protected even while suspended.
const SQLITE_OWNED_TIMESTAMP = "sqlite-transaction-owned";

type BarrierOwner = {
  protocol: typeof BARRIER_PROTOCOL;
  pid: number;
  token: string;
  startedAt: string;
  updatedAt: typeof SQLITE_OWNED_TIMESTAMP;
};
type Barrier = {
  directory: Stats;
  marker: Stats;
  token: string;
};

function sameEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function legacyLockError(lockPath: string): Error {
  return new Error(
    `Legacy or unrecognized Cowork runtime bootstrap lock exists at ${lockPath}. Stop older Cowork processes and remove the obsolete lock before retrying.`,
  );
}

function parseBarrierOwner(text: string, lockPath: string): BarrierOwner {
  let owner: Partial<BarrierOwner> | null;
  try {
    owner = JSON.parse(text);
  } catch {
    throw legacyLockError(lockPath);
  }
  if (
    !owner ||
    owner.protocol !== BARRIER_PROTOCOL ||
    !Number.isInteger(owner.pid) ||
    (owner.pid ?? 0) <= 0 ||
    typeof owner.token !== "string" ||
    !owner.token ||
    typeof owner.startedAt !== "string" ||
    owner.updatedAt !== SQLITE_OWNED_TIMESTAMP
  ) {
    throw legacyLockError(lockPath);
  }
  return owner as BarrierOwner;
}

async function assertBarrierEntries(lockPath: string, barrier: Barrier): Promise<void> {
  const directory = await fs.lstat(lockPath);
  const marker = await fs.lstat(path.join(lockPath, "owner.json"));
  const entries = await fs.readdir(lockPath);
  if (
    !directory.isDirectory() ||
    !marker.isFile() ||
    marker.nlink !== 1 ||
    !sameEntry(directory, barrier.directory) ||
    !sameEntry(marker, barrier.marker) ||
    entries.length !== 1 ||
    entries[0] !== "owner.json"
  ) {
    throw legacyLockError(lockPath);
  }
}

/** Called only while holding SQLite, including abandoned-barrier adoption. */
async function acquireLegacyBarrier(lockPath: string): Promise<Barrier> {
  let created = false;
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directory = await fs.lstat(lockPath);
  if (!directory.isDirectory()) throw legacyLockError(lockPath);
  const ownerPath = path.join(lockPath, "owner.json");
  // Do not follow a foreign marker symlink, or initialize an unknown empty
  // directory left by an older client (or an interrupted initial publication).
  const existing = created ? null : await fs.lstat(ownerPath).catch(() => null);
  if (!created && (!existing?.isFile() || existing.nlink !== 1)) {
    throw legacyLockError(lockPath);
  }
  const file = await fs.open(ownerPath, created ? "wx+" : "r+", 0o600);
  try {
    const marker = await file.stat();
    const barrier = { directory, marker, token: crypto.randomUUID() };
    await assertBarrierEntries(lockPath, barrier);
    if (!created) {
      if (!existing || !sameEntry(existing, marker)) throw legacyLockError(lockPath);
      parseBarrierOwner(await file.readFile("utf8"), lockPath);
    }
    const owner: BarrierOwner = {
      protocol: BARRIER_PROTOCOL,
      pid: process.pid,
      token: barrier.token,
      startedAt: new Date().toISOString(),
      updatedAt: SQLITE_OWNED_TIMESTAMP,
    };
    // SQLite proves a recognized previous owner has left its critical section.
    // Adopt its marker through a pinned descriptor, without deleting/renaming
    // the reusable barrier directory. Foreign paths are never reclaimed.
    const contents = Buffer.from(`${JSON.stringify(owner)}\n`);
    let written = 0;
    while (written < contents.length) {
      const result = await file.write(contents, written, contents.length - written, written);
      if (result.bytesWritten === 0) throw new Error("Could not publish runtime lock owner.");
      written += result.bytesWritten;
    }
    await file.truncate(contents.length);
    await assertBarrierEntries(lockPath, barrier);
    return barrier;
  } finally {
    await file.close();
  }
}

async function releaseLegacyBarrier(lockPath: string, barrier: Barrier): Promise<void> {
  await assertBarrierEntries(lockPath, barrier);
  let file: FileHandle | undefined;
  try {
    file = await fs.open(path.join(lockPath, "owner.json"), "r");
    if (!sameEntry(await file.stat(), barrier.marker)) throw legacyLockError(lockPath);
    const owner = parseBarrierOwner(await file.readFile("utf8"), lockPath);
    if (owner.token !== barrier.token || owner.pid !== process.pid) {
      throw legacyLockError(lockPath);
    }
  } finally {
    await file?.close();
  }
  await assertBarrierEntries(lockPath, barrier);
  // Never recursively remove a reusable lock path. Cooperating clients cannot
  // replace these entries while SQLite is held. Older binaries' own unchecked
  // reclaimers remain unsafe; this protocol cannot repair those binaries.
  await fs.unlink(path.join(lockPath, "owner.json"));
  await fs.rmdir(lockPath);
}

declare const runtimeLockBrand: unique symbol;
/** A capability valid only during its owning, awaited lifecycle callback. */
export type RuntimeBootstrapLock = { readonly [runtimeLockBrand]: true };
const activeLocks = new WeakMap<RuntimeBootstrapLock, string>();
const pendingLocks = new Map<string, number>();

type RuntimeBootstrapLockOptions = {
  home: string;
  version: string;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  onWait?: () => void;
  /** Explicitly propagate ownership to sequential nested lifecycle operations. */
  lock?: RuntimeBootstrapLock;
};

export async function withCoworkRuntimeBootstrapLock<T>(
  opts: RuntimeBootstrapLockOptions,
  callback: (lock: RuntimeBootstrapLock) => Promise<T>,
): Promise<T> {
  const coworkRoot = path.join(path.resolve(opts.home), ".cowork");
  const runtimeRoot = path.join(coworkRoot, "runtime");
  const lockPath = path.join(runtimeRoot, ".bootstrap.lock");
  const identity = canonicalizeSync(lockPath).toLowerCase();
  if (opts.lock) {
    if (activeLocks.get(opts.lock) !== identity) {
      throw new Error("Runtime lifecycle lock is expired or belongs to another home.");
    }
    return await callback(opts.lock);
  }

  let reportedWait = false;
  const reportWait = () => {
    if (reportedWait) return;
    reportedWait = true;
    opts.onWait?.();
  };
  const pending = pendingLocks.get(identity) ?? 0;
  if (pending > 0) reportWait();
  pendingLocks.set(identity, pending + 1);
  try {
    return await withFileLock(
      lockPath,
      async () => {
        await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
        const barrier = await acquireLegacyBarrier(lockPath);
        const lock = Object.freeze({}) as RuntimeBootstrapLock;
        activeLocks.set(lock, identity);
        try {
          return await callback(lock);
        } finally {
          activeLocks.delete(lock);
          await releaseLegacyBarrier(lockPath, barrier);
        }
      },
      {
        lockRoot: fileLockRootForCoworkHome(coworkRoot),
        acquireTimeoutMs: opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
        retryDelayMs: opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      },
      {
        sleep: async (ms) => {
          reportWait();
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      },
    );
  } finally {
    const remaining = (pendingLocks.get(identity) ?? 1) - 1;
    if (remaining === 0) pendingLocks.delete(identity);
    else pendingLocks.set(identity, remaining);
  }
}
