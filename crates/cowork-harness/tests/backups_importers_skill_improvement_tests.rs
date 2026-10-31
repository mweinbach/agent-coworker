use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_config::{
    AgentConfig, LoadConfigOptions, SkillImprovementScope, canonicalize_sync, load_config,
};
use cowork_harness::backups::{
    BackupLifecycle, BackupStatus, BackupTrigger, DeltaChangeKind, DeltaEntryKind,
    SessionLookupMetadata, WorkspaceBackupManager, extract_snapshot_tar_gz_confined,
    validate_contained_relative_path,
};
use cowork_harness::extensions::ExtensionManager;
use cowork_harness::importers::{
    ConversationImportRunInput, ConversationImportService, ConversationImportSource,
    ConversationSourceRequest, ConversationSourceSelectionOptions,
    ConversationWorkspaceMappingInput, EnsuredWorkspaceOutcome, ExternalImportSource,
    ImportableKind, KnownWorkspaceEntry, SelectedConversationInput, import_external_plugin,
    import_external_skill, list_importable, redact_provider_continuation_tokens,
};
use cowork_harness::skill_improvement::{
    CompletedTurnSkillUsage, CompletedTurnSkillUsageInput, ConfinedSkillDirectoryEditor,
    SkillImprovementService, SkillImprovementServiceDeps, SkillImproverRunInput,
    SkillImproverRunResult, SkillImproverRunner,
};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb, SessionDbOptions,
    SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use flate2::Compression;
use flate2::write::GzEncoder;
use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create tempdir in /private/tmp");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

fn setup_env_and_config(
    base: &Path,
    home: &Path,
    ws: &Path,
    extra_env: HashMap<String, String>,
) -> (AgentConfig, HashMap<String, String>) {
    let cowork_home = home.join(".cowork");
    fs::create_dir_all(cowork_home.join("config")).unwrap();
    fs::create_dir_all(ws.join(".cowork/skills")).unwrap();
    let builtin = base.join("builtin");
    fs::create_dir_all(builtin.join("skills/presentations")).unwrap();
    fs::write(
        builtin.join("skills/presentations/SKILL.md"),
        "---\nname: presentations\ndescription: Built-in slide authoring skill\n---\nOriginal builtin guidance.\n",
    )
    .unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        cowork_home.to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.extend(extra_env);

    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.to_path_buf()),
        homedir: Some(home.to_path_buf()),
        built_in_dir: Some(builtin),
        env: Some(env.clone()),
    })
    .unwrap();
    (cfg, env)
}

