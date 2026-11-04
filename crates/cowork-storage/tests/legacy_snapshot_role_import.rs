//! Legacy `sessions/*.json` import must normalize legacy agent roles exactly like
//! `parsePersistedSessionSnapshot` (`src/server/sessionStore/snapshots.ts`): versions 3–5 accept
//! `role`/`agentType` from the legacy enum and map them through `normalizeLegacyRole`, while
//! versions 6–7 only accept canonical roles.

use std::fs;
use std::path::PathBuf;

use cowork_config::canonicalize_sync;
use cowork_storage::{SessionDb, SessionDbOptions, import_legacy_snapshots_from_dir};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};
use uuid::Uuid;

struct TempEnv {
    root: PathBuf,
    cowork_root: PathBuf,
    sessions_dir: PathBuf,
}

impl TempEnv {
    fn new(prefix: &str) -> Self {
        let root_base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = root_base.join(format!("cowork-legacy-role-{prefix}-{}", Uuid::new_v4()));
        let cowork_root = root.join("home").join(".cowork");
        let sessions_dir = cowork_root.join("sessions");
        fs::create_dir_all(&sessions_dir).expect("create sessions dir");
        Self {
            root: canonicalize_sync(&root),
            cowork_root: canonicalize_sync(&cowork_root),
            sessions_dir: canonicalize_sync(&sessions_dir),
        }
    }

    fn write_snapshot(&self, snapshot: &Value) {
        let id = snapshot["sessionId"].as_str().expect("sessionId");
        fs::write(
            self.sessions_dir.join(format!("{id}.json")),
            serde_json::to_string_pretty(snapshot).unwrap(),
        )
        .unwrap();
    }

    async fn open(&self) -> SessionDb {
        SessionDb::open(SessionDbOptions {
            root_dir: self.cowork_root.clone(),
            sessions_dir: self.sessions_dir.clone(),
            db_path: None,
            busy_timeout_ms: Some(5_000),
        })
        .await
        .expect("open session db")
    }

