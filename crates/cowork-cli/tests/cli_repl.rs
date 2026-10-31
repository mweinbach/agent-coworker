use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_cli::{
    ParsedReplCommand, REPL_SLASH_COMMANDS, ReplOptions, get_stored_session_for_cwd,
    parse_repl_input, run_repl_scripted, run_repl_scripted_with_interrupt,
    set_stored_session_for_cwd,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

struct IsolatedCliEnv {
    base_dir: PathBuf,
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedCliEnv {
    fn new() -> Self {
        let id = Uuid::new_v4();
        let base_dir = PathBuf::from(format!("/private/tmp/cowork-cli-test-{id}"));
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
        env.insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
        env.insert(
            "OPENCODE_GO_BASE_URL".into(),
            "http://127.0.0.1:9/v1".into(),
        );
        env.insert(
            "OPENCODE_ZEN_BASE_URL".into(),
            "http://127.0.0.1:9/v1".into(),
        );

        Self {
            base_dir,
            home_dir,
            workspace_dir,
            env,
        }
    }
}

impl Drop for IsolatedCliEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base_dir);
    }
}

#[test]
fn parses_all_13_slash_commands_and_messages() {
    for &cmd in &REPL_SLASH_COMMANDS {
        let parsed = parse_repl_input(cmd);
        assert!(
            !matches!(
                parsed,
                ParsedReplCommand::Message(_) | ParsedReplCommand::Unknown { .. }
            ),
            "expected {cmd} to parse as known slash command, got {parsed:?}"
        );
    }

    assert_eq!(
        parse_repl_input("  /provider openai  "),
        ParsedReplCommand::Provider("openai".to_owned())
    );
    assert_eq!(
        parse_repl_input("/model gpt-5.4"),
        ParsedReplCommand::Model("gpt-5.4".to_owned())
    );
    assert_eq!(
        parse_repl_input("/effort high"),
        ParsedReplCommand::Reasoning("high".to_owned())
    );
    assert_eq!(
        parse_repl_input("hello world"),
        ParsedReplCommand::Message("hello world".to_owned())
    );
}

#[test]
fn cli_state_store_persists_last_thread_by_cwd_with_private_permissions() {
    let iso = IsolatedCliEnv::new();
    assert_eq!(
        get_stored_session_for_cwd(&iso.home_dir, &iso.env, &iso.workspace_dir),
        None
    );

    set_stored_session_for_cwd(&iso.home_dir, &iso.env, &iso.workspace_dir, "thread-abc").unwrap();
    assert_eq!(
        get_stored_session_for_cwd(&iso.home_dir, &iso.env, &iso.workspace_dir).as_deref(),
        Some("thread-abc")
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let state_file = iso.home_dir.join(".cowork/state/cli-state.json");
        let mode = std::fs::metadata(&state_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[tokio::test]
async fn repl_connects_over_jsonrpc_and_executes_slash_commands_end_to_end() {
    let iso = IsolatedCliEnv::new();
    let opts = ReplOptions {
        working_directory: iso.workspace_dir.clone(),
        port: 0,
        yolo: false,
        homedir: Some(iso.home_dir.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env: iso.env.clone(),
    };

    // Session 1: boot server, create initial thread, switch provider/model/reasoning, inspect tools/skills/mcp, start /new, /exit
    let output1 = run_repl_scripted(
        opts.clone(),
        &[
            "/help",
            "/provider openai",
            "/model gpt-5.4",
            "/reasoning high",
            "/tools",
            "/skills",
            "/mcp",
            "/sessions",
            "/new",
            "/compact",
            "/clear",
            "/exit",
        ],
    )
    .await
    .unwrap();

    assert!(output1.contains("Available commands:"));
    assert!(output1.contains("/help"));
    assert!(output1.contains("/sessions"));
    assert!(output1.contains("/resume"));
    assert!(output1.contains("openai"));
    assert!(output1.contains("gpt-5.4"));
    assert!(output1.contains("reasoning effort set to high"));
    assert!(output1.contains("Tools:"));
    assert!(output1.contains("read"));
    assert!(output1.contains("bash"));
    assert!(output1.contains("Started new thread:"));

    let saved_thread = get_stored_session_for_cwd(&iso.home_dir, &iso.env, &iso.workspace_dir)
        .expect("expected persisted thread id in cli-state.json");

    // Session 2: automatically resumes saved_thread from cli-state.json and verifies /sessions + /resume
    let output2 = run_repl_scripted(
        opts,
        &["/sessions", &format!("/resume {saved_thread}"), "/exit"],
    )
    .await
    .unwrap();

    assert!(output2.contains(&saved_thread));
    assert!(output2.contains("Resumed thread:"));
}

fn sse_event(event_type: &str, data: Value) -> String {
    format!("event: {event_type}\ndata: {data}\n\n")
}

fn responses_text_sse(resp_id: &str, text: &str) -> String {
    let mut s = String::new();
    s.push_str(&sse_event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": resp_id } }),
    ));
    s.push_str(&sse_event(
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": "msg_0",
                "type": "message",
                "role": "assistant",
                "status": "in_progress",
                "content": []
            }
        }),
    ));
    s.push_str(&sse_event(
        "response.output_text.delta",
        json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "item_id": "msg_0",
            "delta": text
        }),
    ));
    s.push_str(&sse_event(
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_0",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{ "type": "output_text", "text": text }]
            }
        }),
    ));
    s.push_str(&sse_event(
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": resp_id,
                "status": "completed",
                "output": [],
                "usage": { "input_tokens": 18, "output_tokens": 9 }
            }
        }),
    ));
    s
}

