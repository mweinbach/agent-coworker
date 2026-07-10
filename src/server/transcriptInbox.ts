import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  TRANSCRIPT_EVENTS_MAX_BYTES,
  TRANSCRIPT_REQUEST_MAX_EVENTS,
} from "../shared/transcriptBatchProtocol";

export const TRANSCRIPT_BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
export { TRANSCRIPT_REQUEST_MAX_EVENTS };
export const TRANSCRIPT_REQUEST_MAX_BYTES = TRANSCRIPT_EVENTS_MAX_BYTES;
export const TRANSCRIPT_DEDUPE_MAX_BATCHES = 10_000;
export const TRANSCRIPT_DEDUPE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const SAFE_THREAD_ID = /^[A-Za-z0-9_-]{1,256}$/;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export type TranscriptInboxEvent = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
  generation?: number;
};

export type ProjectedTranscriptEvent = TranscriptInboxEvent & {
  deliveryId?: string;
};

type BatchRow = {
  digest: string;
};

type EventRow = {
  delivery_id: string;
  thread_id: string;
  generation: number;
  event_json: string;
};

type GenerationRow = {
  generation: number;
};

export class TranscriptInboxError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptInboxError";
    this.status = status;
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function chmodIfPresent(filePath: string, mode: number): void {
  try {
    fs.chmodSync(filePath, mode);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function sql(lines: readonly string[]): string {
  return lines.join("\n");
}

function ensureSchema(database: Database): void {
  database.exec(
    sql([
      "PRAGMA foreign_keys = ON;",
      "PRAGMA busy_timeout = 5000;",
      "PRAGMA journal_mode = WAL;",
      "CREATE TABLE IF NOT EXISTS transcript_batches (",
      "  batch_id TEXT PRIMARY KEY,",
      "  digest TEXT NOT NULL,",
      "  state TEXT NOT NULL CHECK(state IN ('pending', 'completed')),",
      "  event_count INTEGER NOT NULL,",
      "  byte_count INTEGER NOT NULL,",
      "  created_at_ms INTEGER NOT NULL,",
      "  completed_at_ms INTEGER",
      ");",
      "CREATE TABLE IF NOT EXISTS transcript_events (",
      "  delivery_id TEXT PRIMARY KEY,",
      "  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id) ON DELETE CASCADE,",
      "  event_index INTEGER NOT NULL,",
      "  thread_id TEXT NOT NULL,",
      "  generation INTEGER NOT NULL,",
      "  event_json TEXT NOT NULL,",
      "  projected INTEGER NOT NULL DEFAULT 0 CHECK(projected IN (0, 1)),",
      "  canceled INTEGER NOT NULL DEFAULT 0 CHECK(canceled IN (0, 1)),",
      "  UNIQUE(batch_id, event_index)",
      ");",
      "CREATE TABLE IF NOT EXISTS transcript_generations (",
      "  thread_id TEXT PRIMARY KEY,",
      "  generation INTEGER NOT NULL,",
      "  tombstoned_at_ms INTEGER NOT NULL",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_transcript_batches_state_created",
      "  ON transcript_batches(state, created_at_ms);",
      "CREATE INDEX IF NOT EXISTS idx_transcript_events_projection",
      "  ON transcript_events(projected, canceled, thread_id, batch_id, event_index);",
      "CREATE INDEX IF NOT EXISTS idx_transcript_events_batch",
      "  ON transcript_events(batch_id, event_index);",
    ]),
  );
}

function parseProjectionMap(filePath: string): Map<string, string> {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  const result = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { deliveryId?: unknown };
      if (typeof parsed.deliveryId === "string") {
        result.set(parsed.deliveryId, JSON.stringify(parsed));
      }
    } catch {
      // Transcript projections remain salvageable when a line is malformed.
    }
  }
  return result;
}

export class TranscriptInbox {
  private readonly databasePath: string;
  private readonly transcriptsDir: string;
  private readonly now: () => number;
  private readonly maxBatches: number;
  private readonly retentionMs: number;

