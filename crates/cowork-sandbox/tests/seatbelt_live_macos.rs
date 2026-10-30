#![cfg(target_os = "macos")]

use std::net::TcpListener;
use std::path::PathBuf;

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxCommand, SandboxConfig, SandboxConfigMode,
    SandboxDenialCategory, SandboxExecutionRequest, SandboxPolicy, SandboxRunner, SandboxType,
    has_seatbelt, resolve_sandbox_policy,
};

fn canonical_private_tmp_dir(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create /private/tmp dir");
    let canon = canonicalize_sync(dir.path());
    assert!(
        canon.starts_with("/private/tmp/"),
        "expected canonical /private/tmp path, got {canon:?}"
    );
    (dir, canon)
}

#[tokio::test]
async fn live_macos_seatbelt_enforces_workspace_git_cowork_target_paths_and_network() {
    assert!(
        has_seatbelt(),
        "Apple /usr/bin/sandbox-exec must verify cleanly on macOS host"
    );

    let (_tmp, root) = canonical_private_tmp_dir("cowork-seatbelt-live-");
    let ws = root.join("ws");
    let outside = root.join("outside");
    std::fs::create_dir_all(ws.join("src")).unwrap();
    std::fs::create_dir_all(ws.join("other")).unwrap();
    std::fs::create_dir_all(ws.join(".git").join("hooks")).unwrap();
    std::fs::create_dir_all(ws.join(".cowork")).unwrap();
    std::fs::create_dir_all(ws.join("nested").join(".git")).unwrap();
    std::fs::create_dir_all(ws.join("nested").join(".CoWoRk")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, ws.join("escape")).unwrap();

    let runner = SandboxRunner::default();
    let policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: Default::default(),
        network: false,
    };

    // 1. Writes inside workspace succeed (and disposable scratch dir inside workspace works).
    let mut ok_req = SandboxExecutionRequest::new(
        SandboxCommand::new(
            "/bin/bash",
            [
                "-c",
                "echo ok > src/allowed.txt && TMPF=$(mktemp \"$TMPDIR/sbx.XXXXXX\") && echo scratch > \"$TMPF\" && rm -f \"$TMPF\"",
            ],
        ),
        policy.clone(),
        &ws,
    );
    ok_req.extra_env.insert(
        "TMPDIR".to_owned(),
        ws.join("src").to_string_lossy().into_owned(),
    );
    let ok_res = runner
        .run_with_approval(
            ok_req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await;
    assert_eq!(ok_res.exit_code, 0, "stderr: {}", ok_res.stderr);
    assert_eq!(ok_res.sandbox, SandboxType::Seatbelt);
    assert_eq!(
        std::fs::read_to_string(ws.join("src").join("allowed.txt")).unwrap(),
        "ok\n"
    );

    // 2. Writes outside workspace (`/private/tmp/.../outside`), via symlink escape, or into
    //    direct/nested `.git` and `.cowork` (including `.CoWoRk`) are kernel-blocked!
    for blocked_target in [
        outside.join("pwned.txt"),
        ws.join("escape").join("pwned.txt"),
        ws.join(".git").join("hooks").join("pre-commit"),
        ws.join(".cowork").join("config.json"),
        ws.join("nested").join(".git").join("config"),
        ws.join("nested").join(".CoWoRk").join("secret.json"),
    ] {
        let script = format!("echo blocked > '{}'", blocked_target.display());
        let req = SandboxExecutionRequest::new(
            SandboxCommand::new("/bin/bash", ["-c", &script]),
            policy.clone(),
            &ws,
        );
        let res = runner
            .run_with_approval(
                req,
                None,
                None::<fn(Option<&str>) -> std::future::Ready<bool>>,
            )
            .await;
        assert_ne!(
            res.exit_code,
            0,
            "expected Seatbelt to block {}",
            blocked_target.display()
        );
        assert!(
            !blocked_target.exists(),
            "Seatbelt allowed forbidden file creation at {}",
            blocked_target.display()
        );
        assert_eq!(
            res.denial.as_ref().map(|d| d.category),
            Some(SandboxDenialCategory::Filesystem)
        );
    }

    // 3. Scoped child `targetPaths` hard floor under `--yolo` allows `src` and blocks `other`!
    let mut child_input = ResolveSandboxPolicyInput::new(&ws);
    child_input.target_paths = Some(vec!["src".to_owned()]);
    child_input.yolo = true;
    let child_policy = resolve_sandbox_policy(&child_input);

    let mut child_blocked_req = SandboxExecutionRequest::new(
        SandboxCommand::new("/bin/bash", ["-c", "echo nope > other/forbidden.txt"]),
        child_policy,
        &ws,
    );
    child_blocked_req.yolo = true;
    child_blocked_req.has_scoped_target_paths = true;
    let child_blocked_res = runner
        .run_with_approval(
            child_blocked_req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await;
    assert_ne!(child_blocked_res.exit_code, 0);
    assert!(!ws.join("other").join("forbidden.txt").exists());
    // Scoped child MUST NEVER offer approval escalation!
    assert_eq!(child_blocked_res.escalation, None);

    // 4. `network: false` kernel-blocks loopback TCP connection to a live local listener!
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
    let port = listener.local_addr().unwrap().port();
    let net_script = format!("/usr/bin/nc -z -G 2 127.0.0.1 {port}");
    let net_req = SandboxExecutionRequest::new(
        SandboxCommand::new("/bin/bash", ["-c", &net_script]),
        policy,
        &ws,
    );
    let net_res = runner
        .run_with_approval(
            net_req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await;
    assert_ne!(
        net_res.exit_code, 0,
        "Seatbelt must block loopback TCP under network: false"
    );
    drop(listener);

    // 5. `read-only` hard floor blocks even `/private/tmp` writes under `--yolo`.
    let mut ro_input = ResolveSandboxPolicyInput::new(&ws);
    ro_input.config = Some(SandboxConfig {
        mode: SandboxConfigMode::ReadOnly,
        network: false,
        require_backend: true,
    });
    ro_input.yolo = true;
    let ro_policy = resolve_sandbox_policy(&ro_input);
    let ro_probe_file = root.join("ro-blocked.txt");
    let mut ro_req = SandboxExecutionRequest::new(
        SandboxCommand::new(
            "/bin/bash",
            ["-c", &format!("echo nope > '{}'", ro_probe_file.display())],
        ),
        ro_policy,
        &ws,
    );
    ro_req.yolo = true;
    let ro_res = runner
        .run_with_approval(
            ro_req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await;
    assert_ne!(ro_res.exit_code, 0);
    assert!(!ro_probe_file.exists());
    assert_eq!(ro_res.escalation, None);
}
