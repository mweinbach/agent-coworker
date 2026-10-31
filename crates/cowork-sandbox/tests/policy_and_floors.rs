use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cowork_config::{SandboxConfig, SandboxMode as ConfigSandboxMode, canonicalize_sync};
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxCapabilities, SandboxCommand, SandboxEnforcement,
    SandboxErrorCode, SandboxGateDecision, SandboxManager, SandboxPolicy, SandboxType,
    TransformOptions, WritableRootKind, filter_target_paths_to_workspace, is_usable_target_path,
    normalize_sandbox_child_env, policy_allows_network, resolve_sandbox_policy, scratch_roots,
    tmp_scratch_roots, with_tmp_scratch,
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
fn resolves_default_modes_and_preserves_all_hard_floors_even_under_yolo() {
    let (_tmp, root) = canonical_temp_dir("cowork-policy-");
    let ws = root.join("ws");
    let out = root.join("out");
    let up = root.join("uploads");
    let runtime_root = root.join("uv-cache");
    let src_dir = ws.join("src");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::create_dir_all(&out).unwrap();
    std::fs::create_dir_all(&up).unwrap();
    std::fs::create_dir_all(&runtime_root).unwrap();

    // 1. Default `auto` -> `workspace-write` including workspace, output, uploads, and runtime roots.
    let mut base = ResolveSandboxPolicyInput::new(&ws);
    base.output_directory = Some(out.clone());
    base.uploads_directory = Some(up.clone());
    base.tool_runtime_writable_roots = vec![runtime_root.clone()];
    let default_policy = resolve_sandbox_policy(&base);
    assert_eq!(
        default_policy,
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![ws.clone(), out.clone(), up.clone(), runtime_root.clone()],
            writable_root_kinds: HashMap::new(),
            network: true,
        }
    );

    // 2. Normal `--yolo` with no hard floor -> `danger-full-access` with network true.
    let mut yolo_normal = base.clone();
    yolo_normal.yolo = true;
    assert_eq!(
        resolve_sandbox_policy(&yolo_normal),
        SandboxPolicy::DangerFullAccess {
            network: Some(true)
        }
    );

    // 3. Hard floor: `mode: read-only` beats `read_only_role`, `target_paths`, and `yolo`.
    let mut read_only = base.clone();
    read_only.config = Some(SandboxConfig {
        mode: ConfigSandboxMode::ReadOnly,
        network: false,
        require_backend: false,
    });
    read_only.read_only_role = true;
    read_only.target_paths = Some(vec!["src".to_owned()]);
    read_only.yolo = true;
    assert_eq!(
        resolve_sandbox_policy(&read_only),
        SandboxPolicy::ReadOnly { network: false }
    );

    // 4. Hard floor: `read_only_role: true` -> `no-project-write` even under `danger-full-access` + `yolo`,
    //    never widened by `tool_runtime_writable_roots`.
    let mut explorer = base.clone();
    explorer.config = Some(SandboxConfig {
        mode: ConfigSandboxMode::DangerFullAccess,
        network: true,
        require_backend: false,
    });
    explorer.read_only_role = true;
    explorer.yolo = true;
    assert_eq!(
        resolve_sandbox_policy(&explorer),
        SandboxPolicy::NoProjectWrite {
            project_roots: vec![ws.clone(), out.clone(), up.clone()],
            network: true,
        }
    );

    // 5. Hard floor: scoped child `targetPaths` -> strictly confined to validated target paths even under `yolo`,
    //    excluding `output_directory`, `uploads_directory`, and `tool_runtime_writable_roots`.
    let mut child = base.clone();
    child.config = Some(SandboxConfig {
        mode: ConfigSandboxMode::DangerFullAccess,
        network: false,
        require_backend: false,
    });
    child.target_paths = Some(vec!["src".to_owned(), "../outside".to_owned()]);
    child.yolo = true;
    assert_eq!(
        resolve_sandbox_policy(&child),
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![src_dir],
            writable_root_kinds: HashMap::new(),
            network: false,
        }
    );

    // 6. Hard floor: explicit `network: false` preserved on `danger-full-access` and `--yolo`.
    let mut yolo_no_net = base.clone();
    yolo_no_net.config = Some(SandboxConfig {
        mode: ConfigSandboxMode::WorkspaceWrite,
        network: false,
        require_backend: false,
    });
    yolo_no_net.yolo = true;
    let resolved_no_net = resolve_sandbox_policy(&yolo_no_net);
    assert_eq!(
        resolved_no_net,
        SandboxPolicy::DangerFullAccess {
            network: Some(false)
        }
    );
    assert!(!policy_allows_network(&resolved_no_net));
}

