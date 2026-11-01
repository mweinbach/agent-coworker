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
