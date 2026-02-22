import type { ModelMessage } from "ai";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { AiCoworkerPaths } from "../connect";
import type { AgentConfig, HarnessContextState, TodoItem } from "../types";
import {
  parsePersistedSessionSnapshot,
  type PersistedSessionSnapshot,
  type PersistedSessionSummary,
} from "./sessionStore";
import type { SessionTitleSource } from "./sessionTitleService";
import { mapPersistedSessionRecordRow, mapPersistedSessionSummaryRow } from "./sessionDb/mappers";
import {
  isCorruptionError,
  parseBooleanInteger,
  parseJsonStringWithSchema,
  parseNonNegativeInteger,
  parseRequiredIsoTimestamp,
  toJsonString,
} from "./sessionDb/normalizers";

export type { PersistedSessionSummary } from "./sessionStore";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const BASE_SCHEMA_MIGRATION = 1;
const LEGACY_IMPORT_MIGRATION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const messagesJsonSchema = z.array(z.unknown());

export type SessionPersistenceStatus = "active" | "closed";

export type PersistedSessionRecord = {
  sessionId: string;
  title: string;
  titleSource: SessionTitleSource;
  titleModel: string | null;
  provider: AgentConfig["provider"];
  model: string;
  workingDirectory: string;
  outputDirectory?: string;
  uploadsDirectory?: string;
  enableMcp: boolean;
  createdAt: string;
  updatedAt: string;
  status: SessionPersistenceStatus;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
  messageCount: number;
  lastEventSeq: number;
  systemPrompt: string;
  messages: ModelMessage[];
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
};

export type PersistedSessionMutation = {
  sessionId: string;
  eventType: string;
  eventTs?: string;
  direction?: "client" | "server" | "system";
  payload?: unknown;
  snapshot: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
    enableMcp: boolean;
    createdAt: string;
    updatedAt: string;
    status: SessionPersistenceStatus;
    hasPendingAsk: boolean;
    hasPendingApproval: boolean;
    systemPrompt: string;
    messages: ModelMessage[];
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
  };
};

type SessionDbOptions = {
  paths: Pick<AiCoworkerPaths, "rootDir" | "sessionsDir">;
  dbPath?: string;
  busyTimeoutMs?: number;
};

export class SessionDb {
  readonly dbPath: string;

  private readonly db: Database;
  private readonly sessionsDir: string;
  private readonly busyTimeoutMs: number;

  private constructor(opts: { db: Database; dbPath: string; sessionsDir: string; busyTimeoutMs: number }) {
    this.db = opts.db;
    this.dbPath = opts.dbPath;
    this.sessionsDir = opts.sessionsDir;
    this.busyTimeoutMs = opts.busyTimeoutMs;
  }

  static async create(opts: SessionDbOptions): Promise<SessionDb> {
    await fs.mkdir(opts.paths.rootDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      await fs.chmod(opts.paths.rootDir, PRIVATE_DIR_MODE);
    } catch {
      // best effort only
    }

    const dbPath = opts.dbPath ?? path.join(opts.paths.rootDir, "sessions.db");
    const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    let db: Database;
    try {
      db = new Database(dbPath, { create: true, strict: false });
    } catch (error) {
      throw new Error(`Failed to open session database at ${dbPath}: ${String(error)}`);
    }

    const repo = new SessionDb({
      db,
      dbPath,
      sessionsDir: opts.paths.sessionsDir,
      busyTimeoutMs,
    });

    try {
      await repo.bootstrap();
      await repo.hardenDbFile();
      return repo;
    } catch (error) {
      if (!isCorruptionError(error)) {
        db.close();
        throw error;
      }

      db.close();
      const backupPath = `${dbPath}.corrupt.${new Date().toISOString().replaceAll(":", "-")}.bak`;
      try {
        await fs.rename(dbPath, backupPath);
      } catch {
        // If we cannot move the corrupted file, attempt to overwrite in place.
        await fs.rm(dbPath, { force: true });
      }

      const recreated = new Database(dbPath, { create: true, strict: false });
      const recoveredRepo = new SessionDb({
        db: recreated,
        dbPath,
        sessionsDir: opts.paths.sessionsDir,
        busyTimeoutMs,
      });
      await recoveredRepo.bootstrap();
      await recoveredRepo.hardenDbFile();
      return recoveredRepo;
    }
  }

  close(): void {
    this.db.close();
  }