    fn role_columns(&self, session_id: &str) -> Option<(Option<String>, Option<String>)> {
        let conn = Connection::open(self.cowork_root.join("sessions.db")).unwrap();
        conn.query_row(
            "SELECT role, agent_type FROM sessions WHERE session_id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap()
    }
}

impl Drop for TempEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A child-agent snapshot of `version` (3–7) with the given `session` role fields merged in.
fn child_snapshot(env: &TempEnv, version: u64, session_id: &str, role_fields: Value) -> Value {
    let mut session = Map::new();
    session.insert("title".into(), json!("Legacy child"));
    session.insert("titleSource".into(), json!("default"));
    session.insert("titleModel".into(), Value::Null);
    session.insert("provider".into(), json!("openai"));
    session.insert("model".into(), json!("gpt-5.4"));
    session.insert("sessionKind".into(), json!("subagent"));
    session.insert("parentSessionId".into(), json!("legacy-parent"));
    if version >= 6 {
        for key in [
            "mode",
            "depth",
            "nickname",
            "requestedModel",
            "requestedReasoningEffort",
            "effectiveReasoningEffort",
            "lastMessagePreview",
        ] {
            session.insert(key.into(), Value::Null);
        }
        session.insert("effectiveModel".into(), json!("gpt-5.4"));
        session.insert("executionState".into(), json!("completed"));
        session.insert("role".into(), Value::Null);
    }
    for (key, value) in role_fields.as_object().expect("role fields object") {
        session.insert(key.clone(), value.clone());
    }

    let mut config = json!({
        "provider": "openai",
        "model": "gpt-5.4",
        "enableMcp": false,
        "workingDirectory": env.root.to_string_lossy(),
    });
    if version >= 5 {
        config["backupsEnabledOverride"] = Value::Null;
    }
    let mut context = json!({
        "system": "sys",
        "messages": [{ "role": "user", "content": "hi" }],
        "todos": [],
        "harnessContext": null,
        "providerState": null,
    });
    if version >= 4 {
        context["costTracker"] = Value::Null;
    }

    json!({
        "version": version,
        "sessionId": session_id,
        "createdAt": "2026-01-10T10:00:00.000Z",
        "updatedAt": "2026-01-10T10:05:00.000Z",
        "session": session,
        "config": config,
        "context": context,
    })
}

#[tokio::test]
async fn legacy_v3_to_v5_agent_roles_are_normalized_on_import() {
    let env = TempEnv::new("normalize");
    // (role fields, expected normalized role) per `normalizeLegacyRole(role, agentType)`.
    let cases: Vec<(&str, Value, Option<&str>)> = vec![
        (
            "agent-type-explore",
            json!({ "agentType": "explore" }),
            Some("explorer"),
        ),
        (
            "role-explore",
            json!({ "role": "explore" }),
            Some("explorer"),
        ),
        (
            "role-null-agent-type-explore",
            json!({ "role": null, "agentType": "explore" }),
            Some("explorer"),
        ),
        (
            "agent-type-general",
            json!({ "agentType": "general" }),
            Some("worker"),
        ),
        ("role-general", json!({ "role": "general" }), Some("worker")),
        (
            "agent-type-research",
            json!({ "agentType": "research" }),
            Some("research"),
        ),
        (
            "role-reviewer",
            json!({ "role": "reviewer" }),
            Some("reviewer"),
        ),
        (
            "canonical-role-wins",
            json!({ "role": "default", "agentType": "explore" }),
            Some("default"),
        ),
        (
            "legacy-role-wins-over-agent-type",
            json!({ "role": "explore", "agentType": "general" }),
            Some("explorer"),
        ),
        // TS quirk preserved: a canonical role only in `agentType` is not a legacy alias.
        (
            "agent-type-explorer",
            json!({ "agentType": "explorer" }),
            None,
        ),
        ("no-role", json!({}), None),
    ];

    let mut expected = Vec::new();
    for version in 3..=5_u64 {
        for (name, fields, role) in &cases {
            let id = format!("v{version}-{name}");
            env.write_snapshot(&child_snapshot(&env, version, &id, fields.clone()));
            expected.push((id, *role));
        }
    }

    let db = env.open().await;
    for (id, role) in &expected {
        let record = db
            .get_session_record(id)
            .unwrap()
            .unwrap_or_else(|| panic!("{id} imported"));
        assert_eq!(record.role.as_deref(), *role, "record role for {id}");
        assert_eq!(
            record.parent_session_id.as_deref(),
            Some("legacy-parent"),
            "{id}"
        );
        let snapshot = db.get_session_snapshot(id).unwrap().expect("snapshot");
        assert_eq!(
            snapshot["role"].as_str(),
            *role,
            "projected snapshot role for {id}"
        );
    }
    db.close();

    for (id, role) in &expected {
        let (role_col, agent_type_col) = env.role_columns(id).expect("row");
        assert_eq!(role_col.as_deref(), *role, "role column for {id}");
        assert_eq!(agent_type_col, None, "agent_type column for {id}");
    }
}

#[tokio::test]
async fn legacy_snapshots_with_roles_outside_their_version_schema_are_skipped() {
    let env = TempEnv::new("reject");
    let rejected = [
        // v3–5 only accept the legacy enum (canonical roles plus `general`/`explore`).
        child_snapshot(&env, 3, "v3-bogus-role", json!({ "role": "bogus" })),
        child_snapshot(
            &env,
            4,
            "v4-bogus-agent-type",
            json!({ "agentType": "bogus" }),
        ),
        child_snapshot(&env, 5, "v5-non-string-role", json!({ "role": 7 })),
        // v6–7 only accept canonical roles.
        child_snapshot(&env, 6, "v6-role-explore", json!({ "role": "explore" })),
        child_snapshot(&env, 7, "v7-role-general", json!({ "role": "general" })),
    ];
    for snapshot in &rejected {
        env.write_snapshot(snapshot);
    }
    env.write_snapshot(&child_snapshot(
        &env,
        6,
        "v6-role-explorer",
        json!({ "role": "explorer" }),
    ));

    let db = env.open().await;
    for snapshot in &rejected {
        let id = snapshot["sessionId"].as_str().unwrap();
        assert!(
            db.get_session_record(id).unwrap().is_none(),
            "{id} must be skipped like parsePersistedSessionSnapshot rejects it"
        );
    }
    let accepted = db
        .get_session_record("v6-role-explorer")
        .unwrap()
        .expect("canonical v6 role imported");
    assert_eq!(accepted.role.as_deref(), Some("explorer"));
    db.close();
}

#[tokio::test]
async fn reimport_overwrites_stale_legacy_agent_type_column() {
    let env = TempEnv::new("reimport");
    env.write_snapshot(&child_snapshot(&env, 4, "v4-no-role", json!({})));
    env.write_snapshot(&child_snapshot(
        &env,
        4,
        "v4-agent-type-explore",
        json!({ "agentType": "explore" }),
    ));
    let db = env.open().await;
    db.close();

    // Pre-existing rows carrying a raw legacy `agent_type` (which reads fall back to when `role`
    // is NULL) are overwritten on re-import, like `agent_type = excluded.agent_type` in TS.
    let mut conn = Connection::open(env.cowork_root.join("sessions.db")).unwrap();
    conn.execute(
        "UPDATE sessions SET role = NULL, agent_type = 'general'",
        [],
    )
    .unwrap();
    import_legacy_snapshots_from_dir(&mut conn, &env.sessions_dir).unwrap();
    drop(conn);

    assert_eq!(env.role_columns("v4-no-role").unwrap(), (None, None));
    assert_eq!(
        env.role_columns("v4-agent-type-explore").unwrap(),
        (Some("explorer".to_string()), None)
    );
    let db = env.open().await;
    assert_eq!(
        db.get_session_record("v4-no-role").unwrap().unwrap().role,
        None
    );
    assert_eq!(
        db.get_session_record("v4-agent-type-explore")
            .unwrap()
            .unwrap()
            .role
            .as_deref(),
        Some("explorer")
    );
    db.close();
}