#[test]
fn filters_target_paths_for_symlinks_protected_metadata_windows_drives_and_creation_hints() {
    let (_tmp, root) = canonical_temp_dir("cowork-targets-");
    let ws = root.join("ws");
    let outside = root.join("outside");
    std::fs::create_dir_all(ws.join("src")).unwrap();
    std::fs::create_dir_all(ws.join(".git").join("hooks")).unwrap();
    std::fs::create_dir_all(ws.join(".cowork")).unwrap();
    std::fs::create_dir_all(ws.join(".github").join("workflows")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, ws.join("escape")).unwrap();
        std::os::unix::fs::symlink(ws.join(".git").join("hooks"), ws.join("gitlink")).unwrap();
    }

    let targets = vec![
        "".to_owned(),
        "src".to_owned(),
        "src/new-component.tsx".to_owned(),
        "build/".to_owned(),
        ".github".to_owned(),
        ".env".to_owned(),
        "../outside".to_owned(),
        ".git".to_owned(),
        ".git/config".to_owned(),
        ".cowork/config.json".to_owned(),
        "escape/secret.txt".to_owned(),
        "gitlink/pre-commit".to_owned(),
    ];

    let filtered = filter_target_paths_to_workspace(&targets, &ws, None, None);
    assert_eq!(
        filtered.writable_roots,
        vec![
            ws.join("src"),
            ws.join("src").join("new-component.tsx"),
            ws.join("build"),
            ws.join(".github"),
            ws.join(".env"),
        ]
    );
    assert_eq!(
        filtered
            .writable_root_kinds
            .get(&ws.join("src").join("new-component.tsx")),
        Some(&WritableRootKind::File)
    );
    assert_eq!(
        filtered.writable_root_kinds.get(&ws.join("build")),
        Some(&WritableRootKind::Directory)
    );
    assert_eq!(
        filtered.writable_root_kinds.get(&ws.join(".env")),
        Some(&WritableRootKind::File)
    );
    // Existing `.github` directory MUST NOT be misclassified as a file.
    assert!(
        !filtered
            .writable_root_kinds
            .contains_key(&ws.join(".github"))
    );

    // One-off chat workspace living inside `~/.cowork/chats/<id>` allows normal children
    // while still blocking `<chat>/.cowork/...`.
    let one_off = root.join(".cowork").join("chats").join("chat-123");
    std::fs::create_dir_all(&one_off).unwrap();
    assert_eq!(
        is_usable_target_path("notes.md", &one_off, None, None),
        Some(one_off.join("notes.md"))
    );
    assert_eq!(
        is_usable_target_path(".cowork/settings.json", &one_off, None, None),
        None
    );

    // Simulated Windows cross-drive and UNC target containment.
    assert_eq!(
        is_usable_target_path("src\\main.rs", Path::new(r"C:\repo"), None, Some("win32")),
        Some(PathBuf::from(r"C:\repo\src\main.rs"))
    );
    assert_eq!(
        is_usable_target_path(
            r"D:\other\secret.txt",
            Path::new(r"C:\repo"),
            None,
            Some("win32")
        ),
        None
    );
    assert_eq!(
        is_usable_target_path(
            r"\\server\share\file.txt",
            Path::new(r"C:\repo"),
            None,
            Some("win32")
        ),
        None
    );
}

#[test]
fn tmp_scratch_roots_excludes_both_lexical_and_canonical_blocked_roots() {
    let darwin_scratch = scratch_roots(Some("darwin"));
    assert_eq!(
        darwin_scratch,
        vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")]
    );

    // Empty writable roots stay empty (never silently widened with `/tmp`).
    assert!(with_tmp_scratch(&[], &darwin_scratch).is_empty());

    // Scoped root inside `/tmp` or `/private/tmp` never gets `/tmp` or `/private/tmp` appended.
    let scoped = vec![PathBuf::from("/tmp/proj/src")];
    assert_eq!(with_tmp_scratch(&scoped, &darwin_scratch), scoped);

    // Blocked `/` or `/tmp` or `/private/tmp` excludes all scratch roots.
    assert!(tmp_scratch_roots(&[PathBuf::from("/")], &darwin_scratch).is_empty());
    assert!(tmp_scratch_roots(&[PathBuf::from("/tmp")], &darwin_scratch).is_empty());
    assert!(tmp_scratch_roots(&[PathBuf::from("/private/tmp")], &darwin_scratch).is_empty());

    // Regression test for commit 5d38ab6c: a workspace symlink pointing directly to `/private/tmp`
    // must exclude BOTH `/tmp` and `/private/tmp` because canonicalization resolves to `/private/tmp`!
    #[cfg(unix)]
    {
        let (_tmp, holder) = canonical_temp_dir("cowork-symlink-scratch-");
        let link_to_tmp = holder.join("linked-project");
        let target = if Path::new("/private/tmp").is_dir() {
            Path::new("/private/tmp")
        } else {
            Path::new("/tmp")
        };
        std::os::unix::fs::symlink(target, &link_to_tmp).unwrap();
        assert!(
            tmp_scratch_roots(&[link_to_tmp], &darwin_scratch).is_empty(),
            "symlinked blocked root targeting /private/tmp must exclude all scratch roots"
        );
    }
}

