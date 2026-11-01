//! Regression tests for durable `clientMessageId` idempotency beyond the in-memory cache (and
//! across a restart), explicit turn `references` / normalized `@` mentions on `turn/start` and
//! `turn/steer`, and provider-qualified memory-generation models.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::{get, post};
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

/// Ordered mock chat-completions responses: `(delay_ms, sse_body)` per request; captures bodies.
type Script = Vec<(u64, String)>;

struct Env {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    bodies: Arc<Mutex<Vec<Value>>>,
    /// Requests to the second provider's endpoint: `(body, authorization header)`.
    together: Arc<Mutex<Vec<(Value, String)>>>,
}

impl Env {
    async fn new(script: Script) -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-turn-regress-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let bodies_route = Arc::clone(&bodies);
        let script = Arc::new(script);
        let together: Arc<Mutex<Vec<(Value, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let together_route = Arc::clone(&together);
        let app = Router::new()
        .route(
            "/together/v1/chat/completions",
            post(move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let together = Arc::clone(&together_route);
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    together.lock().unwrap().push((parsed, auth));
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(chat_sse_text("NONE")))
                        .unwrap()
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |body: axum::body::Bytes| {
                let bodies = Arc::clone(&bodies_route);
                let script = Arc::clone(&script);
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    // Background requests without tools (e.g. session-title generation) neither
                    // consume the turn script nor count as turn steps.
                    let is_turn_step = parsed["tools"].as_array().is_some_and(|t| !t.is_empty());
                    let (delay, sse) = if is_turn_step {
                        let idx = {
                            let mut g = bodies.lock().unwrap();
                            g.push(parsed);
                            g.len() - 1
                        };
                        script
                            .get(idx)
                            .cloned()
                            .unwrap_or_else(|| (0, chat_sse_text("done")))
                    } else {
                        (0, chat_sse_text("Generated title"))
                    };
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                }
            }),
        )
        // LM Studio reachability probe: slow, so `turn/start` awaits inside its setup window.
        .route(
            "/v1/models",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                axum::Json(json!({ "object": "list", "data": [{ "id": "local-model", "object": "model" }] }))
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        env.insert(
            "NVIDIA_BASE_URL".into(),
            format!("http://127.0.0.1:{port}/v1"),
        );
        env.insert("NVIDIA_API_KEY".into(), "nvapi-mock-test".into());
        env.insert(
            "TOGETHER_BASE_URL".into(),
            format!("http://127.0.0.1:{port}/together/v1"),
        );
        env.insert("TOGETHER_API_KEY".into(), "together-mock-key".into());
        env.insert(
            "LM_STUDIO_BASE_URL".into(),
            format!("http://127.0.0.1:{port}"),
        );
        Self {
            _root: root,
            home,
            workspace,
            env,
            bodies,
            together,
        }
    }

    fn options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: true,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }

    fn bodies(&self) -> Vec<Value> {
        self.bodies.lock().unwrap().clone()
    }
}

fn chat_sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

async fn connect(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    send(
        &mut ws,
        json!({
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "turn-regress", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
            }
        }),
    )
    .await;
    let _ = ws.next().await.unwrap().unwrap();
    send(&mut ws, json!({ "method": "initialized", "params": {} })).await;
    ws
}

async fn send(ws: &mut WsStream, msg: Value) {
    ws.send(WsMessage::Text(msg.to_string().into()))
        .await
        .unwrap();
}

/// Reads frames until every id in `ids` has a response; notifications go to `notifs`.
async fn await_responses(
    ws: &mut WsStream,
    ids: &[&str],
    notifs: &mut Vec<Value>,
) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    while out.len() < ids.len() {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("response timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            } else if let Some(id) = val.get("id").and_then(Value::as_str)
                && ids.contains(&id)
            {
                out.insert(id.to_owned(), val);
            }
        }
    }
    out
}

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    call_collecting(ws, id, method, params, &mut Vec::new()).await
}

