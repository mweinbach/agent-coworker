//! `WorktreeService` ref/branch hardening (TS `WorktreeService.ts`): `assertSafeRef`,
//! `validateBranchName` (`git check-ref-format --branch`), `resolveCommit`
//! (`rev-parse --verify <ref>^{commit}`), the managed-path check and the per-git-call timeout.
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::time::{Duration, Instant};

use cowork_tools::{WorktreeCreateOptions, WorktreeService};

struct Repo {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    cowork_home: PathBuf,
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = StdCommand::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn repo() -> Repo {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    fs::write(repo.join("README.md"), "# r\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    git(&repo, &["branch", "-M", "main"]);
    let cowork_home = root.join("cowork-home");
    Repo {
        _tmp: tmp,
        root,
        repo,
        cowork_home,
    }
}

fn service(r: &Repo) -> WorktreeService {
    WorktreeService::with_cowork_home(r.cowork_home.clone(), HashMap::new())
}

fn opts(r: &Repo, base_ref: Option<&str>, branch: Option<&str>) -> WorktreeCreateOptions {
    WorktreeCreateOptions {
        source_cwd: r.repo.clone(),
        base_ref: base_ref.map(str::to_owned),
        branch_name: branch.map(str::to_owned),
        title_hint: Some("Ref test".to_owned()),
    }
}

fn branches(r: &Repo) -> String {
    git(&r.repo, &["branch", "--list"])
}

fn worktree_count(r: &Repo) -> usize {
    git(&r.repo, &["worktree", "list", "--porcelain"])
        .lines()
        .filter(|l| l.starts_with("worktree "))
        .count()
}

#[tokio::test]
async fn option_injection_through_base_ref_is_rejected() {
    let r = repo();
    let svc = service(&r);
    for (bad, expected) in [
        ("--force", "Worktree ref must not start with '-'"),
        ("--lock", "Worktree ref must not start with '-'"),
        ("  -b", "Worktree ref must not start with '-'"),
        ("main\n--force", "Worktree ref contains control characters"),
        ("ma\tin", "Worktree ref contains control characters"),
        ("main\u{7f}", "Worktree ref contains control characters"),
        ("", "Worktree ref must be non-empty"),
        ("   ", "Worktree ref must be non-empty"),
    ] {
        let err = svc
            .create_worktree(opts(&r, Some(bad), Some("feat/ok")))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), expected, "base_ref {bad:?}");
    }
    assert_eq!(worktree_count(&r), 1, "no worktree may be created");
    assert!(!branches(&r).contains("feat/ok"));
}

#[tokio::test]
async fn base_ref_must_resolve_to_a_commit() {
    let r = repo();
    let svc = service(&r);
    let err = svc
        .create_worktree(opts(&r, Some("does-not-exist"), None))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.starts_with("git rev-parse --verify does-not-exist^{commit} failed"),
        "{err}"
    );
    // A tree object is not a commit.
    let tree = git(&r.repo, &["rev-parse", "HEAD^{tree}"]);
    let err = svc
        .create_worktree(opts(&r, Some(&tree), None))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.starts_with("git rev-parse --verify"), "{err}");
    assert_eq!(worktree_count(&r), 1);
}

#[tokio::test]
async fn option_injection_and_invalid_names_through_branch_name_are_rejected() {
    let r = repo();
    let svc = service(&r);
    for bad in ["--force", "-b", "x\ny", "x\u{1}y"] {
        let err = svc
            .create_worktree(opts(&r, None, Some(bad)))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("Worktree ref "), "{bad:?}: {err}");
    }
    for bad in [
        "bad..name",
        "has space",
        "ends.lock",
        "trailing/",
        "a~b",
        "a^b",
        "a:b",
    ] {
        let err = svc
            .create_worktree(opts(&r, None, Some(bad)))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with(&format!("git check-ref-format --branch {bad} failed")),
            "{bad:?}: {err}"
        );
    }
    assert_eq!(worktree_count(&r), 1);
}

