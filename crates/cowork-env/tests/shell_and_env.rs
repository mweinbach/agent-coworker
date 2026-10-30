use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_env::{
    PreparedRuntime, RuntimePaths, ShellEnvOptions, ShellExecutionOptions, UvEnvironmentPaths,
    build_canonical_shell_env, build_non_login_shell_plan, execute_non_login_shell,
    redact_env_for_diagnostics, redact_secrets,
};
use cowork_sandbox::{SandboxPolicy, SandboxRunner, scratch_roots, with_tmp_scratch};
use tempfile::TempDir;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create tempdir in /private/tmp");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

#[test]
fn non_login_shell_plan_uses_bash_dash_c_on_unix_and_pwsh_noprofile_on_windows_without_mutating_command()
 {
    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());

    let raw_cmd =
        "set -euo pipefail\ncat <<'EOF'\nexport PATH=/untouched\nhello $0 $@\nEOF\necho done";

    let unix_plan = build_non_login_shell_plan(raw_cmd, &env, "darwin");
    assert!(
        unix_plan.program.ends_with("bash"),
        "expected bash program on Unix, got {}",
        unix_plan.program
    );
    assert_eq!(unix_plan.args, vec!["-c".to_owned(), raw_cmd.to_owned()]);
    assert!(
        !unix_plan.args.iter().any(|a| a == "-lc" || a == "--login"),
        "non-login shell must never pass -lc or --login"
    );
    assert!(
        !unix_plan.args[1].contains("export PATH='"),
        "command string must not be prefixed with export PATH=..."
    );
    for candidate in &unix_plan.candidates {
        assert_eq!(candidate.args, vec!["-c".to_owned(), raw_cmd.to_owned()]);
    }

    let mut win_env = HashMap::new();
    win_env.insert(
        "Path".to_owned(),
        r"C:\Program Files\PowerShell\7;C:\Windows\System32".to_owned(),
    );
    let win_plan = build_non_login_shell_plan(raw_cmd, &win_env, "win32");
    assert!(
        win_plan.program.eq_ignore_ascii_case("pwsh")
            || win_plan.program.to_ascii_lowercase().ends_with("pwsh.exe"),
        "expected pwsh primary candidate on Windows, got {}",
        win_plan.program
    );
    assert_eq!(
        win_plan.args,
        vec![
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-ExecutionPolicy".to_owned(),
            "Bypass".to_owned(),
            "-Command".to_owned(),
            raw_cmd.to_owned(),
        ]
    );
}

