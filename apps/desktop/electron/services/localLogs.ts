import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import {
  type DiagnosticsRedactionContext,
  redactDiagnosticText,
  sanitizeLogMeta,
} from "../../../../src/diagnostics/redaction";

export type LocalLogFileName = "desktop-main.log" | "server.log" | "renderer.log" | "updater.log";

export type LocalLogLevel = "info" | "warn" | "error";

const LOG_FILE_NAMES = new Set<LocalLogFileName>([
  "desktop-main.log",
  "server.log",
  "renderer.log",
  "updater.log",
]);

const pendingWrites = new Map<LocalLogFileName, Promise<void>>();

function ensureLogFileName(fileName: LocalLogFileName): LocalLogFileName {
  if (!LOG_FILE_NAMES.has(fileName)) {
    throw new Error(`Unsupported log file: ${fileName}`);
  }
  return fileName;
}

export function getLogsDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

export function getLocalLogPath(fileName: LocalLogFileName): string {
  return path.join(getLogsDir(), ensureLogFileName(fileName));
}

function errorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}

function makeLogEntry(
  level: LocalLogLevel,
  category: string,
  message: string,
  meta?: unknown,
  context?: DiagnosticsRedactionContext,
): string {
  const entry = {
    ts: new Date().toISOString(),
    level,
    category: redactDiagnosticText(category, context),
    message: redactDiagnosticText(message, context),
    ...(meta !== undefined ? { meta: sanitizeLogMeta(meta, context) } : {}),
  };
  return `${JSON.stringify(entry)}\n`;
}

export function writeLocalLog(
  fileName: LocalLogFileName,
  level: LocalLogLevel,
  category: string,
  message: string,
  meta?: unknown,
  context?: DiagnosticsRedactionContext,
): void {
  const safeFileName = ensureLogFileName(fileName);
  const entry = makeLogEntry(level, category, message, meta, context);
  const pending = pendingWrites.get(safeFileName) ?? Promise.resolve();
  const next = pending
    .catch(() => {
      // Preserve future writes if an earlier append failed.
    })
    .then(async () => {
      try {
        const logPath = getLocalLogPath(safeFileName);
        await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
        await fs.appendFile(logPath, entry, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Local logs are best-effort diagnostics only.
      }
    });
  pendingWrites.set(safeFileName, next);
}

export function logInfo(category: string, message: string, meta?: unknown): void {
  writeLocalLog("desktop-main.log", "info", category, message, meta);
}

export function logWarn(category: string, message: string, meta?: unknown): void {
  writeLocalLog("desktop-main.log", "warn", category, message, meta);
}

export function logError(category: string, error: unknown, meta?: unknown): void {
  writeLocalLog("desktop-main.log", "error", category, "error", {
    ...errorMeta(error),
    ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : { meta }),
  });
}

export async function flushLocalLogWrites(fileName?: LocalLogFileName): Promise<void> {
  const pending = fileName ? [pendingWrites.get(fileName)] : [...pendingWrites.values()];
  for (const write of pending) {
    if (!write) continue;
    try {
      await write;
    } catch {
      // Local logs are best-effort diagnostics only.
    }
  }
}

export async function tailLog(file: string, maxBytes: number): Promise<string> {
  const cappedMaxBytes = Math.max(0, Math.min(maxBytes, 1024 * 1024));
  if (cappedMaxBytes === 0) return "";

  let handle: FileHandle | null = null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return "";
    const start = Math.max(0, stat.size - cappedMaxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    handle = await fs.open(file, "r");
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

export { sanitizeLogMeta };
