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

/// Script file an oversized Windows command ships as (`pwsh -File <path>`). The executor writes
/// `content` (UTF-8 BOM already embedded) before spawning and deletes it afterwards; every
/// candidate of one plan shares the same script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellTempScript {
    pub path: PathBuf,
    pub content: String,
}

/// Non-login shell invocation plan (`bash -c <cmd>` on POSIX; on Windows
/// `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(utf16le)>`
/// falling back to `powershell.exe`, or `-File <temp script>` for oversized commands).
///
/// Guarantees ZERO `export PATH=... &&` or prefix string mutation of `command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellExecutionPlan {
    pub program: String,
    pub args: Vec<String>,
    pub candidates: Vec<ShellCandidate>,
    /// The original command, for logs/UI (`args` may carry an opaque `-EncodedCommand` payload).
    pub display_command: String,
    pub temp_script: Option<ShellTempScript>,
}

/// Optional inputs for [`build_non_login_shell_plan_with`] (TS `{ tempDir, scriptId }`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ShellPlanOptions<'a> {
    /// Directory for oversized Windows temp scripts (default: `std::env::temp_dir()`).
    pub temp_dir: Option<&'a str>,
    /// Temp script id (default: a random UUID).
    pub script_id: Option<&'a str>,
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
    /// Credential paths the command may neither read nor write under the OS sandbox (see
    /// `cowork_tools::protected_credential_roots`, `SandboxExecutionRequest::read_denied_roots`).
    pub read_denied_roots: Vec<PathBuf>,
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

/// UTF-8 output pin for both pwsh 7 and Windows PowerShell 5.1 (TS `encodingPrelude`), so child
/// output decodes identically to POSIX platforms. `[Console]::OutputEncoding` can throw in
/// consoleless hosts, hence the try/catch; `PYTHONUTF8` makes Python children emit UTF-8.
/// Empty on POSIX (UTF-8 is ambient there).
pub fn powershell_encoding_prelude(platform: &str) -> &'static str {
    if platform != "win32" {
        return "";
    }
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; \
     $OutputEncoding = [System.Text.Encoding]::UTF8; \
     $env:PYTHONUTF8 = '1'"
}

/// Exit-code contract (TS `POWERSHELL_EXIT_CODE_GUARD`, matching GitHub Actions' PowerShell
/// wrapper): if any native command ran, the shell exits with the LAST native command's exit code,
/// even when a cmdlet ran afterwards. Cmdlet-only scripts exit 0, or 1 when PowerShell reports a
/// terminating error. 5.1-safe (no `??`).
pub const POWERSHELL_EXIT_CODE_GUARD: &str =
    r"if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }";

/// CreateProcess caps the command line at 32,767 UTF-16 units. `-EncodedCommand` is
/// base64(UTF-16LE), about 2.67x the script's length, so scripts whose encoding exceeds this
/// switch to a temp-file `-File` transport (TS `WIN32_ENCODED_COMMAND_LIMIT`).
pub const WIN32_ENCODED_COMMAND_LIMIT: usize = 30_000;

const POWERSHELL_BASE_ARGS: [&str; 4] = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
];

/// The full PowerShell script for `command`: encoding prelude, the command, the exit-code guard.
pub fn powershell_script(command: &str) -> String {
    format!(
        "{}\n{command}\n{POWERSHELL_EXIT_CODE_GUARD}",
        powershell_encoding_prelude("win32")
    )
}

/// `-EncodedCommand` payload: base64 of the script's UTF-16LE bytes.
pub fn powershell_encoded_command(script: &str) -> String {
    let utf16le: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    data_encoding::BASE64.encode(&utf16le)
}

/// `path.win32.join(dir, name)` for a temp-script file name.
fn win32_join(dir: &str, name: &str) -> String {
    let normalized = dir.replace('/', "\\");
    let trimmed = normalized.trim_end_matches('\\');
    if trimmed.is_empty() {
        if normalized.is_empty() {
            name.to_owned()
        } else {
            format!("\\{name}")
        }
    } else {
        format!("{trimmed}\\{name}")
    }
}

/// Builds a clean non-login shell execution plan (`bash -c <command>` on Unix; on Windows the TS
/// `buildPlatformShellExecutionPlan` transport) with ZERO `export PATH=... &&` or prefix string
/// mutation of the model-authored command.
pub fn build_non_login_shell_plan(
    command: &str,
    env: &HashMap<String, String>,
    platform: &str,
) -> ShellExecutionPlan {
    build_non_login_shell_plan_with(command, env, platform, ShellPlanOptions::default())
}

