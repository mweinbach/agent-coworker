//! Reasoning-option reconciliation for models known only from the provider discovery cache.
//!
//! A non-bundled Google model whose persisted discovery entry advertises reasoning must keep the
//! user's saved `google.thinkingConfig` across model switches and the pre-turn reconciliation,
//! while a discovered entry without reasoning info still has it pruned
//! (`buildDiscoveredModelMetadata` in `src/models/metadata.ts`).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_config::{
    CachedModelDiscoveryModel, CachedModelReasoning, ModelDiscoveryResult, ModelDiscoverySource,
    ProviderName, get_ai_coworker_paths, write_model_discovery_cache,
};
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

const REASONING_MODEL: &str = "gemini-9-discovered-thinker";
const PLAIN_MODEL: &str = "gemini-9-discovered-plain";

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

    /// Persists a Google discovery cache holding one reasoning and one non-reasoning model.
    async fn seed_google_discovery_cache(&self) {
        let paths = get_ai_coworker_paths(Some(&self.home), &self.env);
        let model = |id: &str, reasoning: Option<CachedModelReasoning>| CachedModelDiscoveryModel {
            id: id.to_owned(),
            model: None,
            display_name: id.to_owned(),
            description: None,
            knowledge_cutoff: None,
            supports_image_input: Some(true),
            is_default: None,
            reasoning,
            runtime_options: None,
            runtime_overrides: None,
        };
        write_model_discovery_cache(
            &paths,
            ProviderName::Google,
            ModelDiscoveryResult {
                provider: ProviderName::Google,
                source: ModelDiscoverySource::Api,
                models: vec![
                    model(
                        REASONING_MODEL,
                        Some(CachedModelReasoning {
                            default_effort: Some("high".into()),
                            available_efforts: Some(vec![
                                "low".into(),
                                "medium".into(),
                                "high".into(),
                            ]),
                        }),
                    ),
                    model(PLAIN_MODEL, None),
                ],
                updated_at: None,
                expires_at: None,
                message: None,
            },
            None,
            None,
        )
        .await
        .expect("write google discovery cache");
    }
}

// ---------------------------------------------------------------------------------------------
// Mock Google Interactions endpoint
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct MockState {
    bodies: Arc<Mutex<Vec<Value>>>,
}

fn gemini_sse(data: Value) -> String {
    format!("data: {data}\n\n")
}

fn text_reply(text: &str) -> String {
    [
        gemini_sse(json!({
            "event_type": "interaction.start",
            "interaction": { "id": "inter_1", "status": "in_progress" }
        })),
        gemini_sse(json!({
            "event_type": "content.start",
            "index": 0,
            "content": { "type": "text", "text": "" }
        })),
        gemini_sse(json!({
            "event_type": "content.delta",
            "index": 0,
            "delta": { "type": "text", "text": text }
        })),
        gemini_sse(json!({ "event_type": "content.stop", "index": 0 })),
        gemini_sse(json!({
            "event_type": "interaction.complete",
            "interaction": {
                "id": "inter_1",
                "status": "completed",
                "usage": { "total_input_tokens": 10, "total_output_tokens": 5, "total_tokens": 15 }
            }
        })),
    ]
    .concat()
}

async fn interactions_handler(
    State(state): State<MockState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    state.bodies.lock().unwrap().push(parsed);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(text_reply("Done.")))
        .unwrap()
        .into_response()
}

async fn start_mock(iso: &mut Iso) -> MockState {
    let state = MockState::default();
    let app = Router::new()
        .route("/v1beta/interactions", post(interactions_handler))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    iso.env.insert(
        "GOOGLE_GENERATIVE_AI_API_KEY".into(),
        "google-test-key".into(),
    );
    iso.env.insert(
        "GEMINI_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1beta"),
    );
    state
}

// ---------------------------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------------------------

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
                "clientInfo": { "name": "discovered-reasoning-tests", "version": "1.0.0" },
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

async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
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
                notifs.push(val);
            }
        }
    }
}

async fn wait_for_method(ws: &mut WsStream, notifs: &mut Vec<Value>, method: &str) {
    if notifs.iter().any(|n| n["method"] == method) {
        return;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        if let Ok(Some(Ok(WsMessage::Text(txt)))) = tokio::time::timeout(rem, ws.next()).await
            && let Ok(val) = serde_json::from_str::<Value>(&txt)
            && val.get("method").is_some()
        {
            let done = val["method"] == method;
            notifs.push(val);
            if done {
                return;
            }
        }
    }
    panic!("timed out waiting for {method}; got {notifs:?}");
}

async fn run_turn(ws: &mut WsStream, thread_id: &str, text: &str, id: &str) {
    let mut notifs = Vec::new();
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": text }] }),
        &mut notifs,
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    wait_for_method(ws, &mut notifs, "turn/completed").await;
}

async fn start_thread(ws: &mut WsStream, cwd: &str, model: &str) -> String {
    let mut notifs = Vec::new();
    let res = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "google", "model": model }),
        &mut notifs,
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