#[test]
fn canonical_shell_env_strips_secrets_and_injects_runtime_and_uv_vars_without_libreoffice_program_on_path()
 {
    let (_tmp, root) = canonical_temp_dir("cowork-shell-env-");
    let home = root.join("home");
    let rt_dir = root.join("runtime");
    let node_resolver = rt_dir.join("cowork/node-resolver/register.mjs");
    std::fs::create_dir_all(node_resolver.parent().unwrap()).unwrap();
    std::fs::write(&node_resolver, "// resolver\n").unwrap();

    let runtime = PreparedRuntime {
        version: "2026-06-22".to_owned(),
        asset: "darwin-arm64".to_owned(),
        root_dir: rt_dir.clone(),
        installed_packs: vec![
            "core".to_owned(),
            "python-wheels".to_owned(),
            "libreoffice".to_owned(),
        ],
        paths: RuntimePaths {
            bin: rt_dir.join("dependencies/bin"),
            node: rt_dir.join("dependencies/node/bin/node"),
            python: rt_dir.join("dependencies/python/bin/python3"),
            git: Some(rt_dir.join("dependencies/git/bin/git")),
            node_modules: rt_dir.join("node_modules"),
            node_resolver,
            poppler_bin: Some(rt_dir.join("dependencies/poppler/bin")),
            pdftoppm: Some(rt_dir.join("dependencies/poppler/bin/pdftoppm")),
            libreoffice: Some(rt_dir.join("dependencies/libreoffice")),
            soffice: Some(rt_dir.join("dependencies/bin/soffice")),
            libreoffice_binary: Some(rt_dir.join("dependencies/libreoffice/program/soffice")),
            uv: Some(rt_dir.join("dependencies/bin/uv")),
            wheelhouse: Some(rt_dir.join("wheels")),
        },
    };

    let venv_dir = root.join("ephemeral-venv");
    let uv_env = UvEnvironmentPaths {
        cache_dir: home.join(".cowork/cache/uv"),
        venv_dir: Some(venv_dir.clone()),
        venv_bin_dir: Some(venv_dir.join("bin")),
        python_executable: venv_dir.join("bin/python3"),
        offline: true,
        wheelhouse_dir: Some(rt_dir.join("wheels")),
    };

    let mut host_env = HashMap::new();
    host_env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    host_env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    host_env.insert(
        "OPENAI_API_KEY".to_owned(),
        "sk-proj-secret1234567890abcdefghijklmnop".to_owned(),
    );
    host_env.insert(
        "ANTHROPIC_API_KEY".to_owned(),
        "sk-ant-api03-secret1234567890abcdefgh".to_owned(),
    );
    host_env.insert(
        "AWS_SECRET_ACCESS_KEY".to_owned(),
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_owned(),
    );
    host_env.insert(
        "GITHUB_TOKEN".to_owned(),
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz".to_owned(),
    );
    host_env.insert("UV_PUBLISH_TOKEN".to_owned(), "uv-pub-secret".to_owned());
    host_env.insert("COWORK_DESKTOP_PARENT_MANAGED".to_owned(), "1".to_owned());

    let built = build_canonical_shell_env(ShellEnvOptions {
        base_env: &host_env,
        runtime: Some(&runtime),
        uv_env: Some(&uv_env),
        extra_env: None,
        platform: "darwin",
        sandboxed: true,
        cowork_home: Some(&home.join(".cowork")),
    });

    // Host secrets and parent-managed marker must never survive into child env.
    for forbidden in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "UV_PUBLISH_TOKEN",
        "COWORK_DESKTOP_PARENT_MANAGED",
    ] {
        assert!(
            !built.contains_key(forbidden),
            "forbidden var {forbidden} leaked into canonical shell env"
        );
    }

    // Canonical runtime pointers & UV_* must be present.
    assert_eq!(
        built.get("COWORK_RUNTIME_VERSION").map(String::as_str),
        Some("2026-06-22")
    );
    assert_eq!(
        built.get("COWORK_RUNTIME_SOFFICE").map(String::as_str),
        Some(
            rt_dir
                .join("dependencies/bin/soffice")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        built.get("UV_CACHE_DIR").map(String::as_str),
        Some(home.join(".cowork/cache/uv").to_string_lossy().as_ref())
    );
    assert_eq!(
        built.get("VIRTUAL_ENV").map(String::as_str),
        Some(venv_dir.to_string_lossy().as_ref())
    );
    assert_eq!(
        built.get("UV_NO_MANAGED_PYTHON").map(String::as_str),
        Some("1")
    );
    assert_eq!(built.get("UV_OFFLINE").map(String::as_str), Some("1"));
    assert!(
        built
            .get("NODE_OPTIONS")
            .expect("NODE_OPTIONS")
            .contains("--import=file://")
    );
    assert!(
        built
            .get("NODE_PATH")
            .expect("NODE_PATH")
            .contains(&rt_dir.join("node_modules").to_string_lossy().into_owned())
    );

    // PATH order: ephemeral venv bin first, runtime dirs next, and NEVER LibreOffice's private program dir.
    let path_entries: Vec<&str> = built.get("PATH").expect("PATH").split(':').collect();
    assert_eq!(path_entries[0], venv_dir.join("bin").to_string_lossy());
    assert!(path_entries.contains(&rt_dir.join("dependencies/bin").to_string_lossy().as_ref()));
    assert!(
        path_entries.contains(
            &rt_dir
                .join("dependencies/poppler/bin")
                .to_string_lossy()
                .as_ref()
        )
    );
    let lo_program = rt_dir
        .join("dependencies/libreoffice/program")
        .to_string_lossy()
        .into_owned();
    assert!(
        !path_entries.iter().any(|entry| *entry == lo_program),
        "LibreOffice private program dir must never be placed on PATH"
    );
}