/// [`build_non_login_shell_plan`] with an explicit temp directory / script id (tests).
///
/// Windows (TS `buildPlatformShellExecutionPlan`): the command crosses exactly one PowerShell
/// interpretation layer via `-EncodedCommand base64(utf16le(script))`, so embedded quotes,
/// backticks and `$` survive byte-exact. The script is wrapped with the UTF-8 encoding prelude and
/// the `$LASTEXITCODE` guard. Scripts too large for the CreateProcess command-line ceiling ship as
/// a BOM-prefixed `-File` temp script instead (see [`ShellTempScript`]). Candidates: `pwsh`, then
/// `powershell.exe`.
pub fn build_non_login_shell_plan_with(
    command: &str,
    env: &HashMap<String, String>,
    platform: &str,
    opts: ShellPlanOptions<'_>,
) -> ShellExecutionPlan {
    if platform == "win32" {
        let script = powershell_script(command);
        let encoded = powershell_encoded_command(&script);
        let mut args: Vec<String> = POWERSHELL_BASE_ARGS
            .iter()
            .map(|a| (*a).to_owned())
            .collect();
        let temp_script = if encoded.len() <= WIN32_ENCODED_COMMAND_LIMIT {
            args.push("-EncodedCommand".to_owned());
            args.push(encoded);
            None
        } else {
            let script_id = opts
                .script_id
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let default_temp_dir;
            let temp_dir = match opts.temp_dir {
                Some(dir) => dir,
                None => {
                    default_temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
                    default_temp_dir.as_str()
                }
            };
            let path = win32_join(temp_dir, &format!("cowork-shell-{script_id}.ps1"));
            args.push("-File".to_owned());
            args.push(path.clone());
            Some(ShellTempScript {
                path: PathBuf::from(path),
                content: format!("\u{feff}{script}"),
            })
        };
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
            display_command: command.to_owned(),
            temp_script,
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
        display_command: command.to_owned(),
        temp_script: None,
    }
}

const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// TS `exec.executableCandidates`: win32 tries the bare name first, then PATHEXT extensions
/// (lowercased, in order); POSIX tries only the name.
fn executable_name_candidates(
    name: &str,
    env: &HashMap<String, String>,
    platform: &str,
) -> Vec<String> {
    if platform != "win32" {
        return vec![name.to_owned()];
    }
    let raw = get_env(env, "PATHEXT", platform)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT);
    let mut seen = HashSet::from([name.to_ascii_lowercase()]);
    let mut out = vec![name.to_owned()];
    for part in raw.split(';') {
        let ext = part.trim().to_ascii_lowercase();
        if ext.is_empty() {
            continue;
        }
        let ext = if ext.starts_with('.') {
            ext
        } else {
            format!(".{ext}")
        };
        let candidate = format!("{name}{ext}");
        if seen.insert(candidate.to_ascii_lowercase()) {
            out.push(candidate);
        }
    }
    out
}

fn is_absolute_for(name: &str, platform: &str) -> bool {
    if platform == "win32" {
        let bytes = name.as_bytes();
        name.starts_with('\\')
            || name.starts_with('/')
            || (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'\\' || bytes[2] == b'/'))
    } else {
        name.starts_with('/')
    }
}

