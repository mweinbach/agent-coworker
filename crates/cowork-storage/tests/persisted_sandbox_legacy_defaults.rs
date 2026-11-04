//! A session's stored `sandbox_json` must keep its restrictions on resume. The TS persistence
//! schema made `network` / `requireBackend` optional, so legacy policies such as
//! `{"mode":"read-only"}` load with the TS defaults (network enabled, backend not required)
//! instead of being dropped (which would let the resumed session fall back to the workspace
//! defaults). A stored policy that cannot be parsed at all fails closed to read-only.

use std::fs;
use std::path::PathBuf;

use cowork_config::{ProviderName, SandboxConfig, SandboxMode, canonicalize_sync};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb, SessionDbOptions,
    SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use rusqlite::Connection;
use serde_json::json;
use uuid::Uuid;

struct Iso {
    root: PathBuf,
    cowork_root: PathBuf,
    sessions_dir: PathBuf,
}

impl Iso {
    fn new(prefix: &str) -> Self {
        let root = std::env::temp_dir().join(format!("cowork-sbx-{prefix}-{}", Uuid::new_v4()));
        let cowork_root = root.join("home").join(".cowork");
        let sessions_dir = cowork_root.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        Self {
            root: canonicalize_sync(&root),
            cowork_root: canonicalize_sync(&cowork_root),
            sessions_dir: canonicalize_sync(&sessions_dir),
        }
    }

    fn options(&self) -> SessionDbOptions {
        SessionDbOptions {
            root_dir: self.cowork_root.clone(),
            sessions_dir: self.sessions_dir.clone(),
            db_path: None,
            busy_timeout_ms: Some(5_000),
        }
    }

    fn set_sandbox_json(&self, session_id: &str, sandbox_json: &str) {
        let conn = Connection::open(self.cowork_root.join("sessions.db")).unwrap();
        let updated = conn
            .execute(
                "UPDATE session_state SET sandbox_json = ?1 WHERE session_id = ?2",
                [sandbox_json, session_id],
            )
            .unwrap();
        assert_eq!(updated, 1);
    }
}