  constructor(options: {
    userDataDir: string;
    now?: () => number;
    maxBatches?: number;
    retentionMs?: number;
  }) {
    this.databasePath = path.join(options.userDataDir, "transcript-inbox.sqlite");
    this.transcriptsDir = path.join(options.userDataDir, "transcripts");
    this.now = options.now ?? (() => Date.now());
    this.maxBatches = Math.max(1, options.maxBatches ?? TRANSCRIPT_DEDUPE_MAX_BATCHES);
    this.retentionMs = Math.max(0, options.retentionMs ?? TRANSCRIPT_DEDUPE_RETENTION_MS);
    fs.mkdirSync(options.userDataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    fs.chmodSync(options.userDataDir, PRIVATE_DIR_MODE);
    const databaseHandle = fs.openSync(this.databasePath, "a", PRIVATE_FILE_MODE);
    fs.closeSync(databaseHandle);
    fs.chmodSync(this.databasePath, PRIVATE_FILE_MODE);
    this.withDatabase(() => {});
  }

  appendBatch(events: TranscriptInboxEvent[], batchId: string): void {
    if (!TRANSCRIPT_BATCH_ID_PATTERN.test(batchId)) {
      throw new TranscriptInboxError("batchId contains invalid characters", 400);
    }
    if (events.length === 0 || events.length > TRANSCRIPT_REQUEST_MAX_EVENTS) {
      throw new TranscriptInboxError(
        `Transcript batches must contain 1-${TRANSCRIPT_REQUEST_MAX_EVENTS} events`,
        413,
      );
    }
    for (const event of events) {
      if (!SAFE_THREAD_ID.test(event.threadId)) {
        throw new TranscriptInboxError("threadId contains invalid characters", 400);
      }
    }
    const serializedEvents = JSON.stringify(events);
    const byteCount = Buffer.byteLength(serializedEvents);
    if (byteCount > TRANSCRIPT_REQUEST_MAX_BYTES) {
      throw new TranscriptInboxError("Transcript batch exceeds the request byte limit", 413);
    }
    const digest = createHash("sha256").update(serializedEvents).digest("hex");
    const timestamp = this.now();

    try {
      this.withImmediateTransaction((database) => {
        const existing = database
          .query("SELECT digest FROM transcript_batches WHERE batch_id = ?")
          .get(batchId) as BatchRow | null;
        if (existing) {
          if (existing.digest !== digest) {
            throw new TranscriptInboxError(
              "Idempotency key was reused with different transcript data",
              409,
            );
          }
          return;
        }
        this.prune(database, timestamp, 1);
        const count = database.query("SELECT COUNT(*) AS count FROM transcript_batches").get() as {
          count: number;
        };
        if (Number(count.count) >= this.maxBatches) {
          throw new TranscriptInboxError("Transcript inbox capacity reached", 503);
        }
        database
          .query(
            "INSERT INTO transcript_batches(batch_id, digest, state, event_count, byte_count, created_at_ms) VALUES(?, ?, 'pending', ?, ?, ?)",
          )
          .run(batchId, digest, events.length, byteCount, timestamp);
        const insertEvent = database.query(
          "INSERT INTO transcript_events(delivery_id, batch_id, event_index, thread_id, generation, event_json, canceled) VALUES(?, ?, ?, ?, ?, ?, ?)",
        );
        for (const [index, event] of events.entries()) {
          const currentGeneration = this.readGenerationInDatabase(database, event.threadId);
          const generation = event.generation ?? currentGeneration;
          const deliveryId = `${batchId}:${index}`;
          const projectedEvent: ProjectedTranscriptEvent = {
            ts: event.ts,
            threadId: event.threadId,
            direction: event.direction,
            payload: event.payload,
            deliveryId,
          };
          insertEvent.run(
            deliveryId,
            batchId,
            index,
            event.threadId,
            generation,
            JSON.stringify(projectedEvent),
            generation === currentGeneration ? 0 : 1,
          );
        }
      });
    } catch (error) {
      this.rethrowOperational(error, "Unable to commit transcript batch");
    }
    this.projectBatch(batchId);
  }

  projectPending(threadId?: string): void {
    let batchIds: string[];
    try {
      batchIds = this.withDatabase((database) => {
        const rows = threadId
          ? (database
              .query(
                "SELECT DISTINCT batch_id FROM transcript_events WHERE projected = 0 AND canceled = 0 AND thread_id = ? ORDER BY batch_id",
              )
              .all(threadId) as Array<{ batch_id: string }>)
          : (database
              .query(
                "SELECT batch_id FROM transcript_batches WHERE state = 'pending' ORDER BY created_at_ms, batch_id",
              )
              .all() as Array<{ batch_id: string }>);
        return rows.map((row) => row.batch_id);
      });
    } catch (error) {
      this.rethrowOperational(error, "Unable to read pending transcript batches");
    }
    for (const batchId of batchIds) {
      this.projectBatch(batchId);
    }
  }

  deleteThread(threadId: string, targetGeneration?: number): number {
    if (!SAFE_THREAD_ID.test(threadId)) {
      throw new TranscriptInboxError("threadId contains invalid characters", 400);
    }
    if (targetGeneration !== undefined && targetGeneration < 1) {
      throw new TranscriptInboxError("generation must be a positive integer", 400);
    }
    try {
      return this.withImmediateTransaction((database) => {
        const current = this.readGenerationInDatabase(database, threadId);
        const generation =
          targetGeneration === undefined ? current + 1 : Math.max(current, targetGeneration);
        if (!Number.isSafeInteger(generation) || generation < 0) {
          throw new TranscriptInboxError("generation must be a non-negative integer", 400);
        }
        database
          .query(
            "INSERT INTO transcript_generations(thread_id, generation, tombstoned_at_ms) VALUES(?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET generation = excluded.generation, tombstoned_at_ms = excluded.tombstoned_at_ms",
          )
          .run(threadId, generation, this.now());
        database
          .query(
            "UPDATE transcript_events SET canceled = 1 WHERE thread_id = ? AND generation < ? AND projected = 0",
          )
          .run(threadId, generation);
        try {
          fs.rmSync(this.transcriptFilePath(threadId), { force: true });
        } catch (error) {
          throw new TranscriptInboxError("Unable to delete transcript projection", 500, {
            cause: error,
          });
        }
        this.completeSettledBatches(database, this.now());
        return generation;
      });
    } catch (error) {
      this.rethrowOperational(error, "Unable to tombstone transcript");
    }
  }

  readGeneration(threadId: string): number {
    return this.withDatabase((database) => this.readGenerationInDatabase(database, threadId));
  }

  close(): void {
    // Connections are intentionally operation-scoped for process-safe ownership.
  }

  private projectBatch(batchId: string): void {
    try {
      this.withImmediateTransaction((database) => {
        const rows = database
          .query(
            "SELECT delivery_id, thread_id, generation, event_json FROM transcript_events WHERE batch_id = ? AND projected = 0 AND canceled = 0 ORDER BY event_index",
          )
          .all(batchId) as EventRow[];
        const projectionMaps = new Map<string, Map<string, string>>();
        const appendByThread = new Map<string, string[]>();
        for (const row of rows) {
          if (this.readGenerationInDatabase(database, row.thread_id) !== row.generation) {
            database
              .query("UPDATE transcript_events SET canceled = 1 WHERE delivery_id = ?")
              .run(row.delivery_id);
            continue;
          }
          const filePath = this.transcriptFilePath(row.thread_id);
          let projection = projectionMaps.get(row.thread_id);
          if (!projection) {
            projection = parseProjectionMap(filePath);
            projectionMaps.set(row.thread_id, projection);
          }
          const existing = projection.get(row.delivery_id);
          if (existing && existing !== row.event_json) {
            throw new TranscriptInboxError(
              "Idempotency key conflicts with the existing transcript projection",
              409,
            );
          }
          if (!existing) {
            const pending = appendByThread.get(row.thread_id) ?? [];
            pending.push(row.event_json);
            appendByThread.set(row.thread_id, pending);
            projection.set(row.delivery_id, row.event_json);
          }
        }
        fs.mkdirSync(this.transcriptsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
        for (const [threadId, lines] of appendByThread) {
          const filePath = this.transcriptFilePath(threadId);
          fs.appendFileSync(filePath, `${lines.join("\n")}\n`, {
            encoding: "utf8",
            mode: PRIVATE_FILE_MODE,
          });
          fs.chmodSync(filePath, PRIVATE_FILE_MODE);
        }
        database
          .query(
            "UPDATE transcript_events SET projected = 1 WHERE batch_id = ? AND projected = 0 AND canceled = 0",
          )
          .run(batchId);
        this.completeSettledBatches(database, this.now());
        this.prune(database, this.now(), 0);
      });
    } catch (error) {
      this.rethrowOperational(error, "Unable to project transcript batch");
    }
  }

  private completeSettledBatches(database: Database, timestamp: number): void {
    database
      .query(
        "UPDATE transcript_batches SET state = 'completed', completed_at_ms = ? WHERE state = 'pending' AND NOT EXISTS (SELECT 1 FROM transcript_events WHERE transcript_events.batch_id = transcript_batches.batch_id AND projected = 0 AND canceled = 0)",
      )
      .run(timestamp);
  }

  private prune(database: Database, timestamp: number, reserve: number): void {
    database
      .query(
        "DELETE FROM transcript_batches WHERE state = 'completed' AND completed_at_ms IS NOT NULL AND completed_at_ms < ?",
      )
      .run(timestamp - this.retentionMs);
    const count = database.query("SELECT COUNT(*) AS count FROM transcript_batches").get() as {
      count: number;
    };
    const excess = Number(count.count) + reserve - this.maxBatches;
    if (excess <= 0) {
      return;
    }
    database
      .query(
        "DELETE FROM transcript_batches WHERE batch_id IN (SELECT batch_id FROM transcript_batches WHERE state = 'completed' ORDER BY completed_at_ms, created_at_ms LIMIT ?)",
      )
      .run(excess);
  }

  private readGenerationInDatabase(database: Database, threadId: string): number {
    const row = database
      .query("SELECT generation FROM transcript_generations WHERE thread_id = ?")
      .get(threadId) as GenerationRow | null;
    return row?.generation ?? 0;
  }

  private transcriptFilePath(threadId: string): string {
    if (!SAFE_THREAD_ID.test(threadId)) {
      throw new TranscriptInboxError("threadId contains invalid characters", 400);
    }
    return path.join(this.transcriptsDir, `${threadId}.jsonl`);
  }

  private withDatabase<T>(operation: (database: Database) => T): T {
    const database = new Database(this.databasePath, { create: true, strict: false });
    try {
      ensureSchema(database);
      this.enforcePrivateDatabasePermissions();
      const result = operation(database);
      this.enforcePrivateDatabasePermissions();
      return result;
    } finally {
      database.close(false);
      this.enforcePrivateDatabasePermissions();
    }
  }

  private enforcePrivateDatabasePermissions(): void {
    fs.chmodSync(path.dirname(this.databasePath), PRIVATE_DIR_MODE);
    chmodIfPresent(this.databasePath, PRIVATE_FILE_MODE);
    chmodIfPresent(`${this.databasePath}-wal`, PRIVATE_FILE_MODE);
    chmodIfPresent(`${this.databasePath}-shm`, PRIVATE_FILE_MODE);
  }

  private withImmediateTransaction<T>(operation: (database: Database) => T): T {
    return this.withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const result = operation(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    });
  }

  private rethrowOperational(error: unknown, message: string): never {
    if (error instanceof TranscriptInboxError) {
      throw error;
    }
    const code = errorCode(error);
    const detail = error instanceof Error ? error.message : String(error);
    const locked =
      code.includes("BUSY") || code.includes("LOCKED") || /database (?:is )?locked/i.test(detail);
    throw new TranscriptInboxError(
      locked ? "Transcript inbox is busy" : message,
      locked ? 503 : 500,
      {
        cause: error,
      },
    );
  }
}
