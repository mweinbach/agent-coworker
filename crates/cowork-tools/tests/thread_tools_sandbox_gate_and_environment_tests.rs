//! Regressions for the agent-facing thread-management tools:
//! - Mutating actions are withheld (registration) and refused (execution) from sessions that
//!   cannot write the project (read-only role, `read-only` / `no-project-write` sandbox), and
//!   turn-starting actions (`create_thread`, `fork_thread`, `send_message_to_thread`) from
//!   sessions with network disabled, since the started turn runs under the target thread's own
//!   (default `workspace-write` + network) sandbox. Read actions stay available. Task and
//!   `targetPaths` scope is rechecked at execution time.
//! - `environment` accepts TS `threadEnvironmentSchema` objects (`{ type: "local" }`,
//!   `{ type: "worktree", ref?, branchName?, startingState? }`) as well as the string forms.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_sandbox::SandboxPolicy;
use cowork_tools::thread_tools::CREATE_THREAD_WORKTREE_REF_UNSUPPORTED;
use cowork_tools::{
    ThreadControlBridge, ThreadManagementTool, ToolError, ToolExecutionContext,
    create_builtin_tools,
};
use serde_json::{Map, Value, json};

#[derive(Default)]
struct RecordingBridge {
    calls: Mutex<Vec<(&'static str, Value)>>,
}

impl RecordingBridge {
    fn record(&self, name: &'static str, args: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push((name, args.clone()));
        Ok(args)
    }
    fn names(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().iter().map(|(n, _)| *n).collect()
    }
    fn last(&self) -> Value {
        self.calls.lock().unwrap().last().unwrap().1.clone()
    }
}

#[async_trait]
impl ThreadControlBridge for RecordingBridge {
    async fn list_projects(&self) -> Result<Value, String> {
        self.record("list_projects", json!({}))
    }
    async fn list_threads(&self, args: Value) -> Result<Value, String> {
        self.record("list_threads", args)
    }
    async fn read_thread(&self, args: Value) -> Result<Value, String> {
        self.record("read_thread", args)
    }
    async fn create_thread(&self, args: Value) -> Result<Value, String> {
        self.record("create_thread", args)
    }
    async fn send_message_to_thread(&self, args: Value) -> Result<Value, String> {
        self.record("send_message_to_thread", args)
    }
    async fn fork_thread(&self, args: Value) -> Result<Value, String> {
        self.record("fork_thread", args)
    }
    async fn set_thread_title(&self, args: Value) -> Result<Value, String> {
        self.record("set_thread_title", args)
    }
    async fn set_thread_pinned(&self, args: Value) -> Result<Value, String> {
        self.record("set_thread_pinned", args)
    }
    async fn set_thread_archived(&self, args: Value) -> Result<Value, String> {
        self.record("set_thread_archived", args)
    }
}

const READ_TOOLS: [&str; 3] = ["list_projects", "list_threads", "read_thread"];
const TURN_TOOLS: [&str; 3] = ["create_thread", "fork_thread", "send_message_to_thread"];
const SETTER_TOOLS: [&str; 3] = [
    "set_thread_title",
    "set_thread_pinned",
    "set_thread_archived",
];

fn args(value: Value) -> Map<String, Value> {
    serde_json::from_value(value).unwrap()
}

fn tool(name: &str) -> Arc<dyn cowork_tools::BuiltinTool> {
    ThreadManagementTool::all_tools()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("missing tool {name}"))
}

fn root_ctx(bridge: &Arc<RecordingBridge>) -> (tempfile::TempDir, ToolExecutionContext) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let ws = dir.path().join("ws");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&ws).unwrap();
    let mut ctx = ToolExecutionContext::new_for_tests(home, ws, ProviderName::Openai, "gpt-5.4");
    ctx.session_id = "calling-thread".to_owned();
    ctx.thread_control = Some(Arc::clone(bridge) as Arc<dyn ThreadControlBridge>);
    (dir, ctx)
}

