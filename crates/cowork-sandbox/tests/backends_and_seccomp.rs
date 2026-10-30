use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use cowork_config::canonicalize_sync;
use cowork_sandbox::linux_seccomp::{
    AARCH64_SYS_SOCKET, AARCH64_SYS_SOCKETPAIR, AUDIT_ARCH_AARCH64, AUDIT_ARCH_I386,
    AUDIT_ARCH_X86_64, LINUX_AF_INET, LINUX_AF_INET6, LINUX_AF_UNIX, LINUX_SOCK_CLOEXEC,
    LINUX_SOCK_DGRAM, LINUX_SOCK_NONBLOCK, LINUX_SOCK_SEQPACKET, LINUX_SOCK_STREAM,
    SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO_ENOSYS, SECCOMP_RET_ERRNO_EPERM, SECCOMP_RET_KILL_PROCESS,
    SYS_IO_URING_ENTER, SYS_IO_URING_REGISTER, SYS_IO_URING_SETUP, X32_SYSCALL_BIT,
    X86_64_SYS_SOCKET, X86_64_SYS_SOCKETPAIR,
};
use cowork_sandbox::{
    BWRAP_RETRY_COOLDOWN_MS, BwrapBuildOptions, BwrapProbeOptions, ClassifyDenialOptions,
    CommandApprovalReasonCode, CommandRiskLevel, ProbeCommandOutput, SEATBELT_RETRY_COOLDOWN_MS,
    SandboxCommand, SandboxDenialCategory, SandboxDenialDetailKind, SandboxPolicy, SandboxType,
    SeatbeltCheckOptions, WINDOWS_SANDBOX_COMMAND_RUNNER_NAME, WINDOWS_SANDBOX_HELPER_NAME,
    WINDOWS_SANDBOX_PROBE_TTL_MS, WINDOWS_SANDBOX_SETUP_NAME, WindowsProbeOptions,
    WritableRootKind, build_bwrap_command, build_linux_socket_filter,
    build_windows_sandbox_command, classify_command_detailed, classify_sandbox_denial,
    classify_sandbox_denial_detailed, describe_sandbox_denial, evaluate_seccomp_bpf, find_bwrap,
    has_seatbelt_with_options, is_bwrap_usable_with_options, is_native_windows_binary,
    plan_sandbox_escalation, probe_windows_sandbox_bundle, reset_bwrap_cache_for_tests,
    reset_seatbelt_cache_for_tests, reset_windows_probe_cache_for_tests,
    sync_codex_windows_sandbox_setup_state, windows_sandbox_home_for_platform,
};
use sha2::{Digest, Sha256};

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
fn bwrap_command_uses_native_self_exec_seccomp_with_zero_python_and_exact_mounts() {
    let (_tmp, root) = canonical_temp_dir("cowork-bwrap-");
    let ws = root.join("ws");
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::create_dir_all(ws.join(".cowork")).unwrap();
    std::fs::create_dir_all(ws.join("packages").join("sub").join(".git")).unwrap();
    std::fs::write(ws.join("submod-file-git"), "").unwrap();

    let missing_file = ws.join("src").join("created-target.ts");
    let missing_dir = ws.join("dist-out");
    let uncreated_output_dir = root.join("optional-output-never-created");

    let mut kinds = HashMap::new();
    kinds.insert(missing_file.clone(), WritableRootKind::File);
    kinds.insert(missing_dir.clone(), WritableRootKind::Directory);

    let policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![
            ws.clone(),
            missing_file.clone(),
            missing_dir.clone(),
            uncreated_output_dir.clone(),
        ],
        writable_root_kinds: kinds,
        network: false,
    };

    let self_bin = Path::new("/opt/cowork/bin/cowork-server");
    let inner = SandboxCommand::new("/bin/bash", ["-c", "echo linux"]);
    let transformed = build_bwrap_command(
        Path::new("/usr/bin/bwrap"),
        &inner,
        &policy,
        &ws,
        BwrapBuildOptions {
            sandbox_exec_path: Some(self_bin),
            ..Default::default()
        },
    );

    assert_eq!(transformed.file, "/usr/bin/bwrap");
    assert_eq!(transformed.sandbox, SandboxType::Bwrap);
    assert!(!transformed.unsandboxed);
    assert_eq!(
        transformed.env.get("COWORK_SANDBOX").map(String::as_str),
        Some("bwrap")
    );
    assert_eq!(
        transformed
            .env
            .get("COWORK_SANDBOX_NETWORK_DISABLED")
            .map(String::as_str),
        Some("1")
    );

    // Zero `/usr/bin/python3` or `python` dependency anywhere in command or args!
    assert!(!transformed.file.contains("python"));
    assert!(
        !transformed.args.iter().any(|a| a.contains("python")),
        "bwrap command must have zero Python dependency: {:?}",
        transformed.args
    );

    // Invokes `<self_bin> __sandbox-exec --linux-seccomp --deny-network -- /bin/bash -c "echo linux"`
    let tail_sep = transformed
        .args
        .iter()
        .position(|a| a == "--")
        .expect("outer bwrap -- separator");
    assert_eq!(
        &transformed.args[tail_sep + 1..],
        &[
            "/opt/cowork/bin/cowork-server",
            "__sandbox-exec",
            "--linux-seccomp",
            "--deny-network",
            "--",
            "/bin/bash",
            "-c",
            "echo linux",
        ]
    );
    assert!(transformed.args.contains(&"--unshare-net".to_owned()));
    assert!(transformed.args.contains(&"--ro-bind".to_owned()));

    // Hinted missing targetPaths were materialized for bind-mounting, while un-hinted output dir was NOT.
    assert!(missing_file.is_file());
    assert!(missing_dir.is_dir());
    assert!(!uncreated_output_dir.exists());
}

