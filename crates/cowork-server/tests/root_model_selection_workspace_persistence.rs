//! `cowork/session/model/set` on a root session writes the selection to the workspace defaults.
//!
//! TS `SessionRegistry.buildSessionCommon` gave root sessions a `persistModelSelectionImpl` that
//! wrote `ProviderAuthManager.prepareModelSelection`'s `persistSelection` (provider, model and
//! the re-normalized child routing) through `persistProjectConfigPatch`; child (`agent`)
//! sessions had none, so their switches stayed session-local. Without the write, the CLI's
//! `/provider` + `/model` followed by `/new` (a bare `thread/start`) reverted to the old model.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use cowork_storage::SessionKind;
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

    fn write_workspace_config(&self, config: Value) {
        fs::write(self.workspace_config_path(), config.to_string()).unwrap();
    }

    fn workspace_config(&self) -> Option<Value> {
        let raw = fs::read_to_string(self.workspace_config_path()).ok()?;
        Some(serde_json::from_str(&raw).unwrap())
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
                "clientInfo": { "name": "root-model-selection-persistence", "version": "1.0.0" },
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

/// Sends a request and returns its response, collecting notifications seen meanwhile.
async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifications: &mut Vec<Value>,
) -> Value {
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
            if val.get("method").is_some() {
                notifications.push(val);
            }
        }
    }
}