fn thread_tool_names(ctx: &ToolExecutionContext) -> BTreeSet<String> {
    create_builtin_tools(ctx)
        .into_keys()
        .filter(|name| {
            READ_TOOLS.contains(&name.as_str())
                || TURN_TOOLS.contains(&name.as_str())
                || SETTER_TOOLS.contains(&name.as_str())
                || name == "threadManagement"
        })
        .collect()
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

fn mutating_args(name: &str) -> Value {
    match name {
        "create_thread" => json!({ "prompt": "go" }),
        "fork_thread" => json!({}),
        "send_message_to_thread" => json!({ "prompt": "go" }),
        "set_thread_title" => json!({ "title": "t" }),
        "set_thread_pinned" => json!({ "pinned": true }),
        "set_thread_archived" => json!({ "archived": true }),
        other => panic!("{other}"),
    }
}

fn workspace_write(ws: PathBuf, network: bool) -> SandboxPolicy {
    SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws],
        writable_root_kinds: Default::default(),
        network,
    }
}

#[tokio::test]
async fn non_writable_sessions_get_only_read_thread_actions() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, base) = root_ctx(&bridge);
    let ws = base.working_directory.clone();

    // Default workspace-write + network: every thread tool is offered.
    let mut all = set(&READ_TOOLS);
    all.extend(set(&TURN_TOOLS));
    all.extend(set(&SETTER_TOOLS));
    all.insert("threadManagement".to_owned());
    assert_eq!(thread_tool_names(&base), all);

    let mut read_only_policy = base.clone();
    read_only_policy.sandbox_policy = SandboxPolicy::ReadOnly { network: true };
    let mut no_project_write = base.clone();
    no_project_write.sandbox_policy = SandboxPolicy::NoProjectWrite {
        project_roots: vec![ws.clone()],
        network: true,
    };
    let mut read_only_role = base.clone();
    read_only_role.read_only_role = true;

    let mut read_only = set(&READ_TOOLS);
    read_only.insert("threadManagement".to_owned());
    for ctx in [&read_only_policy, &no_project_write, &read_only_role] {
        assert_eq!(
            thread_tool_names(ctx),
            read_only,
            "{:?}",
            ctx.sandbox_policy
        );

        // Execution refuses mutating actions too (per-action tools and `threadManagement`),
        // without reaching the bridge.
        for name in TURN_TOOLS.iter().chain(SETTER_TOOLS.iter()) {
            let err = tool(name)
                .execute(args(mutating_args(name)), ctx)
                .await
                .unwrap_err();
            assert!(matches!(err, ToolError::PathDenied(_)), "{name}: {err:?}");
            let mut combined = args(mutating_args(name));
            combined.insert("action".to_owned(), json!(name));
            let err = tool("threadManagement")
                .execute(combined, ctx)
                .await
                .unwrap_err();
            assert!(matches!(err, ToolError::PathDenied(_)), "{name}: {err:?}");
        }
        assert!(bridge.names().is_empty(), "{:?}", bridge.names());

        // Read actions still work.
        tool("list_threads")
            .execute(args(json!({})), ctx)
            .await
            .unwrap();
        tool("threadManagement")
            .execute(args(json!({ "action": "read_thread" })), ctx)
            .await
            .unwrap();
        assert_eq!(bridge.names(), vec!["list_threads", "read_thread"]);
        bridge.calls.lock().unwrap().clear();
    }
}

#[tokio::test]
async fn network_disabled_sessions_cannot_start_turns_in_other_threads() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, mut ctx) = root_ctx(&bridge);
    ctx.sandbox_policy = workspace_write(ctx.working_directory.clone(), false);

    let mut expected = set(&READ_TOOLS);
    expected.extend(set(&SETTER_TOOLS));
    expected.insert("threadManagement".to_owned());
    assert_eq!(thread_tool_names(&ctx), expected);

    for name in TURN_TOOLS {
        let err = tool(name)
            .execute(args(mutating_args(name)), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::PathDenied(_)), "{name}: {err:?}");
    }
    assert!(bridge.names().is_empty());
    // Metadata setters do not start a turn.
    tool("set_thread_title")
        .execute(args(json!({ "title": "renamed" })), &ctx)
        .await
        .unwrap();
    assert_eq!(bridge.names(), vec!["set_thread_title"]);
}

