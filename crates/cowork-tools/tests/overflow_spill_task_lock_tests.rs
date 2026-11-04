//! Regression: an oversized tool result checks the task-mutation lock (`before_tool_invocation`,
//! TS `assertCanMutate("toolOutputOverflow")`) at the spill boundary. Ordinary tool batches
//! execute every call before finalizing results, so a `createTask` later in the batch can lock
//! the source chat before an earlier oversized `grep` spills; the spill must then not create
//! directories or write in the locked workspace, and falls back to an inline truncated preview.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cowork_config::ProviderName;
use cowork_sandbox::SandboxPolicy;
use cowork_tools::{
    DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS, TOOL_OUTPUT_PREVIEW_CHARS, ToolExecutionContext,
    ToolOutput, maybe_spill_tool_output,
};
use uuid::Uuid;

const TASK_LOCK_ERROR: &str = "This chat is locked while a task runs from it.";

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

fn writable_ctx(tag: &str) -> (PathBuf, ToolExecutionContext) {
    let base = test_temp_base().join(format!("cowork-spill-lock-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let mut ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    ctx.sandbox_policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: Default::default(),
        network: true,
    };
    (ws, ctx)
}

/// Installs a lock hook that starts denying from the `lock_from`-th check (0-based) onward and
/// records the tool names it was asked about.
fn install_lock(ctx: &mut ToolExecutionContext, lock_from: usize) -> Arc<Mutex<Vec<String>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let hook_seen = Arc::clone(&seen);
    ctx.before_tool_invocation = Some(Arc::new(move |tool_name: &str| {
        hook_seen.lock().unwrap().push(tool_name.to_owned());
        if calls.fetch_add(1, Ordering::SeqCst) >= lock_from {
            Err(TASK_LOCK_ERROR.to_owned())
        } else {
            Ok(())
        }
    }));
    seen
}

fn big_output() -> String {
    let big = "grep-match-line-0123456789\n".repeat(1500);
    assert!(big.chars().count() > DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);
    big
}

fn assert_inline_truncated(out: &serde_json::Value, big: &str) {
    assert_eq!(out["overflow"], true, "{out}");
    assert_eq!(out["spilledToDisk"], false, "{out}");
    assert!(out.get("filePath").is_none(), "no spill file path: {out}");
    assert_eq!(out["tool"], "grep");
    assert_eq!(out["totalChars"], big.chars().count());
    assert_eq!(
        out["preview"].as_str().unwrap().chars().count(),
        TOOL_OUTPUT_PREVIEW_CHARS
    );
    let hint = out["hint"].as_str().unwrap();
    assert!(hint.contains("locked for task mutation"), "{hint}");
    assert!(hint.contains(TASK_LOCK_ERROR), "{hint}");
}

fn cleanup(ws: &Path) {
    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[test]
fn held_task_lock_blocks_spill_before_any_directory_is_created() {
    let (ws, mut ctx) = writable_ctx("held");
    let seen = install_lock(&mut ctx, 0);
    let big = big_output();

    let out = maybe_spill_tool_output(
        "grep",
        "call-grep-locked",
        ToolOutput::Text(big.clone()),
        &ctx,
        Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
    )
    .unwrap()
    .to_json_value();

    assert_inline_truncated(&out, &big);
    assert!(
        !ws.join(".cowork").exists(),
        "no directory may be created in the locked workspace"
    );
    assert_eq!(*seen.lock().unwrap(), vec!["toolOutputOverflow".to_owned()]);
    cleanup(&ws);
}

#[test]
fn lock_taken_after_directories_exist_blocks_write_and_removes_created_dirs() {
    let (ws, mut ctx) = writable_ctx("midway");
    // First check (before mkdir) passes; the re-check before writing sees the lock.
    let seen = install_lock(&mut ctx, 1);
    let big = big_output();

    let out = maybe_spill_tool_output(
        "grep",
        "call-grep-midway",
        ToolOutput::Text(big.clone()),
        &ctx,
        Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
    )
    .unwrap()
    .to_json_value();

    assert_inline_truncated(&out, &big);
    assert!(
        !ws.join(".cowork").exists(),
        "directories this spill created are removed once the lock is seen"
    );
    assert_eq!(
        seen.lock().unwrap().len(),
        2,
        "checked before mkdir and before write"
    );
    cleanup(&ws);
}

#[test]
fn lock_taken_midway_keeps_preexisting_scratchpad_and_writes_nothing() {
    let (ws, mut ctx) = writable_ctx("preexisting");
    let scratch = ws.join(".cowork").join(".cowork-scratchpad");
    fs::create_dir_all(&scratch).unwrap();
    install_lock(&mut ctx, 1);
    let big = big_output();

    let out = maybe_spill_tool_output(
        "grep",
        "call-grep-pre",
        ToolOutput::Text(big.clone()),
        &ctx,
        Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
    )
    .unwrap()
    .to_json_value();

    assert_inline_truncated(&out, &big);
    assert!(scratch.is_dir(), "pre-existing scratchpad is left alone");
    assert_eq!(
        fs::read_dir(&scratch).unwrap().count(),
        0,
        "no spill file is written"
    );
    cleanup(&ws);
}

#[test]
fn unlocked_spill_still_writes_and_consults_the_lock() {
    let (ws, mut ctx) = writable_ctx("unlocked");
    let seen = install_lock(&mut ctx, usize::MAX);
    let big = big_output();

    let out = maybe_spill_tool_output(
        "grep",
        "call-grep-ok",
        ToolOutput::Text(big.clone()),
        &ctx,
        Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
    )
    .unwrap()
    .to_json_value();

    let file_path = PathBuf::from(out["filePath"].as_str().expect("spilled filePath"));
    assert_eq!(fs::read_to_string(&file_path).unwrap(), big);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            "toolOutputOverflow".to_owned(),
            "toolOutputOverflow".to_owned()
        ]
    );
    cleanup(&ws);
}
