//! Regression: the task-mutation lock (`before_tool_invocation`, TS
//! `assertCanMutate(toolName)` in `mutationGuard.ts`) is rechecked after every
//! wait in the shared `write`/`edit` mutation helper. Code mode can start a
//! file mutation concurrently with `createTask`; task creation may lock the
//! source chat while the mutation waits for approval or for another holder's
//! file lock, and the mutation must then leave the target untouched.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::{FileLockOptions, ProviderName, with_file_lock_sync};
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, ToolExecutionContext, ToolOutput,
    create_builtin_tools, with_file_mutation,
};
use serde_json::{Value, json};

const TASK_LOCK_ERROR: &str = "This chat is locked while a task runs from it.";

fn ctx_for(base: &Path) -> (PathBuf, ToolExecutionContext) {
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

/// Shared task-mutation lock flag plus the tool names the hook was asked about.
struct TaskLock {
    locked: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<String>>>,
}

impl TaskLock {
    fn take(&self) {
        self.locked.store(true, Ordering::SeqCst);
    }

    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn install_task_lock(ctx: &mut ToolExecutionContext) -> TaskLock {
    let locked = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hook_locked = Arc::clone(&locked);
    let hook_seen = Arc::clone(&seen);
    ctx.before_tool_invocation = Some(Arc::new(move |tool_name: &str| {
        hook_seen.lock().unwrap().push(tool_name.to_owned());
        if hook_locked.load(Ordering::SeqCst) {
            Err(TASK_LOCK_ERROR.to_owned())
        } else {
            Ok(())
        }
    }));
    TaskLock { locked, seen }
}

/// Approves every file change, but first takes the task-mutation lock,
/// simulating a concurrent `createTask` while the prompt was pending.
struct LockingApprover {
    locked: Arc<AtomicBool>,
    calls: AtomicUsize,
}

#[async_trait]
impl ApprovalHandler for LockingApprover {
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
        self.locked.store(true, Ordering::SeqCst);
        Ok(true)
    }
}

async fn run_tool(
    ctx: &ToolExecutionContext,
    tool: &'static str,
    args: Value,
) -> Result<ToolOutput, String> {
    let tools = create_builtin_tools(ctx);
    tools[tool]
        .execute(serde_json::from_value(args).unwrap(), ctx)
        .await
        .map_err(|e| e.to_string())
}

fn assert_task_lock_error(tool: &str, res: Result<ToolOutput, String>) {
    match res {
        Err(err) => assert_eq!(err, TASK_LOCK_ERROR),
        Ok(out) => panic!("expected the task-mutation lock to stop {tool}, got {out:?}"),
    }
}

fn staging_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".cowork-stage-"))
        .collect()
}

fn mutation_args(tool: &str, target: &Path) -> Value {
    match tool {
        "write" => json!({ "filePath": target.to_string_lossy(), "content": "replaced" }),
        "edit" => json!({
            "filePath": target.to_string_lossy(),
            "oldString": "original",
            "newString": "replaced",
        }),
        _ => unreachable!("{tool}"),
    }
}

#[tokio::test]
async fn task_lock_taken_during_approval_blocks_write_and_edit() {
    for tool in ["write", "edit"] {
        let tmp = tempfile::tempdir().unwrap();
        let (ws, mut ctx) = ctx_for(tmp.path());
        let target = ws.join("target.txt");
        fs::write(&target, "original").unwrap();
        let lock = install_task_lock(&mut ctx);
        let approver = Arc::new(LockingApprover {
            locked: Arc::clone(&lock.locked),
            calls: AtomicUsize::new(0),
        });
        ctx.approval_handler = Some(approver.clone());

        assert_task_lock_error(
            tool,
            run_tool(&ctx, tool, mutation_args(tool, &target)).await,
        );
        assert_eq!(approver.calls.load(Ordering::SeqCst), 1, "{tool}");
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "original",
            "locked chat must not {tool} after approval"
        );
        assert!(staging_files(&ws).is_empty(), "{tool}");
        let seen = lock.seen();
        assert!(seen.len() >= 2, "{tool}: {seen:?}");
        assert!(seen.iter().all(|name| name == tool), "{tool}: {seen:?}");
    }
}

