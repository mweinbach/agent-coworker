use std::fs;
use std::path::Path;

use cowork_config::ProviderName;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::Result;
use crate::session_db::read_session_record_from_conn;
use crate::types::{PersistedSessionRecord, SessionKind, SessionTitleSource};

/// Imports legacy `sessions/*.json` snapshots (versions `1..=7`) idempotently during migration `2`.
/// Corrupt or schema-incompatible files are skipped without aborting startup.
pub fn import_legacy_snapshots_from_dir(conn: &mut Connection, sessions_dir: &Path) -> Result<()> {
    let entries = match fs::read_dir(sessions_dir) {
        Ok(dir) => dir,
        Err(_) => return Ok(()),
    };

    let mut json_paths: Vec<_> = entries
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .collect();
    json_paths.sort();

    for path in json_paths {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(legacy) = parse_legacy_snapshot(&parsed) else {
            continue;
        };
        let _ = import_single_legacy_snapshot(conn, &legacy);
    }

    Ok(())
}

struct ParsedLegacySnapshot {
    version: u64,
    session_id: String,
    created_at: String,
    updated_at: String,
    title: String,
    title_source: SessionTitleSource,
    title_model: Option<String>,
    provider: ProviderName,
    model: String,
    session_kind: SessionKind,
    parent_session_id: Option<String>,
    role: Option<String>,
    mode: Option<String>,
    depth: Option<i64>,
    nickname: Option<String>,
    task_type: Option<String>,
    target_paths_json: Option<String>,
    agent_profile_json: Option<String>,
    requested_model: Option<String>,
    effective_model: Option<String>,
    requested_reasoning_effort: Option<String>,
    effective_reasoning_effort: Option<String>,
    execution_state: Option<String>,
    last_message_preview: Option<String>,
    working_directory: String,
    output_directory: Option<String>,
    uploads_directory: Option<String>,
    enable_mcp: bool,
    backups_enabled_override: Option<bool>,
    provider_options_json: Option<String>,
    sandbox_json: Option<String>,
    system_prompt: String,
    messages: Vec<Value>,
    todos: Vec<Value>,
    harness_context: Option<Value>,
    provider_state_json: Option<String>,
    cost_tracker_json: Option<String>,
    last_memory_generated_index: usize,
    workflow_runs: Vec<Value>,
}