  listSessions(): PersistedSessionSummary[] {
    const rows = this.db
      .query(
        `SELECT session_id, title, provider, model, created_at, updated_at, message_count
         FROM sessions
         ORDER BY updated_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapPersistedSessionSummaryRow);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  getMessages(sessionId: string, offset = 0, limit = 100): { messages: ModelMessage[]; total: number } {
    const row = this.db
      .query("SELECT messages_json FROM session_state WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) return { messages: [], total: 0 };
    const all = parseJsonStringWithSchema(row.messages_json, messagesJsonSchema, "messages_json") as ModelMessage[];
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    const total = all.length;
    const messages = all.slice(safeOffset, safeOffset + safeLimit);
    return { messages, total };
  }

  getSessionRecord(sessionId: string): PersistedSessionRecord | null {
    const row = this.db
      .query(
        `SELECT
           s.session_id,
           s.title,
           s.title_source,
           s.title_model,
           s.provider,
           s.model,
           s.working_directory,
           s.output_directory,
           s.uploads_directory,
           s.enable_mcp,
           s.created_at,
           s.updated_at,
           s.status,
           s.has_pending_ask,
           s.has_pending_approval,
           s.message_count,
           s.last_event_seq,
           st.system_prompt,
           st.messages_json,
           st.todos_json,
           st.harness_context_json
         FROM sessions s
         JOIN session_state st ON st.session_id = s.session_id
         WHERE s.session_id = ?
         LIMIT 1`
      )
      .get(sessionId) as Record<string, unknown> | null;

    if (!row) return null;
    return mapPersistedSessionRecordRow(row);
  }

  persistSessionMutation(opts: PersistedSessionMutation): number {
    const run = this.db.transaction((input: PersistedSessionMutation) => {
      const existing = this.db
        .query("SELECT last_event_seq FROM sessions WHERE session_id = ?")
        .get(input.sessionId) as Record<string, unknown> | null;

      const currentSeq = existing ? parseNonNegativeInteger(existing.last_event_seq, "sessions.last_event_seq") : 0;
      const nextSeq = currentSeq + 1;
      const snapshot = input.snapshot;
      const outputDirectory = snapshot.outputDirectory ?? null;
      const uploadsDirectory = snapshot.uploadsDirectory ?? null;
      const createdAt = parseRequiredIsoTimestamp(snapshot.createdAt, "snapshot.createdAt");
      const updatedAt = parseRequiredIsoTimestamp(snapshot.updatedAt, "snapshot.updatedAt");
      const ts = parseRequiredIsoTimestamp(input.eventTs ?? updatedAt, "event timestamp");
      const direction = input.direction ?? "system";
      const payloadJson = toJsonString(input.payload ?? {});

      this.db
        .query(
          `INSERT INTO sessions (
             session_id,
             title,
             title_source,
             title_model,
             provider,
             model,
             working_directory,
             output_directory,
             uploads_directory,
             enable_mcp,
             created_at,
             updated_at,
             status,
             has_pending_ask,
             has_pending_approval,
             message_count,
             last_event_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             title = excluded.title,
             title_source = excluded.title_source,
             title_model = excluded.title_model,
             provider = excluded.provider,
             model = excluded.model,
             working_directory = excluded.working_directory,
             output_directory = excluded.output_directory,
             uploads_directory = excluded.uploads_directory,
             enable_mcp = excluded.enable_mcp,
             updated_at = excluded.updated_at,
             status = excluded.status,
             has_pending_ask = excluded.has_pending_ask,
             has_pending_approval = excluded.has_pending_approval,
             message_count = excluded.message_count,
             last_event_seq = excluded.last_event_seq`
        )
        .run(
          input.sessionId,
          snapshot.title,
          snapshot.titleSource,
          snapshot.titleModel,
          snapshot.provider,
          snapshot.model,
          snapshot.workingDirectory,
          outputDirectory,
          uploadsDirectory,
          snapshot.enableMcp ? 1 : 0,
          createdAt,
          updatedAt,
          snapshot.status,
          snapshot.hasPendingAsk ? 1 : 0,
          snapshot.hasPendingApproval ? 1 : 0,
          snapshot.messages.length,
          nextSeq
        );

      this.db
        .query(
          `INSERT INTO session_state (
             session_id,
             system_prompt,
             messages_json,
             todos_json,
             harness_context_json
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             system_prompt = excluded.system_prompt,
             messages_json = excluded.messages_json,
             todos_json = excluded.todos_json,
             harness_context_json = excluded.harness_context_json`
        )
        .run(
          input.sessionId,
          snapshot.systemPrompt,
          toJsonString(snapshot.messages),
          toJsonString(snapshot.todos),
          toJsonString(snapshot.harnessContext)
        );

      this.db
        .query(
          `INSERT INTO session_events (
             session_id,
             seq,
             ts,
             direction,
             event_type,
             payload_json
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(input.sessionId, nextSeq, ts, direction, input.eventType, payloadJson);

      return nextSeq;
    });

    return run(opts);
  }

  private async bootstrap(): Promise<void> {
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(this.busyTimeoutMs))};`);

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`
    );

    const appliedMigrations = new Set(
      (
        this.db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
      ).map((row) => row.version)
    );

    if (!appliedMigrations.has(BASE_SCHEMA_MIGRATION)) {
      this.createBaseSchema();
      this.markMigration(BASE_SCHEMA_MIGRATION);
    }

