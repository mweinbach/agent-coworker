//! A cloned repository's `.cowork/config.json` must not route LM Studio turns to a remote host.
//!
//! The project tier may set `providerOptions.lmstudio.baseUrl` only to a loopback server
//! (`isLoopbackBaseUrl` in `src/providers/lmstudio/local.ts`); any other value is dropped at
//! config load, so the turn uses the trusted tiers instead (user config, then the
//! `LM_STUDIO_BASE_URL` environment pin, which always wins).
//!
//! The "remote" URL uses IPv4-mapped IPv6. Its hostname falls outside the trusted set
//! (`localhost`, `127.0.0.1`, `::1`) but reaches the local IPv4 mock on every test host.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Response, StatusCode, Uri, header};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const MODEL: &str = "local-model";

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-ws-lmstudio-trust-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
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

    fn write_user_lmstudio_base_url(&self, url: &str) {
        write_json(
            &self.home.join(".cowork/config/config.json"),
            &json!({ "providerOptions": { "lmstudio": { "baseUrl": url } } }),
        );
    }

    fn write_workspace_lmstudio_base_url(&self, url: &str) {
        write_json(
            &self.workspace.join(".cowork/config.json"),
            &json!({
                "provider": "lmstudio",
                "model": MODEL,
                "providerOptions": { "lmstudio": { "baseUrl": url } }
            }),
        );
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

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

/// Every request path a mock LM Studio listener receives.
#[derive(Clone, Default)]
struct Recorder {
    paths: Arc<Mutex<Vec<String>>>,
}

impl Recorder {
    fn all(&self) -> Vec<String> {
        self.paths.lock().unwrap().clone()
    }

    fn chat_requests(&self) -> usize {
        self.all()
            .iter()
            .filter(|p| p.ends_with("/chat/completions"))
            .count()
    }
}

async fn mock_handler(
    State(rec): State<Recorder>,
    uri: Uri,
    _headers: HeaderMap,
) -> Response<Body> {
    let path = uri.path().to_owned();
    rec.paths.lock().unwrap().push(path.clone());
    if path == "/v1/models" {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "object": "list", "data": [{ "id": MODEL, "object": "model" }] })
                    .to_string(),
            ))
            .unwrap();
    }
    if path == "/v1/chat/completions" {
        let sse = concat!(
            "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\n",
            "data: [DONE]\n\n"
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(sse))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap()
}

async fn start_mock() -> (Recorder, String) {
    let rec = Recorder::default();
    let app = Router::new().fallback(mock_handler).with_state(rec.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (rec, format!("http://{addr}"))
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
                "clientInfo": { "name": "workspace-lmstudio-trust-tests", "version": "1.0.0" },
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

async fn next_json(ws: &mut WsStream) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).unwrap();
        }
    }
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
        let val = next_json(ws).await;
        if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
            return val;
        }
    }
}

/// Starts a server for `iso`, runs one LM Studio turn and returns the `turn/start` response
/// (plus the `turn/completed` status when it was accepted).
async fn run_lmstudio_turn(iso: &Iso) -> (Value, Option<String>) {
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let started = call(
        &mut ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "lmstudio", "model": MODEL }),
    )
    .await;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned();
    let res = call(
        &mut ws,
        "turn",
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "hello" }] }),
    )
    .await;
    let mut status = None;
    if res.get("error").is_none() {
        loop {
            let val = next_json(&mut ws).await;
            if val["method"] == "turn/completed" {
                status = val["params"]["turn"]["status"]
                    .as_str()
                    .map(ToOwned::to_owned);
                break;
            }
        }
    }
    server.shutdown().await;
    (res, status)
}

#[tokio::test]
async fn workspace_non_loopback_lmstudio_url_is_ignored_in_favour_of_user_config() {
    let (remote_rec, remote_url) = start_mock().await;
    let (user_rec, user_url) = start_mock().await;
    let remote_port = remote_url.rsplit(':').next().unwrap();

    for workspace_url in [
        format!("http://[::ffff:127.0.0.1]:{remote_port}"),
        format!("http://127.0.0.1@[::ffff:127.0.0.1]:{remote_port}"),
    ] {
        let iso = Iso::new();
        iso.write_user_lmstudio_base_url(&user_url);
        iso.write_workspace_lmstudio_base_url(&workspace_url);
        let before = user_rec.chat_requests();

        let (res, status) = run_lmstudio_turn(&iso).await;
        assert!(res.get("error").is_none(), "{workspace_url}: {res}");
        assert_eq!(status.as_deref(), Some("completed"), "{workspace_url}");
        assert!(
            remote_rec.all().is_empty(),
            "{workspace_url}: the workspace-chosen remote listener must receive nothing: {:?}",
            remote_rec.all()
        );
        assert_eq!(user_rec.chat_requests(), before + 1, "{workspace_url}");
    }
}

#[tokio::test]
async fn workspace_loopback_lmstudio_url_is_honoured() {
    let (user_rec, user_url) = start_mock().await;
    let (workspace_rec, workspace_url) = start_mock().await;
    let iso = Iso::new();
    iso.write_user_lmstudio_base_url(&user_url);
    iso.write_workspace_lmstudio_base_url(&workspace_url.replace("127.0.0.1", "localhost"));

    let (res, status) = run_lmstudio_turn(&iso).await;
    assert!(res.get("error").is_none(), "{res}");
    assert_eq!(status.as_deref(), Some("completed"));
    assert_eq!(workspace_rec.chat_requests(), 1);
    assert!(user_rec.all().is_empty(), "{:?}", user_rec.all());
}

#[tokio::test]
async fn lm_studio_base_url_env_pin_wins_over_workspace_config() {
    let (pinned_rec, pinned_url) = start_mock().await;
    let (workspace_rec, workspace_url) = start_mock().await;
    let mut iso = Iso::new();
    iso.env.insert("LM_STUDIO_BASE_URL".into(), pinned_url);
    iso.write_workspace_lmstudio_base_url(&workspace_url);

    let (res, status) = run_lmstudio_turn(&iso).await;
    assert!(res.get("error").is_none(), "{res}");
    assert_eq!(status.as_deref(), Some("completed"));
    assert_eq!(pinned_rec.chat_requests(), 1);
    assert!(workspace_rec.all().is_empty(), "{:?}", workspace_rec.all());
}
