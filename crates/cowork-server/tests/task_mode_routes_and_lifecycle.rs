use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedTaskServerEnv {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedTaskServerEnv {
    fn new(prefix: &str, tasks_enabled: bool) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in("/private/tmp")
            .expect("tempdir in /private/tmp");
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
        if tasks_enabled {
            env.insert("COWORK_ENABLE_TASKS".into(), "1".into());
        }
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        Self {
            _root: root,
            home,
            workspace,
            env,
        }
    }

    fn server_options(&self, yolo: bool) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
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
                "clientInfo": { "name": "m3-task-mode-e2e", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();

    ws.send(WsMessage::Text(
        json!({
            "method": "initialized",
            "params": {}
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    ws
}

async fn ws_call_collecting(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            assert!(
                val.get("jsonrpc").is_none(),
                "outbound frame must omit jsonrpc 2.0: {val}"
            );
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    let mut ignored = Vec::new();
    ws_call_collecting(ws, id, method, params, &mut ignored).await
}

async fn collect_until<F>(ws: &mut WsStream, notifs: &mut Vec<Value>, timeout_ms: u64, pred: F)
where
    F: Fn(&[Value]) -> bool,
{
    if pred(notifs) {
        return;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(txt)))) => {
                if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                    assert!(
                        val.get("jsonrpc").is_none(),
                        "outbound notification must omit jsonrpc 2.0: {val}"
                    );
                    if val.get("method").is_some() {
                        notifs.push(val);
                        if pred(notifs) {
                            return;
                        }
                    }
                }
            }
            _ => break,
        }
    }
}

fn sse_resp(payload: String) -> axum::response::Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(payload))
        .unwrap()
        .into_response()
}

fn chat_sse_tool_calls(calls: &[(&str, &str, Value)]) -> String {
    let mut delta_calls = Vec::new();
    for (idx, (call_id, tool_name, args)) in calls.iter().enumerate() {
        delta_calls.push(json!({
            "index": idx,
            "id": call_id,
            "type": "function",
            "function": {
                "name": tool_name,
                "arguments": serde_json::to_string(args).unwrap(),
            }
        }));
    }
    let first = json!({
        "id": "cmpl-tc",
        "choices": [{
            "index": 0,
            "delta": {
                "role": "assistant",
                "tool_calls": delta_calls,
            }
        }]
    });
    let second = json!({
        "id": "cmpl-tc",
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "tool_calls"
        }],
        "usage": { "prompt_tokens": 20, "completion_tokens": 12, "total_tokens": 32 }
    });
    format!("data: {first}\n\ndata: {second}\n\ndata: [DONE]\n\n")
}

fn chat_sse_text(text: &str) -> String {
    let first = json!({
        "id": "cmpl-txt",
        "choices": [{
            "index": 0,
            "delta": {
                "role": "assistant",
                "content": text,
            }
        }]
    });
    let second = json!({
        "id": "cmpl-txt",
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 24, "completion_tokens": 10, "total_tokens": 34 }
    });
    format!("data: {first}\n\ndata: {second}\n\ndata: [DONE]\n\n")
}

