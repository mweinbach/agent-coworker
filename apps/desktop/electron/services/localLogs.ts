import fs from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import {
  type DiagnosticsRedactionContext,
  redactDiagnosticText,
  sanitizeLogMeta,
} from "../../../../src/diagnostics/redaction";
import { writeFileAtomic } from "../../../../src/platform/fs";

export type LocalLogFileName = "desktop-main.log" | "server.log" | "renderer.log" | "updater.log";

export type LocalLogLevel = "info" | "warn" | "error";

const LOG_FILE_NAMES = new Set<LocalLogFileName>([
  "desktop-main.log",
  "server.log",
  "renderer.log",
  "updater.log",
]);

const pendingWrites = new Map<LocalLogFileName, Promise<void>>();
const logFileSizes = new Map<LocalLogFileName, { path: string; bytes: number }>();
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_RECORD_BYTES = 16 * 1024;
const RETAINED_LOG_BYTES = 1024 * 1024;

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
  const redactionContext = {
    ...context,
    maxStringLength: Math.min(context?.maxStringLength ?? 1024, 1024),
  };
  const entry = {
    ts: new Date().toISOString(),
    level,
    category: redactDiagnosticText(category, redactionContext),
    message: redactDiagnosticText(message, redactionContext),
    ...(meta !== undefined ? { meta: sanitizeLogMeta(meta, redactionContext) } : {}),
  };
  const serialized = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(serialized) <= MAX_LOG_RECORD_BYTES) return serialized;
  return `${JSON.stringify({ ...entry, meta: { truncated: true } })}\n`;
}

async function appendLocalLog(fileName: LocalLogFileName, entry: string): Promise<void> {
  const logPath = getLocalLogPath(fileName);
  let file = logFileSizes.get(fileName);
  if (!file || file.path !== logPath) {
    await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const bytes = await fs.stat(logPath).then(
      (stat) => stat.size,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return 0;
        throw error;
      },
    );
    file = { path: logPath, bytes };
    logFileSizes.set(fileName, file);
  }

  const entryBytes = Buffer.byteLength(entry);
  if (file.bytes + entryBytes > MAX_LOG_FILE_BYTES) {
    const tail = await readLogTail(logPath, RETAINED_LOG_BYTES);
    // Discard partial records at either edge of the bounded tail.
    const firstNewline = tail.indexOf("\n");
    const lastNewline = tail.lastIndexOf("\n");
    const retained = firstNewline < 0 ? "" : tail.slice(firstNewline + 1, lastNewline + 1);
    await writeFileAtomic(logPath, retained, { mode: 0o600 });
    file.bytes = Buffer.byteLength(retained);
  }

  await fs.appendFile(logPath, entry, { encoding: "utf8", mode: 0o600 });
  file.bytes += entryBytes;
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
  let entry: string;
  try {
    entry = makeLogEntry(level, category, message, meta, context);
  } catch {
    // Diagnostics must not turn a metadata getter/serialization failure into an app error.
    return;
  }
  const pending = pendingWrites.get(safeFileName) ?? Promise.resolve();
  const next = pending
    .catch(() => {
      // Preserve future writes if an earlier append failed.
    })
    .then(async () => {
      try {
        await appendLocalLog(safeFileName, entry);
      } catch {
        // A partial write or deleted folder invalidates the cached size; retry fresh next time.
        logFileSizes.delete(safeFileName);
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
  const cappedMaxBytes = Math.floor(Math.max(0, Math.min(maxBytes, RETAINED_LOG_BYTES)));
  if (!Number.isFinite(cappedMaxBytes) || cappedMaxBytes === 0) return "";

  try {
    return await readLogTail(file, cappedMaxBytes);
  } catch {
    return "";
  }
}

async function readLogTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return "";
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let totalBytesRead = 0;
    while (totalBytesRead < length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        length - totalBytesRead,
        start + totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    return buffer.toString("utf8", 0, totalBytesRead);
  } finally {
    await handle.close();
  }
}