#[tokio::test]
async fn valid_refs_and_branch_names_create_worktrees() {
    let r = repo();
    let svc = service(&r);
    let head = git(&r.repo, &["rev-parse", "HEAD"]);
    git(&r.repo, &["tag", "v1"]);

    let cases: [(Option<&str>, Option<&str>, &str); 4] = [
        (None, Some("feat/one"), "HEAD"),
        (Some(" main "), Some(" feat/two "), "main"),
        (Some("v1"), Some("feat/three"), "v1"),
        (Some(&head[..12]), None, &head[..12]),
    ];
    for (base_ref, branch, expected_ref) in cases {
        let wt = svc
            .create_worktree(opts(&r, base_ref, branch))
            .await
            .unwrap_or_else(|e| panic!("{base_ref:?}/{branch:?}: {e}"));
        assert_eq!(wt.base_ref, expected_ref);
        assert_eq!(wt.base_commit, head);
        if let Some(b) = branch {
            assert_eq!(wt.branch_name, b.trim());
        } else {
            assert!(wt.branch_name.starts_with("cowork/ref-test-"));
        }
        assert!(
            wt.path
                .starts_with(fs::canonicalize(svc.worktrees_root()).unwrap())
        );
        assert_eq!(git(&wt.path, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            git(&wt.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            wt.branch_name
        );
    }
    assert_eq!(worktree_count(&r), 5);

    #[cfg(target_os = "linux")]
    {
        let mode = fs::metadata(svc.worktrees_root())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// True once `pid` is gone (or only a zombie awaiting a reaper).
fn process_gone(pid: i32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

fn wait_gone(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if process_gone(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn read_pid(path: &Path) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = fs::read_to_string(path)
            && let Ok(pid) = s.trim().parse()
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "pid file never written");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test]
async fn hanging_git_times_out_and_its_process_group_is_killed() {
    let r = repo();
    let bin = r.root.join("fake-bin");
    fs::create_dir_all(&bin).unwrap();
    let pid_file = r.root.join("sleep.pid");
    write_script(
        &bin.join("git"),
        "#!/bin/sh\nsleep 30 &\necho $! > \"$FAKE_GIT_PID_FILE\"\nwait\n",
    );
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_owned())
    );
    let env = HashMap::from([
        ("PATH".to_owned(), path),
        (
            "FAKE_GIT_PID_FILE".to_owned(),
            pid_file.to_string_lossy().into_owned(),
        ),
    ]);
    let svc = WorktreeService::with_cowork_home(r.cowork_home.clone(), env)
        .with_git_timeout(Duration::from_millis(500));

    let started = Instant::now();
    let err = svc
        .create_worktree(opts(&r, None, None))
        .await
        .unwrap_err()
        .to_string();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(
        err,
        "git rev-parse --show-toplevel failed: timed out after 500ms"
    );
    let pid = read_pid(&pid_file);
    assert!(wait_gone(pid), "hook grandchild {pid} must be killed");
}

#[tokio::test]
async fn hanging_checkout_hook_times_out_worktree_add() {
    let r = repo();
    let pid_file = r.root.join("hook.pid");
    let hooks = r.repo.join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    write_script(
        &hooks.join("post-checkout"),
        &format!(
            "#!/bin/sh\nsleep 30 &\necho $! > '{}'\nwait\n",
            pid_file.display()
        ),
    );
    let svc = service(&r).with_git_timeout(Duration::from_millis(2_000));

    let started = Instant::now();
    let err = svc
        .create_worktree(opts(&r, None, Some("feat/hook")))
        .await
        .unwrap_err()
        .to_string();
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(
        err.starts_with("git worktree add -b feat/hook ")
            && err.ends_with("timed out after 2000ms"),
        "{err}"
    );
    let pid = read_pid(&pid_file);
    assert!(wait_gone(pid), "hook process {pid} must be killed");
}