fn req_messages_contain(req_json: &Value, needle: &str) -> bool {
    serde_json::to_string(req_json.get("messages").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .contains(needle)
}

/// Extracts the latest task revision seen by the LLM in `messages`:
/// checks `"tool"` messages from the CURRENT turn (after the last `"user"` message)
/// for `"taskRevision"` or `"revision"`, falling back to `- Revision: <N>` in the
/// freshly rendered `## Active Task` system prompt (`messages[0]`).
fn extract_latest_task_revision(req_json: &Value) -> i64 {
    if let Some(msgs) = req_json.get("messages").and_then(Value::as_array) {
        let last_user_idx = msgs
            .iter()
            .rposition(|m| m.get("role") == Some(&json!("user")))
            .unwrap_or(0);
        for msg in msgs[last_user_idx..].iter().rev() {
            if msg.get("role") == Some(&json!("tool"))
                && let Some(content) = msg.get("content").and_then(Value::as_str)
                && let Ok(parsed) = serde_json::from_str::<Value>(content)
            {
                if let Some(r) = parsed.get("taskRevision").and_then(Value::as_i64) {
                    return r;
                }
                if let Some(r) = parsed.get("revision").and_then(Value::as_i64) {
                    return r;
                }
            }
        }
        if let Some(sys) = msgs
            .first()
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
        {
            for line in sys.lines() {
                if let Some(rest) = line.strip_prefix("- Revision: ")
                    && let Ok(r) = rest.trim().parse::<i64>()
                {
                    return r;
                }
            }
        }
    }
    1
}

/// Extracts the first work-item UUID from `### Work graph` in `## Active Task`.
fn extract_first_work_item_id(req_json: &Value) -> String {
    if let Some(sys) = req_json
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
    {
        let mut in_graph = false;
        for line in sys.lines() {
            if line == "### Work graph" {
                in_graph = true;
                continue;
            }
            if in_graph {
                if line.starts_with("### ") {
                    break;
                }
                if let Some(rest) = line.strip_prefix("- ")
                    && let Some((id, _)) = rest.split_once(": [")
                {
                    return id.trim().to_owned();
                }
            }
        }
    }
    String::new()
}

// ============================================================================
// 1. Feature Flag Gating + All 26 `task/*` JSON-RPC Routes + Artifact Conflicts
// ============================================================================
#[tokio::test]
async fn task_feature_flag_gating_and_all_26_task_routes_end_to_end() {
    // Part A: With tasks disabled, `task/*` routes return METHOD_NOT_FOUND (-32601)
    {
        let iso_disabled = IsolatedTaskServerEnv::new("cowork-task-disabled-", false);
        let srv = start_server(iso_disabled.server_options(true))
            .await
            .unwrap();
        let mut ws = connect_ready_ws(srv.ws_url()).await;
        let res = ws_call(&mut ws, "disabled-1", "task/list", json!({})).await;
        assert_eq!(res["error"]["code"], -32601, "expected -32601: {res}");
        srv.shutdown().await;
    }

    // Part B: With COWORK_ENABLE_TASKS=1, exercise all 26 `task/*` routes + strict validation
    let mut iso = IsolatedTaskServerEnv::new("cowork-task-routes-", true);

    let kickoff_asked_nonblocking = Arc::new(AtomicBool::new(false));
    let kickoff_flag = Arc::clone(&kickoff_asked_nonblocking);
    let rev_turn_done = Arc::new(tokio::sync::Notify::new());
    let rev_turn_done_route = Arc::clone(&rev_turn_done);
    let rev_file_path = iso.workspace.join("spec.md");
    let rev_file_for_llm = rev_file_path.clone();

    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let rev_file = rev_file_for_llm.clone();
            let rev_done = Arc::clone(&rev_turn_done_route);
            let asked_nb = Arc::clone(&kickoff_flag);
            async move {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let model = parsed.get("model").and_then(Value::as_str).unwrap_or("");
                if model.contains("mini") || model.contains("nano") {
                    return sse_resp(chat_sse_text("Task Route Test"));
                }
                let has_tool_result = parsed
                    .get("messages")
                    .and_then(Value::as_array)
                    .is_some_and(|msgs| msgs.iter().any(|m| m.get("role") == Some(&json!("tool"))));

                // Artifact revision turn: write `spec.md` then finish
                if req_messages_contain(&parsed, "Add Rollback section") && !has_tool_result {
                    return sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_write",
                        "write",
                        json!({
                            "filePath": rev_file.to_string_lossy(),
                            "content": "# Spec v3\n\n## Rollback\nClean rollback steps.\n"
                        }),
                    )]));
                }
                if req_messages_contain(&parsed, "Add Rollback section") && has_tool_result {
                    rev_done.notify_waiters();
                    return sse_resp(chat_sse_text("Added Rollback section to spec.md."));
                }

                // Kickoff turn: record a non-blocking question so `task/questions/resolve` can be exercised!
                if !asked_nb.swap(true, Ordering::SeqCst) {
                    let cur_rev = extract_latest_task_revision(&parsed);
                    return sse_resp(chat_sse_tool_calls(&[(
                        "call_nb_q",
                        "taskUpdate",
                        json!({
                            "idempotencyKey": "kickoff-nb-q-1",
                            "type": "request_input",
                            "expectedRevision": cur_rev,
                            "questions": [{
                                "header": "Audience",
                                "question": "Internal or external API consumers?",
                                "blocking": false,
                                "urgency": "optional",
                                "defaultAction": "Internal engineers"
                            }]
                        }),
                    )]));
                }

                sse_resp(chat_sse_text("Kickoff turn acknowledged."))
            }
        }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });

    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );
    let user_cfg_dir = iso.home.join(".cowork/config");
    fs::create_dir_all(&user_cfg_dir).unwrap();
    fs::write(
        user_cfg_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({
            "provider": "together",
            "model": "deepseek-ai/DeepSeek-V3"
        }))
        .unwrap(),
    )
    .unwrap();

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();

    // Strict param validation: unknown key rejected with -32602
    let bad_params = ws_call(
        &mut ws,
        "bad-1",
        "task/list",
        json!({ "unexpectedField": true }),
    )
    .await;
    assert_eq!(bad_params["error"]["code"], -32602);

    // Direct `task/*` RPCs reject unpromoted one-off chat workspaces with -32600
    let one_off_dir = iso.home.join(".cowork/chats/quick-1");
    fs::create_dir_all(&one_off_dir).unwrap();
    let bad_one_off = ws_call(
        &mut ws,
        "bad-oneoff",
        "task/list",
        json!({ "cwd": one_off_dir.to_string_lossy() }),
    )
    .await;
    assert_eq!(bad_one_off["error"]["code"], -32600);
    assert!(
        bad_one_off["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("authorized project workspace")
    );

    // 1. `task/create` (`reviewRequired: true, reviewRounds: 0` so human review lifecycle
    //    `proposeCompletion` -> `requestChanges` -> `accept` is exercised here, while 3-round
    //    independent `reviewTask` is exercised in Test #2!)
    let create_res = ws_call_collecting(
        &mut ws,
        "t-create",
        "task/create",
        json!({
            "idempotencyKey": "idem-route-1",
            "title": "Build API Spec",
            "objective": "Author and version the API specification.",
            "context": "Greenfield spec task.",
            "reviewRequired": true,
            "reviewRounds": 0,
            "requirements": [
                { "kind": "acceptance_criterion", "text": "Write spec.md", "permanence": "fixed" }
            ],
            "workItems": [
                { "key": "design", "title": "Draft outline" },
                { "key": "implement", "title": "Write full spec", "dependsOn": ["design"], "expectedOutputs": ["spec.md"] }
            ],
            "decisions": [
                { "question": "Format?", "resolution": "Markdown", "confidence": 0.95 }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert!(
        create_res.get("error").is_none(),
        "task/create failed: {create_res}"
    );
    let task_id = create_res["result"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let primary_session_id = create_res["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Wait until kickoff turn records the non-blocking question and settles
    for _ in 0..40 {
        let r = ws_call(
            &mut ws,
            "t-wait-kickoff",
            "task/read",
            json!({ "taskId": task_id }),
        )
        .await;
        if r["result"]["task"]["questions"]
            .as_array()
            .is_some_and(|q| !q.is_empty())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 2. `task/list` & 3. `task/read`
    let list_res = ws_call_collecting(&mut ws, "t-list", "task/list", json!({}), &mut notifs).await;
    assert_eq!(list_res["result"]["total"], 1);
    assert!(
        notifs.iter().any(|n| n["method"] == "task/created"),
        "expected buffered/subscribed task/created notification: {notifs:?}"
    );

    let read_res = ws_call(&mut ws, "t-read", "task/read", json!({ "taskId": task_id })).await;
    let mut rev = read_res["result"]["task"]["revision"].as_i64().unwrap();
    let design_id = read_res["result"]["task"]["workItems"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let implement_id = read_res["result"]["task"]["workItems"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let question_id = read_res["result"]["task"]["questions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Verify `thread/list` excludes task-owned threads!
    let thread_list = ws_call(&mut ws, "th-list-1", "thread/list", json!({})).await;
    assert_eq!(
        thread_list["result"]["threads"].as_array().unwrap().len(),
        0,
        "task primary thread must be hidden from thread/list: {thread_list}"
    );

    // Verify `cowork/session/delete` & `thread/fork` reject task threads!
    let del_task_thread = ws_call(
        &mut ws,
        "del-task-th",
        "cowork/session/delete",
        json!({ "targetSessionId": primary_session_id }),
    )
    .await;
    assert_eq!(del_task_thread["error"]["code"], -32600);
    assert!(
        del_task_thread["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("Task threads must be managed through the task lifecycle")
    );
    let fork_task_thread = ws_call(
        &mut ws,
        "fork-task-th",
        "thread/fork",
        json!({ "threadId": primary_session_id }),
    )
    .await;
    assert_eq!(fork_task_thread["error"]["code"], -32602);

    // 4. `task/updateBrief` + Optimistic Concurrency (`revision_conflict`)
    let stale_res = ws_call(
        &mut ws,
        "t-stale",
        "task/updateBrief",
        json!({
            "taskId": task_id,
            "expectedRevision": rev + 99,
            "title": "Stale Title"
        }),
    )
    .await;
    assert_eq!(stale_res["error"]["code"], -32600);
    assert_eq!(stale_res["error"]["data"]["category"], "revision_conflict");
    assert_eq!(stale_res["error"]["data"]["currentRevision"], rev);

    let brief_res = ws_call(
        &mut ws,
        "t-brief",
        "task/updateBrief",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "title": "Build API Spec v2"
        }),
    )
    .await;
    rev = brief_res["result"]["task"]["revision"].as_i64().unwrap();

    // 5. `task/updateGraph` — reject cyclic dependency, accept valid graph update
    let cycle_res = ws_call(
        &mut ws,
        "t-cycle",
        "task/updateGraph",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItems": [
                { "id": design_id, "title": "Draft outline", "dependsOn": [implement_id] },
                { "id": implement_id, "title": "Write full spec", "dependsOn": [design_id] }
            ]
        }),
    )
    .await;
    assert_eq!(cycle_res["error"]["code"], -32600);
    assert!(
        cycle_res["error"]["message"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase()
            .contains("cycle")
    );

    let graph_res = ws_call(
        &mut ws,
        "t-graph",
        "task/updateGraph",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItems": [
                { "id": design_id, "title": "Draft outline", "expectedOutputs": ["outline"] },
                { "id": implement_id, "title": "Write full spec", "dependsOn": [design_id], "expectedOutputs": ["spec.md"] }
            ]
        }),
    )
    .await;
    rev = graph_res["result"]["task"]["revision"].as_i64().unwrap();

    // 6. `task/thread/create` — creates worker thread (also excluded from `thread/list`)
    let th_create_res = ws_call(
        &mut ws,
        "t-th-create",
        "task/thread/create",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "title": "Spec Worker 1"
        }),
    )
    .await;
    assert!(
        th_create_res.get("error").is_none(),
        "task/thread/create failed: {th_create_res}"
    );
    rev = th_create_res["result"]["task"]["revision"]
        .as_i64()
        .unwrap();
    let worker_task_thread_id = th_create_res["result"]["task"]["threads"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let primary_task_thread_id = th_create_res["result"]["task"]["threads"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let thread_list_after = ws_call(&mut ws, "th-list-2", "thread/list", json!({})).await;
    assert_eq!(
        thread_list_after["result"]["threads"]
            .as_array()
            .unwrap()
            .len(),
        0,
        "worker task thread must remain hidden from thread/list"
    );

    // 7. `task/workItem/claim` — DAG gating + atomic ownership
    let premature_claim = ws_call(
        &mut ws,
        "t-claim-premature",
        "task/workItem/claim",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItemId": implement_id,
            "taskThreadId": worker_task_thread_id
        }),
    )
    .await;
    assert_eq!(premature_claim["error"]["code"], -32600);

    let claim_design = ws_call(
        &mut ws,
        "t-claim-design",
        "task/workItem/claim",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItemId": design_id,
            "taskThreadId": worker_task_thread_id
        }),
    )
    .await;
    rev = claim_design["result"]["task"]["revision"].as_i64().unwrap();

    // Verify `task_work_item_claims` row is persisted while claimed!
    {
        let conn = Connection::open(iso.home.join(".cowork/sessions.db")).unwrap();
        let active_claims: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_work_item_claims", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            active_claims, 1,
            "expected active claim row in task_work_item_claims"
        );
    }

    // Conflicting claim from another task thread is rejected!
    let conflicting_claim = ws_call(
        &mut ws,
        "t-claim-conflict",
        "task/workItem/claim",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItemId": design_id,
            "taskThreadId": primary_task_thread_id
        }),
    )
    .await;
    assert_eq!(conflicting_claim["error"]["code"], -32600);

    // 8. `task/workItem/mark` — complete `design`, then claim & complete `implement`
    fs::write(iso.workspace.join("outline"), "# Outline\n").unwrap();
    let outline_reg = ws_call(
        &mut ws,
        "t-art-outline",
        "task/artifact/register",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "path": "outline",
            "title": "Outline",
            "kind": "document",
            "workItemId": design_id
        }),
    )
    .await;
    rev = outline_reg["result"]["task"]["revision"].as_i64().unwrap();

    let mark_design = ws_call(
        &mut ws,
        "t-mark-design",
        "task/workItem/mark",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItemId": design_id,
            "status": "done",
            "completionEvidence": "Outline drafted"
        }),
    )
    .await;
    rev = mark_design["result"]["task"]["revision"].as_i64().unwrap();

    let claim_impl = ws_call(
        &mut ws,
        "t-claim-impl",
        "task/workItem/claim",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItemId": implement_id,
            "taskThreadId": primary_task_thread_id
        }),
    )
    .await;
    rev = claim_impl["result"]["task"]["revision"].as_i64().unwrap();

    fs::write(&rev_file_path, "# Spec v1\n\nInitial endpoints.\n").unwrap();
    let mark_impl = ws_call(
        &mut ws,
        "t-mark-impl",
        "task/workItem/mark",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "workItemId": implement_id,
            "status": "done",
            "completionEvidence": "Wrote spec.md"
        }),
    )
    .await;
    rev = mark_impl["result"]["task"]["revision"].as_i64().unwrap();

    // 9. `task/decision/record`
    let dec_res = ws_call(
        &mut ws,
        "t-dec",
        "task/decision/record",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "question": "Versioning scheme?",
            "resolution": "URL path /v1",
            "source": "user",
            "scope": "project",
            "confidence": 1.0
        }),
    )
    .await;
    rev = dec_res["result"]["task"]["revision"].as_i64().unwrap();

    // 10. `task/blocker/report` & 11. `task/blocker/resolve`
    let blk_rep = ws_call(
        &mut ws,
        "t-blk-rep",
        "task/blocker/report",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "description": "Waiting on auth schema review",
            "blocking": true,
            "workItemId": implement_id
        }),
    )
    .await;
    assert_eq!(blk_rep["result"]["task"]["status"], "blocked");
    rev = blk_rep["result"]["task"]["revision"].as_i64().unwrap();
    let blocker_id = blk_rep["result"]["task"]["blockers"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let blk_res = ws_call(
        &mut ws,
        "t-blk-res",
        "task/blocker/resolve",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "blockerId": blocker_id
        }),
    )
    .await;
    assert_eq!(blk_res["result"]["task"]["status"], "working");
    rev = blk_res["result"]["task"]["revision"].as_i64().unwrap();

    // 12. `task/questions/resolve` (non-blocking question)
    let q_res = ws_call(
        &mut ws,
        "t-q-res",
        "task/questions/resolve",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "answers": [
                { "questionId": question_id, "text": "Both internal and partner engineers" }
            ]
        }),
    )
    .await;
    assert!(
        q_res.get("error").is_none(),
        "questions/resolve failed: {q_res}"
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    let refreshed = ws_call(
        &mut ws,
        "t-read-after-q",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    rev = refreshed["result"]["task"]["revision"].as_i64().unwrap();

    // 13. `task/artifact/register` & 14. `task/artifact/read`
    let art_reg = ws_call(
        &mut ws,
        "t-art-reg",
        "task/artifact/register",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "path": "spec.md",
            "title": "API Specification",
            "kind": "document",
            "changeSummary": "Initial spec",
            "workItemId": implement_id
        }),
    )
    .await;
    assert!(
        art_reg.get("error").is_none(),
        "artifact/register failed: {art_reg}"
    );
    rev = art_reg["result"]["task"]["revision"].as_i64().unwrap();
    let artifact_id = art_reg["result"]["task"]["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["path"].as_str().is_some_and(|p| p.ends_with("spec.md")))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let art_read = ws_call(
        &mut ws,
        "t-art-read",
        "task/artifact/read",
        json!({ "taskId": task_id, "artifactId": artifact_id }),
    )
    .await;
    let v1_id = art_read["result"]["detail"]["versions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let v1_sha = art_read["result"]["detail"]["versions"][0]["sha256"]
        .as_str()
        .unwrap()
        .to_owned();

    // Verify content-addressed SHA-256 blob on disk under `<cowork_home>/artifacts/objects/sha256/<2>/<sha>` with 0600/0700!
    let shard_dir = iso
        .home
        .join(".cowork/artifacts/objects/sha256")
        .join(&v1_sha[..2]);
    let blob_file = shard_dir.join(&v1_sha);
    assert!(
        blob_file.is_file(),
        "expected SHA-256 blob at {blob_file:?}"
    );
    assert_eq!(
        fs::metadata(&shard_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&blob_file).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // 15. `task/artifact/version/capture`
    fs::write(
        &rev_file_path,
        "# Spec v2\n\nInitial endpoints.\n\n## Rate Limits\n100 req/s.\n",
    )
    .unwrap();
    let art_cap = ws_call(
        &mut ws,
        "t-art-cap",
        "task/artifact/version/capture",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "expectedRevision": rev,
            "changeSummary": "Add rate limits"
        }),
    )
    .await;
    rev = art_cap["result"]["task"]["revision"].as_i64().unwrap();
    let v2_id = art_cap["result"]["detail"]["versions"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 16. `task/artifact/version/preview` & 17. `task/artifact/version/compare`
    let art_prev = ws_call(
        &mut ws,
        "t-art-prev",
        "task/artifact/version/preview",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "versionId": v2_id
        }),
    )
    .await;
    assert_eq!(art_prev["result"]["preview"]["kind"], "text");
    assert!(
        art_prev["result"]["preview"]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Rate Limits")
    );

    let art_cmp = ws_call(
        &mut ws,
        "t-art-cmp",
        "task/artifact/version/compare",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "baseVersionId": v1_id,
            "targetVersionId": v2_id
        }),
    )
    .await;
    assert_eq!(art_cmp["result"]["comparison"]["kind"], "text");
    assert!(
        art_cmp["result"]["comparison"]["summary"]["totalChanges"]
            .as_i64()
            .unwrap()
            > 0
    );

    // 18. `task/artifact/version/restore` — external edit triggers deterministic `artifact_conflict`!
    fs::write(
        &rev_file_path,
        "# Externally Edited Spec!\nDo not clobber!\n",
    )
    .unwrap();
    let conflict_restore = ws_call(
        &mut ws,
        "t-art-restore-conflict",
        "task/artifact/version/restore",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "versionId": v1_id,
            "expectedRevision": rev
        }),
    )
    .await;
    assert_eq!(conflict_restore["error"]["code"], -32600);
    assert_eq!(
        conflict_restore["error"]["data"]["category"],
        "artifact_conflict"
    );
    assert_eq!(
        fs::read_to_string(&rev_file_path).unwrap(),
        "# Externally Edited Spec!\nDo not clobber!\n",
        "conflicting restore must never overwrite externally edited workspace file!"
    );

    // Capture external edit, then cleanly restore v2!
    let cap_ext = ws_call(
        &mut ws,
        "t-art-cap-ext",
        "task/artifact/version/capture",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "expectedRevision": rev,
            "changeSummary": "Capture external edit"
        }),
    )
    .await;
    rev = cap_ext["result"]["task"]["revision"].as_i64().unwrap();

    let clean_restore = ws_call(
        &mut ws,
        "t-art-restore-ok",
        "task/artifact/version/restore",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "versionId": v2_id,
            "expectedRevision": rev,
            "changeSummary": "Restore v2"
        }),
    )
    .await;
    assert!(
        clean_restore.get("error").is_none(),
        "clean restore failed: {clean_restore}"
    );
    rev = clean_restore["result"]["task"]["revision"]
        .as_i64()
        .unwrap();
    let restored_ver_id = clean_restore["result"]["detail"]["versions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        fs::read_to_string(&rev_file_path)
            .unwrap()
            .contains("## Rate Limits")
    );

    // 19. `task/artifact/version/accept`
    let accept_ver = ws_call(
        &mut ws,
        "t-art-accept",
        "task/artifact/version/accept",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "versionId": restored_ver_id,
            "expectedRevision": rev
        }),
    )
    .await;
    assert_eq!(
        accept_ver["result"]["detail"]["versions"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["reviewStatus"],
        "accepted"
    );
    let versions_before_rev = accept_ver["result"]["detail"]["versions"]
        .as_array()
        .unwrap()
        .len();
    rev = accept_ver["result"]["task"]["revision"].as_i64().unwrap();

    // 20. `task/artifact/revision/start` — runs revision thread turn & settles new version!
    let rev_start = ws_call(
        &mut ws,
        "t-art-rev-start",
        "task/artifact/revision/start",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "baseVersionId": restored_ver_id,
            "expectedRevision": rev,
            "instruction": "Add Rollback section"
        }),
    )
    .await;
    assert!(
        rev_start.get("error").is_none(),
        "revision/start failed: {rev_start}"
    );
    let _ = tokio::time::timeout(Duration::from_secs(5), rev_turn_done.notified()).await;
    // Wait until activeRevision settles to null and new version is captured
    for _ in 0..40 {
        let r = ws_call(
            &mut ws,
            "t-art-read-poll",
            "task/artifact/read",
            json!({ "taskId": task_id, "artifactId": artifact_id }),
        )
        .await;
        if r["result"]["detail"]["activeRevision"].is_null()
            && r["result"]["detail"]["versions"]
                .as_array()
                .is_some_and(|v| v.len() > versions_before_rev)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        fs::read_to_string(&rev_file_path)
            .unwrap()
            .contains("## Rollback")
    );

    // Revision completed -> mark `implement` done again if revision reopened work item
    let cur_task = ws_call(
        &mut ws,
        "t-read-post-rev",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    rev = cur_task["result"]["task"]["revision"].as_i64().unwrap();
    if cur_task["result"]["task"]["workItems"][1]["status"] != "done" {
        let m = ws_call(
            &mut ws,
            "t-mark-impl-2",
            "task/workItem/mark",
            json!({
                "taskId": task_id,
                "expectedRevision": rev,
                "workItemId": implement_id,
                "status": "done",
                "completionEvidence": "Revised spec.md with Rollback"
            }),
        )
        .await;
        rev = m["result"]["task"]["revision"].as_i64().unwrap();
    }

    // 21. `task/proposeCompletion` -> `awaiting_review`
    let prop_res = ws_call(
        &mut ws,
        "t-prop",
        "task/proposeCompletion",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "summary": "Spec complete with rate limits and rollback."
        }),
    )
    .await;
    assert_eq!(
        prop_res["result"]["task"]["status"], "awaiting_review",
        "proposeCompletion failed: {prop_res}"
    );
    rev = prop_res["result"]["task"]["revision"].as_i64().unwrap();

    // 22. `task/requestChanges` -> `working`, then re-propose completion
    let req_chg = ws_call(
        &mut ws,
        "t-req-chg",
        "task/requestChanges",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "feedback": "Double check formatting"
        }),
    )
    .await;
    assert_eq!(req_chg["result"]["task"]["status"], "working");
    rev = req_chg["result"]["task"]["revision"].as_i64().unwrap();

    let prop_res2 = ws_call(
        &mut ws,
        "t-prop-2",
        "task/proposeCompletion",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "summary": "Verified formatting."
        }),
    )
    .await;
    assert_eq!(prop_res2["result"]["task"]["status"], "awaiting_review");
    rev = prop_res2["result"]["task"]["revision"].as_i64().unwrap();

    // 23. `task/accept` -> `completed` + terminal lock on task threads!
    let accept_res = ws_call(
        &mut ws,
        "t-accept",
        "task/accept",
        json!({
            "taskId": task_id,
            "expectedRevision": rev
        }),
    )
    .await;
    assert_eq!(accept_res["result"]["task"]["status"], "completed");
    rev = accept_res["result"]["task"]["revision"].as_i64().unwrap();

    let locked_terminal = ws_call(
        &mut ws,
        "t-term-lock",
        "turn/start",
        json!({
            "threadId": primary_session_id,
            "input": "try writing to completed task thread"
        }),
    )
    .await;
    assert_eq!(locked_terminal["error"]["code"], -32600);
    assert_eq!(locked_terminal["error"]["data"]["category"], "task_locked");
    assert_eq!(
        locked_terminal["error"]["data"]["lockKind"],
        "terminal_task_thread"
    );

    // 24. `task/reopen` -> `working`
    let reopen_res = ws_call(
        &mut ws,
        "t-reopen",
        "task/reopen",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "reason": "Follow-up tweak"
        }),
    )
    .await;
    assert_eq!(reopen_res["result"]["task"]["status"], "working");
    rev = reopen_res["result"]["task"]["revision"].as_i64().unwrap();

    // 25. `task/cancel` -> `cancelled`
    let cancel_res = ws_call(
        &mut ws,
        "t-cancel",
        "task/cancel",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "reason": "Superseded"
        }),
    )
    .await;
    assert_eq!(cancel_res["result"]["task"]["status"], "cancelled");
    rev = cancel_res["result"]["task"]["revision"].as_i64().unwrap();

    // 26. `task/retry` — transition a reopened task to failed via coordinator and exercise `task/retry`!
    let reopen2 = ws_call(
        &mut ws,
        "t-reopen-2",
        "task/reopen",
        json!({
            "taskId": task_id,
            "expectedRevision": rev
        }),
    )
    .await;
    rev = reopen2["result"]["task"]["revision"].as_i64().unwrap();

    let failed_rec = server
        .runtime()
        .task_coordinator
        .transition(
            &task_id,
            &iso.workspace.to_string_lossy(),
            rev,
            cowork_storage::TaskStatus::Failed,
            "Simulated failure",
            Some("Simulated error"),
            None,
        )
        .await
        .unwrap();
    rev = failed_rec.revision;

    let retry_res = ws_call(
        &mut ws,
        "t-retry",
        "task/retry",
        json!({
            "taskId": task_id,
            "expectedRevision": rev
        }),
    )
    .await;
    assert!(
        retry_res.get("error").is_none(),
        "task/retry failed: {retry_res}"
    );
    assert_eq!(retry_res["result"]["task"]["status"], "working");
    assert_eq!(retry_res["result"]["retryStatus"], "queued");

    // Verify all 15 non-review SQLite task tables have persisted rows in `sessions.db`!
    let db_path = iso.home.join(".cowork/sessions.db");
    let conn = Connection::open(&db_path).unwrap();
    for table in [
        "tasks",
        "task_threads",
        "task_requirements",
        "task_work_items",
        "task_work_item_dependencies",
        "task_decisions",
        "task_artifacts",
        "task_blockers",
        "task_activity",
        "task_checkpoints",
        "task_directive_receipts",
        "task_artifact_versions",
        "task_artifact_revisions",
        "task_questions",
    ] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert!(count > 0, "expected persisted rows in SQLite table {table}");
    }

    tokio::time::sleep(Duration::from_millis(150)).await;
    server.shutdown().await;
    llm_task.abort();
}

