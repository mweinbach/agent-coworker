//! Regressions for the shared `write`/`edit` mutation helper:
//! - existing targets that are not regular files (FIFOs) are rejected before
//!   they are opened, so a FIFO with no writer cannot wedge the worker;
//! - a Stop request while waiting for another holder's file lock, or after the
//!   replacement was staged, aborts without modifying the target.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use cowork_config::{FileLockOptions, ProviderName, with_file_lock_sync};
use cowork_tools::{ToolExecutionContext, ToolOutput, create_builtin_tools, with_file_mutation};
use serde_json::{Value, json};
use tokio::sync::watch;

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

/// Runs a mutation tool against a FIFO on its own task so a regression (a
/// blocking read on a worker thread) fails via the timeout instead of hanging.
async fn mutation_err_on_fifo(
    ctx: &ToolExecutionContext,
    tool: &'static str,
    args: Value,
    fifo: &Path,
) -> String {
    let ctx = ctx.clone();
    let task = tokio::spawn(async move { run_tool(&ctx, tool, args).await.map(|_| ()) });
    let Ok(joined) = tokio::time::timeout(Duration::from_secs(5), task).await else {
        // Release the blocked reader so runtime shutdown does not hang, then fail.
        let _ = fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(fifo);
        panic!("{tool} on a FIFO hung instead of erroring");
    };
    joined
        .unwrap()
        .expect_err("mutation of a non-regular file must fail")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn write_and_edit_reject_fifo_without_blocking() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let fifo = ws.join("pipe");
    let status = Command::new("mkfifo").arg(&fifo).status().unwrap();
    assert!(status.success(), "mkfifo failed");

    let write_err = mutation_err_on_fifo(
        &ctx,
        "write",
        json!({ "filePath": fifo.to_string_lossy(), "content": "replaced" }),
        &fifo,
    )
    .await;
    assert!(
        write_err.contains("not a regular file"),
        "unexpected write error: {write_err}"
    );

    let edit_err = mutation_err_on_fifo(
        &ctx,
        "edit",
        json!({
            "filePath": fifo.to_string_lossy(),
            "oldString": "a",
            "newString": "b",
        }),
        &fifo,
    )
    .await;
    assert!(
        edit_err.contains("not a regular file"),
        "unexpected edit error: {edit_err}"
    );

    // The FIFO itself was not replaced by a staged regular file.
    assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
}

fn staging_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".cowork-stage-"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn write_cancelled_while_waiting_for_file_lock_leaves_file_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());
    let target = ws.join("locked.txt");
    fs::write(&target, "original").unwrap();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    ctx.cancel_rx = Some(cancel_rx);

    // Another holder (standing in for a second process) owns the file lock.
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

    let write_ctx = ctx.clone();
    let write_args = json!({ "filePath": target.to_string_lossy(), "content": "replaced" });
    let write = tokio::spawn(async move { run_tool(&write_ctx, "write", write_args).await });

    // The write is queued behind the held lock.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!write.is_finished(), "write must wait for the held lock");

    cancel_tx.send(true).unwrap();
    release_tx.send(()).unwrap();
    holder.join().unwrap();

    let result = tokio::time::timeout(Duration::from_secs(5), write)
        .await
        .expect("cancelled write must return promptly")
        .unwrap();
    let err = result.expect_err("cancelled write must fail");
    assert!(err.contains("cancelled"), "unexpected error: {err}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    assert!(staging_files(&ws).is_empty());
}

#[tokio::test]
async fn mutation_cancelled_before_publish_leaves_file_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());
    let target = ws.join("staged.txt");
    fs::write(&target, "original").unwrap();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    ctx.cancel_rx = Some(cancel_rx);

    // Stop arrives after the lock was acquired and the new contents computed,
    // i.e. while the replacement is being staged.
    let result = with_file_mutation(&target, &ctx, move |snapshot| {
        assert_eq!(snapshot.bytes.as_deref(), Some(&b"original"[..]));
        cancel_tx.send(true).unwrap();
        Ok((b"replaced".to_vec(), ()))
    })
    .await;

    let err = result.expect_err("cancelled mutation must fail");
    assert!(err.to_string().contains("cancelled"), "unexpected: {err}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    assert!(staging_files(&ws).is_empty());
}
