//! The `session_config` event reports the session's effective editable `providerOptions`: the
//! thread's stored override layered over the inherited workspace options, merged one provider
//! section deep exactly as the turn runner merges them before a turn.
//!
//! TS `getSessionConfigEvent` emitted `pickEditableOpenAiCompatibleProviderOptions` of the
//! session's `state.config.providerOptions`, which started from the workspace config and had
//! each patch merged into it. The desktop replaces its `sessionConfig` with this event and
//! `ChatView` reads the Google reasoning selection from it, so a partial override (e.g. only
//! `google.nativeWebSearch`) must not hide an inherited `google.thinkingConfig`.

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

    /// Writes the workspace `.cowork/config.json` with an inherited Google thinking level.
    fn write_workspace_thinking_level(&self, level: &str) {
        fs::write(
            self.workspace.join(".cowork").join("config.json"),
            json!({
                "provider": "google",
                "providerOptions": {
                    "google": { "thinkingConfig": { "thinkingLevel": level } }
                }
            })
            .to_string(),
        )
        .unwrap();
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
                "clientInfo": { "name": "session-config-inherited-options", "version": "1.0.0" },
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

/// Sends `cowork/session/config/set` and returns the emitted event's `config.providerOptions`.
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
    res["result"]["event"]["config"]["providerOptions"].clone()
}

fn seed_provider_options(server: &ServerHandle, thread_id: &str, value: Value) {
    let live = server.runtime().load_thread(thread_id).unwrap();
    live.lock()
        .config_overrides
        .insert("providerOptions".to_owned(), value);
}

#[tokio::test]
async fn partial_google_override_keeps_inherited_thinking_level_in_event() {
    let iso = Iso::new("cowork-session-config-inherited-po-");
    iso.write_workspace_thinking_level("high");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    let po = set_config(
        &mut ws,
        "web-search",
        &thread_id,
        json!({ "providerOptions": { "google": { "nativeWebSearch": true } } }),
    )
    .await;
    assert_eq!(po["google"]["nativeWebSearch"], json!(true), "{po}");
    assert_eq!(
        po["google"]["thinkingConfig"]["thinkingLevel"],
        json!("high"),
        "the inherited workspace thinking level must survive a partial override: {po}"
    );

    // The session override itself stays partial; the merge happens when reporting.
    let live = server.runtime().load_thread(&thread_id).unwrap();
    assert_eq!(
        live.lock().config_overrides.get("providerOptions"),
        Some(&json!({ "google": { "nativeWebSearch": true } }))
    );
}

#[tokio::test]
async fn unrelated_config_update_reports_merged_options_without_persisting_them() {
    let iso = Iso::new("cowork-session-config-inherited-po-seed-");
    iso.write_workspace_thinking_level("high");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    // A stored partial override (e.g. hydrated from an earlier run) that was never written to
    // the workspace config.
    seed_provider_options(
        &server,
        &thread_id,
        json!({ "google": { "nativeWebSearch": true }, "codeMode": true }),
    );

    let po = set_config(&mut ws, "steps", &thread_id, json!({ "maxSteps": 42 })).await;
    assert_eq!(po["google"]["nativeWebSearch"], json!(true), "{po}");
    assert_eq!(
        po["google"]["thinkingConfig"]["thinkingLevel"],
        json!("high"),
        "{po}"
    );
    // Session tool-exposure toggles are not editable provider options.
    assert!(po.get("codeMode").is_none(), "{po}");
}

#[tokio::test]
async fn session_override_key_wins_over_inherited_workspace_value() {
    let iso = Iso::new("cowork-session-config-inherited-po-override-");
    iso.write_workspace_thinking_level("high");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso).await;

    seed_provider_options(
        &server,
        &thread_id,
        json!({ "google": { "thinkingConfig": { "thinkingLevel": "low" } } }),
    );
    let po = set_config(&mut ws, "steps", &thread_id, json!({ "maxSteps": 7 })).await;
    assert_eq!(
        po["google"]["thinkingConfig"]["thinkingLevel"],
        json!("low"),
        "{po}"
    );
}
