#![cfg(windows)]

//! Live Windows Microsoft Execution Containers (MXC / PSEC) enforcement integration test.
//!
//! When the host Windows build provides native PSEC (`ProcessContainer`) support, verifies real
//! kernel enforcement across workspace writes, outside write denials, `.git`/`.cowork` write
//! protection (read ok, write denied), credential `denied_paths` protection, `read-only` mode,
//! and `network: false`. When the host build lacks PSEC, verifies fail-closed `SANDBOX_REQUIRED`
//! gating for `require_backend` and hard-floor policies.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    SandboxCommand, SandboxErrorCode, SandboxExecutionRequest, SandboxManager, SandboxPolicy,
    SandboxRunner, SandboxType,
};

fn ps_command(script: &str) -> SandboxCommand {
    SandboxCommand::new(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
    )
}

fn host_env_with_secret() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("OPENAI_API_KEY".to_owned(), "sk-never-leak".to_owned());
    env
}

async fn run_req(req: SandboxExecutionRequest) -> cowork_sandbox::SandboxExecutionResult {
    SandboxRunner::default()
        .run_with_approval(
            req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await
}

fn new_req(
    script: &str,
    policy: SandboxPolicy,
    cwd: &Path,
    env: &HashMap<String, String>,
) -> SandboxExecutionRequest {
    let mut req = SandboxExecutionRequest::new(ps_command(script), policy, cwd);
    req.require_backend = true;
    req.timeout = Some(Duration::from_secs(30));
    req.env_source = Some(env.clone());
    req
}

#[tokio::test]
async fn windows_mxc_enforces_sandbox_or_fails_closed_when_psec_absent() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = canonicalize_sync(tmp.path());
    let ws = root.join("ws");
    let outside = root.join("outside");
    let creds = root.join("creds");
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::create_dir_all(ws.join(".cowork")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(&creds).unwrap();
    std::fs::write(ws.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(ws.join(".cowork").join("config.json"), "{}\n").unwrap();
    std::fs::write(creds.join("secret.txt"), "top-secret-token\n").unwrap();

    let env = host_env_with_secret();
    let caps = SandboxManager::new().detect_capabilities(Some("win32"), Some(&env));
    eprintln!(
        "[windows_mxc_live] backend={:?} enforcement={:?} deny_paths={} loopback_ingress={} warning={:?}",
        caps.backend,
        caps.enforcement,
        caps.windows_supports_deny_paths,
        caps.windows_supports_ingress_host_loopback_allow,
        caps.warning
    );

    let ww_no_net = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: HashMap::new(),
        network: false,
    };

    if caps.backend != SandboxType::Windows {
        // Host lacks PSEC ProcessContainer support: require_backend and hard floors MUST fail closed.
        let res = run_req(new_req(
            "Write-Output 'should-not-run'",
            ww_no_net,
            &ws,
            &env,
        ))
        .await;
        assert_eq!(
            res.error_code,
            Some(SandboxErrorCode::SandboxRequired),
            "{res:?}"
        );
        assert_eq!(res.sandbox, SandboxType::None);
        assert!(!res.unsandboxed);

        let mut ro_yolo = new_req(
            "Write-Output 'should-not-run'",
            SandboxPolicy::ReadOnly { network: false },
            &ws,
            &env,
        );
        ro_yolo.yolo = true;
        ro_yolo.require_backend = false;
        let ro_res = run_req(ro_yolo).await;
        assert_eq!(
            ro_res.error_code,
            Some(SandboxErrorCode::SandboxRequired),
            "{ro_res:?}"
        );
        return;
    }

    // 1. Workspace write succeeds, COWORK_SANDBOX markers are set, and secrets are stripped.
    let ok = run_req(new_req(
        "if ($env:OPENAI_API_KEY) { exit 99 }; Set-Content -Path 'allowed.txt' -Value 'ok'; Write-Output \"$($env:COWORK_SANDBOX)|$($env:COWORK_SANDBOX_NETWORK_DISABLED)\"",
        ww_no_net.clone(),
        &ws,
        &env,
    ))
    .await;
    assert_eq!(ok.exit_code, 0, "{ok:?}");
    assert_eq!(ok.sandbox, SandboxType::Windows);
    assert!(!ok.unsandboxed);
    assert_eq!(ok.stdout.trim(), "windows-sandbox|1");
    assert_eq!(
        std::fs::read_to_string(ws.join("allowed.txt"))
            .unwrap()
            .trim(),
        "ok"
    );

    // 2. Write outside workspace is denied by PSEC.
    let escaped = outside.join("escape.txt");
    let outside_res = run_req(new_req(
        &format!(
            "Set-Content -Path '{}' -Value 'nope'",
            escaped.to_string_lossy().replace('\'', "''")
        ),
        ww_no_net.clone(),
        &ws,
        &env,
    ))
    .await;
    assert_ne!(
        outside_res.exit_code, 0,
        "outside write must fail: {outside_res:?}"
    );
    assert!(!escaped.exists(), "outside file must not be created");

    // 3. Protected `.git` and `.cowork` remain readable, while writes into them are denied.
    let git_read = run_req(new_req(
        "Get-Content -Path '.git\\HEAD'",
        ww_no_net.clone(),
        &ws,
        &env,
    ))
    .await;
    assert_eq!(git_read.exit_code, 0, "{git_read:?}");
    assert!(git_read.stdout.contains("refs/heads/main"));

    let git_write = run_req(new_req(
        "Set-Content -Path '.git\\pwned' -Value 'bad'",
        ww_no_net.clone(),
        &ws,
        &env,
    ))
    .await;
    assert_ne!(
        git_write.exit_code, 0,
        ".git write must fail: {git_write:?}"
    );
    assert!(!ws.join(".git").join("pwned").exists());

    let cowork_write = run_req(new_req(
        "Set-Content -Path '.cowork\\pwned' -Value 'bad'",
        ww_no_net.clone(),
        &ws,
        &env,
    ))
    .await;
    assert_ne!(
        cowork_write.exit_code, 0,
        ".cowork write must fail: {cowork_write:?}"
    );
    assert!(!ws.join(".cowork").join("pwned").exists());

    // 4. `read-only` mode denies workspace writes.
    let ro_res = run_req(new_req(
        "Set-Content -Path 'ro-fail.txt' -Value 'nope'",
        SandboxPolicy::ReadOnly { network: false },
        &ws,
        &env,
    ))
    .await;
    assert_ne!(ro_res.exit_code, 0, "read-only write must fail: {ro_res:?}");
    assert!(!ws.join("ro-fail.txt").exists());

    // 5. Credential `read_denied_roots` cannot be read.
    let mut deny_req = new_req(
        &format!(
            "Get-Content -Path '{}'",
            creds
                .join("secret.txt")
                .to_string_lossy()
                .replace('\'', "''")
        ),
        ww_no_net,
        &ws,
        &env,
    );
    deny_req.read_denied_roots = vec![creds.clone()];
    let deny_res = run_req(deny_req).await;
    assert_ne!(
        deny_res.exit_code, 0,
        "denied credential read must fail: {deny_res:?}"
    );
    assert!(!deny_res.stdout.contains("top-secret-token"));

    // 6. Nonexistent writable subdirs, missing `.git`/`.cowork`, and missing credential roots
    //    (including missing intermediate parents) must not cause `CreateProcessSecurityEnvironment`
    //    to fail with `ERROR_PATH_NOT_FOUND` (`0x80070003`), while missing `.git`/`.cowork`
    //    carveouts under existing writable roots remain write-protected and cleaned up on exit.
    let empty_ws = root.join("empty_ws");
    std::fs::create_dir_all(&empty_ws).unwrap();
    let empty_ws_policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![
            empty_ws.clone(),
            empty_ws.join("output"),
            empty_ws.join("uploads"),
        ],
        writable_root_kinds: HashMap::new(),
        network: false,
    };
    let mut missing_paths_req = new_req(
        "Set-Content -Path 'created.txt' -Value 'ok'; Write-Output 'missing-paths-ok'",
        empty_ws_policy.clone(),
        &empty_ws,
        &env,
    );
    missing_paths_req.read_denied_roots = vec![
        root.join("missing-home").join(".cowork").join("auth"),
        empty_ws.join(".cowork").join("auth"),
        root.join("missing-ssh"),
        creds.clone(),
    ];
    let missing_paths_res = run_req(missing_paths_req).await;
    assert_eq!(missing_paths_res.exit_code, 0, "{missing_paths_res:?}");
    assert_eq!(missing_paths_res.stdout.trim(), "missing-paths-ok");
    assert_eq!(
        std::fs::read_to_string(empty_ws.join("created.txt"))
            .unwrap()
            .trim(),
        "ok"
    );
    assert!(
        !empty_ws.join(".cowork").exists(),
        "empty placeholder .cowork must be cleaned up after exit"
    );
    assert!(
        !empty_ws.join(".git").exists(),
        "empty placeholder .git must be cleaned up after exit"
    );

    let missing_cowork_write = run_req(new_req(
        "New-Item -ItemType Directory -Force -Path '.cowork' | Out-Null; Set-Content -Path '.cowork\\mcp-servers.json' -Value '{}'",
        empty_ws_policy.clone(),
        &empty_ws,
        &env,
    ))
    .await;
    assert_ne!(
        missing_cowork_write.exit_code, 0,
        "creating .cowork\\mcp-servers.json in a fresh workspace must fail: {missing_cowork_write:?}"
    );
    assert!(
        !empty_ws.join(".cowork").join("mcp-servers.json").exists(),
        ".cowork\\mcp-servers.json must not be created"
    );
    assert!(!empty_ws.join(".cowork").exists());

    let missing_git_write = run_req(new_req(
        "New-Item -ItemType Directory -Force -Path '.git\\hooks' | Out-Null; Set-Content -Path '.git\\hooks\\pre-commit' -Value 'echo pwned'",
        empty_ws_policy,
        &empty_ws,
        &env,
    ))
    .await;
    assert_ne!(
        missing_git_write.exit_code, 0,
        "creating .git\\hooks\\pre-commit in a fresh workspace must fail: {missing_git_write:?}"
    );
    assert!(
        !empty_ws
            .join(".git")
            .join("hooks")
            .join("pre-commit")
            .exists(),
        ".git\\hooks\\pre-commit must not be created"
    );
    assert!(!empty_ws.join(".git").exists());
}
