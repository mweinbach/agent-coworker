//! Regression: `read` must reject non-regular files (FIFOs, devices) before opening them.
//! Opening a FIFO with no writer blocks forever outside cancellation, so a workspace FIFO
//! (directly or behind a symlink) would wedge the turn.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{OpenOptionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::json;

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

/// Runs the read on its own task so a regression (a blocking open on a worker thread)
/// fails via the timeout instead of hanging the test.
async fn read_err(ctx: &ToolExecutionContext, path: &str, fifo: &Path) -> String {
    let ctx = ctx.clone();
    let owned_path = path.to_owned();
    let task = tokio::spawn(async move {
        let tools = create_builtin_tools(&ctx);
        tools["read"]
            .execute(
                serde_json::from_value(json!({ "filePath": owned_path })).unwrap(),
                &ctx,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    });
    let Ok(joined) = tokio::time::timeout(Duration::from_secs(5), task).await else {
        // Release the blocked reader (a writer-side open now succeeds) so runtime shutdown
        // does not hang, then fail.
        let _ = fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(fifo);
        panic!("read of {path} hung instead of erroring");
    };
    joined
        .unwrap()
        .expect_err("non-regular file read must fail")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_rejects_fifo_without_blocking() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    for name in ["pipe", "pipe.png", "pipe.pdf"] {
        let status = Command::new("mkfifo").arg(ws.join(name)).status().unwrap();
        assert!(status.success(), "mkfifo failed");
        let err = read_err(&ctx, name, &ws.join(name)).await;
        assert!(
            err.contains(&format!("Cannot read {name}: not a regular file.")),
            "{err}"
        );
    }

    symlink(ws.join("pipe"), ws.join("link-to-pipe.txt")).unwrap();
    let err = read_err(&ctx, "link-to-pipe.txt", &ws.join("pipe")).await;
    assert!(err.contains("not a regular file"), "{err}");
}