fn parse_legacy_snapshot(root: &Value) -> Option<ParsedLegacySnapshot> {
    let obj = root.as_object()?;
    let version = obj.get("version")?.as_u64()?;
    if !(1..=7).contains(&version) {
        return None;
    }

    let session_id = non_empty_str(obj.get("sessionId")?)?;
    let created_at = non_empty_str(obj.get("createdAt")?)?;
    let updated_at = non_empty_str(obj.get("updatedAt")?)?;

    let session = obj.get("session")?.as_object()?;
    let config = obj.get("config")?.as_object()?;
    let context = obj.get("context")?.as_object()?;

    let title = session.get("title")?.as_str()?.to_string();
    let title_source = session
        .get("titleSource")
        .and_then(|v| v.as_str())
        .map(SessionTitleSource::from_db)
        .unwrap_or(SessionTitleSource::Default);
    let title_model = opt_string(session.get("titleModel"));

    let provider_str = session.get("provider")?.as_str()?;
    let provider = ProviderName::parse(provider_str)?;
    let model = non_empty_str(session.get("model")?)?;

    let has_subagent = version >= 3;
    let has_exec = version >= 6;

    let session_kind = if has_subagent {
        session
            .get("sessionKind")
            .and_then(|v| v.as_str())
            .map(SessionKind::from_db)
            .unwrap_or(SessionKind::Root)
    } else {
        SessionKind::Root
    };
    let parent_session_id = if has_subagent {
        opt_string(session.get("parentSessionId"))
    } else {
        None
    };
    let role = if has_subagent {
        opt_string(session.get("role"))
    } else {
        None
    };

    let mode = if has_exec {
        opt_string(session.get("mode"))
    } else {
        None
    };
    let depth = if has_exec {
        session.get("depth").and_then(|v| v.as_i64())
    } else {
        None
    };
    let nickname = if has_exec {
        opt_string(session.get("nickname"))
    } else {
        None
    };
    let task_type = if has_exec {
        opt_string(session.get("taskType"))
    } else {
        None
    };
    let target_paths_json = if has_exec {
        session
            .get("targetPaths")
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::to_string(v).ok())
    } else {
        None
    };
    let agent_profile_json = if version == 7 {
        session
            .get("profile")
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::to_string(v).ok())
    } else {
        None
    };
    let requested_model = if has_exec {
        opt_string(session.get("requestedModel"))
    } else {
        None
    };
    let effective_model = if has_exec {
        opt_string(session.get("effectiveModel")).or_else(|| Some(model.clone()))
    } else {
        Some(model.clone())
    };
    let requested_reasoning_effort = if has_exec {
        opt_string(session.get("requestedReasoningEffort"))
    } else {
        None
    };
    let effective_reasoning_effort = if has_exec {
        opt_string(session.get("effectiveReasoningEffort"))
    } else {
        None
    };
    let execution_state = if has_exec {
        opt_string(session.get("executionState"))
    } else {
        None
    };
    let last_message_preview = if has_exec {
        opt_string(session.get("lastMessagePreview"))
    } else {
        None
    };

    let working_directory = non_empty_str(config.get("workingDirectory")?)?;
    let output_directory = opt_string(config.get("outputDirectory"));
    let uploads_directory = opt_string(config.get("uploadsDirectory"));
    let enable_mcp = config
        .get("enableMcp")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let backups_enabled_override = if version >= 5 {
        config
            .get("backupsEnabledOverride")
            .and_then(|v| v.as_bool())
    } else {
        None
    };
    let provider_options_json = if version == 7 {
        config
            .get("providerOptions")
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::to_string(v).ok())
    } else {
        None
    };
    let sandbox_json = if version == 7 {
        config
            .get("sandbox")
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::to_string(v).ok())
    } else {
        None
    };

    let system_prompt = context
        .get("system")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let messages = context.get("messages")?.as_array()?.clone();
    let todos = context
        .get("todos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let harness_context = context
        .get("harnessContext")
        .cloned()
        .filter(|v| !v.is_null());
    let provider_state_json = context
        .get("providerState")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());
    let cost_tracker_json = context
        .get("costTracker")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok());
    let last_memory_generated_index = if version == 7 {
        context
            .get("lastMemoryGeneratedIndex")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).min(messages.len()))
            .unwrap_or(messages.len())
    } else {
        messages.len()
    };
    let workflow_runs = if version == 7 {
        context
            .get("workflowRuns")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Some(ParsedLegacySnapshot {
        version,
        session_id,
        created_at,
        updated_at,
        title,
        title_source,
        title_model,
        provider,
        model,
        session_kind,
        parent_session_id,
        role,
        mode,
        depth,
        nickname,
        task_type,
        target_paths_json,
        agent_profile_json,
        requested_model,
        effective_model,
        requested_reasoning_effort,
        effective_reasoning_effort,
        execution_state,
        last_message_preview,
        working_directory,
        output_directory,
        uploads_directory,
        enable_mcp,
        backups_enabled_override,
        provider_options_json,
        sandbox_json,
        system_prompt,
        messages,
        todos,
        harness_context,
        provider_state_json,
        cost_tracker_json,
        last_memory_generated_index,
        workflow_runs,
    })
}