#[test]
fn workspace_backups_lifecycle_delta_restore_and_tar_confinement() {
    let (_guard, base) = canonical_temp_dir("cowork-backups-test-");
    let cowork_home = base.join("home/.cowork");
    let fallback_tmp = base.join("tmp-backups");
    let ws = base.join("workspace");
    fs::create_dir_all(&cowork_home).unwrap();
    fs::create_dir_all(&fallback_tmp).unwrap();
    fs::create_dir_all(ws.join("src")).unwrap();

    fs::write(ws.join("README.md"), "# Initial Workspace\n").unwrap();
    fs::write(ws.join("src/app.txt"), "v1\n").unwrap();
    // Internal scratchpad must be excluded from backups and preserved on restore.
    fs::create_dir_all(ws.join(".ModelScratchpad")).unwrap();
    fs::write(ws.join(".ModelScratchpad/scratch.txt"), "keep-me").unwrap();

    let mgr = WorkspaceBackupManager::with_fallback_root(cowork_home.clone(), fallback_tmp);

    // 1. Initial backup creates initial checkpoint.
    let init_state = mgr
        .ensure_initial_backup(
            "sess-1",
            &ws,
            Some("My Session".to_owned()),
            Some("openai".to_owned()),
            Some("gpt-5".to_owned()),
        )
        .expect("ensure initial backup");
    assert_eq!(init_state.status, BackupStatus::Ready);
    assert_eq!(init_state.checkpoints.len(), 1);
    assert_eq!(init_state.checkpoints[0].id, "cp-0001");
    assert_eq!(init_state.checkpoints[0].trigger, BackupTrigger::Initial);

    // 2. Unchanged workspace manual checkpoint records `changed: false` and `patch_bytes: 0` without writing a duplicate archive.
    let unchanged = mgr
        .create_checkpoint("sess-1", &ws, BackupTrigger::Manual, None, None, None)
        .expect("create unchanged checkpoint")
        .expect("state");
    assert_eq!(unchanged.checkpoints.len(), 2);
    assert!(!unchanged.checkpoints[1].changed);
    assert_eq!(unchanged.checkpoints[1].patch_bytes, 0);

    // 3. Modify, add, and delete files in workspace, then inspect delta vs "original".
    fs::write(ws.join("src/app.txt"), "v2-updated\n").unwrap();
    fs::write(ws.join("added.bin"), [0x00, 0xff, 0x10, 0x20]).unwrap();
    fs::remove_file(ws.join("README.md")).unwrap();

    let delta = mgr
        .read_workspace_backup_delta(&ws, "sess-1", "original", Some("sess-1".to_owned()))
        .expect("read delta");
    assert_eq!(delta.event_type, "workspace_backup_delta");
    assert_eq!(delta.counts.added, 1);
    assert_eq!(delta.counts.modified, 1);
    assert_eq!(delta.counts.deleted, 1);

    let added_entry = delta
        .files
        .iter()
        .find(|f| f.path == "added.bin")
        .expect("added.bin in delta");
    assert_eq!(added_entry.change, DeltaChangeKind::Added);
    assert_eq!(added_entry.kind, DeltaEntryKind::File);

    // 4. Create manual checkpoint for v2 state.
    let cp2_state = mgr
        .create_checkpoint("sess-1", &ws, BackupTrigger::Manual, None, None, None)
        .expect("create manual checkpoint")
        .expect("state");
    assert_eq!(cp2_state.checkpoints.len(), 3);
    assert!(cp2_state.checkpoints[2].changed);
    let cp2_id = cp2_state.checkpoints[2].id.clone();

    // 5. Make dirty unstaged edit ("v3-dirty") and restore back to "initial".
    // Restore must create a pre-restore safety manual checkpoint so v3-dirty is recoverable!
    fs::write(ws.join("src/app.txt"), "v3-dirty\n").unwrap();
    let lookup = |sid: &str| SessionLookupMetadata {
        lifecycle: if sid == "sess-1" {
            BackupLifecycle::Active
        } else {
            BackupLifecycle::Closed
        },
        busy: false,
        title: Some("My Session".to_owned()),
        provider: Some("openai".to_owned()),
        model: Some("gpt-5".to_owned()),
    };

    let (restored_event, restored_state) = mgr
        .restore_workspace_backup(
            &ws,
            "sess-1",
            Some("original"),
            Some("sess-1".to_owned()),
            lookup,
        )
        .expect("restore original");
    assert_eq!(
        fs::read_to_string(ws.join("README.md")).unwrap(),
        "# Initial Workspace\n"
    );
    assert_eq!(fs::read_to_string(ws.join("src/app.txt")).unwrap(), "v1\n");
    assert!(!ws.join("added.bin").exists());
    // Preserved internal scratchpad!
    assert_eq!(
        fs::read_to_string(ws.join(".ModelScratchpad/scratch.txt")).unwrap(),
        "keep-me"
    );
    // Pre-restore safety checkpoint increased count from 3 -> 4.
    assert_eq!(restored_event.backups.len(), 1);
    assert_eq!(restored_event.backups[0].checkpoints.len(), 4);
    assert_eq!(restored_state.checkpoints.len(), 4);

    // 6. Deleting initial checkpoint ("cp-0001") is rejected; deleting cp2 succeeds.
    let err_init = mgr
        .delete_checkpoint(&ws, "sess-1", "cp-0001", None, lookup)
        .expect_err("cannot delete initial checkpoint");
    assert!(err_init.contains("initial"), "unexpected error: {err_init}");

    let (after_del_cp, _) = mgr
        .delete_checkpoint(&ws, "sess-1", &cp2_id, None, lookup)
        .expect("delete cp2");
    assert_eq!(after_del_cp.backups[0].checkpoints.len(), 3);

    // 7. Delete entire backup entry removes session backup directory cleanly.
    let after_del_entry = mgr
        .delete_entry(&ws, "sess-1", None, lookup)
        .expect("delete entry");
    assert!(after_del_entry.backups.is_empty());

    // 8. Confinement checks: traversal paths & malicious tar entries are rejected.
    assert!(validate_contained_relative_path("../escape.txt").is_err());
    assert!(validate_contained_relative_path("/etc/passwd").is_err());
    assert!(validate_contained_relative_path("C:\\evil.txt").is_err());

    let evil_tar_gz = base.join("evil.tar.gz");
    {
        let file = fs::File::create(&evil_tar_gz).unwrap();
        let enc = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(enc);
        let payload = b"owned";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        let path_bytes = b"../escaped.txt";
        header.as_gnu_mut().unwrap().name[..path_bytes.len()].copy_from_slice(path_bytes);
        header.set_cksum();
        builder.append(&header, &payload[..]).unwrap();
        let enc = builder.into_inner().unwrap();
        enc.finish().unwrap();
    }
    let extract_target = base.join("extract-target");
    fs::create_dir_all(&extract_target).unwrap();
    let traversal_err = extract_snapshot_tar_gz_confined(&evil_tar_gz, &extract_target)
        .expect_err("must reject tar path traversal");
    assert!(
        !base.join("escaped.txt").exists(),
        "must not write outside destination: {traversal_err}"
    );
}

