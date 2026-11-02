//! Regression test: concurrent first-time `cowork/session/agent/spawn` requests for one parent
//! must install a single child-agent controller. A replaced controller would orphan the
//! children it spawned (missing from `agent/list`) and its separate slot tracker would let the
//! parent exceed the per-parent active-child cap.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Mirrors `cowork_harness::agents::MAX_ACTIVE_CHILDREN_PER_PARENT`.
const MAX_ACTIVE_CHILDREN_PER_PARENT: usize = 16;
const SPAWNS_PER_PARENT: usize = 24;
const PARENTS: usize = 8;

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
    send(
        &mut ws,
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "agent-control-race", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
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

async fn next_json(ws: &mut WsStream) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("ws frame timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).unwrap();
        }
    }
}

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    loop {
        let val = next_json(ws).await;
        if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
            return val;
        }
    }
}

/// Reads child ids from the `cowork/session/agentList` notification `agent/list` emits. The
/// notification is queued before the request's response, so the last one seen for the parent
/// before that response is the one this call produced.
async fn list_child_ids(ws: &mut WsStream, parent_id: &str) -> Vec<String> {
    let id = format!("list-{parent_id}");
    send(
        ws,
        json!({
            "id": id,
            "method": "cowork/session/agent/list",
            "params": { "threadId": parent_id }
        }),
    )
    .await;
    let mut latest = None;
    loop {
        let val = next_json(ws).await;
        if val["method"] == "cowork/session/agentList" && val["params"]["sessionId"] == parent_id {
            latest = Some(val);
        } else if val.get("method").is_none() && val["id"] == id.as_str() {
            assert_eq!(val["result"], json!({}), "agent/list: {val}");
            break;
        }
    }
    let latest = latest.expect("agent/list emits cowork/session/agentList");
    latest["params"]["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["agentId"].as_str().map(str::to_owned))
        .collect()
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

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_first_spawns_share_one_agent_controller_and_cap() {
    // Every child turn is held open until the test releases it, so spawned children stay
    // `running` and keep occupying their parent's active-child slots.
    let (release_tx, release_rx) = watch::channel(false);
    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let mut release = release_rx.clone();
            async move {
                let _ = release.wait_for(|released| *released).await;
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(chat_sse_text("done")))
                    .unwrap()
            }
        }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        let _ = axum::serve(llm_listener, llm_app).await;
    });

    let root = tempfile::Builder::new()
        .prefix("cowork-agent-control-race-")
        .tempdir_in(test_temp_base())
        .unwrap();
    let (opts, workspace) = server_options(&root, llm_port);
    let server = start_server(opts).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    for round in 0..PARENTS {
        let th = ws_call(
            &mut ws,
            &format!("th-{round}"),
            "thread/start",
            json!({
                "cwd": workspace.to_string_lossy(),
                "provider": "together",
                "model": "moonshotai/Kimi-K2.5"
            }),
        )
        .await;
        let parent_id = th["result"]["thread"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("thread/start: {th}"))
            .to_owned();

        // Fire every first-time spawn back to back; the server dispatches each request on its
        // own task, so they all race to create this parent's controller.
        for i in 0..SPAWNS_PER_PARENT {
            send(
                &mut ws,
                json!({
                    "id": format!("spawn-{round}-{i}"),
                    "method": "cowork/session/agent/spawn",
                    "params": { "threadId": parent_id, "message": format!("child {round}-{i}") }
                }),
            )
            .await;
        }
        let mut ok = 0usize;
        let mut capped = 0usize;
        let mut pending = SPAWNS_PER_PARENT;
        while pending > 0 {
            let val = next_json(&mut ws).await;
            let Some(id) = val.get("id").and_then(Value::as_str) else {
                continue;
            };
            if val.get("method").is_some() || !id.starts_with(&format!("spawn-{round}-")) {
                continue;
            }
            pending -= 1;
            if val["result"] == json!({}) {
                ok += 1;
            } else {
                let msg = val["error"]["message"].as_str().unwrap_or_default();
                assert!(
                    msg.contains("Maximum active child agents per parent"),
                    "round {round}: unexpected spawn failure: {val}"
                );
                capped += 1;
            }
        }
        assert_eq!(
            ok, MAX_ACTIVE_CHILDREN_PER_PARENT,
            "round {round}: concurrent spawns must share one slot tracker ({capped} capped)"
        );

        let listed = list_child_ids(&mut ws, &parent_id).await;
        assert_eq!(
            listed.len(),
            ok,
            "round {round}: every spawned child must be managed by the installed controller: {listed:?}"
        );
        assert_eq!(
            server.runtime().list_child_agents(&parent_id, true).len(),
            ok,
            "round {round}: runtime controller must own every spawned child"
        );
    }

    let _ = release_tx.send(true);
    server.shutdown().await;
    llm_task.abort();
}
