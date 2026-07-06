import fs from "node:fs/promises";

import { SessionBackupManager, getSessionBackupsRootDirs } from "../sessionBackup";
import type { SessionDb } from "../sessionDb";
import { sweepStaleSessionTmpFiles } from "../sessionStore";

const MODEL_STREAM_CHUNK_RETENTION_DAYS = 30;

export type StartupMaintenanceOptions = {
  sessionDb: SessionDb;
  sessionsDir: string;
  homedir?: string;
  log?: (line: string) => void;
};

export type StartupMaintenanceResult = {
  prunedModelStreamChunks: number;
  sweptSessionTmpFiles: number;
};

/**
 * Best-effort housekeeping for state that only ever accumulates when sessions
 * die without a clean shutdown: unbounded raw model stream chunks, leaked
 * snapshot temp files, and unprunable backup dirs. Failures are logged and
 * never block startup. Stale execution-state reconciliation is NOT here — it
 * must run synchronously at boot before any session can start a turn.
 */
export async function runStartupMaintenance(
  opts: StartupMaintenanceOptions,
): Promise<StartupMaintenanceResult> {
  const log = opts.log ?? (() => {});
  const result: StartupMaintenanceResult = {
    prunedModelStreamChunks: 0,
    sweptSessionTmpFiles: 0,
  };

  try {
    const cutoff = new Date(
      Date.now() - MODEL_STREAM_CHUNK_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    result.prunedModelStreamChunks =
      await opts.sessionDb.pruneModelStreamChunksForStaleSessions(cutoff);
    if (result.prunedModelStreamChunks > 0) {
      log(`[maintenance] pruned ${result.prunedModelStreamChunks} stale model stream chunk(s)`);
    }
  } catch (error) {
    log(`[maintenance] model stream chunk pruning failed: ${String(error)}`);
  }

  try {
    result.sweptSessionTmpFiles = await sweepStaleSessionTmpFiles({
      sessionsDir: opts.sessionsDir,
    });
    if (result.sweptSessionTmpFiles > 0) {
      log(`[maintenance] removed ${result.sweptSessionTmpFiles} leaked session temp file(s)`);
    }
  } catch (error) {
    log(`[maintenance] session temp file sweep failed: ${String(error)}`);
  }

  for (const backupsRootDir of getSessionBackupsRootDirs({ homedir: opts.homedir })) {
    try {
      const stat = await fs.stat(backupsRootDir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      await SessionBackupManager.pruneBackupsRoot(backupsRootDir);
    } catch (error) {
      log(`[maintenance] backup pruning failed for ${backupsRootDir}: ${String(error)}`);
    }
  }

  return result;
}