#[tokio::test]
async fn execute_non_login_shell_ignores_bash_profile_preserves_heredocs_and_strips_secrets() {
    let (_tmp, root) = canonical_temp_dir("cowork-shell-exec-");
    let fake_home = root.join("home");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&fake_home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();

    // Plant polluted login profile scripts in fake HOME to prove non-login `bash -c` never sources them.
    for profile in [
        ".bash_profile",
        ".profile",
        ".bashrc",
        ".zprofile",
        ".zshrc",
    ] {
        std::fs::write(
            fake_home.join(profile),
            "export PATH=/polluted-from-login-profile:$PATH\nexport PROFILE_POLLUTED=yes\n",
        )
        .unwrap();
    }

    let mut host_env = HashMap::new();
    host_env.insert("HOME".to_owned(), fake_home.to_string_lossy().into_owned());
    host_env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    host_env.insert(
        "OPENAI_API_KEY".to_owned(),
        "sk-live-supersecret1234567890abcdef".to_owned(),
    );
    host_env.insert(
        "ANTHROPIC_API_KEY".to_owned(),
        "sk-ant-supersecret1234567890abcdef".to_owned(),
    );
    host_env.insert(
        "AWS_SECRET_ACCESS_KEY".to_owned(),
        "aws-secret-value-1234567890".to_owned(),
    );
    host_env.insert("COWORK_DESKTOP_PARENT_MANAGED".to_owned(), "1".to_owned());

    let policy = SandboxPolicy::WorkspaceWrite {
        writable_roots: with_tmp_scratch(std::slice::from_ref(&workspace), &scratch_roots(None)),
        writable_root_kinds: HashMap::new(),
        network: false,
    };
    let runner = SandboxRunner::default();

    let script = r#"set -euo pipefail
echo "ARG0=$0"
echo "POLLUTED=${PROFILE_POLLUTED:-clean}"
echo "OPENAI=${OPENAI_API_KEY:-stripped}"
echo "ANTHROPIC=${ANTHROPIC_API_KEY:-stripped}"
echo "AWS=${AWS_SECRET_ACCESS_KEY:-stripped}"
echo "PARENT=${COWORK_DESKTOP_PARENT_MANAGED:-stripped}"
echo "PATH=$PATH"
cat <<'HEREDOC_END'
line1 $UNEXPANDED_VAR
export PATH=/literal-inside-heredoc
HEREDOC_END
"#;

    let res = execute_non_login_shell(
        &runner,
        ShellExecutionOptions {
            command: script.to_owned(),
            cwd: workspace.clone(),
            policy,
            base_env: host_env,
            runtime: None,
            uv_env: None,
            extra_env: HashMap::new(),
            cowork_home: Some(fake_home.join(".cowork")),
            timeout: Duration::from_secs(10),
            yolo: false,
            require_sandbox_backend: true,
        },
    )
    .await
    .expect("execute non-login shell");

    assert_eq!(res.exit_code, Some(0), "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("POLLUTED=clean"),
        "stdout: {}",
        res.stdout
    );
    assert!(
        !res.stdout.contains("/polluted-from-login-profile"),
        "login profile polluted PATH: {}",
        res.stdout
    );
    assert!(res.stdout.contains("OPENAI=stripped"));
    assert!(res.stdout.contains("ANTHROPIC=stripped"));
    assert!(res.stdout.contains("AWS=stripped"));
    assert!(res.stdout.contains("PARENT=stripped"));
    assert!(
        res.stdout
            .contains("line1 $UNEXPANDED_VAR\nexport PATH=/literal-inside-heredoc")
    );
}

#[test]
fn secret_redaction_scrubs_tokens_keys_and_env_diagnostics() {
    let raw = concat!(
        "Error calling https://user:my_pass_123@api.example.com/v1 with ",
        "Authorization: Bearer sk-proj-1234567890abcdefghijklmnop and ",
        "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop ",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ",
        "ghp_abcdefghijklmnopqrstuvwxyz123456"
    );
    let redacted = redact_secrets(raw);
    assert!(!redacted.contains("my_pass_123"), "redacted={redacted}");
    assert!(
        !redacted.contains("sk-proj-1234567890abcdefghijklmnop"),
        "redacted={redacted}"
    );
    assert!(
        !redacted.contains("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
        "redacted={redacted}"
    );
    assert!(
        !redacted.contains("ghp_abcdefghijklmnopqrstuvwxyz123456"),
        "redacted={redacted}"
    );

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert(
        "ANTHROPIC_API_KEY".to_owned(),
        "sk-ant-secret-value".to_owned(),
    );
    env.insert("CUSTOM_DB_PASSWORD".to_owned(), "hunter2-secret".to_owned());
    let diag = redact_env_for_diagnostics(&env);
    assert_eq!(diag.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
    assert_eq!(
        diag.get("ANTHROPIC_API_KEY").map(String::as_str),
        Some("[REDACTED]")
    );
    assert_eq!(
        diag.get("CUSTOM_DB_PASSWORD").map(String::as_str),
        Some("[REDACTED]")
    );
}