async fn set_thinking_level(ws: &mut WsStream, thread_id: &str, level: &str) {
    let mut ignored = Vec::new();
    let cfg = call(
        ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": level } } }
            }
        }),
        &mut ignored,
    )
    .await;
    assert!(cfg.get("error").is_none(), "config/set failed: {cfg}");
}

async fn switch_model(ws: &mut WsStream, thread_id: &str, model: &str) {
    let mut ignored = Vec::new();
    let set = call(
        ws,
        "model",
        "cowork/session/model/set",
        json!({ "threadId": thread_id, "provider": "google", "model": model }),
        &mut ignored,
    )
    .await;
    assert!(set.get("error").is_none(), "model/set failed: {set}");
}

/// Latest captured turn request for `model` (title-generation requests use another model).
fn last_turn_body(mock: &MockState, model: &str) -> Value {
    let bodies = mock.bodies.lock().unwrap();
    bodies
        .iter()
        .rev()
        .find(|b| b["model"] == model)
        .cloned()
        .unwrap_or_else(|| panic!("no google request for {model}: {bodies:?}"))
}

fn stored_thinking_config(server: &cowork_server::ServerHandle, thread_id: &str) -> Option<Value> {
    let live = server.runtime().load_thread(thread_id).unwrap();
    live.lock()
        .config_overrides
        .get("providerOptions")
        .and_then(|po| po.get("google"))
        .and_then(|g| g.get("thinkingConfig"))
        .cloned()
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/// A discovered Google model that advertises reasoning keeps the saved `thinkingConfig` through
/// the model-switch reconciliation and the pre-turn reconciliation, so the request still carries
/// the user's thinking level.
#[tokio::test]
async fn discovered_reasoning_google_model_keeps_thinking_config() {
    let mut iso = Iso::new("cowork-discovered-reasoning-");
    iso.seed_google_discovery_cache().await;
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();

    // Model switch from a bundled reasoning model onto the discovered reasoning model.
    let thread_id = start_thread(&mut ws, &cwd, "gemini-3.1-pro-preview").await;
    set_thinking_level(&mut ws, &thread_id, "low").await;
    switch_model(&mut ws, &thread_id, REASONING_MODEL).await;
    assert_eq!(
        stored_thinking_config(&server, &thread_id),
        Some(json!({ "thinkingLevel": "low" })),
        "discovered reasoning model must keep the saved thinkingConfig on model switch"
    );

    run_turn(&mut ws, &thread_id, "hello", "turn-1").await;
    {
        let last = last_turn_body(&mock, REASONING_MODEL);
        assert_eq!(
            last["generation_config"]["thinking_level"], "low",
            "pre-turn reconciliation stripped the thinking level: {last}"
        );
    }
    assert_eq!(
        stored_thinking_config(&server, &thread_id),
        Some(json!({ "thinkingLevel": "low" })),
    );

    // A thread started directly on the discovered model only goes through the pre-turn path.
    let direct_id = start_thread(&mut ws, &cwd, REASONING_MODEL).await;
    set_thinking_level(&mut ws, &direct_id, "medium").await;
    run_turn(&mut ws, &direct_id, "hello again", "turn-2").await;
    let last = last_turn_body(&mock, REASONING_MODEL);
    assert_eq!(
        last["generation_config"]["thinking_level"], "medium",
        "{last}"
    );
}

/// A discovered Google model without reasoning info still has `thinkingConfig` pruned, both on
/// model switch and before the turn, so no thinking payload is forwarded.
#[tokio::test]
async fn discovered_non_reasoning_google_model_prunes_thinking_config() {
    let mut iso = Iso::new("cowork-discovered-plain-");
    iso.seed_google_discovery_cache().await;
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();

    let thread_id = start_thread(&mut ws, &cwd, "gemini-3.1-pro-preview").await;
    set_thinking_level(&mut ws, &thread_id, "low").await;
    assert!(stored_thinking_config(&server, &thread_id).is_some());
    switch_model(&mut ws, &thread_id, PLAIN_MODEL).await;
    assert_eq!(
        stored_thinking_config(&server, &thread_id),
        None,
        "non-reasoning discovered model must drop thinkingConfig on model switch"
    );

    // Started directly on the non-reasoning model: the pre-turn reconciliation prunes it.
    let direct_id = start_thread(&mut ws, &cwd, PLAIN_MODEL).await;
    set_thinking_level(&mut ws, &direct_id, "medium").await;
    run_turn(&mut ws, &direct_id, "hello", "turn-1").await;
    let last = last_turn_body(&mock, PLAIN_MODEL);
    let gen_cfg = last.get("generation_config");
    assert!(
        gen_cfg.and_then(|g| g.get("thinking_level")).is_none()
            && gen_cfg.and_then(|g| g.get("thinking_summaries")).is_none(),
        "thinking payload forwarded for a non-reasoning model: {last}"
    );
}