#[test]
fn linux_seccomp_bpf_bytecode_enforces_abi_iouring_socket_and_socketpair_rules() {
    let host_filter = build_linux_socket_filter(false);
    let net_deny_filter = build_linux_socket_filter(true);

    // 1. Foreign architecture -> KILL_PROCESS.
    assert_eq!(
        evaluate_seccomp_bpf(&host_filter, AUDIT_ARCH_I386, 1, [0; 6]).unwrap(),
        SECCOMP_RET_KILL_PROCESS
    );
    assert_eq!(
        evaluate_seccomp_bpf(&host_filter, 0xdead_beef, 1, [0; 6]).unwrap(),
        SECCOMP_RET_KILL_PROCESS
    );

    // 2. x86_64 x32 ABI bit -> ENOSYS.
    assert_eq!(
        evaluate_seccomp_bpf(&host_filter, AUDIT_ARCH_X86_64, X32_SYSCALL_BIT | 1, [0; 6]).unwrap(),
        SECCOMP_RET_ERRNO_ENOSYS
    );

    // 3. io_uring syscalls (425, 426, 427) -> ENOSYS on both x86_64 and aarch64.
    for arch in [AUDIT_ARCH_X86_64, AUDIT_ARCH_AARCH64] {
        for nr in [
            SYS_IO_URING_SETUP,
            SYS_IO_URING_ENTER,
            SYS_IO_URING_REGISTER,
        ] {
            assert_eq!(
                evaluate_seccomp_bpf(&host_filter, arch, nr, [0; 6]).unwrap(),
                SECCOMP_RET_ERRNO_ENOSYS
            );
        }
    }

    // 4. `socket(AF_UNIX, ...)` -> EPERM on both x86_64 (41) and aarch64 (198).
    for (arch, sys_socket) in [
        (AUDIT_ARCH_X86_64, X86_64_SYS_SOCKET),
        (AUDIT_ARCH_AARCH64, AARCH64_SYS_SOCKET),
    ] {
        assert_eq!(
            evaluate_seccomp_bpf(
                &host_filter,
                arch,
                sys_socket,
                [LINUX_AF_UNIX as u64, LINUX_SOCK_STREAM as u64, 0, 0, 0, 0]
            )
            .unwrap(),
            SECCOMP_RET_ERRNO_EPERM
        );

        // AF_INET / AF_INET6 allowed in host-socket filter (where `bwrap --unshare-net` isolates IP),
        // and blocked with EPERM when `deny_network == true`.
        for domain in [LINUX_AF_INET, LINUX_AF_INET6] {
            assert_eq!(
                evaluate_seccomp_bpf(
                    &host_filter,
                    arch,
                    sys_socket,
                    [domain as u64, LINUX_SOCK_STREAM as u64, 0, 0, 0, 0]
                )
                .unwrap(),
                SECCOMP_RET_ALLOW
            );
            assert_eq!(
                evaluate_seccomp_bpf(
                    &net_deny_filter,
                    arch,
                    sys_socket,
                    [domain as u64, LINUX_SOCK_STREAM as u64, 0, 0, 0, 0]
                )
                .unwrap(),
                SECCOMP_RET_ERRNO_EPERM
            );
        }
    }

    // 5. `socketpair`: allow ONLY AF_UNIX + SOCK_STREAM (with optional CLOEXEC | NONBLOCK);
    //    reject SOCK_DGRAM / SOCK_SEQPACKET / AF_INET with EPERM!
    for (arch, sys_socketpair) in [
        (AUDIT_ARCH_X86_64, X86_64_SYS_SOCKETPAIR),
        (AUDIT_ARCH_AARCH64, AARCH64_SYS_SOCKETPAIR),
    ] {
        for ok_type in [
            LINUX_SOCK_STREAM,
            LINUX_SOCK_STREAM | LINUX_SOCK_CLOEXEC,
            LINUX_SOCK_STREAM | LINUX_SOCK_NONBLOCK,
            LINUX_SOCK_STREAM | LINUX_SOCK_CLOEXEC | LINUX_SOCK_NONBLOCK,
        ] {
            assert_eq!(
                evaluate_seccomp_bpf(
                    &host_filter,
                    arch,
                    sys_socketpair,
                    [LINUX_AF_UNIX as u64, ok_type as u64, 0, 0, 0, 0]
                )
                .unwrap(),
                SECCOMP_RET_ALLOW
            );
        }

        for blocked_type in [LINUX_SOCK_DGRAM, LINUX_SOCK_SEQPACKET] {
            assert_eq!(
                evaluate_seccomp_bpf(
                    &host_filter,
                    arch,
                    sys_socketpair,
                    [LINUX_AF_UNIX as u64, blocked_type as u64, 0, 0, 0, 0]
                )
                .unwrap(),
                SECCOMP_RET_ERRNO_EPERM
            );
        }

        assert_eq!(
            evaluate_seccomp_bpf(
                &host_filter,
                arch,
                sys_socketpair,
                [LINUX_AF_INET as u64, LINUX_SOCK_STREAM as u64, 0, 0, 0, 0]
            )
            .unwrap(),
            SECCOMP_RET_ERRNO_EPERM
        );
    }

    // 6. Standard syscalls (`execve` = 59 on x86_64, `read` = 0, `write` = 1) -> ALLOW.
    for nr in [0, 1, 59, 257] {
        assert_eq!(
            evaluate_seccomp_bpf(&net_deny_filter, AUDIT_ARCH_X86_64, nr, [0; 6]).unwrap(),
            SECCOMP_RET_ALLOW
        );
    }
}