/// Starts a thread with no provider/model override (the CLI's `/new`) and returns
/// `(id, provider, model)`.
async fn start_bare_thread(
    ws: &mut WsStream,
    iso: &Iso,
    id: &str,
    notifications: &mut Vec<Value>,
) -> (String, String, String) {
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let started = call(ws, id, "thread/start", json!({ "cwd": cwd }), notifications).await;
    let thread = &started["result"]["thread"];
    let thread_id = thread["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned();
    (
        thread_id,
        thread["modelProvider"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        thread["model"].as_str().unwrap_or_default().to_owned(),
    )
}

async fn set_model(
    ws: &mut WsStream,
    id: &str,
    thread_id: &str,
    provider: &str,
    model: &str,
    notifications: &mut Vec<Value>,
) -> Value {
    let res = call(
        ws,
        id,
        "cowork/session/model/set",
        json!({ "threadId": thread_id, "provider": provider, "model": model }),
        notifications,
    )
    .await;
    assert!(res.get("error").is_none(), "model/set failed: {res}");
    assert_eq!(res["result"]["event"]["type"], "config_updated", "{res}");
    res
}

#[tokio::test]
async fn root_model_switch_persists_workspace_defaults_for_the_next_thread() {
    let iso = Iso::new("cowork-root-model-persist-");
    iso.write_workspace_config(json!({
        "provider": "google",
        "model": "gemini-3.1-pro-preview",
        "enableMemory": false
    }));
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut notifs = Vec::new();

    let (thread_id, provider, model) =
        start_bare_thread(&mut ws, &iso, "start-1", &mut notifs).await;
    assert_eq!(
        (provider.as_str(), model.as_str()),
        ("google", "gemini-3.1-pro-preview")
    );

    set_model(&mut ws, "set", &thread_id, "openai", "gpt-5.4", &mut notifs).await;

    let persisted = iso.workspace_config().expect("workspace config written");
    assert_eq!(persisted["provider"], "openai", "{persisted}");
    assert_eq!(persisted["model"], "gpt-5.4", "{persisted}");
    // The child routing follows the new selection (the provider changed, so a same-provider
    // preference cannot survive), as `prepareModelSelection`'s `persistSelection` wrote it.
    assert_eq!(persisted["preferredChildModel"], "gpt-5.4", "{persisted}");
    assert_eq!(
        persisted["preferredChildModelRef"], "openai:gpt-5.4",
        "{persisted}"
    );
    assert_eq!(
        persisted["childModelRoutingMode"], "same-provider",
        "{persisted}"
    );
    // Unrelated workspace keys are kept.
    assert_eq!(persisted["enableMemory"], false, "{persisted}");
    assert!(
        !notifs.iter().any(|n| n["method"] == "error"),
        "a successful write must not report an error: {notifs:?}"
    );

    // The next bare `thread/start` (the CLI's `/new`) starts on the new selection.
    let (_, provider, model) = start_bare_thread(&mut ws, &iso, "start-2", &mut notifs).await;
    assert_eq!((provider.as_str(), model.as_str()), ("openai", "gpt-5.4"));

    // Re-selecting the current model is a no-op: workspace edits made meanwhile survive.
    let mut edited = persisted.clone();
    edited["model"] = json!("gpt-5.4-mini");
    iso.write_workspace_config(edited);
    set_model(
        &mut ws,
        "same",
        &thread_id,
        "openai",
        "gpt-5.4",
        &mut notifs,
    )
    .await;
    assert_eq!(
        iso.workspace_config().unwrap()["model"],
        "gpt-5.4-mini",
        "an unchanged selection must not rewrite the workspace defaults"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn child_session_model_switch_stays_session_local() {
    let iso = Iso::new("cowork-child-model-local-");
    let initial = json!({ "provider": "google", "model": "gemini-3.1-pro-preview" });
    iso.write_workspace_config(initial.clone());
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut notifs = Vec::new();

    let (thread_id, _, _) = start_bare_thread(&mut ws, &iso, "start-1", &mut notifs).await;
    {
        let live = server.runtime().get_live_thread(&thread_id).unwrap();
        live.lock().session_kind = SessionKind::Agent;
    }

    set_model(&mut ws, "set", &thread_id, "openai", "gpt-5.4", &mut notifs).await;
    {
        let live = server.runtime().get_live_thread(&thread_id).unwrap();
        let live = live.lock();
        assert_eq!(live.provider.as_str(), "openai");
        assert_eq!(live.model, "gpt-5.4");
    }
    assert_eq!(
        iso.workspace_config().unwrap(),
        initial,
        "a child session's model switch must not touch the workspace config"
    );

    let (_, provider, model) = start_bare_thread(&mut ws, &iso, "start-2", &mut notifs).await;
    assert_eq!(
        (provider.as_str(), model.as_str()),
        ("google", "gemini-3.1-pro-preview")
    );
    server.shutdown().await;
}

#[tokio::test]
async fn failed_workspace_write_keeps_the_session_switch_and_reports_an_error() {
    let iso = Iso::new("cowork-root-model-persist-fail-");
    iso.write_workspace_config(json!({ "provider": "google", "model": "gemini-3.1-pro-preview" }));
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut notifs = Vec::new();

    let (thread_id, _, _) = start_bare_thread(&mut ws, &iso, "start-1", &mut notifs).await;

    // Make the workspace config unwritable: replace `config.json` with a directory.
    fs::remove_file(iso.workspace_config_path()).unwrap();
    fs::create_dir_all(iso.workspace_config_path()).unwrap();

    let res = set_model(&mut ws, "set", &thread_id, "openai", "gpt-5.4", &mut notifs).await;
    assert_eq!(
        res["result"]["event"]["config"]["model"], "gpt-5.4",
        "{res}"
    );
    {
        let live = server.runtime().get_live_thread(&thread_id).unwrap();
        let live = live.lock();
        assert_eq!(live.provider.as_str(), "openai");
        assert_eq!(live.model, "gpt-5.4");
    }
    let error = notifs
        .iter()
        .find(|n| n["method"] == "error")
        .unwrap_or_else(|| panic!("expected an error notification: {notifs:?}"));
    assert_eq!(error["params"]["sessionId"], thread_id.as_str(), "{error}");
    assert_eq!(error["params"]["code"], "internal_error", "{error}");
    assert_eq!(error["params"]["source"], "session", "{error}");
    assert!(
        error["params"]["message"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Model updated for this session, but failed to persist defaults:"),
        "{error}"
    );
    server.shutdown().await;
}

/// Every client subscribed to the thread hears about a model switch, not only the requester
/// (TS `applyPreparedModelSelection` emitted it through the notification projector).
#[tokio::test]
async fn model_switch_is_broadcast_to_other_subscribed_clients() {
    let iso = Iso::new("cowork-model-broadcast-");
    iso.write_workspace_config(json!({
        "provider": "google",
        "model": "gemini-3.1-pro-preview",
        "enableMemory": false
    }));
    let server = start_server(iso.options()).await.unwrap();
    let mut first = connect(server.ws_url()).await;
    let mut second = connect(server.ws_url()).await;
    let mut first_notifs = Vec::new();
    let mut second_notifs = Vec::new();

    let (thread_id, _, _) = start_bare_thread(&mut first, &iso, "start", &mut first_notifs).await;
    let resumed = call(
        &mut second,
        "resume",
        "thread/resume",
        json!({ "threadId": thread_id }),
        &mut second_notifs,
    )
    .await;
    assert!(
        resumed.get("error").is_none(),
        "thread/resume failed: {resumed}"
    );
    second_notifs.clear();

    set_model(
        &mut first,
        "set",
        &thread_id,
        "openai",
        "gpt-5.4",
        &mut first_notifs,
    )
    .await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let update = loop {
        if let Some(found) = second_notifs
            .iter()
            .find(|n| n["method"] == "cowork/session/configUpdated")
        {
            break found.clone();
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = tokio::time::timeout(remaining, second.next())
            .await
            .expect("second client never received cowork/session/configUpdated")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                second_notifs.push(val);
            }
        }
    };
    assert_eq!(update["params"]["type"], "config_updated", "{update}");
    assert_eq!(update["params"]["sessionId"], json!(thread_id), "{update}");
    assert_eq!(update["params"]["config"]["provider"], "openai", "{update}");
    assert_eq!(update["params"]["config"]["model"], "gpt-5.4", "{update}");
}