#[test]
fn normalize_sandbox_child_env_rewrites_unwritable_tmpdir_and_sets_c_locale() {
    let policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![PathBuf::from("/Users/alice/proj")],
        writable_root_kinds: HashMap::new(),
        network: true,
    };

    let mut env = HashMap::new();
    env.insert("TMPDIR".to_owned(), "/var/folders/xx/abc/T/".to_owned());
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());

    let normalized = normalize_sandbox_child_env(&env, &policy, Some("darwin"));
    assert_eq!(normalized.get("LC_MESSAGES").map(String::as_str), Some("C"));
    assert_eq!(normalized.get("TMPDIR").map(String::as_str), Some("/tmp"));
    assert!(!normalized.contains_key("TMP"));
    assert!(!normalized.contains_key("TEMP"));

    // In-workspace TMPDIR stays untouched.
    let mut in_ws_env = HashMap::new();
    let ws_tmp_str = "/Users/alice/proj/local-tmp".to_owned();
    in_ws_env.insert("TMPDIR".to_owned(), ws_tmp_str.clone());
    let preserved = normalize_sandbox_child_env(&in_ws_env, &policy, Some("darwin"));
    assert_eq!(preserved.get("TMPDIR"), Some(&ws_tmp_str));

    // Scoped root inside `/private/tmp` keeps `/tmp` blocked and does NOT rewrite TMPDIR to `/tmp`.
    let scoped_tmp_policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![PathBuf::from("/private/tmp/proj/src")],
        writable_root_kinds: HashMap::new(),
        network: true,
    };
    let scoped_out = normalize_sandbox_child_env(&env, &scoped_tmp_policy, Some("darwin"));
    assert_eq!(
        scoped_out.get("TMPDIR").map(String::as_str),
        Some("/var/folders/xx/abc/T/")
    );

    // Windows leaves env untouched.
    let win_out = normalize_sandbox_child_env(&env, &policy, Some("win32"));
    assert_eq!(win_out, env);
}

#[test]
fn sandbox_required_gate_fails_closed_for_hard_floors_and_require_backend() {
    let (_tmp, ws) = canonical_temp_dir("cowork-gate-");
    let manager = SandboxManager::new();
    let cmd = SandboxCommand::new("/bin/echo", ["hi"]);
    let missing_caps = SandboxCapabilities::none("no sandbox backend available");

    // 1. Hard floor (`ReadOnly`) fails closed with `SANDBOX_REQUIRED` (no approval fallback).
    let ro_decision = manager.evaluate_gate(
        &cmd,
        &SandboxPolicy::ReadOnly { network: true },
        &ws,
        true, // even with --yolo!
        false,
        false,
        TransformOptions {
            platform: Some("linux"),
            capabilities: Some(&missing_caps),
            ..Default::default()
        },
    );
    assert!(matches!(
        ro_decision,
        SandboxGateDecision::Deny {
            error_code: SandboxErrorCode::SandboxRequired,
            ..
        }
    ));

    // 2. Hard floor (`--yolo` + `network: false`) fails closed if backend lacks network isolation.
    let partial_caps = SandboxCapabilities {
        backend: SandboxType::Windows,
        bwrap_path: None,
        windows_helper_path: Some(PathBuf::from("cowork-win-sandbox.exe")),
        enforcement: SandboxEnforcement {
            filesystem: true,
            network: false,
            process: true,
            integrity: true,
        },
        warning: Some("Firewall rule missing".to_owned()),
        setup_required: false,
    };
    let yolo_no_net_decision = manager.evaluate_gate(
        &cmd,
        &SandboxPolicy::DangerFullAccess {
            network: Some(false),
        },
        &ws,
        true,
        false,
        false,
        TransformOptions {
            platform: Some("win32"),
            capabilities: Some(&partial_caps),
            ..Default::default()
        },
    );
    assert!(matches!(
        yolo_no_net_decision,
        SandboxGateDecision::Deny {
            error_code: SandboxErrorCode::SandboxRequired,
            ..
        }
    ));

    // 3. `requireBackend: true` fails closed on `workspace-write` when backend is missing.
    let ww_policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![ws.clone()],
        writable_root_kinds: HashMap::new(),
        network: true,
    };
    let req_backend_decision = manager.evaluate_gate(
        &cmd,
        &ww_policy,
        &ws,
        false,
        true,
        false,
        TransformOptions {
            platform: Some("linux"),
            capabilities: Some(&missing_caps),
            ..Default::default()
        },
    );
    assert!(matches!(
        req_backend_decision,
        SandboxGateDecision::Deny {
            error_code: SandboxErrorCode::SandboxRequired,
            ..
        }
    ));

    // 4. Standard `workspace-write` with `requireBackend: false` requests explicit unsandboxed approval.
    let approval_decision = manager.evaluate_gate(
        &cmd,
        &ww_policy,
        &ws,
        false,
        false,
        false,
        TransformOptions {
            platform: Some("linux"),
            capabilities: Some(&missing_caps),
            ..Default::default()
        },
    );
    assert!(matches!(
        approval_decision,
        SandboxGateDecision::RequireUnsandboxedApproval {
            reason: "sandbox_denied",
            ..
        }
    ));
}

