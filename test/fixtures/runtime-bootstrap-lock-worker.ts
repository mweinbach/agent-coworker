import fs from "node:fs/promises";
import path from "node:path";

import { withCoworkRuntimeBootstrapLock } from "../../src/coworkRuntime/bootstrapLock";

const [home, workerId] = process.argv.slice(2);
if (!home || !workerId) throw new Error("Expected runtime lock worker home and id");

// Frozen compatibility probe of HEAD's mkdir acquisition/parser/reclaimer.
// Deliberately retains the old unsafe deletion logic, confined to test homes.
async function withLegacyLock(callback: () => Promise<void>): Promise<void> {
  const lockDir = path.join(home!, ".cowork", "runtime", ".bootstrap.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const heartbeatPath = path.join(lockDir, "heartbeat");
  const token = crypto.randomUUID();
  const started = Date.now();
  const readOwner = async () => {
    try {
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      return typeof owner.pid === "number" &&
        typeof owner.token === "string" &&
        typeof owner.startedAt === "string" &&
        typeof owner.updatedAt === "string"
        ? owner
        : null;
    } catch {
      return null;
    }
  };
  const processAlive = (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwner();
      const heartbeat = await fs.stat(heartbeatPath).catch(() => null);
      const updatedAt = heartbeat?.mtimeMs ?? (owner ? Date.parse(owner.updatedAt) : Number.NaN);
      const staleByHeartbeat = Number.isFinite(updatedAt) && updatedAt <= Date.now() - 1;
      const deadOwner = owner ? !processAlive(owner.pid) : false;
      const directory = owner ? null : await fs.stat(lockDir).catch(() => null);
      const missingOwnerStale = !owner && (!directory || directory.mtimeMs <= Date.now() - 1);
      if (deadOwner || staleByHeartbeat || missingOwnerStale) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= 100) throw new Error("Legacy lock timed out");
      await Bun.sleep(5);
    }
  }
  const timestamp = new Date().toISOString();
  await fs.writeFile(
    ownerPath,
    JSON.stringify({ pid: process.pid, token, startedAt: timestamp, updatedAt: timestamp }),
  );
  await fs.writeFile(heartbeatPath, "");
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(heartbeatPath, now, now).catch(() => {});
  }, 10);
  try {
    await callback();
  } finally {
    clearInterval(heartbeat);
    if ((await readOwner())?.token === token) {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }
}

const callback = async () => {
  if (workerId === "hold" || workerId === "legacy-hold") {
    process.stdout.write("locked\n");
    await new Promise<void>(() => {
      setInterval(() => {}, 1_000);
    });
    return;
  }
  const activePath = path.join(home, "active-worker");
  await fs.writeFile(activePath, workerId, { flag: "wx" });
  try {
    await Bun.sleep(50);
  } finally {
    await fs.rm(activePath, { force: true });
  }
};
if (workerId.startsWith("legacy-")) {
  await withLegacyLock(callback);
} else {
  await withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22", retryDelayMs: 5 }, callback);
}
