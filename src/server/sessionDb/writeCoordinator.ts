import fs from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDirectory, hardenPrivateFile } from "./fileHardening";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 1_000;

type LockOwnerMetadata = {
  pid: number;
  startedAt: string;
  updatedAt: string;
};

type SessionDbWriteCoordinatorOptions = {
  rootDir: string;
  lockName?: string;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
  emitTelemetry?: (
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number,
  ) => void;
};

type LockHandle = {
  owner: LockOwnerMetadata;
  waitedMs: number;
  staleRecoveries: number;
  release: () => Promise<void>;
};

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ESRCH") return false;
    return true;
  }
}

async function readOwnerMetadata(ownerPath: string): Promise<LockOwnerMetadata | null> {
  try {
    const raw = await fs.readFile(ownerPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockOwnerMetadata>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export class SessionDbWriteCoordinator {
  private readonly lockRootDir: string;
  private readonly lockDir: string;
  private readonly ownerFilePath: string;
  private readonly acquireTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly staleLockMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly processAlive: (pid: number) => boolean;
  private readonly emitTelemetry?: SessionDbWriteCoordinatorOptions["emitTelemetry"];

  constructor(opts: SessionDbWriteCoordinatorOptions) {
    this.lockRootDir = path.join(opts.rootDir, "locks");
    this.lockDir = path.join(this.lockRootDir, opts.lockName ?? "session-db-write.lock");
    this.ownerFilePath = path.join(this.lockDir, "owner.json");
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    this.processAlive = opts.processAlive ?? defaultProcessAlive;
    this.emitTelemetry = opts.emitTelemetry;
  }

  async runExclusive<T>(
    operation: string,
    callback: () => Promise<T> | T,
    attributes?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const startedAt = this.now();
    let handle: LockHandle | null = null;
    try {
      handle = await this.acquire(operation, attributes);
      const result = await callback();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("database is locked")) {
        this.emitTelemetry?.(
          "session.db.sqlite_lock",
          "error",
          {
            operation,
            ...(attributes ?? {}),
            error: message,
          },
          this.now() - startedAt,
        );
      }
      throw error;
    } finally {
      if (handle) {
        await handle.release();
      }
    }
  }

  private async acquire(
    operation: string,
    attributes?: Record<string, string | number | boolean>,
  ): Promise<LockHandle> {
    await ensurePrivateDirectory(this.lockRootDir);

    const acquireStartedAt = this.now();
    let staleRecoveries = 0;

    while (true) {
      const owner = this.makeOwnerMetadata();
      try {
        await fs.mkdir(this.lockDir, { mode: 0o700 });
        await fs.writeFile(this.ownerFilePath, `${JSON.stringify(owner, null, 2)}\n`, {
          encoding: "utf-8",
          mode: 0o600,
        });
        await hardenPrivateFile(this.ownerFilePath);

        const waitedMs = this.now() - acquireStartedAt;
        if (waitedMs > 0 || staleRecoveries > 0) {
          this.emitTelemetry?.(
            "session.db.write_lock_wait",
            "ok",
            {
              operation,
              waitedMs,
              staleRecoveries,
              ...(attributes ?? {}),
            },
            waitedMs,
          );
        }

        const heartbeat = this.startHeartbeat(owner);
        return {
          owner,
          waitedMs,
          staleRecoveries,
          release: async () => {
            heartbeat.stop();
            const liveOwner = await readOwnerMetadata(this.ownerFilePath);
            if (!liveOwner || liveOwner.pid === owner.pid) {
              await fs.rm(this.lockDir, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code !== "EEXIST") {
          this.emitTelemetry?.(
            "session.db.write_lock_wait",
            "error",
            {
              operation,
              error: error instanceof Error ? error.message : String(error),
              ...(attributes ?? {}),
            },
            this.now() - acquireStartedAt,
          );
          throw error;
        }

        if (await this.cleanupStaleLock()) {
          staleRecoveries += 1;
          continue;
        }

        const waitedMs = this.now() - acquireStartedAt;
        if (waitedMs >= this.acquireTimeoutMs) {
          const timeoutError = new Error(
            `Timed out acquiring session DB write lock after ${waitedMs}ms for ${operation}`,
          );
          this.emitTelemetry?.(
            "session.db.write_lock_wait",
            "error",
            {
              operation,
              waitedMs,
              staleRecoveries,
              error: timeoutError.message,
              ...(attributes ?? {}),
            },
            waitedMs,
          );
          throw timeoutError;
        }

        await this.sleep(this.retryDelayMs);
      }
    }
  }

  private startHeartbeat(owner: LockOwnerMetadata): { stop: () => void } {
    const interval = setInterval(() => {
      const next: LockOwnerMetadata = {
        ...owner,
        updatedAt: new Date(this.now()).toISOString(),
      };
      void fs
        .writeFile(this.ownerFilePath, `${JSON.stringify(next, null, 2)}\n`, {
          encoding: "utf-8",
          mode: 0o600,
        })
        .then(() => hardenPrivateFile(this.ownerFilePath))
        .catch(() => {
          // best effort only; stale lock recovery handles cleanup if needed.
        });
    }, this.heartbeatMs);
    interval.unref?.();
    return {
      stop: () => {
        clearInterval(interval);
      },
    };
  }

  private async cleanupStaleLock(): Promise<boolean> {
    const owner = await readOwnerMetadata(this.ownerFilePath);
    const staleCutoff = this.now() - this.staleLockMs;
    if (owner) {
      const updatedAtMs = Date.parse(owner.updatedAt);
      const isStaleByTime = !Number.isFinite(updatedAtMs) || updatedAtMs <= staleCutoff;
      const isStaleByPid = !this.processAlive(owner.pid);
      if (!isStaleByTime && !isStaleByPid) {
        return false;
      }
      await fs.rm(this.lockDir, { recursive: true, force: true });
      return true;
    }

    try {
      const stat = await fs.stat(this.lockDir);
      if (stat.mtimeMs <= staleCutoff) {
        await fs.rm(this.lockDir, { recursive: true, force: true });
        return true;
      }
    } catch {
      return true;
    }

    return false;
  }

  private makeOwnerMetadata(): LockOwnerMetadata {
    const at = new Date(this.now()).toISOString();
    return {
      pid: process.pid,
      startedAt: at,
      updatedAt: at,
    };
  }
}
