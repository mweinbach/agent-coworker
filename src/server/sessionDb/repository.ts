import type { Database } from "bun:sqlite";
import { z } from "zod";

import type { PersistentAgentSummary } from "../../shared/agents";
import type { PersistedModelStreamChunk, PersistedSessionMutation, PersistedSessionRecord } from "../sessionDb";
import type { PersistedSessionSnapshot, PersistedSessionSummary } from "../sessionStore";
import type { ModelMessage } from "../../types";
import { sessionSnapshotSchema, type SessionSnapshot } from "../../shared/sessionSnapshot";
import { mapPersistedSessionRecordRow, mapPersistedSessionSubagentSummaryRow, mapPersistedSessionSummaryRow } from "./mappers";
import { sameWorkspacePath } from "../../utils/workspacePath";
import {
  parseBooleanInteger,
  parseJsonStringWithSchema,
  parseNonNegativeInteger,
  parseRequiredIsoTimestamp,
  toJsonString,
} from "./normalizers";

const messagesJsonSchema = z.array(z.unknown());
const modelStreamRawFormatSchema = z.enum(["openai-responses-v1", "google-interactions-v1"]);

export class SessionDbRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  listSessions(opts?: { workingDirectory?: string | null }): PersistedSessionSummary[] {
    const filterWorkspace = opts?.workingDirectory != null && String(opts.workingDirectory).trim() !== "";

    const rows = (filterWorkspace
      ? this.db
          .query(
            `SELECT
               session_id,
               title,
               title_source,
               title_model,
               provider,
               model,
               created_at,
               updated_at,
               message_count,
               last_event_seq,
               has_pending_ask,
               has_pending_approval,
               working_directory
             FROM sessions
             WHERE session_kind = 'root'
             ORDER BY updated_at DESC`,
          )
          .all()
      : this.db
          .query(
            `SELECT
               session_id,
               title,
               title_source,
               title_model,
               provider,
               model,
               created_at,
               updated_at,
               message_count,
               last_event_seq,
               has_pending_ask,
               has_pending_approval
             FROM sessions
             WHERE session_kind = 'root'
             ORDER BY updated_at DESC`,
          )
          .all()) as Array<Record<string, unknown>>;

    const mapped = filterWorkspace
      ? rows.filter((row) => sameWorkspacePath(String(row.working_directory ?? ""), opts!.workingDirectory!))
      : rows;

