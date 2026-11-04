//! Credential read-deny (`~/.ssh`, `~/.cowork/auth`, `<ws>/.cowork/auth`, ...) for the OS
//! sandbox backends: command-construction ordering for bwrap + Seatbelt, and a live bwrap run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    BwrapBuildOptions, SandboxCommand, SandboxPolicy, build_bwrap_command,
    build_seatbelt_command_with_read_denies,
};

// bwrap re-executes the current binary as `__sandbox-exec --linux-seccomp`; dispatch it pre-libtest.
cowork_sandbox::install_sandbox_exec_test_hook!();

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    ws: PathBuf,
}

/// Fake HOME with `.ssh/id_rsa`, a `.aws` FILE root and a workspace with `.cowork/auth/token`.
fn fixture() -> Fixture {
    let tmp = tempfile::Builder::new()
        .prefix("cowork-read-deny-")
        .tempdir()
        .expect("tempdir");
    let root = canonicalize_sync(tmp.path());
    let home = root.join("home");
    let ws = root.join("ws");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::write(home.join(".ssh").join("id_rsa"), "SSH-PRIVATE-KEY-SENTINEL").unwrap();
    std::fs::create_dir_all(home.join(".cowork").join("auth")).unwrap();
    std::fs::write(
        home.join(".cowork").join("auth").join("connections.json"),
        "COWORK-AUTH-SENTINEL",
    )
    .unwrap();
    // A denied root that is a regular file (rather than a directory).
    std::fs::write(home.join(".netrc-like"), "FILE-ROOT-SENTINEL").unwrap();
    std::fs::create_dir_all(ws.join(".cowork").join("auth")).unwrap();
    std::fs::write(
        ws.join(".cowork").join("auth").join("mcp.json"),
        "WS-AUTH-SENTINEL",
    )
    .unwrap();
    std::fs::write(ws.join("readme.txt"), "WORKSPACE-OK").unwrap();
    Fixture {
        _tmp: tmp,
        home,
        ws,
    }
}

fn denied_roots(f: &Fixture) -> Vec<PathBuf> {
    vec![
        f.home.join(".cowork").join("auth"),
        f.home.join(".cowork").join("mobile-pairing"), // missing -> skipped by bwrap
        f.ws.join(".cowork").join("auth"),
        f.home.join(".ssh"),
        f.home.join(".netrc-like"),
        f.home.join(".aws"), // missing -> skipped by bwrap
    ]
}

fn position(args: &[String], window: &[&str]) -> usize {
    args.windows(window.len())
        .position(|w| w.iter().zip(window).all(|(a, b)| a == b))
        .unwrap_or_else(|| panic!("expected {window:?} in bwrap args: {args:?}"))
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn bwrap_masks_credential_roots_after_every_bind_for_all_policies() {
    let f = fixture();
    let denied = denied_roots(&f);
    let inner = SandboxCommand::new("/bin/cat", ["x"]);
    let ws_str = s(&f.ws);
    let ws_cowork = s(&f.ws.join(".cowork"));
    let ws_auth = s(&f.ws.join(".cowork").join("auth"));
    let ssh = s(&f.home.join(".ssh"));
    let home_auth = s(&f.home.join(".cowork").join("auth"));
    let file_root = s(&f.home.join(".netrc-like"));

    let ww = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![f.ws.clone()],
        writable_root_kinds: HashMap::new(),
        network: true,
    };
    let full_no_net = SandboxPolicy::DangerFullAccess {
        network: Some(false),
    };
    for policy in [ww, SandboxPolicy::ReadOnly { network: true }, full_no_net] {
        let cmd = build_bwrap_command(
            Path::new("/usr/bin/bwrap"),
            &inner,
            &policy,
            &f.ws,
            BwrapBuildOptions {
                sandbox_exec_path: Some(Path::new("/opt/cowork/bin/cowork-server")),
                read_denied_roots: &denied,
                ..Default::default()
            },
        );
        let args = &cmd.args;
        let root_bind = if matches!(policy, SandboxPolicy::DangerFullAccess { .. }) {
            position(args, &["--bind", "/", "/"])
        } else {
            position(args, &["--ro-bind", "/", "/"])
        };
        let ws_mask = position(args, &["--tmpfs", &ws_auth, "--remount-ro", &ws_auth]);
        let ssh_mask = position(args, &["--tmpfs", &ssh, "--remount-ro", &ssh]);
        let home_auth_mask = position(args, &["--tmpfs", &home_auth]);
        let file_mask = position(args, &["--ro-bind", "/dev/null", &file_root]);
        let unshare = position(args, &["--unshare-user"]);
        for mask in [ws_mask, ssh_mask, home_auth_mask, file_mask] {
            assert!(root_bind < mask, "mask must follow the root bind: {args:?}");
            assert!(
                mask < unshare,
                "mask must precede namespace flags: {args:?}"
            );
        }
        if let SandboxPolicy::WorkspaceWrite { .. } = policy {
            // The writable workspace bind and its read-only `.cowork` rebind must not re-expose
            // `<ws>/.cowork/auth`: both come before the mask.
            let ws_bind = position(args, &["--bind", &ws_str, &ws_str]);
            let cowork_ro = position(args, &["--ro-bind", &ws_cowork, &ws_cowork]);
            assert!(ws_bind < cowork_ro && cowork_ro < ws_mask, "{args:?}");
        }
        // Missing roots are skipped (bwrap would otherwise create mount points / fail).
        for missing in [".aws", "mobile-pairing"] {
            assert!(
                !args.iter().any(|a| a.ends_with(missing)),
                "missing root {missing} must be skipped: {args:?}"
            );
        }
    }
}