async fn call_collecting(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    await_responses(ws, &[id], notifs).await.remove(id).unwrap()
}

/// Reads notifications until `turn/completed` for `turn_id` (checking `notifs` first).
async fn await_turn_completed(ws: &mut WsStream, turn_id: &str, notifs: &mut Vec<Value>) {
    let done = |v: &Value| {
        v["method"] == "turn/completed" && v["params"]["turn"]["id"].as_str() == Some(turn_id)
    };
    while !notifs.iter().any(done) {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("turn completion timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

async fn start_thread(ws: &mut WsStream, cwd: &std::path::Path) -> String {
    start_thread_with(ws, cwd, "nvidia", "moonshotai/kimi-k2-instruct").await
}

async fn start_thread_with(
    ws: &mut WsStream,
    cwd: &std::path::Path,
    provider: &str,
    model: &str,
) -> String {
    let res = call(
        ws,
        "thread-start",
        "thread/start",
        json!({ "cwd": cwd.to_string_lossy(), "provider": provider, "model": model }),
    )
    .await;
    res["result"]["thread"]["id"].as_str().unwrap().to_owned()
}

fn last_user_message(body: &Value) -> String {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|m| m["role"] == "user")
        .unwrap()
        .to_string()
}

fn write_documents_skill(workspace: &std::path::Path) {
    let dir = workspace.join(".cowork/skills/documents");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: documents\ndescription: Document authoring helper\n---\nDOCUMENTS-SKILL-BODY: use the house style.\n",
    )
    .unwrap();
}

async fn start_turn(ws: &mut WsStream, id: &str, params: Value, notifs: &mut Vec<Value>) -> Value {
    call_collecting(ws, id, "turn/start", params, notifs).await
}

/// More accepted `clientMessageId`s than the in-memory cache holds: a retry of the oldest one
/// must replay its original turn (from the journal receipt) instead of starting a new turn,
/// both in the same process and after a restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn evicted_client_message_id_replays_the_original_turn_across_restart() {
    const TURNS: usize = 257;
    let env = Env::new(Vec::new()).await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let mut first_turn_id = String::new();
    for i in 0..TURNS {
        let mut notifs = Vec::new();
        let res = start_turn(
            &mut ws,
            &format!("t{i}"),
            json!({ "threadId": thread_id, "clientMessageId": format!("cmsg-{i}"), "input": format!("message {i}") }),
            &mut notifs,
        )
        .await;
        let turn_id = res["result"]["turn"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("turn {i} failed: {res}"))
            .to_owned();
        if i == 0 {
            first_turn_id = turn_id.clone();
        }
        await_turn_completed(&mut ws, &turn_id, &mut notifs).await;
    }
    assert_eq!(env.bodies().len(), TURNS);

    let retry = call(
        &mut ws,
        "retry-0",
        "turn/start",
        json!({ "threadId": thread_id, "clientMessageId": "cmsg-0", "input": "message 0" }),
    )
    .await;
    assert_eq!(retry["result"]["replayed"], json!(true), "{retry}");
    assert_eq!(retry["result"]["turn"]["id"], json!(first_turn_id));
    let conflict = call(
        &mut ws,
        "retry-0-conflict",
        "turn/start",
        json!({ "threadId": thread_id, "clientMessageId": "cmsg-0", "input": "different" }),
    )
    .await;
    assert!(conflict.get("error").is_some(), "{conflict}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        env.bodies().len(),
        TURNS,
        "a replay must not reach the provider"
    );

    drop(ws);
    server.shutdown().await;

    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let retry = call(
        &mut ws,
        "retry-0-restarted",
        "turn/start",
        json!({ "threadId": thread_id, "clientMessageId": "cmsg-0", "input": "message 0" }),
    )
    .await;
    assert_eq!(retry["result"]["replayed"], json!(true), "{retry}");
    assert_eq!(retry["result"]["turn"]["id"], json!(first_turn_id));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        env.bodies().len(),
        TURNS,
        "a replay must not reach the provider"
    );
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turn_start_honors_references_and_normalized_mentions() {
    let env = Env::new(Vec::new()).await;
    write_documents_skill(&env.workspace);
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let cases = [
        (
            json!({ "threadId": thread_id, "input": "Write the memo", "references": [{ "kind": "skill", "name": "documents" }] }),
            true,
        ),
        (
            json!({ "threadId": thread_id, "input": "Draft it with @Documents." }),
            true,
        ),
        (
            json!({ "threadId": thread_id, "input": "No skill here" }),
            false,
        ),
    ];
    for (i, (params, expect_skill)) in cases.into_iter().enumerate() {
        let mut notifs = Vec::new();
        let res = start_turn(&mut ws, &format!("ref-{i}"), params, &mut notifs).await;
        let turn_id = res["result"]["turn"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("turn {i} failed: {res}"))
            .to_owned();
        await_turn_completed(&mut ws, &turn_id, &mut notifs).await;
        let bodies = env.bodies();
        let last_user = last_user_message(bodies.last().unwrap());
        assert_eq!(
            last_user.contains("DOCUMENTS-SKILL-BODY"),
            expect_skill,
            "case {i}: {last_user}"
        );
    }

    let bad = call(
        &mut ws,
        "ref-bad",
        "turn/start",
        json!({ "threadId": thread_id, "input": "x", "references": [{ "kind": "tool", "name": "documents" }] }),
    )
    .await;
    assert_eq!(bad["error"]["code"], json!(-32602), "{bad}");
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turn_steer_with_reference_injects_the_skill() {
    let env = Env::new(vec![
        (1500, chat_sse_text("first pass")),
        (0, chat_sse_text("steered")),
    ])
    .await;
    write_documents_skill(&env.workspace);
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let mut notifs = Vec::new();
    let res = start_turn(
        &mut ws,
        "t1",
        json!({ "threadId": thread_id, "input": "start" }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    let steer = call_collecting(
        &mut ws,
        "steer",
        "turn/steer",
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "clientMessageId": "steer-1",
            "input": "STEER-TEXT switch format",
            "references": [{ "kind": "skill", "name": "documents" }]
        }),
        &mut notifs,
    )
    .await;
    assert!(steer.get("result").is_some(), "turn/steer failed: {steer}");
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;

    let bodies = env.bodies();
    assert!(!bodies.is_empty() && bodies.len() <= 2, "{}", bodies.len());
    let last_user = last_user_message(&bodies[bodies.len() - 1]);
    assert!(last_user.contains("STEER-TEXT"), "{last_user}");
    assert!(
        last_user.contains("Reference context for this steer"),
        "{last_user}"
    );
    assert!(last_user.contains("DOCUMENTS-SKILL-BODY"), "{last_user}");
    server.shutdown().await;
}

/// `memoryGenerationModel` is persisted provider-qualified (`together:mem-model`): the memory
/// request must go to that provider's endpoint with its credentials and the bare model ID.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provider_qualified_memory_generation_model_uses_that_providers_connection() {
    let env = Env::new(Vec::new()).await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;
    let set = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "memoryGenerationModel": "together:mem-model" } }),
    )
    .await;
    assert!(set.get("error").is_none(), "{set}");

    let mut notifs = Vec::new();
    let res = start_turn(
        &mut ws,
        "t1",
        json!({ "threadId": thread_id, "input": "remember: always run cargo fmt first" }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while env.together.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let together = env.together.lock().unwrap().clone();
    assert_eq!(
        together.len(),
        1,
        "memory request must reach the together endpoint"
    );
    assert_eq!(together[0].0["model"], json!("mem-model"));
    assert_eq!(together[0].1, "Bearer together-mock-key");
    // The chat provider never saw a request for the memory model.
    assert!(
        env.bodies()
            .iter()
            .all(|b| b["model"] != json!("together:mem-model") && b["model"] != json!("mem-model"))
    );
    server.shutdown().await;
}
