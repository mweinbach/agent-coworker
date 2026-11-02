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

// bwrap re-executes the current binary as `__sandbox-exec --linux-seccomp`; dispatch it pre-libtest.
cowork_sandbox::install_sandbox_exec_test_hook!();

/// Per-test scratch base: the canonical `/private/tmp` Seatbelt scratch root on macOS, the
/// platform temp dir (`/tmp` on Linux) elsewhere.
fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

struct IsolatedCliEnv {
    base_dir: PathBuf,
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedCliEnv {
    fn new() -> Self {
        let id = Uuid::new_v4();
        let base_dir = test_temp_base().join(format!("cowork-cli-test-{id}"));
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
fn embedded_server_self_exec_reaches_the_native_seccomp_stage() {
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_cowork"))
        .args([
            "__sandbox-exec",
            "--linux-seccomp",
            "--deny-network",
            "--",
            "/bin/sh",
            "-c",
            "exit 37",
        ])
        .output()
        .unwrap();
    if cfg!(target_os = "linux") {
        assert_eq!(result.status.code(), Some(37), "{result:?}");
    } else {
        assert_eq!(result.status.code(), Some(125), "{result:?}");
        assert!(
            String::from_utf8_lossy(&result.stderr)
                .contains("seccomp-BPF is only supported on Linux")
        );
    }
}

#[test]
fn parses_all_12_slash_commands_and_messages() {
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
    // The TS CLI had no `/compact` and the protocol has no compaction RPC, so it is not a
    // built-in command; it falls through to workspace command lookup like any other name.
    assert!(!REPL_SLASH_COMMANDS.contains(&"/compact"));
    assert_eq!(
        parse_repl_input("/compact"),
        ParsedReplCommand::Unknown {
            name: "compact".to_owned(),
            arg: String::new(),
        }
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
    // `/compact` must not claim success for an operation the server does not implement.
    assert!(
        !output1.contains("Compact current conversation context"),
        "help must not advertise /compact: {output1}"
    );
    assert!(!output1.contains("compacted"), "{output1}");
    assert!(
        output1.contains("Unknown command: /compact"),
        "expected /compact to be reported as unknown: {output1}"
    );

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
        output1.contains("[question] Which environment should we configure?"),
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

/// Registered slash commands (`command/execute`) start a real turn; the REPL must consume it
/// through the same render + approval loop as an ordinary message instead of returning to the
/// prompt after a brief drain (TS parity: command turns stream through the shared event handler).
#[tokio::test]
async fn repl_slash_command_turn_streams_output_and_answers_approvals() {
    let mut iso = IsolatedCliEnv::new();
    let target_file = iso.workspace_dir.join("review-note.txt");

    let (base_url, _calls) = spawn_mock_openai_sse(vec![
        responses_tool_calls_sse(
            "resp_cmd_1",
            &[(
                "call_cmd_bash_1",
                "bash",
                json!({
                    "command": format!("rm -f stale.tmp && printf 'reviewed' > '{}'", target_file.display()),
                    "description": "Write review marker"
                }),
            )],
        ),
        responses_text_sse("resp_cmd_2", "Review finished: no regressions found."),
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

    let output = run_repl_scripted(opts, &["/provider openai", "/review HEAD~3", "y", "/exit"])
        .await
        .unwrap();

    assert!(
        output.contains("[approval] Command requires approval:"),
        "output={output}"
    );
    assert!(
        output.contains("[tool] bash -> output-available"),
        "output={output}"
    );
    assert!(
        output.contains("Review finished: no regressions found."),
        "output={output}"
    );
    assert!(!output.contains("Unknown command"), "output={output}");
    assert_eq!(std::fs::read_to_string(&target_file).unwrap(), "reviewed");
}

/// Model/server-supplied text must not reach the terminal with OSC/DCS/APC/PM/SOS sequences
/// intact (TS parity: `sanitizeTerminalOutput` on deltas, final text, and ask/approval prompts),
/// while the safe SGR color sequences it preserves still pass through.
#[tokio::test]
async fn repl_sanitizes_terminal_control_sequences_in_server_supplied_text() {
    let mut iso = IsolatedCliEnv::new();
    let (base_url, _calls) = spawn_mock_openai_sse(vec![
        responses_tool_calls_sse(
            "resp_sanitize_1",
            &[(
                "call_ask_sanitize",
                "AskUserQuestion",
                json!({
                    "questions": [{
                        "id": "q1",
                        "header": "Pick\u{1b}]0;hdr-title\u{7}",
                        "question": "Which\u{1b}]52;c;Y2xpcA==\u{7} one?",
                        "options": [
                            { "label": "alpha\u{1b}Pdcs\u{1b}\\", "description": "first\u{1b}_apc\u{1b}\\" },
                            { "label": "beta", "description": "second" }
                        ]
                    }]
                }),
            )],
        ),
        responses_text_sse(
            "resp_sanitize_2",
            "before\u{1b}]0;evil title\u{7}middle\u{1b}]52;c;SGVsbG8=\u{7}\u{1b}]8;;https://evil.example\u{1b}\\link\u{1b}]8;;\u{1b}\\ \u{1b}[32mgreen\u{1b}[0m after",
        ),
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

    let output = run_repl_scripted(opts, &["/provider openai", "Say something", "1", "/exit"])
        .await
        .unwrap();

    assert!(
        output.contains("[question] Which one?"),
        "output={output:?}"
    );
    assert!(output.contains("  1. alpha\n"), "output={output:?}");
    assert!(
        output.contains("beforemiddlelink \u{1b}[32mgreen\u{1b}[0m after"),
        "output={output:?}"
    );
    for forbidden in [
        "\u{1b}]", "\u{1b}P", "\u{1b}_", "\u{1b}^", "\u{1b}X", "\u{7}",
    ] {
        assert!(
            !output.contains(forbidden),
            "found {forbidden:?} in output={output:?}"
        );
    }
}

/// `/cwd <path>` validates the directory (relative to the current workspace), restarts the
/// embedded server there, and later turns run in the new workspace (TS parity: `/cwd` handler
/// with `resolveAndValidateDir` + `restartServer`).
#[tokio::test]
async fn repl_cwd_switches_workspace_and_restarts_server() {
    let mut iso = IsolatedCliEnv::new();
    let other_dir = iso.base_dir.join("other-workspace");
    std::fs::create_dir_all(&other_dir).unwrap();
    let other_dir = std::fs::canonicalize(&other_dir).unwrap();

    let (base_url, _calls) = spawn_mock_openai_sse(vec![
        responses_tool_calls_sse(
            "resp_cwd_1",
            &[(
                "call_cwd_bash_1",
                "bash",
                json!({
                    "command": "printf moved > cwd-marker.txt",
                    "description": "Write marker in the active workspace"
                }),
            )],
        ),
        responses_text_sse("resp_cwd_2", "Marker written."),
    ])
    .await;

    iso.env
        .insert("OPENAI_API_KEY".into(), "sk-test-cli".into());
    iso.env.insert("OPENAI_BASE_URL".into(), base_url);

    let opts = ReplOptions {
        working_directory: iso.workspace_dir.clone(),
        port: 0,
        yolo: true,
        homedir: Some(iso.home_dir.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env: iso.env.clone(),
    };

    let missing = iso.base_dir.join("does-not-exist");
    let output = run_repl_scripted(
        opts,
        &[
            "/cwd",
            "/cwd ../does-not-exist",
            "/cwd ../other-workspace",
            "/provider openai",
            "Write the marker",
            "/restart",
            "/exit",
        ],
    )
    .await
    .unwrap();

    assert!(output.contains("usage: /cwd <path>"), "output={output}");
    assert!(
        output.contains(&format!("--dir is not a directory: {}", missing.display())),
        "output={output}"
    );
    assert!(
        output.contains(&format!("cwd set to {}", other_dir.display())),
        "output={output}"
    );
    assert!(output.contains("Marker written."), "output={output}");
    // `/restart` restarts in the same workspace and auto-resumes the current thread.
    let after_restart = output
        .split("restarting server...")
        .nth(1)
        .unwrap_or_else(|| panic!("missing restart notice; output={output}"));
    assert!(
        after_restart.contains(&format!("Workspace: {}", other_dir.display())),
        "output={output}"
    );
    assert!(
        after_restart.contains("--- Conversation History (1 turn(s)) ---"),
        "output={output}"
    );
    assert_eq!(
        std::fs::read_to_string(other_dir.join("cwd-marker.txt")).unwrap(),
        "moved"
    );
    assert!(!iso.workspace_dir.join("cwd-marker.txt").exists());
    assert!(
        get_stored_session_for_cwd(&iso.home_dir, &iso.env, &other_dir).is_some(),
        "expected a stored thread for the new workspace"
    );
}

fn scripted_opts(iso: &IsolatedCliEnv) -> ReplOptions {
    ReplOptions {
        working_directory: iso.workspace_dir.clone(),
        port: 0,
        yolo: false,
        homedir: Some(iso.home_dir.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env: iso.env.clone(),
    }
}

/// `/new` starts a thread on the workspace defaults (no provider/model overrides), so the REPL's
/// provider/model must follow the new thread's descriptor rather than its own last local
/// selection (TS parity: `tryRequest("thread/start")` -> `applyThreadDescriptor`).
///
/// A root thread's `/provider` persists to the workspace defaults (TS `persistModelSelectionImpl`),
/// so a plain `/provider` + `/new` would land on the same selection either way. To tell "adopted
/// the new thread's descriptor" from "kept local state", a turn rewrites the workspace defaults
/// between `/provider` and `/new` -- and only if `/provider` persisted them first.
#[tokio::test]
async fn repl_new_thread_refreshes_provider_and_model_selection() {
    let mut iso = IsolatedCliEnv::new();
    let (base_url, _calls) = spawn_mock_openai_sse(vec![
        responses_tool_calls_sse(
            "resp_defaults_1",
            &[(
                "call_defaults_bash_1",
                "bash",
                json!({
                    "command": "grep -q '\"provider\": *\"openai\"' .cowork/config.json && printf '{\"provider\":\"anthropic\",\"model\":\"claude-opus-4-8\"}' > .cowork/config.json",
                    "description": "Rewrite the workspace defaults"
                }),
            )],
        ),
        responses_text_sse("resp_defaults_2", "Defaults rewritten."),
    ])
    .await;
    iso.env
        .insert("OPENAI_API_KEY".into(), "sk-test-cli".into());
    iso.env.insert("OPENAI_BASE_URL".into(), base_url);
    let opts = ReplOptions {
        yolo: true,
        ..scripted_opts(&iso)
    };

    let output = run_repl_scripted(
        opts,
        &[
            "/provider openai",
            "Rewrite the workspace defaults",
            "/new",
            "/model",
            "/reasoning high",
            "/verbosity low",
            "/exit",
        ],
    )
    .await
    .unwrap();

    // Banner: "Cowork CLI vX — connected (<provider> / <model>)" for the initial defaults.
    let banner = output
        .lines()
        .next()
        .and_then(|l| l.split("connected (").nth(1))
        .and_then(|l| l.strip_suffix(')'))
        .unwrap_or_else(|| panic!("missing banner; output={output}"));
    let (default_provider, _) = banner
        .split_once(" / ")
        .unwrap_or_else(|| panic!("bad banner; output={output}"));
    assert_ne!(default_provider, "openai", "output={output}");
    assert_ne!(default_provider, "anthropic", "output={output}");
    assert!(output.contains("Provider set to openai"), "output={output}");
    assert!(output.contains("Defaults rewritten."), "output={output}");

    // The REPL's last local selection was openai; the new thread starts on the rewritten
    // workspace defaults, and the REPL reports and uses those.
    let after_new = output
        .split("Started new thread:")
        .nth(1)
        .unwrap_or_else(|| panic!("missing /new notice; output={output}"));
    assert!(
        after_new.contains("(anthropic / claude-opus-4-8)"),
        "output={output}"
    );
    assert!(
        after_new.contains("Current model: claude-opus-4-8 (anthropic)"),
        "output={output}"
    );
    assert!(
        after_new.contains("anthropic reasoning effort set to high"),
        "output={output}"
    );
    assert!(
        after_new.contains("anthropic verbosity set to low"),
        "output={output}"
    );
    assert!(!after_new.contains("openai"), "output={output}");
}

/// `/effort` (and `/reasoning`) accept the full canonical ladder, TS
/// `OPENAI_REASONING_EFFORT_VALUES`: `none` disables reasoning and `light`/`max` are opt-in
/// levels some models advertise, so none of them may be rejected client-side. Unknown values
/// still print the usage line listing the complete ladder in order.
#[tokio::test]
async fn repl_effort_accepts_full_reasoning_effort_ladder() {
    let iso = IsolatedCliEnv::new();
    let output = run_repl_scripted(
        scripted_opts(&iso),
        &[
            "/help",
            "/provider openai",
            "/effort none",
            "/effort light",
            "/reasoning-effort MAX",
            "/effort bogus",
            "/exit",
        ],
    )
    .await
    .unwrap();

    let ladder = "none|minimal|light|low|medium|high|xhigh|max";
    assert!(
        output.contains(&format!("Set reasoning effort ({ladder})")),
        "help must list the full ladder; output={output}"
    );
    for effort in ["none", "light", "max"] {
        assert!(
            output.contains(&format!("openai reasoning effort set to {effort}")),
            "expected /effort {effort} to be accepted; output={output}"
        );
    }
    assert!(
        output.contains(&format!("usage: /reasoning <{ladder}>")),
        "output={output}"
    );
    assert!(!output.contains("set to bogus"), "output={output}");
}

/// The id printed after `marker` (e.g. the banner's `Thread: <id>` or `Started new thread: <id>`).
fn id_after(output: &str, marker: &str) -> String {
    output
        .split(marker)
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("missing {marker:?}; output={output}"))
        .to_owned()
}

/// Resuming a thread that belongs to another workspace adopts that thread's working directory
/// (TS `applyThreadDescriptor`: `workspaceCwd = descriptor.cwd` before persisting, then
/// `loadWorkspaceMetadata` for it): later workspace-scoped commands target the thread's
/// workspace and the last-session entry is written under it, leaving the launch workspace's
/// entry untouched. The startup auto-resume path adopts it the same way.
#[tokio::test]
async fn repl_resume_adopts_the_resumed_threads_workspace() {
    let mut iso = IsolatedCliEnv::new();
    let (base_url, _calls) =
        spawn_mock_openai_sse(vec![responses_text_sse("resp_ws_b", "Hello from B.")]).await;
    use_openai_provider(&mut iso, &base_url);
    // Workspace B sits under the one-off chats root, which a server launched in A authorizes for
    // `thread/list` / `thread/start`, and carries a skill that only exists there.
    let workspace_b = iso.home_dir.join(".cowork/chats/workspace-b");
    let skill_dir = workspace_b.join(".agents/skills/workspace-b-only");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: workspace-b-only\ndescription: Only discoverable from workspace B.\n---\n\n# B\n",
    )
    .unwrap();
    let workspace_b = std::fs::canonicalize(&workspace_b).unwrap();
    let workspace_a = iso.workspace_dir.clone();
    let stored = |cwd: &PathBuf| get_stored_session_for_cwd(&iso.home_dir, &iso.env, cwd);

    // Seed B's thread (with a turn, so `thread/list` includes it) from a REPL launched in B.
    let mut b_opts = scripted_opts(&iso);
    b_opts.working_directory = workspace_b.clone();
    let output = run_repl_scripted(b_opts, &["Say hello", "/exit"])
        .await
        .unwrap();
    assert!(output.contains("Hello from B."), "output={output}");
    let b_thread = stored(&workspace_b).expect("expected a stored thread for workspace B");

    // Launched in A: `/resume` B's thread, then list sessions and skills.
    let output = run_repl_scripted(
        scripted_opts(&iso),
        &[
            &format!("/resume {b_thread}"),
            "/sessions",
            "/skills",
            "/exit",
        ],
    )
    .await
    .unwrap();
    let a_thread = id_after(&output, "Thread: ");
    assert_ne!(a_thread, b_thread, "output={output}");
    let after_resume = output
        .split("Resumed thread:")
        .nth(1)
        .unwrap_or_else(|| panic!("missing /resume notice; output={output}"));
    assert!(
        after_resume.contains(&format!(" * {b_thread} ")),
        "/sessions must list workspace B's threads: {output}"
    );
    assert!(
        !after_resume.contains(&a_thread),
        "/sessions must not list workspace A's threads: {output}"
    );
    assert!(
        after_resume.contains("  - workspace-b-only"),
        "/skills must read workspace B: {output}"
    );
    assert_eq!(stored(&workspace_b).as_deref(), Some(b_thread.as_str()));
    assert_eq!(
        stored(&workspace_a).as_deref(),
        Some(a_thread.as_str()),
        "A's last-session entry must be untouched"
    );

    // Launched in A again (auto-resumes A's thread): `/new` after resuming B starts in B.
    let output = run_repl_scripted(
        scripted_opts(&iso),
        &[&format!("/resume {b_thread}"), "/new", "/exit"],
    )
    .await
    .unwrap();
    assert_eq!(id_after(&output, "Thread: "), a_thread, "output={output}");
    let new_thread = id_after(&output, "Started new thread: ");
    assert_ne!(new_thread, b_thread, "output={output}");
    assert_eq!(stored(&workspace_b).as_deref(), Some(new_thread.as_str()));
    assert_eq!(stored(&workspace_a).as_deref(), Some(a_thread.as_str()));

    // Startup auto-resume: a launch workspace whose stored thread belongs to B (as a pre-fix CLI
    // persisted it) adopts B for the session.
    set_stored_session_for_cwd(&iso.home_dir, &iso.env, &workspace_a, &b_thread).unwrap();
    let output = run_repl_scripted(scripted_opts(&iso), &["/sessions", "/exit"])
        .await
        .unwrap();
    assert!(
        output.contains(&format!("Workspace: {}", workspace_b.display())),
        "output={output}"
    );
    assert!(
        output.contains(&format!(" * {b_thread} ")),
        "output={output}"
    );
    assert_eq!(stored(&workspace_b).as_deref(), Some(b_thread.as_str()));
}

/// A slash command whose RPC fails reports the error and keeps the REPL running (TS parity:
/// `tryRequest` prints `Error: ...` and re-prompts) instead of ending the session.
#[tokio::test]
async fn repl_keeps_running_after_a_failing_command_rpc() {
    let iso = IsolatedCliEnv::new();
    let output = run_repl_scripted(
        scripted_opts(&iso),
        &["/connect opneai token", "/sessions", "/model", "/exit"],
    )
    .await
    .unwrap_or_else(|err| panic!("REPL ended on a recoverable command error: {err:#}"));

    let error_line = output
        .lines()
        .find(|l| l.starts_with("Error: "))
        .unwrap_or_else(|| panic!("missing error report; output={output}"));
    assert!(error_line.contains("opneai"), "output={output}");
    assert!(
        output.contains("Use /new to start a new thread"),
        "output={output}"
    );
    assert!(output.contains("Current model: "), "output={output}");
    assert!(output.contains("Goodbye."), "output={output}");
}

fn isolated_cli(iso: &IsolatedCliEnv) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_cowork"));
    cmd.arg("-d").arg(&iso.workspace_dir);
    cmd.env_clear();
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    cmd.envs(&iso.env);
    cmd
}

#[tokio::test]
async fn interactive_history_omits_provider_credentials() {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let iso = IsolatedCliEnv::new();
    let mut child = isolated_cli(&iso)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"/help\n/connect unknown dummy-history-secret\n/exit\n")
        .await
        .unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Goodbye."));
    let history =
        std::fs::read_to_string(cowork_cli::repl_history_file_path(&iso.home_dir, &iso.env))
            .unwrap();
    assert!(history.contains("/help"));
    assert!(!history.contains("dummy-history-secret"));
}

/// Runs the real `cowork "<prompt>"` binary in one-shot mode against an isolated home/workspace.
async fn run_one_shot_binary(iso: &IsolatedCliEnv, prompt: &str) -> std::process::Output {
    let mut cmd = isolated_cli(iso);
    cmd.arg(prompt).stdin(std::process::Stdio::null());
    tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output())
        .await
        .expect("one-shot cowork timed out")
        .expect("failed to spawn cowork")
}

/// A one-shot turn whose provider fails must exit non-zero so shell scripts and CI see the
/// failure, instead of the unconditional success the REPL loop uses for interactive recovery.
#[tokio::test]
async fn one_shot_prompt_exits_nonzero_when_the_turn_fails() {
    let mut iso = IsolatedCliEnv::new();
    // A reachable provider endpoint that rejects every model call.
    let app = Router::new().route(
        "/v1/responses",
        post(|| async {
            (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, "application/json")],
                r#"{"error":{"message":"one-shot provider rejected the request","type":"invalid_request_error"}}"#,
            )
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    use_openai_provider(&mut iso, &format!("http://127.0.0.1:{port}/v1"));

    let result = run_one_shot_binary(&iso, "Say hello").await;
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        !result.status.success(),
        "failed one-shot turn exited successfully; status={:?} stdout={stdout} stderr={stderr}",
        result.status
    );
    assert_eq!(
        result.status.code(),
        Some(1),
        "stdout={stdout} stderr={stderr}"
    );
    assert!(
        stderr.contains("Turn failed"),
        "stdout={stdout} stderr={stderr}"
    );
}

/// A one-shot turn that completes keeps exiting zero.
#[tokio::test]
async fn one_shot_prompt_exits_zero_when_the_turn_completes() {
    let mut iso = IsolatedCliEnv::new();
    let (base_url, calls) =
        spawn_mock_openai_sse(vec![responses_text_sse("resp_one_shot", "One-shot done.")]).await;
    use_openai_provider(&mut iso, &base_url);

    let result = run_one_shot_binary(&iso, "Say hello").await;
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        result.status.success(),
        "status={:?} stdout={stdout} stderr={stderr}",
        result.status
    );
    assert!(
        stdout.contains("One-shot done."),
        "stdout={stdout} stderr={stderr}"
    );
    assert!(calls.load(Ordering::SeqCst) >= 1);
}

/// Selects the OpenAI provider (served from `base_url`) as the isolated workspace default.
fn use_openai_provider(iso: &mut IsolatedCliEnv, base_url: &str) {
    iso.env.insert("AGENT_PROVIDER".into(), "openai".into());
    iso.env
        .insert("OPENAI_API_KEY".into(), "sk-test-cli".into());
    iso.env
        .insert("OPENAI_BASE_URL".into(), base_url.to_owned());
}
