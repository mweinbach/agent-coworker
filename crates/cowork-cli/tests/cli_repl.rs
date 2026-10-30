use std::collections::HashMap;
use std::path::PathBuf;

use cowork_cli::{
    ParsedReplCommand, REPL_SLASH_COMMANDS, ReplOptions, get_stored_session_for_cwd,
    parse_repl_input, run_repl_scripted, set_stored_session_for_cwd,
};
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
