//! The `session_config` event reports the session's effective `userProfile`: the thread's stored
//! profile fields layered over the workspace profile one field at a time.
//!
//! TS `SessionMetadataManager.buildNextConfig` spread a `userProfile` patch over the session's
//! effective profile (`{ ...effectiveUserProfile(), ...patch.userProfile }`), and
//! `getSessionConfigEvent` emitted all three fields. The desktop's `controlSocket.ts` normalizes
//! omitted profile fields to `""` and replaces the workspace profile with the event, so a patch
//! of only `userProfile.work` must not blank `instructions` and `details` (a later settings save
//! would write those blanks back). The root-session config write merges the patch over the
//! stored profile (`ConfigPatchStore.ts`), so the persisted profile keeps every field too.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new(prefix: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(workspace.join(".cowork")).unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            base.join("electron").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            base.join("desktop").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        Self {
            _root: root,
            home,
            workspace,
            env,
        }
    }

    fn workspace_config_path(&self) -> PathBuf {
        self.workspace.join(".cowork").join("config.json")
    }

    /// Writes the workspace `.cowork/config.json` with a complete user profile.
    fn write_workspace_profile(&self) {
        fs::write(
            self.workspace_config_path(),
            json!({
                "provider": "google",
                "userProfile": {
                    "instructions": "Be concise",
                    "work": "Systems engineer",
                    "details": "Rust rewrite"
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn persisted_profile(&self) -> Value {
        let raw = fs::read_to_string(self.workspace_config_path()).unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["userProfile"].clone()
    }

    fn options(&self) -> ServerOptions {
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
            env: self.env.clone(),
        }
    }
}

async fn connect(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "session-config-user-profile-merge", "version": "1.0.0" },
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

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
        }
    }
}

async fn start_thread(ws: &mut WsStream, iso: &Iso) -> String {
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let started = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "google", "model": "gemini-3.1-pro-preview" }),
    )
    .await;
    started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned()
}

/// Sends `cowork/session/config/set` and returns the emitted event's `config.userProfile`.
async fn set_config(ws: &mut WsStream, id: &str, thread_id: &str, config: Value) -> Value {
    let res = call(
        ws,
        id,
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": config }),
    )
    .await;
    assert!(res.get("error").is_none(), "config/set failed: {res}");
    assert_eq!(res["result"]["event"]["type"], "session_config", "{res}");
    res["result"]["event"]["config"]["userProfile"].clone()
}

fn stored_profile(server: &ServerHandle, thread_id: &str) -> Option<Value> {
    let live = server.runtime().load_thread(thread_id).unwrap();
    live.lock().config_overrides.get("userProfile").cloned()
}

#[tokio::test]
async fn partial_profile_patch_keeps_other_fields_in_event_and_config_file() {
    let iso = Iso::new("cowork-session-config-user-profile-");
    iso.write_workspace_profile();
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    let profile = set_config(
        &mut ws,
        "work",
        &thread_id,
        json!({ "userProfile": { "work": "Staff engineer" } }),
    )
    .await;
    assert_eq!(
        profile,
        json!({
            "instructions": "Be concise",
            "work": "Staff engineer",
            "details": "Rust rewrite"
        }),
        "a partial profile patch must not blank the inherited fields"
    );

    assert_eq!(
        iso.persisted_profile(),
        json!({
            "instructions": "Be concise",
            "work": "Staff engineer",
            "details": "Rust rewrite"
        }),
        "the root-session config write must merge the partial profile"
    );

    // An unrelated update still reports the full effective profile.
    let profile = set_config(&mut ws, "steps", &thread_id, json!({ "maxSteps": 42 })).await;
    assert_eq!(profile["instructions"], "Be concise", "{profile}");
    assert_eq!(profile["work"], "Staff engineer", "{profile}");
    assert_eq!(profile["details"], "Rust rewrite", "{profile}");
}

#[tokio::test]
async fn successive_partial_patches_accumulate_in_the_session_override() {
    let iso = Iso::new("cowork-session-config-user-profile-acc-");
    iso.write_workspace_profile();
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    // A stored partial profile that never reached the workspace config (a child session's
    // override, or one hydrated from an earlier run).
    {
        let live = server.runtime().load_thread(&thread_id).unwrap();
        live.lock().config_overrides.insert(
            "userProfile".to_owned(),
            json!({ "work": "Session-only work" }),
        );
    }

    let profile = set_config(
        &mut ws,
        "details",
        &thread_id,
        json!({ "userProfile": { "details": "New details" } }),
    )
    .await;
    assert_eq!(
        profile,
        json!({
            "instructions": "Be concise",
            "work": "Session-only work",
            "details": "New details"
        })
    );
    assert_eq!(
        stored_profile(&server, &thread_id),
        Some(json!({ "work": "Session-only work", "details": "New details" })),
        "a later partial patch must merge into, not replace, the stored profile"
    );
}

#[tokio::test]
async fn empty_string_and_null_fields_clear_only_those_fields() {
    let iso = Iso::new("cowork-session-config-user-profile-clear-");
    iso.write_workspace_profile();
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    let profile = set_config(
        &mut ws,
        "clear",
        &thread_id,
        json!({ "userProfile": { "instructions": "", "details": null } }),
    )
    .await;
    assert_eq!(
        profile,
        json!({ "instructions": "", "work": "Systems engineer", "details": "" })
    );
    assert_eq!(
        iso.persisted_profile(),
        json!({ "instructions": "", "work": "Systems engineer", "details": "" })
    );
}