#[tokio::test]
async fn task_and_scoped_contexts_are_refused_at_execution_time() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, base) = root_ctx(&bridge);
    let mut in_task = base.clone();
    in_task.in_task_context = true;
    let mut scoped = base.clone();
    scoped.target_paths = Some(vec![base.working_directory.join("src")]);
    for ctx in [&in_task, &scoped] {
        for name in ["list_threads", "fork_thread"] {
            let raw = if name == "list_threads" {
                json!({})
            } else {
                mutating_args(name)
            };
            let err = tool(name).execute(args(raw), ctx).await.unwrap_err();
            assert!(matches!(err, ToolError::PathDenied(_)), "{name}: {err:?}");
        }
    }
    assert!(bridge.names().is_empty());
}

#[tokio::test]
async fn fork_thread_accepts_object_environment_specs() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(&bridge);

    let worktree = json!({
        "type": "worktree",
        "ref": "main",
        "branchName": "feature/x",
        "startingState": { "ref": "origin/main", "branchName": "base" }
    });
    for (tool_name, mut raw) in [
        ("fork_thread", json!({ "environment": worktree.clone() })),
        (
            "threadManagement",
            json!({ "action": "fork_thread", "environment": worktree.clone() }),
        ),
        ("fork_thread", json!({ "environment": { "type": "local" } })),
        ("fork_thread", json!({ "environment": "worktree" })),
    ] {
        let expected_env = raw["environment"].clone();
        tool(tool_name)
            .execute(args(raw.take()), &ctx)
            .await
            .unwrap_or_else(|err| panic!("{tool_name} {expected_env}: {err:?}"));
        assert_eq!(bridge.last()["environment"], expected_env);
    }

    // Strict objects: unknown keys and unknown types are rejected before the bridge.
    bridge.calls.lock().unwrap().clear();
    for bad in [
        json!({ "type": "worktree", "base": "main" }),
        json!({ "type": "remote" }),
        json!({ "type": "local", "ref": "main" }),
        json!({ "type": "worktree", "startingState": { "sha": "abc" } }),
        json!({ "type": "worktree", "ref": "" }),
    ] {
        let err = tool("fork_thread")
            .execute(args(json!({ "environment": bad.clone() })), &ctx)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidArguments(_)),
            "{bad}: {err:?}"
        );
    }
    assert!(bridge.names().is_empty());
}

#[tokio::test]
async fn create_thread_folds_object_environment_into_the_bridge_shape() {
    let bridge = Arc::new(RecordingBridge::default());
    let (_dir, ctx) = root_ctx(&bridge);

    tool("create_thread")
        .execute(
            args(json!({
                "prompt": "go",
                "environment": { "type": "worktree", "branchName": "feature/y" }
            })),
            &ctx,
        )
        .await
        .unwrap();
    let sent = bridge.last();
    assert_eq!(sent["environment"], json!("worktree"));
    assert_eq!(sent["branchName"], json!("feature/y"));

    tool("threadManagement")
        .execute(
            args(json!({
                "action": "create_thread",
                "prompt": "go",
                "environment": { "type": "local" }
            })),
            &ctx,
        )
        .await
        .unwrap();
    assert_eq!(bridge.last()["environment"], json!("local"));

    // The server creates worktrees from the default base: a requested base ref is refused
    // rather than silently ignored.
    let err = tool("create_thread")
        .execute(
            args(json!({
                "prompt": "go",
                "environment": { "type": "worktree", "startingState": { "ref": "v1" } }
            })),
            &ctx,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&err, ToolError::InvalidArguments(m) if m == CREATE_THREAD_WORKTREE_REF_UNSUPPORTED),
        "{err:?}"
    );
}
