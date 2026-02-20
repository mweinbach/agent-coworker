# Session Storage Architecture

This document describes the hybrid session/history architecture introduced with the SQLite cutover.

## Canonical Store

- Canonical session/history storage lives in `~/.cowork/sessions.db`.
- Legacy JSON snapshots in `~/.cowork/sessions/*.json` are read only for one-time startup import.
- Backup/checkpoint artifacts remain filesystem-based under `~/.cowork/session-backups`.

## Data Model

Core tables:

- `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
- `sessions(...)` metadata row per session (`status`, `message_count`, `last_event_seq`, etc.)
- `session_state(...)` materialized state (`system_prompt`, `messages_json`, `todos_json`, `harness_context_json`)
- `session_events(...)` append-only semantic event log keyed by `(session_id, seq)`

Indexes:

- `sessions(updated_at DESC)`
- `session_events(session_id, seq DESC)`
- `sessions(status, updated_at DESC)`

SQLite pragmas at init:

- `journal_mode=WAL`
- `synchronous=NORMAL`
- `foreign_keys=ON`
- `busy_timeout`

## Migration

On server startup:

1. Create/upgrade schema migrations.
2. If legacy import migration is not marked:
   - Scan `~/.cowork/sessions/*.json`.
   - Parse valid legacy snapshots.
   - Upsert `sessions` + `session_state`.
   - Insert synthetic `session_events` row with `event_type=legacy_import_snapshot`.
3. Mark migration complete.

Legacy files are left untouched for rollback visibility.

## Resume Semantics

When connecting with `resumeSessionId`:

1. Try warm in-memory binding.
2. If missing, load from SQLite and cold-rehydrate.
3. If not found, create a new session.

`server_hello` remains v6-compatible and includes optional:

- `isResume`
- `busy`
- `messageCount`
- `hasPendingAsk`
- `hasPendingApproval`
- `resumedFromStorage` (cold rehydrate only)

## Surface Behavior

- Core server: writes semantic events + state updates transactionally to SQLite.
- CLI/TUI/desktop: list/resume/history operations go through server APIs (`list_sessions`, `get_messages`, etc.).
- Desktop transcript JSONL remains a cache for fast local rendering, not an authority.
- Desktop thread removal sends `session_close` only; explicit "Delete session history" sends `delete_session`.
