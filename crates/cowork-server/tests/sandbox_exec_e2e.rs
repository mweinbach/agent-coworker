#![cfg(target_os = "macos")]

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    SandboxDenialCategory, SandboxErrorCode, SandboxExecutionResult, SandboxPolicy, SandboxType,
};

fn canonical_private_tmp_dir(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create /private/tmp dir");
    let canon = canonicalize_sync(dir.path());
    (dir, canon)
}

#[test]
fn cowork_server_sandbox_exec_enforces_seatbelt_strips_secrets_and_classifies_denials() {
    let bin = env!("CARGO_BIN_EXE_cowork-server");
    let (_tmp, root) = canonical_private_tmp_dir("cowork-srv-sbx-");
    let iso_home = root.join("home");
    let ws = root.join("ws");
    let outside = root.join("outside");
    std::fs::create_dir_all(&iso_home).unwrap();
    std::fs::create_dir_all(ws.join("src")).unwrap();
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::create_dir_all(ws.join(".cowork")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    // 1. Allowed workspace write + secret/parent-managed env stripping.
    let ok_out = Command::new(bin)
        .args([
            "__sandbox-exec",
            "--json-result",
            "--cwd",
            &ws.to_string_lossy(),
            "--mode",
            "workspace-write",
            "--no-network",
            "--",
            "/bin/bash",
            "-c",
            "printf 'parent=%s;secret=%s' \"${COWORK_DESKTOP_PARENT_MANAGED:-unset}\" \"${OPENAI_API_KEY:-unset}\" > src/env_check.txt",
        ])
        .env("HOME", &iso_home)
        .env("COWORK_HOME_OVERRIDE", &iso_home)
        .env("COWORK_DESKTOP_PARENT_MANAGED", "1")
        .env("OPENAI_API_KEY", "sk-top-secret-never-leak")
        .output()
        .expect("spawn cowork-server __sandbox-exec");

    assert_eq!(
        ok_out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&ok_out.stderr)
    );
    let ok_json: SandboxExecutionResult =
        serde_json::from_slice(&ok_out.stdout).expect("parse SandboxExecutionResult");
    assert_eq!(ok_json.sandbox, SandboxType::Seatbelt);
    assert!(!ok_json.unsandboxed);
    assert_eq!(ok_json.denial, None);
    assert_eq!(
        std::fs::read_to_string(ws.join("src").join("env_check.txt")).unwrap(),
        "parent=unset;secret=unset"
    );

    // 2. Blocked `.git` write -> classified as `Filesystem` (`ProtectedMetadata`) with escalation plan.
    let git_out = Command::new(bin)
        .args([
            "__sandbox-exec",
            "--json-result",
            "--cwd",
            &ws.to_string_lossy(),
            "--mode",
            "workspace-write",
            "--no-network",
            "--",
            "/bin/bash",
            "-c",
            "echo pwn > .git/config",
        ])
        .env("HOME", &iso_home)
        .env("COWORK_HOME_OVERRIDE", &iso_home)
        .output()
        .expect("spawn git write check");

    assert_ne!(git_out.status.code(), Some(0));
    let git_json: SandboxExecutionResult = serde_json::from_slice(&git_out.stdout).unwrap();
    assert_eq!(
        git_json.denial.as_ref().map(|d| d.category),
        Some(SandboxDenialCategory::Filesystem)
    );
    assert_eq!(
        git_json.escalation.as_ref().map(|e| &e.retry_policy),
        Some(&SandboxPolicy::DangerFullAccess {
            network: Some(false)
        })
    );
    assert!(!ws.join(".git").join("config").exists());

    // 3. Blocked loopback TCP connection under `--no-network` -> classified as `Network`!
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let net_out = Command::new(bin)
        .args([
            "__sandbox-exec",
            "--json-result",
            "--cwd",
            &ws.to_string_lossy(),
            "--mode",
            "workspace-write",
            "--no-network",
            "--",
            "/bin/bash",
            "-c",
            &format!("/usr/bin/curl -sS --connect-timeout 2 http://127.0.0.1:{port}/ || /usr/bin/nc -v -z -G 2 127.0.0.1 {port}"),
        ])
        .env("HOME", &iso_home)
        .env("COWORK_HOME_OVERRIDE", &iso_home)
        .output()
        .expect("spawn network denial check");

    assert_ne!(net_out.status.code(), Some(0));
    let net_json: SandboxExecutionResult = serde_json::from_slice(&net_out.stdout).unwrap();
    assert_eq!(
        net_json.denial.as_ref().map(|d| d.category),
        Some(SandboxDenialCategory::Network),
        "expected Network denial on blocked loopback connect, got: {net_json:?}"
    );
    assert_eq!(
        net_json.escalation.as_ref().map(|e| &e.retry_policy),
        Some(&SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![ws.clone()],
            writable_root_kinds: Default::default(),
            network: true,
        })
    );

    // 4. Hard floor: `--yolo --no-network` STILL blocks loopback TCP!
    let yolo_net_out = Command::new(bin)
        .args([
            "__sandbox-exec",
            "--cwd",
            &ws.to_string_lossy(),
            "--yolo",
            "--no-network",
            "--",
            "/usr/bin/nc",
            "-z",
            "-G",
            "2",
            "127.0.0.1",
            &port.to_string(),
        ])
        .env("HOME", &iso_home)
        .env("COWORK_HOME_OVERRIDE", &iso_home)
        .output()
        .expect("spawn yolo --no-network check");
    assert_ne!(
        yolo_net_out.status.code(),
        Some(0),
        "--yolo must preserve explicit --no-network hard floor"
    );
    drop(listener);

    // 5. False-positive immunity: unsandboxed `--yolo` script printing `"Operation not permitted"`
    //    MUST NOT trigger `denial` or `escalation`!
    let fp_out = Command::new(bin)
        .args([
            "__sandbox-exec",
            "--json-result",
            "--cwd",
            &ws.to_string_lossy(),
            "--yolo",
            "--",
            "/bin/bash",
            "-c",
            "echo 'user script: Operation not permitted' >&2; exit 1",
        ])
        .env("HOME", &iso_home)
        .env("COWORK_HOME_OVERRIDE", &iso_home)
        .output()
        .expect("spawn unsandboxed false-positive check");
    assert_eq!(fp_out.status.code(), Some(1));
    let fp_json: SandboxExecutionResult = serde_json::from_slice(&fp_out.stdout).unwrap();
    assert!(fp_json.unsandboxed);
    assert_eq!(fp_json.denial, None);
    assert_eq!(fp_json.escalation, None);

    // 6. Dedicated process-group reaping on `--timeout-ms`: grandchild `sleep 30` is killed cleanly!
    let pid_file = ws.join("src").join("grandchild.pid");
    let timeout_out = Command::new(bin)
        .args([
            "__sandbox-exec",
            "--json-result",
            "--cwd",
            &ws.to_string_lossy(),
            "--timeout-ms",
            "250",
            "--",
            "/bin/bash",
            "-c",
            &format!(
                "/bin/sleep 30 & GPID=$!; printf '%s' \"$GPID\" > '{}'; wait",
                pid_file.display()
            ),
        ])
        .env("HOME", &iso_home)
        .env("COWORK_HOME_OVERRIDE", &iso_home)
        .output()
        .expect("spawn timeout reaping check");

    assert_eq!(timeout_out.status.code(), Some(124));
    let timeout_json: SandboxExecutionResult = serde_json::from_slice(&timeout_out.stdout).unwrap();
    assert_eq!(timeout_json.error_code, Some(SandboxErrorCode::Timeout));

    if let Ok(raw_pid) = std::fs::read_to_string(&pid_file)
        && let Ok(gpid) = raw_pid.trim().parse::<i32>()
    {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut alive = true;
        while Instant::now() < deadline {
            // SAFETY: `kill(pid, 0)` probes process existence without sending a signal.
            let rc = unsafe { libc::kill(gpid, 0) };
            if rc != 0 {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !alive,
            "grandchild PID {gpid} survived process-group timeout reaping!"
        );
    }
}