fn responses_tool_calls_sse(resp_id: &str, calls: &[(&str, &str, Value)]) -> String {
    let mut s = String::new();
    s.push_str(&sse_event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": resp_id } }),
    ));
    for (idx, (call_id, name, args)) in calls.iter().enumerate() {
        let args_str = serde_json::to_string(args).unwrap();
        s.push_str(&sse_event(
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "output_index": idx,
                "item": {
                    "type": "function_call",
                    "id": format!("fc_{idx}"),
                    "call_id": call_id,
                    "name": name
                }
            }),
        ));
        s.push_str(&sse_event(
            "response.function_call_arguments.delta",
            json!({
                "type": "response.function_call_arguments.delta",
                "output_index": idx,
                "delta": args_str
            }),
        ));
        s.push_str(&sse_event(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "output_index": idx,
                "item": {
                    "type": "function_call",
                    "id": format!("fc_{idx}"),
                    "call_id": call_id,
                    "name": name,
                    "arguments": args_str
                }
            }),
        ));
    }
    s.push_str(&sse_event(
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": resp_id,
                "status": "completed",
                "output": [],
                "usage": { "input_tokens": 25, "output_tokens": 12 }
            }
        }),
    ));
    s
}

#[derive(Clone)]
struct MockSseState {
    replies: Arc<Mutex<VecDeque<String>>>,
    calls: Arc<AtomicUsize>,
}

async fn spawn_mock_openai_sse(replies: Vec<String>) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let state = MockSseState {
        replies: Arc::new(Mutex::new(replies.into())),
        calls: calls.clone(),
    };
    let app = Router::new()
        .route(
            "/v1/responses",
            post(
                |State(st): State<MockSseState>, req_body: axum::body::Bytes| async move {
                    let parsed: Value = serde_json::from_slice(&req_body).unwrap_or(Value::Null);
                    let model = parsed.get("model").and_then(Value::as_str).unwrap_or("");
                    if model.contains("mini") || model.contains("nano") {
                        return (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            responses_text_sse("resp_title_bg", "Configure Staging Marker"),
                        )
                            .into_response();
                    }
                    let n = st.calls.fetch_add(1, Ordering::SeqCst);
                    let body = st
                        .replies
                        .lock()
                        .await
                        .pop_front()
                        .unwrap_or_else(|| responses_text_sse(&format!("resp_fb_{n}"), "ok"));
                    (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        body,
                    )
                        .into_response()
                },
            ),
        )
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://127.0.0.1:{}/v1", addr.port()), calls)
}