#[tokio::test]
async fn task_lock_taken_during_approval_blocks_new_file_creation() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());
    let lock = install_task_lock(&mut ctx);
    ctx.approval_handler = Some(Arc::new(LockingApprover {
        locked: Arc::clone(&lock.locked),
        calls: AtomicUsize::new(0),
    }));
    let target = ws.join("nested").join("new.txt");

    assert_task_lock_error(
        "write",
        run_tool(&ctx, "write", mutation_args("write", &target)).await,
    );
    assert!(!target.exists(), "locked chat must not create the file");
    assert!(
        !ws.join("nested").exists(),
        "locked chat must not create parent directories"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_lock_taken_while_waiting_for_file_lock_blocks_write_and_edit() {
    for tool in ["write", "edit"] {
        let tmp = tempfile::tempdir().unwrap();
        let (ws, mut ctx) = ctx_for(tmp.path());
        let target = ws.join("locked.txt");
        fs::write(&target, "original").unwrap();
        let lock = install_task_lock(&mut ctx);

        // Another session (standing in for a second process) owns the file lock.
        fs::create_dir_all(&ctx.lock_root).unwrap();
        let (locked_tx, locked_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder_target = target.clone();
        let holder_lock_root = ctx.lock_root.clone();
        let holder = std::thread::spawn(move || {
            with_file_lock_sync::<(), cowork_config::ConfigError, _>(
                &holder_target,
                || {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                },
                FileLockOptions {
                    lock_root: Some(holder_lock_root),
                    ..Default::default()
                },
            )
            .unwrap();
        });
        locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        let mutate_ctx = ctx.clone();
        let args = mutation_args(tool, &target);
        let mutation = tokio::spawn(async move { run_tool(&mutate_ctx, tool, args).await });

        // The mutation is queued behind the held file lock.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !mutation.is_finished(),
            "{tool} must wait for the held lock"
        );

        // `createTask` locks the chat, then the other session releases the file.
        lock.take();
        release_tx.send(()).unwrap();
        holder.join().unwrap();

        let result = tokio::time::timeout(Duration::from_secs(10), mutation)
            .await
            .expect("locked mutation must return")
            .unwrap();
        assert_task_lock_error(tool, result);
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "original",
            "locked chat must not {tool} after the file lock wait"
        );
        assert!(staging_files(&ws).is_empty(), "{tool}");
    }
}

#[tokio::test]
async fn task_lock_taken_while_staging_blocks_publish() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());
    let target = ws.join("staged.txt");
    fs::write(&target, "original").unwrap();
    let lock = install_task_lock(&mut ctx);
    let locked = Arc::clone(&lock.locked);

    // The lock is taken after the file lock was acquired and the new contents
    // computed, i.e. while the replacement is being staged.
    let result = with_file_mutation(&target, &ctx, "edit", move |snapshot| {
        assert_eq!(snapshot.bytes.as_deref(), Some(&b"original"[..]));
        locked.store(true, Ordering::SeqCst);
        Ok((b"replaced".to_vec(), ()))
    })
    .await;

    let err = result.expect_err("locked mutation must fail");
    assert_eq!(err.to_string(), TASK_LOCK_ERROR);
    assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    assert!(staging_files(&ws).is_empty());
    assert!(lock.seen().iter().all(|name| name == "edit"));
}

#[tokio::test]
async fn unlocked_mutation_checks_the_hook_and_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());
    let target = ws.join("ok.txt");
    fs::write(&target, "original").unwrap();
    let lock = install_task_lock(&mut ctx);

    run_tool(&ctx, "edit", mutation_args("edit", &target))
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "replaced");
    // Before the approval gate, after it, after the file lock and before publish.
    assert_eq!(lock.seen(), vec!["edit"; 4]);
}
