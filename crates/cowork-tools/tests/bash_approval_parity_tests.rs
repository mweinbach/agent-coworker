//! Regression: in non-YOLO turns, bash commands the legacy TS server did not auto-approve
//! (its `dangerous` + `review` tables) must go through the approval handler before running,
//! and are denied when no handler is available.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, ToolExecutionContext, ToolOutput,
    create_builtin_tools,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

struct RecordingApprover {
    approve: bool,
    requests: Mutex<Vec<ApprovalDecisionRequest>>,
}

#[async_trait]
impl ApprovalHandler for RecordingApprover {
    async fn approve_command(&self, req: ApprovalDecisionRequest) -> Result<bool, String> {
        self.requests.lock().push(req);
        Ok(self.approve)
    }

    async fn ask_user(
        &self,
        _question: &str,
        _options: Option<Vec<String>>,
    ) -> Result<String, String> {
        Ok(String::new())
    }
}

fn setup() -> (PathBuf, ToolExecutionContext) {
    let base = std::env::temp_dir().join(format!("cowork-tools-bash-approval-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    (ws, ctx)
}

async fn run_bash(ctx: &ToolExecutionContext, command: &str) -> Value {
    let tools = create_builtin_tools(ctx);
    match tools["bash"]
        .execute(
            serde_json::from_value(json!({ "command": command })).unwrap(),
            ctx,
        )
        .await
        .unwrap()
    {
        ToolOutput::Json(v) => v,
        other => panic!("unexpected bash output: {other:?}"),
    }
}

fn not_approved(out: &Value) -> bool {
    out["stderr"] == "Command was not approved." && out["exitCode"] == 1
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn bash_discovers_backend_from_host_and_runs_it_with_child_env() {
    use std::os::unix::fs::PermissionsExt;

    let (_ws, mut ctx) = setup();
    let bundle = tempfile::tempdir().unwrap();
    let helper = bundle.path().join("fixture-bwrap");
    fs::write(
        &helper,
        r#"#!/bin/sh
while [ "$1" != -- ]; do shift; done
shift
if [ "$2" = __sandbox-exec ]; then
    printf 'fixture: '
    while [ "$1" != -- ]; do shift; done
    shift
fi
exec "$@"
"#,
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    ctx.env.insert(
        "COWORK_BWRAP_PATH".to_owned(),
        helper.to_string_lossy().into_owned(),
    );
    ctx.sandbox_config.require_backend = true;
    let out = run_bash(&ctx, "echo \"$COWORK_SANDBOX ${COWORK_BWRAP_PATH-unset}\"").await;
    assert_eq!(out["exitCode"], 0, "{out}");
    assert_eq!(
        out["stdout"].as_str().unwrap().trim(),
        "fixture: linux-bwrap unset"
    );
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires the provisioned Windows sandbox helper bundle"]
async fn windows_bash_uses_host_sandbox() {
    let (_ws, mut ctx) = setup();
    ctx.env = std::env::vars().collect();
    ctx.sandbox_config.require_backend = true;
    let out = run_bash(
        &ctx,
        "if (Get-ChildItem Env:COWORK_WIN_SANDBOX_*) { throw 'helper configuration leaked' }; Write-Output 'sandbox-ok'",
    )
    .await;
    assert_eq!(out["exitCode"], 0, "{out}");
    assert_eq!(out["stdout"].as_str().unwrap().trim(), "sandbox-ok");
}

#[tokio::test]
async fn review_classified_bash_commands_require_approval_outside_yolo() {
    let (ws, mut ctx) = setup();
    let victim = ws.join("victim.txt");
    fs::write(&victim, "keep me").unwrap();
    assert!(!ctx.yolo);

    // No approval handler -> denied, never executed.
    let out = run_bash(&ctx, "rm victim.txt").await;
    assert!(not_approved(&out), "{out}");
    assert!(victim.exists());
    let out = run_bash(&ctx, "cat ~/.ssh/id_rsa").await;
    assert!(not_approved(&out), "{out}");

    // Handler declines -> denied, never executed; the prompt carries the review reason.
    let deny = Arc::new(RecordingApprover {
        approve: false,
        requests: Mutex::new(Vec::new()),
    });
    ctx.approval_handler = Some(deny.clone());
    let out = run_bash(&ctx, "rm victim.txt").await;
    assert!(not_approved(&out), "{out}");
    assert!(victim.exists());
    {
        let reqs = deny.requests.lock();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].command, "rm victim.txt");
        assert_eq!(reqs[0].reason, "requires_manual_review");
    }

    // Handler approves -> the command runs.
    let allow = Arc::new(RecordingApprover {
        approve: true,
        requests: Mutex::new(Vec::new()),
    });
    ctx.approval_handler = Some(allow.clone());
    let out = run_bash(&ctx, "rm victim.txt").await;
    assert!(!not_approved(&out), "{out}");
    assert!(!victim.exists(), "approved command must execute: {out}");
    assert_eq!(allow.requests.lock()[0].reason, "requires_manual_review");

    // Commands the TS server auto-approved still never prompt.
    let quiet = Arc::new(RecordingApprover {
        approve: false,
        requests: Mutex::new(Vec::new()),
    });
    ctx.approval_handler = Some(quiet.clone());
    let out = run_bash(&ctx, "echo hello").await;
    assert!(!not_approved(&out), "{out}");
    assert!(
        quiet.requests.lock().iter().all(
            |r| r.reason != "requires_manual_review" && r.reason != "matches_dangerous_pattern"
        ),
        "auto-approved command must not hit the pre-exec prompt"
    );

    // YOLO keeps its no-prompt semantics.
    ctx.yolo = true;
    ctx.approval_handler = None;
    fs::write(&victim, "again").unwrap();
    let out = run_bash(&ctx, "rm victim.txt").await;
    assert!(!not_approved(&out), "{out}");
}

// ---------------------------------------------------------------------------------------------
// Regression: the task-mutation lock (`before_tool_invocation`, TS `assertCanMutate("bash")`) is
// rechecked after every approval wait. Code mode can start `bash` and `createTask` concurrently;
// task creation may lock the source chat while the shell call waits on a prompt, and accepting
// that prompt must not run the command alongside the new task.
// ---------------------------------------------------------------------------------------------

const TASK_LOCK_ERROR: &str = "This chat is locked while a task runs from it.";

/// Approves every prompt; the first prompt matching `lock_on` takes the task-mutation lock
/// before the approval resolves, simulating a concurrent `createTask`.
struct LockingApprover {
    lock: Arc<std::sync::atomic::AtomicBool>,
    lock_on: fn(&ApprovalDecisionRequest) -> bool,
    requests: Mutex<Vec<ApprovalDecisionRequest>>,
}

#[async_trait]
impl ApprovalHandler for LockingApprover {
    async fn approve_command(&self, req: ApprovalDecisionRequest) -> Result<bool, String> {
        if (self.lock_on)(&req) {
            self.lock.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.requests.lock().push(req);
        Ok(true)
    }

    async fn ask_user(
        &self,
        _question: &str,
        _options: Option<Vec<String>>,
    ) -> Result<String, String> {
        Ok(String::new())
    }
}

fn install_task_lock(
    ctx: &mut ToolExecutionContext,
    lock_on: fn(&ApprovalDecisionRequest) -> bool,
) -> Arc<LockingApprover> {
    let lock = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hook_lock = Arc::clone(&lock);
    ctx.before_tool_invocation = Some(Arc::new(move |tool_name: &str| {
        assert_eq!(tool_name, "bash");
        if hook_lock.load(std::sync::atomic::Ordering::SeqCst) {
            Err(TASK_LOCK_ERROR.to_owned())
        } else {
            Ok(())
        }
    }));
    let approver = Arc::new(LockingApprover {
        lock,
        lock_on,
        requests: Mutex::new(Vec::new()),
    });
    ctx.approval_handler = Some(approver.clone());
    approver
}

async fn run_bash_result(
    ctx: &ToolExecutionContext,
    command: &str,
) -> cowork_tools::ToolResult<ToolOutput> {
    let tools = create_builtin_tools(ctx);
    tools["bash"]
        .execute(
            serde_json::from_value(json!({ "command": command })).unwrap(),
            ctx,
        )
        .await
}

fn assert_task_lock_error(res: cowork_tools::ToolResult<ToolOutput>) {
    match res {
        Err(err) => assert_eq!(err.to_string(), TASK_LOCK_ERROR),
        Ok(out) => panic!("expected the task-mutation lock to stop bash, got {out:?}"),
    }
}

#[cfg(target_os = "linux")]
fn install_fixture_bwrap(ctx: &mut ToolExecutionContext) -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;

    let bundle = tempfile::tempdir().unwrap();
    let helper = bundle.path().join("fixture-bwrap");
    fs::write(
        &helper,
        r#"#!/bin/sh
while [ "$1" != -- ]; do shift; done
shift
if [ "$2" = __sandbox-exec ]; then
    while [ "$1" != -- ]; do shift; done
    shift
fi
exec "$@"
"#,
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    ctx.env.insert(
        "COWORK_BWRAP_PATH".to_owned(),
        helper.to_string_lossy().into_owned(),
    );
    bundle
}

#[tokio::test]
async fn task_lock_taken_during_manual_approval_blocks_the_approved_command() {
    let (ws, mut ctx) = setup();
    let victim = ws.join("victim.txt");
    fs::write(&victim, "keep me").unwrap();
    let approver = install_task_lock(&mut ctx, |req| req.reason == "requires_manual_review");

    assert_task_lock_error(run_bash_result(&ctx, "rm victim.txt").await);
    assert!(
        victim.exists(),
        "locked chat must not run the approved command"
    );
    let reqs = approver.requests.lock();
    assert_eq!(reqs.len(), 1, "only the manual-review prompt is shown");
    assert_eq!(reqs[0].reason, "requires_manual_review");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn task_lock_taken_during_sandbox_escalation_approval_blocks_the_retry() {
    let (ws, mut ctx) = setup();
    let _bundle = install_fixture_bwrap(&mut ctx);
    let approver = install_task_lock(&mut ctx, |req| {
        req.reason == "sandbox_denied" && req.category.is_some()
    });

    // First (sandboxed) attempt reports a filesystem denial; only a retry would create `retried`.
    let command = "if [ -e first-attempt ]; then touch retried; exit 0; fi; touch first-attempt; \
                   echo 'touch: cannot touch /outside: Read-only file system' >&2; exit 1";
    assert_task_lock_error(run_bash_result(&ctx, command).await);
    assert!(ws.join("first-attempt").exists(), "first attempt must run");
    assert!(
        !ws.join("retried").exists(),
        "locked chat must not run the approved escalation retry"
    );
    let reqs = approver.requests.lock();
    assert_eq!(reqs.len(), 1, "{:?}", *reqs);
    assert_eq!(reqs[0].reason, "sandbox_denied");
    assert_eq!(reqs[0].category.as_deref(), Some("filesystem"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn task_lock_taken_during_unsandboxed_fallback_approval_blocks_the_command() {
    let (ws, mut ctx) = setup();
    // No usable backend: the runner asks before falling back to an unsandboxed run.
    let missing = ws.join("no-such-bwrap");
    ctx.env.insert(
        "COWORK_BWRAP_PATH".to_owned(),
        missing.to_string_lossy().into_owned(),
    );
    let approver = install_task_lock(&mut ctx, |req| {
        req.reason == "sandbox_denied" && req.category.is_none()
    });

    assert_task_lock_error(run_bash_result(&ctx, "touch executed").await);
    assert!(
        !ws.join("executed").exists(),
        "locked chat must not run the approved unsandboxed fallback"
    );
    let reqs = approver.requests.lock();
    assert_eq!(reqs.len(), 1, "{:?}", *reqs);
    assert_eq!(reqs[0].reason, "sandbox_denied");
    assert_eq!(reqs[0].category, None);
}
