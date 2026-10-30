use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use cowork_server::{
    MAX_OUTBOUND_QUEUE_CAPACITY, SendSinkOutcome, ServerOptions, SocketSendQueue, start_server,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use uuid::Uuid;

struct IsolatedServerEnv {
    base_dir: PathBuf,
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedServerEnv {
    fn new() -> Self {
        let id = Uuid::new_v4();
        let base_dir = PathBuf::from(format!("/private/tmp/cowork-srv-test-{id}"));
        let home_dir = base_dir.join("home");
        let userdata_dir = base_dir.join("userdata");
        let workspace_dir = base_dir.join("workspace");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::create_dir_all(&userdata_dir).unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();

        let home_dir = std::fs::canonicalize(&home_dir).unwrap();
        let userdata_dir = std::fs::canonicalize(&userdata_dir).unwrap();
        let workspace_dir = std::fs::canonicalize(&workspace_dir).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".into(), home_dir.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            userdata_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            userdata_dir.to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());

        Self {
            base_dir,
            home_dir,
            workspace_dir,
            env,
        }
    }

    fn server_options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace_dir.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home_dir.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

impl Drop for IsolatedServerEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base_dir);
    }
}

fn url_with_query(base: &str, params: &[(&str, &str)]) -> Url {
    Url::parse_with_params(base, params).unwrap()
}

#[test]
fn socket_send_queue_enforces_500_cap_and_evicts_only_deltas() {
    assert_eq!(MAX_OUTBOUND_QUEUE_CAPACITY, 500);
    let queue = SocketSendQueue::new(MAX_OUTBOUND_QUEUE_CAPACITY);
    let mut delivered: Vec<Value> = Vec::new();

    // Queue 250 lifecycle/response items + 250 delta items = 500 cap
    for i in 0..250 {
        queue.send("conn-1", &json!({"id": i, "result": {"ok": true}}), |_| {
            SendSinkOutcome::Backpressured
        });
        queue.send(
            "conn-1",
            &json!({"method": "item/agentMessage/delta", "params": {"itemId": "m1", "delta": format!("d-{i}")}}),
            |_| SendSinkOutcome::Backpressured,
        );
    }
    assert_eq!(
        queue.stats().queue_depth_by_connection.get("conn-1"),
        Some(&500)
    );
    assert_eq!(queue.stats().dropped_deltas, 0);
    assert_eq!(queue.stats().dropped_important, 0);

    // Send 250 more important lifecycle/server-request frames -> all 250 deltas are evicted, 0 important dropped!
    for i in 0..250 {
        let frame = if i % 2 == 0 {
            json!({"method": "turn/completed", "params": {"seq": i}})
        } else {
            json!({"id": format!("srv-{i}"), "method": "item/commandExecution/requestApproval", "params": {}})
        };
        queue.send("conn-1", &frame, |_| SendSinkOutcome::Backpressured);
    }
    assert_eq!(
        queue.stats().queue_depth_by_connection.get("conn-1"),
        Some(&500)
    );
    assert_eq!(queue.stats().dropped_deltas, 250);
    assert_eq!(queue.stats().dropped_important, 0);

    // Queue now holds 500 important frames and 0 deltas; incoming delta is dropped without evicting important frames!
    queue.send(
        "conn-1",
        &json!({"method": "item/reasoning/delta", "params": {"delta": "late"}}),
        |_| SendSinkOutcome::Backpressured,
    );
    assert_eq!(queue.stats().dropped_deltas, 251);
    assert_eq!(queue.stats().dropped_important, 0);

    // Flush delivers all 500 important frames in FIFO order
    queue.flush("conn-1", |raw| {
        delivered.push(serde_json::from_str(raw).unwrap());
        SendSinkOutcome::Accepted
    });
    assert_eq!(delivered.len(), 500);
    assert!(delivered.iter().all(|v| {
        v.get("method").and_then(Value::as_str) != Some("item/agentMessage/delta")
            && v.get("method").and_then(Value::as_str) != Some("item/reasoning/delta")
    }));
}

