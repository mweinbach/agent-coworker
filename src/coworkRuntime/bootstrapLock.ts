import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_STALE_LOCK_MS = 300_000;
const DEFAULT_HEARTBEAT_MS = 1_000;

type RuntimeBootstrapLockOwner = {
  pid: number;
  token: string;
  startedAt: string;
  updatedAt: string;
};

type RuntimeBootstrapLockOptions = {
  home: string;
  version: string;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
  onWait?: (owner: RuntimeBootstrapLockOwner | null) => void;
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
    return code !== "ESRCH";
  }
}

async function readOwner(ownerPath: string): Promise<RuntimeBootstrapLockOwner | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(ownerPath, "utf8"),
    ) as Partial<RuntimeBootstrapLockOwner>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as RuntimeBootstrapLockOwner;
  } catch {
    return null;
  }
}

async function hardenDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
}

export async function withCoworkRuntimeBootstrapLock<T>(
  opts: RuntimeBootstrapLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const runtimeRoot = path.join(path.resolve(opts.home), ".cowork", "runtime");
  const lockDir = path.join(runtimeRoot, ".bootstrap.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const heartbeatPath = path.join(lockDir, "heartbeat");
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const processAlive = opts.processAlive ?? defaultProcessAlive;
  const token = randomUUID();
  const acquireStartedAt = now();
  let reportedWait = false;

  await hardenDirectory(runtimeRoot);

  while (true) {
    const timestamp = new Date(now()).toISOString();
    const owner: RuntimeBootstrapLockOwner = {
      pid: process.pid,
      token,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "EEXIST") throw error;

      const liveOwner = await readOwner(ownerPath);
      if (!reportedWait) {
        reportedWait = true;
        opts.onWait?.(liveOwner);
      }

      const heartbeatStat = await fs.stat(heartbeatPath).catch(() => null);
      const updatedAt =
        heartbeatStat?.mtimeMs ?? (liveOwner ? Date.parse(liveOwner.updatedAt) : Number.NaN);
      const staleByHeartbeat = Number.isFinite(updatedAt) && updatedAt <= now() - staleLockMs;
      const deadOwner = liveOwner ? !processAlive(liveOwner.pid) : false;
      let missingOwnerStale = false;
      if (!liveOwner) {
        const stat = await fs.stat(lockDir).catch(() => null);
        missingOwnerStale = stat === null || stat.mtimeMs <= now() - staleLockMs;
      }
      if (deadOwner || staleByHeartbeat || missingOwnerStale) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }

      const waitedMs = now() - acquireStartedAt;
      if (waitedMs >= acquireTimeoutMs) {
        throw new Error(
          `Timed out waiting ${waitedMs}ms for Cowork runtime ${opts.version} bootstrap`,
        );
      }
      await sleep(retryDelayMs);
      continue;
    }

    try {
      await fs.writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.writeFile(heartbeatPath, "", { mode: 0o600 });
    } catch (error) {
      await fs.rm(lockDir, { recursive: true, force: true });
      throw error;
    }

    const heartbeat = setInterval(() => {
      const next = new Date(now());
      void fs.utimes(heartbeatPath, next, next).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      return await callback();
    } finally {
      clearInterval(heartbeat);
      const liveOwner = await readOwner(ownerPath);
      if (liveOwner?.token === token) {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    }
  }
}