fn import_single_legacy_snapshot(
    conn: &mut Connection,
    legacy: &ParsedLegacySnapshot,
) -> Result<()> {
    let tx = conn.transaction()?;
    let existing: Option<(String, i64, i64, i64)> = tx
        .query_row(
            "SELECT status, has_pending_ask, has_pending_approval, last_event_seq
             FROM sessions WHERE session_id = ?1",
            params![legacy.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;

    let (status, has_pending_ask, has_pending_approval, last_event_seq) = match existing {
        Some((st, ask, appr, seq)) => (st, ask, appr, seq.max(1)),
        None => ("active".to_string(), 0, 0, 1),
    };

    let execution_state = legacy.execution_state.clone().unwrap_or_else(|| {
        if status == "closed" {
            "closed".to_string()
        } else {
            "completed".to_string()
        }
    });

    tx.execute(
        "INSERT INTO sessions (
           session_id, session_kind, parent_session_id, role, agent_type, mode, depth,
           nickname, task_type, target_paths_json, agent_profile_json, requested_model,
           effective_model, requested_reasoning_effort, effective_reasoning_effort,
           execution_state, last_message_preview, title, title_source, title_model,
           provider, model, working_directory, output_directory, uploads_directory,
           enable_mcp, backups_enabled_override, created_at, updated_at, status,
           has_pending_ask, has_pending_approval, message_count, last_event_seq
         ) VALUES (
           ?1, ?2, ?3, ?4, NULL, ?5, ?6,
           ?7, ?8, ?9, ?10, ?11,
           ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19,
           ?20, ?21, ?22, ?23, ?24,
           ?25, ?26, ?27, ?28, ?29,
           ?30, ?31, ?32, ?33
         )
         ON CONFLICT(session_id) DO UPDATE SET
           session_kind = excluded.session_kind,
           parent_session_id = excluded.parent_session_id,
           role = excluded.role,
           mode = excluded.mode,
           depth = excluded.depth,
           nickname = excluded.nickname,
           task_type = excluded.task_type,
           target_paths_json = excluded.target_paths_json,
           agent_profile_json = excluded.agent_profile_json,
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
           END",
        params![
            legacy.session_id,
            legacy.session_kind.as_str(),
            legacy.parent_session_id,
            legacy.role,
            legacy.mode,
            legacy.depth,
            legacy.nickname,
            legacy.task_type,
            legacy.target_paths_json,
            legacy.agent_profile_json,
            legacy.requested_model,
            legacy.effective_model,
            legacy.requested_reasoning_effort,
            legacy.effective_reasoning_effort,
            execution_state,
            legacy.last_message_preview,
            legacy.title,
            legacy.title_source.as_str(),
            legacy.title_model,
            legacy.provider.as_str(),
            legacy.model,
            legacy.working_directory,
            legacy.output_directory,
            legacy.uploads_directory,
            if legacy.enable_mcp { 1_i64 } else { 0_i64 },
            legacy
                .backups_enabled_override
                .map(|b| if b { 1_i64 } else { 0_i64 }),
            legacy.created_at,
            legacy.updated_at,
            status,
            has_pending_ask,
            has_pending_approval,
            legacy.messages.len() as i64,
            last_event_seq,
        ],
    )?;

    let messages_json = serde_json::to_string(&legacy.messages)?;
    let todos_json = serde_json::to_string(&legacy.todos)?;
    let harness_context_json = serde_json::to_string(&legacy.harness_context)?;

    tx.execute(
        "INSERT INTO session_state (
           session_id, system_prompt, messages_json, last_memory_generated_index,
           provider_state_json, provider_options_json, sandbox_json, todos_json,
           harness_context_json, cost_tracker_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(session_id) DO UPDATE SET
           system_prompt = excluded.system_prompt,
           messages_json = excluded.messages_json,
           last_memory_generated_index = excluded.last_memory_generated_index,
           provider_state_json = excluded.provider_state_json,
           provider_options_json = excluded.provider_options_json,
           sandbox_json = excluded.sandbox_json,
           todos_json = excluded.todos_json,
           harness_context_json = excluded.harness_context_json,
           cost_tracker_json = excluded.cost_tracker_json",
        params![
            legacy.session_id,
            legacy.system_prompt,
            messages_json,
            legacy.last_memory_generated_index as i64,
            legacy.provider_state_json,
            legacy.provider_options_json,
            legacy.sandbox_json,
            todos_json,
            harness_context_json,
            legacy.cost_tracker_json,
        ],
    )?;

    if let Some(record) = read_session_record_from_conn(&tx, &legacy.session_id)? {
        let mut projected = create_legacy_session_snapshot(&record);
        if let Some(obj) = projected.as_object_mut() {
            obj.insert(
                "workflowRuns".to_string(),
                Value::Array(legacy.workflow_runs.clone()),
            );
        }
        let snapshot_json = serde_json::to_string(&projected)?;
        tx.execute(
            "INSERT INTO session_snapshots (session_id, updated_at, snapshot_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
               updated_at = excluded.updated_at,
               snapshot_json = excluded.snapshot_json",
            params![legacy.session_id, legacy.updated_at, snapshot_json],
        )?;
    }

    let event_payload = serde_json::to_string(&json!({ "version": legacy.version }))?;
    tx.execute(
        "INSERT OR IGNORE INTO session_events (
           session_id, seq, ts, direction, event_type, payload_json
         ) VALUES (?1, 1, ?2, 'server', 'legacy_import_snapshot', ?3)",
        params![legacy.session_id, legacy.updated_at, event_payload],
    )?;

    tx.commit()?;
    Ok(())
}