#[test]
fn backend_detection_caches_and_windows_bundle_integrity_work_offline() {
    reset_seatbelt_cache_for_tests();
    reset_bwrap_cache_for_tests();
    reset_windows_probe_cache_for_tests();

    // 1. Seatbelt 60s negative cooldown -> permanent positive cache.
    let calls = AtomicUsize::new(0);
    let ok_flag = std::sync::atomic::AtomicBool::new(false);
    let verifier = || {
        calls.fetch_add(1, Ordering::SeqCst);
        ok_flag.load(Ordering::SeqCst)
    };
    assert!(!has_seatbelt_with_options(SeatbeltCheckOptions {
        now_ms: Some(1_000),
        platform: Some("darwin"),
        verifier: Some(&verifier),
    }));
    assert!(!has_seatbelt_with_options(SeatbeltCheckOptions {
        now_ms: Some(30_000),
        platform: Some("darwin"),
        verifier: Some(&verifier),
    }));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    ok_flag.store(true, Ordering::SeqCst);
    assert!(has_seatbelt_with_options(SeatbeltCheckOptions {
        now_ms: Some(1_000 + SEATBELT_RETRY_COOLDOWN_MS),
        platform: Some("darwin"),
        verifier: Some(&verifier),
    }));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    ok_flag.store(false, Ordering::SeqCst);
    assert!(has_seatbelt_with_options(SeatbeltCheckOptions {
        now_ms: Some(999_999),
        platform: Some("darwin"),
        verifier: Some(&verifier),
    }));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    reset_seatbelt_cache_for_tests();

    // 2. `find_bwrap` rejects relative `COWORK_BWRAP_PATH` and ignores untrusted `PATH`;
    //    `is_bwrap_usable_with_options` honors 60s cooldown per binary path.
    let mut bad_env = HashMap::new();
    bad_env.insert("COWORK_BWRAP_PATH".to_owned(), "relative/bwrap".to_owned());
    bad_env.insert("PATH".to_owned(), "/tmp/evil-bin".to_owned());
    assert_eq!(find_bwrap(&bad_env), None);

    let bwrap_probes = AtomicUsize::new(0);
    let bwrap_ok = std::sync::atomic::AtomicBool::new(false);
    let bwrap_probe = |_: &Path| {
        bwrap_probes.fetch_add(1, Ordering::SeqCst);
        bwrap_ok.load(Ordering::SeqCst)
    };
    let fake_bwrap = Path::new("/usr/bin/bwrap");
    assert!(!is_bwrap_usable_with_options(
        fake_bwrap,
        BwrapProbeOptions {
            now_ms: Some(5_000),
            probe_fn: Some(&bwrap_probe),
        }
    ));
    assert!(!is_bwrap_usable_with_options(
        fake_bwrap,
        BwrapProbeOptions {
            now_ms: Some(25_000),
            probe_fn: Some(&bwrap_probe),
        }
    ));
    assert_eq!(bwrap_probes.load(Ordering::SeqCst), 1);
    bwrap_ok.store(true, Ordering::SeqCst);
    assert!(is_bwrap_usable_with_options(
        fake_bwrap,
        BwrapProbeOptions {
            now_ms: Some(5_000 + BWRAP_RETRY_COOLDOWN_MS),
            probe_fn: Some(&bwrap_probe),
        }
    ));
    assert_eq!(bwrap_probes.load(Ordering::SeqCst), 2);
    reset_bwrap_cache_for_tests();

    // 3. Windows unified `~/.cowork` sandbox home & PE header verification + offline probe TTL.
    let mut win_env = HashMap::new();
    win_env.insert("USERPROFILE".to_owned(), r"C:\Users\Alice".to_owned());
    win_env.insert("HOME".to_owned(), r"C:\GitBashPoisonedHome".to_owned());
    assert_eq!(
        windows_sandbox_home_for_platform(&win_env, "win32"),
        PathBuf::from(r"C:\Users\Alice\.cowork")
    );

    let (_tmp, bundle_dir) = canonical_temp_dir("cowork-win-bundle-");
    let helper = bundle_dir.join(WINDOWS_SANDBOX_HELPER_NAME);
    let setup = bundle_dir.join(WINDOWS_SANDBOX_SETUP_NAME);
    let runner = bundle_dir.join(WINDOWS_SANDBOX_COMMAND_RUNNER_NAME);

    // Minimal valid PE header (`MZ` ... `e_lfanew = 0x40` ... `PE\0\0` + `0x8664` x64).
    let mut pe_bytes = vec![0u8; 128];
    pe_bytes[0] = b'M';
    pe_bytes[1] = b'Z';
    pe_bytes[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
    pe_bytes[0x40..0x44].copy_from_slice(b"PE\0\0");
    pe_bytes[0x44..0x46].copy_from_slice(&0x8664u16.to_le_bytes());

    std::fs::write(&helper, &pe_bytes).unwrap();
    std::fs::write(&setup, b"setup-payload").unwrap();
    std::fs::write(&runner, b"runner-payload").unwrap();
    assert!(is_native_windows_binary(&helper, "x64"));
    assert!(!is_native_windows_binary(&helper, "arm64"));

    let sha_hex = |data: &[u8]| hex::encode(Sha256::digest(data));
    let mut probe_env = HashMap::new();
    probe_env.insert(
        "COWORK_WIN_SANDBOX_HOME".to_owned(),
        bundle_dir.join("sbx-home").to_string_lossy().into_owned(),
    );

    // Missing SHA-256 fails closed without spawning probe child!
    let spawns = AtomicUsize::new(0);
    let probe_runner = |_: &Path, _: &[String]| -> Result<ProbeCommandOutput, String> {
        spawns.fetch_add(1, Ordering::SeqCst);
        Ok(ProbeCommandOutput {
            exit_code: Some(0),
            signaled: false,
            stdout: r#"{"ready":true,"filesystem":true,"network":true,"process":true,"integrity":true,"setup_required":false}"#.to_owned(),
            stderr: String::new(),
        })
    };
    let missing_hash_res = probe_windows_sandbox_bundle(
        &helper,
        &probe_env,
        WindowsProbeOptions {
            now_ms: Some(1_000),
            cwd: Some(&bundle_dir),
            probe_runner: Some(&probe_runner),
            authenticode_verifier: None,
        },
    );
    assert!(!missing_hash_res.integrity);
    assert!(
        missing_hash_res
            .warning
            .as_deref()
            .unwrap_or("")
            .contains("trusted SHA-256 is missing")
    );
    assert_eq!(spawns.load(Ordering::SeqCst), 0);
    reset_windows_probe_cache_for_tests();

    // Valid SHA-256 + Authenticode verification across all 3 binaries + 30s TTL memoization.
    probe_env.insert(
        "COWORK_WIN_SANDBOX_HELPER_SHA256".to_owned(),
        sha_hex(&pe_bytes),
    );
    probe_env.insert(
        "COWORK_WIN_SANDBOX_SETUP_SHA256".to_owned(),
        sha_hex(b"setup-payload"),
    );
    probe_env.insert(
        "COWORK_WIN_SANDBOX_COMMAND_RUNNER_SHA256".to_owned(),
        sha_hex(b"runner-payload"),
    );
    probe_env.insert(
        "COWORK_WIN_SANDBOX_REQUIRE_AUTHENTICODE".to_owned(),
        "1".to_owned(),
    );

    // Fail Authenticode on 3rd binary (`codex-command-runner.exe`) -> still 0 spawns!
    let reject_third = |p: &Path| !p.ends_with(WINDOWS_SANDBOX_COMMAND_RUNNER_NAME);
    let bad_sig = probe_windows_sandbox_bundle(
        &helper,
        &probe_env,
        WindowsProbeOptions {
            now_ms: Some(2_000),
            cwd: Some(&bundle_dir),
            probe_runner: Some(&probe_runner),
            authenticode_verifier: Some(&reject_third),
        },
    );
    assert!(!bad_sig.integrity);
    assert!(
        bad_sig
            .warning
            .as_deref()
            .unwrap_or("")
            .contains("Authenticode signature is invalid for codex-command-runner.exe")
    );
    assert_eq!(spawns.load(Ordering::SeqCst), 0);
    reset_windows_probe_cache_for_tests();

    let accept_all = |_: &Path| true;
    let ok1 = probe_windows_sandbox_bundle(
        &helper,
        &probe_env,
        WindowsProbeOptions {
            now_ms: Some(10_000),
            cwd: Some(&bundle_dir),
            probe_runner: Some(&probe_runner),
            authenticode_verifier: Some(&accept_all),
        },
    );
    assert!(ok1.ready && ok1.integrity && ok1.filesystem && ok1.network && ok1.process);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);

    // Cached within 30s TTL -> no extra spawn.
    let ok2 = probe_windows_sandbox_bundle(
        &helper,
        &probe_env,
        WindowsProbeOptions {
            now_ms: Some(20_000),
            cwd: Some(&bundle_dir),
            probe_runner: Some(&probe_runner),
            authenticode_verifier: Some(&accept_all),
        },
    );
    assert_eq!(ok2, ok1);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);

    // Expired at +30s -> re-probes.
    let _ = probe_windows_sandbox_bundle(
        &helper,
        &probe_env,
        WindowsProbeOptions {
            now_ms: Some(10_000 + WINDOWS_SANDBOX_PROBE_TTL_MS),
            cwd: Some(&bundle_dir),
            probe_runner: Some(&probe_runner),
            authenticode_verifier: Some(&accept_all),
        },
    );
    assert_eq!(spawns.load(Ordering::SeqCst), 2);
    reset_windows_probe_cache_for_tests();

    // 4. Windows command builder & v5 setup marker newest-wins sync.
    let win_cmd = build_windows_sandbox_command(
        &helper,
        &SandboxCommand::new("pwsh.exe", ["-NoProfile", "-Command", "Get-Location"]),
        &SandboxPolicy::DangerFullAccess {
            network: Some(false),
        },
        &bundle_dir,
        &probe_env,
    );
    assert_eq!(win_cmd.sandbox, SandboxType::Windows);
    assert!(
        win_cmd
            .args
            .windows(2)
            .any(|w| w == ["--mode", "network-only"])
    );
    assert!(!win_cmd.args.iter().any(|a| a == "--allow-network"));

    let sbx_home = bundle_dir.join("sbx-home");
    let codex_home = bundle_dir.join("codex-home");
    let ambient_codex = bundle_dir.join(".codex");
    std::fs::create_dir_all(sbx_home.join(".sandbox")).unwrap();
    std::fs::create_dir_all(sbx_home.join(".sandbox-secrets")).unwrap();
    std::fs::create_dir_all(ambient_codex.join(".sandbox")).unwrap();
    std::fs::create_dir_all(ambient_codex.join(".sandbox-secrets")).unwrap();
    std::fs::write(
        sbx_home.join(".sandbox").join("setup_marker.json"),
        r#"{"version":5,"created_at":"2026-03-20T12:00:00Z"}"#,
    )
    .unwrap();
    std::fs::write(
        sbx_home.join(".sandbox-secrets").join("sandbox_users.json"),
        r#"{"version":5,"users":[{"username":"sbx_offline"}]}"#,
    )
    .unwrap();
    // Poisoned ambient `~/.codex` with newer timestamp MUST NEVER be read!
    std::fs::write(
        ambient_codex.join(".sandbox").join("setup_marker.json"),
        r#"{"version":5,"created_at":"2099-01-01T00:00:00Z"}"#,
    )
    .unwrap();
    std::fs::write(
        ambient_codex
            .join(".sandbox-secrets")
            .join("sandbox_users.json"),
        r#"{"version":5,"users":[{"username":"POISONED"}]}"#,
    )
    .unwrap();

    sync_codex_windows_sandbox_setup_state(&codex_home, &probe_env, Some("win32"));
    let synced_users = std::fs::read_to_string(
        codex_home
            .join(".sandbox-secrets")
            .join("sandbox_users.json"),
    )
    .unwrap();
    assert!(synced_users.contains("sbx_offline"));
    assert!(!synced_users.contains("POISONED"));
}

