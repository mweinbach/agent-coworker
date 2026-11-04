//! TS `proc.run` parity for output overflow and pre-spawn cancellation:
//! - a stream exceeding `max_buffer` terminates the whole process tree and returns exit 1 with
//!   `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, keeping the captured prefix;
//! - an already-cancelled run returns `ABORT_ERR` without spawning anything.
#![cfg(unix)]

use std::path::Path;
use std::time::{Duration, Instant};

use cowork_sandbox::{
    SandboxCommand, SandboxErrorCode, SandboxExecutionRequest, SandboxExecutionResult,
    SandboxPolicy, SandboxRunner,
};
use tokio::sync::watch;

cowork_sandbox::install_sandbox_exec_test_hook!();

fn unsandboxed_request(script: &str, cwd: &Path) -> SandboxExecutionRequest {
    let mut req = SandboxExecutionRequest::new(
        SandboxCommand::new("/bin/sh", ["-c", script]),
        SandboxPolicy::DangerFullAccess { network: None },
        cwd,
    );
    req.yolo = true;
    req
}

async fn run(
    req: SandboxExecutionRequest,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> SandboxExecutionResult {
    SandboxRunner::default()
        .run_with_approval(
            req,
            cancel_rx,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await
}

fn read_pid(pid_file: &Path) -> i32 {
    std::fs::read_to_string(pid_file)
        .expect("pid file written")
        .trim()
        .parse()
        .expect("numeric pid")
}

/// True once `pid` is gone or a zombie awaiting reaping (it was killed).
async fn wait_until_dead(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
        let dead = match stat {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit_once(')')
                .map(|(_, rest)| rest.trim_start().starts_with('Z'))
                .unwrap_or(false),
        };
        if dead {
            return true;
        }
        if cfg!(not(target_os = "linux")) {
            // SAFETY: signal 0 only probes for existence.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn stdout_overflow_kills_tree_quickly_and_returns_maxbuffer_error() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root_pid = tmp.path().join("root.pid");
    let bg_pid = tmp.path().join("bg.pid");
    // The root records its pid and `exec`s `yes` (same pid); a background sleep that inherits the
    // pipes must die with the group too.
    let script = format!(
        "sleep 600 & echo $! > '{}'; echo $$ > '{}'; exec yes",
        bg_pid.display(),
        root_pid.display()
    );
    let mut req = unsandboxed_request(&script, tmp.path());
    req.timeout = Some(Duration::from_secs(300));
    req.max_buffer = 64 * 1024;

    let started = Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(20), run(req, None))
        .await
        .expect("overflow must stop the process instead of running until the timeout");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(
        res.error_code,
        Some(SandboxErrorCode::MaxBufferExceeded),
        "{:?}",
        (&res.exit_code, &res.stderr)
    );
    assert_eq!(res.exit_code, 1);
    assert_eq!(res.stdout.len(), 64 * 1024, "captured prefix is kept");
    assert!(res.stdout.starts_with("y\ny\n"));
    assert!(res.escalation.is_none() && res.denial.is_none());

    for pid_file in [&root_pid, &bg_pid] {
        let pid = read_pid(pid_file);
        assert!(wait_until_dead(pid).await, "process {pid} must be killed");
    }

    let json = serde_json::to_value(&res).expect("serialize");
    assert_eq!(json["errorCode"], "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
}

#[tokio::test]
async fn stderr_overflow_is_capped_independently() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut req = unsandboxed_request("echo out; exec yes >&2", tmp.path());
    req.timeout = Some(Duration::from_secs(300));
    req.max_buffer = 4096;

    let res = tokio::time::timeout(Duration::from_secs(20), run(req, None))
        .await
        .expect("stderr overflow must stop the process");
    assert_eq!(res.error_code, Some(SandboxErrorCode::MaxBufferExceeded));
    assert_eq!(res.exit_code, 1);
    assert_eq!(res.stdout, "out\n");
    assert_eq!(res.stderr.len(), 4096);
}

#[tokio::test]
async fn overflow_wins_even_when_the_root_exits_on_its_own() {
    let tmp = tempfile::tempdir().expect("tempdir");
    // Exactly at the cap is fine (TS overflows only when `total > maxBuffer`).
    let mut req = unsandboxed_request("printf 0123456789", tmp.path());
    req.max_buffer = 10;
    let res = run(req, None).await;
    assert_eq!(res.error_code, None, "{res:?}");
    assert_eq!(res.exit_code, 0);
    assert_eq!(res.stdout, "0123456789");

    // One byte over: the root exits immediately, yet the run still reports the overflow.
    for _ in 0..20 {
        let mut req = unsandboxed_request("printf 0123456789A", tmp.path());
        req.max_buffer = 10;
        let res = run(req, None).await;
        assert_eq!(
            res.error_code,
            Some(SandboxErrorCode::MaxBufferExceeded),
            "{res:?}"
        );
        assert_eq!(res.exit_code, 1);
        assert_eq!(res.stdout, "0123456789");
    }
}

#[tokio::test]
async fn overflow_truncation_drops_a_split_code_point_whole() {
    let tmp = tempfile::tempdir().expect("tempdir");
    // "abc€" is 6 bytes; a 4-byte cap splits the 3-byte euro sign.
    let mut req = unsandboxed_request(r"printf 'abc\342\202\254'", tmp.path());
    req.max_buffer = 4;
    let res = run(req, None).await;
    assert_eq!(res.error_code, Some(SandboxErrorCode::MaxBufferExceeded));
    assert_eq!(res.stdout, "abc", "no U+FFFD for the truncated code point");
}

#[tokio::test]
async fn cancel_before_spawn_returns_abort_without_spawning() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let marker = tmp.path().join("spawned");
    let req = unsandboxed_request(&format!("touch '{}'", marker.display()), tmp.path());
    let (_cancel_tx, cancel_rx) = watch::channel(true);

    let res = run(req, Some(cancel_rx)).await;
    assert_eq!(res.error_code, Some(SandboxErrorCode::AbortErr), "{res:?}");
    assert_eq!(res.exit_code, 130);
    assert_eq!(res.stdout, "");
    assert_eq!(res.stderr, "");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!marker.exists(), "no process may be spawned after cancel");
}

/// The root exits and stdout reaches EOF (its reader is joined), while a background child keeps
/// only stderr open. The timeout branch must not re-poll the already-joined stdout reader.
#[tokio::test]
async fn timeout_after_one_reader_finished_does_not_repoll_it() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pid_file = tmp.path().join("bg.pid");
    let script = format!(
        "echo out; sleep 600 >/dev/null & echo $! > '{}'; exit 0",
        pid_file.display()
    );
    let mut req = unsandboxed_request(&script, tmp.path());
    req.timeout = Some(Duration::from_millis(800));

    let res = tokio::time::timeout(Duration::from_secs(10), run(req, None))
        .await
        .expect("runner must return");
    assert_eq!(res.error_code, Some(SandboxErrorCode::Timeout), "{res:?}");
    assert_eq!(res.exit_code, 124);
    assert_eq!(res.stdout, "out\n");
    let pid = read_pid(&pid_file);
    assert!(
        wait_until_dead(pid).await,
        "background child must be killed"
    );
}
