import fs from "node:fs/promises";
import path from "node:path";

import { redactDiagnosticText } from "../diagnostics/redaction";
import type { SessionEvent } from "./protocol";

const DEFAULT_RETENTION_DAYS = 14;
const LOG_FILE_PATTERN = /^server-\d{4}-\d{2}-\d{2}\.log$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function shouldEnableServerFileLog(env: Record<string, string | undefined>): boolean {
  const value = env.COWORK_SERVER_FILE_LOGS?.trim().toLowerCase();
  // Default ON: production desktop builds have no terminal, so this file is
  // the only durable record of harness logs and turn errors.
  return !(value === "0" || value === "false");
}

/**
 * Durable, redacted record of session `log` and `error` events under
 * `~/.cowork/logs/server-YYYY-MM-DD.log` (JSONL). Writes are serialized and
 * best-effort: logging must never affect session delivery. Files older than
 * the retention window are swept once per process.
 */
export class ServerFileLog {
  private readonly logsDir: string;
  private readonly retentionDays: number;
  private pendingWrite: Promise<void> = Promise.resolve();
  private retentionSweepStarted = false;

  constructor(opts: { logsDir: string; retentionDays?: number }) {
    this.logsDir = opts.logsDir;
    this.retentionDays = Math.max(1, Math.floor(opts.retentionDays ?? DEFAULT_RETENTION_DAYS));
  }

  appendSessionEvent(event: SessionEvent): void {
    if (event.type === "log") {
      this.append({ sessionId: event.sessionId, kind: "log", line: event.line });
      return;
    }
    if (event.type === "error") {
      this.append({
        sessionId: event.sessionId,
        kind: "error",
        message: event.message,
        code: event.code,
        source: event.source,
      });
    }
  }

  async flush(): Promise<void> {
    try {
      await this.pendingWrite;
    } catch {
      // best-effort diagnostics only
    }
  }

  private append(entry: {
    sessionId: string;
    kind: "log" | "error";
    line?: string;
    message?: string;
    code?: string;
    source?: string;
  }): void {
    const now = new Date();
    const payload = {
      ts: now.toISOString(),
      sessionId: entry.sessionId,
      kind: entry.kind,
      ...(entry.line !== undefined ? { line: redactDiagnosticText(entry.line) } : {}),
      ...(entry.message !== undefined ? { message: redactDiagnosticText(entry.message) } : {}),
      ...(entry.code !== undefined ? { code: entry.code } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
    };
    const logPath = path.join(this.logsDir, `server-${now.toISOString().slice(0, 10)}.log`);
    const serialized = `${JSON.stringify(payload)}\n`;

    this.pendingWrite = this.pendingWrite
      .catch(() => {
        // Preserve future writes if an earlier append failed.
      })
      .then(async () => {
        try {
          await fs.mkdir(this.logsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
          await fs.appendFile(logPath, serialized, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
        } catch {
          // best-effort diagnostics only
        }
      });

    if (!this.retentionSweepStarted) {
      this.retentionSweepStarted = true;
      void this.sweepExpiredLogs().catch(() => {
        // best-effort diagnostics only
      });
    }
  }

  private async sweepExpiredLogs(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.logsDir);
    } catch {
      return;
    }
    const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!LOG_FILE_PATTERN.test(entry)) continue;
      const datePart = entry.slice("server-".length, -".log".length);
      const fileDayMs = Date.parse(`${datePart}T00:00:00.000Z`);
      if (!Number.isFinite(fileDayMs) || fileDayMs >= cutoffMs) continue;
      await fs.rm(path.join(this.logsDir, entry), { force: true });
    }
  }
}