#[test]
fn denial_classifier_and_escalation_avoid_false_positives_and_preserve_hard_floors() {
    // 1. Non-zero exit codes 0, 124, 126, 127, 130 and bare "sandbox" strings never match.
    for code in [0, 124, 126, 127, 130] {
        assert_eq!(
            classify_sandbox_denial(
                "Operation not permitted",
                code,
                ClassifyDenialOptions {
                    network_restricted: true,
                    platform: Some("darwin"),
                }
            ),
            None
        );
    }
    assert_eq!(
        classify_sandbox_denial(
            "sandbox test runner failed: expected 2 to equal 3",
            1,
            ClassifyDenialOptions {
                network_restricted: true,
                platform: Some("darwin"),
            }
        ),
        None
    );

    // 2. SSH/Git/Docker/HTTP/sudo auth failures never misclassify as sandbox denials.
    for auth_err in [
        "git@github.com: Permission denied (publickey).",
        "HTTP 403 Forbidden",
        "permission denied while trying to connect to the Docker daemon socket",
        "sudo: a password is required",
    ] {
        assert_eq!(
            classify_sandbox_denial(
                auth_err,
                1,
                ClassifyDenialOptions {
                    network_restricted: true,
                    platform: Some("linux"),
                }
            ),
            None,
            "should ignore non-sandbox failure: {auth_err}"
        );
    }

    // 3. Network markers classify ONLY when `network_restricted == true`.
    assert_eq!(
        classify_sandbox_denial(
            "curl: (6) Could not resolve host: api.example.com",
            6,
            ClassifyDenialOptions {
                network_restricted: false,
                platform: Some("darwin"),
            }
        ),
        None
    );
    assert_eq!(
        classify_sandbox_denial(
            "curl: (6) Could not resolve host: api.example.com",
            6,
            ClassifyDenialOptions {
                network_restricted: true,
                platform: Some("darwin"),
            }
        ),
        Some(SandboxDenialCategory::Network)
    );
    assert_eq!(
        describe_sandbox_denial(SandboxDenialCategory::Network),
        "The OS sandbox blocked network access for this command."
    );

    // 4. Protected `.git`/`.cowork` write denial classifies as `Filesystem` + `ProtectedMetadata`.
    let git_denial = classify_sandbox_denial_detailed(
        "/bin/bash: /private/tmp/ws/.git/hooks/pre-commit: Operation not permitted",
        1,
        ClassifyDenialOptions {
            network_restricted: false,
            platform: Some("darwin"),
        },
    )
    .expect("protected metadata denial");
    assert_eq!(git_denial.category, SandboxDenialCategory::Filesystem);
    assert_eq!(
        git_denial.detail_kind,
        SandboxDenialDetailKind::ProtectedMetadata
    );

    // 5. Non-sandboxed user script emitting `"Operation not permitted"` MUST NEVER trigger escalation!
    let ww_no_net = SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![PathBuf::from("/private/tmp/ws")],
        writable_root_kinds: HashMap::new(),
        network: false,
    };
    assert_eq!(
        plan_sandbox_escalation(
            &ww_no_net,
            SandboxType::None,
            true,
            false,
            "",
            "custom-script.py: Operation not permitted",
            1,
            Some("darwin"),
        ),
        None
    );

    // 6. Hard floors (`ReadOnly`, `NoProjectWrite`, scoped `targetPaths`) NEVER escalate!
    assert_eq!(
        plan_sandbox_escalation(
            &SandboxPolicy::ReadOnly { network: false },
            SandboxType::Seatbelt,
            false,
            false,
            "",
            "touch: /private/tmp/x: Operation not permitted",
            1,
            Some("darwin"),
        ),
        None
    );
    assert_eq!(
        plan_sandbox_escalation(
            &ww_no_net,
            SandboxType::Seatbelt,
            false,
            true, // scoped child targetPaths!
            "",
            "touch: /private/tmp/ws/other/x: Operation not permitted",
            1,
            Some("darwin"),
        ),
        None
    );

    // 7. Eligible `WorkspaceWrite` escalation widens ONLY the denied dimension!
    let fs_plan = plan_sandbox_escalation(
        &ww_no_net,
        SandboxType::Seatbelt,
        false,
        false,
        "",
        "touch: /etc/hosts: Operation not permitted",
        1,
        Some("darwin"),
    )
    .expect("filesystem escalation plan");
    assert_eq!(fs_plan.category, SandboxDenialCategory::Filesystem);
    assert_eq!(
        fs_plan.retry_policy,
        SandboxPolicy::DangerFullAccess {
            network: Some(false) // preserves network: false!
        }
    );

    let net_plan = plan_sandbox_escalation(
        &ww_no_net,
        SandboxType::Seatbelt,
        false,
        false,
        "",
        "curl: (6) Could not resolve host: example.com",
        6,
        Some("darwin"),
    )
    .expect("network escalation plan");
    assert_eq!(net_plan.category, SandboxDenialCategory::Network);
    assert_eq!(
        net_plan.retry_policy,
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/private/tmp/ws")],
            writable_root_kinds: HashMap::new(),
            network: true, // widens network ONLY, keeping workspace-write filesystem!
        }
    );

    // 8. Pre-exec command risk classification covers POSIX + PowerShell dialects.
    let ps_danger = classify_command_detailed(
        "Remove-Item -Path ./build -Recurse -Force",
        None,
        Some("win32"),
    );
    assert_eq!(ps_danger.risk_level, CommandRiskLevel::Dangerous);
    assert_eq!(
        ps_danger.reason_code,
        CommandApprovalReasonCode::MatchesDangerousPattern
    );
    let escalated_review =
        classify_command_detailed("npm install", Some("sandbox_denied"), Some("darwin"));
    assert_eq!(escalated_review.risk_level, CommandRiskLevel::Review);
    assert_eq!(
        escalated_review.reason_code,
        CommandApprovalReasonCode::SandboxDeniedEscalation
    );
}
