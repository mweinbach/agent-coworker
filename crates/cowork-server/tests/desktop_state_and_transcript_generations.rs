//! TS-parity regressions for the web desktop service (`COWORK_WEB_DESKTOP_SERVICE=1`):
//!
//! - `state.json` changes (external writes and `POST /cowork/desktop/state`)
//!   broadcast `workspace/listChanged` (TS `watchStateChanges`);
//! - `POST /cowork/desktop/state` runs TS `normalizeState` and returns exactly
//!   what it persisted, preserving unknown per-workspace fields;
//! - conversation-import workspace creation keeps unknown workspace fields;
//! - transcript generations: DELETE tombstones a generation in
//!   `transcript-inbox.sqlite`, stale batches cannot recreate the transcript,
//!   and `ts`/`direction`/`generation` are validated like TS;
//! - batches committed by the TS server (same SQLite schema) are projected.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, Method, StatusCode};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::http_desktop::{WebDesktopService, handle_desktop_route};
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const TOKEN: &str = "desktop-state-test-token";

struct Env {
    _root: TempDir,
    home: PathBuf,
    user_data: PathBuf,
    workspace: PathBuf,
}

impl Env {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-desktop-state-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let user_data = base.join("userdata");
        let workspace = base.join("workspace");
        for dir in [&home, &user_data, &workspace] {
            fs::create_dir_all(dir).unwrap();
        }
        Self {
            _root: root,
            home,
            user_data,
            workspace,
        }
    }

    fn service(&self) -> WebDesktopService {
        WebDesktopService::new(self.home.clone(), self.user_data.clone())
    }

    fn server_options(&self) -> ServerOptions {
        let mut env = HashMap::new();
        env.insert("HOME".into(), self.home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            self.home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            self.user_data.to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
        env.insert("COWORK_BROWSER_ACCESS_TOKEN".into(), TOKEN.into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env,
        }
    }
}

fn route(
    svc: &WebDesktopService,
    cwd: &Path,
    method: Method,
    pathname: &str,
    query: Option<&str>,
    body: &Value,
) -> (StatusCode, String) {
    let bytes = if body.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(body).unwrap()
    };
    let res = handle_desktop_route(
        &method,
        pathname,
        query,
        &HeaderMap::new(),
        &bytes,
        cwd,
        Some(svc),
    );
    let status = res.status();
    let body = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(axum::body::to_bytes(res.into_body(), usize::MAX))
        .unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

async fn connect_ready_ws(ws_url: &str) -> WsStream {
    let mut req = format!("{ws_url}?token={TOKEN}")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "desktop-state-test", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    ws.send(WsMessage::Text(
        json!({ "method": "initialized", "params": {} })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    ws
}

/// Collects `workspace/listChanged` notifications seen within `window`.
async fn collect_list_changed(ws: &mut WsStream, window: Duration) -> Vec<Value> {
    let deadline = Instant::now() + window;
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return out;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&text)
                    && v["method"] == "workspace/listChanged"
                {
                    out.push(v);
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return out,
        }
    }
}