#[test]
fn unscoped_workspace_write_includes_project_root_resolves_relative_dirs_and_rejects_protected_metadata()
 {
    let (_tmp, root) = canonical_temp_dir("cowork-unscoped-ww-");
    let repo = root.join("repo");
    let subdir = repo.join("packages").join("app");
    let external_mem = root
        .join("home")
        .join(".cowork")
        .join("memories")
        .join("active");
    std::fs::create_dir_all(&subdir).unwrap();
    std::fs::create_dir_all(repo.join(".git").join("hooks")).unwrap();
    std::fs::create_dir_all(repo.join(".cowork")).unwrap();
    std::fs::create_dir_all(subdir.join("out")).unwrap();
    std::fs::create_dir_all(subdir.join("uploads")).unwrap();
    std::fs::create_dir_all(&external_mem).unwrap();

    // 1. Subdirectory `working_directory` includes `project_root` AND resolves relative
    //    `output_directory` / `uploads_directory` against `working_directory` (not process CWD!).
    let mut input = ResolveSandboxPolicyInput::new(&subdir);
    input.project_root = Some(repo.clone());
    input.output_directory = Some(PathBuf::from("out"));
    input.uploads_directory = Some(PathBuf::from("uploads"));
    input.tool_runtime_writable_roots = vec![
        external_mem.clone(),
        repo.join(".git").join("hooks"),
        PathBuf::from("   "),
    ];
    let resolved = resolve_sandbox_policy(&input);
    assert_eq!(
        resolved,
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![
                subdir.clone(),
                repo.clone(),
                subdir.join("out"),
                subdir.join("uploads"),
                external_mem,
            ],
            writable_root_kinds: HashMap::new(),
            network: true,
        }
    );

    // 2. Direct `.git`/`.cowork` paths (both relative to subdir and under outer `project_root`)
    //    are rejected for `output_directory`, `uploads_directory`, and `tool_runtime_writable_roots`.
    let mut bad_meta = ResolveSandboxPolicyInput::new(&subdir);
    bad_meta.project_root = Some(repo.clone());
    bad_meta.output_directory = Some(repo.join(".git").join("hooks"));
    bad_meta.uploads_directory = Some(PathBuf::from(".cowork/uploads"));
    bad_meta.tool_runtime_writable_roots = vec![PathBuf::from(".git/objects")];
    assert_eq!(
        resolve_sandbox_policy(&bad_meta),
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![subdir.clone(), repo.clone()],
            writable_root_kinds: HashMap::new(),
            network: true,
        }
    );

    // 3. Symlinked `output_directory`, `uploads_directory`, and `tool_runtime_writable_roots`
    //    resolving into `.git` or `.cowork` are rejected!
    #[cfg(unix)]
    {
        let out_link = subdir.join("symlink-out");
        let up_link = subdir.join("symlink-up");
        let rt_link = subdir.join("symlink-rt");
        std::os::unix::fs::symlink(repo.join(".git").join("hooks"), &out_link).unwrap();
        std::os::unix::fs::symlink(repo.join(".cowork"), &up_link).unwrap();
        std::os::unix::fs::symlink(repo.join(".git"), &rt_link).unwrap();

        let mut sym_input = ResolveSandboxPolicyInput::new(&subdir);
        sym_input.project_root = Some(repo.clone());
        sym_input.output_directory = Some(PathBuf::from("symlink-out"));
        sym_input.uploads_directory = Some(up_link);
        sym_input.tool_runtime_writable_roots = vec![rt_link];
        assert_eq!(
            resolve_sandbox_policy(&sym_input),
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![subdir, repo],
                writable_root_kinds: HashMap::new(),
                network: true,
            }
        );
    }
}
