use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use cowork_sandbox::{
    PARENT_MANAGED_ENV_VAR, SandboxCommand, SandboxExecutionRequest, SandboxPolicy, SandboxRunner,
    SandboxType, get_env, host_platform, minimal_sandbox_env, remove_env, set_env,
};
use regex::Regex;
use url::Url;

use crate::error::{EnvError, Result};
use crate::manifest::PreparedRuntime;
use crate::uv::UvEnvironmentPaths;

/// Ordered shell executable candidate in a `ShellExecutionPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCandidate {
    pub program: String,
    pub args: Vec<String>,
}

/// Non-login shell invocation plan (`bash -c <cmd>` on POSIX, `pwsh -NoProfile -Command <cmd>` on Windows).
///
/// Guarantees ZERO `export PATH=... &&` or prefix string mutation of `command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellExecutionPlan {
    pub program: String,
    pub args: Vec<String>,
    pub candidates: Vec<ShellCandidate>,
}

/// Inputs for constructing a canonical child tool environment map.
pub struct ShellEnvOptions<'a> {
    pub base_env: &'a HashMap<String, String>,
    pub runtime: Option<&'a PreparedRuntime>,
    pub uv_env: Option<&'a UvEnvironmentPaths>,
    pub extra_env: Option<&'a HashMap<String, String>>,
    pub platform: &'a str,
    pub sandboxed: bool,
    pub cowork_home: Option<&'a Path>,
}

/// Execution parameters for `execute_non_login_shell`.
#[derive(Debug, Clone)]
pub struct ShellExecutionOptions {
    pub command: String,
    pub cwd: PathBuf,
    pub policy: SandboxPolicy,
    pub base_env: HashMap<String, String>,
    pub runtime: Option<PreparedRuntime>,
    pub uv_env: Option<UvEnvironmentPaths>,
    pub extra_env: HashMap<String, String>,
    pub cowork_home: Option<PathBuf>,
    pub timeout: Duration,
    pub yolo: bool,
    pub require_sandbox_backend: bool,
}

/// Structured result of `execute_non_login_shell`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellExecutionOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub sandbox: SandboxType,
    pub unsandboxed: bool,
}

fn path_delimiter(platform: &str) -> char {
    if platform == "win32" { ';' } else { ':' }
}

fn dedup_path_list(entries: impl IntoIterator<Item = String>, platform: &str) -> String {
    let delim = path_delimiter(platform);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in entries {
        for part in raw.split(delim) {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let key = if platform == "win32" {
                trimmed.to_ascii_lowercase()
            } else {
                trimmed.to_owned()
            };
            if seen.insert(key) {
                out.push(trimmed.to_owned());
            }
        }
    }
    out.join(&delim.to_string())
}

