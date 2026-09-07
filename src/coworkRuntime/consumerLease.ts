import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalizeSync } from "../platform/paths";
import { type RuntimeBootstrapLock, withCoworkRuntimeBootstrapLock } from "./bootstrapLock";

const APPLICATION_ID = 0x4357524c; // CWRL
type ConsumerLease = { database: DatabaseSync; file: string; identity: Stats };
const consumers = new Map<string, ConsumerLease>();

function sameEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** External explicit runtimes are not owned (or pruned) by the installer. */
export function runtimeConsumerHome(runtimeDir: string): string | null {
  for (const resolved of [canonicalizeSync(runtimeDir), path.resolve(runtimeDir)]) {
    const root = path.dirname(resolved);
    const cowork = path.dirname(root);
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(path.basename(resolved)) &&
      path.basename(root) === "runtime" &&
      path.basename(cowork) === ".cowork"
    )
      return path.dirname(cowork);
  }
  return null;
}

async function assertDatabaseIdentity(file: string, identity: Stats): Promise<void> {
  const current = await fs.lstat(file);
  if (!current.isFile() || current.nlink !== 1 || !sameEntry(current, identity)) {
    throw new Error(`Cowork runtime consumer lease ownership changed: ${file}`);
  }
}

async function openLeaseDatabase(runtimeDir: string): Promise<ConsumerLease> {
  // Readers and mutators must derive the database from the same canonical
  // runtime, never from the caller's home. Two homes can alias only their
  // runtime roots while their .cowork/locks directories remain unrelated.
  const resolved = canonicalizeSync(runtimeDir);
  const runtimeRoot = path.dirname(resolved);
  const coworkRoot = path.dirname(runtimeRoot);
  const root =
    path.basename(runtimeRoot) === "runtime" && path.basename(coworkRoot) === ".cowork"
      ? path.join(coworkRoot, "locks", "runtime-consumers")
      : path.join(runtimeRoot, ".consumer-leases");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(root)).isDirectory()) {
    throw new Error(`Invalid Cowork runtime consumer lease directory: ${root}`);
  }
  const file = path.join(root, `${path.basename(resolved)}.sqlite`);
  // Never open/close an existing database through fs: on POSIX, closing an
  // unrelated descriptor can release this process's SQLite advisory locks.
  try {
    await (await fs.open(file, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = await fs.lstat(file);
  if (!identity.isFile() || identity.nlink !== 1) {
    throw new Error(`Invalid Cowork runtime consumer lease database: ${file}`);
  }
  const database = new DatabaseSync(file);
  try {
    // Use exec throughout this module: node:sqlite's StatementSync has no
    // explicit finalize API, and Bun's close() defers closing the native file
    // until outstanding prepared statements are garbage-collected. exec
    // finalizes its statements synchronously, including on query errors.
    database.exec("PRAGMA busy_timeout = 0; PRAGMA application_id");
    // The first SQLite read may recover a hot journal and truncate an
    // interrupted first initialization back to its original empty file.
    if ((await fs.lstat(file)).size === 0) {
      // Initialization is serialized by the runtime lifecycle lock. SQLite
      // recovers an interrupted initialization; no stale files are deleted.
      database.exec(`
        BEGIN IMMEDIATE;
        PRAGMA application_id = ${APPLICATION_ID};
        CREATE TABLE lease_anchor (id INTEGER PRIMARY KEY CHECK (id = 1));
        INSERT INTO lease_anchor VALUES (1);
        COMMIT;
      `);
    }
    try {
      // CHECK/NOT NULL constraints validate scalar results without creating
      // JS-owned StatementSync objects. The table is connection-local, never
      // persisted to the permanent lease database.
      database.exec(`
        CREATE TEMP TABLE lease_validation (
          application_id INTEGER NOT NULL CHECK (application_id = ${APPLICATION_ID}),
          journal_mode TEXT NOT NULL CHECK (journal_mode = 'delete'),
          anchor INTEGER NOT NULL CHECK (anchor = 1)
        );
        INSERT INTO lease_validation VALUES (
          (SELECT application_id FROM pragma_application_id),
          (SELECT journal_mode FROM pragma_journal_mode),
          (SELECT id FROM lease_anchor WHERE id = 1)
        );
        DROP TABLE lease_validation;
      `);
    } catch (error) {
      throw new Error(`Unrecognized or invalid Cowork runtime consumer lease database: ${file}`, {
        cause: error,
      });
    }
    await assertDatabaseIdentity(file, identity);
    return { database, file, identity };
  } catch (error) {
    database.close();
    throw error;
  }
}

function isContention(error: unknown): boolean {
  const candidate = error as { code?: string; errcode?: number };
  return (
    candidate.code?.startsWith("SQLITE_BUSY") === true ||
    candidate.code?.startsWith("SQLITE_LOCKED") === true ||
    (candidate.code === "ERR_SQLITE_ERROR" &&
      typeof candidate.errcode === "number" &&
      [5, 6].includes(candidate.errcode & 0xff))
  );
}

function closeConsumers(): void {
  for (const lease of consumers.values()) lease.database.close();
  consumers.clear();
}

/**
 * Pin an environment's managed runtime until this process exits. Environments
 * are copied/cached by servers and tools, so releasing at the end of a turn (or
 * on GC) would prematurely invalidate other consumers. One shared read
 * transaction per version/process suffices; no timers, PIDs or owner markers.
 */
export async function retainRuntimeForProcess(
  runtimeDir: string,
  lock: RuntimeBootstrapLock,
): Promise<void> {
  const home = runtimeConsumerHome(runtimeDir);
  if (!home) return;
  const resolved = canonicalizeSync(runtimeDir);
  await withCoworkRuntimeBootstrapLock({ home, version: "consumer", lock }, async () => {
    const existing = consumers.get(resolved);
    if (existing) {
      await assertDatabaseIdentity(existing.file, existing.identity);
      return;
    }
    const lease = await openLeaseDatabase(resolved);
    try {
      lease.database.exec("BEGIN; SELECT id FROM lease_anchor WHERE id = 1");
      await assertDatabaseIdentity(lease.file, lease.identity);
      if (consumers.size === 0) process.once("exit", closeConsumers);
      consumers.set(resolved, lease);
    } catch (error) {
      lease.database.close();
      throw error;
    }
  });
}

/**
 * Nonblocking exclusive transaction proves no process is using this version.
 * Keep it throughout mutation, not just the liveness check. Database identities
 * are permanent, including after pruning/reinstallation; never unlink them.
 */
export async function withUnusedRuntime<T>(
  opts: { home: string; runtimeDir: string; lock: RuntimeBootstrapLock },
  mutate: () => Promise<T>,
): Promise<{ used: true } | { used: false; result: T }> {
  return await withCoworkRuntimeBootstrapLock(
    { home: opts.home, version: "consumer-retention", lock: opts.lock },
    async () => {
      const resolved = canonicalizeSync(opts.runtimeDir);
      if (consumers.has(resolved)) return { used: true };
      const lease = await openLeaseDatabase(resolved);
      try {
        try {
          lease.database.exec("BEGIN EXCLUSIVE");
        } catch (error) {
          if (isContention(error)) return { used: true };
          throw error;
        }
        await assertDatabaseIdentity(lease.file, lease.identity);
        return { used: false, result: await mutate() };
      } finally {
        lease.database.close();
      }
    },
  );
}

/** Test teardown only: production leases must outlive all copied environments. */
export const consumerLeaseTesting = {
  releaseAll(): void {
    closeConsumers();
    process.removeListener("exit", closeConsumers);
  },
};