#[tokio::test]
async fn http_security_gates_health_fs_confinement_and_desktop_routes() {
    let iso = IsolatedServerEnv::new();
    let mut opts = iso.server_options();
    opts.env.insert(
        "COWORK_BROWSER_ACCESS_TOKEN".into(),
        "secret-browser-token".into(),
    );
    opts.env
        .insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());

    let handle = start_server(opts).await.unwrap();
    let base = format!("http://127.0.0.1:{}", handle.port());
    let client = reqwest::Client::new();

    // 1. Health endpoint works without Origin on loopback
    let health = client
        .get(format!("{base}/cowork/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 200);
    let health_json: Value = health.json().await.unwrap();
    assert_eq!(health_json["ok"], true);
    assert_eq!(health_json["startup"]["ready"], true);

    // 2. Evil origin rejected with 403
    let evil = client
        .get(format!("{base}/cowork/health"))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(evil.status(), 403);
    assert_eq!(evil.text().await.unwrap(), "Forbidden origin");

    // 3. Loopback browser origin without token -> 401
    let no_tok = client
        .get(format!("{base}/cowork/health"))
        .header("Origin", "http://127.0.0.1:14330")
        .send()
        .await
        .unwrap();
    assert_eq!(no_tok.status(), 401);
    assert_eq!(no_tok.text().await.unwrap(), "Unauthorized browser access");

    // 4. Loopback browser origin with valid token -> 200 + CORS headers
    let with_tok = client
        .get(format!("{base}/cowork/health"))
        .header("Origin", "http://127.0.0.1:14330")
        .header("X-Cowork-Browser-Token", "secret-browser-token")
        .send()
        .await
        .unwrap();
    assert_eq!(with_tok.status(), 200);
    assert_eq!(
        with_tok
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "http://127.0.0.1:14330"
    );

    // 5. /cowork/workspaces & /cowork/desktop/state
    let ws_res: Value = client
        .get(format!("{base}/cowork/workspaces"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!ws_res["workspaces"].as_array().unwrap().is_empty());

    let state_res: Value = client
        .get(format!("{base}/cowork/desktop/state"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(state_res.get("workspaces").is_some());

    // 6. /cowork/fs/* confined operations + path traversal & symlink escape rejection
    let inside_file = iso.workspace_dir.join("hello.txt");
    std::fs::write(&inside_file, "workspace data").unwrap();

    let outside_file = iso.base_dir.join("outside-secret.txt");
    std::fs::write(&outside_file, "top secret").unwrap();
    let escape_link = iso.workspace_dir.join("escape-link.txt");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside_file, &escape_link).unwrap();

    // Valid list, read & preview
    let list_res: Value = client
        .get(url_with_query(
            &format!("{base}/cowork/fs/list"),
            &[(
                "path",
                inside_file.parent().unwrap().to_string_lossy().as_ref(),
            )],
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        list_res
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "hello.txt")
    );

    let read_res: Value = client
        .get(url_with_query(
            &format!("{base}/cowork/fs/read"),
            &[("path", inside_file.to_string_lossy().as_ref())],
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(read_res["content"], "workspace data");

    let preview_res = client
        .get(url_with_query(
            &format!("{base}/cowork/fs/preview"),
            &[("path", inside_file.to_string_lossy().as_ref())],
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(preview_res.status(), 200);
    assert!(
        preview_res
            .headers()
            .get("x-cowork-file-fingerprint")
            .is_some()
    );
    assert_eq!(preview_res.text().await.unwrap(), "workspace data");

    // Path traversal blocked
    let traversal = client
        .get(url_with_query(
            &format!("{base}/cowork/fs/read"),
            &[(
                "path",
                iso.workspace_dir
                    .join("../outside-secret.txt")
                    .to_string_lossy()
                    .as_ref(),
            )],
        ))
        .send()
        .await
        .unwrap();
    assert!(traversal.status().is_client_error());

    // Symlink escape blocked on read & preview
    #[cfg(unix)]
    {
        let sym_read = client
            .get(url_with_query(
                &format!("{base}/cowork/fs/read"),
                &[("path", escape_link.to_string_lossy().as_ref())],
            ))
            .send()
            .await
            .unwrap();
        assert!(sym_read.status().is_client_error());

        let sym_preview = client
            .get(url_with_query(
                &format!("{base}/cowork/fs/preview"),
                &[("path", escape_link.to_string_lossy().as_ref())],
            ))
            .send()
            .await
            .unwrap();
        assert!(sym_preview.status().is_client_error());
    }

    // Create directory, rename, trash inside workspace
    let mkdir = client
        .post(format!("{base}/cowork/fs/create-directory"))
        .json(&json!({
            "parentPath": iso.workspace_dir.to_string_lossy(),
            "name": "sub"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(mkdir.status(), 204);
    assert!(iso.workspace_dir.join("sub").is_dir());

    let rename_resp = client
        .post(format!("{base}/cowork/fs/rename"))
        .json(&json!({
            "path": iso.workspace_dir.join("sub").to_string_lossy(),
            "newName": "sub-renamed"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(rename_resp.status(), 204);
    assert!(iso.workspace_dir.join("sub-renamed").is_dir());

    let trash_resp = client
        .post(format!("{base}/cowork/fs/trash"))
        .json(&json!({
            "path": iso.workspace_dir.join("sub-renamed").to_string_lossy()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(trash_resp.status(), 204);
    assert!(!iso.workspace_dir.join("sub-renamed").exists());
    assert!(iso.workspace_dir.join(".cowork-trash").is_dir());

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_and_sticky_http_rpc_routes_and_idle_eviction() {
    let iso = IsolatedServerEnv::new();
    let handle = start_server(iso.server_options()).await.unwrap();
    let port = handle.port();
    let ws_url = format!("ws://127.0.0.1:{port}/ws");

    // Retired ?protocol= query rejected with 400
    let retired_ws = reqwest::get(format!("http://127.0.0.1:{port}/ws?protocol=legacy"))
        .await
        .unwrap();
    assert_eq!(retired_ws.status(), 400);

    // Connect WebSocket with cowork.jsonrpc.v1 subprotocol
    let mut ws_req = ws_url.into_client_request().unwrap();
    ws_req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("cowork.jsonrpc.v1"),
    );
    let (mut ws, upgrade_resp) = tokio_tungstenite::connect_async(ws_req).await.unwrap();
    assert_eq!(
        upgrade_resp
            .headers()
            .get("sec-websocket-protocol")
            .unwrap(),
        "cowork.jsonrpc.v1"
    );

    async fn recv_json(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let WsMessage::Text(txt) = msg {
                let val: Value = serde_json::from_str(&txt).unwrap();
                assert!(
                    val.get("jsonrpc").is_none(),
                    "unexpected jsonrpc field: {val}"
                );
                return val;
            }
        }
    }

    async fn rpc_call(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        id: i64,
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
            let frame = recv_json(ws).await;
            if frame.get("id") == Some(&json!(id)) {
                return frame;
            }
            notifications.push(frame);
        }
    }

    // 1. Pre-handshake request rejected with -32002
    let mut notifs = Vec::new();
    let pre_init = rpc_call(&mut ws, 1, "workspace/list", json!({}), &mut notifs).await;
    assert_eq!(pre_init["error"]["code"], -32002);

    // 2. Inbound "jsonrpc": "2.0" rejected with -32600
    ws.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let with_2_0 = recv_json(&mut ws).await;
    assert_eq!(with_2_0["id"], 2);
    assert_eq!(with_2_0["error"]["code"], -32600);

    // 3. Valid initialize + initialized handshake + duplicate initialize -> -32003
    let init_res = rpc_call(
        &mut ws,
        3,
        "initialize",
        json!({
            "clientInfo": { "name": "test-client", "version": "0.1.0" },
            "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(init_res["result"]["protocolVersion"], "0.1");
    assert_eq!(
        init_res["result"]["serverInfo"]["subprotocol"],
        "cowork.jsonrpc.v1"
    );

    ws.send(WsMessage::Text(
        json!({"method": "initialized"}).to_string().into(),
    ))
    .await
    .unwrap();

    let dup_init = rpc_call(
        &mut ws,
        4,
        "initialize",
        json!({ "clientInfo": { "name": "dup" } }),
        &mut notifs,
    )
    .await;
    assert_eq!(dup_init["error"]["code"], -32003);

    // 4. thread/start with creationKey idempotency
    let cwd_str = iso.workspace_dir.to_string_lossy().into_owned();
    let start_resp = rpc_call(
        &mut ws,
        10,
        "thread/start",
        json!({ "cwd": cwd_str, "clientThreadId": "idem-key-1" }),
        &mut notifs,
    )
    .await;
    let thread_id = start_resp["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Repeat with same clientThreadId -> returns identical thread_id
    let start2_resp = rpc_call(
        &mut ws,
        11,
        "thread/start",
        json!({ "cwd": cwd_str, "clientThreadId": "idem-key-1" }),
        &mut notifs,
    )
    .await;
    assert_eq!(start2_resp["result"]["thread"]["id"], thread_id);

    // 5. cowork/session/*, thread/{pinned,archived,read,hydrate}, workspace/*, command/*, cowork/creation/preflight
    let title_resp = rpc_call(
        &mut ws,
        12,
        "cowork/session/title/set",
        json!({ "threadId": thread_id, "title": "My Rust Thread" }),
        &mut notifs,
    )
    .await;
    assert_eq!(title_resp["result"]["event"]["type"], "session_info");
    assert_eq!(title_resp["result"]["event"]["title"], "My Rust Thread");

    let model_resp = rpc_call(
        &mut ws,
        13,
        "cowork/session/model/set",
        json!({ "threadId": thread_id, "provider": "openai", "model": "gpt-5.4" }),
        &mut notifs,
    )
    .await;
    assert_eq!(model_resp["result"]["event"]["type"], "config_updated");
    assert_eq!(model_resp["result"]["event"]["config"]["model"], "gpt-5.4");

    let budget_resp = rpc_call(
        &mut ws,
        14,
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "warnAtUsd": 2.5, "stopAtUsd": 10.0 }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        budget_resp["result"]["event"]["usage"]["stopAtUsd"],
        json!(10.0)
    );

    let hc_set = rpc_call(
        &mut ws,
        15,
        "cowork/session/harnessContext/set",
        json!({
            "threadId": thread_id,
            "context": {
                "runId": "run-1",
                "objective": "Verify routes",
                "acceptanceCriteria": ["pass"],
                "constraints": ["isolated"]
            }
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(hc_set["result"]["event"]["context"]["runId"], "run-1");

    let hc_get = rpc_call(
        &mut ws,
        16,
        "cowork/session/harnessContext/get",
        json!({ "threadId": thread_id }),
        &mut notifs,
    )
    .await;
    assert_eq!(hc_get["result"]["event"]["context"]["runId"], "run-1");

    let pin_resp = rpc_call(
        &mut ws,
        17,
        "thread/pinned/set",
        json!({ "threadId": thread_id, "pinned": true }),
        &mut notifs,
    )
    .await;
    assert_eq!(pin_resp["result"]["thread"]["pinned"], true);

    let arch_resp = rpc_call(
        &mut ws,
        18,
        "thread/archived/set",
        json!({ "threadId": thread_id, "archived": true }),
        &mut notifs,
    )
    .await;
    assert_eq!(arch_resp["result"]["thread"]["archived"], true);

    let ws_list = rpc_call(&mut ws, 19, "workspace/list", json!({}), &mut notifs).await;
    let ws_id = ws_list["result"]["activeWorkspaceId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ws_switch = rpc_call(
        &mut ws,
        20,
        "workspace/switch",
        json!({ "workspaceId": ws_id }),
        &mut notifs,
    )
    .await;
    assert_eq!(ws_switch["result"]["path"], cwd_str);

    let bootstrap_resp = rpc_call(
        &mut ws,
        21,
        "cowork/workspace/bootstrap",
        json!({ "cwd": cwd_str }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        bootstrap_resp["result"]["threads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        !bootstrap_resp["result"]["state"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let cmd_resp = rpc_call(
        &mut ws,
        22,
        "command/list",
        json!({ "threadId": thread_id }),
        &mut notifs,
    )
    .await;
    assert!(
        !cmd_resp["result"]["commands"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Execute /init command to append journal events so we can verify includeTurns & afterSeq replay
    let exec_resp = rpc_call(
        &mut ws,
        23,
        "command/execute",
        json!({
            "threadId": thread_id,
            "name": "init",
            "clientMessageId": "cmd-msg-1"
        }),
        &mut notifs,
    )
    .await;
    assert!(exec_resp["result"]["turn"]["id"].is_string());

    let read_resp = rpc_call(
        &mut ws,
        24,
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        read_resp["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(read_resp["result"]["journalTailSeq"].as_u64().unwrap() >= 4);

    let preflight_resp = rpc_call(
        &mut ws,
        25,
        "cowork/creation/preflight",
        json!({ "kind": "chat", "cwd": cwd_str }),
        &mut notifs,
    )
    .await;
    assert!(preflight_resp["result"]["checks"].is_array());

    // 6. Unsubscribe & trigger idle eviction -> persisted thread still readable & resumable with afterSeq!
    let unsub_resp = rpc_call(
        &mut ws,
        26,
        "thread/unsubscribe",
        json!({ "threadId": thread_id }),
        &mut notifs,
    )
    .await;
    assert_eq!(unsub_resp["result"]["status"], "unsubscribed");

    let evicted = handle.evict_idle_sessions(Duration::ZERO);
    assert_eq!(evicted, 1);

    // Resume over WebSocket with afterSeq: 1 -> replays subsequent journal events cleanly!
    notifs.clear();
    let ws_resume = rpc_call(
        &mut ws,
        27,
        "thread/resume",
        json!({ "threadId": thread_id, "afterSeq": 1 }),
        &mut notifs,
    )
    .await;
    assert_eq!(ws_resume["result"]["replayHealth"]["trusted"], true);
    assert!(
        notifs.iter().any(|n| n["method"] == "turn/started"),
        "expected turn/started replayed notification, got {notifs:?}"
    );

    // 7. Sticky HTTP POST /rpc via X-Cowork-Client-Id
    let http = reqwest::Client::new();
    let rpc_url = format!("http://127.0.0.1:{port}/rpc");

    // Missing X-Cowork-Client-Id -> 400
    let missing_cid = http
        .post(&rpc_url)
        .json(&json!({"id": 1, "method": "workspace/list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_cid.status(), 400);

    // Pre-init on client-A -> 200 with -32002
    let pre_http: Value = http
        .post(&rpc_url)
        .header("X-Cowork-Client-Id", "client-A")
        .json(&json!({"id": 1, "method": "workspace/list"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pre_http["error"]["code"], -32002);

    // Handshake on client-A
    let http_init: Value = http
        .post(&rpc_url)
        .header("X-Cowork-Client-Id", "client-A")
        .json(&json!({
            "id": 2,
            "method": "initialize",
            "params": { "clientInfo": { "name": "http-cli" } }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(http_init["result"]["transport"]["type"], "http");

    let http_inited = http
        .post(&rpc_url)
        .header("X-Cowork-Client-Id", "client-A")
        .json(&json!({"method": "initialized"}))
        .send()
        .await
        .unwrap();
    assert_eq!(http_inited.status(), 202);

    let hydrated: Value = http
        .post(&rpc_url)
        .header("X-Cowork-Client-Id", "client-A")
        .json(&json!({
            "id": 3,
            "method": "thread/hydrate",
            "params": { "threadId": thread_id, "afterSeq": 0, "includeTurns": true }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hydrated["result"]["thread"]["title"], "My Rust Thread");
    assert_eq!(hydrated["result"]["replayHealth"]["trusted"], true);

    handle.shutdown().await;
}

#[tokio::test]
async fn binary_cold_starts_under_100ms_emits_ndjson_and_exits_0_on_stdin_eof() {
    let iso = IsolatedServerEnv::new();
    let bin = env!("CARGO_BIN_EXE_cowork-server");

    // Pre-build HTTP client and warm macOS amfid Mach-O signature cache (--version does not touch disk/DB)
    let client = reqwest::Client::new();
    let _ = tokio::process::Command::new(bin)
        .arg("--version")
        .env_clear()
        .envs(&iso.env)
        .output()
        .await;

    let t0 = Instant::now();
    let mut child = tokio::process::Command::new(bin)
        .args([
            "--dir",
            iso.workspace_dir.to_str().unwrap(),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--json",
        ])
        .env_clear()
        .envs(&iso.env)
        .env("COWORK_DESKTOP_PARENT_MANAGED", "1")
        .env("COWORK_DESKTOP_STARTUP_EVENTS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = tokio::io::BufReader::new(stdout).lines();

    let mut saw_progress = false;
    let mut listening_payload: Option<Value> = None;

    while let Some(line) = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
    {
        let parsed: Value = serde_json::from_str(&line).unwrap();
        if parsed["type"] == "server_startup_progress" {
            saw_progress = true;
            assert_eq!(parsed["component"], "cowork-runtime");
            assert_eq!(parsed["progress"]["phase"], "ready");
        } else if parsed["type"] == "server_listening" {
            listening_payload = Some(parsed);
            break;
        }
    }

    let listening = listening_payload.expect("expected server_listening NDJSON");
    assert!(saw_progress, "expected server_startup_progress NDJSON");
    let port = listening["port"].as_u64().unwrap();
    assert!(port > 0);
    assert!(
        listening["url"]
            .as_str()
            .unwrap()
            .starts_with("ws://127.0.0.1:")
    );
    assert!(
        listening["wsUrl"]
            .as_str()
            .unwrap()
            .starts_with("ws://127.0.0.1:")
    );

    let health = client
        .get(format!("http://127.0.0.1:{port}/cowork/health"))
        .send()
        .await
        .unwrap();
    let cold_start_elapsed = t0.elapsed();
    println!("cold_start_elapsed = {cold_start_elapsed:?}");
    assert_eq!(health.status(), 200);
    assert!(
        cold_start_elapsed < Duration::from_millis(100),
        "cold start took {cold_start_elapsed:?}, expected <100ms"
    );

    // Close stdin under COWORK_DESKTOP_PARENT_MANAGED=1 -> exits 0 within <10s
    let shutdown_t0 = Instant::now();
    drop(stdin);
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("server must exit within 10s of stdin EOF")
        .unwrap();
    assert!(status.success(), "expected exit 0, got {status}");
    assert!(shutdown_t0.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn protocol_error_codes_cors_preflight_mobile_h3_and_parent_env_scrubbing() {
    let mut iso = IsolatedServerEnv::new();
    iso.env
        .insert("COWORK_DESKTOP_PARENT_MANAGED".into(), "1".into());
    let mut opts = iso.server_options();
    opts.mobile_h3 = true;
    opts.env = iso.env.clone();

    let handle = start_server(opts).await.unwrap();
    // COWORK_DESKTOP_PARENT_MANAGED must be scrubbed from runtime env so child tools never inherit it
    assert!(
        !handle
            .runtime()
            .env
            .contains_key("COWORK_DESKTOP_PARENT_MANAGED")
    );

    let listening = handle.listening_event();
    let h3 = listening.mobile_h3.expect("expected mobileH3 metadata");
    assert!(h3.ticket.starts_with("cowork-pair://"));

    let port = handle.port();
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::new();

    // OPTIONS preflight returns 204 + CORS headers
    let preflight = http
        .request(reqwest::Method::OPTIONS, format!("{base}/cowork/health"))
        .header("Origin", "http://localhost:14330")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), 204);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "http://localhost:14330"
    );

    // Browser origin when no browserAccessToken is configured -> 403 "Browser access is not enabled for this server"
    let browser_disabled = http
        .get(format!("{base}/cowork/health"))
        .header("Origin", "http://localhost:14330")
        .send()
        .await
        .unwrap();
    assert_eq!(browser_disabled.status(), 403);
    assert_eq!(
        browser_disabled.text().await.unwrap(),
        "Browser access is not enabled for this server"
    );

    // /mobile-h3/trusted requires Bearer adminToken
    let unauth_h3 = http
        .get(format!("{base}/mobile-h3/trusted"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_h3.status(), 401);

    let auth_h3: Value = http
        .get(format!("{base}/mobile-h3/trusted"))
        .bearer_auth(&h3.admin_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(auth_h3["trustedDevices"], json!([]));

    // Verify -32700 parse error, -32601 unknown method, and -32602 invalid params over WS
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();

    ws.send(WsMessage::Text("{broken json".into()))
        .await
        .unwrap();
    let parse_err: Value = serde_json::from_str(
        ws.next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .as_str(),
    )
    .unwrap();
    assert_eq!(parse_err["error"]["code"], -32700);

    ws.send(WsMessage::Text(
        json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "err-test"}}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    ws.send(WsMessage::Text(
        json!({"method": "initialized"}).to_string().into(),
    ))
    .await
    .unwrap();

    ws.send(WsMessage::Text(
        json!({"id": 2, "method": "nonexistent/method", "params": {}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let not_found: Value = serde_json::from_str(
        ws.next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .as_str(),
    )
    .unwrap();
    assert_eq!(not_found["error"]["code"], -32601);

    ws.send(WsMessage::Text(
        json!({"id": 3, "method": "thread/read", "params": {"unknownField": true}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let bad_params: Value = serde_json::from_str(
        ws.next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .as_str(),
    )
    .unwrap();
    assert_eq!(bad_params["error"]["code"], -32602);

    handle.shutdown().await;
}
