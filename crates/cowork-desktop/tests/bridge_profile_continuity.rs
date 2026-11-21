//! Integration tests proving the bridge upgrade disposable desktop profile
//! (`scripts/bridge_upgrade_fixture.ts`) is read losslessly by Rune's real
//! [`PersistenceService`] reader and survives a Rune core-snapshot save.

use std::fs;
use std::path::{Path, PathBuf};

use cowork_desktop::native::persistence::{PersistenceService, TranscriptDirection};
use cowork_desktop::theme::ThemePreference;
use serde_json::json;
use tempfile::TempDir;

const BRIDGE_WORKSPACE_ID: &str = "ws-bridge-continuity-001";
const BRIDGE_THREAD_ID: &str = "thread-bridge-continuity-001";
const BRIDGE_THREAD_TITLE: &str = "Bridge upgrade profile continuity check";
const BRIDGE_TRANSCRIPT_TEXT: &str =
    "Preserved historical message before Electron to Rune upgrade.";

fn canonicalize_dir(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[test]
fn seeded_bridge_profile_from_env_roundtrips_through_rune_persistence() {
    let _temp_guard: Option<TempDir>;
    let user_data_dir: PathBuf;
    let expected_workspace_dir: PathBuf;
    let expect_electron_sanitized = std::env::var("COWORK_TEST_BRIDGE_EXPECT_ELECTRON_SANITIZED")
        .ok()
        .as_deref()
        == Some("1");

    if let Ok(env_dir) = std::env::var("COWORK_TEST_BRIDGE_PROFILE_DIR") {
        _temp_guard = None;
        user_data_dir = PathBuf::from(env_dir);
        expected_workspace_dir = std::env::var("COWORK_TEST_BRIDGE_WORKSPACE_DIR")
            .map(PathBuf::from)
            .map(|p| canonicalize_dir(&p))
            .expect(
                "COWORK_TEST_BRIDGE_WORKSPACE_DIR must be set with COWORK_TEST_BRIDGE_PROFILE_DIR",
            );
    } else {
        let tmp = TempDir::new().expect("create temp dir");
        let ws_dir = tmp.path().join("workspace");
        let ud_dir = tmp.path().join("Cowork");
        fs::create_dir_all(ud_dir.join("transcripts")).expect("create transcripts dir");
        fs::create_dir_all(&ws_dir).expect("create workspace dir");
        let canonical_ws = canonicalize_dir(&ws_dir);
        let now = "2026-10-04T16:00:00.000Z";

        let state = json!({
            "version": 2,
            "workspaces": [
                {
                    "id": BRIDGE_WORKSPACE_ID,
                    "name": "Bridge Workspace",
                    "path": canonical_ws,
                    "workspaceKind": "project",
                    "createdAt": now,
                    "lastOpenedAt": now,
                    "archived": false,
                    "wsProtocol": "jsonrpc",
                    "defaultEnableMcp": true,
                    "defaultBackupsEnabled": false,
                    "yolo": false,
                }
            ],
            "threads": [
                {
                    "id": BRIDGE_THREAD_ID,
                    "workspaceId": BRIDGE_WORKSPACE_ID,
                    "title": BRIDGE_THREAD_TITLE,
                    "titleSource": "manual",
                    "createdAt": now,
                    "lastMessageAt": now,
                    "status": "active",
                    "sessionId": null,
                    "messageCount": 1,
                    "lastEventSeq": 1,
                    "archived": false,
                }
            ],
            "workspaceOrder": [BRIDGE_WORKSPACE_ID],
            "collapsedWorkspaceIds": [],
            "collapsedSidebarSections": [],
            "activeWorkspaceId": BRIDGE_WORKSPACE_ID,
            "activeThreadId": BRIDGE_THREAD_ID,
            "developerMode": false,
            "showHiddenFiles": false,
            "perWorkspaceSettings": false,
            "desktopSettings": {
                "theme": "dark",
            },
            "onboarding": {
                "status": "completed",
                "completedAt": now,
                "dismissedAt": null,
            }
        });
        fs::write(
            ud_dir.join("state.json"),
            format!("{}\n", serde_json::to_string_pretty(&state).unwrap()),
        )
        .expect("write state.json");

        let transcript_event = json!({
            "ts": now,
            "threadId": BRIDGE_THREAD_ID,
            "direction": "client",
            "payload": {
                "id": "msg-bridge-001",
                "role": "user",
                "text": BRIDGE_TRANSCRIPT_TEXT,
            }
        });
        fs::write(
            ud_dir
                .join("transcripts")
                .join(format!("{BRIDGE_THREAD_ID}.jsonl")),
            format!("{}\n", serde_json::to_string(&transcript_event).unwrap()),
        )
        .expect("write transcript");

        user_data_dir = ud_dir;
        expected_workspace_dir = canonical_ws;
        _temp_guard = Some(tmp);
    }

    let service = PersistenceService::new(user_data_dir, None, true, None);

    // 1. Verify raw document sanitization through Rune's real PersistenceService reader.
    let doc = service
        .load_state_value()
        .expect("Rune PersistenceService::load_state_value must succeed");
    assert_eq!(doc["version"].as_u64(), Some(2));
    assert_eq!(doc["onboarding"]["status"].as_str(), Some("completed"));
    assert!(
        doc["onboarding"]["completedAt"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "onboarding.completedAt must be preserved"
    );
    assert!(
        doc["onboarding"]["dismissedAt"].is_null(),
        "onboarding.dismissedAt must stay null"
    );

    // 2. Verify core desktop state hydration (workspaces, top-level threads, onboarding).
    let core = service
        .load_core_state()
        .expect("Rune PersistenceService::load_core_state must succeed");
    assert_eq!(
        core.workspaces.len(),
        1,
        "expected exactly 1 hydrated workspace"
    );
    let ws = &core.workspaces[0];
    assert_eq!(ws.id, BRIDGE_WORKSPACE_ID);
    assert!(
        !ws.one_off_chat,
        "bridge workspace must stay a project workspace"
    );
    assert_eq!(
        canonicalize_dir(Path::new(&ws.path)),
        expected_workspace_dir,
        "hydrated workspace path must match canonical workspace dir"
    );

    assert_eq!(
        core.threads.len(),
        1,
        "Rune must hydrate the seeded top-level thread"
    );
    let thread = &core.threads[0];
    assert_eq!(thread.id, BRIDGE_THREAD_ID);
    assert_eq!(thread.workspace_id, BRIDGE_WORKSPACE_ID);
    assert_eq!(thread.title, BRIDGE_THREAD_TITLE);

    assert!(
        core.onboarding.completed && !core.onboarding.dismissed,
        "Rune must hydrate completed onboarding so the onboarding modal stays hidden during Hop 2"
    );

    if !expect_electron_sanitized {
        assert_eq!(
            core.active_workspace_id.as_deref(),
            Some(BRIDGE_WORKSPACE_ID)
        );
        assert_eq!(core.active_thread_id.as_deref(), Some(BRIDGE_THREAD_ID));
        assert_eq!(core.settings.theme, ThemePreference::Dark);
    }

    // 3. Verify transcript JSONL reader loads the seeded historical message.
    let events = service
        .read_transcript(BRIDGE_THREAD_ID)
        .expect("Rune PersistenceService::read_transcript must succeed");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].thread_id, BRIDGE_THREAD_ID);
    assert_eq!(events[0].direction, TranscriptDirection::Client);
    assert_eq!(
        events[0].payload.get("text").and_then(|v| v.as_str()),
        Some(BRIDGE_TRANSCRIPT_TEXT)
    );

    // 4. Verify Rune's real merge-and-save write path preserves canonical v2 state on disk.
    let saved = service
        .merge_and_save_core_snapshot(&core)
        .expect("Rune PersistenceService::merge_and_save_core_snapshot must succeed");
    assert_eq!(saved["version"].as_u64(), Some(2));
    assert_eq!(saved["onboarding"]["status"].as_str(), Some("completed"));
    assert_eq!(
        saved["threads"].as_array().map(Vec::len),
        Some(1),
        "saved state.json must preserve top-level threads"
    );

    let reloaded = service
        .load_core_state()
        .expect("reload after merge_and_save_core_snapshot");
    assert_eq!(reloaded.workspaces.len(), 1);
    assert_eq!(reloaded.threads.len(), 1);
    assert_eq!(reloaded.threads[0].id, BRIDGE_THREAD_ID);
    assert!(reloaded.onboarding.completed && !reloaded.onboarding.dismissed);
}