async fn wait_for_list_changed(ws: &mut WsStream, timeout: Duration) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&text)
                    && v["method"] == "workspace/listChanged"
                {
                    return Some(v);
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

fn workspace_json(id: &str, path: &Path) -> Value {
    json!({
        "id": id,
        "name": id,
        "path": path.to_string_lossy(),
        "createdAt": "2026-01-01T00:00:00.000Z",
        "lastOpenedAt": "2026-01-02T00:00:00.000Z",
    })
}

#[tokio::test]
async fn external_state_json_write_broadcasts_workspace_list_changed() {
    let env = Env::new();
    let server = start_server(env.server_options()).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    // Drain anything emitted during the handshake.
    let _ = collect_list_changed(&mut ws, Duration::from_millis(150)).await;

    // Electron writes state.json itself (temp file + rename).
    let project = env.workspace.join("external-project");
    fs::create_dir_all(&project).unwrap();
    let state = json!({ "version": 2, "workspaces": [workspace_json("ext-ws", &project)] });
    let tmp = env.user_data.join(".state.json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&state).unwrap()).unwrap();
    fs::rename(&tmp, env.user_data.join("state.json")).unwrap();

    let notif = wait_for_list_changed(&mut ws, Duration::from_secs(5))
        .await
        .expect("external state.json write must broadcast workspace/listChanged");
    assert!(
        notif["params"]["revision"].as_u64().unwrap() >= 1,
        "{notif}"
    );

    // An in-place rewrite of the same file (no rename) is detected as well.
    fs::write(
        env.user_data.join("state.json"),
        serde_json::to_string(&json!({ "version": 3, "workspaces": [] })).unwrap(),
    )
    .unwrap();
    assert!(
        wait_for_list_changed(&mut ws, Duration::from_secs(5))
            .await
            .is_some(),
        "in-place state.json rewrite must broadcast workspace/listChanged"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn post_desktop_state_broadcasts_workspace_list_changed_once() {
    let env = Env::new();
    let server = start_server(env.server_options()).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let _ = collect_list_changed(&mut ws, Duration::from_millis(150)).await;

    let state = json!({ "workspaces": [workspace_json("posted-ws", &env.workspace)] });
    let res = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{}/cowork/desktop/state",
            server.port()
        ))
        .header("X-Cowork-Browser-Token", TOKEN)
        .json(&state)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let notifs = collect_list_changed(&mut ws, Duration::from_millis(800)).await;
    assert_eq!(
        notifs.len(),
        1,
        "POST state must broadcast exactly once (the watcher must not echo our own write): {notifs:?}"
    );
    server.shutdown().await;
}

#[test]
fn post_state_normalizes_replaces_and_returns_persisted_state() {
    let env = Env::new();
    let svc = env.service();
    let project = env.workspace.join("proj");
    fs::create_dir_all(&project).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&project, env.workspace.join("proj-link")).unwrap();

    // Seed state with a key that a replace (not merge) must drop.
    let (status, _) = route(
        &svc,
        &env.workspace,
        Method::POST,
        "/cowork/desktop/state",
        None,
        &json!({ "workspaces": [workspace_json("old-ws", &project)], "developerMode": true }),
    );
    assert_eq!(status, StatusCode::OK);

    let non_canonical = format!("{}/sub/../proj", env.workspace.display());
    let mut extra = workspace_json("ws-a", Path::new(&non_canonical));
    extra["providerOptions"] = json!({ "openai": { "reasoningEffort": "high" } });
    extra["userName"] = json!("Max");
    extra["defaultChildModelRoutingMode"] = json!("cross-provider-allowlist");
    extra["yolo"] = json!(true);
    extra["workspaceKind"] = json!("bogus");
    fs::create_dir_all(env.workspace.join("sub")).unwrap();
    #[cfg(unix)]
    let linked = workspace_json("ws-link", &env.workspace.join("proj-link"));
    #[cfg(not(unix))]
    let linked = workspace_json("ws-link", &project);
    let incoming = json!({
        "version": 1,
        "workspaces": [
            extra,
            workspace_json("ws-a", &env.workspace),              // duplicate id: dropped
            linked,
            { "id": "bad id!", "name": "x", "path": "/tmp", "createdAt": "2026-01-01T00:00:00Z", "lastOpenedAt": "2026-01-01T00:00:00Z" },
            { "id": "no-dates", "name": "x", "path": project.to_string_lossy() },
        ],
        "threads": [
            { "id": "t1", "workspaceId": "ws-a", "title": " T1 ", "createdAt": "2026-01-01T00:00:00Z",
              "lastMessageAt": "2026-01-01T00:00:00Z", "messageCount": 3.7, "status": "weird", "custom": 1 },
            { "id": "t1", "workspaceId": "ws-a", "title": "dup", "createdAt": "2026-01-01T00:00:00Z", "lastMessageAt": "2026-01-01T00:00:00Z" },
            { "id": "t2", "workspaceId": "missing", "title": "orphan", "createdAt": "2026-01-01T00:00:00Z", "lastMessageAt": "2026-01-01T00:00:00Z" },
        ],
        "desktopSettings": { "quickChat": { "shortcutAccelerator": "ctrl+shift+k" }, "other": 1 },
        "cloudSync": { "enabled": true, "endpoint": "https://sync.example.com///" },
        "desktopFeatureFlagOverrides": { "tasks": true, "unknownFlag": true, "canvas": "yes" },
        "unknownTopLevel": 42,
        "onboarding": { "done": true },
    });
    let (status, body) = route(
        &svc,
        &env.workspace,
        Method::POST,
        "/cowork/desktop/state",
        None,
        &incoming,
    );
    assert_eq!(status, StatusCode::OK, "{body}");
    let returned: Value = serde_json::from_str(&body).unwrap();
    let persisted: Value =
        serde_json::from_str(&fs::read_to_string(env.user_data.join("state.json")).unwrap())
            .unwrap();
    assert_eq!(
        returned, persisted,
        "response must equal what was persisted"
    );

    let canon_project = fs::canonicalize(&project).unwrap();
    let workspaces = persisted["workspaces"].as_array().unwrap();
    let ids: Vec<&str> = workspaces
        .iter()
        .map(|w| w["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["ws-a", "ws-link"], "{persisted}");
    let ws_a = &workspaces[0];
    assert_eq!(ws_a["path"], json!(canon_project.to_string_lossy()));
    assert_eq!(ws_a["workspaceKind"], "project");
    assert_eq!(ws_a["wsProtocol"], "jsonrpc");
    assert_eq!(ws_a["yolo"], false);
    assert_eq!(ws_a["defaultEnableMcp"], true);
    assert_eq!(ws_a["defaultBackupsEnabled"], false);
    assert_eq!(
        ws_a["providerOptions"]["openai"]["reasoningEffort"], "high",
        "unknown workspace fields are preserved"
    );
    assert_eq!(ws_a["userName"], "Max");
    assert_eq!(
        ws_a["defaultChildModelRoutingMode"],
        "cross-provider-allowlist"
    );
    assert_eq!(
        workspaces[1]["path"],
        json!(canon_project.to_string_lossy()),
        "symlinked paths are canonicalized"
    );

    let threads = persisted["threads"].as_array().unwrap();
    assert_eq!(threads.len(), 1, "{persisted}");
    assert_eq!(threads[0]["title"], "T1");
    assert_eq!(threads[0]["status"], "disconnected");
    assert_eq!(threads[0]["messageCount"], 3);
    assert_eq!(threads[0]["lastEventSeq"], 0);
    assert_eq!(threads[0]["sessionId"], Value::Null);
    assert_eq!(threads[0]["custom"], 1);

    assert_eq!(persisted["version"], 2);
    assert_eq!(
        persisted["developerMode"], false,
        "POST replaces, not merges"
    );
    assert!(persisted.get("unknownTopLevel").is_none());
    assert_eq!(persisted["onboarding"]["done"], true);
    assert_eq!(
        persisted["desktopSettings"],
        json!({
            "quickChat": { "iconEnabled": true, "shortcutEnabled": false, "shortcutAccelerator": "Ctrl+Shift+K" },
            "archivedChatsAutoDeleteDays": 0
        })
    );
    assert_eq!(
        persisted["cloudSync"],
        json!({
            "enabled": true, "provider": "none", "endpoint": "https://sync.example.com",
            "syncSettings": true, "syncWorkspaceMetadata": false, "syncThreads": false
        })
    );
    assert_eq!(
        persisted["desktopFeatureFlagOverrides"],
        json!({ "tasks": true })
    );

    // GET returns the same normalized state.
    let (status, body) = route(
        &svc,
        &env.workspace,
        Method::GET,
        "/cowork/desktop/state",
        None,
        &Value::Null,
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), persisted);

    // Non-object bodies are rejected like TS `readJsonBody`.
    let (status, body) = route(
        &svc,
        &env.workspace,
        Method::POST,
        "/cowork/desktop/state",
        None,
        &json!([1, 2]),
    );
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, "Expected a JSON object body");
}

#[test]
fn import_workspace_creation_preserves_unknown_workspace_fields() {
    let env = Env::new();
    let svc = env.service();
    let mut existing = workspace_json("existing", &env.workspace);
    existing["providerOptions"] = json!({ "google": { "thinkingBudget": 1024 } });
    existing["userProfile"] = json!({ "instructions": "be brief" });
    existing["defaultAllowedChildModelRefs"] = json!(["openai:gpt-5"]);
    existing["defaultSkillImprovementEnabled"] = json!(true);
    svc.save_state_json(json!({ "workspaces": [existing] }), &env.workspace)
        .unwrap();

    let target = env.workspace.parent().unwrap().join("imported-target");
    fs::create_dir_all(&target).unwrap();
    let outcome = svc
        .ensure_workspace_for_import(&target, Some("Imported"), &env.workspace)
        .unwrap();
    assert!(outcome.created);

    let persisted: Value =
        serde_json::from_str(&fs::read_to_string(env.user_data.join("state.json")).unwrap())
            .unwrap();
    let workspaces = persisted["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 2, "{persisted}");
    let kept = &workspaces[0];
    assert_eq!(kept["id"], "existing");
    assert_eq!(kept["providerOptions"]["google"]["thinkingBudget"], 1024);
    assert_eq!(kept["userProfile"]["instructions"], "be brief");
    assert_eq!(
        kept["defaultAllowedChildModelRefs"],
        json!(["openai:gpt-5"])
    );
    assert_eq!(kept["defaultSkillImprovementEnabled"], true);
    assert_eq!(workspaces[1]["name"], "Imported");

    // Importing the same path again reuses the workspace.
    let again = svc
        .ensure_workspace_for_import(&target, None, &env.workspace)
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.workspace_id, outcome.workspace_id);
}

fn batch(batch_id: &str, thread: &str, generation: Option<i64>, text: &str) -> Value {
    let mut event = json!({
        "threadId": thread,
        "ts": "2026-01-01T00:00:00.000Z",
        "direction": "server",
        "payload": { "text": text },
    });
    if let Some(g) = generation {
        event["generation"] = json!(g);
    }
    json!({ "batchId": batch_id, "events": [event] })
}

fn read_transcript(svc: &WebDesktopService, cwd: &Path, thread: &str) -> Vec<Value> {
    let (status, body) = route(
        svc,
        cwd,
        Method::GET,
        "/cowork/desktop/transcript",
        Some(&format!("threadId={thread}")),
        &Value::Null,
    );
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str::<Vec<Value>>(&body).unwrap()
}

fn post_batch(svc: &WebDesktopService, cwd: &Path, body: &Value) -> (StatusCode, String) {
    route(
        svc,
        cwd,
        Method::POST,
        "/cowork/desktop/transcript/batch",
        None,
        body,
    )
}

#[test]
fn deleted_transcript_is_not_recreated_by_stale_generation_batch() {
    let env = Env::new();
    let svc = env.service();
    let cwd = env.workspace.clone();
    let transcript = env.user_data.join("transcripts").join("thread-1.jsonl");

    assert_eq!(
        post_batch(&svc, &cwd, &batch("b-1", "thread-1", None, "before")).0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(read_transcript(&svc, &cwd, "thread-1").len(), 1);
    assert!(transcript.exists());

    let (status, _) = route(
        &svc,
        &cwd,
        Method::DELETE,
        "/cowork/desktop/transcript",
        Some("threadId=thread-1&generation=1"),
        &Value::Null,
    );
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!transcript.exists());
    assert_eq!(
        svc.transcript_inbox().read_generation("thread-1").unwrap(),
        1
    );

    // A late retry from the old generation is acknowledged but dropped.
    assert_eq!(
        post_batch(&svc, &cwd, &batch("b-2", "thread-1", Some(0), "stale")).0,
        StatusCode::NO_CONTENT
    );
    assert!(read_transcript(&svc, &cwd, "thread-1").is_empty());
    assert!(
        !transcript.exists(),
        "stale batch must not recreate the transcript"
    );

    // The current generation is accepted, as is an event without a generation.
    assert_eq!(
        post_batch(&svc, &cwd, &batch("b-3", "thread-1", Some(1), "fresh")).0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post_batch(&svc, &cwd, &batch("b-4", "thread-1", None, "fresh-2")).0,
        StatusCode::NO_CONTENT
    );
    let events = read_transcript(&svc, &cwd, "thread-1");
    let texts: Vec<&str> = events
        .iter()
        .map(|e| e["payload"]["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, vec!["fresh", "fresh-2"]);
    assert_eq!(events[0]["deliveryId"], "b-3:0");
    assert_eq!(events[0]["direction"], "server");

    // A DELETE for an older/equal generation is a no-op; one without a
    // generation bumps it.
    route(
        &svc,
        &cwd,
        Method::DELETE,
        "/cowork/desktop/transcript",
        Some("threadId=thread-1&generation=1"),
        &Value::Null,
    );
    assert_eq!(read_transcript(&svc, &cwd, "thread-1").len(), 2);
    route(
        &svc,
        &cwd,
        Method::DELETE,
        "/cowork/desktop/transcript",
        Some("threadId=thread-1"),
        &Value::Null,
    );
    assert_eq!(
        svc.transcript_inbox().read_generation("thread-1").unwrap(),
        2
    );
    assert!(read_transcript(&svc, &cwd, "thread-1").is_empty());

    // Tombstones are durable across service restarts.
    let restarted = env.service();
    assert_eq!(
        post_batch(
            &restarted,
            &cwd,
            &batch("b-5", "thread-1", Some(1), "stale")
        )
        .0,
        StatusCode::NO_CONTENT
    );
    assert!(read_transcript(&restarted, &cwd, "thread-1").is_empty());
}

#[test]
fn transcript_routes_validate_generation_ts_and_direction_like_ts() {
    let env = Env::new();
    let svc = env.service();
    let cwd = env.workspace.clone();

    for bad in ["0", "-1", "01", "+1", "1.5", "abc", ""] {
        let (status, body) = route(
            &svc,
            &cwd,
            Method::DELETE,
            "/cowork/desktop/transcript",
            Some(&format!("threadId=t&generation={bad}")),
            &Value::Null,
        );
        assert_eq!(status, StatusCode::BAD_REQUEST, "generation={bad}");
        assert_eq!(body, "generation must be a positive integer");
    }
    let (status, body) = route(
        &svc,
        &cwd,
        Method::DELETE,
        "/cowork/desktop/transcript",
        None,
        &Value::Null,
    );
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::BAD_REQUEST, "threadId is required")
    );

    let base = json!({ "threadId": "t", "ts": "2026-01-01T00:00:00Z", "direction": "client" });
    let cases = [
        (
            json!({ "direction": "sideways" }),
            "direction must be 'server' or 'client'",
        ),
        (json!({ "direction": null }), "direction is required"),
        (json!({ "ts": "   " }), "ts is required"),
        (json!({ "ts": 5 }), "ts is required"),
        (
            json!({ "generation": -1 }),
            "generation must be a non-negative integer",
        ),
        (
            json!({ "generation": 1.5 }),
            "generation must be a non-negative integer",
        ),
        (
            json!({ "generation": "1" }),
            "generation must be a non-negative integer",
        ),
        (
            json!({ "threadId": "bad id" }),
            "threadId contains invalid characters",
        ),
    ];
    for (patch, expected) in cases {
        let mut event = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            event[k] = v.clone();
        }
        let (status, body) = post_batch(&svc, &cwd, &json!({ "batchId": "b", "events": [event] }));
        assert_eq!(status, StatusCode::BAD_REQUEST, "{patch} -> {body}");
        assert_eq!(body, expected, "{patch}");

        // The single-event route validates ts/direction the same way.
        if !expected.starts_with("generation") {
            let (status, body) = route(
                &svc,
                &cwd,
                Method::POST,
                "/cowork/desktop/transcript/event",
                None,
                &event,
            );
            assert_eq!(status, StatusCode::BAD_REQUEST, "event {patch}");
            assert_eq!(body, expected, "event {patch}");
        }
    }

    let (status, body) = post_batch(&svc, &cwd, &json!({ "events": [base.clone()] }));
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::BAD_REQUEST, "batchId is required")
    );
    let (status, body) = post_batch(&svc, &cwd, &json!({ "batchId": "b", "events": "x" }));
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::BAD_REQUEST, "events must be a JSON array")
    );
    let (status, _) = post_batch(&svc, &cwd, &json!({ "batchId": "b", "events": [] }));
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    let (status, body) = post_batch(&svc, &cwd, &json!({ "batchId": "b", "events": [1] }));
    assert_eq!(
        (status, body.as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Transcript batch entries must be objects"
        )
    );
    assert!(!env.user_data.join("transcripts").join("t.jsonl").exists());

    // Legacy array bodies and the single-event route still append.
    assert_eq!(
        post_batch(&svc, &cwd, &json!([base.clone()])).0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        route(
            &svc,
            &cwd,
            Method::POST,
            "/cowork/desktop/transcript/event",
            None,
            &base
        )
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(read_transcript(&svc, &cwd, "t").len(), 2);
}

