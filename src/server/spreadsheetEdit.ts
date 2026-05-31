import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchRequest,
  SpreadsheetBatchPatchResult,
} from "../shared/spreadsheetPreview";
import { runCsvOps } from "./spreadsheetEditCsv";
import type { EditFailure, OpsOutcome } from "./spreadsheetEditTypes";
import { runXlsxOps } from "./spreadsheetEditXlsx";
import {
  resolveWorkspaceFilePath,
  spreadsheetFileVersionFromStat,
  spreadsheetPathFailure,
} from "./spreadsheetPreview";

const MAX_BATCH_PATCH_OPERATIONS = 50_000;

/**
 * Apply an ordered batch of cell/format operations as a single atomic
 * read-modify-write. A mid-batch failure aborts before any bytes are persisted,
 * so partial batches never land on disk.
 */
export async function patchSpreadsheetBatch(
  req: SpreadsheetBatchPatchRequest,
): Promise<SpreadsheetBatchPatchResult> {
  if (req.operations.length > MAX_BATCH_PATCH_OPERATIONS) {
    return {
      ok: false,
      error: {
        kind: "parse_error",
        message: `Spreadsheet patch batches are limited to ${MAX_BATCH_PATCH_OPERATIONS} operations.`,
      },
    };
  }
  // A no-op batch must not touch disk (re-zipping or re-quoting would change the
  // file's bytes and fingerprint with no actual edit).
  if (req.operations.length === 0) return { ok: true };

  const target = await resolveEditTarget(req.cwd, req.filePath);
  if (!target.ok) return target;
  const outcome = await executeOps(
    target.resolvedPath,
    target.ext,
    req.operations,
    req.expectedFileVersion,
  );
  if (outcome.ok) return { ok: true };
  const message =
    outcome.index === null
      ? outcome.error.message
      : `Operation ${outcome.index + 1} failed: ${outcome.error.message}`;
  return { ok: false, error: { kind: outcome.error.kind, message } };
}

async function resolveEditTarget(
  cwd: string,
  filePath: string,
): Promise<{ ok: true; resolvedPath: string; ext: string } | { ok: false; error: EditFailure }> {
  try {
    const resolvedPath = await resolveWorkspaceFilePath(cwd, filePath);
    return { ok: true, resolvedPath, ext: path.extname(resolvedPath).toLowerCase() };
  } catch (error) {
    return { ok: false, error: spreadsheetPathFailure(error) };
  }
}

const fileWriteChains = new Map<string, Promise<void>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileWriteChains.get(filePath) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  fileWriteChains.set(filePath, settled);
  void settled.then(() => {
    if (fileWriteChains.get(filePath) === settled) fileWriteChains.delete(filePath);
  });
  return result;
}

function executeOps(
  resolvedPath: string,
  ext: string,
  operations: SpreadsheetBatchPatchOperation[],
  expectedFileVersion: SpreadsheetBatchPatchRequest["expectedFileVersion"],
): Promise<OpsOutcome> {
  return withFileLock(resolvedPath, async () => {
    try {
      if (expectedFileVersion) {
        const currentVersion = spreadsheetFileVersionFromStat(await fs.stat(resolvedPath));
        if (currentVersion.fingerprint !== expectedFileVersion.fingerprint) {
          return {
            ok: false,
            index: null,
            error: {
              kind: "write_error",
              message: "Spreadsheet file changed on disk; reload before saving.",
            },
          };
        }
      }
      if (ext === ".csv") return await runCsvOps(resolvedPath, operations, writeFileAtomic);
      if (ext === ".xlsx") return await runXlsxOps(resolvedPath, operations, writeFileAtomic);
      const firstType = operations[0]?.type;
      const message =
        firstType === "format"
          ? "Formatting supports XLSX files."
          : firstType === "merge"
            ? "Merging supports XLSX files."
            : "Editing supports CSV and XLSX files.";
      return { ok: false, index: null, error: { kind: "unsupported_format", message } };
    } catch (error) {
      return {
        ok: false,
        index: null,
        error: {
          kind: "write_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
