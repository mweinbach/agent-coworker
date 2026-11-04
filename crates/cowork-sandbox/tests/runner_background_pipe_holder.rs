//! A command whose root exits while a background child still holds stdout/stderr must stay
//! bounded by the timeout/cancellation race, and the whole process group must be killed.
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

/// Background script: the root prints, forks a long sleep that inherits both pipes, records its
/// pid, then exits immediately.
fn background_holder_script(pid_file: &Path) -> String {
    format!(
        "echo before-background; sleep 600 & echo $! > '{}'; exit 0",
        pid_file.display()
    )
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
async fn timeout_bounds_background_child_holding_pipes_and_kills_group() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pid_file = tmp.path().join("bg.pid");
    let mut req = unsandboxed_request(&background_holder_script(&pid_file), tmp.path());
    req.timeout = Some(Duration::from_millis(800));

    let started = Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(10), run(req, None))
        .await
        .expect("runner must return within the timeout, not wait on the background pipe holder");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(res.error_code, Some(SandboxErrorCode::Timeout), "{res:?}");
    assert_eq!(res.exit_code, 124, "{res:?}");
    assert!(res.stdout.contains("before-background"), "{res:?}");

    let pid = read_pid(&pid_file);
    assert!(
        wait_until_dead(pid).await,
        "background child {pid} must be killed"
    );
}

#[tokio::test]
async fn cancellation_interrupts_background_child_holding_pipes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pid_file = tmp.path().join("bg.pid");
    let req = unsandboxed_request(&background_holder_script(&pid_file), tmp.path());
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let handle = tokio::spawn(run(req, Some(cancel_rx)));
    // Wait until the root has exited and only the background child holds the pipes.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pid_file.exists()
        || std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .is_empty()
    {
        assert!(Instant::now() < deadline, "background pid never written");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    cancel_tx.send(true).expect("send cancel");

    let res = tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("Stop must interrupt a command whose background child holds the pipes")
        .expect("join");
    assert_eq!(res.error_code, Some(SandboxErrorCode::AbortErr), "{res:?}");
    assert_eq!(res.exit_code, 130, "{res:?}");
    assert!(res.stdout.contains("before-background"), "{res:?}");

    let pid = read_pid(&pid_file);
    assert!(
        wait_until_dead(pid).await,
        "background child {pid} must be killed"
    );
}

#[tokio::test]
async fn normal_exit_returns_promptly_with_full_output() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let script =
        "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; echo err-out >&2; exit 3";
    let mut req = unsandboxed_request(script, tmp.path());
    req.timeout = Some(Duration::from_secs(30));

    let started = Instant::now();
    let res = run(req, None).await;
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(res.error_code, None, "{res:?}");
    assert_eq!(res.exit_code, 3);
    assert_eq!(res.stdout.lines().count(), 2000);
    assert!(res.stdout.ends_with("line-1999\n"));
    assert_eq!(res.stderr, "err-out\n");

    // A detached background child that does not hold the pipes does not delay completion.
    let mut req = unsandboxed_request("sleep 30 >/dev/null 2>&1 & echo done; exit 0", tmp.path());
    req.timeout = Some(Duration::from_secs(20));
    let started = Instant::now();
    let res = run(req, None).await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(res.error_code, None, "{res:?}");
    assert_eq!(res.stdout, "done\n");
}