#[test]
fn bwrap_skips_roots_nested_under_an_already_masked_root() {
    let f = fixture();
    let ssh = f.home.join(".ssh");
    let nested = ssh.join("id_rsa");
    let cmd = build_bwrap_command(
        Path::new("/usr/bin/bwrap"),
        &SandboxCommand::new("/bin/true", Vec::<String>::new()),
        &SandboxPolicy::ReadOnly { network: true },
        &f.ws,
        BwrapBuildOptions {
            sandbox_exec_path: Some(Path::new("/opt/cowork/bin/cowork-server")),
            read_denied_roots: &[nested.clone(), ssh.clone()],
            ..Default::default()
        },
    );
    position(&cmd.args, &["--tmpfs", &s(&ssh)]);
    assert!(
        !cmd.args.contains(&s(&nested)),
        "nested root already hidden by its masked ancestor: {:?}",
        cmd.args
    );
}

#[test]
fn seatbelt_denies_credential_reads_and_writes_after_allow_rules() {
    let f = fixture();
    let denied = vec![f.home.join(".ssh"), f.ws.join(".cowork").join("auth")];
    let inner = SandboxCommand::new("/bin/cat", ["x"]);
    for policy in [
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![f.ws.clone()],
            writable_root_kinds: HashMap::new(),
            network: true,
        },
        SandboxPolicy::DangerFullAccess {
            network: Some(false),
        },
        SandboxPolicy::ReadOnly { network: false },
    ] {
        let cmd = build_seatbelt_command_with_read_denies(&inner, &policy, None, &denied);
        assert_eq!(cmd.args[0], "-p");
        let profile = &cmd.args[1];
        let allow_read = profile.find("(allow file-read*)").expect("allow read");
        let deny = profile
            .find("(deny file-read* file-write*")
            .unwrap_or_else(|| panic!("deny rule missing: {profile}"));
        assert!(allow_read < deny, "deny must follow allow read: {profile}");
        if let Some(allow_write) = profile.find("(allow file-write*") {
            assert!(
                allow_write < deny,
                "deny must follow allow write: {profile}"
            );
        }
        assert!(profile.contains("(subpath (param \"READ_DENIED_0\"))"));
        assert!(profile.contains("(subpath (param \"READ_DENIED_1\"))"));
        // Paths travel as `-D` params, never interpolated into the profile text.
        assert!(!profile.contains(&s(&f.home)));
        for root in &denied {
            let canonical = canonicalize_sync(root);
            assert!(
                cmd.args
                    .iter()
                    .any(|a| a.starts_with("-DREAD_DENIED_") && a.ends_with(&s(&canonical))),
                "missing -D param for {canonical:?}: {:?}",
                cmd.args
            );
        }
    }
    // No denied roots -> no deny section (profile unchanged from the legacy builder).
    let plain = build_seatbelt_command_with_read_denies(
        &inner,
        &SandboxPolicy::ReadOnly { network: false },
        None,
        &[],
    );
    assert!(!plain.args[1].contains("(deny file-read*"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn live_bwrap_hides_credential_paths_but_keeps_workspace_readable() {
    use cowork_sandbox::{SandboxExecutionRequest, SandboxRunner, SandboxType};

    let f = fixture();
    let runner = SandboxRunner::default();
    let policies = [
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![f.ws.clone()],
            writable_root_kinds: HashMap::new(),
            network: false,
        },
        SandboxPolicy::DangerFullAccess {
            network: Some(false),
        },
    ];
    for policy in policies {
        let script = format!(
            "cat readme.txt; echo; \
             cat {ssh} && echo LEAK-SSH; \
             cat {ws_auth} && echo LEAK-WS-AUTH; \
             cat {home_auth} && echo LEAK-HOME-AUTH; \
             cat {file_root} && echo LEAK-FILE-ROOT; \
             echo pwned > {ws_auth_new} && echo LEAK-WRITE; \
             true",
            ssh = s(&f.home.join(".ssh").join("id_rsa")),
            ws_auth = s(&f.ws.join(".cowork").join("auth").join("mcp.json")),
            home_auth = s(&f.home.join(".cowork").join("auth").join("connections.json")),
            file_root = s(&f.home.join(".netrc-like")),
            ws_auth_new = s(&f.ws.join(".cowork").join("auth").join("new.json")),
        );
        let mut req = SandboxExecutionRequest::new(
            SandboxCommand::new("/bin/sh", ["-c", script.as_str()]),
            policy.clone(),
            &f.ws,
        );
        req.require_backend = true;
        req.read_denied_roots = denied_roots(&f);
        let res = runner
            .run_with_approval(
                req,
                None,
                None::<fn(Option<&str>) -> std::future::Ready<bool>>,
            )
            .await;
        assert_eq!(
            res.sandbox,
            SandboxType::Bwrap,
            "bwrap must be usable on Linux CI: {res:?}"
        );
        assert!(
            res.stdout.contains("WORKSPACE-OK"),
            "{policy:?}: workspace must stay readable: {res:?}"
        );
        for leaked in [
            "SENTINEL",
            "LEAK-SSH",
            "LEAK-WS-AUTH",
            "LEAK-HOME-AUTH",
            "LEAK-FILE-ROOT",
            "LEAK-WRITE",
        ] {
            assert!(
                !res.stdout.contains(leaked),
                "{policy:?}: credential path exposed ({leaked}): {res:?}"
            );
        }
    }
    // The masks are ephemeral: nothing was written through to the real credential dir.
    assert!(!f.ws.join(".cowork").join("auth").join("new.json").exists());
    assert_eq!(
        std::fs::read_to_string(f.home.join(".ssh").join("id_rsa")).unwrap(),
        "SSH-PRIVATE-KEY-SENTINEL"
    );
}