fn join_for(dir: &str, name: &str, platform: &str) -> String {
    if platform == "win32" {
        win32_join(dir, name)
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// TS `exec.which`: resolves `name` against the child env's `PATH` (plus `PATHEXT` on win32).
fn which_with(
    name: &str,
    env: &HashMap<String, String>,
    platform: &str,
    exists: &dyn Fn(&str) -> bool,
) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let has_separator = name.contains('/') || (platform == "win32" && name.contains('\\'));
    if is_absolute_for(name, platform) || has_separator {
        return executable_name_candidates(name, env, platform)
            .into_iter()
            .find(|c| exists(c));
    }
    let names = executable_name_candidates(name, env, platform);
    let path_value = get_env(env, "PATH", platform)?;
    for entry in path_value.split(path_delimiter(platform)) {
        let dir = entry.trim();
        let dir = if platform == "win32" {
            dir.trim_matches('"')
        } else {
            dir
        };
        if dir.is_empty() {
            continue;
        }
        for candidate in &names {
            let full = join_for(dir, candidate, platform);
            if exists(&full) {
                return Some(full);
            }
        }
    }
    None
}

fn is_batch_shim(path: &str, platform: &str) -> bool {
    if platform != "win32" {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

fn default_executable_exists(path: &str) -> bool {
    let p = Path::new(path);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Picks the shell candidate to spawn, like TS bash.ts: every candidate is resolved through
/// `which` against the child env, candidates resolving to a `.cmd`/`.bat` shim are skipped (a
/// shell-less spawn cannot run them), and the first resolved candidate wins with its absolute
/// path, so a missing `pwsh` falls back to `powershell.exe`. When nothing resolves, the first
/// remaining candidate is returned unchanged (the spawn reports the missing shell). `None` only
/// when every candidate was a batch shim.
pub fn select_shell_candidate(
    plan: &ShellExecutionPlan,
    env: &HashMap<String, String>,
    platform: &str,
) -> Option<ShellCandidate> {
    select_shell_candidate_with(plan, env, platform, &default_executable_exists)
}

/// [`select_shell_candidate`] with an injected existence probe (tests).
pub fn select_shell_candidate_with(
    plan: &ShellExecutionPlan,
    env: &HashMap<String, String>,
    platform: &str,
    exists: &dyn Fn(&str) -> bool,
) -> Option<ShellCandidate> {
    let mut first_unresolved = None;
    for candidate in &plan.candidates {
        match which_with(&candidate.program, env, platform, exists) {
            Some(path) if is_batch_shim(&path, platform) => continue,
            Some(path) => {
                return Some(ShellCandidate {
                    program: path,
                    args: candidate.args.clone(),
                });
            }
            None => {
                if first_unresolved.is_none() {
                    first_unresolved = Some(candidate.clone());
                }
            }
        }
    }
    first_unresolved
}

/// Deletes a materialized [`ShellTempScript`] when dropped (best effort; the OS temp dir is the
/// backstop).
#[derive(Debug)]
pub struct ShellTempScriptGuard {
    path: PathBuf,
}

impl ShellTempScriptGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ShellTempScriptGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Writes the plan's temp script (if any) before spawn; the returned guard removes it once the
/// run settles (TS bash.ts `writeFileSync` / `unlinkSync`).
pub fn materialize_temp_script(
    plan: &ShellExecutionPlan,
) -> std::io::Result<Option<ShellTempScriptGuard>> {
    let Some(script) = &plan.temp_script else {
        return Ok(None);
    };
    std::fs::write(&script.path, script.content.as_bytes())?;
    Ok(Some(ShellTempScriptGuard {
        path: script.path.clone(),
    }))
}

/// Executes a command via `SandboxRunner` using a clean non-login shell (`bash -c` / `pwsh -NoProfile`)
/// and canonical secret-stripped environment map.
pub async fn execute_non_login_shell(
    runner: &SandboxRunner,
    opts: ShellExecutionOptions,
) -> Result<ShellExecutionOutput> {
    let platform = host_platform();
    let effective_sandboxed = !matches!(opts.policy, SandboxPolicy::DangerFullAccess { .. })
        || !cowork_sandbox::policy_allows_network(&opts.policy);
    let canonical_env = build_canonical_shell_env(ShellEnvOptions {
        base_env: &opts.base_env,
        runtime: opts.runtime.as_ref(),
        uv_env: opts.uv_env.as_ref(),
        extra_env: Some(&opts.extra_env),
        platform,
        sandboxed: effective_sandboxed,
        cowork_home: opts.cowork_home.as_deref(),
    });
    let plan = build_non_login_shell_plan(&opts.command, &canonical_env, platform);
    let shell = select_shell_candidate(&plan, &canonical_env, platform).ok_or_else(|| {
        EnvError::ShellFailed(format!(
            "No compatible shell executable was found for platform {platform}."
        ))
    })?;
    let _temp_script = materialize_temp_script(&plan).map_err(|err| {
        EnvError::ShellFailed(format!("Failed to write the shell temp script: {err}"))
    })?;

    let mut caller_extra_env = HashMap::new();
    for (k, v) in &opts.extra_env {
        if !k.eq_ignore_ascii_case(PARENT_MANAGED_ENV_VAR)
            && !k.eq_ignore_ascii_case("PATH")
            && !k.eq_ignore_ascii_case("NODE_PATH")
            && !k.eq_ignore_ascii_case("NODE_OPTIONS")
        {
            caller_extra_env.insert(k.clone(), v.clone());
        }
    }

    let mut req = SandboxExecutionRequest::new(
        SandboxCommand::new(shell.program, shell.args),
        opts.policy,
        &opts.cwd,
    );
    req.yolo = opts.yolo;
    req.require_backend = opts.require_sandbox_backend;
    req.timeout = Some(opts.timeout);
    req.env_source = Some(canonical_env);
    req.extra_env = caller_extra_env;
    req.read_denied_roots = opts.read_denied_roots;

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