// ============================================================================
// 2. Chat-to-Task Promotion, Source Locks, Blocking Question Auto-Resume,
//    3-Round Independent `reviewTask`, Tamper Invalidation & Quiescing
// ============================================================================
#[tokio::test]
async fn chat_to_task_promotion_locks_blocking_question_resume_and_3_round_review_e2e() {
    let mut iso = IsolatedTaskServerEnv::new("cowork-task-promo-", true);
    let sneaky_path = iso.workspace.join("sneaky-same-step.txt");
    let deliverable_path = iso.workspace.join("deliverable.md");

    let captured_reqs: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured_for_llm = Arc::clone(&captured_reqs);
    let primary_phase = Arc::new(AtomicUsize::new(0));
    let primary_phase_route = Arc::clone(&primary_phase);
    let reviewer_round = Arc::new(AtomicUsize::new(0));
    let reviewer_round_route = Arc::clone(&reviewer_round);
    let slow_worker_started = Arc::new(tokio::sync::Notify::new());
    let slow_worker_started_route = Arc::clone(&slow_worker_started);
    let slow_worker_hold = Arc::new(tokio::sync::Notify::new());
    let slow_worker_hold_route = Arc::clone(&slow_worker_hold);

    let sneaky_for_llm = sneaky_path.clone();
    let deliv_for_llm = deliverable_path.clone();

    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let captured = Arc::clone(&captured_for_llm);
            let phase = Arc::clone(&primary_phase_route);
            let rev_ctr = Arc::clone(&reviewer_round_route);
            let worker_started = Arc::clone(&slow_worker_started_route);
            let worker_hold = Arc::clone(&slow_worker_hold_route);
            let sneaky = sneaky_for_llm.clone();
            let deliv = deliv_for_llm.clone();

            async move {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let model = parsed.get("model").and_then(Value::as_str).unwrap_or("");
                if model.contains("mini") || model.contains("nano") {
                    return sse_resp(chat_sse_text("Promotion Flow"));
                }

                captured.lock().unwrap().push(parsed.clone());

                // 1. Slow background worker subagent (to prove `quiesceTaskThreads` stops running children!)
                if req_messages_contain(&parsed, "SLOW_BACKGROUND_WORKER") {
                    worker_started.notify_waiters();
                    worker_hold.notified().await;
                    return sse_resp(chat_sse_text("Worker finished."));
                }

                // 2. Independent `"reviewer"` subagent spawned by `reviewTask`
                if req_messages_contain(
                    &parsed,
                    "finish with VERDICT: PASS, VERDICT: PARTIAL, or VERDICT: FAIL.",
                ) {
                    let r = rev_ctr.fetch_add(1, Ordering::SeqCst);
                    if r == 0 {
                        return sse_resp(chat_sse_text(
                            "Checked deliverable.\n- Add error handling note.\nVERDICT: PARTIAL",
                        ));
                    }
                    return sse_resp(chat_sse_text(
                        "Independent review verified all acceptance criteria.\nVERDICT: PASS",
                    ));
                }

                // 3. Source chat promotion turn: emits `createTask` AND a sneaky same-step `write`!
                if req_messages_contain(&parsed, "PROMOTE_THIS_CHAT_NOW") {
                    return sse_resp(chat_sse_tool_calls(&[
                        (
                            "call_create_task",
                            "createTask",
                            json!({
                                "idempotencyKey": "promo-idem-1",
                                "title": "Ship Deliverable",
                                "objective": "Produce verified deliverable.md",
                                "context": "Promoted from user chat",
                                "reviewRequired": true,
                                "reviewRounds": 3,
                                "requirements": [
                                    { "kind": "acceptance_criterion", "text": "Create deliverable.md" }
                                ],
                                "workItems": [
                                    { "key": "build", "title": "Write deliverable.md", "expectedOutputs": ["deliverable.md"] }
                                ],
                                "decisions": []
                            }),
                        ),
                        (
                            "call_sneaky_write",
                            "write",
                            json!({
                                "filePath": sneaky.to_string_lossy(),
                                "content": "should be blocked by active_source_chat lock!"
                            }),
                        ),
                    ]));
                }

                // 4. Promoted Task Primary Thread turns!
                let cur_rev = extract_latest_task_revision(&parsed);
                let work_item_id = extract_first_work_item_id(&parsed);

                let p = phase.fetch_add(1, Ordering::SeqCst);
                match p {
                    // Kickoff step 0: ask a blocking question via `request_input`!
                    // `taskUpdate` returns `continuation: "pause_for_input"` and sets `stop_after_step = true`!
                    0 => sse_resp(chat_sse_tool_calls(&[(
                        "call_pause_q",
                        "taskUpdate",
                        json!({
                            "idempotencyKey": "req-input-1",
                            "type": "request_input",
                            "expectedRevision": cur_rev,
                            "questions": [{
                                "header": "Target stack",
                                "question": "Should deliverable target Rust 2024?",
                                "urgency": "now",
                                "blocking": true
                            }]
                        }),
                    )])),

                    // Continuation turn after user resolves blocking question!
                    // Step 1: write deliverable.md
                    1 => sse_resp(chat_sse_tool_calls(&[(
                        "call_write_deliv",
                        "write",
                        json!({
                            "filePath": deliv.to_string_lossy(),
                            "content": "# Deliverable v1\n\nTargets Rust 2024.\n"
                        }),
                    )])),

                    // Step 2: register artifact `deliverable.md`
                    2 => sse_resp(chat_sse_tool_calls(&[(
                        "call_reg_art",
                        "taskUpdate",
                        json!({
                            "idempotencyKey": "reg-art-1",
                            "type": "register_artifact",
                            "expectedRevision": cur_rev,
                            "path": "deliverable.md",
                            "title": "Deliverable Doc",
                            "kind": "document",
                            "changeSummary": "Initial deliverable",
                            "workItemId": work_item_id
                        }),
                    )])),

                    // Step 3: mark work item `done`
                    3 => sse_resp(chat_sse_tool_calls(&[(
                        "call_mark_done",
                        "taskUpdate",
                        json!({
                            "idempotencyKey": "mark-wi-done-1",
                            "type": "mark_work_item",
                            "expectedRevision": cur_rev,
                            "workItemId": work_item_id,
                            "status": "done",
                            "completionEvidence": "Wrote and registered deliverable.md"
                        }),
                    )])),

                    // Step 4: Round 1 `reviewTask` -> reviewer returns PARTIAL
                    4 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_1",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Check completeness"
                        }),
                    )])),

                    // Step 5: Try Round 2 `reviewTask` BEFORE `address_review` (must error!)
                    5 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_premature",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev
                        }),
                    )])),

                    // Step 6: Finish continuation turn so test can verify unaddressed PARTIAL blocks completion
                    6 => sse_resp(chat_sse_text(
                        "Paused after PARTIAL review check; ready to address findings.",
                    )),

                    // Phase 2 turn (after `address_review`): run 3 clean PASS rounds!
                    7 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_pass_1",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Pass round 1"
                        }),
                    )])),
                    8 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_pass_2",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Pass round 2"
                        }),
                    )])),
                    9 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_pass_3",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Pass round 3"
                        }),
                    )])),
                    10 => sse_resp(chat_sse_text("Completed 3 clean PASS review rounds.")),

                    // Phase 3 turn (after tamper re-capture): 3 fresh PASS rounds on new material fingerprint!
                    11 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_repass_1",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Re-verify round 1"
                        }),
                    )])),
                    12 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_repass_2",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Re-verify round 2"
                        }),
                    )])),
                    13 => sse_resp(chat_sse_tool_calls(&[(
                        "call_rev_repass_3",
                        "reviewTask",
                        json!({
                            "expectedRevision": cur_rev,
                            "focus": "Re-verify round 3"
                        }),
                    )])),
                    _ => sse_resp(chat_sse_text("All fresh review rounds passed.")),
                }
            }
        }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });

    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );
    let user_cfg_dir = iso.home.join(".cowork/config");
    fs::create_dir_all(&user_cfg_dir).unwrap();
    fs::write(
        user_cfg_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({
            "provider": "together",
            "model": "deepseek-ai/DeepSeek-V3"
        }))
        .unwrap(),
    )
    .unwrap();

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();

    // Start ordinary source chat thread
    let started =
        ws_call_collecting(&mut ws, "src-start", "thread/start", json!({}), &mut notifs).await;
    let source_thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Trigger chat-to-task promotion via `createTask` tool + sneaky same-step `write`!
    let promo_turn = ws_call_collecting(
        &mut ws,
        "src-turn",
        "turn/start",
        json!({
            "threadId": source_thread_id,
            "input": "PROMOTE_THIS_CHAT_NOW"
        }),
        &mut notifs,
    )
    .await;
    assert!(promo_turn.get("error").is_none());
    let promo_turn_id = promo_turn["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Wait for `task/created`, source `turn/completed`, AND task status reaching `blocked` (from kickoff `request_input`)!
    collect_until(&mut ws, &mut notifs, 8_000, |ns| {
        let has_created = ns.iter().any(|n| n["method"] == "task/created");
        let has_src_done = ns
            .iter()
            .any(|n| n["method"] == "turn/completed" && n["params"]["turn"]["id"] == promo_turn_id);
        let has_blocked = ns.iter().any(|n| {
            n["method"] == "task/updated"
                && n["params"]["task"]["status"] == "blocked"
                && n["params"]["task"]["blockingQuestionCount"] == 1
        });
        has_created && has_src_done && has_blocked
    })
    .await;

    // Sneaky same-step `write` after `createTask` MUST have been blocked!
    assert!(
        !sneaky_path.exists(),
        "same-step write after createTask must be blocked by active_source_chat lock!"
    );

    let created_notif = notifs
        .iter()
        .find(|n| n["method"] == "task/created")
        .expect("task/created notification emitted to source chat subscriber");
    assert_eq!(created_notif["params"]["sourceSessionId"], source_thread_id);
    assert_eq!(created_notif["params"]["takeover"], true);
    assert_eq!(
        created_notif["params"]["workspaceDisposition"],
        "existing_project"
    );
    let task_id = created_notif["params"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let task_session_id = created_notif["params"]["task"]["threads"][0]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Verify `sourceThreadId` is `task_locked` across `turn/start`, `turn/steer`, `agent/spawn`, and `session/delete`!
    let locked_turn = ws_call(
        &mut ws,
        "lock-turn",
        "turn/start",
        json!({
            "threadId": source_thread_id,
            "input": "try chatting on promoted source thread"
        }),
    )
    .await;
    assert_eq!(locked_turn["error"]["code"], -32600);
    assert_eq!(locked_turn["error"]["data"]["category"], "task_locked");
    assert_eq!(
        locked_turn["error"]["data"]["lockKind"],
        "active_source_chat"
    );
    assert_eq!(locked_turn["error"]["data"]["taskId"], task_id);

    let locked_steer = ws_call(
        &mut ws,
        "lock-steer",
        "turn/steer",
        json!({
            "threadId": source_thread_id,
            "input": "try steering promoted source thread"
        }),
    )
    .await;
    assert_eq!(locked_steer["error"]["code"], -32600);
    assert_eq!(locked_steer["error"]["data"]["category"], "task_locked");

    let locked_spawn = ws_call(
        &mut ws,
        "lock-spawn",
        "cowork/session/agent/spawn",
        json!({
            "threadId": source_thread_id,
            "message": "try spawning child on locked source chat"
        }),
    )
    .await;
    assert_eq!(locked_spawn["error"]["code"], -32600);
    assert_eq!(locked_spawn["error"]["data"]["category"], "task_locked");

    let locked_del = ws_call(
        &mut ws,
        "lock-del",
        "cowork/session/delete",
        json!({ "targetSessionId": source_thread_id }),
    )
    .await;
    assert_eq!(locked_del["error"]["code"], -32600);
    assert!(
        locked_del["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("Chat is locked by active task")
    );

    // Verify `thread/list` includes `sourceThreadId` and EXCLUDES `task_session_id`!
    let tl = ws_call(&mut ws, "tl-check", "thread/list", json!({})).await;
    let listed_ids: Vec<&str> = tl["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["id"].as_str())
        .collect();
    assert_eq!(listed_ids, vec![source_thread_id.as_str()]);

    // Verify system prompt & toolset gating sent to LLM on the task primary thread!
    {
        let reqs = captured_reqs.lock().unwrap();
        let task_req = reqs
            .iter()
            .find(|r| {
                r["messages"][0]["content"]
                    .as_str()
                    .unwrap_or("")
                    .contains("## Active Task")
            })
            .expect("expected LLM request with ## Active Task system prompt section");
        let tool_names: Vec<&str> = task_req["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert!(tool_names.contains(&"taskUpdate"));
        assert!(tool_names.contains(&"reviewTask"));
        assert!(!tool_names.contains(&"createTask"));
        assert!(!tool_names.contains(&"AskUserQuestion"));
        assert!(!tool_names.contains(&"todoWrite"));
        assert!(!tool_names.contains(&"threadManagement"));
    }

    // Wait briefly so kickoff turn is completely settled before resolving the blocking question
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Read current `blocked` task state and resolve the blocking question -> auto-resumes primary thread!
    let paused_read = ws_call(
        &mut ws,
        "t-read-paused",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    assert_eq!(paused_read["result"]["task"]["status"], "blocked");
    let paused_rev = paused_read["result"]["task"]["revision"].as_i64().unwrap();
    let blocking_q_id = paused_read["result"]["task"]["questions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Subscribe to task_session_id so we can deterministically observe its continuation `turn/completed`
    let _ = ws_call(
        &mut ws,
        "sub-task-th",
        "thread/resume",
        json!({ "threadId": task_session_id }),
    )
    .await;

    notifs.clear();
    let resolve_q_res = ws_call_collecting(
        &mut ws,
        "t-resolve-blocking",
        "task/questions/resolve",
        json!({
            "taskId": task_id,
            "expectedRevision": paused_rev,
            "answers": [
                { "questionId": blocking_q_id, "text": "Yes, target Rust 2024 edition." }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(resolve_q_res["result"]["resumeStatus"], "queued");
    assert_eq!(resolve_q_res["result"]["task"]["status"], "working");

    // Wait for the auto-resumed continuation turn on `task_session_id` to complete!
    collect_until(&mut ws, &mut notifs, 10_000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "turn/completed" && n["params"]["threadId"] == task_session_id)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Verify continuation turn wrote deliverable.md, registered artifact, marked work item done,
    // recorded Round 1 PARTIAL review, and rejected Round 2 review before `address_review`!
    assert!(deliverable_path.is_file());
    let after_cont = ws_call(
        &mut ws,
        "t-read-cont",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    assert_eq!(
        after_cont["result"]["task"]["artifacts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reviews_after_r1 = server
        .runtime()
        .session_db
        .list_task_reviews(&task_id)
        .unwrap();
    assert_eq!(
        reviews_after_r1.len(),
        1,
        "second reviewTask before address_review must be rejected"
    );
    assert_eq!(
        reviews_after_r1[0].verdict,
        cowork_storage::TaskReviewVerdict::Partial
    );
    let round1_review_id = reviews_after_r1[0].id.clone();

    let mut rev = after_cont["result"]["task"]["revision"].as_i64().unwrap();
    let artifact_id = after_cont["result"]["task"]["artifacts"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Premature `task/proposeCompletion` must fail because 3 clean PASS rounds haven't passed!
    let premature_prop = ws_call(
        &mut ws,
        "t-prop-premature",
        "task/proposeCompletion",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "summary": "Try completing before 3 PASS reviews"
        }),
    )
    .await;
    assert_eq!(premature_prop["error"]["code"], -32600);
    assert!(
        premature_prop["error"]["message"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase()
            .contains("review")
    );

    // Address the PARTIAL review finding via coordinator `address_review`, then run turn for 3 clean PASS rounds!
    let addressed = server
        .runtime()
        .task_coordinator
        .address_review(
            &task_id,
            &iso.workspace.to_string_lossy(),
            Some(&task_session_id),
            rev,
            &round1_review_id,
            "Documented error handling.",
        )
        .await
        .unwrap();
    let _ = addressed.revision;

    notifs.clear();
    let pass_turn = ws_call_collecting(
        &mut ws,
        "t-pass-rounds",
        "turn/start",
        json!({
            "threadId": task_session_id,
            "input": "Run the 3 independent review rounds now."
        }),
        &mut notifs,
    )
    .await;
    let pass_turn_id = pass_turn["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    collect_until(&mut ws, &mut notifs, 10_000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "turn/completed" && n["params"]["turn"]["id"] == pass_turn_id)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let reviews_after_pass = server
        .runtime()
        .session_db
        .list_task_reviews(&task_id)
        .unwrap();
    assert_eq!(
        reviews_after_pass.len(),
        4,
        "expected 1 addressed PARTIAL + 3 clean PASS review rounds"
    );
    let after_pass = ws_call(
        &mut ws,
        "t-read-pass",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    rev = after_pass["result"]["task"]["revision"].as_i64().unwrap();

    // Propose completion -> succeeds and enters `awaiting_review`!
    let prop_ok = ws_call(
        &mut ws,
        "t-prop-ok",
        "task/proposeCompletion",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "summary": "Deliverable verified across 3 independent review rounds."
        }),
    )
    .await;
    assert_eq!(
        prop_ok["result"]["task"]["status"], "awaiting_review",
        "proposeCompletion failed: {prop_ok}"
    );
    rev = prop_ok["result"]["task"]["revision"].as_i64().unwrap();

    // Tamper `deliverable.md` on disk AFTER the 3 review rounds -> `task/accept` MUST reject & return task to `working`!
    fs::write(
        &deliverable_path,
        "# Deliverable v2 (Post-Review Edit)\n\nTargets Rust 2024 + Error Handling.\n",
    )
    .unwrap();
    let tampered_accept = ws_call(
        &mut ws,
        "t-accept-tampered",
        "task/accept",
        json!({
            "taskId": task_id,
            "expectedRevision": rev
        }),
    )
    .await;
    assert_eq!(tampered_accept["error"]["code"], -32600);
    let after_tamper = ws_call(
        &mut ws,
        "t-read-tamper",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    assert_eq!(
        after_tamper["result"]["task"]["status"], "working",
        "stale acceptance after live file mutation must return task to working!"
    );
    rev = after_tamper["result"]["task"]["revision"].as_i64().unwrap();

    // Capture the updated artifact version, run 3 fresh review rounds bound to the new fingerprint,
    // spawn a live background child subagent on `task_session_id`, and accept the task!
    let recap = ws_call(
        &mut ws,
        "t-recap",
        "task/artifact/version/capture",
        json!({
            "taskId": task_id,
            "artifactId": artifact_id,
            "expectedRevision": rev,
            "changeSummary": "Capture post-review edit"
        }),
    )
    .await;
    let _ = recap["result"]["task"]["revision"].as_i64().unwrap();

    notifs.clear();
    let repass_turn = ws_call_collecting(
        &mut ws,
        "t-repass-rounds",
        "turn/start",
        json!({
            "threadId": task_session_id,
            "input": "Re-verify updated deliverable across 3 rounds."
        }),
        &mut notifs,
    )
    .await;
    let repass_turn_id = repass_turn["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    collect_until(&mut ws, &mut notifs, 10_000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "turn/completed" && n["params"]["turn"]["id"] == repass_turn_id)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let ready_again = ws_call(
        &mut ws,
        "t-read-ready2",
        "task/read",
        json!({ "taskId": task_id }),
    )
    .await;
    rev = ready_again["result"]["task"]["revision"].as_i64().unwrap();

    let prop_final = ws_call(
        &mut ws,
        "t-prop-final",
        "task/proposeCompletion",
        json!({
            "taskId": task_id,
            "expectedRevision": rev,
            "summary": "Re-verified after edit."
        }),
    )
    .await;
    assert_eq!(prop_final["result"]["task"]["status"], "awaiting_review");
    rev = prop_final["result"]["task"]["revision"].as_i64().unwrap();

    // Spawn a slow background subagent under `task_session_id` to verify `quiesceTaskThreads` stops it!
    let spawn_bg = ws_call(
        &mut ws,
        "spawn-bg-worker",
        "cowork/session/agent/spawn",
        json!({
            "threadId": task_session_id,
            "role": "worker",
            "message": "SLOW_BACKGROUND_WORKER"
        }),
    )
    .await;
    assert!(
        spawn_bg.get("error").is_none(),
        "spawn bg worker failed: {spawn_bg}"
    );
    tokio::time::timeout(Duration::from_secs(5), slow_worker_started.notified())
        .await
        .expect("background worker subagent started");

    // Accept the task -> `quiesceTaskThreads` interrupts & reaps the slow background subagent!
    let final_accept = ws_call(
        &mut ws,
        "t-accept-final",
        "task/accept",
        json!({
            "taskId": task_id,
            "expectedRevision": rev
        }),
    )
    .await;
    assert_eq!(final_accept["result"]["task"]["status"], "completed");

    // Assert zero busy task/child threads remain after terminal quiesce!
    let ctrl_children = server.runtime().list_child_agents(&task_session_id, true);
    assert!(
        ctrl_children.iter().all(|a| !a.busy),
        "all subagent threads must be quiesced after task/accept: {ctrl_children:?}"
    );

    // Assert `source_thread_id` is now UNLOCKED (`active_source_chat` lock lifted once task is completed!)
    assert!(
        server
            .runtime()
            .get_session_task_lock(&source_thread_id)
            .is_none(),
        "source chat thread should unlock after task reaches terminal completed state"
    );
    // Assert `task_session_id` IS locked with `terminal_task_thread`!
    let term_lock = server
        .runtime()
        .get_session_task_lock(&task_session_id)
        .expect("completed task primary thread must hold terminal_task_thread lock");
    assert_eq!(
        term_lock.data.lock_kind,
        cowork_harness::tasks::TaskLockKind::TerminalTaskThread
    );

    // Verify `task_reviews` in `sessions.db` contains all 7 persisted review rounds!
    let db_path = iso.home.join(".cowork/sessions.db");
    let conn = Connection::open(&db_path).unwrap();
    let review_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM task_reviews", [], |r| r.get(0))
        .unwrap();
    assert_eq!(review_count, 7);

    slow_worker_hold.notify_waiters();
    server.shutdown().await;
    llm_task.abort();
}

// ============================================================================
// 3. One-Off Chat Promotion (`promote_one_off`) & Active-Turn Question Steer
// ============================================================================
#[tokio::test]
async fn one_off_chat_promotion_and_active_turn_question_steer_e2e() {
    let mut iso = IsolatedTaskServerEnv::new("cowork-task-oneoff-", true);

    let hold_mid_turn = Arc::new(tokio::sync::Notify::new());
    let hold_mid_turn_route = Arc::clone(&hold_mid_turn);
    let mid_turn_waiting = Arc::new(tokio::sync::Notify::new());
    let mid_turn_waiting_route = Arc::clone(&mid_turn_waiting);
    let primary_step = Arc::new(AtomicUsize::new(0));
    let primary_step_route = Arc::clone(&primary_step);

    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let hold = Arc::clone(&hold_mid_turn_route);
            let waiting = Arc::clone(&mid_turn_waiting_route);
            let step = Arc::clone(&primary_step_route);
            async move {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let model = parsed.get("model").and_then(Value::as_str).unwrap_or("");
                if model.contains("mini") || model.contains("nano") {
                    return sse_resp(chat_sse_text("One-Off Promotion"));
                }

                if req_messages_contain(&parsed, "PROMOTE_ONE_OFF_CHAT") {
                    return sse_resp(chat_sse_tool_calls(&[(
                        "call_create_oneoff",
                        "createTask",
                        json!({
                            "idempotencyKey": "oneoff-idem-1",
                            "title": "Quick Note Task",
                            "objective": "Turn quick chat into durable task",
                            "context": "Started in ~/.cowork/chats",
                            "reviewRequired": false,
                            "reviewRounds": 0,
                            "requirements": [
                                { "kind": "acceptance_criterion", "text": "Write notes.md" }
                            ],
                            "workItems": [
                                { "key": "write", "title": "Write notes.md", "expectedOutputs": ["notes.md"] }
                            ]
                        }),
                    )]));
                }

                let cur_rev = extract_latest_task_revision(&parsed);
                let s = step.fetch_add(1, Ordering::SeqCst);
                match s {
                    // Kickoff step 0: emit a non-blocking question (`continuation: "continue"`),
                    // so the turn stays IN-PROGRESS for step 1!
                    0 => sse_resp(chat_sse_tool_calls(&[(
                        "call_nb_steer",
                        "taskUpdate",
                        json!({
                            "idempotencyKey": "nb-steer-1",
                            "type": "request_input",
                            "expectedRevision": cur_rev,
                            "questions": [{
                                "header": "Tone",
                                "question": "Concise bullets or prose?",
                                "urgency": "optional",
                                "blocking": false,
                                "defaultAction": "Concise bullets"
                            }]
                        }),
                    )])),
                    // Kickoff step 1: hold mid-turn while client resolves the non-blocking question -> triggers `steered`!
                    1 => {
                        waiting.notify_waiters();
                        hold.notified().await;
                        sse_resp(chat_sse_text("Proceeding with steered answer."))
                    }
                    _ => sse_resp(chat_sse_text("Steer received and incorporated.")),
                }
            }
        }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });

    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );

    let one_off_cwd = iso.home.join(".cowork/chats/quick-promo-1");
    fs::create_dir_all(&one_off_cwd).unwrap();
    let user_cfg_dir = iso.home.join(".cowork/config");
    fs::create_dir_all(&user_cfg_dir).unwrap();
    fs::write(
        user_cfg_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({
            "provider": "together",
            "model": "deepseek-ai/DeepSeek-V3"
        }))
        .unwrap(),
    )
    .unwrap();

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();

    // Start thread inside `~/.cowork/chats/quick-promo-1`
    let started = ws_call_collecting(
        &mut ws,
        "oneoff-start",
        "thread/start",
        json!({ "cwd": one_off_cwd.to_string_lossy() }),
        &mut notifs,
    )
    .await;
    assert!(
        started.get("error").is_none(),
        "one-off thread/start failed: {started}"
    );
    let one_off_thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Promote one-off chat via `createTask`
    let turn = ws_call_collecting(
        &mut ws,
        "oneoff-turn",
        "turn/start",
        json!({
            "threadId": one_off_thread_id,
            "input": "PROMOTE_ONE_OFF_CHAT"
        }),
        &mut notifs,
    )
    .await;
    assert!(turn.get("error").is_none());

    // Wait until the primary task thread reaches step 1 (mid-flight after recording non-blocking question!)
    tokio::time::timeout(Duration::from_secs(5), mid_turn_waiting.notified())
        .await
        .expect("task kickoff turn reached mid-flight hold");
    collect_until(&mut ws, &mut notifs, 2_000, |ns| {
        ns.iter().any(|n| n["method"] == "task/created")
    })
    .await;

    let created_notif = notifs
        .iter()
        .find(|n| n["method"] == "task/created")
        .expect("task/created emitted for one-off promotion");
    assert_eq!(
        created_notif["params"]["workspaceDisposition"],
        "promote_one_off"
    );
    let task_id = created_notif["params"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Simulate desktop promoting the one-off workspace to `"project"` in desktop `state.json`,
    // then resolve the non-blocking question via `task/questions/resolve` WHILE the primary turn is active -> `steered`!
    let canon_one_off = fs::canonicalize(&one_off_cwd).unwrap();
    if let Some(svc) = &server.runtime().desktop_service {
        svc.save_state_json(
            json!({
                "workspaces": [{
                    "id": "ws-promoted-1",
                    "name": "Quick Note Task",
                    "path": canon_one_off.to_string_lossy(),
                    "workspaceKind": "project"
                }]
            }),
            &iso.workspace,
        )
        .unwrap();

        let tr = ws_call(
            &mut ws,
            "oneoff-read",
            "task/read",
            json!({
                "cwd": canon_one_off.to_string_lossy(),
                "taskId": task_id
            }),
        )
        .await;
        assert!(
            tr.get("error").is_none(),
            "task/read on promoted one-off failed: {tr}"
        );
        let rev = tr["result"]["task"]["revision"].as_i64().unwrap();
        let qid = tr["result"]["task"]["questions"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let steered_res = ws_call(
            &mut ws,
            "oneoff-steer-q",
            "task/questions/resolve",
            json!({
                "cwd": canon_one_off.to_string_lossy(),
                "taskId": task_id,
                "expectedRevision": rev,
                "answers": [{ "questionId": qid, "text": "Use concise bullets" }]
            }),
        )
        .await;
        assert!(
            steered_res.get("error").is_none(),
            "steered questions/resolve failed: {steered_res}"
        );
        assert_eq!(steered_res["result"]["resumeStatus"], "steered");
    }

    hold_mid_turn.notify_waiters();
    tokio::time::sleep(Duration::from_millis(200)).await;
    server.shutdown().await;
    llm_task.abort();
}
