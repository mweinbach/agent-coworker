//! Regression: `bash` must run under the sandbox policy the server already resolved for the turn
//! (`ctx.sandbox_policy`, TS `ctx.sandboxPolicy`) instead of re-resolving a policy from
//! `sandbox_config`, which widened `no-project-write` to `workspace-write`, demoted `read-only`
//! to the `no-project-write` temp-scratch floor, and dropped a resolved `network: false`.
#![cfg(target_os = "linux")]

use std::fs;
use std::path::PathBuf;

use cowork_config::ProviderName;
use cowork_sandbox::SandboxPolicy;
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::{Value, json};
use uuid::Uuid;

// Sandboxed commands re-exec this test binary as the seccomp helper.
cowork_sandbox::install_sandbox_exec_test_hook!();

fn bwrap_available() -> bool {
    std::process::Command::new("bwrap")
        .args(["--ro-bind", "/", "/", "true"])
        .status()
        .is_ok_and(|s| s.success())
}

/// Workspace outside `/tmp` so the `no-project-write` floor's `/tmp` scratch is not suppressed
/// by a project root nested inside it.
fn ctx(prefix: &str) -> (PathBuf, ToolExecutionContext) {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("cowork-tools-{prefix}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let ctx = ToolExecutionContext::new_for_tests(
        fs::canonicalize(home).unwrap(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    (ws, ctx)
}

async fn run_bash(ctx: &ToolExecutionContext, command: &str) -> Value {
    create_builtin_tools(ctx)["bash"]
        .execute(
            serde_json::from_value(json!({ "command": command })).unwrap(),
            ctx,
        )
        .await
        .unwrap()
        .to_json_value()
}

#[tokio::test]
async fn bash_keeps_resolved_no_project_write_policy() {
    if !bwrap_available() {
        eprintln!("skipping: bwrap unavailable");
        return;
    }
    let (ws, mut ctx) = ctx("bash-npw");
    // Explicit `no-project-write` shell policy on a non-read-only role with the default
    // (`auto`) sandbox config: re-resolving would yield `workspace-write`.
    ctx.sandbox_policy = SandboxPolicy::NoProjectWrite {
        project_roots: vec![ws.clone()],
        network: true,
    };
    let out = run_bash(&ctx, "printf blocked > project-file.txt").await;
    assert_ne!(out["exitCode"], json!(0), "{out}");
    assert!(!ws.join("project-file.txt").exists(), "{out}");
    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn bash_keeps_resolved_read_only_policy_without_temp_scratch() {
    if !bwrap_available() {
        eprintln!("skipping: bwrap unavailable");
        return;
    }
    let (ws, mut ctx) = ctx("bash-ro");
    // `read-only` resolved (e.g. persisted session policy) while `sandbox_config.mode` is `auto`:
    // re-resolving with `read_only_role` would hit the `no-project-write` floor and grant `/tmp`.
    ctx.sandbox_policy = SandboxPolicy::ReadOnly { network: true };
    let probe = PathBuf::from("/tmp").join(format!("cowork-bash-ro-probe-{}", Uuid::new_v4()));
    let out = run_bash(&ctx, &format!("printf leaked > '{}'", probe.display())).await;
    let leaked = probe.exists();
    let _ = fs::remove_file(&probe);
    assert!(!leaked, "read-only bash wrote temp scratch: {out}");
    assert_ne!(out["exitCode"], json!(0), "{out}");
    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn bash_keeps_resolved_network_off() {
    if !bwrap_available() {
        eprintln!("skipping: bwrap unavailable");
        return;
    }
    let host_ifaces = fs::read_to_string("/proc/net/dev").unwrap_or_default();
    if !host_ifaces
        .lines()
        .skip(2)
        .any(|l| !l.trim().starts_with("lo:"))
    {
        eprintln!("skipping: host has no non-loopback interface to observe");
        return;
    }
    let (ws, mut ctx) = ctx("bash-net");
    assert!(ctx.sandbox_config.network, "default config allows network");
    ctx.sandbox_policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: Default::default(),
        network: false,
    };
    let out = run_bash(&ctx, "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '").await;
    assert_eq!(out["exitCode"], json!(0), "{out}");
    let ifaces: Vec<&str> = out["stdout"]
        .as_str()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    assert_eq!(ifaces, vec!["lo"], "bash regained network: {out}");
    let _ = fs::remove_dir_all(ws.parent().unwrap());
}