#[test]
fn legacy_incompatible_threads_by_workspace_schema_is_dropped_by_rune_persistence() {
    let tmp = TempDir::new().expect("create temp dir");
    let ws_dir = tmp.path().join("workspace");
    let ud_dir = tmp.path().join("Cowork");
    fs::create_dir_all(&ud_dir).expect("create userData dir");
    fs::create_dir_all(&ws_dir).expect("create workspace dir");
    let now = "2026-10-04T16:00:00.000Z";

    // The pre-fix invented schema (`schemaVersion`, `threadsByWorkspace`, no `onboarding`)
    // is silently dropped by Rune's persistence reader.
    let broken_state = json!({
        "schemaVersion": 2,
        "workspaces": [
            {
                "id": BRIDGE_WORKSPACE_ID,
                "name": "Bridge Workspace",
                "path": ws_dir,
                "kind": "project",
                "createdAt": now,
                "lastOpenedAt": now,
            }
        ],
        "activeWorkspaceId": BRIDGE_WORKSPACE_ID,
        "threadsByWorkspace": {
            BRIDGE_WORKSPACE_ID: [
                {
                    "id": BRIDGE_THREAD_ID,
                    "title": BRIDGE_THREAD_TITLE,
                    "createdAt": now,
                    "updatedAt": now,
                }
            ]
        },
        "activeThreadByWorkspace": {
            BRIDGE_WORKSPACE_ID: BRIDGE_THREAD_ID
        },
        "settings": {
            "theme": "dark"
        }
    });
    fs::write(
        ud_dir.join("state.json"),
        format!("{}\n", serde_json::to_string_pretty(&broken_state).unwrap()),
    )
    .expect("write broken state.json");

    let service = PersistenceService::new(ud_dir, None, true, None);
    let core = service.load_core_state().expect("load broken state");
    assert!(
        core.threads.is_empty(),
        "non-canonical threadsByWorkspace must not be hydrated by Rune"
    );
    assert!(
        !core.onboarding.completed,
        "omitting onboarding must leave onboarding incomplete"
    );
}
