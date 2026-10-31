use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use data_encoding::BASE64;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedServerEnv {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedServerEnv {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-srv-harn-")
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
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
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
                "clientInfo": { "name": "harness-e2e-test", "version": "1.0.0" },
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
        let frame = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws open")
            .expect("ws frame ok");
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

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    let mut ignored = Vec::new();
    ws_call_collecting(ws, id, method, params, &mut ignored).await
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

#[tokio::test]
async fn websocket_turn_runner_executes_builtin_tools_idempotency_attachments_steer_and_todos() {
    let captured_bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let bodies_for_route = Arc::clone(&captured_bodies);

    let mock_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: axum::body::Bytes| {
            let bodies = Arc::clone(&bodies_for_route);
            async move {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let step_idx = {
                    let mut g = bodies.lock().unwrap();
                    let idx = g.len();
                    g.push(parsed);
                    idx
                };

                let sse = match step_idx {
                    0 => chat_sse_tool_call(
                        "call_write_1",
                        "write",
                        &json!({
                            "filePath": "notes.txt",
                            "content": "alpha\nbeta\ngamma\n"
                        }),
                    ),
                    1 => chat_sse_tool_call(
                        "call_edit_1",
                        "edit",
                        &json!({
                            "filePath": "notes.txt",
                            "oldString": "beta",
                            "newString": "BETA-EDITED"
                        }),
                    ),
                    2 => chat_sse_tool_call(
                        "call_todo_1",
                        "todoWrite",
                        &json!({
                            "todos": [
                                { "id": "t1", "content": "Verify notes.txt", "status": "completed", "priority": "high" }
                            ]
                        }),
                    ),
                    3 => chat_sse_tool_call(
                        "call_grep_1",
                        "grep",
                        &json!({
                            "pattern": "BETA-EDITED"
                        }),
                    ),
                    _ => chat_sse_text("All workspace tools succeeded cleanly!"),
                };

                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from(sse))
                    .unwrap()
            }
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move {
        let _ = axum::serve(listener, mock_app).await;
    });

    let mut iso = IsolatedServerEnv::new();
    fs::write(
        iso.workspace.join("AGENTS.md"),
        "Always honor project rule ALPHA-RULE-99.",
    )
    .unwrap();
    iso.env.insert(
        "NVIDIA_BASE_URL".into(),
        format!("http://127.0.0.1:{mock_port}/v1"),
    );
    iso.env
        .insert("NVIDIA_API_KEY".into(), "nvapi-mock-test".into());

    let server = start_server(iso.server_options(false)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    let start_res = ws_call(
        &mut ws,
        "th-1",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "nvidia",
            "model": "moonshotai/kimi-k2-instruct"
        }),
    )
    .await;
    let thread_id = start_res["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 1x1 transparent PNG inline attachment
    let png_b64 = BASE64.encode(&[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    let turn_input = json!([
        { "type": "text", "text": "Create notes.txt, edit beta, track todos, and grep it. Remember: I prefer concise Rust diffs." },
        { "type": "file", "filename": "pixel.png", "mimeType": "image/png", "contentBase64": png_b64 }
    ]);

    let mut collected_notifs = Vec::new();

    let turn_resp = ws_call_collecting(
        &mut ws,
        "turn-1",
        "turn/start",
        json!({
            "threadId": thread_id,
            "clientMessageId": "cmsg-e2e-1",
            "input": turn_input
        }),
        &mut collected_notifs,
    )
    .await;
    assert!(
        turn_resp.get("error").is_none(),
        "turn/start err: {turn_resp}"
    );
    let turn_id = turn_resp["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Duplicate `clientMessageId` with identical payload returns `replayed: true` with same `turnId`!
    let dup_resp = ws_call_collecting(
        &mut ws,
        "turn-dup",
        "turn/start",
        json!({
            "threadId": thread_id,
            "clientMessageId": "cmsg-e2e-1",
            "input": turn_input
        }),
        &mut collected_notifs,
    )
    .await;
    assert_eq!(dup_resp["result"]["replayed"], json!(true));
    assert_eq!(dup_resp["result"]["turn"]["id"], json!(turn_id));

    // Conflicting `clientMessageId` with different payload returns `-32600`!
    let conflict_resp = ws_call_collecting(
        &mut ws,
        "turn-conflict",
        "turn/start",
        json!({
            "threadId": thread_id,
            "clientMessageId": "cmsg-e2e-1",
            "input": "Different payload text"
        }),
        &mut collected_notifs,
    )
    .await;
    assert_eq!(conflict_resp["error"]["code"], json!(-32600));

    let mut completed_status = collected_notifs.iter().find_map(|v| {
        (v.get("method") == Some(&json!("turn/completed")))
            .then(|| v["params"]["turn"]["status"].as_str().map(str::to_owned))
            .flatten()
    });

    while completed_status.is_none() {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("turn completion timeout")
            .expect("ws open")
            .expect("ws frame ok");
        let WsMessage::Text(txt) = frame else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("turn/completed")) {
            completed_status = val["params"]["turn"]["status"].as_str().map(str::to_owned);
        }
        collected_notifs.push(val);
    }

    let saw_todos_notif = collected_notifs.iter().any(|v| {
        v.get("method") == Some(&json!("cowork/todos"))
            && v["params"]["type"] == json!("todos")
            && v["params"].get("event").is_none()
    });
    let saw_session_info = collected_notifs.iter().any(|v| {
        v.get("method") == Some(&json!("cowork/session/info"))
            && v["params"]["type"] == json!("session_info")
            && v["params"].get("event").is_none()
    });

    assert_eq!(completed_status.as_deref(), Some("completed"));
    assert!(
        saw_todos_notif,
        "expected unwrapped cowork/todos notification"
    );
    assert!(
        saw_session_info,
        "expected unwrapped heuristic cowork/session/info notification"
    );

    // Verify `write` + `edit` persisted on disk and inline attachment staged in `User Uploads/`
    let final_notes = fs::read_to_string(iso.workspace.join("notes.txt")).unwrap();
    assert_eq!(final_notes, "alpha\nBETA-EDITED\ngamma\n");
    assert!(
        iso.workspace
            .join("uploads")
            .join("User Uploads")
            .join("pixel.png")
            .exists()
    );

    // Verify layered system prompt included `AGENTS.md` instructions in step 0
    {
        let bodies = captured_bodies.lock().unwrap();
        assert!(
            bodies.len() == 5 || bodies.len() == 6,
            "expected 5 turn steps (+ optional async remote title call), got {}",
            bodies.len()
        );
        let sys_msg = bodies[0]["messages"][0]["content"].as_str().unwrap_or("");
        assert!(
            sys_msg.contains("ALPHA-RULE-99"),
            "system prompt should include AGENTS.md content, got: {sys_msg}"
        );
    }

    // Verify `thread/read` (`includeTurns: true`) projects user, toolCall, and agentMessage items
    let read_res = ws_call(
        &mut ws,
        "th-read-1",
        "thread/read",
        json!({
            "threadId": thread_id,
            "includeTurns": true
        }),
    )
    .await;
    let turns = read_res["result"]["thread"]["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert!(
        !read_res["result"]["thread"]["title"]
            .as_str()
            .unwrap()
            .eq("New session")
    );

    mock_task.abort();
    server.shutdown().await;
}

#[tokio::test]
async fn websocket_interactions_approval_ask_receipts_and_cascading_interrupt_kill_process_tree() {
    let mut iso = IsolatedServerEnv::new();
    let pid_file = iso.workspace.join("child.pid");
    let pid_file_str = pid_file.to_string_lossy().into_owned();

    let step_counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sc_clone = Arc::clone(&step_counter);

    let mock_app = Router::new().route(
        "/v1/chat/completions",
        post(move |_body: axum::body::Bytes| {
            let idx = sc_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let p_str = pid_file_str.clone();
            async move {
                let sse = match idx {
                    // Step 0: AskUserQuestion
                    0 => chat_sse_tool_call(
                        "call_ask_1",
                        "AskUserQuestion",
                        &json!({
                            "questions": [
                                {
                                    "id": "deploy_env",
                                    "header": "Environment",
                                    "question": "Which environment should we target?",
                                    "options": [
                                        { "label": "staging", "description": "Staging cluster" },
                                        { "label": "prod", "description": "Production cluster" }
                                    ]
                                }
                            ]
                        }),
                    ),
                    // Step 1: Dangerous bash command (`rm`) requiring interactive approval,
                    // followed by spawning a long-lived child sleep process so we can test `turn/interrupt`!
                    1 => chat_sse_tool_call(
                        "call_bash_int",
                        "bash",
                        &json!({
                            "command": format!("rm -f nonexistent_temp.tmp && (sleep 120 & echo $! > '{p_str}'; wait)")
                        }),
                    ),
                    _ => chat_sse_text("Done"),
                };
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from(sse))
                    .unwrap()
            }
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move {
        let _ = axum::serve(listener, mock_app).await;
    });

    iso.env.insert(
        "NVIDIA_BASE_URL".into(),
        format!("http://127.0.0.1:{mock_port}/v1"),
    );
    iso.env
        .insert("NVIDIA_API_KEY".into(), "nvapi-mock-test".into());

    let server = start_server(iso.server_options(false)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    let th = ws_call(
        &mut ws,
        "th-int",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "nvidia",
            "model": "moonshotai/kimi-k2-instruct"
        }),
    )
    .await;
    let thread_id = th["result"]["thread"]["id"].as_str().unwrap().to_owned();

    let _ = ws_call(
        &mut ws,
        "turn-int-1",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": "Ask me for env and run command."
        }),
    )
    .await;

    // 1. Wait for canonical `item/tool/requestUserInput` server request
    let mut ask_req_id = None;
    let mut ask_params = Value::Null;
    while ask_req_id.is_none() {
        let WsMessage::Text(txt) = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("item/tool/requestUserInput")) {
            ask_req_id = val.get("id").and_then(Value::as_str).map(str::to_owned);
            ask_params = val["params"].clone();
        }
    }
    let ask_id = ask_req_id.unwrap();
    assert!(
        ask_params.get("question").and_then(Value::as_str).is_some()
            && ask_params.get("questions").is_none(),
        "requestUserInput must emit canonical single question without legacy questions array: {ask_params}"
    );

    // Send an EMPTY answer first -> must return `-32602` error and re-prompt!
    ws.send(WsMessage::Text(
        json!({
            "id": ask_id,
            "result": { "answer": "   " }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let mut saw_empty_err = false;
    while !saw_empty_err {
        let WsMessage::Text(txt) = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("id") == Some(&json!(ask_id)) && val.get("error").is_some() {
            assert_eq!(val["error"]["code"], json!(-32602));
            saw_empty_err = true;
        }
    }

    // Now send valid canonical `{ answer }` -> resolves and emits `serverRequest/resolved`!
    let valid_ask_result = json!({
        "answer": "staging"
    });
    ws.send(WsMessage::Text(
        json!({
            "id": ask_id,
            "result": valid_ask_result
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    // Duplicate identical response -> idempotent (`serverRequest/resolved`), no error!
    ws.send(WsMessage::Text(
        json!({
            "id": ask_id,
            "result": valid_ask_result
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    // Conflicting duplicate response -> `-32602` conflict!
    ws.send(WsMessage::Text(
        json!({
            "id": ask_id,
            "result": { "answer": "prod" }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    // 2. Wait for canonical `item/commandExecution/requestApproval` AND conflict error
    let mut approval_req_id = None;
    let mut approval_params = Value::Null;
    let mut saw_conflict_err = false;
    let mut saw_resolved_notif = false;
    while approval_req_id.is_none() || !saw_conflict_err || !saw_resolved_notif {
        let WsMessage::Text(txt) = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("serverRequest/resolved"))
            && val["params"]["requestId"] == json!(ask_id)
        {
            saw_resolved_notif = true;
        }
        if val.get("id") == Some(&json!(ask_id)) && val.get("error").is_some() {
            assert_eq!(val["error"]["code"], json!(-32602));
            saw_conflict_err = true;
        }
        if val.get("method") == Some(&json!("item/commandExecution/requestApproval")) {
            approval_req_id = val.get("id").and_then(Value::as_str).map(str::to_owned);
            approval_params = val["params"].clone();
        }
    }
    assert!(
        approval_params.get("cwd").is_none(),
        "requestApproval must not include cwd: {approval_params}"
    );

    // Approve the bash command so it spawns `sleep 120`!
    let app_id = approval_req_id.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": app_id,
            "result": { "decision": "accept" }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    // Wait for `child.pid` to appear on disk
    let mut spawned_pid: Option<i32> = None;
    for _ in 0..80 {
        if let Ok(raw) = fs::read_to_string(&pid_file)
            && let Ok(p) = raw.trim().parse::<i32>()
        {
            spawned_pid = Some(p);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let child_pid = spawned_pid.expect("expected bash child sleep PID file");

    // Trigger `turn/interrupt` and verify cascading process-group termination + `interrupted` status!
    let int_res = ws_call(
        &mut ws,
        "int-call-1",
        "turn/interrupt",
        json!({ "threadId": thread_id }),
    )
    .await;
    assert_eq!(int_res["result"]["interrupted"], json!(true));

    let mut final_status = None;
    while final_status.is_none() {
        let WsMessage::Text(txt) = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("turn/completed")) {
            final_status = val["params"]["turn"]["status"].as_str().map(str::to_owned);
        }
    }
    assert_eq!(final_status.as_deref(), Some("interrupted"));

    // Confirm `child_pid` was killed cleanly (cleanup fallback if somehow still alive)
    let mut child_dead = false;
    for _ in 0..40 {
        let rc = unsafe { libc::kill(child_pid, 0) };
        if rc != 0 {
            child_dead = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !child_dead {
        unsafe {
            libc::kill(child_pid, libc::SIGKILL);
        }
    }
    assert!(
        child_dead,
        "expected child PID {child_pid} to be killed by turn/interrupt"
    );

    mock_task.abort();
    server.shutdown().await;
}

#[tokio::test]
async fn websocket_thread_fork_worktree_and_all_11_memory_routes_operate_end_to_end() {
    let iso = IsolatedServerEnv::new();

    // Initialize an isolated git repository in `iso.workspace` (under `/private/tmp/...`)
    for args in [
        &["init", "-b", "main"][..],
        &["config", "user.email", "test@cowork.local"][..],
        &["config", "user.name", "Cowork Test"][..],
    ] {
        let st = StdCommand::new("git")
            .args(args)
            .current_dir(&iso.workspace)
            .status()
            .unwrap();
        assert!(st.success());
    }
    fs::write(iso.workspace.join("README.md"), "# Isolated Repo\n").unwrap();
    assert!(
        StdCommand::new("git")
            .args(["add", "README.md"])
            .current_dir(&iso.workspace)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        StdCommand::new("git")
            .args(["commit", "-m", "Initial commit"])
            .current_dir(&iso.workspace)
            .status()
            .unwrap()
            .success()
    );

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    let th = ws_call(
        &mut ws,
        "th-root",
        "thread/start",
        json!({ "cwd": iso.workspace.to_string_lossy() }),
    )
    .await;
    let root_thread_id = th["result"]["thread"]["id"].as_str().unwrap().to_owned();

    // Fork into an isolated git worktree under `<coworkHome>/worktrees`!
    let fork_res = ws_call(
        &mut ws,
        "th-fork-1",
        "thread/fork",
        json!({
            "threadId": root_thread_id,
            "title": "Feature Worktree Fork",
            "environment": {
                "type": "worktree",
                "branchName": "cowork/feature-fork-test"
            }
        }),
    )
    .await;
    assert!(
        fork_res.get("error").is_none(),
        "thread/fork err: {fork_res}"
    );
    assert_eq!(fork_res["result"]["forked"], json!(true));
    assert_eq!(fork_res["result"]["sourceThreadId"], json!(root_thread_id));
    assert_eq!(fork_res["result"]["environment"]["type"], json!("worktree"));
    assert_eq!(
        fork_res["result"]["environment"]["branchName"],
        json!("cowork/feature-fork-test")
    );
    let wt_cwd = PathBuf::from(fork_res["result"]["environment"]["cwd"].as_str().unwrap());
    assert!(wt_cwd.join("README.md").exists());
    assert!(wt_cwd.starts_with(iso.home.join(".cowork").join("worktrees")));

    // Exercise SQLite memory routes (`list`, `upsert`, `delete`)
    let up_res = ws_call(
        &mut ws,
        "mem-up",
        "cowork/memory/upsert",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "scope": "workspace",
            "id": "arch-note",
            "content": "Use strict JSON-RPC-lite envelopes."
        }),
    )
    .await;
    assert_eq!(up_res["result"]["event"]["type"], json!("memory_list"));
    assert_eq!(
        up_res["result"]["event"]["memories"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let list_res = ws_call(
        &mut ws,
        "mem-list",
        "cowork/memory/list",
        json!({ "cwd": iso.workspace.to_string_lossy(), "scope": "workspace" }),
    )
    .await;
    assert_eq!(
        list_res["result"]["event"]["memories"][0]["id"],
        json!("arch-note")
    );

    let del_res = ws_call(
        &mut ws,
        "mem-del",
        "cowork/memory/delete",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "scope": "workspace",
            "id": "arch-note"
        }),
    )
    .await;
    assert_eq!(del_res["result"]["event"]["deleted"], json!(true));
    assert_eq!(
        del_res["result"]["event"]["memories"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // Exercise Markdown advanced memory routes (current workspace + explicit folder + reject `folder` on current!)
    let bad_adv = ws_call(
        &mut ws,
        "adv-bad",
        "cowork/memory/advanced/list",
        json!({ "folder": "forbidden" }),
    )
    .await;
    assert_eq!(bad_adv["error"]["code"], json!(-32602));

    let adv_up = ws_call(
        &mut ws,
        "adv-up",
        "cowork/memory/advanced/upsert",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "name": "Build Commands",
            "description": "Workspace cargo test command",
            "type": "project",
            "body": "Always run cargo test --workspace."
        }),
    )
    .await;
    assert_eq!(
        adv_up["result"]["event"]["type"],
        json!("advanced_memory_list")
    );
    let ws_folder = adv_up["result"]["event"]["folder"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        adv_up["result"]["event"]["memories"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let adv_folder_up = ws_call(
        &mut ws,
        "adv-f-up",
        "cowork/memory/advanced/folder/upsert",
        json!({
            "folder": "custom-team-folder",
            "name": "Team Convention",
            "description": "PR style",
            "body": "Conventional commits required."
        }),
    )
    .await;
    assert_eq!(
        adv_folder_up["result"]["event"]["memories"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        adv_folder_up["result"]["event"]["folders"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_string)
            && adv_folder_up["result"]["event"]["folders"]
                .as_array()
                .unwrap()
                .contains(&json!("custom-team-folder")),
        "folders must serialize as Vec<String>: {}",
        adv_folder_up["result"]["event"]["folders"]
    );

    let adv_folder_list = ws_call(
        &mut ws,
        "adv-f-list",
        "cowork/memory/advanced/folder/list",
        json!({ "folder": "custom-team-folder" }),
    )
    .await;
    assert_eq!(
        adv_folder_list["result"]["event"]["memories"][0]["slug"],
        json!("team-convention")
    );

    let adv_gen = ws_call(
        &mut ws,
        "adv-gen",
        "cowork/memory/advanced/generate",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "threadId": root_thread_id
        }),
    )
    .await;
    assert_eq!(adv_gen["result"]["event"]["folder"], json!(ws_folder));

    let adv_f_gen = ws_call(
        &mut ws,
        "adv-f-gen",
        "cowork/memory/advanced/folder/generate",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "folder": "custom-team-folder",
            "threadId": root_thread_id
        }),
    )
    .await;
    assert_eq!(
        adv_f_gen["result"]["event"]["folder"],
        json!("custom-team-folder")
    );

    let adv_f_del = ws_call(
        &mut ws,
        "adv-f-del",
        "cowork/memory/advanced/folder/delete",
        json!({
            "folder": "custom-team-folder",
            "slug": "team-convention"
        }),
    )
    .await;
    assert!(
        !adv_f_del["result"]["event"]["memories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["slug"] == json!("team-convention"))
    );

    let adv_del = ws_call(
        &mut ws,
        "adv-del",
        "cowork/memory/advanced/delete",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "slug": "build-commands"
        }),
    )
    .await;
    assert_eq!(
        adv_del["result"]["event"]["memories"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    server.shutdown().await;
}

#[tokio::test]
async fn yolo_keeps_ask_user_interactive_and_error_turn_completed_matches_strict_schema() {
    let mut iso = IsolatedServerEnv::new();
    let marker = iso.workspace.join("yolo-marker.txt");
    let marker_str = marker.to_string_lossy().into_owned();

    let step_idx = Arc::new(Mutex::new(0usize));
    let step_idx_srv = Arc::clone(&step_idx);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |_req_body: axum::body::Bytes| {
            let step_idx_srv = Arc::clone(&step_idx_srv);
            let marker_str = marker_str.clone();
            async move {
                let current = {
                    let mut g = step_idx_srv.lock().unwrap();
                    let v = *g;
                    *g += 1;
                    v
                };
                let body = match current {
                    0 => chat_sse_tool_call(
                        "call_y_ask",
                        "AskUserQuestion",
                        &json!({
                            "question": "Confirm label for yolo marker?"
                        }),
                    ),
                    1 => chat_sse_tool_call(
                        "call_y_rm",
                        "bash",
                        &json!({
                            "command": format!("rm -f '{marker_str}' && printf 'yolo-ok' > '{marker_str}'")
                        }),
                    ),
                    _ => chat_sse_text("Yolo turn done."),
                };
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from(body))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // Configure ONLY `together` API key (`OPENAI_API_KEY` intentionally absent to test transport creation Err!)
    iso.env
        .insert("TOGETHER_API_KEY".into(), "tgp-test-yolo".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;

    // 1. `--yolo`: `AskUserQuestion` STILL prompts interactively while `rm -f` auto-approves!
    let th1 = ws_call(
        &mut ws,
        "th-yolo-1",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "together",
            "model": "deepseek-ai/DeepSeek-V3"
        }),
    )
    .await;
    let tid1 = th1["result"]["thread"]["id"].as_str().unwrap().to_owned();
    let _ = ws_call(
        &mut ws,
        "turn-yolo-1",
        "turn/start",
        json!({ "threadId": tid1, "input": "Run yolo ask and rm." }),
    )
    .await;

    let mut answered_ask = false;
    let mut saw_approval_req = false;
    let mut yolo_done = false;
    while !yolo_done {
        let WsMessage::Text(txt) = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("item/tool/requestUserInput")) {
            let req_id = val["id"].as_str().unwrap().to_owned();
            ws.send(WsMessage::Text(
                json!({ "id": req_id, "result": { "answer": "confirmed" } })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            answered_ask = true;
        }
        if val.get("method") == Some(&json!("item/commandExecution/requestApproval")) {
            saw_approval_req = true;
        }
        if val.get("method") == Some(&json!("turn/completed"))
            && val["params"]["threadId"] == json!(tid1)
        {
            assert_eq!(val["params"]["turn"]["status"], json!("completed"));
            yolo_done = true;
        }
    }
    assert!(
        answered_ask,
        "--yolo must keep AskUserQuestion interactive over WebSocket"
    );
    assert!(
        !saw_approval_req,
        "--yolo must auto-approve destructive bash without requestApproval"
    );
    assert_eq!(fs::read_to_string(&marker).unwrap(), "yolo-ok");

    // 2. Provider auth failure (`openai` with no API key) emits projected `error` item (`code`, `source`) + strict `turn/completed` (no `turn.threadId`)!
    let th2 = ws_call(
        &mut ws,
        "th-err-2",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "openai",
            "model": "gpt-5.4"
        }),
    )
    .await;
    let tid2 = th2["result"]["thread"]["id"].as_str().unwrap().to_owned();
    let _ = ws_call(
        &mut ws,
        "turn-err-2",
        "turn/start",
        json!({ "threadId": tid2, "input": "Trigger missing API key error." }),
    )
    .await;

    let mut err_item = None;
    let mut err_completed = None;
    while err_completed.is_none() {
        let WsMessage::Text(txt) = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        else {
            continue;
        };
        let val: Value = serde_json::from_str(&txt).unwrap();
        if val.get("method") == Some(&json!("item/completed"))
            && val["params"]["threadId"] == json!(tid2)
            && val["params"]["item"]["type"] == json!("error")
        {
            err_item = Some(val["params"]["item"].clone());
        }
        if val.get("method") == Some(&json!("turn/completed"))
            && val["params"]["threadId"] == json!(tid2)
        {
            err_completed = Some(val["params"].clone());
        }
    }
    let err_it = err_item.expect("expected projected error item");
    assert_eq!(err_it["code"], json!("provider_error"));
    assert_eq!(err_it["source"], json!("provider"));

    let comp_p = err_completed.unwrap();
    assert_eq!(comp_p["turn"]["status"], json!("failed"));
    assert!(
        comp_p["turn"].get("threadId").is_none(),
        "turn/completed.turn must not contain threadId under strict schema: {comp_p}"
    );

    server.shutdown().await;
}
