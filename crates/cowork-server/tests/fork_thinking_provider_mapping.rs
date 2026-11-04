//! `thread/fork { thinking }` maps the requested level onto the target provider's own reasoning
//! option (`buildThreadReasoningOptionsPatch` in `src/models/threadReasoningOptions.ts`):
//! OpenAI/Codex `reasoningEffort`, Google `thinkingConfig.thinkingLevel`, and an error for every
//! other provider or an unsupported level.

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

const GOOGLE_MODEL: &str = "gemini-3.1-pro-preview";

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-fork-thinking-")
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

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
    }

    fn write_workspace_config(&self, config: Value) {
        let dir = self.workspace.join(".cowork");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.json"), config.to_string()).unwrap();
    }
}

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

async fn start_google_mock(iso: &mut Iso) -> MockState {
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
                "clientInfo": { "name": "fork-thinking-tests", "version": "1.0.0" },
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

async fn call_collecting(
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

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    call_collecting(ws, id, method, params, &mut Vec::new()).await
}

async fn run_turn(ws: &mut WsStream, thread_id: &str, text: &str, id: &str) {
    let mut notifs = Vec::new();
    let res = call_collecting(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": text }] }),
        &mut notifs,
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !notifs.iter().any(|n| n["method"] == "turn/completed") {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!rem.is_zero(), "timed out waiting for turn/completed");
        if let Ok(Some(Ok(WsMessage::Text(txt)))) = tokio::time::timeout(rem, ws.next()).await
            && let Ok(val) = serde_json::from_str::<Value>(&txt)
            && val.get("method").is_some()
        {
            notifs.push(val);
        }
    }
}

async fn start_thread(ws: &mut WsStream, cwd: &str, provider: &str, model: &str) -> String {
    let res = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": provider, "model": model }),
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

async fn fork(ws: &mut WsStream, thread_id: &str, thinking: &str) -> Value {
    call(
        ws,
        "fork",
        "thread/fork",
        json!({ "threadId": thread_id, "thinking": thinking }),
    )
    .await
}

fn forked_id(res: &Value) -> String {
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/fork failed: {res}"))
        .to_owned()
}

fn stored_provider_section(
    server: &cowork_server::ServerHandle,
    thread_id: &str,
    provider: &str,
) -> Option<Value> {
    let live = server.runtime().load_thread(thread_id).unwrap();
    live.lock()
        .config_overrides
        .get("providerOptions")
        .and_then(|po| po.get(provider))
        .cloned()
}

fn last_turn_body(mock: &MockState) -> Value {
    let bodies = mock.bodies.lock().unwrap();
    bodies
        .iter()
        .rev()
        .find(|b| b["model"] == GOOGLE_MODEL)
        .cloned()
        .unwrap_or_else(|| panic!("no google request for {GOOGLE_MODEL}: {bodies:?}"))
}

/// The source thread's inherited `google.thinkingConfig.thinkingLevel` must be overridden by the
/// fork's `thinking`, since the Google request builder prefers it over `reasoningEffort`.
#[tokio::test]
async fn google_fork_thinking_overrides_inherited_thinking_level() {
    let mut iso = Iso::new();
    let mock = start_google_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();

    let source = start_thread(&mut ws, &cwd, "google", GOOGLE_MODEL).await;
    let cfg = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": source,
            "config": {
                "providerOptions": { "google": { "thinkingConfig": { "thinkingLevel": "high" } } }
            }
        }),
    )
    .await;
    assert!(cfg.get("error").is_none(), "config/set failed: {cfg}");

    let res = fork(&mut ws, &source, "low").await;
    let fork_id = forked_id(&res);
    assert_eq!(
        stored_provider_section(&server, &fork_id, "google").and_then(|g| g
            .get("thinkingConfig")
            .and_then(|t| t.get("thinkingLevel"))
            .cloned()),
        Some(json!("low")),
    );
    // The source thread keeps its own level.
    assert_eq!(
        stored_provider_section(&server, &source, "google").and_then(|g| {
            g["thinkingConfig"]["thinkingLevel"]
                .as_str()
                .map(str::to_owned)
        }),
        Some("high".to_owned()),
    );

    run_turn(&mut ws, &fork_id, "hello", "turn-1").await;
    let body = last_turn_body(&mock);
    assert_eq!(
        body["generation_config"]["thinking_level"], "low",
        "fork thinking must override the inherited thinking level: {body}"
    );
    server.shutdown().await;
}

