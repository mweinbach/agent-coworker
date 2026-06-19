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
- `research(...)` global research metadata rows (`status`, `interaction_id`, `last_event_id`, `inputs_json`, `settings_json`, `outputs_markdown`, `thought_summaries_json`, `sources_json`, `error`)
- `tasks(...)` project-scoped task brief and lifecycle rows with optimistic `revision`
- `task_threads(...)` maps coordinator task threads to canonical session ids
- `task_requirements(...)`, `task_work_items(...)`, and `task_work_item_dependencies(...)` hold the live brief and work graph
- `task_work_item_claims(...)` provides transactional single-owner work-item claims across concurrent task threads
- `task_decisions(...)`, `task_artifacts(...)`, `task_blockers(...)`, and `task_activity(...)` hold durable semantic work state
- `task_questions(...)` stores blocking and non-blocking user decisions, structured options, reversible defaults, provisional decision links, answers, supersession, and resolution state
- `task_artifact_versions(...)` stores immutable version lineage, hashes, provenance, and review state; content-addressed bytes live separately under `~/.cowork/artifacts`
- `task_artifact_revisions(...)` owns focused revision work items and task threads, including rollback state
- `task_checkpoints(...)` stores compact coordinator snapshots for resume
- `task_directive_receipts(...)` deduplicates retried model directives by idempotency key

Indexes:

- `sessions(updated_at DESC)`
- `session_events(session_id, seq DESC)`
- `sessions(status, updated_at DESC)`
- `research(status, updated_at DESC)`
- `research(parent_research_id, updated_at DESC)`
- `tasks(workspace_path, updated_at DESC)`
- `task_activity(task_id, seq DESC)`
- `task_questions(task_id, status, created_at)`
- `task_questions(task_id, blocking, status)`

SQLite pragmas at init:

- `journal_mode=WAL`
- `synchronous=NORMAL`
- `foreign_keys=ON`
- `busy_timeout`

## Migration

On server startup:

1. Create/upgrade schema migrations.
   - Migration 21 adds durable task questions and their indexes without replaying task transcripts.
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
- Research service: writes debounced markdown/thought/source state into `research` rows and mirrors exported artifacts under `~/.cowork/research/<id>/`.
- Task coordinator: owns task lifecycle, validates work-graph and completion invariants, persists durable user questions and provisional defaults, resumes the primary thread after the final blocking answer, versions artifact bytes, checkpoints meaningful phases, and attaches each task thread to an ordinary persisted session without exposing it in chat listings.
- CLI/TUI/desktop: list/resume/history operations go through server APIs (`list_sessions`, `get_messages`, etc.).
- Desktop transcript JSONL remains a cache for fast local rendering, not an authority.
- Desktop thread removal sends `session_close` only; explicit "Delete session history" sends `delete_session`.
