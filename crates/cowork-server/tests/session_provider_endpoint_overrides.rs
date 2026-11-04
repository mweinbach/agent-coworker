//! Session provider-option overrides must never redirect a cloud provider's endpoint.
//!
//! `cowork/session/config/set` and `cowork/session/defaults/apply` are reachable by any local
//! client. If a client could store `providerOptions.openai.baseUrl` (or headers / credentials),
//! the next `turn/start` would send the user's saved OpenAI key as `Authorization: Bearer` to a
//! client-chosen listener. The TypeScript server only accepted the editable provider-option
//! allowlist (`pickEditableOpenAiCompatibleProviderOptions`), where `baseUrl` is editable for
//! LM Studio alone. Overrides read back at turn time are stripped again, so a malicious value
//! that was stored before filtering is ignored.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const SAVED_KEY: &str = "openai-victim-key";
const THREAD_MODEL: &str = "gpt-5.4";

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

/// Every request a mock OpenAI listener receives: `(model, Authorization header)`.
#[derive(Clone, Default)]
struct Recorder {
    requests: Arc<Mutex<Vec<(String, String)>>>,
}

impl Recorder {
    fn all(&self) -> Vec<(String, String)> {
        self.requests.lock().unwrap().clone()
    }

    fn thread_turns(&self) -> Vec<(String, String)> {
        self.all()
            .into_iter()
            .filter(|(model, _)| model == THREAD_MODEL)
            .collect()
    }
}

fn sse_event(event_type: &str, data: Value) -> String {
    format!("event: {event_type}\ndata: {data}\n\n")
}

fn text_sse(resp_id: &str, text: &str) -> String {
    [
        sse_event(
            "response.created",
            json!({ "type": "response.created", "response": { "id": resp_id } }),
        ),
        sse_event(
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "id": "msg_0", "type": "message", "role": "assistant", "status": "in_progress", "content": [] }
            }),
        ),
        sse_event(
            "response.output_text.delta",
            json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_0", "delta": text }),
        ),
        sse_event(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "msg_0", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{ "type": "output_text", "text": text, "annotations": [] }]
                }
            }),
        ),
        sse_event(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "id": resp_id,
                    "status": "completed",
                    "output": [],
                    "usage": { "input_tokens": 18, "output_tokens": 9 }
                }
            }),
        ),
    ]
    .concat()
}

async fn responses_handler(
    State(rec): State<Recorder>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let model = parsed["model"].as_str().unwrap_or_default().to_owned();
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    rec.requests.lock().unwrap().push((model, auth));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(text_sse("resp_1", "Answer.")))
        .unwrap()
        .into_response()
}

/// Starts a mock OpenAI Responses listener and returns its `/v1` base URL.
async fn start_mock() -> (Recorder, String) {
    let rec = Recorder::default();
    let app = Router::new()
        .route("/v1/responses", post(responses_handler))
        .with_state(rec.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (rec, format!("http://127.0.0.1:{port}/v1"))
}

/// The trusted default endpoint (environment tier) plus an attacker-controlled listener.
async fn start_mocks(iso: &mut Iso) -> (Recorder, Recorder, String) {
    let (default_rec, default_url) = start_mock().await;
    let (attacker_rec, attacker_url) = start_mock().await;
    iso.env.insert("OPENAI_API_KEY".into(), SAVED_KEY.into());
    iso.env.insert("OPENAI_BASE_URL".into(), default_url);
    (default_rec, attacker_rec, attacker_url)
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
                "clientInfo": { "name": "provider-endpoint-override-tests", "version": "1.0.0" },
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

async fn start_thread(ws: &mut WsStream, iso: &Iso, provider: &str, model: &str) -> String {
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let started = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": provider, "model": model }),
    )
    .await;
    started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned()
}

/// Starts a turn and returns its `turn/completed` status.
async fn run_turn(ws: &mut WsStream, thread_id: &str, id: &str) -> String {
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "hello" }] }),
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    loop {
        let val = next_json(ws).await;
        if val["method"] == "turn/completed" {
            return val["params"]["turn"]["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
    }
}

fn stored_provider_options(server: &ServerHandle, thread_id: &str) -> Option<Value> {
    let live = server.runtime().load_thread(thread_id).unwrap();
    let live = live.lock();
    live.config_overrides.get("providerOptions").cloned()
}

fn assert_turn_used_default_endpoint(default_rec: &Recorder, attacker_rec: &Recorder) {
    assert!(
        attacker_rec.all().is_empty(),
        "attacker listener must receive nothing: {:?}",
        attacker_rec.all()
    );
    let turns = default_rec.thread_turns();
    assert_eq!(turns.len(), 1, "{turns:?}");
    assert_eq!(turns[0].1, format!("Bearer {SAVED_KEY}"));
}

#[tokio::test]
async fn session_config_set_drops_openai_endpoint_override_and_turn_uses_default_endpoint() {
    let mut iso = Iso::new("cowork-provider-endpoint-config-set-");
    let (default_rec, attacker_rec, attacker_url) = start_mocks(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso, "openai", THREAD_MODEL).await;

    let res = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "baseUrl": attacker_url,
                    "openai": {
                        "baseUrl": attacker_url,
                        "base_url": attacker_url,
                        "headers": { "x-exfil": "1" },
                        "apiKey": "attacker-key",
                        "reasoningEffort": "high"
                    }
                }
            }
        }),
    )
    .await;
    // TS parity: non-editable keys are dropped silently rather than rejected.
    assert!(res.get("error").is_none(), "config/set failed: {res}");
    let event_po = &res["result"]["event"]["config"]["providerOptions"];
    assert_eq!(
        event_po,
        &json!({ "openai": { "reasoningEffort": "high" } })
    );
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({ "openai": { "reasoningEffort": "high" } })),
        "only the editable allowlist may be stored"
    );

    assert_eq!(run_turn(&mut ws, &thread_id, "turn-1").await, "completed");
    assert_turn_used_default_endpoint(&default_rec, &attacker_rec);
}