/// A workspace-configured `google.thinkingConfig` is overridden too, keeping its other keys
/// (`{ ...current.thinkingConfig, thinkingLevel }`).
#[tokio::test]
async fn google_fork_thinking_overrides_workspace_thinking_level() {
    let mut iso = Iso::new();
    iso.write_workspace_config(json!({
        "provider": "google",
        "model": GOOGLE_MODEL,
        "providerOptions": {
            "google": { "thinkingConfig": { "thinkingLevel": "high", "includeThoughts": false } }
        }
    }));
    let mock = start_google_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();

    let source = start_thread(&mut ws, &cwd, "google", GOOGLE_MODEL).await;
    run_turn(&mut ws, &source, "hello", "turn-src").await;
    assert_eq!(
        last_turn_body(&mock)["generation_config"]["thinking_level"],
        "high",
        "precondition: the workspace level applies to the source thread"
    );

    let fork_id = forked_id(&fork(&mut ws, &source, "low").await);
    run_turn(&mut ws, &fork_id, "hello", "turn-fork").await;
    let body = last_turn_body(&mock);
    assert_eq!(
        body["generation_config"]["thinking_level"], "low",
        "fork thinking must override the workspace thinking level: {body}"
    );
    assert_eq!(
        body["generation_config"]["thinking_summaries"], "none",
        "the workspace includeThoughts=false must survive the override: {body}"
    );
    server.shutdown().await;
}

/// OpenAI keeps `reasoningEffort`; unsupported levels and providers are rejected before the
/// fork is created.
#[tokio::test]
async fn fork_thinking_validates_level_and_provider() {
    let iso = Iso::new();
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();

    let openai = start_thread(&mut ws, &cwd, "openai", "gpt-5-mini").await;
    let fork_id = forked_id(&fork(&mut ws, &openai, "low").await);
    assert_eq!(
        stored_provider_section(&server, &fork_id, "openai")
            .and_then(|o| o.get("reasoningEffort").cloned()),
        Some(json!("low")),
    );

    let count_before = server.runtime().active_session_count();
    let cases = [
        (
            openai.clone(),
            "dynamic",
            "Unsupported reasoning effort for openai: dynamic",
        ),
        (
            openai.clone(),
            "xhigh",
            "Unsupported reasoning effort for openai:gpt-5-mini: xhigh. Supported efforts: none, minimal, low, medium, high",
        ),
    ];
    for (thread, thinking, message) in cases {
        let res = fork(&mut ws, &thread, thinking).await;
        assert_eq!(res["error"]["message"], message, "{res}");
    }

    let google = start_thread(&mut ws, &cwd, "google", GOOGLE_MODEL).await;
    let nvidia = start_thread(&mut ws, &cwd, "nvidia", "moonshotai/kimi-k2-instruct").await;
    let count_before = count_before + 2;
    let cases = [
        (
            google.clone(),
            "xhigh",
            "Unsupported Google thinking level: xhigh".to_owned(),
        ),
        (
            google.clone(),
            "minimal",
            format!(
                "Unsupported reasoning effort for google:{GOOGLE_MODEL}: minimal. Supported efforts: dynamic, low, medium, high"
            ),
        ),
        (
            nvidia.clone(),
            "high",
            "Reasoning/thinking overrides are not supported for provider nvidia".to_owned(),
        ),
    ];
    for (thread, thinking, message) in cases {
        let res = fork(&mut ws, &thread, thinking).await;
        assert_eq!(res["error"]["message"], json!(message), "{res}");
    }
    assert_eq!(
        server.runtime().active_session_count(),
        count_before,
        "a rejected fork must not create a thread"
    );
    server.shutdown().await;
}