    return mapped.map((row) => {
      if (!filterWorkspace) {
        return mapPersistedSessionSummaryRow(row);
      }
      const { working_directory: _wd, ...summaryRow } = row;
      return mapPersistedSessionSummaryRow(summaryRow);
    });
  }

  listAgentSessions(parentSessionId: string): PersistentAgentSummary[] {
    const rows = this.db
      .query(
        `SELECT
           session_id,
           parent_session_id,
           COALESCE(
             role,
             CASE agent_type
               WHEN 'general' THEN 'worker'
               WHEN 'explore' THEN 'explorer'
               ELSE agent_type
             END
           ) AS role,
           agent_type,
           title,
           provider,
           model,
           mode,
           depth,
           nickname,
           requested_model,
           effective_model,
           requested_reasoning_effort,
           effective_reasoning_effort,
           created_at,
           updated_at,
           status,
           execution_state,
           last_message_preview
         FROM sessions
         WHERE parent_session_id = ?
           AND session_kind IN ('agent', 'subagent')
         ORDER BY updated_at DESC`,
      )
      .all(parentSessionId) as Array<Record<string, unknown>>;

    return rows.map(mapPersistedSessionSubagentSummaryRow);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM sessions WHERE parent_session_id = ?").run(sessionId);
    this.db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  getMessages(sessionId: string, offset = 0, limit = 100): { messages: ModelMessage[]; total: number } {
    const row = this.db
      .query("SELECT messages_json FROM session_state WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) return { messages: [], total: 0 };
    let all: ModelMessage[];
    try {
      all = parseJsonStringWithSchema(row.messages_json, messagesJsonSchema, "messages_json") as ModelMessage[];
    } catch {
      all = [];
    }
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
           s.session_kind,
           s.parent_session_id,
           COALESCE(
             s.role,
             CASE s.agent_type
               WHEN 'general' THEN 'worker'
               WHEN 'explore' THEN 'explorer'
               ELSE s.agent_type
             END
           ) AS role,
           s.agent_type,
           s.mode,
           s.depth,
           s.nickname,
           s.requested_model,
           s.effective_model,
           s.requested_reasoning_effort,
           s.effective_reasoning_effort,
           s.execution_state,
           s.last_message_preview,
           s.title,
           s.title_source,
           s.title_model,
           s.provider,
           s.model,
           s.working_directory,
           s.output_directory,
           s.uploads_directory,
           s.enable_mcp,
           s.backups_enabled_override,
           s.created_at,
           s.updated_at,
           s.status,
           s.has_pending_ask,
           s.has_pending_approval,
           s.message_count,
           s.last_event_seq,
           st.system_prompt,
           st.messages_json,
           st.provider_state_json,
           st.provider_options_json,
           st.todos_json,
           st.harness_context_json,
           st.cost_tracker_json
         FROM sessions s
         JOIN session_state st ON st.session_id = s.session_id
         WHERE s.session_id = ?
         LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | null;

    if (!row) return null;
    return mapPersistedSessionRecordRow(row);
  }

  getSessionSnapshot(sessionId: string): SessionSnapshot | null {
    const row = this.db
      .query("SELECT snapshot_json FROM session_snapshots WHERE session_id = ? LIMIT 1")
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) return null;
    return parseJsonStringWithSchema(row.snapshot_json, sessionSnapshotSchema, "session_snapshots.snapshot_json");
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
      const providerStateJson =
        snapshot.providerState === null ? null : toJsonString(snapshot.providerState);
      const providerOptionsJson =
        snapshot.providerOptions === undefined ? null : toJsonString(snapshot.providerOptions);
      const costTrackerJson =
        snapshot.costTracker === null ? null : toJsonString(snapshot.costTracker);
      const backupsEnabledOverride =
        snapshot.backupsEnabledOverride === null ? null : snapshot.backupsEnabledOverride ? 1 : 0;
      const parentSessionId = snapshot.parentSessionId ?? null;
      const role = snapshot.role ?? null;
      const mode = snapshot.mode ?? null;
      const depth = snapshot.depth ?? null;
      const nickname = snapshot.nickname ?? null;
      const requestedModel = snapshot.requestedModel ?? null;
      const effectiveModel = snapshot.effectiveModel ?? null;
      const requestedReasoningEffort = snapshot.requestedReasoningEffort ?? null;
      const effectiveReasoningEffort = snapshot.effectiveReasoningEffort ?? null;
      const executionState = snapshot.executionState ?? null;
      const lastMessagePreview = snapshot.lastMessagePreview ?? null;
      const createdAt = parseRequiredIsoTimestamp(snapshot.createdAt, "snapshot.createdAt");
      const updatedAt = parseRequiredIsoTimestamp(snapshot.updatedAt, "snapshot.updatedAt");
      const ts = parseRequiredIsoTimestamp(input.eventTs ?? updatedAt, "event timestamp");
      const direction = input.direction ?? "system";
      const payloadJson = toJsonString(input.payload ?? {});

      this.db
        .query(
          `INSERT INTO sessions (
             session_id,
             session_kind,
             parent_session_id,
             role,
             agent_type,
             mode,
             depth,
             nickname,
             requested_model,
             effective_model,
             requested_reasoning_effort,
             effective_reasoning_effort,
             execution_state,
             last_message_preview,
             title,
             title_source,
             title_model,
             provider,
             model,
             working_directory,
             output_directory,
             uploads_directory,
             enable_mcp,
             backups_enabled_override,
             created_at,
             updated_at,
             status,
             has_pending_ask,
             has_pending_approval,
             message_count,
             last_event_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             session_kind = excluded.session_kind,
             parent_session_id = excluded.parent_session_id,
             role = excluded.role,
             agent_type = excluded.agent_type,
             mode = excluded.mode,
             depth = excluded.depth,
             nickname = excluded.nickname,
             requested_model = excluded.requested_model,
             effective_model = excluded.effective_model,
             requested_reasoning_effort = excluded.requested_reasoning_effort,
             effective_reasoning_effort = excluded.effective_reasoning_effort,
             execution_state = excluded.execution_state,
             last_message_preview = excluded.last_message_preview,
             title = excluded.title,
             title_source = excluded.title_source,
             title_model = excluded.title_model,
             provider = excluded.provider,
             model = excluded.model,
             working_directory = excluded.working_directory,
             output_directory = excluded.output_directory,
             uploads_directory = excluded.uploads_directory,
             enable_mcp = excluded.enable_mcp,
             backups_enabled_override = excluded.backups_enabled_override,
             updated_at = excluded.updated_at,
             status = excluded.status,
             has_pending_ask = excluded.has_pending_ask,
             has_pending_approval = excluded.has_pending_approval,
             message_count = excluded.message_count,
             last_event_seq = excluded.last_event_seq`,
        )
        .run(
          input.sessionId,
          snapshot.sessionKind,
          parentSessionId,
          role,
          null,
          mode,
          depth,
          nickname,
          requestedModel,
          effectiveModel,
          requestedReasoningEffort,
          effectiveReasoningEffort,
          executionState,
          lastMessagePreview,
          snapshot.title,
          snapshot.titleSource,
          snapshot.titleModel,
          snapshot.provider,
          snapshot.model,
          snapshot.workingDirectory,
          outputDirectory,
          uploadsDirectory,
          snapshot.enableMcp ? 1 : 0,
          backupsEnabledOverride,
          createdAt,
          updatedAt,
          snapshot.status,
          snapshot.hasPendingAsk ? 1 : 0,
          snapshot.hasPendingApproval ? 1 : 0,
          snapshot.messages.length,
          nextSeq,
        );

      this.db
        .query(
          `INSERT INTO session_state (
             session_id,
             system_prompt,
             messages_json,
             provider_state_json,
             provider_options_json,
             todos_json,
             harness_context_json,
             cost_tracker_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             system_prompt = excluded.system_prompt,
             messages_json = excluded.messages_json,
             provider_state_json = excluded.provider_state_json,
             provider_options_json = excluded.provider_options_json,
             todos_json = excluded.todos_json,
             harness_context_json = excluded.harness_context_json,
             cost_tracker_json = excluded.cost_tracker_json`,
        )
        .run(
          input.sessionId,
          snapshot.systemPrompt,
          toJsonString(snapshot.messages),
          providerStateJson,
          providerOptionsJson,
          toJsonString(snapshot.todos),
          toJsonString(snapshot.harnessContext),
          costTrackerJson,
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
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.sessionId, nextSeq, ts, direction, input.eventType, payloadJson);

      return nextSeq;
    });

    return run(opts);
  }

  persistModelStreamChunk(opts: PersistedModelStreamChunk): void {
    const ts = parseRequiredIsoTimestamp(opts.ts, "model_stream_chunk.ts");
    const chunkIndex = parseNonNegativeInteger(opts.chunkIndex, "model_stream_chunk.chunkIndex");
    const rawFormat = modelStreamRawFormatSchema.parse(opts.rawFormat);

    this.db
      .query(
        `INSERT INTO session_model_stream_chunks (
           session_id,
           turn_id,
           chunk_index,
           ts,
           provider,
           model,
           raw_format,
           normalizer_version,
           raw_event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.sessionId,
        opts.turnId,
        chunkIndex,
        ts,
        opts.provider,
        opts.model,
        rawFormat,
        opts.normalizerVersion,
        toJsonString(opts.rawEvent),
      );
  }

  persistSessionSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
    this.db
      .query(
        `INSERT INTO session_snapshots (session_id, updated_at, snapshot_json)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           snapshot_json = excluded.snapshot_json`,
      )
      .run(sessionId, snapshot.updatedAt, toJsonString(snapshot));
  }

  listModelStreamChunks(sessionId: string, turnId?: string): PersistedModelStreamChunk[] {
    const rows = turnId
      ? (this.db
          .query(
            `SELECT session_id, turn_id, chunk_index, ts, provider, model, raw_format, normalizer_version, raw_event_json
             FROM session_model_stream_chunks
             WHERE session_id = ? AND turn_id = ?
             ORDER BY chunk_index ASC`,
          )
          .all(sessionId, turnId) as Array<Record<string, unknown>>)
      : (this.db
          .query(
            `SELECT session_id, turn_id, chunk_index, ts, provider, model, raw_format, normalizer_version, raw_event_json
             FROM session_model_stream_chunks
             WHERE session_id = ?
             ORDER BY turn_id ASC, chunk_index ASC`,
          )
          .all(sessionId) as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      sessionId: String(row.session_id),
      turnId: String(row.turn_id),
      chunkIndex: parseNonNegativeInteger(row.chunk_index, "session_model_stream_chunks.chunk_index"),
      ts: parseRequiredIsoTimestamp(row.ts, "session_model_stream_chunks.ts"),
      provider: String(row.provider) as PersistedModelStreamChunk["provider"],
      model: String(row.model),
      rawFormat: modelStreamRawFormatSchema.parse(row.raw_format),
      normalizerVersion: parseNonNegativeInteger(
        row.normalizer_version,
        "session_model_stream_chunks.normalizer_version",
      ),
      rawEvent: parseJsonStringWithSchema(
        row.raw_event_json,
        z.unknown(),
        "session_model_stream_chunks.raw_event_json",
      ),
    }));
  }

  createBaseSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         session_id TEXT PRIMARY KEY,
         session_kind TEXT NOT NULL DEFAULT 'root',
         parent_session_id TEXT NULL,
         role TEXT NULL,
         agent_type TEXT NULL,
         mode TEXT NULL,
         depth INTEGER NULL,
         nickname TEXT NULL,
         requested_model TEXT NULL,
         effective_model TEXT NULL,
         requested_reasoning_effort TEXT NULL,
         effective_reasoning_effort TEXT NULL,
         execution_state TEXT NULL,
         last_message_preview TEXT NULL,
         title TEXT NOT NULL,
         title_source TEXT NOT NULL,
         title_model TEXT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         working_directory TEXT NOT NULL,
         output_directory TEXT NULL,
         uploads_directory TEXT NULL,
         enable_mcp INTEGER NOT NULL,
         backups_enabled_override INTEGER NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         status TEXT NOT NULL,
         has_pending_ask INTEGER NOT NULL,
         has_pending_approval INTEGER NOT NULL,
         message_count INTEGER NOT NULL,
         last_event_seq INTEGER NOT NULL
       )`,
    );

    this.db.exec(
         `CREATE TABLE IF NOT EXISTS session_state (
             session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
             system_prompt TEXT NOT NULL,
             messages_json TEXT NOT NULL,
             provider_state_json TEXT NULL,
             provider_options_json TEXT NULL,
             todos_json TEXT NOT NULL,
             harness_context_json TEXT NULL,
             cost_tracker_json TEXT NULL
           )`,
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
       )`,
    );

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_model_stream_chunks (
         session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
         turn_id TEXT NOT NULL,
         chunk_index INTEGER NOT NULL,
         ts TEXT NOT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         raw_format TEXT NOT NULL,
         normalizer_version INTEGER NOT NULL,
         raw_event_json TEXT NOT NULL,
         PRIMARY KEY(session_id, turn_id, chunk_index)
       )`,
    );

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_snapshots (
         session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
         updated_at TEXT NOT NULL,
         snapshot_json TEXT NOT NULL
       )`,
    );

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_seq_desc ON session_events(session_id, seq DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent_updated ON sessions(parent_session_id, updated_at DESC)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_model_stream_chunks_session_turn ON session_model_stream_chunks(session_id, turn_id, chunk_index)",
    );
  }

  markMigration(version: number): void {
    this.db
      .query("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  }

  getAppliedMigrationVersions(): Set<number> {
    return new Set(
      (
        this.db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
      ).map((row) => row.version),
    );
  }

  hasSessionStateColumn(columnName: string): boolean {
    const rows = this.db.query("PRAGMA table_info(session_state)").all() as Array<Record<string, unknown>>;
    return rows.some((row) => row.name === columnName);
  }

  addProviderStateColumn(): void {
    if (this.hasSessionStateColumn("provider_state_json")) return;
    this.db.exec("ALTER TABLE session_state ADD COLUMN provider_state_json TEXT NULL");
  }

  addCostTrackerColumn(): void {
    if (this.hasSessionStateColumn("cost_tracker_json")) return;
    this.db.exec("ALTER TABLE session_state ADD COLUMN cost_tracker_json TEXT NULL");
  }

  addProviderOptionsColumn(): void {
    if (this.hasSessionStateColumn("provider_options_json")) return;
    this.db.exec("ALTER TABLE session_state ADD COLUMN provider_options_json TEXT NULL");
  }

  hasSessionsColumn(columnName: string): boolean {
    const rows = this.db.query("PRAGMA table_info(sessions)").all() as Array<Record<string, unknown>>;
    return rows.some((row) => row.name === columnName);
  }

  addSubagentMetadataColumns(): void {
    if (!this.hasSessionsColumn("session_kind")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'root'");
    }
    if (!this.hasSessionsColumn("parent_session_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT NULL");
    }
    if (!this.hasSessionsColumn("role")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN role TEXT NULL");
    }
    if (!this.hasSessionsColumn("agent_type")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent_type TEXT NULL");
    }
    if (!this.hasSessionsColumn("mode")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NULL");
    }
    if (!this.hasSessionsColumn("depth")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN depth INTEGER NULL");
    }
    if (!this.hasSessionsColumn("nickname")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN nickname TEXT NULL");
    }
    if (!this.hasSessionsColumn("requested_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN requested_model TEXT NULL");
    }
    if (!this.hasSessionsColumn("effective_model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN effective_model TEXT NULL");
    }
    if (!this.hasSessionsColumn("requested_reasoning_effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN requested_reasoning_effort TEXT NULL");
    }
    if (!this.hasSessionsColumn("effective_reasoning_effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN effective_reasoning_effort TEXT NULL");
    }
    if (!this.hasSessionsColumn("execution_state")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN execution_state TEXT NULL");
    }
    if (!this.hasSessionsColumn("last_message_preview")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_message_preview TEXT NULL");
    }
    this.db.exec("UPDATE sessions SET session_kind = 'root' WHERE session_kind IS NULL OR session_kind = ''");
    this.db.exec("UPDATE sessions SET session_kind = 'agent' WHERE session_kind = 'subagent'");
    this.db.exec(
      `UPDATE sessions
       SET role = CASE
         WHEN role IS NOT NULL AND role != '' THEN role
         WHEN agent_type = 'general' THEN 'worker'
         WHEN agent_type = 'explore' THEN 'explorer'
         ELSE agent_type
       END
       WHERE role IS NULL OR role = ''`,
    );
    this.db.exec("UPDATE sessions SET effective_model = model WHERE effective_model IS NULL OR effective_model = ''");
    this.db.exec(
      `UPDATE sessions
       SET execution_state = CASE
         WHEN execution_state IS NOT NULL AND execution_state != '' THEN execution_state
         WHEN status = 'closed' THEN 'closed'
         ELSE 'completed'
       END`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent_updated ON sessions(parent_session_id, updated_at DESC)");
  }

  addBackupsEnabledOverrideColumn(): void {
    if (this.hasSessionsColumn("backups_enabled_override")) return;
    this.db.exec("ALTER TABLE sessions ADD COLUMN backups_enabled_override INTEGER NULL");
  }

  addModelStreamChunksTable(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_model_stream_chunks (
         session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
         turn_id TEXT NOT NULL,
         chunk_index INTEGER NOT NULL,
         ts TEXT NOT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         raw_format TEXT NOT NULL,
         normalizer_version INTEGER NOT NULL,
         raw_event_json TEXT NOT NULL,
         PRIMARY KEY(session_id, turn_id, chunk_index)
       )`,
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_model_stream_chunks_session_turn ON session_model_stream_chunks(session_id, turn_id, chunk_index)",
    );
  }

  addSessionSnapshotsTable(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_snapshots (
         session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
         updated_at TEXT NOT NULL,
         snapshot_json TEXT NOT NULL
       )`,
    );
  }

  importLegacySnapshot(snapshot: PersistedSessionSnapshot): void {
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
      const providerState =
        "providerState" in legacy.context ? legacy.context.providerState : null;
      const costTracker =
        "costTracker" in legacy.context ? legacy.context.costTracker : null;
      const backupsEnabledOverride =
        legacy.version === 5 || legacy.version === 6 || legacy.version === 7
          ? legacy.config.backupsEnabledOverride
          : null;
      const providerOptions =
        legacy.version === 7 ? legacy.config.providerOptions : undefined;
      const hasSubagentMetadata =
        legacy.version === 3 || legacy.version === 4 || legacy.version === 5 || legacy.version === 6 || legacy.version === 7;
      const hasAgentExecutionMetadata = legacy.version === 6 || legacy.version === 7;
      const sessionKind = hasSubagentMetadata ? legacy.session.sessionKind : "root";
      const parentSessionId = hasSubagentMetadata ? legacy.session.parentSessionId : null;
      const role = hasSubagentMetadata ? legacy.session.role : null;
      const effectiveModel =
        hasAgentExecutionMetadata ? legacy.session.effectiveModel : legacy.config.model;
      const requestedModel =
        hasAgentExecutionMetadata ? legacy.session.requestedModel : null;
      const requestedReasoningEffort =
        hasAgentExecutionMetadata ? legacy.session.requestedReasoningEffort : null;
      const effectiveReasoningEffort =
        hasAgentExecutionMetadata ? legacy.session.effectiveReasoningEffort : null;
      const mode = hasAgentExecutionMetadata ? legacy.session.mode : null;
      const depth = hasAgentExecutionMetadata ? legacy.session.depth : null;
      const nickname = hasAgentExecutionMetadata ? legacy.session.nickname : null;
      const executionState =
        hasAgentExecutionMetadata
          ? legacy.session.executionState
          : status === "closed"
            ? "closed"
            : "completed";
      const lastMessagePreview =
        hasAgentExecutionMetadata ? legacy.session.lastMessagePreview : null;
      const createdAt = parseRequiredIsoTimestamp(legacy.createdAt, "legacy.createdAt");
      const updatedAt = parseRequiredIsoTimestamp(legacy.updatedAt, "legacy.updatedAt");

      this.db
        .query(
          `INSERT INTO sessions (
             session_id,
             session_kind,
             parent_session_id,
             role,
             agent_type,
             mode,
             depth,
             nickname,
             requested_model,
             effective_model,
             requested_reasoning_effort,
             effective_reasoning_effort,
             execution_state,
             last_message_preview,
             title,
             title_source,
             title_model,
             provider,
             model,
             working_directory,
             output_directory,
             uploads_directory,
             enable_mcp,
             backups_enabled_override,
             created_at,
             updated_at,
             status,
             has_pending_ask,
             has_pending_approval,
             message_count,
             last_event_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             session_kind = excluded.session_kind,
             parent_session_id = excluded.parent_session_id,
             role = excluded.role,
             agent_type = excluded.agent_type,
             mode = excluded.mode,
             depth = excluded.depth,
             nickname = excluded.nickname,
             requested_model = excluded.requested_model,
             effective_model = excluded.effective_model,
             requested_reasoning_effort = excluded.requested_reasoning_effort,
             effective_reasoning_effort = excluded.effective_reasoning_effort,
             execution_state = excluded.execution_state,
             last_message_preview = excluded.last_message_preview,
             title = excluded.title,
             title_source = excluded.title_source,
             title_model = excluded.title_model,
             provider = excluded.provider,
             model = excluded.model,
             working_directory = excluded.working_directory,
             output_directory = excluded.output_directory,
             uploads_directory = excluded.uploads_directory,
             enable_mcp = excluded.enable_mcp,
             backups_enabled_override = excluded.backups_enabled_override,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             message_count = excluded.message_count,
             last_event_seq = CASE
               WHEN sessions.last_event_seq > excluded.last_event_seq THEN sessions.last_event_seq
               ELSE excluded.last_event_seq
             END`,
        )
        .run(
          legacy.sessionId,
          sessionKind,
          parentSessionId,
          role,
          null,
          mode,
          depth,
          nickname,
          requestedModel,
          effectiveModel,
          requestedReasoningEffort,
          effectiveReasoningEffort,
          executionState,
          lastMessagePreview,
          legacy.session.title,
          legacy.session.titleSource,
          legacy.session.titleModel,
          legacy.session.provider,
          legacy.session.model,
          legacy.config.workingDirectory,
          legacy.config.outputDirectory ?? null,
          legacy.config.uploadsDirectory ?? null,
          legacy.config.enableMcp ? 1 : 0,
          backupsEnabledOverride === null ? null : backupsEnabledOverride ? 1 : 0,
          createdAt,
          updatedAt,
          status,
          hasPendingAsk,
          hasPendingApproval,
          legacy.context.messages.length,
          lastEventSeq,
        );

      this.db
        .query(
          `INSERT INTO session_state (
             session_id,
             system_prompt,
             messages_json,
             provider_state_json,
             provider_options_json,
             todos_json,
             harness_context_json,
             cost_tracker_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             system_prompt = excluded.system_prompt,
             messages_json = excluded.messages_json,
             provider_state_json = excluded.provider_state_json,
             provider_options_json = excluded.provider_options_json,
             todos_json = excluded.todos_json,
             harness_context_json = excluded.harness_context_json,
             cost_tracker_json = excluded.cost_tracker_json`,
        )
        .run(
          legacy.sessionId,
          legacy.context.system,
          toJsonString(legacy.context.messages),
          providerState === null ? null : toJsonString(providerState),
          providerOptions === undefined ? null : toJsonString(providerOptions),
          toJsonString(legacy.context.todos),
          toJsonString(legacy.context.harnessContext),
          costTracker === null ? null : toJsonString(costTracker),
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
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacy.sessionId,
          1,
          updatedAt,
          "server",
          "legacy_import_snapshot",
          toJsonString({ version: legacy.version }),
        );
    });

    run(snapshot);
  }
}
