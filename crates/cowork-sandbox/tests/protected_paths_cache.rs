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

#[test]
fn non_tmp_workspace_never_scans_or_watches_tmp_scratch_roots_in_seatbelt_or_bwrap() {
    // Use a directory outside `/tmp` and `/private/tmp` so `with_tmp_scratch` appends
    // `/tmp` and `/private/tmp` as scratch roots.
    let non_tmp_base = if Path::new("/private/var/tmp").is_dir() {
        PathBuf::from("/private/var/tmp")
    } else {
        std::env::temp_dir()
    };
    let non_tmp_holder = tempfile::Builder::new()
        .prefix("cowork-non-tmp-ws-")
        .tempdir_in(&non_tmp_base)
        .expect("create non-tmp workspace holder");
    let ws = canonicalize_sync(non_tmp_holder.path()).join("project");
    std::fs::create_dir_all(ws.join("packages").join("sub").join(".git")).unwrap();

    // Plant a sentinel `.git` inside `/private/tmp` (or `/tmp`) to prove scratch roots
    // are NEVER walked or watched by `protected_metadata_paths`.
    let (_tmp_sentinel_holder, tmp_sentinel_root) = canonical_temp_dir("cowork-tmp-sentinel-");
    let tmp_sentinel_git = tmp_sentinel_root.join("nested-in-tmp").join(".git");
    std::fs::create_dir_all(&tmp_sentinel_git).unwrap();

    let inner = SandboxCommand::new("/bin/bash", ["-c", "echo check"]);
    let ww_policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: Default::default(),
        network: false,
    };

    // 1. Seatbelt: `/tmp` / `/private/tmp` must be granted as scratch WRITABLE_ROOT_*,
    //    while `cache` scans ONLY `ws` (`initial_scans == 1`) and never walks `/private/tmp`.
    let sb_cache = WorkspaceProtectedPathsCache::new();
    let sb_cmd =
        cowork_sandbox::build_seatbelt_command_with_cache(&inner, &ww_policy, Some(&sb_cache));
    assert_eq!(
        sb_cmd.env.get("COWORK_SANDBOX").map(String::as_str),
        Some("macos-seatbelt")
    );
    assert!(
        sb_cmd
            .args
            .iter()
            .any(|a| a.starts_with("-DWRITABLE_ROOT_") && a.ends_with("=/private/tmp")),
        "expected /private/tmp scratch root in Seatbelt writable roots: {:?}",
        sb_cmd.args
    );
    assert_eq!(
        sb_cache.stats().initial_scans,
        1,
        "Seatbelt must scan ONLY explicit workspace writable_roots, never /private/tmp scratch"
    );
    assert!(
        !sb_cmd
            .args
            .iter()
            .any(|a| a.contains(&tmp_sentinel_git.to_string_lossy().into_owned())),
        "Seatbelt must not walk /private/tmp and pick up unrelated nested .git directories"
    );

    // 2. bwrap: `/tmp` scratch is bound writable, while `cache` scans ONLY `ws` (`initial_scans == 1`).
    let bw_cache = WorkspaceProtectedPathsCache::new();
    let bw_cmd = cowork_sandbox::build_bwrap_command(
        Path::new("/usr/bin/bwrap"),
        &inner,
        &ww_policy,
        &ws,
        cowork_sandbox::BwrapBuildOptions {
            sandbox_exec_path: Some(Path::new("/opt/cowork/bin/cowork-server")),
            exists: None,
            is_directory: None,
            cache: Some(&bw_cache),
        },
    );
    assert_eq!(
        bw_cmd.env.get("COWORK_SANDBOX").map(String::as_str),
        Some("linux-bwrap")
    );
    assert_eq!(
        bw_cache.stats().initial_scans,
        1,
        "bwrap must scan ONLY explicit workspace writable_roots, never /tmp scratch"
    );
    assert!(
        !bw_cmd
            .args
            .iter()
            .any(|a| a.contains(&tmp_sentinel_git.to_string_lossy().into_owned())),
        "bwrap must not walk /tmp and --ro-bind unrelated nested .git directories"
    );

    // 3. NoProjectWrite: zero explicit writable_roots -> `initial_scans == 0` in both Seatbelt and bwrap!
    let npw_policy = SandboxPolicy::NoProjectWrite {
        project_roots: vec![ws.clone()],
        network: false,
    };
    let npw_cache = WorkspaceProtectedPathsCache::new();
    let _ =
        cowork_sandbox::build_seatbelt_command_with_cache(&inner, &npw_policy, Some(&npw_cache));
    let _ = cowork_sandbox::build_bwrap_command(
        Path::new("/usr/bin/bwrap"),
        &inner,
        &npw_policy,
        &ws,
        cowork_sandbox::BwrapBuildOptions {
            sandbox_exec_path: Some(Path::new("/opt/cowork/bin/cowork-server")),
            exists: None,
            is_directory: None,
            cache: Some(&npw_cache),
        },
    );
    assert_eq!(
        npw_cache.stats().initial_scans,
        0,
        "NoProjectWrite has only scratch roots and must perform ZERO protected-metadata scans"
    );
}