    if (!appliedMigrations.has(LEGACY_IMPORT_MIGRATION)) {
      await this.importLegacySnapshots();
      this.markMigration(LEGACY_IMPORT_MIGRATION);
    }
  }

  private createBaseSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         session_id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         title_source TEXT NOT NULL,
         title_model TEXT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         working_directory TEXT NOT NULL,
         output_directory TEXT NULL,
         uploads_directory TEXT NULL,
         enable_mcp INTEGER NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         status TEXT NOT NULL,
         has_pending_ask INTEGER NOT NULL,
         has_pending_approval INTEGER NOT NULL,
         message_count INTEGER NOT NULL,
         last_event_seq INTEGER NOT NULL
       )`
    );

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_state (
         session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
         system_prompt TEXT NOT NULL,
         messages_json TEXT NOT NULL,
         todos_json TEXT NOT NULL,
         harness_context_json TEXT NULL
       )`
    );

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_events (
         session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         ts TEXT NOT NULL,
         direction TEXT NOT NULL,
         event_type TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         PRIMARY KEY(session_id, seq)
       )`
    );

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_seq_desc ON session_events(session_id, seq DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)");
  }

  private markMigration(version: number): void {
    this.db
      .query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  }

  private async importLegacySnapshots(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.sessionsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.sessionsDir, entry);
      const raw = await fs.readFile(filePath, "utf-8");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Invalid JSON in legacy session snapshot ${filePath}: ${String(error)}`);
      }
      const snapshot = parsePersistedSessionSnapshot(parsedJson);
      this.importLegacySnapshot(snapshot);
    }
  }

  private importLegacySnapshot(snapshot: PersistedSessionSnapshot): void {
    const run = this.db.transaction((legacy: PersistedSessionSnapshot) => {
      const existing = this.db
        .query("SELECT status, has_pending_ask, has_pending_approval, last_event_seq FROM sessions WHERE session_id = ?")
        .get(legacy.sessionId) as Record<string, unknown> | null;

      const existingLastEventSeq = existing
        ? parseNonNegativeInteger(existing.last_event_seq, "sessions.last_event_seq")
        : 0;
      const lastEventSeq = Math.max(existingLastEventSeq, 1);
      const existingStatus = existing?.status;
      if (existingStatus !== undefined && existingStatus !== "active" && existingStatus !== "closed") {
        throw new Error(`Invalid existing session status for ${legacy.sessionId}: ${String(existingStatus)}`);
      }
      const status = existingStatus ?? "active";
      const hasPendingAsk = existing ? parseBooleanInteger(existing.has_pending_ask, "sessions.has_pending_ask") : 0;
      const hasPendingApproval = existing
        ? parseBooleanInteger(existing.has_pending_approval, "sessions.has_pending_approval")
        : 0;
      const createdAt = parseRequiredIsoTimestamp(legacy.createdAt, "legacy.createdAt");
      const updatedAt = parseRequiredIsoTimestamp(legacy.updatedAt, "legacy.updatedAt");

      this.db
        .query(
          `INSERT INTO sessions (
             session_id,
             title,
             title_source,
             title_model,
             provider,
             model,
             working_directory,
             output_directory,
             uploads_directory,
             enable_mcp,
             created_at,
             updated_at,
             status,
             has_pending_ask,
             has_pending_approval,
             message_count,
             last_event_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             title = excluded.title,
             title_source = excluded.title_source,
             title_model = excluded.title_model,
             provider = excluded.provider,
             model = excluded.model,
             working_directory = excluded.working_directory,
             output_directory = excluded.output_directory,
             uploads_directory = excluded.uploads_directory,
             enable_mcp = excluded.enable_mcp,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             message_count = excluded.message_count,
             last_event_seq = CASE
               WHEN sessions.last_event_seq > excluded.last_event_seq THEN sessions.last_event_seq
               ELSE excluded.last_event_seq
             END`
        )
        .run(
          legacy.sessionId,
          legacy.session.title,
          legacy.session.titleSource,
          legacy.session.titleModel,
          legacy.session.provider,
          legacy.session.model,
          legacy.config.workingDirectory,
          legacy.config.outputDirectory ?? null,
          legacy.config.uploadsDirectory ?? null,
          legacy.config.enableMcp ? 1 : 0,
          createdAt,
          updatedAt,
          status,
          hasPendingAsk,
          hasPendingApproval,
          legacy.context.messages.length,
          lastEventSeq
        );

      this.db
        .query(
          `INSERT INTO session_state (
             session_id,
             system_prompt,
             messages_json,
             todos_json,
             harness_context_json
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             system_prompt = excluded.system_prompt,
             messages_json = excluded.messages_json,
             todos_json = excluded.todos_json,
             harness_context_json = excluded.harness_context_json`
        )
        .run(
          legacy.sessionId,
          legacy.context.system,
          toJsonString(legacy.context.messages),
          toJsonString(legacy.context.todos),
          toJsonString(legacy.context.harnessContext)
        );

      this.db
        .query(
          `INSERT OR IGNORE INTO session_events (
             session_id,
             seq,
             ts,
             direction,
             event_type,
             payload_json
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          legacy.sessionId,
          1,
          updatedAt,
          "server",
          "legacy_import_snapshot",
          toJsonString({ version: legacy.version })
        );
    });

    run(snapshot);
  }

  private async hardenDbFile(): Promise<void> {
    try {
      await fs.chmod(this.dbPath, PRIVATE_FILE_MODE);
    } catch {
      // best effort only
    }
  }
}
