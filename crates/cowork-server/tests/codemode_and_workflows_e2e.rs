use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
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
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedServerEnv {
    _root: TempDir,
    base: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedServerEnv {
    fn new(prefix: &str) -> Self {
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
        env.insert("COWORK_ENABLE_WORKFLOWS".into(), "1".into());
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        Self {
            _root: root,
            base,
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
                "clientInfo": { "name": "m3-codemode-workflows-e2e", "version": "1.0.0" },
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
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
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
                if let Ok(val) = serde_json::from_str::<Value>(&txt)
                    && val.get("method").is_some()
                {
                    notifs.push(val);
                    if pred(notifs) {
                        return;
                    }
                }
            }
            _ => break,
        }
    }
}

fn sse_resp(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn chat_sse_tool_call(call_id: &str, tool_name: &str, args: &Value) -> String {
    let args_str = serde_json::to_string(args).unwrap();
    format!(
        concat!(
            "data: {{\"id\":\"cmpl-tc\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"tool_calls\":[{{\"index\":0,\"id\":{call_id:?},\"type\":\"function\",\"function\":{{\"name\":{tool_name:?},\"arguments\":{args_str:?}}}}}]}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-tc\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":50000,\"completion_tokens\":10000,\"total_tokens\":60000}}}}\n\n",
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
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":50000,\"completion_tokens\":10000,\"total_tokens\":60000}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

#[tokio::test]
async fn websocket_codemode_and_deep_research_workflow_with_journal_resume_e2e() {
    let mut iso = IsolatedServerEnv::new("cowork-srv-cm-wf-e2e-");
    fs::write(
        iso.workspace.join("architecture_note.txt"),
        "QuickJS enforces set_memory_limit and 30s interrupt slices.\n",
    )
    .unwrap();

    // Shared counters for child LLM requests and 1-turn JSON Schema repair verification!
    let child_llm_calls = Arc::new(AtomicUsize::new(0));
    let plan_attempts = Arc::new(AtomicUsize::new(0));
    let last_run_id_slot: Arc<parking_lot::Mutex<Option<String>>> =
        Arc::new(parking_lot::Mutex::new(None));

    let child_calls_ref = Arc::clone(&child_llm_calls);
    let plan_attempts_ref = Arc::clone(&plan_attempts);
    let run_id_slot_ref = Arc::clone(&last_run_id_slot);

    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let child_calls = Arc::clone(&child_calls_ref);
            let plan_attempts = Arc::clone(&plan_attempts_ref);
            let run_id_slot = Arc::clone(&run_id_slot_ref);
            async move {
                let payload: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let msgs = payload
                    .get("messages")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let all_text = serde_json::to_string(&msgs).unwrap_or_default();
                let has_tool_result = msgs.iter().any(|m| m.get("role") == Some(&json!("tool")));

                // Detect child workflow calls by `<workflow_result>` system instruction or prompt content!
                let is_child = all_text.contains("<workflow_result>");
                if is_child {
                    child_calls.fetch_add(1, Ordering::SeqCst);

                    if all_text.contains("Plan a deep research program") {
                        let attempt = plan_attempts.fetch_add(1, Ordering::SeqCst);
                        if attempt == 0 {
                            // Deliberately return invalid JSON (`questions` is not an array!) to force 1-turn repair!
                            return sse_resp(chat_sse_text(
                                r#"<workflow_result>{"questions":"oops","planningLimitations":[]}</workflow_result>"#,
                            ));
                        }
                        return sse_resp(chat_sse_text(
                            r#"<workflow_result>{
                              "questions": [
                                {"title": "Q1: Heap caps", "focus": "set_memory_limit"},
                                {"title": "Q2: Interrupts", "focus": "set_interrupt_handler"}
                              ],
                              "planningLimitations": []
                            }</workflow_result>"#,
                        ));
                    }

                    if all_text.contains("Research this part of a larger deep-research request") {
                        let label = if all_text.contains("Q1: Heap caps") {
                            "q1"
                        } else {
                            "q2"
                        };
                        return sse_resp(chat_sse_text(&format!(
                            r#"<workflow_result>{{
                              "claims": [{{
                                "statement": "Verified isolate guarantee for {label}",
                                "evidence": "Direct runtime check",
                                "sources": [{{"title": "Spec", "locator": "https://quickjs.local/{label}"}}],
                                "uncertainty": "low"
                              }}],
                              "reportMarkdown": "Section for {label} citing https://quickjs.local/{label}.",
                              "sources": [{{"title": "Spec", "locator": "https://quickjs.local/{label}"}}],
                              "limitations": []
                            }}</workflow_result>"#
                        )));
                    }

                    if all_text.contains(
                        "Independently and adversarially verify every candidate claim from this research shard",
                    ) {
                        let cand_idx = if all_text.contains("\\\"candidateIndex\\\":0")
                            || all_text.contains("\"candidateIndex\":0")
                            || all_text.contains("Q1: Heap caps")
                        {
                            0
                        } else {
                            1
                        };
                        return sse_resp(chat_sse_text(&format!(
                            r#"<workflow_result>{{
                              "claims": [{{
                                "candidateIndex": {cand_idx},
                                "verified": true,
                                "reason": "Confirmed by primary source",
                                "evidence": "Verified",
                                "sources": [{{"title": "Spec", "locator": "https://quickjs.local/v"}}],
                                "correctedStatement": "Verified isolate guarantee {cand_idx}"
                              }}],
                              "limitations": []
                            }}</workflow_result>"#
                        )));
                    }

                    if all_text
                        .contains("Write a rigorous, comprehensive, full-length deep-research report")
                    {
                        return sse_resp(chat_sse_text(
                            r##"<workflow_result>{
                              "title": "QuickJS Isolation Synthesis",
                              "executiveSummary": "Verified heap and interrupt bounds.",
                              "reportMarkdown": "# QuickJS Isolation Synthesis\n\nAll claims verified."
                            }</workflow_result>"##,
                        ));
                    }
                }

                // Root session turns:
                // Turn 1: "RUN_CODEMODE_TURN"
                if all_text.contains("RUN_CODEMODE_TURN")
                    && !all_text.contains("RUN_WORKFLOW_TURN")
                {
                    if !has_tool_result {
                        return sse_resp(chat_sse_tool_call(
                            "call_cm_1",
                            "codeMode",
                            &json!({
                                "code": r#"
                                    type NoteInfo = { found: number; content: string };
                                    const s: any = await tools.search("read");
                                    const raw: any = await tools.call("read", { filePath: "architecture_note.txt" });
                                    console.log("note-read-ok");
                                    const info: NoteInfo = { found: s.tools.length, content: JSON.stringify(raw) };
                                    return info;
                                "#
                            }),
                        ));
                    }
                    return sse_resp(chat_sse_text("Completed codeMode turn."));
                }

                // Turn 2: "RUN_WORKFLOW_TURN" (fresh run of bundled `deep-research`)
                if all_text.contains("RUN_WORKFLOW_TURN")
                    && !all_text.contains("RUN_RESUME_TURN")
                {
                    // Check if the LATEST user turn has already executed `workflow`
                    let last_msg_is_tool = msgs
                        .last()
                        .is_some_and(|m| m.get("role") == Some(&json!("tool")));
                    if !last_msg_is_tool {
                        return sse_resp(chat_sse_tool_call(
                            "call_wf_fresh",
                            "workflow",
                            &json!({
                                "action": "run",
                                "name": "deep-research",
                                "args": {
                                    "query": "How does cowork-js-vm isolate scripts?",
                                    "maxQuestions": 2,
                                    "maxClaimsPerQuestion": 1
                                }
                            }),
                        ));
                    }
                    // Capture `runId` from the tool result so Turn 3 can pass `resumeFromRunId`!
                    if let Some(last_tool) = msgs.last()
                        && let Some(content_str) = last_tool.get("content").and_then(Value::as_str)
                        && let Ok(parsed) = serde_json::from_str::<Value>(content_str)
                        && let Some(rid) = parsed.get("runId").and_then(Value::as_str)
                    {
                        *run_id_slot.lock() = Some(rid.to_owned());
                    }
                    return sse_resp(chat_sse_text("Completed fresh deep-research workflow."));
                }

                // Turn 3: "RUN_RESUME_TURN" (`resumeFromRunId` replay at $0 child cost!)
                if all_text.contains("RUN_RESUME_TURN") {
                    let last_msg_is_tool = msgs
                        .last()
                        .is_some_and(|m| m.get("role") == Some(&json!("tool")));
                    if !last_msg_is_tool {
                        let rid = run_id_slot
                            .lock()
                            .clone()
                            .expect("runId from Turn 2 must be recorded");
                        return sse_resp(chat_sse_tool_call(
                            "call_wf_resume",
                            "workflow",
                            &json!({
                                "action": "run",
                                "name": "deep-research",
                                "resumeFromRunId": rid,
                                "args": {
                                    "query": "How does cowork-js-vm isolate scripts?",
                                    "maxQuestions": 2,
                                    "maxClaimsPerQuestion": 1
                                }
                            }),
                        ));
                    }
                    return sse_resp(chat_sse_text("Completed resumed deep-research workflow."));
                }

                sse_resp(chat_sse_text("Fallback assistant text."))
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

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();

    // Start a root thread on `together` / `moonshotai/Kimi-K2.5` (which has built-in USD pricing!)
    let start_res = ws_call_collecting(
        &mut ws,
        "th-start",
        "thread/start",
        json!({
            "cwd": iso.workspace.to_string_lossy(),
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5",
        }),
        &mut notifs,
    )
    .await;
    let thread_id = start_res["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();

    // Enable `codeMode` + `deferredToolSearch` via `cowork/session/config/set`
    let cfg_res = ws_call_collecting(
        &mut ws,
        "cfg-cm",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "deferredToolSearch": true,
                    "codeMode": true
                }
            }
        }),
        &mut notifs,
    )
    .await;
    assert!(cfg_res.get("error").is_none(), "cfg_res={cfg_res}");

    // ------------------------------------------------------------------------
    // Turn 1: `codeMode` executes TypeScript (`tools.search` + `tools.call`)
    // ------------------------------------------------------------------------
    notifs.clear();
    let t1 = ws_call_collecting(
        &mut ws,
        "turn-1",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": "RUN_CODEMODE_TURN" }]
        }),
        &mut notifs,
    )
    .await;
    assert!(t1.get("error").is_none(), "t1={t1}");
    collect_until(&mut ws, &mut notifs, 10_000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    let cm_item = notifs
        .iter()
        .find(|n| {
            n["method"] == "item/completed"
                && n["params"]["item"]["type"] == "toolCall"
                && n["params"]["item"]["toolName"] == "codeMode"
                && n["params"]["item"]["state"] == "output-available"
        })
        .unwrap_or_else(|| panic!("expected completed codeMode toolCall item, notifs={notifs:?}"));
    let raw_cm_out = &cm_item["params"]["item"]["result"];
    let cm_output: Value = if let Some(s) = raw_cm_out.as_str() {
        serde_json::from_str(s).unwrap_or_else(|_| json!({ "raw": s }))
    } else if !raw_cm_out.is_null() {
        raw_cm_out.clone()
    } else {
        panic!("unexpected codeMode item: {cm_item}");
    };
    assert!(
        cm_output["content"]
            .as_str()
            .unwrap()
            .contains("set_memory_limit"),
        "cm_output = {cm_output}"
    );
    assert!(cm_output["found"].as_u64().unwrap() >= 1);

    // Switch off `deferredToolSearch` so Turn 2 calls `workflow` directly
    let _ = ws_call_collecting(
        &mut ws,
        "cfg-wf",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "providerOptions": {
                    "deferredToolSearch": false,
                    "codeMode": false
                }
            }
        }),
        &mut notifs,
    )
    .await;

    // ------------------------------------------------------------------------
    // Turn 2: `workflow` runs bundled `workflows/deep-research.ts` over real HTTP SSE!
    // ------------------------------------------------------------------------
    notifs.clear();
    let t2 = ws_call_collecting(
        &mut ws,
        "turn-2",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": "RUN_WORKFLOW_TURN" }]
        }),
        &mut notifs,
    )
    .await;
    assert!(t2.get("error").is_none(), "t2={t2}");
    collect_until(&mut ws, &mut notifs, 20_000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    // 6 child agents + 1 repair turn on `research-plan` = 7 child HTTP calls!
    let child_calls_after_fresh = child_llm_calls.load(Ordering::SeqCst);
    assert_eq!(
        child_calls_after_fresh, 7,
        "expected 6 child spawns + 1 JSON Schema repair turn = 7 child LLM HTTP calls"
    );
    assert_eq!(plan_attempts.load(Ordering::SeqCst), 2);

    let wf_progress_events: Vec<&Value> = notifs
        .iter()
        .filter(|n| n["method"] == "cowork/session/workflowProgress")
        .collect();
    assert!(
        wf_progress_events.len() >= 2,
        "expected live cowork/session/workflowProgress notifications: {notifs:?}"
    );
    let final_prog = &wf_progress_events.last().unwrap()["params"]["progress"];
    assert_eq!(final_prog["outcome"], json!("completed"));
    assert_eq!(final_prog["name"], json!("deep-research"));
    assert!(
        final_prog["spentUsd"].as_f64().unwrap() > 0.0,
        "fresh workflow run must report positive USD child spend: {final_prog}"
    );
    let fresh_run_id = final_prog["runId"].as_str().unwrap().to_owned();

    // Verify `thread/read` exposes `coworkSnapshot.workflowRuns`!
    let read_after_t2 = ws_call_collecting(
        &mut ws,
        "th-read-2",
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
        &mut notifs,
    )
    .await;
    let snap_runs = read_after_t2["result"]["coworkSnapshot"]["workflowRuns"]
        .as_array()
        .expect("coworkSnapshot.workflowRuns array");
    assert_eq!(snap_runs.len(), 1);
    assert_eq!(snap_runs[0]["runId"], json!(fresh_run_id));
    assert_eq!(snap_runs[0]["outcome"], json!("completed"));

    // ------------------------------------------------------------------------
    // Turn 3: `resumeFromRunId` replays all 6 completed shards from `journal.jsonl` at $0!
    // ------------------------------------------------------------------------
    notifs.clear();
    let t3 = ws_call_collecting(
        &mut ws,
        "turn-3",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": "RUN_RESUME_TURN" }]
        }),
        &mut notifs,
    )
    .await;
    assert!(t3.get("error").is_none(), "t3={t3}");
    collect_until(&mut ws, &mut notifs, 15_000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    assert_eq!(
        child_llm_calls.load(Ordering::SeqCst),
        child_calls_after_fresh,
        "resumeFromRunId MUST NOT make any child LLM HTTP calls for completed shards!"
    );

    let resume_wf_item = notifs
        .iter()
        .find(|n| {
            n["method"] == "item/completed"
                && n["params"]["item"]["type"] == "toolCall"
                && n["params"]["item"]["toolName"] == "workflow"
                && n["params"]["item"]["state"] == "output-available"
        })
        .expect("expected completed resumed workflow toolCall item");
    let raw_res_out = &resume_wf_item["params"]["item"]["result"];
    let resume_out: Value = if let Some(s) = raw_res_out.as_str() {
        serde_json::from_str(s).unwrap()
    } else {
        raw_res_out.clone()
    };
    assert_eq!(resume_out["ok"], json!(true));
    assert_eq!(resume_out["resumedFromRunId"], json!(fresh_run_id));
    assert_eq!(resume_out["cachedCount"], json!(6));
    assert_eq!(resume_out["spentUsd"], json!(0.0));

    let read_after_t3 = ws_call_collecting(
        &mut ws,
        "th-read-3",
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": false }),
        &mut notifs,
    )
    .await;
    let snap_runs_t3 = read_after_t3["result"]["coworkSnapshot"]["workflowRuns"]
        .as_array()
        .unwrap();
    assert_eq!(snap_runs_t3.len(), 2);

    // Validate emitted `workflowProgress` notifications + `workflowRuns` payloads against untouched TypeScript Zod schemas!
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let wf_notif_params: Vec<Value> = notifs
        .iter()
        .filter(|n| n["method"] == "cowork/session/workflowProgress")
        .map(|n| n["params"].clone())
        .collect();
    let samples_file = iso.base.join("wf_progress_samples.json");
    fs::write(
        &samples_file,
        serde_json::to_vec_pretty(&json!({
            "runs": snap_runs_t3,
            "notifs": wf_notif_params,
        }))
        .unwrap(),
    )
    .unwrap();
    let bun_status = std::process::Command::new("bun")
        .current_dir(&repo_root)
        .env_remove("COWORK_HOME_OVERRIDE")
        .arg("-e")
        .arg(format!(
            r#"
            import {{ readFileSync }} from "node:fs";
            import {{ workflowProgressPayloadSchema }} from "./src/shared/workflows";
            import {{ jsonRpcAgentNotificationSchemas }} from "./src/server/jsonrpc/schema.agents";
            const data = JSON.parse(readFileSync({:?}, "utf8"));
            for (const item of data.runs) {{
              workflowProgressPayloadSchema.parse(item);
            }}
            for (const notif of data.notifs) {{
              jsonRpcAgentNotificationSchemas["cowork/session/workflowProgress"].parse(notif);
            }}
            "#,
            samples_file.to_string_lossy()
        ))
        .status();
    if let Ok(st) = bun_status {
        assert!(
            st.success(),
            "Zod workflowProgress schema validation failed on Rust workflow payloads"
        );
    }

    server.shutdown().await;
    llm_task.abort();
}