/// Projects a `PersistedSessionRecord` into a JSON `SessionSnapshot` matching
/// `createLegacySessionSnapshot` in `src/server/session/SessionSnapshotProjector.ts`.
pub fn create_legacy_session_snapshot(record: &PersistedSessionRecord) -> Value {
    let mut feed = Vec::new();
    for msg in &record.messages {
        let Some(role) = msg.get("role").and_then(|v| v.as_str()) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = extract_message_text(msg.get("content"));
        if text.is_empty() {
            continue;
        }
        feed.push(json!({
            "id": Uuid::new_v4().to_string(),
            "kind": "message",
            "role": role,
            "ts": record.updated_at,
            "text": text,
        }));
    }
    if !record.todos.is_empty() {
        feed.push(json!({
            "id": Uuid::new_v4().to_string(),
            "kind": "todos",
            "ts": record.updated_at,
            "todos": record.todos,
        }));
    }

    let last_turn_usage = record
        .cost_tracker
        .as_ref()
        .and_then(|ct| ct.get("turns"))
        .and_then(|t| t.as_array())
        .and_then(|turns| turns.last())
        .and_then(|last| {
            let turn_id = last.get("turnId")?.as_str()?;
            let mut usage = last.get("usage")?.clone();
            if let Some(cost) = last.get("estimatedCostUsd").filter(|v| !v.is_null())
                && let Some(uobj) = usage.as_object_mut()
            {
                uobj.insert("estimatedCostUsd".to_string(), cost.clone());
            }
            Some(json!({
                "turnId": turn_id,
                "usage": usage,
            }))
        });

    json!({
        "sessionId": record.session_id,
        "title": record.title,
        "titleSource": record.title_source.as_str(),
        "titleModel": record.title_model,
        "provider": record.provider.as_str(),
        "model": record.model,
        "sessionKind": record.session_kind.as_str(),
        "parentSessionId": record.parent_session_id,
        "role": record.role,
        "mode": record.mode,
        "depth": record.depth,
        "nickname": record.nickname,
        "taskType": record.task_type,
        "targetPaths": record.target_paths,
        "profile": record.profile,
        "requestedModel": record.requested_model,
        "effectiveModel": record.effective_model,
        "requestedReasoningEffort": record.requested_reasoning_effort,
        "effectiveReasoningEffort": record.effective_reasoning_effort,
        "executionState": record.execution_state.map(|s| s.as_str()),
        "lastMessagePreview": record.last_message_preview,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "messageCount": record.message_count,
        "lastEventSeq": record.last_event_seq,
        "feed": feed,
        "agents": [],
        "workflowRuns": [],
        "todos": record.todos,
        "sessionUsage": record.cost_tracker,
        "lastTurnUsage": last_turn_usage,
        "hasPendingAsk": record.has_pending_ask,
        "hasPendingApproval": record.has_pending_approval,
    })
}

fn extract_message_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for part in arr {
            if let Some(text) = part.get("text").and_then(|v| v.as_str())
                && !text.is_empty()
            {
                parts.push(text);
            }
        }
        return parts.join("\n");
    }
    String::new()
}

fn non_empty_str(val: &Value) -> Option<String> {
    let s = val.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn opt_string(val: Option<&Value>) -> Option<String> {
    val.and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}