#[test]
fn batch_receipts_survive_restart() {
    let env = Env::new();
    let cwd = env.workspace.clone();
    let body = batch("persisted-1", "thread-r", None, "once");
    assert_eq!(
        post_batch(&env.service(), &cwd, &body).0,
        StatusCode::NO_CONTENT
    );
    let restarted = env.service();
    assert_eq!(
        post_batch(&restarted, &cwd, &body).0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(read_transcript(&restarted, &cwd, "thread-r").len(), 1);
    let (status, _) = post_batch(
        &restarted,
        &cwd,
        &batch("persisted-1", "thread-r", None, "different"),
    );
    assert_eq!(status, StatusCode::CONFLICT);
}

/// A `transcript-inbox.sqlite` left behind by the TS server (exact TS schema)
/// with a pending batch, a canceled event, and a generation tombstone.
#[test]
fn pending_batches_from_typescript_inbox_are_projected_on_read() {
    let env = Env::new();
    let db_path = env.user_data.join("transcript-inbox.sqlite");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE transcript_batches (
           batch_id TEXT PRIMARY KEY, digest TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('pending', 'completed')),
           event_count INTEGER NOT NULL, byte_count INTEGER NOT NULL,
           created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER);
         CREATE TABLE transcript_events (
           delivery_id TEXT PRIMARY KEY,
           batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id) ON DELETE CASCADE,
           event_index INTEGER NOT NULL, thread_id TEXT NOT NULL, generation INTEGER NOT NULL,
           event_json TEXT NOT NULL,
           projected INTEGER NOT NULL DEFAULT 0 CHECK(projected IN (0, 1)),
           canceled INTEGER NOT NULL DEFAULT 0 CHECK(canceled IN (0, 1)),
           UNIQUE(batch_id, event_index));
         CREATE TABLE transcript_generations (
           thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, tombstoned_at_ms INTEGER NOT NULL);",
    )
    .unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let line = |delivery: &str, text: &str| {
        json!({ "ts": "2026-01-01T00:00:00.000Z", "threadId": "ts-thread", "direction": "client",
                "payload": { "text": text }, "deliveryId": delivery })
        .to_string()
    };
    for batch_id in ["ts-b1", "ts-b2"] {
        conn.execute(
            "INSERT INTO transcript_batches(batch_id, digest, state, event_count, byte_count, created_at_ms) VALUES(?, 'd', 'pending', 2, 10, ?)",
            params![batch_id, now],
        )
        .unwrap();
    }
    let rows = [
        ("ts-b1:0", "ts-b1", 0, 1, "first", 0),
        ("ts-b1:1", "ts-b1", 1, 1, "canceled", 1),
        ("ts-b2:0", "ts-b2", 0, 1, "second", 0),
        ("ts-b2:1", "ts-b2", 1, 0, "old-generation", 0),
    ];
    for (delivery, batch_id, index, generation, text, canceled) in rows {
        conn.execute(
            "INSERT INTO transcript_events(delivery_id, batch_id, event_index, thread_id, generation, event_json, canceled) VALUES(?, ?, ?, 'ts-thread', ?, ?, ?)",
            params![delivery, batch_id, index, generation, line(delivery, text), canceled],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO transcript_generations(thread_id, generation, tombstoned_at_ms) VALUES('ts-thread', 1, ?)",
        [now],
    )
    .unwrap();
    drop(conn);

    let svc = env.service();
    let events = read_transcript(&svc, &env.workspace, "ts-thread");
    let texts: Vec<&str> = events
        .iter()
        .map(|e| e["payload"]["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, vec!["first", "second"]);

    let conn = Connection::open(&db_path).unwrap();
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transcript_batches WHERE state = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0, "projected batches are completed");
    let stale_canceled: i64 = conn
        .query_row(
            "SELECT canceled FROM transcript_events WHERE delivery_id = 'ts-b2:1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stale_canceled, 1);

    // Re-reading does not duplicate lines; the imported tombstone still applies.
    assert_eq!(read_transcript(&svc, &env.workspace, "ts-thread").len(), 2);
    assert_eq!(
        post_batch(
            &svc,
            &env.workspace,
            &batch("late", "ts-thread", Some(0), "late")
        )
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(read_transcript(&svc, &env.workspace, "ts-thread").len(), 2);
}
