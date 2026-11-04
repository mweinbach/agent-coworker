//! Regression tests:
//! - `command/execute` expands the command/skill template and runs a real turn (it used to
//!   persist the literal slash text and emit an empty completed turn without calling a model).
//! - `cowork/session/delete` during an active turn cancels and awaits the turn, and the turn's
//!   final persist must not resurrect the deleted session.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::post;
use cowork_config::{LoadConfigOptions, load_config};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::registry::{expand_command_template, resolve_command_template};
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
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
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        Self {
            _root: root,
            home,
            workspace,
            env,
        }
    }

    fn server_options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: true,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(repo_root()),
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
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "cmd-delete-test", "version": "1.0.0" },
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
            .expect("ws call timeout")
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

async fn wait_for_notification(
    ws: &mut WsStream,
    notifs: &mut Vec<Value>,
    pred: impl Fn(&Value) -> bool,
) -> Value {
    if let Some(found) = notifs.iter().find(|n| pred(n)) {
        return found.clone();
    }
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("notification timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            notifs.push(val.clone());
            if pred(&val) {
                return val;
            }
        }
    }
}

fn sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

/// Mock OpenAI-compatible provider: records request bodies, optionally delays each response.
async fn mock_provider(delay: Duration) -> (u16, Arc<Mutex<Vec<Value>>>) {
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let bodies_route = Arc::clone(&bodies);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: axum::body::Bytes| {
            let bodies = Arc::clone(&bodies_route);
            async move {
                bodies
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
                tokio::time::sleep(delay).await;
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from(sse_text("done")))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, bodies)
}

async fn start_thread(ws: &mut WsStream, iso: &Iso, notifs: &mut Vec<Value>) -> String {
    let res = call(
        ws,
        "th",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "nvidia",
            "model": "moonshotai/kimi-k2-instruct"
        }),
        notifs,
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

#[test]
fn expand_command_template_matches_ts_semantics() {
    assert_eq!(
        expand_command_template("Target: $ARGUMENTS", "  a b  "),
        "Target: a b"
    );
    assert_eq!(
        expand_command_template("Do it", "extra args"),
        "Do it\n\nextra args"
    );
    assert_eq!(expand_command_template("Do it", ""), "Do it");
    // Highest numbered placeholder takes the rest; missing tokens become empty.
    assert_eq!(
        expand_command_template("$1 | $2", "one \"two words\" three"),
        "one | two words three"
    );
    assert_eq!(expand_command_template("[$1][$3]", "x"), "[x][]");
    // Arguments are inserted literally (no recursive placeholder expansion).
    assert_eq!(
        expand_command_template("$ARGUMENTS", "$1 $ARGUMENTS"),
        "$1 $ARGUMENTS"
    );
}

#[test]
fn resolves_builtin_config_and_skill_commands() {
    let mut iso = Iso::new();
    // The bundled `task` skill is gated behind the tasks feature flag.
    iso.env.insert("COWORK_ENABLE_TASKS".into(), "1".into());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(iso.workspace.clone()),
        homedir: Some(iso.home.clone()),
        built_in_dir: Some(repo_root()),
        env: Some(iso.env.clone()),
    })
    .unwrap();

    let (name, review) = resolve_command_template(&cfg, "review").unwrap();
    assert_eq!(name, "review");
    assert!(review.contains("$ARGUMENTS"), "built-in template: {review}");
    assert_eq!(
        resolve_command_template(&cfg, "REVIEW").unwrap().0,
        "review"
    );

    // `/task` resolves to the bundled task skill body, not the bare slash text.
    let (task_name, task_body) = resolve_command_template(&cfg, "task").unwrap();
    assert_eq!(task_name, "task");
    assert!(
        task_body.contains("# Task Mode"),
        "task skill body: {task_body}"
    );
    assert!(!task_body.contains("description: Hand ordinary chat"));

    assert!(resolve_command_template(&cfg, "definitely-not-a-command").is_err());
}

