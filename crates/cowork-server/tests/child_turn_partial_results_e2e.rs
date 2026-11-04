//! End-to-end: a child agent whose turn completes a tool step and is then interrupted (or whose
//! provider fails on step 2) keeps the request, tool call/result and step-1 usage, and a follow-up
//! continues from that history.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Response, StatusCode, header};
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

fn server_options(root: &TempDir, llm_port: u16) -> (ServerOptions, PathBuf) {
    let base = fs::canonicalize(root.path()).unwrap();
    let home = base.join("home");
    let workspace = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(workspace.join("notes")).unwrap();
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
    env.insert(
        "PATH".into(),
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
    );
    env.insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );
    let opts = ServerOptions {
        working_directory: workspace.clone(),
        host: "127.0.0.1".into(),
        port: 0,
        yolo: true,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".into(),
        mobile_h3_port: 0,
        homedir: Some(home),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env,
    };
    (opts, workspace)
}

async fn connect_ready_ws(ws_url: &str) -> WsStream {
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
                "clientInfo": { "name": "child-partial-e2e", "version": "1.0.0" },
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

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
        }
    }
}

async fn spawn_child(ws: &mut WsStream, parent_id: &str, message: &str) -> String {
    let before = list_child_ids(ws, parent_id).await;
    let res = ws_call(
        ws,
        &format!("spawn-{message}"),
        "cowork/session/agent/spawn",
        json!({ "threadId": parent_id, "message": message }),
    )
    .await;
    assert_eq!(res["result"], json!({}), "spawn: {res}");
    for _ in 0..100 {
        if let Some(id) = list_child_ids(ws, parent_id)
            .await
            .into_iter()
            .find(|id| !before.contains(id))
        {
            return id;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("child for {message} never appeared");
}

/// Reads child ids from the `cowork/session/agentList` notification `agent/list` emits.
async fn list_child_ids(ws: &mut WsStream, parent_id: &str) -> Vec<String> {
    ws.send(WsMessage::Text(
        json!({
            "id": "list",
            "method": "cowork/session/agent/list",
            "params": { "threadId": parent_id }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("agent list timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val["method"] == "cowork/session/agentList" {
                return val["params"]["agents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a["agentId"].as_str().map(str::to_owned))
                    .collect();
            }
        }
    }
}

async fn inspect_when_idle(ws: &mut WsStream, parent_id: &str, agent_id: &str) -> Value {
    for i in 0..200 {
        let res = ws_call(
            ws,
            &format!("insp-{agent_id}-{i}"),
            "cowork/session/agent/inspect",
            json!({ "threadId": parent_id, "agentId": agent_id }),
        )
        .await;
        let event = res["result"]["event"].clone();
        if event["agent"]["busy"] == json!(false) {
            return event;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("child {agent_id} never went idle");
}

async fn send_input(ws: &mut WsStream, parent_id: &str, agent_id: &str, message: &str) {
    let res = ws_call(
        ws,
        &format!("send-{message}"),
        "cowork/session/agent/input/send",
        json!({ "threadId": parent_id, "agentId": agent_id, "message": message }),
    )
    .await;
    assert_eq!(res["result"], json!({}), "send: {res}");
}

fn chat_sse_tool_call(call_id: &str, tool_name: &str, args: &Value) -> String {
    let args_str = serde_json::to_string(args).unwrap();
    format!(
        concat!(
            "data: {{\"id\":\"cmpl-tc\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"tool_calls\":[{{\"index\":0,\"id\":{call_id:?},\"type\":\"function\",\"function\":{{\"name\":{tool_name:?},\"arguments\":{args_str:?}}}}}]}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-tc\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        call_id = call_id,
        tool_name = tool_name,
        args_str = args_str,
    )
}

fn chat_sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":25,\"completion_tokens\":8,\"total_tokens\":33}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

fn sse_resp(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

/// The follow-up request must carry the original request, the tool call and its result.
fn assert_continues_from(body: &Value, request: &str, call_id: &str) {
    let messages = body["messages"].as_array().expect("messages array");
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "user" && m.to_string().contains(request)),
        "follow-up lost the interrupted request: {body}"
    );
    assert!(
        messages.iter().any(|m| m["role"] == "assistant"
            && m["tool_calls"]
                .as_array()
                .is_some_and(|calls| calls.iter().any(|c| c["id"] == call_id))),
        "follow-up lost the completed tool call: {body}"
    );
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == call_id),
        "follow-up lost the completed tool result: {body}"
    );
}

fn total_tokens(event: &Value) -> u64 {
    event["sessionUsage"]["totalTokens"]
        .as_u64()
        .unwrap_or_default()
}

#[tokio::test]
async fn child_turn_interrupt_or_provider_failure_keeps_partial_history_and_usage_e2e() {
    // Scripted provider: step 1 writes a file; step 2 hangs (interrupt case) or returns a
    // non-retryable 400 (failure case); follow-ups are captured and answered with text.
    let follow_ups: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let step2_reached = Arc::new(Notify::new());
    let release_hold = Arc::new(Notify::new());
    let (follow_ups_route, step2_route, release_route) = (
        Arc::clone(&follow_ups),
        Arc::clone(&step2_reached),
        Arc::clone(&release_hold),
    );
    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let follow_ups = Arc::clone(&follow_ups_route);
            let step2 = Arc::clone(&step2_route);
            let release = Arc::clone(&release_route);
            async move {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let body_str = parsed.to_string();
                if body_str.contains("FOLLOWUP_AFTER") {
                    follow_ups.lock().unwrap().push(parsed);
                    return sse_resp(chat_sse_text("Follow-up done."));
                }
                if body_str.contains("PARTIAL_INTERRUPT") {
                    if body_str.contains("call_int") {
                        step2.notify_one();
                        release.notified().await;
                        return sse_resp(chat_sse_text("released"));
                    }
                    return sse_resp(chat_sse_tool_call(
                        "call_int",
                        "write",
                        &json!({ "path": "notes/int.txt", "content": "interrupt side effect\n" }),
                    ));
                }
                if body_str.contains("PARTIAL_FAIL") {
                    if body_str.contains("call_fail") {
                        return Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(
                                json!({ "error": { "message": "step 2 rejected" } }).to_string(),
                            ))
                            .unwrap();
                    }
                    return sse_resp(chat_sse_tool_call(
                        "call_fail",
                        "write",
                        &json!({ "path": "notes/fail.txt", "content": "failure side effect\n" }),
                    ));
                }
                sse_resp(chat_sse_text("ok"))
            }
        }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });

    let root = tempfile::Builder::new()
        .prefix("cowork-child-partial-e2e-")
        .tempdir_in(test_temp_base())
        .unwrap();
    let (opts, workspace) = server_options(&root, llm_port);
    let server = start_server(opts).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    let th = ws_call(
        &mut ws,
        "th-parent",
        "thread/start",
        json!({
            "cwd": workspace.to_string_lossy(),
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }),
    )
    .await;
    let parent_id = th["result"]["thread"]["id"].as_str().unwrap().to_owned();

    // --- Interrupted after the tool step ---
    let interrupt_request = "PARTIAL_INTERRUPT: write notes/int.txt";
    let step2 = step2_reached.notified();
    let int_child = spawn_child(&mut ws, &parent_id, interrupt_request).await;
    tokio::time::timeout(Duration::from_secs(10), step2)
        .await
        .expect("child reached step 2");
    assert_eq!(
        fs::read_to_string(workspace.join("notes/int.txt")).unwrap(),
        "interrupt side effect\n"
    );
    let int_res = ws_call(
        &mut ws,
        "turn-int",
        "turn/interrupt",
        json!({ "threadId": parent_id, "includeSubagents": true }),
    )
    .await;
    assert_eq!(int_res["result"]["interrupted"], json!(true), "{int_res}");
    let event = inspect_when_idle(&mut ws, &parent_id, &int_child).await;
    assert_eq!(
        event["agent"]["executionState"],
        json!("completed"),
        "{event}"
    );
    assert_eq!(
        total_tokens(&event),
        30,
        "step-1 usage must be kept: {event}"
    );

    send_input(&mut ws, &parent_id, &int_child, "FOLLOWUP_AFTER_INTERRUPT").await;
    let event = inspect_when_idle(&mut ws, &parent_id, &int_child).await;
    assert_eq!(
        event["agent"]["executionState"],
        json!("completed"),
        "{event}"
    );
    assert_eq!(total_tokens(&event), 63, "{event}");
    let body = follow_ups
        .lock()
        .unwrap()
        .iter()
        .find(|b| b.to_string().contains("FOLLOWUP_AFTER_INTERRUPT"))
        .cloned()
        .expect("interrupt follow-up request");
    assert_continues_from(&body, interrupt_request, "call_int");

    // --- Provider failure on step 2 ---
    let fail_request = "PARTIAL_FAIL: write notes/fail.txt";
    let fail_child = spawn_child(&mut ws, &parent_id, fail_request).await;
    let event = inspect_when_idle(&mut ws, &parent_id, &fail_child).await;
    assert_eq!(
        event["agent"]["executionState"],
        json!("errored"),
        "{event}"
    );
    assert_eq!(
        total_tokens(&event),
        30,
        "step-1 usage must be kept: {event}"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("notes/fail.txt")).unwrap(),
        "failure side effect\n"
    );

    send_input(&mut ws, &parent_id, &fail_child, "FOLLOWUP_AFTER_FAIL").await;
    let event = inspect_when_idle(&mut ws, &parent_id, &fail_child).await;
    assert_eq!(
        event["agent"]["executionState"],
        json!("completed"),
        "{event}"
    );
    let body = follow_ups
        .lock()
        .unwrap()
        .iter()
        .find(|b| b.to_string().contains("FOLLOWUP_AFTER_FAIL"))
        .cloned()
        .expect("failure follow-up request");
    assert_continues_from(&body, fail_request, "call_fail");

    release_hold.notify_waiters();
    server.shutdown().await;
    llm_task.abort();
}