#[tokio::test]
async fn external_skill_and_claude_plugin_import_convert_safely_without_mutating_source() {
    let (_guard, base) = canonical_temp_dir("cowork-ext-import-");
    let home = base.join("home");
    let ws = base.join("workspace");
    let (cfg, env) = setup_env_and_config(&base, &home, &ws, HashMap::new());
    let ext = ExtensionManager::new(env);

    // Populate Claude Code non-kebab skill (diagnostic check) + Claude Code plugin with `.claude-plugin/plugin.json`.
    let claude_skill_dir = home.join(".claude/skills/Log_Analyzer");
    fs::create_dir_all(&claude_skill_dir).unwrap();
    fs::write(
        claude_skill_dir.join("SKILL.md"),
        "---\nname: Log_Analyzer\ndescription: Analyzes server logs\n---\nInspect structured JSONL logs.\n",
    )
    .unwrap();

    let claude_plugin_cache = home.join(".claude/plugins/cache/acme-tools/1.0.0");
    fs::create_dir_all(claude_plugin_cache.join(".claude-plugin")).unwrap();
    fs::create_dir_all(claude_plugin_cache.join("skills/deploy-check")).unwrap();
    let original_claude_manifest = json!({
        "$schema": "https://example.com/claude-plugin.schema.json",
        "name": "acme-tools",
        "version": "1.0.0",
        "description": "Acme Claude plugin",
        "commands": ["./commands/deploy.md"],
        "agents": ["./agents/reviewer.md"],
        "hooks": { "PreToolUse": [] },
        "mcpServers": "./.mcp.json"
    });
    fs::write(
        claude_plugin_cache.join(".claude-plugin/plugin.json"),
        serde_json::to_string_pretty(&original_claude_manifest).unwrap(),
    )
    .unwrap();
    fs::write(
        claude_plugin_cache.join(".mcp.json"),
        serde_json::to_string_pretty(&json!({
            "mcpServers": {
                "acme-local": { "command": "echo", "args": ["hello"] }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        claude_plugin_cache.join("skills/deploy-check/SKILL.md"),
        "---\nname: deploy-check\ndescription: Checks deployment readiness\n---\nVerify checklist.\n",
    )
    .unwrap();
    fs::create_dir_all(home.join(".claude/plugins")).unwrap();
    fs::write(
        home.join(".claude/plugins/installed_plugins.json"),
        serde_json::to_string_pretty(&json!({
            "version": 2,
            "plugins": {
                "acme-tools@market": [
                    { "installPath": claude_plugin_cache.to_string_lossy() }
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    // Populate Codex skill in `~/.codex/skills`.
    let codex_skill_dir = home.join(".codex/skills/sql-helper");
    fs::create_dir_all(&codex_skill_dir).unwrap();
    fs::write(
        codex_skill_dir.join("SKILL.md"),
        "---\nname: sql-helper\ndescription: Writes safe SQL queries\n---\nUse parameterized queries.\n",
    )
    .unwrap();

    let claude_plugins = list_importable(
        &ext,
        &cfg,
        ExternalImportSource::Claude,
        ImportableKind::Plugin,
        Some("s-import".to_owned()),
        None,
    );
    assert_eq!(claude_plugins.event_type, "import_list");
    let plugin_item = claude_plugins
        .items
        .iter()
        .find(|i| i.id == "acme-tools")
        .expect("acme-tools plugin discovered");
    assert_eq!(plugin_item.conversion_required, Some(true));

    let codex_skills = list_importable(
        &ext,
        &cfg,
        ExternalImportSource::Codex,
        ImportableKind::Skill,
        Some("s-import".to_owned()),
        None,
    );
    assert!(
        codex_skills.items.iter().any(|i| i.id == "sql-helper"),
        "expected sql-helper skill in {:?}",
        codex_skills.items
    );

    let claude_skills = list_importable(
        &ext,
        &cfg,
        ExternalImportSource::Claude,
        ImportableKind::Skill,
        None,
        None,
    );
    let bad_slug_skill = claude_skills
        .items
        .iter()
        .find(|i| i.display_name == "Log_Analyzer" || i.id == "Log_Analyzer")
        .expect("discovered non-kebab skill with diagnostic");
    assert!(!bad_slug_skill.diagnostics.is_empty());

    // Import Claude plugin into workspace scope and verify conversion + source immutability.
    let plugin_snap = import_external_plugin(
        &ext,
        &cfg,
        Path::new(&plugin_item.source_path),
        plugin_item.conversion_required.unwrap_or(false),
        "workspace",
    )
    .await
    .expect("import external claude plugin");
    assert!(
        plugin_snap.plugins.iter().any(|p| p.name == "acme-tools"),
        "installed plugin must appear in catalog"
    );
    // Source `.claude-plugin/plugin.json` MUST remain untouched!
    assert!(
        claude_plugin_cache
            .join(".claude-plugin/plugin.json")
            .is_file()
    );
    assert!(!claude_plugin_cache.join(".cowork-plugin").exists());
    // Installed plugin has `.cowork-plugin/plugin.json` without `commands`/`agents`/`hooks`/`$schema`.
    let installed_manifest_raw =
        fs::read_to_string(ws.join(".cowork/plugins/acme-tools/.cowork-plugin/plugin.json"))
            .expect("installed converted plugin.json");
    let installed_manifest: serde_json::Value =
        serde_json::from_str(&installed_manifest_raw).unwrap();
    assert!(installed_manifest.get("commands").is_none());
    assert!(installed_manifest.get("agents").is_none());
    assert!(installed_manifest.get("hooks").is_none());
    assert!(installed_manifest.get("$schema").is_none());
    assert_eq!(
        installed_manifest
            .get("mcpServers")
            .and_then(|v| v.as_str()),
        Some("./.mcp.json")
    );

    // Import Codex skill into user scope.
    let skill_snap = import_external_skill(&ext, &cfg, &codex_skill_dir, "user")
        .await
        .expect("import codex skill");
    assert!(
        skill_snap
            .installations
            .iter()
            .any(|s| s.name == "sql-helper" && s.scope == "global")
    );
    assert!(home.join(".cowork/skills/sql-helper/SKILL.md").is_file());
}

#[tokio::test]
async fn conversation_importer_discovers_previews_redacts_dedupes_and_blocks_self_import() {
    let (_guard, base) = canonical_temp_dir("cowork-conv-import-");
    let home = base.join("home");
    let ws = base.join("workspace");
    let mapped_ws = base.join("mapped-workspace");
    fs::create_dir_all(&mapped_ws).unwrap();
    let (cfg, _env) = setup_env_and_config(&base, &home, &ws, HashMap::new());

    // Target SessionDb for current Cowork instance.
    let target_cowork_home = home.join(".cowork");
    let target_db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: target_cowork_home.clone(),
            sessions_dir: target_cowork_home.join("sessions"),
            db_path: None,
            busy_timeout_ms: None,
        })
        .await
        .expect("open target session db"),
    );

    // 1. Seed Codex source (`~/.codex/state_5.sqlite` + rollout jsonl with secret continuation tokens).
    let codex_home = home.join(".codex");
    let rollout_dir = codex_home.join("sessions/2026/03/15");
    fs::create_dir_all(&rollout_dir).unwrap();
    let rollout_path = rollout_dir.join("rollout-thread-codex-1.jsonl");
    let long_b64 = "A".repeat(180);
    let rollout_lines = [
        json!({
            "timestamp": "2026-03-15T10:00:00.000Z",
            "type": "session_meta",
            "payload": {
                "id": "thread-codex-1",
                "cwd": ws.to_string_lossy(),
                "model_provider": "openai",
                "model": "gpt-5"
            }
        }),
        json!({
            "timestamp": "2026-03-15T10:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "Fix the parser bug please." }]
            }
        }),
        json!({
            "timestamp": "2026-03-15T10:00:02.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": "call_secret123456",
                "name": "bash",
                "arguments": "{\"command\":\"cargo test\"}"
            }
        }),
        json!({
            "timestamp": "2026-03-15T10:00:03.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_secret123456",
                "output": format!("ok resp_987654321 gAAAAABk1234567890 {long_b64}")
            }
        }),
        json!({
            "timestamp": "2026-03-15T10:00:04.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Fixed and verified with cargo test." }]
            }
        }),
    ];
    fs::write(
        &rollout_path,
        rollout_lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    {
        let conn = Connection::open(codex_home.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                cwd TEXT,
                title TEXT,
                archived INTEGER DEFAULT 0,
                model_provider TEXT,
                model TEXT
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, archived, model_provider, model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'openai', 'gpt-5')",
            rusqlite::params![
                "thread-codex-1",
                rollout_path.to_string_lossy().as_ref(),
                1_773_568_800_i64,
                1_773_568_804_i64,
                ws.to_string_lossy().as_ref(),
                "Parser bug fix",
            ],
        )
        .unwrap();
    }

    // 2. Seed Claude Code source (`~/.claude/projects/proj-a/claude-sess-1.jsonl`).
    let claude_proj_dir = home.join(".claude/projects/proj-a");
    fs::create_dir_all(&claude_proj_dir).unwrap();
    let missing_orig_cwd = base.join("deleted-old-project");
    let claude_lines = [
        json!({
            "type": "user",
            "sessionId": "claude-sess-1",
            "cwd": missing_orig_cwd.to_string_lossy(),
            "timestamp": "2026-03-16T12:00:00.000Z",
            "message": {
                "role": "user",
                "content": "Summarize the API schema."
            }
        }),
        json!({
            "type": "assistant",
            "sessionId": "claude-sess-1",
            "cwd": missing_orig_cwd.to_string_lossy(),
            "timestamp": "2026-03-16T12:00:05.000Z",
            "message": {
                "role": "assistant",
                "model": "claude-sonnet-4-5",
                "content": [{ "type": "text", "text": "Here is the API schema summary." }]
            }
        }),
    ];
    fs::write(
        claude_proj_dir.join("claude-sess-1.jsonl"),
        claude_lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();

    // 3. Seed an external Cowork `sessions.db` to import from, plus verify self-import guard on target DB.
    let other_cowork_dir = base.join("other-cowork");
    let other_db = SessionDb::open(SessionDbOptions {
        root_dir: other_cowork_dir.clone(),
        sessions_dir: other_cowork_dir.join("sessions"),
        db_path: None,
        busy_timeout_ms: None,
    })
    .await
    .expect("open external cowork db");
    let ext_messages = vec![
        json!({ "role": "user", "content": "Hello from another Cowork profile!" }),
        json!({ "role": "assistant", "content": "Welcome back!" }),
    ];
    other_db
        .persist_session_mutation(PersistedSessionMutation {
            session_id: "ext-cowork-sess-1".to_owned(),
            event_type: "session_created".to_owned(),
            event_ts: Some("2026-03-17T09:01:00.000Z".to_owned()),
            direction: Some("outbound".to_owned()),
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
                last_message_preview: Some("Welcome back!".to_owned()),
                title: "External Cowork Chat".to_owned(),
                title_source: SessionTitleSource::Manual,
                title_model: None,
                provider: cowork_config::ProviderName::Openai,
                model: "gpt-5".to_owned(),
                working_directory: ws.to_string_lossy().into_owned(),
                output_directory: None,
                uploads_directory: None,
                provider_options: None,
                sandbox: Some(cfg.sandbox.clone()),
                enable_mcp: true,
                backups_enabled_override: None,
                created_at: "2026-03-17T09:00:00.000Z".to_owned(),
                updated_at: "2026-03-17T09:01:00.000Z".to_owned(),
                status: SessionPersistenceStatus::Active,
                has_pending_ask: false,
                has_pending_approval: false,
                system_prompt: String::new(),
                messages: ext_messages.clone(),
                last_memory_generated_index: None,
                provider_state: None,
                todos: vec![],
                harness_context: None,
                cost_tracker: None,
            },
        })
        .await
        .expect("seed external cowork session");
    other_db
        .persist_session_snapshot(
            "ext-cowork-sess-1",
            &json!({
                "sessionId": "ext-cowork-sess-1",
                "title": "External Cowork Chat",
                "updatedAt": "2026-03-17T09:01:00.000Z",
                "messages": ext_messages,
                "feed": [
                    {
                        "id": "u1",
                        "type": "user",
                        "content": "Hello from another Cowork profile!",
                        "ts": "2026-03-17T09:00:00.000Z"
                    },
                    {
                        "id": "a1",
                        "type": "assistant",
                        "content": "Welcome back!",
                        "ts": "2026-03-17T09:00:02.000Z"
                    }
                ]
            }),
        )
        .await
        .expect("seed external cowork snapshot");

    let service = ConversationImportService::new(target_db.clone(), home.clone(), None);

    // Self-import check: passing target_db path as cowork source marks it unavailable!
    let self_sources = service.discover_sources(&ConversationSourceSelectionOptions {
        sources: Some(vec![ConversationSourceRequest {
            source: ConversationImportSource::Cowork,
            path: Some(target_db.db_path().to_string_lossy().into_owned()),
        }]),
        ..Default::default()
    });
    assert_eq!(self_sources.len(), 1);
    assert!(!self_sources[0].available);

    // Preview across Codex state_5.sqlite + Claude Code + external Cowork DB.
    let selection = ConversationSourceSelectionOptions {
        sources: Some(vec![
            ConversationSourceRequest {
                source: ConversationImportSource::Codex,
                path: Some(
                    codex_home
                        .join("state_5.sqlite")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            ConversationSourceRequest {
                source: ConversationImportSource::ClaudeCode,
                path: None,
            },
            ConversationSourceRequest {
                source: ConversationImportSource::Cowork,
                path: Some(other_db.db_path().to_string_lossy().into_owned()),
            },
        ]),
        ..Default::default()
    };
    let known_workspaces = vec![KnownWorkspaceEntry {
        id: "ws-main".to_owned(),
        name: "Main Workspace".to_owned(),
        path: ws.to_string_lossy().into_owned(),
    }];

    let preview = service.preview(&selection, Some(50), false, &known_workspaces);
    assert_eq!(preview.conversations.len(), 3);

    let claude_prev = preview
        .conversations
        .iter()
        .find(|c| c.source == ConversationImportSource::ClaudeCode)
        .unwrap();
    let codex_prev = preview
        .conversations
        .iter()
        .find(|c| c.source == ConversationImportSource::Codex)
        .unwrap();
    let cowork_prev = preview
        .conversations
        .iter()
        .find(|c| c.source == ConversationImportSource::Cowork)
        .unwrap();

    // Validate workspace mapping for Claude Code's missing original directory -> `mapped_ws`.
    let mapping_input = ConversationWorkspaceMappingInput::Create {
        path: mapped_ws.to_string_lossy().into_owned(),
        name: Some("Mapped Project".to_owned()),
    };
    let mut mappings_to_validate = BTreeMap::new();
    mappings_to_validate.insert(claude_prev.fingerprint.clone(), mapping_input.clone());
    let validation = service.validate_workspace_mappings(&mappings_to_validate, &known_workspaces);
    assert!(validation.valid, "errors: {:?}", validation.errors);

    // Import all 3 conversations!
    let mut run_mappings = BTreeMap::new();
    run_mappings.insert(claude_prev.fingerprint.clone(), mapping_input);
    let import_res = service
        .import_selected(
            &cfg,
            ConversationImportRunInput {
                selection: selection.clone(),
                selected: vec![
                    SelectedConversationInput {
                        source: ConversationImportSource::Codex,
                        fingerprint: codex_prev.fingerprint.clone(),
                    },
                    SelectedConversationInput {
                        source: ConversationImportSource::ClaudeCode,
                        fingerprint: claude_prev.fingerprint.clone(),
                    },
                    SelectedConversationInput {
                        source: ConversationImportSource::Cowork,
                        fingerprint: cowork_prev.fingerprint.clone(),
                    },
                ],
                mappings: Some(run_mappings.clone()),
                include_archived: Some(false),
                provider: None,
                model: None,
                default_provider: None,
                default_model: None,
            },
            &known_workspaces,
            |target_path, name| {
                Ok(EnsuredWorkspaceOutcome {
                    workspace_id: Some("ws-created-1".to_owned()),
                    workspace_path: target_path.to_owned(),
                    name: name.unwrap_or("Imported").to_owned(),
                    created: target_path == mapped_ws.to_string_lossy(),
                })
            },
        )
        .await;

    assert_eq!(
        import_res.imported.len(),
        3,
        "failed: {:?}",
        import_res.failed
    );
    assert!(import_res.skipped.is_empty());
    assert!(import_res.failed.is_empty());
    assert_eq!(import_res.created_workspaces.len(), 1);

    // Verify `<past_conversation>` handoff text redacted provider continuation tokens!
    let imported_codex = import_res
        .imported
        .iter()
        .find(|i| i.source == ConversationImportSource::Codex)
        .unwrap();
    let persisted_codex = target_db
        .get_session_record(&imported_codex.thread_id)
        .expect("read imported codex session")
        .expect("session exists");
    let messages_str = serde_json::to_string(&persisted_codex.messages).unwrap();
    assert!(messages_str.contains("<past_conversation "));
    assert!(messages_str.contains("</past_conversation>"));
    assert!(!messages_str.contains("call_secret123456"));
    assert!(!messages_str.contains("resp_987654321"));
    assert!(!messages_str.contains("gAAAAABk1234567890"));
    assert!(!messages_str.contains(&long_b64));
    assert!(
        redact_provider_continuation_tokens("id call_abc123456789")
            .contains("[redacted-provider-token]")
    );

    // Re-running the exact same import is idempotent and reports all 3 as `duplicate`!
    let second_res = service
        .import_selected(
            &cfg,
            ConversationImportRunInput {
                selection,
                selected: vec![
                    SelectedConversationInput {
                        source: ConversationImportSource::Codex,
                        fingerprint: codex_prev.fingerprint.clone(),
                    },
                    SelectedConversationInput {
                        source: ConversationImportSource::ClaudeCode,
                        fingerprint: claude_prev.fingerprint.clone(),
                    },
                    SelectedConversationInput {
                        source: ConversationImportSource::Cowork,
                        fingerprint: cowork_prev.fingerprint.clone(),
                    },
                ],
                mappings: Some(run_mappings),
                include_archived: Some(false),
                provider: None,
                model: None,
                default_provider: None,
                default_model: None,
            },
            &known_workspaces,
            |target_path, name| {
                Ok(EnsuredWorkspaceOutcome {
                    workspace_id: Some("ws-created-1".to_owned()),
                    workspace_path: target_path.to_owned(),
                    name: name.unwrap_or("Imported").to_owned(),
                    created: false,
                })
            },
        )
        .await;
    assert!(second_res.imported.is_empty());
    assert_eq!(second_res.skipped.len(), 3);
    assert!(
        second_res
            .skipped
            .iter()
            .all(|s| s.reason == "already_imported")
    );
}

struct TestImprover {
    mode: String,
}

#[async_trait]
impl SkillImproverRunner for TestImprover {
    async fn run(
        &self,
        _cfg: &AgentConfig,
        input: SkillImproverRunInput,
    ) -> SkillImproverRunResult {
        let editor = ConfinedSkillDirectoryEditor::open(&input.skill_root_dir).unwrap();
        match self.mode.as_str() {
            "edit_valid" => {
                let current = editor.read_file("SKILL.md").unwrap();
                let updated = format!("{current}\n## Learned Tip\nAlways check exit codes.\n");
                editor.write_file("SKILL.md", &updated).unwrap();
                SkillImproverRunResult {
                    ok: true,
                    changed: true,
                    message: "Added learned tip.".to_owned(),
                    error: None,
                }
            }
            "corrupt_frontmatter" => {
                editor
                    .write_file(
                        "SKILL.md",
                        "---\nname: wrong-renamed-skill\ndescription: Broken\n---\nCorrupted.\n",
                    )
                    .unwrap();
                SkillImproverRunResult {
                    ok: true,
                    changed: true,
                    message: "Wrote invalid frontmatter.".to_owned(),
                    error: None,
                }
            }
            _ => SkillImproverRunResult {
                ok: true,
                changed: false,
                message: "No-op.".to_owned(),
                error: None,
            },
        }
    }
}

#[tokio::test]
async fn skill_improvement_runs_copy_back_shadow_restore_and_prerun_rollback() {
    let (_guard, base) = canonical_temp_dir("cowork-skill-imp-");
    let home = base.join("home");
    let ws = base.join("workspace");
    let (mut base_cfg, env) = setup_env_and_config(&base, &home, &ws, HashMap::new());
    base_cfg.skill_improvement_enabled = true;
    base_cfg.skill_improvement_scope = SkillImprovementScope::All;

    // Editable user skill:
    let user_skill_dir = home.join(".cowork/skills/ops-helper");
    fs::create_dir_all(&user_skill_dir).unwrap();
    let orig_user_md =
        "---\nname: ops-helper\ndescription: Operations helper\n---\nOriginal user body.\n";
    fs::write(user_skill_dir.join("SKILL.md"), orig_user_md).unwrap();

    let mutations = Arc::new(AtomicUsize::new(0));
    let mutations_clone = mutations.clone();
    let cfg_for_loader = base_cfg.clone();

    let svc = SkillImprovementService::new(SkillImprovementServiceDeps {
        cowork_home: home.join(".cowork"),
        env: env.clone(),
        load_config: Arc::new(move |_cwd| Ok(cfg_for_loader.clone())),
        has_busy_sessions: Arc::new(|| false),
        signal_skill_mutation: Arc::new(move || {
            mutations_clone.fetch_add(1, Ordering::SeqCst);
        }),
        broadcast_status: None,
        improver: Some(Arc::new(TestImprover {
            mode: "edit_valid".to_owned(),
        })),
    });

    // 1. Record turn usage & run manual improvement on editable user skill (`copy-back` backup).
    svc.record_completed_turn_usage(CompletedTurnSkillUsage {
        session_id: "s1".to_owned(),
        turn_id: "t1".to_owned(),
        working_directory: ws.to_string_lossy().into_owned(),
        message_start_index: 0,
        message_end_index: 2,
        transcript: "User invoked ops-helper.".to_owned(),
        usages: vec![CompletedTurnSkillUsageInput {
            skill_name: "ops-helper".to_owned(),
            kind: "tool".to_owned(),
            source: "skill".to_owned(),
            turn_id: "t1".to_owned(),
            used_at: "2026-03-20T10:00:00.000Z".to_owned(),
            skill_source: Some("global".to_owned()),
            skill_path: Some(
                user_skill_dir
                    .join("SKILL.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
        }],
    })
    .expect("record usage");

    let status_before = svc.get_status(None, Some(&ws)).expect("status before");
    assert_eq!(status_before.pending_jobs.len(), 1);

    svc.run_now(Some("ops-helper"), Some(&ws))
        .await
        .expect("run_now ops-helper");
    let improved_md = fs::read_to_string(user_skill_dir.join("SKILL.md")).unwrap();
    assert!(improved_md.contains("Always check exit codes."));
    assert!(mutations.load(Ordering::SeqCst) >= 1);

    let status_after = svc.get_status(None, Some(&ws)).expect("status after");
    let ops_entry = status_after
        .skills
        .iter()
        .find(|s| s.skill_name == "ops-helper")
        .unwrap();
    assert!(ops_entry.has_backup);
    let stored_state = svc.store().read();
    assert_eq!(
        stored_state
            .backups
            .values()
            .find(|b| b.skill_name == "ops-helper")
            .unwrap()
            .restore_mode,
        "copy-back"
    );

    // Restore `ops-helper` reverts to `orig_user_md`!
    svc.restore("ops-helper", Some(&ws))
        .await
        .expect("restore ops-helper");
    assert_eq!(
        fs::read_to_string(user_skill_dir.join("SKILL.md")).unwrap(),
        orig_user_md
    );

    // 2. Built-in read-only skill (`presentations`) creates shadow under `<coworkHome>/skills/presentations` (`delete-shadow`)!
    svc.record_completed_turn_usage(CompletedTurnSkillUsage {
        session_id: "s1".to_owned(),
        turn_id: "t2".to_owned(),
        working_directory: ws.to_string_lossy().into_owned(),
        message_start_index: 2,
        message_end_index: 4,
        transcript: "User invoked presentations.".to_owned(),
        usages: vec![CompletedTurnSkillUsageInput {
            skill_name: "presentations".to_owned(),
            kind: "tool".to_owned(),
            source: "skill".to_owned(),
            turn_id: "t2".to_owned(),
            used_at: "2026-03-20T10:05:00.000Z".to_owned(),
            skill_source: Some("bundled".to_owned()),
            skill_path: Some(
                base.join("builtin/skills/presentations/SKILL.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
        }],
    })
    .expect("record presentations usage");
    svc.run_now(Some("presentations"), Some(&ws))
        .await
        .expect("run_now presentations shadow");
    let shadow_md = home.join(".cowork/skills/presentations/SKILL.md");
    assert!(shadow_md.is_file());
    assert!(
        fs::read_to_string(&shadow_md)
            .unwrap()
            .contains("Always check exit codes.")
    );
    // Built-in original remains untouched!
    assert!(
        !fs::read_to_string(base.join("builtin/skills/presentations/SKILL.md"))
            .unwrap()
            .contains("Always check exit codes.")
    );

    let status_shadow = svc.get_status(None, Some(&ws)).unwrap();
    assert!(
        status_shadow
            .skills
            .iter()
            .any(|s| s.skill_name == "presentations" && s.has_backup)
    );
    assert_eq!(
        svc.store()
            .read()
            .backups
            .values()
            .find(|b| b.skill_name == "presentations")
            .unwrap()
            .restore_mode,
        "delete-shadow"
    );

    svc.restore("presentations", Some(&ws))
        .await
        .expect("restore delete-shadow");
    assert!(!home.join(".cowork/skills/presentations").exists());

    // 3. Invalid frontmatter produced by runner triggers automatic `prerun/` rollback!
    let cfg_for_corrupt = base_cfg.clone();
    let bad_svc = SkillImprovementService::new(SkillImprovementServiceDeps {
        cowork_home: home.join(".cowork"),
        env,
        load_config: Arc::new(move |_cwd| Ok(cfg_for_corrupt.clone())),
        has_busy_sessions: Arc::new(|| false),
        signal_skill_mutation: Arc::new(|| {}),
        broadcast_status: None,
        improver: Some(Arc::new(TestImprover {
            mode: "corrupt_frontmatter".to_owned(),
        })),
    });
    bad_svc
        .record_completed_turn_usage(CompletedTurnSkillUsage {
            session_id: "s1".to_owned(),
            turn_id: "t3".to_owned(),
            working_directory: ws.to_string_lossy().into_owned(),
            message_start_index: 4,
            message_end_index: 6,
            transcript: "User invoked ops-helper again.".to_owned(),
            usages: vec![CompletedTurnSkillUsageInput {
                skill_name: "ops-helper".to_owned(),
                kind: "tool".to_owned(),
                source: "skill".to_owned(),
                turn_id: "t3".to_owned(),
                used_at: "2026-03-20T10:10:00.000Z".to_owned(),
                skill_source: Some("global".to_owned()),
                skill_path: Some(
                    user_skill_dir
                        .join("SKILL.md")
                        .to_string_lossy()
                        .into_owned(),
                ),
            }],
        })
        .expect("record ops-helper usage before corrupt run");
    bad_svc
        .run_now(Some("ops-helper"), Some(&ws))
        .await
        .expect("run_now handles failed frontmatter via history");
    assert_eq!(
        fs::read_to_string(user_skill_dir.join("SKILL.md")).unwrap(),
        orig_user_md,
        "prerun snapshot must roll back corrupted SKILL.md"
    );
    let bad_status = bad_svc.get_status(None, Some(&ws)).unwrap();
    assert_eq!(bad_status.run_history[0].status, "failed");
}