#[tokio::test]
async fn command_execute_expands_template_and_runs_a_real_turn() {
    let (port, bodies) = mock_provider(Duration::ZERO).await;
    let mut iso = Iso::new();
    iso.env.insert(
        "NVIDIA_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    iso.env.insert("NVIDIA_API_KEY".into(), "nvapi-mock".into());
    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut notifs = Vec::new();
    let thread_id = start_thread(&mut ws, &iso, &mut notifs).await;

    let res = call(
        &mut ws,
        "cmd",
        "command/execute",
        json!({
            "threadId": thread_id,
            "name": "review",
            "arguments": "HEAD~3",
            "clientMessageId": "cmd-1"
        }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("command/execute failed: {res}"))
        .to_owned();

    let completed = wait_for_notification(&mut ws, &mut notifs, |n| {
        n["method"] == "turn/completed" && n["params"]["turn"]["id"] == json!(turn_id)
    })
    .await;
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );

    // The model received the expanded review template, with the arguments substituted.
    let sent = bodies.lock().unwrap().clone();
    assert!(!sent.is_empty(), "command/execute must call the model");
    let request = sent[0].to_string();
    assert!(
        request.contains("HEAD~3"),
        "expanded args missing: {request}"
    );
    assert!(
        request.contains("focus on bugs, regressions, and missing tests"),
        "review template missing from model input: {request}"
    );

    // The projected user message shows the literal slash command.
    let user_text = notifs
        .iter()
        .filter(|n| {
            n["method"] == "item/completed"
                && n["params"]["item"]["type"] == "userMessage"
                && n["params"]["turnId"] == json!(turn_id)
        })
        .flat_map(|n| {
            n["params"]["item"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|c| c["text"].as_str().map(str::to_owned))
        .collect::<Vec<_>>()
        .join("");
    assert_eq!(user_text, "/review HEAD~3");

    // Unknown commands are rejected without starting a turn.
    let bad = call(
        &mut ws,
        "cmd-bad",
        "command/execute",
        json!({ "threadId": thread_id, "name": "nope-not-real" }),
        &mut notifs,
    )
    .await;
    assert!(bad.get("error").is_some(), "{bad}");
}

#[tokio::test]
async fn deleting_a_chat_mid_turn_cancels_it_and_does_not_resurrect_it() {
    // Slow provider: without the fix the turn completes ~1.5s after delete returned and its
    // final persist re-creates the deleted session.
    let (port, bodies) = mock_provider(Duration::from_millis(1500)).await;
    let mut iso = Iso::new();
    iso.env.insert(
        "NVIDIA_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    iso.env.insert("NVIDIA_API_KEY".into(), "nvapi-mock".into());
    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut notifs = Vec::new();
    let thread_id = start_thread(&mut ws, &iso, &mut notifs).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();

    let started = call(
        &mut ws,
        "turn",
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "hello" }] }),
        &mut notifs,
    )
    .await;
    assert!(started["result"]["turn"]["id"].is_string(), "{started}");
    // Wait until the provider request is in flight.
    for _ in 0..200 {
        if !bodies.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !bodies.lock().unwrap().is_empty(),
        "turn never reached the provider"
    );

    let deleted = call(
        &mut ws,
        "del",
        "cowork/session/delete",
        json!({ "cwd": cwd, "targetSessionId": thread_id }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        deleted["result"]["event"]["type"], "session_deleted",
        "{deleted}"
    );

    // Let the (cancelled or slow) runner finish any late persistence.
    tokio::time::sleep(Duration::from_millis(2500)).await;

    let read = call(
        &mut ws,
        "read",
        "thread/read",
        json!({ "threadId": thread_id }),
        &mut notifs,
    )
    .await;
    assert!(
        read.get("error").is_some(),
        "deleted thread resurrected: {read}"
    );
    let list = call(
        &mut ws,
        "list",
        "thread/list",
        json!({ "cwd": cwd }),
        &mut notifs,
    )
    .await;
    let ids: Vec<&str> = list["result"]["data"]
        .as_array()
        .or_else(|| list["result"]["threads"].as_array())
        .map(|a| a.iter().filter_map(|t| t["id"].as_str()).collect())
        .unwrap_or_default();
    assert!(
        !ids.contains(&thread_id.as_str()),
        "deleted thread listed: {list}"
    );

    // A new turn on the deleted thread is refused.
    let again = call(
        &mut ws,
        "turn2",
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "again" }] }),
        &mut notifs,
    )
    .await;
    assert!(again.get("error").is_some(), "{again}");
}
