use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_sandbox::{
    SandboxCapabilities, SandboxCommand, SandboxEnforcement, SandboxManager, SandboxPolicy,
    SandboxType, TransformOptions, WorkspaceProtectedPathsCache,
};

fn canonical_temp_dir(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let base = if Path::new("/private/tmp").is_dir() {
        Path::new("/private/tmp")
    } else {
        Path::new("/tmp")
    };
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(base)
        .expect("create canonical temp dir");
    let canon = canonicalize_sync(dir.path());
    (dir, canon)
}

#[test]
fn multi_thousand_file_workspace_avoids_repeated_walks_and_updates_via_notify() {
    let (_tmp, root) = canonical_temp_dir("cowork-cache-scale-");
    let ws = root.join("workspace");
    let outside = root.join("outside-secret");
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::create_dir_all(ws.join(".cowork")).unwrap();
    std::fs::create_dir_all(outside.join(".git")).unwrap();

    // Populate 60 directories * 40 files = 2,400 files + initial nested submodule `.git` file
    // and case-variant `.CoWoRk` directory.
    for d in 0..60 {
        let dir = ws.join("packages").join(format!("pkg-{d:03}")).join("src");
        std::fs::create_dir_all(&dir).unwrap();
        for f in 0..40 {
            std::fs::write(dir.join(format!("mod_{f:02}.ts")), "export const x = 1;\n").unwrap();
        }
    }
    let submod_git_file = ws.join("packages").join("pkg-001").join(".git");
    std::fs::write(&submod_git_file, "gitdir: ../../.git/modules/pkg-001\n").unwrap();
    let case_cowork_dir = ws.join("packages").join("pkg-002").join(".CoWoRk");
    std::fs::create_dir_all(&case_cowork_dir).unwrap();

    #[cfg(unix)]
    {
        // Symlink escaping outside workspace MUST NEVER be traversed.
        std::os::unix::fs::symlink(&outside, ws.join("symlink-escape")).unwrap();
    }

    let cache = Arc::new(WorkspaceProtectedPathsCache::new());
    let manager = SandboxManager::with_cache(Arc::clone(&cache));
    let policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: Default::default(),
        network: true,
    };
    let seatbelt_caps = SandboxCapabilities {
        backend: SandboxType::Seatbelt,
        bwrap_path: None,
        windows_helper_path: None,
        enforcement: SandboxEnforcement::FULL,
        warning: None,
        setup_required: false,
    };

    // 1. First command populates the cache once via `ignore::WalkBuilder`.
    let inner = SandboxCommand::new("/bin/bash", ["-c", "echo warm"]);
    let (first_cmd, _, _) = manager.transform_with_options(
        &inner,
        &policy,
        &ws,
        TransformOptions {
            platform: Some("darwin"),
            capabilities: Some(&seatbelt_caps),
            ..Default::default()
        },
    );
    let after_first = cache.stats();
    assert_eq!(after_first.initial_scans, 1);
    assert!(after_first.dirs_walked >= 60);
    assert!(
        first_cmd
            .args
            .iter()
            .any(|a| a.ends_with(&submod_git_file.to_string_lossy().into_owned())),
        "submodule .git file must be excluded"
    );
    assert!(
        first_cmd
            .args
            .iter()
            .any(|a| a.ends_with(&case_cowork_dir.to_string_lossy().into_owned())),
        "case-variant .CoWoRk dir must be excluded on darwin"
    );
    assert!(
        !first_cmd.args.iter().any(|a| a.contains("outside-secret")),
        "external symlink target must never appear in exclusions"
    );

    // 2. 25 subsequent command transforms perform ZERO workspace walks (`dirs_walked` unchanged!).
    for i in 0..25 {
        let step_cmd = SandboxCommand::new("/bin/bash", ["-c", &format!("echo step-{i}")]);
        let _ = manager.transform_with_options(
            &step_cmd,
            &policy,
            &ws,
            TransformOptions {
                platform: Some("darwin"),
                capabilities: Some(&seatbelt_caps),
                ..Default::default()
            },
        );
    }
    let after_repeats = cache.stats();
    assert_eq!(after_repeats.initial_scans, 1);
    assert_eq!(
        after_repeats.dirs_walked, after_first.dirs_walked,
        "repeated sandbox command builds must perform ZERO full-workspace directory walks"
    );
    assert!(after_repeats.cache_hits >= 25);

    // 3. Querying a subdirectory inside an already-cached workspace (`ws/packages/pkg-001`) AND
    //    querying Linux case-sensitive mode also perform ZERO additional walks!
    let linux_paths = cache.protected_paths_for_roots(std::slice::from_ref(&ws), Some("linux"));
    assert!(linux_paths.contains(&submod_git_file));
    assert!(
        !linux_paths.contains(&case_cowork_dir),
        "Linux case-sensitive query must ignore .CoWoRk while sharing the single cached entry"
    );
    let sub_paths =
        cache.protected_paths_for_roots(&[ws.join("packages").join("pkg-001")], Some("darwin"));
    assert_eq!(sub_paths, vec![submod_git_file.clone()]);
    assert_eq!(cache.stats().dirs_walked, after_first.dirs_walked);

    // 4. Live `notify` update: create a brand-new nested worktree `.git` dir & `.cowork` dir,
    //    verify `notify` picks them up without a full-workspace re-scan (`initial_scans == 1`)!
    let live_wt_git = ws
        .join("packages")
        .join("pkg-010")
        .join("worktree-a")
        .join(".git");
    let live_wt_cowork = ws
        .join("packages")
        .join("pkg-010")
        .join("worktree-a")
        .join(".cowork");
    std::fs::create_dir_all(&live_wt_git).unwrap();
    std::fs::create_dir_all(&live_wt_cowork).unwrap();

    assert!(
        cache.wait_for_protected_path(
            std::slice::from_ref(&ws),
            &live_wt_git,
            true,
            Some("darwin"),
            Duration::from_secs(4),
        ),
        "notify watcher did not surface newly created nested .git directory within 4s"
    );
    assert!(
        cache.wait_for_protected_path(
            std::slice::from_ref(&ws),
            &live_wt_cowork,
            true,
            Some("darwin"),
            Duration::from_secs(4),
        ),
        "notify watcher did not surface newly created nested .cowork directory within 4s"
    );
    assert_eq!(
        cache.stats().initial_scans,
        1,
        "live notify updates must maintain cache incrementally without full-workspace rescans"
    );

    // 5. Removing the nested `.cowork` directory prunes it cleanly via `notify`.
    std::fs::remove_dir_all(&live_wt_cowork).unwrap();
    assert!(
        cache.wait_for_protected_path(
            std::slice::from_ref(&ws),
            &live_wt_cowork,
            false,
            Some("darwin"),
            Duration::from_secs(4),
        ),
        "notify watcher did not prune removed nested .cowork directory within 4s"
    );
}