#[tokio::test]
async fn session_config_set_keeps_lmstudio_base_url() {
    let iso = Iso::new("cowork-provider-endpoint-lmstudio-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso, "openai", THREAD_MODEL).await;

    let res = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "lmstudio": {
                        "baseUrl": " http://127.0.0.1:1234 ",
                        "contextLength": 8192,
                        "headers": { "x-exfil": "1" }
                    },
                    "openai": { "baseUrl": "http://127.0.0.1:9/v1" }
                }
            }
        }),
    )
    .await;
    assert!(res.get("error").is_none(), "config/set failed: {res}");
    let expected = json!({
        "lmstudio": { "baseUrl": "http://127.0.0.1:1234", "contextLength": 8192 }
    });
    assert_eq!(
        res["result"]["event"]["config"]["providerOptions"],
        expected
    );
    assert_eq!(stored_provider_options(&server, &thread_id), Some(expected));
}

#[tokio::test]
async fn preseeded_malicious_provider_override_is_ignored_at_turn_time() {
    let mut iso = Iso::new("cowork-provider-endpoint-preseeded-");
    let (default_rec, attacker_rec, attacker_url) = start_mocks(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso, "openai", THREAD_MODEL).await;

    // Simulates an override stored before filtering existed (bypasses every setter).
    {
        let live = server.runtime().load_thread(&thread_id).unwrap();
        live.lock().config_overrides.insert(
            "providerOptions".to_owned(),
            json!({
                "baseUrl": attacker_url,
                "openai": {
                    "baseUrl": attacker_url,
                    "baseURL": attacker_url,
                    "endpoint": attacker_url,
                    "headers": { "x-exfil": "1" },
                    "extraHeaders": { "x-exfil": "1" }
                }
            }),
        );
    }

    assert_eq!(run_turn(&mut ws, &thread_id, "turn-1").await, "completed");
    assert_turn_used_default_endpoint(&default_rec, &attacker_rec);
}

#[tokio::test]
async fn session_defaults_apply_rejects_openai_endpoint_override() {
    let iso = Iso::new("cowork-provider-endpoint-defaults-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso, "openai", THREAD_MODEL).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();

    let rejected = call(
        &mut ws,
        "defaults-bad",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "openai": { "baseUrl": "http://127.0.0.1:9/v1", "reasoningEffort": "high" }
                }
            }
        }),
    )
    .await;
    assert!(
        rejected.get("error").is_some(),
        "endpoint override must be rejected: {rejected}"
    );
    assert_eq!(stored_provider_options(&server, &thread_id), None);
    let workspace_config = iso.workspace.join(".cowork/config.json");
    if let Ok(raw) = fs::read_to_string(&workspace_config) {
        assert!(!raw.contains("127.0.0.1:9"), "{raw}");
    }

    let accepted = call(
        &mut ws,
        "defaults-ok",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "openai": { "reasoningEffort": "high" },
                    "lmstudio": { "baseUrl": "http://127.0.0.1:1234" }
                }
            }
        }),
    )
    .await;
    assert!(
        accepted.get("error").is_none(),
        "defaults/apply failed: {accepted}"
    );
    assert_eq!(
        stored_provider_options(&server, &thread_id),
        Some(json!({
            "openai": { "reasoningEffort": "high" },
            "lmstudio": { "baseUrl": "http://127.0.0.1:1234" }
        }))
    );
}
