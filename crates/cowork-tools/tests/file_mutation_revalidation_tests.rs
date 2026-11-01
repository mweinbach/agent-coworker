//! Regression tests: file mutations must re-validate the authorized target after
//! asynchronous gates (approval prompt) so a parent directory swapped for a
//! symlink cannot redirect the write outside the workspace.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, ToolExecutionContext, create_builtin_tools,
    with_file_mutation,
};
use serde_json::json;

/// Approves every file change, but first replaces `swap_dir` with a symlink to
/// `outside_dir` — simulating an attacker racing the pending approval.
struct SwappingApprover {
    swap_dir: PathBuf,
    outside_dir: PathBuf,
    calls: AtomicUsize,
}

#[async_trait]
impl ApprovalHandler for SwappingApprover {
    async fn approve_command(&self, _req: ApprovalDecisionRequest) -> Result<bool, String> {
        Ok(true)
    }

    async fn ask_user(
        &self,
        _question: &str,
        _options: Option<Vec<String>>,
    ) -> Result<String, String> {
        Err("not supported in this test".to_owned())
    }

    async fn approve_file_change(
        &self,
        _path: &Path,
        _reason: Option<&str>,
    ) -> Result<bool, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        fs::remove_dir_all(&self.swap_dir).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&self.outside_dir, &self.swap_dir).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    outside: PathBuf,
    ctx: ToolExecutionContext,
    approver: Arc<SwappingApprover>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let ws = base.join("workspace");
    let outside = base.join("outside");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(ws.join("sub")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(ws.join("sub").join("target.txt"), "inside original").unwrap();
    fs::write(outside.join("target.txt"), "outside original").unwrap();

    let approver = Arc::new(SwappingApprover {
        swap_dir: ws.join("sub"),
        outside_dir: outside.clone(),
        calls: AtomicUsize::new(0),
    });
    let mut ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    ctx.approval_handler = Some(approver.clone());
    Fixture {
        _tmp: tmp,
        ws,
        outside,
        ctx,
        approver,
    }
}

fn outside_listing(outside: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(outside)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn with_file_mutation_fails_closed_when_parent_swapped_during_approval() {
    let f = fixture();
    let target = f.ws.join("sub").join("target.txt");

    let mutate_ran = Arc::new(AtomicUsize::new(0));
    let mutate_ran_in = mutate_ran.clone();
    let result = with_file_mutation(&target, &f.ctx, move |_snapshot| {
        mutate_ran_in.fetch_add(1, Ordering::SeqCst);
        Ok((b"pwned".to_vec(), ()))
    })
    .await;

    assert_eq!(f.approver.calls.load(Ordering::SeqCst), 1);
    let err = result.expect_err("mutation must fail after parent swap");
    assert!(
        err.to_string().contains("changed during mutation") || err.to_string().contains("blocked"),
        "unexpected error: {err}"
    );
    assert_eq!(mutate_ran.load(Ordering::SeqCst), 0, "mutate must not run");
    assert_eq!(
        fs::read_to_string(f.outside.join("target.txt")).unwrap(),
        "outside original"
    );
    // No staging file leaked into the outside directory either.
    assert_eq!(outside_listing(&f.outside), vec!["target.txt".to_owned()]);
}

#[tokio::test]
async fn write_tool_fails_closed_when_parent_swapped_during_approval() {
    let f = fixture();
    let tools = create_builtin_tools(&f.ctx);
    let write = tools.get("write").expect("write tool");

    let result = write
        .execute(
            serde_json::from_value(json!({
                "filePath": f.ws.join("sub").join("target.txt").to_string_lossy(),
                "content": "pwned",
            }))
            .unwrap(),
            &f.ctx,
        )
        .await;

    assert_eq!(f.approver.calls.load(Ordering::SeqCst), 1);
    assert!(result.is_err(), "write must fail after parent swap");
    assert_eq!(
        fs::read_to_string(f.outside.join("target.txt")).unwrap(),
        "outside original"
    );
    assert_eq!(outside_listing(&f.outside), vec!["target.txt".to_owned()]);
}

#[tokio::test]
async fn with_file_mutation_still_writes_when_nothing_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");

    let target = ws.join("new").join("nested").join("file.txt");
    with_file_mutation(&target, &ctx, |snapshot| {
        assert!(!snapshot.exists);
        Ok((b"hello".to_vec(), ()))
    })
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
}
