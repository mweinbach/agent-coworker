//! Symlinked / dangling `.git` and `.cowork` entries inside a writable root must stay protected
//! as directory entries (not just at their symlink targets) by both Seatbelt and bwrap, so a
//! sandboxed `workspace-write` command cannot `rm .git && mkdir -p .git/hooks` or replace
//! `.cowork/config.json`.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    BwrapBuildOptions, SandboxCommand, SandboxPolicy, build_bwrap_command,
    build_seatbelt_command_with_cache,
};

// bwrap re-executes the current binary as `__sandbox-exec --linux-seccomp`; dispatch it pre-libtest.
cowork_sandbox::install_sandbox_exec_test_hook!();

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    external_gitdir: PathBuf,
}

/// Workspace whose `.git` is an absolute symlink to an external gitdir, whose `.cowork` is a
/// dangling symlink, and with a nested `sub/.git` relative symlink.
fn fixture() -> Fixture {
    let tmp = tempfile::Builder::new()
        .prefix("cowork-meta-symlink-")
        .tempdir()
        .expect("tempdir");
    let root = canonicalize_sync(tmp.path());
    let ws = root.join("ws");
    let external_gitdir = root.join("external").join("gitdir");
    std::fs::create_dir_all(external_gitdir.join("hooks")).unwrap();
    std::fs::create_dir_all(ws.join("sub")).unwrap();
    std::fs::write(ws.join("readme.txt"), "WORKSPACE-OK").unwrap();
    std::os::unix::fs::symlink(&external_gitdir, ws.join(".git")).unwrap();
    std::os::unix::fs::symlink(root.join("missing-cowork-target"), ws.join(".cowork")).unwrap();
    std::os::unix::fs::symlink("../../external/gitdir", ws.join("sub").join(".git")).unwrap();
    Fixture {
        _tmp: tmp,
        ws,
        external_gitdir,
    }
}

fn ww_policy(ws: &Path, network: bool) -> SandboxPolicy {
    SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.to_path_buf()],
        writable_root_kinds: HashMap::new(),
        network,
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn seatbelt_excludes_lexical_and_canonical_symlinked_metadata_entries() {
    let f = fixture();
    let cmd = build_seatbelt_command_with_cache(
        &SandboxCommand::new("/bin/true", Vec::<String>::new()),
        &ww_policy(&f.ws, true),
        None,
    );
    let excluded: Vec<&str> = cmd
        .args
        .iter()
        .filter_map(|a| a.strip_prefix("-DWRITABLE_EXCLUDED_"))
        .filter_map(|a| a.split_once('=').map(|(_, v)| v))
        .collect();
    for required in [
        // Lexical link entries (what `unlink`/`rename` act on).
        f.ws.join(".git"),
        f.ws.join(".cowork"),
        f.ws.join("sub").join(".git"),
        // Canonical target (what writes through the link resolve to).
        f.external_gitdir.clone(),
    ] {
        assert!(
            excluded.contains(&s(&required).as_str()),
            "{required:?} must be excluded from writes: {excluded:?}"
        );
    }
}

#[test]
fn bwrap_freezes_directories_holding_symlinked_metadata_entries() {
    let f = fixture();
    let cmd = build_bwrap_command(
        Path::new("/usr/bin/bwrap"),
        &SandboxCommand::new("/bin/true", Vec::<String>::new()),
        &ww_policy(&f.ws, true),
        &f.ws,
        BwrapBuildOptions {
            sandbox_exec_path: Some(Path::new("/opt/cowork/bin/cowork-server")),
            ..Default::default()
        },
    );
    let ro: Vec<&str> = cmd
        .args
        .windows(3)
        .filter(|w| w[0] == "--ro-bind" && w[1] == w[2])
        .map(|w| w[1].as_str())
        .collect();
    let ws_bind = cmd
        .args
        .windows(3)
        .position(|w| w[0] == "--bind" && w[1] == s(&f.ws))
        .expect("workspace bind");
    let ws_ro = cmd
        .args
        .windows(3)
        .position(|w| w[0] == "--ro-bind" && w[1] == s(&f.ws))
        .unwrap_or_else(|| panic!("workspace holding .git/.cowork links must be frozen: {ro:?}"));
    assert!(ws_bind < ws_ro, "{:?}", cmd.args);
    for required in [f.ws.join("sub"), f.external_gitdir.clone()] {
        assert!(
            ro.contains(&s(&required).as_str()),
            "{required:?} must be read-only: {ro:?}"
        );
    }
    // Dangling symlinks are never passed as bind sources (bwrap would abort on them).
    assert!(!ro.contains(&s(&f.ws.join(".cowork")).as_str()), "{ro:?}");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn live_bwrap_cannot_unlink_or_replace_symlinked_metadata() {
    use cowork_sandbox::{SandboxExecutionRequest, SandboxRunner, SandboxType};

    let f = fixture();
    let script = "cat readme.txt; echo; \
                  rm .git && echo UNLINKED-GIT; \
                  rm .cowork && echo UNLINKED-COWORK; \
                  rm sub/.git && echo UNLINKED-NESTED; \
                  mkdir -p .cowork && echo REPLACED-COWORK; \
                  touch .git/hooks/pre-commit && echo WROTE-HOOK; \
                  true";
    let mut req = SandboxExecutionRequest::new(
        SandboxCommand::new("/bin/sh", ["-c", script]),
        ww_policy(&f.ws, false),
        &f.ws,
    );
    req.require_backend = true;
    let res = SandboxRunner::default()
        .run_with_approval(
            req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await;
    assert_eq!(res.sandbox, SandboxType::Bwrap, "{res:?}");
    assert!(res.stdout.contains("WORKSPACE-OK"), "{res:?}");
    for marker in [
        "UNLINKED-GIT",
        "UNLINKED-COWORK",
        "UNLINKED-NESTED",
        "REPLACED-COWORK",
        "WROTE-HOOK",
    ] {
        assert!(!res.stdout.contains(marker), "{marker}: {res:?}");
    }
    for link in [
        f.ws.join(".git"),
        f.ws.join(".cowork"),
        f.ws.join("sub").join(".git"),
    ] {
        assert!(
            std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink()),
            "{link:?} must survive"
        );
    }
    assert!(!f.external_gitdir.join("hooks").join("pre-commit").exists());
}