#[tokio::test]
async fn repl_streams_turns_handles_approval_and_ask_user_question_and_renders_resume_history() {
    let mut iso = IsolatedCliEnv::new();
    let target_file = iso.workspace_dir.join("cli-note.txt");

    let (base_url, _calls) = spawn_mock_openai_sse(vec![
        // Step 1: AskUserQuestion -> user enters empty line first, then selects option 2 ("staging")
        responses_tool_calls_sse(
            "resp_1",
            &[(
                "call_ask_1",
                "AskUserQuestion",
                json!({
                    "questions": [{
                        "id": "env_q",
                        "header": "Target",
                        "question": "Which environment should we configure?",
                        "options": [
                            { "label": "dev", "description": "Local dev" },
                            { "label": "staging", "description": "Staging cluster" }
                        ]
                    }]
                }),
            )],
        ),
        // Step 2: destructive bash (`rm`) triggers interactive approval!
        responses_tool_calls_sse(
            "resp_2",
            &[(
                "call_bash_1",
                "bash",
                json!({
                    "command": format!("rm -f nonexistent.tmp && printf 'staging-ok' > '{}'", target_file.display()),
                    "description": "Clean stale file and write staging marker"
                }),
            )],
        ),
        // Step 3: final streamed assistant answer
        responses_text_sse("resp_3", "Configured staging and wrote marker file."),
        // Background remote title generator call
        responses_text_sse("resp_title", "Configure Staging Marker"),
    ])
    .await;

    iso.env
        .insert("OPENAI_API_KEY".into(), "sk-test-cli".into());
    iso.env.insert("OPENAI_BASE_URL".into(), base_url);

    let opts = ReplOptions {
        working_directory: iso.workspace_dir.clone(),
        port: 0,
        yolo: false,
        homedir: Some(iso.home_dir.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env: iso.env.clone(),
    };

    let output1 = run_repl_scripted(
        opts.clone(),
        &[
            "/provider openai",
            "Please configure our environment",
            "",  // empty answer -> triggers re-prompt!
            "2", // selects option 2 ("staging")
            "y", // approves bash command
            "/exit",
        ],
    )
    .await
    .unwrap();

    assert!(
        output1.contains("[question] Target: Which environment should we configure?"),
        "output1={output1}"
    );
    assert!(
        output1.contains("Please enter a non-empty answer or type 'skip'."),
        "output1={output1}"
    );
    assert!(
        output1.contains("[approval] Command requires approval:"),
        "output1={output1}"
    );
    assert!(
        output1.contains("[tool] bash -> output-available"),
        "output1={output1}"
    );
    assert!(
        output1.contains("Configured staging and wrote marker file."),
        "output1={output1}"
    );
    assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "staging-ok");

    let saved_thread = get_stored_session_for_cwd(&iso.home_dir, &iso.env, &iso.workspace_dir)
        .expect("saved thread id");

    // Session 2: start a fresh thread, then `/resume <saved_thread>` and verify full history rendering!
    let output2 = run_repl_scripted(opts, &["/new", &format!("/resume {saved_thread}"), "/exit"])
        .await
        .unwrap();

    assert!(
        output2.contains("--- Conversation History (1 turn(s)) ---"),
        "output2={output2}"
    );
    assert!(
        output2.contains("you> Please configure our environment"),
        "output2={output2}"
    );
    assert!(
        output2.contains("[tool] AskUserQuestion -> output-available"),
        "output2={output2}"
    );
    assert!(
        output2.contains("[tool] bash -> output-available"),
        "output2={output2}"
    );
    assert!(
        output2.contains("Configured staging and wrote marker file."),
        "output2={output2}"
    );
}

#[tokio::test]
async fn repl_ctrl_c_interrupts_active_turn_without_exiting_repl() {
    let mut iso = IsolatedCliEnv::new();
    let (base_url, _calls) = spawn_mock_openai_sse(vec![
        responses_tool_calls_sse(
            "resp_int_1",
            &[(
                "call_sleep_1",
                "bash",
                json!({
                    "command": "sleep 30",
                    "description": "Long command to interrupt"
                }),
            )],
        ),
        responses_text_sse("resp_after_int", "Ready again after interrupt."),
    ])
    .await;

    iso.env
        .insert("OPENAI_API_KEY".into(), "sk-test-cli".into());
    iso.env.insert("OPENAI_BASE_URL".into(), base_url);

    // Run in yolo mode so bash starts immediately, then fire interrupt_notify 250ms into the turn!
    let interrupt = Arc::new(Notify::new());
    let interrupt_trigger = interrupt.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        interrupt_trigger.notify_one();
    });

    let opts = ReplOptions {
        working_directory: iso.workspace_dir.clone(),
        port: 0,
        yolo: true,
        homedir: Some(iso.home_dir.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env: iso.env.clone(),
    };

    let output = run_repl_scripted_with_interrupt(
        opts,
        &[
            "/provider openai",
            "Run sleep",
            "Say hello after interrupt",
            "/exit",
        ],
        Some(interrupt),
    )
    .await
    .unwrap();

    assert!(
        output.contains("^C Interrupting turn..."),
        "output={output}"
    );
    assert!(output.contains("[Turn interrupted]"), "output={output}");
    assert!(
        output.contains("Ready again after interrupt."),
        "output={output}"
    );
    assert!(output.contains("Goodbye."), "output={output}");
}