impl Drop for Iso {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn mutation(
    session_id: &str,
    workspace: &str,
    sandbox: Option<SandboxConfig>,
) -> PersistedSessionMutation {
    let now = "2026-04-17T12:00:00.000Z".to_string();
    PersistedSessionMutation {
        session_id: session_id.to_string(),
        event_type: "session.created".to_string(),
        event_ts: Some(now.clone()),
        direction: Some("system".to_string()),
        payload: Some(json!({})),
        snapshot: PersistedSessionSnapshotData {
            session_kind: SessionKind::Root,
            parent_session_id: None,
            role: None,
            mode: None,
            depth: None,
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: None,
            effective_model: None,
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            execution_state: None,
            last_message_preview: None,
            title: format!("Session {session_id}"),
            title_source: SessionTitleSource::Default,
            title_model: None,
            provider: ProviderName::Google,
            model: "gemini-3-flash-preview".to_string(),
            working_directory: workspace.to_string(),
            output_directory: None,
            uploads_directory: None,
            provider_options: None,
            sandbox,
            enable_mcp: false,
            backups_enabled_override: None,
            created_at: now.clone(),
            updated_at: now,
            status: SessionPersistenceStatus::Active,
            has_pending_ask: false,
            has_pending_approval: false,
            system_prompt: "sys".to_string(),
            messages: vec![],
            last_memory_generated_index: None,
            provider_state: None,
            todos: vec![],
            harness_context: None,
            cost_tracker: None,
        },
    }
}

fn cfg(mode: SandboxMode, network: bool, require_backend: bool) -> SandboxConfig {
    SandboxConfig {
        mode,
        network,
        require_backend,
    }
}

#[tokio::test]
async fn legacy_sandbox_without_optional_fields_survives_resume_with_ts_defaults() {
    let iso = Iso::new("legacy-defaults");
    let ws = iso.root.join("project");
    fs::create_dir_all(&ws).unwrap();
    let ws = ws.to_string_lossy().into_owned();

    let cases: &[(&str, &str, Option<SandboxConfig>)] = &[
        (
            "s-read-only",
            r#"{"mode":"read-only"}"#,
            Some(cfg(SandboxMode::ReadOnly, true, false)),
        ),
        (
            "s-ww-no-net",
            r#"{"mode":"workspace-write","network":false}"#,
            Some(cfg(SandboxMode::WorkspaceWrite, false, false)),
        ),
        (
            "s-require-backend-only",
            r#"{"mode":"read-only","requireBackend":true}"#,
            Some(cfg(SandboxMode::ReadOnly, true, true)),
        ),
        (
            "s-full",
            r#"{"mode":"auto","network":false,"requireBackend":true}"#,
            Some(cfg(SandboxMode::Auto, false, true)),
        ),
        // JSON null is "no stored policy" (the workspace defaults apply).
        ("s-null", "null", None),
        // Unparseable policies fail closed instead of widening to the workspace defaults.
        (
            "s-unknown-mode",
            r#"{"mode":"yolo"}"#,
            Some(cfg(SandboxMode::ReadOnly, false, true)),
        ),
        (
            "s-missing-mode",
            r#"{"network":true}"#,
            Some(cfg(SandboxMode::ReadOnly, false, true)),
        ),
        (
            "s-bad-type",
            r#"{"mode":"workspace-write","network":"yes"}"#,
            Some(cfg(SandboxMode::ReadOnly, false, true)),
        ),
        (
            "s-malformed",
            "{not json",
            Some(cfg(SandboxMode::ReadOnly, false, true)),
        ),
    ];

    let db = SessionDb::open(iso.options()).await.unwrap();
    for (id, _, _) in cases {
        db.persist_session_mutation(mutation(id, &ws, None))
            .await
            .unwrap();
    }
    db.close();
    for (id, raw, _) in cases {
        iso.set_sandbox_json(id, raw);
    }

    // Reopen (server restart) and load the records a resume would use.
    let db = SessionDb::open(iso.options()).await.unwrap();
    for (id, raw, expected) in cases {
        let rec = db.get_session_record(id).unwrap().expect("record loads");
        assert_eq!(&rec.sandbox, expected, "{id}: stored {raw}");
    }

    // Re-persisting the resumed session keeps the saved read-only policy (now explicit).
    let resumed = db.get_session_record("s-read-only").unwrap().unwrap();
    db.persist_session_mutation(mutation("s-read-only", &ws, resumed.sandbox.clone()))
        .await
        .unwrap();
    assert_eq!(
        db.get_session_record("s-read-only")
            .unwrap()
            .unwrap()
            .sandbox,
        Some(cfg(SandboxMode::ReadOnly, true, false))
    );
    db.close();
}

#[tokio::test]
async fn legacy_v7_json_import_keeps_partial_sandbox_policy() {
    let iso = Iso::new("legacy-import");
    let legacy = json!({
        "version": 7,
        "sessionId": "legacy-ro",
        "createdAt": "2026-01-10T10:00:00.000Z",
        "updatedAt": "2026-01-10T10:05:00.000Z",
        "session": {
            "title": "Legacy read-only",
            "titleSource": "manual",
            "titleModel": null,
            "provider": "openai",
            "model": "gpt-5.4",
            "sessionKind": "root",
            "parentSessionId": null,
            "role": null,
            "mode": null,
            "depth": null,
            "nickname": null,
            "taskType": null,
            "targetPaths": null,
            "profile": null,
            "requestedModel": null,
            "effectiveModel": "gpt-5.4",
            "requestedReasoningEffort": null,
            "effectiveReasoningEffort": null,
            "executionState": "completed",
            "lastMessagePreview": null
        },
        "config": {
            "workingDirectory": iso.root.to_string_lossy(),
            "enableMcp": true,
            "backupsEnabledOverride": null,
            "sandbox": { "mode": "read-only" }
        },
        "context": {
            "system": "System prompt",
            "messages": [],
            "todos": [],
            "harnessContext": null,
            "providerState": null,
            "costTracker": null,
            "lastMemoryGeneratedIndex": 0
        }
    });
    fs::write(
        iso.sessions_dir.join("legacy-ro.json"),
        serde_json::to_string_pretty(&legacy).unwrap(),
    )
    .unwrap();

    let db = SessionDb::open(iso.options()).await.unwrap();
    let rec = db
        .get_session_record("legacy-ro")
        .unwrap()
        .expect("legacy session imported");
    assert_eq!(rec.sandbox, Some(cfg(SandboxMode::ReadOnly, true, false)));
    db.close();
}
