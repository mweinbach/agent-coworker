import type { ModelMessage } from "ai";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import type { AiCoworkerPaths } from "../connect";
import { isProviderName } from "../types";
import type { AgentConfig, HarnessContextState, TodoItem } from "../types";
import type { PersistedSessionSummary } from "./sessionStore";
import type { SessionTitleSource } from "./sessionTitleService";
import { isRecord } from "../utils/typeGuards";

export type { PersistedSessionSummary } from "./sessionStore";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const BASE_SCHEMA_MIGRATION = 1;
const LEGACY_IMPORT_MIGRATION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asIsoTimestamp(value: unknown, fallback = new Date().toISOString()): string {
  const text = asNonEmptyString(value);
  if (!text) return fallback;
  return Number.isNaN(Date.parse(text)) ? fallback : text;
}

function asSessionTitleSource(value: unknown): SessionTitleSource {
  const raw = asNonEmptyString(value);
  return raw === "default" || raw === "model" || raw === "heuristic" || raw === "manual"
    ? raw
    : "default";
}

function asProvider(value: unknown, fallback: AgentConfig["provider"] = "google"): AgentConfig["provider"] {
  const raw = asNonEmptyString(value);
  if (!raw || !isProviderName(raw)) return fallback;
  return raw;
}

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toJsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function asIntegerFlag(value: unknown): 0 | 1 {
  return value === 1 ? 1 : 0;
}

function asPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isCorruptionError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("database disk image is malformed")
    || msg.includes("file is not a database")
    || msg.includes("database corruption");
}

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

    return rows
      .map((row) => {
        const sessionId = asNonEmptyString(row.session_id);
        const title = asNonEmptyString(row.title);
        const provider = asProvider(row.provider, "google");
        const model = asNonEmptyString(row.model);
        const createdAt = asIsoTimestamp(row.created_at);
        const updatedAt = asIsoTimestamp(row.updated_at);
        const messageCount = asPositiveInteger(row.message_count);
        if (!sessionId || !title || !model) return null;
        return {
          sessionId,
          title,
          provider,
          model,
          createdAt,
          updatedAt,
          messageCount,
        } satisfies PersistedSessionSummary;
      })
      .filter((entry): entry is PersistedSessionSummary => entry !== null);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  getMessages(sessionId: string, offset = 0, limit = 100): { messages: ModelMessage[]; total: number } {
    const row = this.db
      .query("SELECT messages_json FROM session_state WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) return { messages: [], total: 0 };
    const all = parseJsonSafe<ModelMessage[]>(row.messages_json, []);
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

    const persistedId = asNonEmptyString(row.session_id);
    const title = asNonEmptyString(row.title);
    const provider = asProvider(row.provider, "google");
    const model = asNonEmptyString(row.model);
    const workingDirectory = asNonEmptyString(row.working_directory);
    const systemPrompt = typeof row.system_prompt === "string" ? row.system_prompt : "";
    if (!persistedId || !title || !model || !workingDirectory) {
      return null;
    }

    const createdAt = asIsoTimestamp(row.created_at);
    const updatedAt = asIsoTimestamp(row.updated_at);
    const outputDirectory = asNonEmptyString(row.output_directory) ?? undefined;
    const uploadsDirectory = asNonEmptyString(row.uploads_directory) ?? undefined;
    const enableMcp = asIntegerFlag(row.enable_mcp) === 1;
    const hasPendingAsk = asIntegerFlag(row.has_pending_ask) === 1;
    const hasPendingApproval = asIntegerFlag(row.has_pending_approval) === 1;
    const messageCount = asPositiveInteger(row.message_count);
    const lastEventSeq = asPositiveInteger(row.last_event_seq);
    const status = row.status === "closed" ? "closed" : "active";
    const titleSource = asSessionTitleSource(row.title_source);
    const titleModel = asNonEmptyString(row.title_model);
    const messages = parseJsonSafe<ModelMessage[]>(row.messages_json, []);
    const todos = parseJsonSafe<TodoItem[]>(row.todos_json, []);
    const harnessContextRaw = parseJsonSafe<unknown>(row.harness_context_json, null);
    const harnessContext = isRecord(harnessContextRaw) ? (harnessContextRaw as HarnessContextState) : null;

    return {
      sessionId: persistedId,
      title,
      titleSource,
      titleModel,
      provider,
      model,
      workingDirectory,
      outputDirectory,
      uploadsDirectory,
      enableMcp,
      createdAt,
      updatedAt,
      status,
      hasPendingAsk,
      hasPendingApproval,
      messageCount,
      lastEventSeq,
      systemPrompt,
      messages,
      todos,
      harnessContext,
    };
  }

  persistSessionMutation(opts: PersistedSessionMutation): number {
    const run = this.db.transaction((input: PersistedSessionMutation) => {
      const existing = this.db
        .query("SELECT last_event_seq FROM sessions WHERE session_id = ?")
        .get(input.sessionId) as Record<string, unknown> | null;

      const currentSeq = existing ? asPositiveInteger(existing.last_event_seq) : 0;
      const nextSeq = currentSeq + 1;
      const snapshot = input.snapshot;
      const outputDirectory = snapshot.outputDirectory ?? null;
      const uploadsDirectory = snapshot.uploadsDirectory ?? null;
      const ts = asIsoTimestamp(input.eventTs ?? snapshot.updatedAt);
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
          snapshot.createdAt,
          snapshot.updatedAt,
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
      // Legacy JSON snapshot import was a one-time migration. New installs skip it.
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

  private async hardenDbFile(): Promise<void> {
    try {
      await fs.chmod(this.dbPath, PRIVATE_FILE_MODE);
    } catch {
      // best effort only
    }
  }
}