fn append_node_option_import(existing: Option<&str>, resolver_path: &Path) -> String {
    let file_url = Url::from_file_path(resolver_path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", resolver_path.to_string_lossy()));
    let import_flag = format!("--import={file_url}");
    let current = existing.map(str::trim).unwrap_or("");
    if current.is_empty() {
        import_flag
    } else if current.contains(&import_flag) {
        current.to_owned()
    } else {
        format!("{import_flag} {current}")
    }
}

/// Builds the canonical, secret-stripped child tool environment map (`PATH`, `NODE_PATH`,
/// `NODE_OPTIONS`, `UV_*`, `COWORK_RUNTIME_*`, and `COWORK_DESKTOP_PARENT_MANAGED` stripped).
pub fn build_canonical_shell_env(opts: ShellEnvOptions<'_>) -> HashMap<String, String> {
    let mut env = if opts.sandboxed {
        minimal_sandbox_env(opts.base_env, opts.platform)
    } else {
        let mut cloned = opts.base_env.clone();
        remove_env(&mut cloned, PARENT_MANAGED_ENV_VAR, opts.platform);
        cloned
    };

    if let Some(extra) = opts.extra_env {
        for (k, v) in extra {
            if !k.eq_ignore_ascii_case(PARENT_MANAGED_ENV_VAR) {
                set_env(&mut env, k, v.clone(), opts.platform);
            }
        }
    }

    let mut path_parts: Vec<String> = Vec::new();

    if let Some(uv) = opts.uv_env
        && let Some(venv_bin) = &uv.venv_bin_dir
    {
        path_parts.push(venv_bin.to_string_lossy().into_owned());
    }

    if let Some(rt) = opts.runtime {
        path_parts.push(rt.paths.bin.to_string_lossy().into_owned());
        if let Some(node_dir) = rt.paths.node.parent() {
            path_parts.push(node_dir.to_string_lossy().into_owned());
        }
        if let Some(py_dir) = rt.paths.python.parent() {
            path_parts.push(py_dir.to_string_lossy().into_owned());
            if opts.platform == "win32" {
                path_parts.push(py_dir.join("Scripts").to_string_lossy().into_owned());
            }
        }
        if let Some(git_bin) = rt.paths.git.as_ref().and_then(|g| g.parent()) {
            path_parts.push(git_bin.to_string_lossy().into_owned());
        }
        if let Some(poppler_bin) = &rt.paths.poppler_bin {
            path_parts.push(poppler_bin.to_string_lossy().into_owned());
        }

        // Explicitly strip LibreOffice's private `program` dir if inherited on PATH (`repo-contracts.md`).
        let forbidden_lo_program = rt
            .paths
            .libreoffice_binary
            .as_ref()
            .and_then(|b| b.parent())
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|| {
                rt.paths
                    .libreoffice
                    .as_ref()
                    .map(|lo| lo.join("program").to_string_lossy().into_owned())
            });

        if let Some(inherited) = get_env(&env, "PATH", opts.platform) {
            let delim = path_delimiter(opts.platform);
            for entry in inherited.split(delim) {
                if let Some(forbid) = &forbidden_lo_program {
                    let matches_forbid = if opts.platform == "win32" {
                        entry.trim().eq_ignore_ascii_case(forbid)
                    } else {
                        entry.trim() == forbid
                    };
                    if matches_forbid {
                        continue;
                    }
                }
                path_parts.push(entry.to_owned());
            }
        } else if opts.platform != "win32" {
            path_parts.push("/usr/bin:/bin".to_owned());
        }

        set_env(
            &mut env,
            "PATH",
            dedup_path_list(path_parts, opts.platform),
            opts.platform,
        );

        let mut node_paths = vec![
            rt.paths.node_modules.to_string_lossy().into_owned(),
            rt.paths
                .node_modules
                .join(".pnpm")
                .join("node_modules")
                .to_string_lossy()
                .into_owned(),
        ];
        if let Some(existing_np) = get_env(&env, "NODE_PATH", opts.platform) {
            node_paths.push(existing_np.to_owned());
        }
        set_env(
            &mut env,
            "NODE_PATH",
            dedup_path_list(node_paths, opts.platform),
            opts.platform,
        );

        let next_node_opts = append_node_option_import(
            get_env(&env, "NODE_OPTIONS", opts.platform),
            &rt.paths.node_resolver,
        );
        set_env(&mut env, "NODE_OPTIONS", next_node_opts, opts.platform);

        set_env(
            &mut env,
            "COWORK_RUNTIME_DIR",
            rt.root_dir.to_string_lossy().into_owned(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_VERSION",
            rt.version.clone(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_ASSET",
            rt.asset.clone(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_BIN",
            rt.paths.bin.to_string_lossy().into_owned(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_NODE",
            rt.paths.node.to_string_lossy().into_owned(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_PYTHON",
            rt.paths.python.to_string_lossy().into_owned(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_NODE_MODULES",
            rt.paths.node_modules.to_string_lossy().into_owned(),
            opts.platform,
        );
        set_env(
            &mut env,
            "COWORK_RUNTIME_NODE_RESOLVER",
            rt.paths.node_resolver.to_string_lossy().into_owned(),
            opts.platform,
        );
        if !rt.installed_packs.is_empty() {
            set_env(
                &mut env,
                "COWORK_RUNTIME_PACKS",
                rt.installed_packs.join(","),
                opts.platform,
            );
        }
        if let Some(git) = &rt.paths.git {
            set_env(
                &mut env,
                "COWORK_RUNTIME_GIT",
                git.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(poppler_bin) = &rt.paths.poppler_bin {
            set_env(
                &mut env,
                "COWORK_RUNTIME_POPPLER_BIN",
                poppler_bin.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(pdftoppm) = &rt.paths.pdftoppm {
            set_env(
                &mut env,
                "COWORK_RUNTIME_PDFTOPPM",
                pdftoppm.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(soffice) = &rt.paths.soffice {
            set_env(
                &mut env,
                "COWORK_RUNTIME_SOFFICE",
                soffice.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(lo_dir) = &rt.paths.libreoffice {
            set_env(
                &mut env,
                "COWORK_RUNTIME_LIBREOFFICE_DIR",
                lo_dir.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(lo_bin) = &rt.paths.libreoffice_binary {
            set_env(
                &mut env,
                "COWORK_RUNTIME_LIBREOFFICE_BINARY",
                lo_bin.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(uv_bin) = &rt.paths.uv {
            set_env(
                &mut env,
                "COWORK_RUNTIME_UV",
                uv_bin.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if let Some(wh) = &rt.paths.wheelhouse {
            set_env(
                &mut env,
                "COWORK_RUNTIME_WHEELHOUSE",
                wh.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
    } else if !path_parts.is_empty() {
        if let Some(inherited) = get_env(&env, "PATH", opts.platform) {
            path_parts.push(inherited.to_owned());
        } else if opts.platform != "win32" {
            path_parts.push("/usr/bin:/bin".to_owned());
        }
        set_env(
            &mut env,
            "PATH",
            dedup_path_list(path_parts, opts.platform),
            opts.platform,
        );
    }

    set_env(
        &mut env,
        "SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION",
        "1".to_owned(),
        opts.platform,
    );

    // Configure `UV_*` environment variables canonically.
    let resolved_uv_cache = opts
        .uv_env
        .map(|u| u.cache_dir.clone())
        .or_else(|| opts.cowork_home.map(|h| h.join("cache").join("uv")));
    if let Some(cache_dir) = resolved_uv_cache {
        set_env(
            &mut env,
            "UV_CACHE_DIR",
            cache_dir.to_string_lossy().into_owned(),
            opts.platform,
        );
    }
    set_env(
        &mut env,
        "UV_PYTHON_PREFERENCE",
        "only-system".to_owned(),
        opts.platform,
    );
    set_env(
        &mut env,
        "UV_NO_MANAGED_PYTHON",
        "1".to_owned(),
        opts.platform,
    );
    set_env(
        &mut env,
        "UV_PYTHON_DOWNLOADS",
        "never".to_owned(),
        opts.platform,
    );

    if let Some(uv) = opts.uv_env {
        set_env(
            &mut env,
            "UV_PYTHON",
            uv.python_executable.to_string_lossy().into_owned(),
            opts.platform,
        );
        if let Some(venv_dir) = &uv.venv_dir {
            set_env(
                &mut env,
                "VIRTUAL_ENV",
                venv_dir.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
        if uv.offline {
            set_env(&mut env, "UV_OFFLINE", "1".to_owned(), opts.platform);
            set_env(&mut env, "UV_NO_INDEX", "1".to_owned(), opts.platform);
        }
        if let Some(wh) = &uv.wheelhouse_dir {
            set_env(
                &mut env,
                "UV_FIND_LINKS",
                wh.to_string_lossy().into_owned(),
                opts.platform,
            );
        }
    } else if let Some(rt) = opts.runtime {
        set_env(
            &mut env,
            "UV_PYTHON",
            rt.paths.python.to_string_lossy().into_owned(),
            opts.platform,
        );
    }

    remove_env(&mut env, PARENT_MANAGED_ENV_VAR, opts.platform);
    env
}

fn find_unix_executable_in_path(name: &str, path_var: Option<&str>) -> Option<String> {
    let path_str = path_var?;
    for dir in path_str.split(':') {
        if dir.trim().is_empty() {
            continue;
        }
        let candidate = Path::new(dir.trim()).join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Builds a clean non-login shell execution plan (`bash -c <command>` on Unix,
/// `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <command>` on Windows)
/// with ZERO `export PATH=... &&` or prefix string mutation.
pub fn build_non_login_shell_plan(
    command: &str,
    env: &HashMap<String, String>,
    platform: &str,
) -> ShellExecutionPlan {
    if platform == "win32" {
        let args = vec![
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-ExecutionPolicy".to_owned(),
            "Bypass".to_owned(),
            "-Command".to_owned(),
            command.to_owned(),
        ];
        let candidates = vec![
            ShellCandidate {
                program: "pwsh".to_owned(),
                args: args.clone(),
            },
            ShellCandidate {
                program: "powershell.exe".to_owned(),
                args: args.clone(),
            },
        ];
        return ShellExecutionPlan {
            program: candidates[0].program.clone(),
            args,
            candidates,
        };
    }

    let path_var = get_env(env, "PATH", platform);
    let primary_bash = if Path::new("/bin/bash").is_file() {
        "/bin/bash".to_owned()
    } else {
        find_unix_executable_in_path("bash", path_var).unwrap_or_else(|| "bash".to_owned())
    };

    let args = vec!["-c".to_owned(), command.to_owned()];
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for prog in [primary_bash.as_str(), "/bin/bash", "bash", "/bin/sh", "sh"] {
        if seen.insert(prog.to_owned()) {
            candidates.push(ShellCandidate {
                program: prog.to_owned(),
                args: args.clone(),
            });
        }
    }

    ShellExecutionPlan {
        program: candidates[0].program.clone(),
        args,
        candidates,
    }
}

/// Executes a command via `SandboxRunner` using a clean non-login shell (`bash -c` / `pwsh -NoProfile`)
/// and canonical secret-stripped environment map.
pub async fn execute_non_login_shell(
    runner: &SandboxRunner,
    opts: ShellExecutionOptions,
) -> Result<ShellExecutionOutput> {
    let platform = host_platform();
    let canonical_env = build_canonical_shell_env(ShellEnvOptions {
        base_env: &opts.base_env,
        runtime: opts.runtime.as_ref(),
        uv_env: opts.uv_env.as_ref(),
        extra_env: Some(&opts.extra_env),
        platform,
        sandboxed: !opts.yolo,
        cowork_home: opts.cowork_home.as_deref(),
    });
    let plan = build_non_login_shell_plan(&opts.command, &canonical_env, platform);

    let mut req = SandboxExecutionRequest::new(
        SandboxCommand::new(plan.program, plan.args),
        opts.policy,
        &opts.cwd,
    );
    req.yolo = opts.yolo;
    req.require_backend = opts.require_sandbox_backend;
    req.timeout = Some(opts.timeout);
    req.env_source = Some(canonical_env.clone());
    req.extra_env = canonical_env;

    let res = runner
        .run_with_approval(
            req,
            None,
            None::<fn(Option<&str>) -> std::future::Ready<bool>>,
        )
        .await;
    if let Some(code) = res.error_code {
        return Err(EnvError::ShellFailed(format!(
            "Sandboxed shell failed ({code:?}): {}",
            res.stderr
        )));
    }

    Ok(ShellExecutionOutput {
        stdout: res.stdout,
        stderr: res.stderr,
        exit_code: Some(res.exit_code),
        sandbox: res.sandbox,
        unsandboxed: res.unsandboxed,
    })
}

fn secret_regexes() -> &'static Vec<(Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
                    .unwrap(),
                "[REDACTED_PRIVATE_KEY]",
            ),
            (
                Regex::new(r"([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+:)([^@\s/]+)(@)").unwrap(),
                "${1}[REDACTED]${3}",
            ),
            (
                Regex::new(r"(?i)\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)([^\s,;]+)").unwrap(),
                "${1}[REDACTED]",
            ),
            (
                Regex::new(r"(?i)\b(Bearer\s+)(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})")
                    .unwrap(),
                "${1}[REDACTED]",
            ),
            (
                Regex::new(r"\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b").unwrap(),
                "[REDACTED]",
            ),
            (
                Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b")
                    .unwrap(),
                "[REDACTED]",
            ),
            (
                Regex::new(r"(?i)\b([A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PASSWD)[A-Z0-9_]*\s*=\s*)([^\s&]+)")
                    .unwrap(),
                "${1}[REDACTED]",
            ),
        ]
    })
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    const SAFE_SUFFIXES: &[&str] = &[
        "COWORK_RUNTIME_DIR",
        "COWORK_RUNTIME_VERSION",
        "COWORK_RUNTIME_ASSET",
        "COWORK_RUNTIME_BIN",
        "COWORK_RUNTIME_NODE",
        "COWORK_RUNTIME_PYTHON",
    ];
    if SAFE_SUFFIXES.contains(&upper.as_str()) {
        return false;
    }
    [
        "API_KEY",
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "SENTRY_DSN",
        "AUTH",
    ]
    .iter()
    .any(|marker| upper.contains(marker))
}

/// Redacts credentials, API keys, cloud tokens, URL passwords, and PEM keys from free-form text.
pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_owned();
    for (re, replacement) in secret_regexes() {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Produces a sorted diagnostics snapshot of an environment map with sensitive keys/values redacted.
pub fn redact_env_for_diagnostics(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in env {
        if is_sensitive_env_key(k) {
            out.insert(k.clone(), "[REDACTED]".to_owned());
        } else {
            out.insert(k.clone(), redact_secrets(v));
        }
    }
    out
}
