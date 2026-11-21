use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use cowork_config::{canonicalize_sync, resolve_home_dir, windows_path_compare_key};

use crate::bwrap::resolve_sandbox_exec_binary;
use crate::env_utils::{PARENT_MANAGED_ENV_VAR, get_env, host_platform, remove_env};
use crate::policy::{
    SandboxPolicy, policy_allows_network, scratch_roots, tmp_scratch_roots, with_tmp_scratch,
};
use crate::protected_paths::{
    PROTECTED_SUBDIRS, ProtectedMetadataOptions, WorkspaceProtectedPathsCache,
    protected_metadata_paths,
};
use crate::{SandboxCommand, SandboxType, TransformedCommand};

const RUNTIME_READONLY_DIR_ENV_VARS: &[&str] = &[
    "COWORK_BUILTIN_DIR",
    "COWORK_RUNTIME_DIR",
    "COWORK_RUNTIME_BIN",
    "COWORK_RUNTIME_LIBREOFFICE_DIR",
    "COWORK_RUNTIME_POPPLER_BIN",
    "COWORK_RUNTIME_NODE_MODULES",
    "COWORK_RUNTIME_WHEELHOUSE",
    "COWORK_RUNTIME_PACKS",
];

const RUNTIME_READONLY_FILE_ENV_VARS: &[&str] = &[
    "COWORK_RUNTIME_NODE",
    "COWORK_RUNTIME_PYTHON",
    "COWORK_RUNTIME_GIT",
    "COWORK_RUNTIME_SOFFICE",
    "COWORK_RUNTIME_LIBREOFFICE_BINARY",
    "COWORK_RUNTIME_PDFTOPPM",
    "COWORK_RUNTIME_UV",
];

/// Non-credential subdirectories inside `~/.cowork` that sandboxed tools may read (skills,
/// plugins, managed runtime, config). Never grants `~/.cowork` itself so `~/.cowork/auth` and
/// `~/.cowork/mobile-pairing` stay outside the allowlist even on hosts without `deniedPaths`.
const COWORK_HOME_READONLY_SUBDIRS: &[&str] = &["skills", "plugins", "runtime", "config"];

/// Options controlling Windows MXC ProcessContainer policy generation and CLI wrapping.
#[derive(Default)]
pub struct WindowsMxcBuildOptions<'a> {
    /// Path to the `cowork-server` binary used for `__sandbox-exec --windows-mxc`.
    /// Defaults to `COWORK_SANDBOX_EXEC_PATH` or `std::env::current_exe()`.
    pub sandbox_exec_path: Option<&'a Path>,
    /// Shared protected `.git`/`.cowork` cache.
    pub cache: Option<&'a WorkspaceProtectedPathsCache>,
    /// Additional paths the contained process must be able to read (e.g. discovered skill/plugin
    /// roots, materialized shell temp script, or LibreOffice input file).
    pub read_allowed_roots: &'a [PathBuf],
    /// Credential directories/files the contained process must never read or write.
    pub read_denied_roots: &'a [PathBuf],
    /// Whether the host PSEC runtime advertises `base_container_supports_deny_paths`.
    /// When `false`, `denied_paths` is omitted from the MXC request so startup is not rejected,
    /// while overlapping grants are still stripped from `readwrite_paths` and `readonly_paths`.
    pub supports_deny_paths: bool,
    /// Additional read-only tool/profile paths (populated on Windows from MXC's
    /// `available_tools_policy` and `user_profile_policy` `.readonly_paths`).
    pub extra_tool_readonly_paths: &'a [PathBuf],
}

/// Cross-platform typed specification of a Windows MXC `ProcessContainer` launch request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsMxcRequestSpec {
    pub command_line: String,
    pub working_directory: String,
    pub readwrite_paths: Vec<String>,
    pub readonly_paths: Vec<String>,
    pub denied_paths: Vec<String>,
    pub allow_network: bool,
    pub environment: Vec<(String, String)>,
}

/// Resolves the Cowork home directory (`~/.cowork`) on Windows, honoring `COWORK_HOME_OVERRIDE`
/// and ignoring Git Bash `HOME` on `win32`.
pub fn windows_sandbox_home(env: &HashMap<String, String>) -> PathBuf {
    absolutize_host_path(&windows_sandbox_home_for_platform(env, host_platform()))
}

/// Resolves `path` against the server process cwd so a relative value is never re-resolved
/// against a session workspace later.
fn absolutize_host_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Platform-parameterized variant of `windows_sandbox_home` for cross-platform unit tests.
pub fn windows_sandbox_home_for_platform(env: &HashMap<String, String>, platform: &str) -> PathBuf {
    if let Some(home_override) = get_env(env, "COWORK_HOME_OVERRIDE", platform) {
        let trimmed = home_override.trim();
        if !trimmed.is_empty() {
            return join_cowork_dir(trimmed, platform);
        }
    }
    if platform == "win32" {
        if let Some(user_profile) = get_env(env, "USERPROFILE", "win32") {
            let trimmed = user_profile.trim();
            if !trimmed.is_empty() {
                return join_cowork_dir(trimmed, "win32");
            }
        }
        if let (Some(drive), Some(home_path)) = (
            get_env(env, "HOMEDRIVE", "win32"),
            get_env(env, "HOMEPATH", "win32"),
        ) {
            let combined = format!("{}{}", drive.trim(), home_path.trim());
            if !combined.is_empty() {
                return join_cowork_dir(&combined, "win32");
            }
        }
    }
    resolve_home_dir(env, platform).join(".cowork")
}

fn join_cowork_dir(home_base: &str, platform: &str) -> PathBuf {
    if platform == "win32"
        && (home_base.contains('\\') || home_base.as_bytes().get(1) == Some(&b':'))
    {
        let trimmed = home_base.trim_end_matches(['\\', '/']);
        PathBuf::from(format!(r"{trimmed}\.cowork"))
    } else {
        PathBuf::from(home_base).join(".cowork")
    }
}

/// Formats `file` and `args` into a single Windows `CreateProcessW` command line using the
/// Microsoft C/C++ runtime (`CommandLineToArgvW`) quoting rules.
pub fn format_windows_command_line(file: &str, args: &[String]) -> String {
    let mut out = String::new();
    for (idx, token) in std::iter::once(file)
        .chain(args.iter().map(String::as_str))
        .enumerate()
    {
        if idx > 0 {
            out.push(' ');
        }
        push_windows_argv_token(&mut out, token);
    }
    out
}

fn push_windows_argv_token(out: &mut String, arg: &str) {
    if arg.is_empty() {
        out.push_str("\"\"");
        return;
    }
    let needs_quotes = arg
        .bytes()
        .any(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | b'"'));
    if !needs_quotes {
        out.push_str(arg);
        return;
    }

    out.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else if ch == '"' {
            for _ in 0..(backslashes * 2 + 1) {
                out.push('\\');
            }
            out.push('"');
            backslashes = 0;
        } else {
            for _ in 0..backslashes {
                out.push('\\');
            }
            backslashes = 0;
            out.push(ch);
        }
    }
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
}

/// Builds a `<self_exe> __sandbox-exec --windows-mxc ...` wrapper command enforcing `policy`.
///
/// In-process `SandboxRunner` execution on Windows invokes MXC directly without a subprocess hop;
/// this command representation powers `--print-command` and external transparent CLI launchers.
pub fn build_windows_sandbox_command(
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cwd: &Path,
    _env_source: &HashMap<String, String>,
    opts: WindowsMxcBuildOptions<'_>,
) -> TransformedCommand {
    let cwd_abs = absolutize_host_path(cwd);
    let cwd = cwd_abs.as_path();
    let (mode_arg, writable_roots) = windows_mode_and_writable_roots(policy, cwd);

    let self_exe = resolve_sandbox_exec_binary(opts.sandbox_exec_path);
    let mut args: Vec<String> = vec![
        "__sandbox-exec".to_owned(),
        "--windows-mxc".to_owned(),
        "--mode".to_owned(),
        mode_arg.to_owned(),
        "--cwd".to_owned(),
        cwd.to_string_lossy().into_owned(),
    ];

    for root in &writable_roots {
        args.push("--writable-root".to_owned());
        args.push(root.to_string_lossy().into_owned());
    }
    for root in opts.read_allowed_roots {
        args.push("--read-root".to_owned());
        args.push(root.to_string_lossy().into_owned());
    }
    if let SandboxPolicy::NoProjectWrite { project_roots, .. } = policy {
        for root in project_roots {
            args.push("--read-root".to_owned());
            args.push(root.to_string_lossy().into_owned());
        }
    }
    for root in opts.read_denied_roots {
        args.push("--read-deny".to_owned());
        args.push(root.to_string_lossy().into_owned());
    }

    let network_allowed = policy_allows_network(policy);
    if network_allowed {
        args.push("--allow-network".to_owned());
    }

    args.push("--".to_owned());
    args.push(inner.file.clone());
    args.extend(inner.args.iter().cloned());

    let mut env = HashMap::new();
    env.insert(
        "COWORK_SANDBOX".to_owned(),
        SandboxType::Windows.as_str().to_owned(),
    );
    if !network_allowed {
        env.insert("COWORK_SANDBOX_NETWORK_DISABLED".to_owned(), "1".to_owned());
    }

    TransformedCommand {
        file: self_exe,
        args,
        env,
        sandbox: SandboxType::Windows,
        unsandboxed: false,
    }
}

/// Ensures the explicit child environment passed to Windows MXC `ProcessContainer` (with
/// `inherit_default_environment: Some(false)`) satisfies PSEC's mandatory `SYSTEMROOT` and
/// `LOCALAPPDATA` presence checks, preserves `PSModulePath` so Windows PowerShell built-in
/// modules (`Microsoft.PowerShell.Management`, `Microsoft.PowerShell.Utility`) resolve inside
/// the container, and strips `COWORK_DESKTOP_PARENT_MANAGED`.
pub fn ensure_required_mxc_child_env(
    child_env: &HashMap<String, String>,
    host_env: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut effective = child_env.clone();
    remove_env(&mut effective, PARENT_MANAGED_ENV_VAR, "win32");

    let resolved_system_root = get_env(&effective, "SYSTEMROOT", "win32")
        .or_else(|| get_env(host_env, "SYSTEMROOT", "win32"))
        .or_else(|| get_env(host_env, "WINDIR", "win32"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(r"C:\Windows")
        .to_owned();

    if get_env(&effective, "SYSTEMROOT", "win32")
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        effective.insert("SystemRoot".to_owned(), resolved_system_root.clone());
    }

    if get_env(&effective, "LOCALAPPDATA", "win32")
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        let local_app_data = get_env(host_env, "LOCALAPPDATA", "win32")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                get_env(&effective, "USERPROFILE", "win32")
                    .or_else(|| get_env(host_env, "USERPROFILE", "win32"))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|profile| {
                        format!(r"{}\AppData\Local", profile.trim_end_matches(['\\', '/']))
                    })
            })
            .or_else(|| {
                get_env(&effective, "TEMP", "win32")
                    .or_else(|| get_env(host_env, "TEMP", "win32"))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| r"C:\Windows\Temp".to_owned());
        effective.insert("LOCALAPPDATA".to_owned(), local_app_data);
    }

    if get_env(&effective, "PSModulePath", "win32")
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        let ps_module_path = get_env(host_env, "PSModulePath", "win32")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    r"{}\System32\WindowsPowerShell\v1.0\Modules",
                    resolved_system_root.trim_end_matches(['\\', '/'])
                )
            });
        effective.insert("PSModulePath".to_owned(), ps_module_path);
    }

    let mut pairs: Vec<(String, String)> = effective.into_iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
}

/// Normalizes a path to the fully qualified literal Windows path format accepted by MXC
/// `ProcessContainer` (`C:\...` or `\\server\share\...`, no `\\?\`, no `/` separators, no `..`,
/// no trailing `\` except bare drive roots when `allow_drive_root` is `true`).
pub fn normalize_mxc_windows_path(path: &Path) -> Option<String> {
    normalize_mxc_windows_path_with(path, &canonical_win_root, false)
}

fn normalize_mxc_windows_path_with(
    path: &Path,
    canon: &dyn Fn(&Path) -> PathBuf,
    allow_drive_root: bool,
) -> Option<String> {
    let resolved = canon(path);
    let raw = resolved.to_string_lossy();
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }

    let mut s = trimmed.replace('/', "\\");
    if let Some(rest) = s
        .strip_prefix(r"\\?\UNC\")
        .or_else(|| s.strip_prefix(r"\\?\unc\"))
    {
        s = format!(r"\\{rest}");
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_owned();
    }

    // Reject relative traversal segments (`..`) which MXC rejects before launch.
    if s.split('\\').any(|seg| seg == "..") {
        return None;
    }

    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        // Require drive-absolute (`C:\...` or bare `C:`), never drive-relative (`C:foo`).
        if bytes.len() == 2 {
            return allow_drive_root.then(|| format!("{s}\\"));
        }
        if bytes[2] != b'\\' {
            return None;
        }
        let without_trailing = s.trim_end_matches('\\');
        if without_trailing.len() == 2 {
            // Bare volume root (`C:\`) does not cascade in BaseContainer policy lists.
            return allow_drive_root.then(|| format!("{without_trailing}\\"));
        }
        return Some(without_trailing.to_owned());
    }

    if let Some(unc_rest) = s.strip_prefix(r"\\") {
        let trimmed_unc = unc_rest.trim_end_matches('\\');
        let mut parts = trimmed_unc.split('\\').filter(|p| !p.is_empty());
        let _server = parts.next()?;
        let _share = parts.next()?;
        return Some(format!(r"\\{trimmed_unc}"));
    }

    None
}

/// Builds the complete cross-platform Windows MXC `ProcessContainer` request specification for
/// `inner`, `policy`, `cwd`, and `child_env`.
pub fn build_windows_mxc_spec(
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cwd: &Path,
    child_env: &HashMap<String, String>,
    host_env: &HashMap<String, String>,
    opts: &WindowsMxcBuildOptions<'_>,
) -> WindowsMxcRequestSpec {
    build_windows_mxc_spec_with(
        inner,
        policy,
        cwd,
        child_env,
        host_env,
        opts,
        &scratch_roots(Some("win32")),
        &canonical_win_root,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_windows_mxc_spec_with(
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cwd: &Path,
    child_env: &HashMap<String, String>,
    host_env: &HashMap<String, String>,
    opts: &WindowsMxcBuildOptions<'_>,
    raw_scratch: &[PathBuf],
    canon: &dyn Fn(&Path) -> PathBuf,
) -> WindowsMxcRequestSpec {
    let cwd_abs = if host_platform() == "win32" {
        absolutize_host_path(cwd)
    } else {
        cwd.to_path_buf()
    };
    let (_mode_arg, raw_writable_roots) =
        windows_mode_and_writable_roots_with(policy, &cwd_abs, raw_scratch, canon);

    // Collect normalized denied roots first so overlapping grants can NEVER re-expose them
    // (in BaseContainer a more-specific child grant overrides a denied parent!).
    let mut normalized_denied: Vec<String> = Vec::new();
    let mut seen_denied: HashSet<String> = HashSet::new();
    for denied in opts.read_denied_roots {
        if let Some(norm) = normalize_mxc_windows_path_with(denied, canon, false) {
            let key = norm.to_ascii_lowercase();
            if seen_denied.insert(key) {
                normalized_denied.push(norm);
            }
        }
    }

    // Explicit project/workspace writable roots whose `.git` / `.cowork` metadata must remain
    // read-only via longest-prefix match (never scanning `%TEMP%` scratch roots).
    let explicit_writable_for_protection: Vec<PathBuf> = match policy {
        SandboxPolicy::WorkspaceWrite { writable_roots, .. } => {
            writable_roots.iter().map(|r| canon(r)).collect()
        }
        SandboxPolicy::DangerFullAccess { .. } => vec![canon(&cwd_abs)],
        SandboxPolicy::ReadOnly { .. } | SandboxPolicy::NoProjectWrite { .. } => Vec::new(),
    };

    let mut protected_ro: Vec<String> = Vec::new();
    let mut seen_protected: HashSet<String> = HashSet::new();
    let mut push_protected = |p: &Path| {
        if let Some(norm) = normalize_mxc_windows_path_with(p, canon, false) {
            if is_covered_by_any_win(&norm, &normalized_denied) {
                return;
            }
            let key = norm.to_ascii_lowercase();
            if seen_protected.insert(key) {
                protected_ro.push(norm);
            }
        }
    };

    for root in &explicit_writable_for_protection {
        for name in PROTECTED_SUBDIRS {
            push_protected(&join_win_child(root, name));
        }
    }
    if !explicit_writable_for_protection.is_empty() {
        let discovered = match opts.cache {
            Some(cache) => {
                cache.protected_paths_for_roots(&explicit_writable_for_protection, Some("win32"))
            }
            None => protected_metadata_paths(
                &explicit_writable_for_protection,
                ProtectedMetadataOptions {
                    platform: Some("win32"),
                    ..Default::default()
                },
            ),
        };
        for p in &discovered {
            push_protected(p);
        }
    }

    // Final `readwrite_paths`, stripping any entry equal to or inside `normalized_denied` or
    // `protected_ro`.
    let mut readwrite_paths: Vec<String> = Vec::new();
    let mut seen_rw: HashSet<String> = HashSet::new();
    for root in &raw_writable_roots {
        if let Some(norm) = normalize_mxc_windows_path_with(root, canon, false) {
            if is_covered_by_any_win(&norm, &normalized_denied)
                || is_covered_by_any_win(&norm, &protected_ro)
            {
                continue;
            }
            let key = norm.to_ascii_lowercase();
            if seen_rw.insert(key) {
                readwrite_paths.push(norm);
            }
        }
    }

    // General read-only candidates. Because BaseContainer uses longest-prefix match, any general
    // read-only candidate that is equal to or inside a `readwrite_paths` entry is skipped so it
    // never downgrades a writable directory (e.g. `cwd` inside a writable repo root) to read-only.
    let mut readonly_paths: Vec<String> = protected_ro;
    let mut seen_ro: HashSet<String> = readonly_paths
        .iter()
        .map(|p| p.to_ascii_lowercase())
        .collect();
    let mut push_general_ro = |p: &Path| {
        if let Some(norm) = normalize_mxc_windows_path_with(p, canon, false) {
            if is_covered_by_any_win(&norm, &normalized_denied)
                || is_covered_by_any_win(&norm, &readwrite_paths)
            {
                return;
            }
            let key = norm.to_ascii_lowercase();
            if seen_ro.insert(key) {
                readonly_paths.push(norm);
            }
        }
    };

    push_general_ro(&cwd_abs);
    if let SandboxPolicy::NoProjectWrite { project_roots, .. } = policy {
        for root in project_roots {
            push_general_ro(root);
        }
    }
    for root in opts.read_allowed_roots {
        push_general_ro(root);
    }

    // Grant read access to the executable's directory when invoked by absolute Windows path.
    if let Some(exe_norm) = normalize_mxc_windows_path_with(Path::new(&inner.file), canon, false)
        && let Some(parent) = windows_parent_dir(&exe_norm)
    {
        push_general_ro(Path::new(&parent));
    }

    // Non-credential Cowork home subdirectories (`~/.cowork/{skills,plugins,runtime,config}`).
    let sandbox_home = windows_sandbox_home_for_platform(host_env, "win32");
    for subdir in COWORK_HOME_READONLY_SUBDIRS {
        push_general_ro(&join_win_child(&sandbox_home, subdir));
    }

    // Built-in Windows PowerShell standard module directory (`Microsoft.PowerShell.Management`,
    // `Microsoft.PowerShell.Utility`, etc.) so PowerShell cmdlets resolve reliably under PSEC.
    let system_root = get_env(child_env, "SYSTEMROOT", "win32")
        .or_else(|| get_env(host_env, "SYSTEMROOT", "win32"))
        .or_else(|| get_env(host_env, "WINDIR", "win32"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(r"C:\Windows");
    push_general_ro(&join_win_child(
        Path::new(system_root),
        r"System32\WindowsPowerShell\v1.0\Modules",
    ));

    // Managed Cowork runtime / built-in roots from host or child env.
    for env_map in [host_env, child_env] {
        for var in RUNTIME_READONLY_DIR_ENV_VARS {
            if let Some(val) = get_env(env_map, var, "win32")
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                push_general_ro(Path::new(val));
            }
        }
        for var in RUNTIME_READONLY_FILE_ENV_VARS {
            if let Some(val) = get_env(env_map, var, "win32")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                && let Some(norm) = normalize_mxc_windows_path_with(Path::new(val), canon, false)
                && let Some(parent) = windows_parent_dir(&norm)
            {
                push_general_ro(Path::new(&parent));
            }
        }
    }

    for extra in opts.extra_tool_readonly_paths {
        push_general_ro(extra);
    }

    let working_directory = normalize_mxc_windows_path_with(&cwd_abs, canon, true)
        .unwrap_or_else(|| cwd_abs.to_string_lossy().into_owned());
    let denied_paths = if opts.supports_deny_paths {
        normalized_denied
    } else {
        Vec::new()
    };

    WindowsMxcRequestSpec {
        command_line: format_windows_command_line(&inner.file, &inner.args),
        working_directory,
        readwrite_paths,
        readonly_paths,
        denied_paths,
        allow_network: policy_allows_network(policy),
        environment: ensure_required_mxc_child_env(child_env, host_env),
    }
}

fn join_win_child(parent: &Path, child: &str) -> PathBuf {
    let raw = parent.to_string_lossy();
    if raw.contains('\\') || raw.as_bytes().get(1) == Some(&b':') {
        let trimmed = raw.trim_end_matches(['\\', '/']);
        PathBuf::from(format!(r"{trimmed}\{child}"))
    } else {
        parent.join(child)
    }
}

fn windows_parent_dir(win_path: &str) -> Option<String> {
    let idx = win_path.rfind('\\')?;
    if idx <= 2 {
        // Drive root (`C:\foo.exe` -> `C:\` does not cascade in BaseContainer).
        return None;
    }
    Some(win_path[..idx].to_owned())
}

fn is_same_or_descendant_win(path: &str, ancestor: &str) -> bool {
    let p = path.trim_end_matches('\\').to_ascii_lowercase();
    let a = ancestor.trim_end_matches('\\').to_ascii_lowercase();
    if p == a {
        return true;
    }
    p.len() > a.len() && p.starts_with(&a) && p.as_bytes().get(a.len()) == Some(&b'\\')
}

fn is_covered_by_any_win(path: &str, ancestors: &[String]) -> bool {
    ancestors
        .iter()
        .any(|ancestor| is_same_or_descendant_win(path, ancestor))
}

/// Maps `policy` to the mode label and its writable root set. `danger-full-access` (only wrapped
/// when `network` is off) runs as `network-only`, confining writes to `cwd` plus filtered temp
/// scratch like the other writable policies.
fn windows_mode_and_writable_roots(
    policy: &SandboxPolicy,
    cwd: &Path,
) -> (&'static str, Vec<PathBuf>) {
    windows_mode_and_writable_roots_with(
        policy,
        cwd,
        &scratch_roots(Some("win32")),
        &canonical_win_root,
    )
}

/// Resolves a writable-root candidate the way Windows PSEC will see it: on a Windows host through
/// `canonicalize_sync` (8.3 short names such as `RUNNER~1`, junctions, trailing separators, and
/// the `\\?\` prefix stripped) and absolutized; elsewhere unchanged, so cross-platform unit tests
/// never touch the host filesystem for Windows-shaped paths.
fn canonical_win_root(path: &Path) -> PathBuf {
    if host_platform() == "win32" {
        absolutize_host_path(&canonicalize_sync(path))
    } else {
        path.to_path_buf()
    }
}

/// Pure core of `windows_mode_and_writable_roots` with the temp scratch candidates and the
/// canonicalizer injected.
///
/// Scratch candidates, project roots, and writable roots are all canonicalized BEFORE the
/// ancestor filtering. Filtering lexical spellings first would let an 8.3 `%TEMP%` alias survive
/// next to a project that lives under its long-name equivalent, and the final canonicalization
/// would then grant the project's ancestor.
fn windows_mode_and_writable_roots_with(
    policy: &SandboxPolicy,
    cwd: &Path,
    raw_scratch: &[PathBuf],
    canon: &dyn Fn(&Path) -> PathBuf,
) -> (&'static str, Vec<PathBuf>) {
    let win_scratch = dedupe_win_roots(raw_scratch, canon);
    let blocked = |roots: &[PathBuf]| -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for root in roots {
            for candidate in [root.clone(), canon(root)] {
                if !out.contains(&candidate) {
                    out.push(candidate);
                }
            }
        }
        out
    };
    let canonical =
        |roots: &[PathBuf]| -> Vec<PathBuf> { roots.iter().map(|r| canon(r)).collect() };

    let (mode, roots) = match policy {
        SandboxPolicy::DangerFullAccess { .. } => (
            "network-only",
            with_tmp_scratch(&canonical(&[cwd.to_path_buf()]), &win_scratch),
        ),
        SandboxPolicy::NoProjectWrite { project_roots, .. } => {
            let scratch = tmp_scratch_roots(&blocked(project_roots), &win_scratch);
            if scratch.is_empty() {
                return ("read-only", Vec::new());
            }
            ("workspace-write", scratch)
        }
        SandboxPolicy::ReadOnly { .. } => return ("read-only", Vec::new()),
        SandboxPolicy::WorkspaceWrite {
            writable_roots: raw,
            ..
        } => {
            let roots = if !raw.is_empty() {
                with_tmp_scratch(&canonical(raw), &win_scratch)
            } else {
                tmp_scratch_roots(&blocked(&[cwd.to_path_buf()]), &win_scratch)
            };
            ("workspace-write", roots)
        }
    };
    (mode, dedupe_win_roots(&roots, canon))
}

/// Canonicalizes every root and drops later duplicates by their Windows comparison key
/// (case-insensitive, `\\?\`-agnostic, separator- and trailing-separator-insensitive).
fn dedupe_win_roots(roots: &[PathBuf], canon: &dyn Fn(&Path) -> PathBuf) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in roots {
        let resolved = canon(r);
        let key = win_root_key(&resolved);
        if seen.insert(key) {
            out.push(resolved);
        }
    }
    out
}

fn win_root_key(path: &Path) -> String {
    let key = windows_path_compare_key(path).replace('/', "\\");
    let trimmed = key.trim_end_matches('\\');
    if trimmed.is_empty() {
        key
    } else {
        trimmed.to_owned()
    }
}

#[cfg(windows)]
mod native_mxc {
    use std::collections::HashMap;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use mxc_sdk::v1::configs::ProcessContainerConfig;
    use mxc_sdk::v1::policy::filesystem::{
        ToolsPolicyOptions, available_tools_policy, user_profile_policy,
    };
    use mxc_sdk::v1::{
        ClipboardPolicy, ContainerRequest, Containment, ErrorCode, FilesystemPolicy, MxcProcess,
        NetworkAction, NetworkEgressPolicy, NetworkIngressPolicy, NetworkPolicy,
        SpawnExtendedOptions, SpawnOptions, SpawnStdio, StreamCloser, UiPolicy, WaitResult,
    };
    use tokio::sync::watch;

    use super::{
        WindowsMxcBuildOptions, WindowsMxcRequestSpec, build_windows_mxc_spec,
        ensure_required_mxc_child_env,
    };
    use crate::policy::SandboxPolicy;
    use crate::runner::{
        KILLED_PIPE_DRAIN_GRACE, OverflowSignal, RawProcessOutcome, finish_outcome, join_reader,
    };
    use crate::{SandboxCommand, SandboxErrorCode};

    const STOP_NONE: u8 = 0;
    const STOP_TIMEOUT: u8 = 1;
    const STOP_CANCEL: u8 = 2;
    const STOP_OVERFLOW: u8 = 3;

    const TOOL_DISCOVERY_CACHE_ENV_KEYS: &[&str] = &[
        "PATH",
        "LOCALAPPDATA",
        "USERPROFILE",
        "PSMODULEPATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "VCINSTALLDIR",
        "VSINSTALLDIR",
        "VCPKG_ROOT",
        "GOPATH",
        "GOROOT",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "JAVA_HOME",
        "NVM_HOME",
        "NVM_SYMLINK",
        "NODE_PATH",
        "DOTNET_ROOT",
        "CONDA_PREFIX",
        "LD_LIBRARY_PATH",
        "VIRTUAL_ENV",
        "PYENV_ROOT",
    ];

    static HOST_TOOL_RO_CACHE: OnceLock<Mutex<HashMap<Vec<(String, String)>, Vec<PathBuf>>>> =
        OnceLock::new();

    /// Discovers read-only tool and user-profile paths via MXC's built-in policy helpers.
    ///
    /// Deliberately takes ONLY `.readonly_paths` (never `.readwrite_paths` such as PSReadLine
    /// history) so Cowork's strict write scoping and `read-only` floors remain intact. Uses
    /// `ToolsPolicyOptions::default()` (skipping per-directory `icacls.exe` subprocess probes
    /// that add ~30s overhead on large Windows `PATH`s) and caches results by discovery env vars.
    pub(super) fn discover_mxc_host_readonly_paths(env_pairs: &[(String, String)]) -> Vec<PathBuf> {
        let mut cache_key: Vec<(String, String)> = env_pairs
            .iter()
            .filter_map(|(k, v)| {
                let upper = k.to_ascii_uppercase();
                TOOL_DISCOVERY_CACHE_ENV_KEYS
                    .contains(&upper.as_str())
                    .then_some((upper, v.clone()))
            })
            .collect();
        cache_key.sort();

        let cache = HOST_TOOL_RO_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some(hit) = cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&cache_key)
        {
            return hit.clone();
        }

        let mut out = Vec::new();
        let tools = available_tools_policy(Some(env_pairs), ToolsPolicyOptions::default());
        out.extend(tools.readonly_paths.into_iter().map(PathBuf::from));
        let profile = user_profile_policy(Some(env_pairs));
        out.extend(profile.readonly_paths.into_iter().map(PathBuf::from));

        let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= 16 {
            guard.clear();
        }
        guard.insert(cache_key, out.clone());
        out
    }

    pub(super) fn build_mxc_container_request(spec: &WindowsMxcRequestSpec) -> ContainerRequest {
        let network = if spec.allow_network {
            NetworkPolicy {
                egress: Some(NetworkEgressPolicy {
                    default: Some(NetworkAction::Allow),
                    allow: None,
                    deny: None,
                }),
                ingress: Some(NetworkIngressPolicy {
                    default: Some(NetworkAction::Allow),
                    host_loopback: Some(NetworkAction::Allow),
                }),
                runtime_config: None,
            }
        } else {
            NetworkPolicy {
                egress: Some(NetworkEgressPolicy {
                    default: Some(NetworkAction::Deny),
                    allow: None,
                    deny: None,
                }),
                ingress: Some(NetworkIngressPolicy {
                    default: Some(NetworkAction::Deny),
                    host_loopback: Some(NetworkAction::Deny),
                }),
                runtime_config: None,
            }
        };

        ContainerRequest {
            command: spec.command_line.clone(),
            filesystem: Some(FilesystemPolicy {
                readwrite_paths: spec.readwrite_paths.clone(),
                readonly_paths: spec.readonly_paths.clone(),
                denied_paths: spec.denied_paths.clone(),
                clear_policy_on_exit: Some(true),
            }),
            network: Some(network),
            // Keep Win32k enabled (`disable: false`) so tools linking user32/gdi32 (e.g.
            // headless LibreOffice or PowerShell) do not crash, while locking clipboard & input.
            ui: Some(UiPolicy {
                disable: false,
                clipboard: ClipboardPolicy::None,
                allow_input_injection: false,
            }),
            timeout_ms: None,
            containment: Containment::ProcessContainer(ProcessContainerConfig::default()),
            container_name: None,
            working_directory: Some(spec.working_directory.clone()),
            environment: Some(spec.environment.clone()),
            inherit_default_environment: Some(false),
        }
    }

    fn build_request_for_host(
        inner: &SandboxCommand,
        policy: &SandboxPolicy,
        cwd: &Path,
        child_env: &HashMap<String, String>,
        host_env: &HashMap<String, String>,
        opts: &WindowsMxcBuildOptions<'_>,
    ) -> ContainerRequest {
        let env_pairs = ensure_required_mxc_child_env(child_env, host_env);
        let mut discovered = discover_mxc_host_readonly_paths(&env_pairs);
        discovered.extend(opts.extra_tool_readonly_paths.iter().cloned());
        let merged_opts = WindowsMxcBuildOptions {
            sandbox_exec_path: opts.sandbox_exec_path,
            cache: opts.cache,
            read_allowed_roots: opts.read_allowed_roots,
            read_denied_roots: opts.read_denied_roots,
            supports_deny_paths: opts.supports_deny_paths,
            extra_tool_readonly_paths: &discovered,
        };
        let spec = build_windows_mxc_spec(inner, policy, cwd, child_env, host_env, &merged_opts);
        build_mxc_container_request(&spec)
    }

    fn format_mxc_error(err: &mxc_sdk::v1::Error) -> String {
        match &err.remediation {
            Some(rem) if !rem.trim().is_empty() => format!("{} ({})", err.message, rem.trim()),
            _ => err.message.clone(),
        }
    }

    fn is_file_not_found_error(err: &mxc_sdk::v1::Error) -> bool {
        err.native_code.as_deref().is_some_and(|code| {
            let trimmed = code.trim();
            trimmed == "2"
                || trimmed.eq_ignore_ascii_case("0x2")
                || trimmed.eq_ignore_ascii_case("0x00000002")
                || trimmed.eq_ignore_ascii_case("ERROR_FILE_NOT_FOUND")
        }) || err.message.contains("error code 2 (0x00000002)")
    }

    struct MxcAbandonGuard {
        armed: bool,
        stop_signal: Arc<AtomicU8>,
        stdout_closer: Option<StreamCloser>,
        stderr_closer: Option<StreamCloser>,
    }

    impl MxcAbandonGuard {
        fn disarm(&mut self) {
            self.armed = false;
        }
    }

    impl Drop for MxcAbandonGuard {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            let _ = self.stop_signal.compare_exchange(
                STOP_NONE,
                STOP_CANCEL,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            if let Some(closer) = &self.stdout_closer {
                closer.close();
            }
            if let Some(closer) = &self.stderr_closer {
                closer.close();
            }
        }
    }

    fn read_capped_blocking(
        reader: Option<Box<dyn Read + Send>>,
        max_bytes: usize,
        buf: Arc<Mutex<Vec<u8>>>,
        overflow: Arc<OverflowSignal>,
    ) {
        let Some(mut r) = reader else {
            return;
        };
        let mut chunk = [0u8; 8192];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut guard = buf.lock().unwrap_or_else(|e| e.into_inner());
                    let remaining = max_bytes.saturating_sub(guard.len());
                    if n > remaining {
                        guard.extend_from_slice(&chunk[..remaining]);
                        drop(guard);
                        overflow.trip();
                        return;
                    }
                    guard.extend_from_slice(&chunk[..n]);
                }
            }
        }
    }

    fn drive_mxc_process(
        mut proc: MxcProcess,
        stop_signal: Arc<AtomicU8>,
    ) -> Result<WaitResult, String> {
        loop {
            match stop_signal.load(Ordering::SeqCst) {
                STOP_TIMEOUT => {
                    let _ = proc.kill_for_timeout();
                    let _ = proc.wait();
                    return Ok(WaitResult::TimedOut);
                }
                STOP_CANCEL | STOP_OVERFLOW => {
                    let _ = proc.kill();
                    let _ = proc.wait();
                    return Ok(WaitResult::Exited(1));
                }
                _ => {}
            }

            match proc.try_wait() {
                Ok(Some(code)) => {
                    let _ = proc.wait();
                    return Ok(WaitResult::Exited(code));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(err) if err.kind() == std::io::ErrorKind::TimedOut => {
                    let _ = proc.wait();
                    return Ok(WaitResult::TimedOut);
                }
                Err(err) => return Err(err.to_string()),
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_windows_mxc_in_process(
        inner: &SandboxCommand,
        policy: &SandboxPolicy,
        cwd: &Path,
        child_env: &HashMap<String, String>,
        host_env: &HashMap<String, String>,
        opts: WindowsMxcBuildOptions<'_>,
        timeout: Option<Duration>,
        max_buffer: usize,
        mut cancel_rx: Option<watch::Receiver<bool>>,
    ) -> RawProcessOutcome {
        if cancel_rx.as_ref().is_some_and(|rx| *rx.borrow()) {
            return RawProcessOutcome {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 130,
                error_code: Some(SandboxErrorCode::AbortErr),
            };
        }

        let request = build_request_for_host(inner, policy, cwd, child_env, host_env, &opts);
        let spawn_result = tokio::task::spawn_blocking(move || {
            mxc_sdk::v1::spawn(request, SpawnOptions { telemetry: None })
        })
        .await;

        let mut proc = match spawn_result {
            Ok(Ok(p)) => p,
            Ok(Err(err)) => {
                if is_file_not_found_error(&err) {
                    return RawProcessOutcome {
                        stdout: String::new(),
                        stderr: format_mxc_error(&err),
                        exit_code: 127,
                        error_code: None,
                    };
                }
                let error_code = if err.code == ErrorCode::BackendUnavailable {
                    SandboxErrorCode::SandboxRequired
                } else {
                    SandboxErrorCode::BackendFailed
                };
                return RawProcessOutcome {
                    stdout: String::new(),
                    stderr: format!(
                        "Windows MXC ProcessContainer failed: {}",
                        format_mxc_error(&err)
                    ),
                    exit_code: 1,
                    error_code: Some(error_code),
                };
            }
            Err(join_err) => {
                return RawProcessOutcome {
                    stdout: String::new(),
                    stderr: format!("Windows MXC spawn worker panicked: {join_err}"),
                    exit_code: 1,
                    error_code: Some(SandboxErrorCode::BackendFailed),
                };
            }
        };

        // Close child stdin immediately (matching `Stdio::null()`).
        drop(proc.take_stdin());
        let stdout_reader = proc.take_stdout();
        let stderr_reader = proc.take_stderr();
        let stdout_closer = proc.stdout_closer();
        let stderr_closer = proc.stderr_closer();

        let out_buf = Arc::new(Mutex::new(Vec::new()));
        let err_buf = Arc::new(Mutex::new(Vec::new()));
        let overflow = Arc::new(OverflowSignal::default());
        let stop_signal = Arc::new(AtomicU8::new(STOP_NONE));

        let mut abandon_guard = MxcAbandonGuard {
            armed: true,
            stop_signal: Arc::clone(&stop_signal),
            stdout_closer: proc.stdout_closer(),
            stderr_closer: proc.stderr_closer(),
        };

        let mut out_task = tokio::task::spawn_blocking({
            let out_buf = Arc::clone(&out_buf);
            let overflow = Arc::clone(&overflow);
            move || read_capped_blocking(stdout_reader, max_buffer, out_buf, overflow)
        });
        let mut err_task = tokio::task::spawn_blocking({
            let err_buf = Arc::clone(&err_buf);
            let overflow = Arc::clone(&overflow);
            move || read_capped_blocking(stderr_reader, max_buffer, err_buf, overflow)
        });
        let mut wait_task = tokio::task::spawn_blocking({
            let stop_signal = Arc::clone(&stop_signal);
            move || drive_mxc_process(proc, stop_signal)
        });

        enum WaitOutcome {
            Completed(Result<Result<WaitResult, String>, tokio::task::JoinError>),
            TimedOut,
            Cancelled,
            Overflowed,
        }

        let wait_outcome = {
            let completion_fut = async {
                let res = (&mut wait_task).await;
                join_reader(&mut out_task).await;
                join_reader(&mut err_task).await;
                res
            };
            tokio::pin!(completion_fut);

            let timeout_fut = async {
                match timeout {
                    Some(dur) => tokio::time::sleep(dur).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::pin!(timeout_fut);

            let cancel_fut = async {
                match cancel_rx.as_mut() {
                    Some(rx) => {
                        if *rx.borrow() {
                            return;
                        }
                        while rx.changed().await.is_ok() {
                            if *rx.borrow() {
                                return;
                            }
                        }
                        std::future::pending::<()>().await
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::pin!(cancel_fut);

            tokio::select! {
                res = &mut completion_fut => WaitOutcome::Completed(res),
                () = &mut timeout_fut => WaitOutcome::TimedOut,
                () = &mut cancel_fut => WaitOutcome::Cancelled,
                () = overflow.notify.notified() => WaitOutcome::Overflowed,
            }
        };

        let wait_outcome = if overflow.tripped() && !matches!(wait_outcome, WaitOutcome::Overflowed)
        {
            if matches!(wait_outcome, WaitOutcome::Completed(_)) {
                abandon_guard.disarm();
                return finish_outcome(
                    &out_buf,
                    &err_buf,
                    &overflow,
                    1,
                    Some(SandboxErrorCode::MaxBufferExceeded),
                );
            }
            WaitOutcome::Overflowed
        } else {
            wait_outcome
        };

        let (exit_code, error_code) = match wait_outcome {
            WaitOutcome::Completed(res) => {
                abandon_guard.disarm();
                match res {
                    Ok(Ok(WaitResult::Exited(code))) => (code, None),
                    Ok(Ok(WaitResult::TimedOut)) => (124, Some(SandboxErrorCode::Timeout)),
                    Ok(Err(msg)) => {
                        let mut guard = err_buf.lock().unwrap_or_else(|e| e.into_inner());
                        if !guard.is_empty() {
                            guard.push(b'\n');
                        }
                        guard.extend_from_slice(msg.as_bytes());
                        (1, Some(SandboxErrorCode::BackendFailed))
                    }
                    Err(_) => (1, Some(SandboxErrorCode::BackendFailed)),
                }
            }
            forced => {
                let sig = match forced {
                    WaitOutcome::TimedOut => STOP_TIMEOUT,
                    WaitOutcome::Overflowed => STOP_OVERFLOW,
                    _ => STOP_CANCEL,
                };
                stop_signal.store(sig, Ordering::SeqCst);
                let _ = (&mut wait_task).await;
                abandon_guard.disarm();

                let drained = tokio::time::timeout(KILLED_PIPE_DRAIN_GRACE, async {
                    join_reader(&mut out_task).await;
                    join_reader(&mut err_task).await;
                })
                .await;
                if drained.is_err() {
                    if let Some(closer) = &stdout_closer {
                        closer.close();
                    }
                    if let Some(closer) = &stderr_closer {
                        closer.close();
                    }
                    let _ = tokio::time::timeout(Duration::from_millis(200), async {
                        join_reader(&mut out_task).await;
                        join_reader(&mut err_task).await;
                    })
                    .await;
                }

                match forced {
                    WaitOutcome::TimedOut => (124, Some(SandboxErrorCode::Timeout)),
                    WaitOutcome::Overflowed => (1, Some(SandboxErrorCode::MaxBufferExceeded)),
                    _ => (130, Some(SandboxErrorCode::AbortErr)),
                }
            }
        };

        finish_outcome(&out_buf, &err_buf, &overflow, exit_code, error_code)
    }

    /// Runs `inner` inside a Windows MXC `ProcessContainer` inheriting the caller's stdin,
    /// stdout, and stderr (used by `cowork-server __sandbox-exec --windows-mxc` and transparent
    /// CLI execution on Windows).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn run_windows_mxc_inherited(
        inner: &SandboxCommand,
        policy: &SandboxPolicy,
        cwd: &Path,
        child_env: &HashMap<String, String>,
        host_env: &HashMap<String, String>,
        opts: WindowsMxcBuildOptions<'_>,
        timeout: Option<Duration>,
    ) -> i32 {
        use std::io::Write;

        let request = build_request_for_host(inner, policy, cwd, child_env, host_env, &opts);
        let mut spawn_opts = SpawnExtendedOptions::default();
        spawn_opts.stdio = SpawnStdio::Inherit;

        let mut proc = match mxc_sdk::v1::spawn_with_extended_options(request, spawn_opts) {
            Ok(p) => p,
            Err(err) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Windows MXC ProcessContainer failed: {}",
                    format_mxc_error(&err)
                );
                return if is_file_not_found_error(&err) {
                    127
                } else {
                    125
                };
            }
        };

        match timeout {
            None => match proc.wait() {
                Ok(WaitResult::Exited(code)) => code,
                Ok(WaitResult::TimedOut) => {
                    let _ = writeln!(std::io::stderr(), "Command timed out");
                    124
                }
                Err(err) => {
                    let _ = writeln!(
                        std::io::stderr(),
                        "Windows MXC ProcessContainer wait failed: {err}"
                    );
                    1
                }
            },
            Some(dur) => {
                let deadline = Instant::now() + dur;
                loop {
                    match proc.try_wait() {
                        Ok(Some(code)) => {
                            let _ = proc.wait();
                            return code;
                        }
                        Ok(None) => {
                            if Instant::now() >= deadline {
                                let _ = proc.kill_for_timeout();
                                let _ = proc.wait();
                                let _ = writeln!(std::io::stderr(), "Command timed out");
                                return 124;
                            }
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::TimedOut => {
                            let _ = proc.wait();
                            let _ = writeln!(std::io::stderr(), "Command timed out");
                            return 124;
                        }
                        Err(err) => {
                            let _ = proc.kill();
                            let _ = proc.wait();
                            let _ = writeln!(
                                std::io::stderr(),
                                "Windows MXC ProcessContainer wait failed: {err}"
                            );
                            return 1;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(windows)]
pub(crate) use native_mxc::{run_windows_mxc_in_process, run_windows_mxc_inherited};

#[cfg(test)]
mod tests {
    use super::*;

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|w| w[0] == flag)
            .map(|w| w[1].as_str())
            .collect()
    }

    #[test]
    fn danger_full_access_without_network_grants_cwd_and_temp_scratch() {
        let cwd = Path::new("/cowork-test-nonexistent/workspace");
        let (mode, roots) = windows_mode_and_writable_roots(
            &SandboxPolicy::DangerFullAccess {
                network: Some(false),
            },
            cwd,
        );
        assert_eq!(mode, "network-only");
        let abs_cwd = std::path::absolute(cwd).unwrap();
        assert!(roots.contains(&abs_cwd), "{roots:?}");
        for scratch in scratch_roots(Some("win32")) {
            let canonical = cowork_config::canonicalize_sync(&scratch);
            assert!(
                roots.contains(&scratch) || roots.contains(&canonical),
                "{scratch:?} missing: {roots:?}"
            );
        }
        let (_, ww_roots) = windows_mode_and_writable_roots(
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![cwd.to_path_buf()],
                writable_root_kinds: HashMap::new(),
                network: false,
            },
            cwd,
        );
        assert_eq!(roots, ww_roots);

        let cmd = build_windows_sandbox_command(
            &SandboxCommand::new("cmd.exe", ["/c", "echo hi"]),
            &SandboxPolicy::DangerFullAccess {
                network: Some(false),
            },
            cwd,
            &HashMap::new(),
            WindowsMxcBuildOptions {
                sandbox_exec_path: Some(Path::new(r"C:\Program Files\Cowork\cowork-server.exe")),
                ..Default::default()
            },
        );
        assert_eq!(cmd.file, r"C:\Program Files\Cowork\cowork-server.exe");
        assert_eq!(cmd.args[0], "__sandbox-exec");
        assert_eq!(cmd.args[1], "--windows-mxc");
        let writable = arg_after(&cmd.args, "--writable-root");
        assert!(
            writable.contains(&abs_cwd.to_str().unwrap()),
            "{:?}",
            cmd.args
        );
        assert!(writable.len() > 1, "temp scratch missing: {:?}", cmd.args);
    }

    const SHORT_TEMP: &str = r"Q:\Users\RUNNER~1\AppData\Local\Temp";
    const LONG_TEMP: &str = r"Q:\Users\runneradmin\AppData\Local\Temp";

    fn fake_8dot3_canon(path: &Path) -> PathBuf {
        let raw = path.to_string_lossy().replace('/', "\\");
        let raw = raw.trim_end_matches('\\');
        let short = SHORT_TEMP.to_ascii_lowercase();
        let lower = raw.to_ascii_lowercase();
        if lower == short || lower.starts_with(&format!("{short}\\")) {
            PathBuf::from(format!("{LONG_TEMP}{}", &raw[SHORT_TEMP.len()..]))
        } else {
            PathBuf::from(raw)
        }
    }

    fn aliased_scratch() -> Vec<PathBuf> {
        vec![
            PathBuf::from(format!(r"{SHORT_TEMP}\")),
            PathBuf::from(LONG_TEMP),
        ]
    }

    #[test]
    fn aliased_temp_ancestor_of_a_project_is_never_granted_as_scratch() {
        let scratch = aliased_scratch();
        for project in [
            format!(r"{LONG_TEMP}\proj"),
            format!(r"{SHORT_TEMP}\proj"),
            format!(r"{}\proj\", LONG_TEMP.to_ascii_uppercase()),
        ] {
            let project = PathBuf::from(project);
            let (mode, roots) = windows_mode_and_writable_roots_with(
                &SandboxPolicy::NoProjectWrite {
                    project_roots: vec![project.clone()],
                    network: false,
                },
                &project,
                &scratch,
                &fake_8dot3_canon,
            );
            assert_eq!((mode, roots), ("read-only", Vec::new()), "{project:?}");

            let (mode, roots) = windows_mode_and_writable_roots_with(
                &SandboxPolicy::WorkspaceWrite {
                    writable_roots: Vec::new(),
                    writable_root_kinds: HashMap::new(),
                    network: false,
                },
                &project,
                &scratch,
                &fake_8dot3_canon,
            );
            assert_eq!(mode, "workspace-write");
            assert!(roots.is_empty(), "{project:?}: {roots:?}");
        }
    }

    #[test]
    fn aliased_temp_collapses_to_one_canonical_scratch_root() {
        let scratch = aliased_scratch();
        let outside = PathBuf::from(r"Q:\work\proj");
        let (mode, roots) = windows_mode_and_writable_roots_with(
            &SandboxPolicy::NoProjectWrite {
                project_roots: vec![outside.clone()],
                network: false,
            },
            &outside,
            &scratch,
            &fake_8dot3_canon,
        );
        assert_eq!(mode, "workspace-write");
        assert_eq!(roots, [PathBuf::from(LONG_TEMP)]);

        let (mode, roots) = windows_mode_and_writable_roots_with(
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![
                    PathBuf::from(format!(r"{SHORT_TEMP}\proj")),
                    PathBuf::from(format!(r"{LONG_TEMP}\proj\")),
                ],
                writable_root_kinds: HashMap::new(),
                network: false,
            },
            &outside,
            &scratch,
            &fake_8dot3_canon,
        );
        assert_eq!(mode, "workspace-write");
        assert_eq!(roots, [PathBuf::from(format!(r"{LONG_TEMP}\proj"))]);

        let (mode, roots) = windows_mode_and_writable_roots_with(
            &SandboxPolicy::DangerFullAccess {
                network: Some(false),
            },
            &outside,
            &scratch,
            &fake_8dot3_canon,
        );
        assert_eq!(mode, "network-only");
        assert_eq!(roots, [outside, PathBuf::from(LONG_TEMP)]);
    }

    #[test]
    fn formats_windows_command_line_with_crt_escaping() {
        assert_eq!(
            format_windows_command_line(
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                &[
                    "-NoProfile".to_owned(),
                    "-Command".to_owned(),
                    r#"Write-Output "hello \"world\"" C:\path\"#.to_owned(),
                    String::new(),
                ]
            ),
            r#""C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "Write-Output \"hello \\\"world\\\"\" C:\path\\" """#
        );
    }

    #[test]
    fn mxc_spec_protects_git_cowork_strips_denied_overlaps_and_preserves_writable_subdir_cwd() {
        let scratch = vec![PathBuf::from(r"C:\Users\Alice\AppData\Local\Temp")];
        let repo = PathBuf::from(r"C:\work\repo");
        let subdir = PathBuf::from(r"C:\work\repo\packages\app");
        let ssh_dir = PathBuf::from(r"C:\Users\Alice\.ssh");
        let cowork_auth = PathBuf::from(r"C:\Users\Alice\.cowork\auth");

        let mut host_env = HashMap::new();
        host_env.insert("USERPROFILE".to_owned(), r"C:\Users\Alice".to_owned());
        host_env.insert("SystemRoot".to_owned(), r"C:\Windows".to_owned());
        host_env.insert(
            "LOCALAPPDATA".to_owned(),
            r"C:\Users\Alice\AppData\Local".to_owned(),
        );
        host_env.insert("OPENAI_API_KEY".to_owned(), "sk-never-leak".to_owned());

        let mut child_env = HashMap::new();
        child_env.insert("PATH".to_owned(), r"C:\Windows\System32".to_owned());
        child_env.insert(PARENT_MANAGED_ENV_VAR.to_owned(), "1".to_owned());

        // 1. Subdirectory `cwd` inside a writable `repo` must NOT be added to `readonly_paths`
        //    (otherwise BaseContainer longest-prefix match would downgrade `cwd` to read-only!).
        let spec = build_windows_mxc_spec_with(
            &SandboxCommand::new(
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                ["-NoProfile", "-Command", "echo ok"],
            ),
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![repo.clone(), cowork_auth.clone()],
                writable_root_kinds: HashMap::new(),
                network: false,
            },
            &subdir,
            &child_env,
            &host_env,
            &WindowsMxcBuildOptions {
                read_allowed_roots: &[
                    PathBuf::from(r"C:\work\repo\skills"),
                    PathBuf::from(r"C:\Users\Alice\.ssh\id_rsa"),
                    PathBuf::from(r"C:\shared\docs\input.docx"),
                ],
                read_denied_roots: &[ssh_dir.clone(), cowork_auth.clone()],
                supports_deny_paths: true,
                extra_tool_readonly_paths: &[
                    PathBuf::from(r"C:\Program Files\nodejs"),
                    PathBuf::from(r"C:\Users\Alice\.cowork\auth\tokens"),
                ],
                ..Default::default()
            },
            &scratch,
            &fake_8dot3_canon,
        );

        assert!(!spec.allow_network);
        assert!(spec.readwrite_paths.contains(&r"C:\work\repo".to_owned()));
        assert!(
            !spec
                .readwrite_paths
                .iter()
                .any(|p| p.eq_ignore_ascii_case(r"C:\Users\Alice\.cowork\auth")),
            "denied root must be stripped from readwrite_paths: {:?}",
            spec.readwrite_paths
        );
        assert!(
            spec.readonly_paths
                .contains(&r"C:\work\repo\.git".to_owned()),
            "{:?}",
            spec.readonly_paths
        );
        assert!(
            spec.readonly_paths
                .contains(&r"C:\work\repo\.cowork".to_owned()),
            "{:?}",
            spec.readonly_paths
        );
        assert!(
            !spec
                .readonly_paths
                .iter()
                .any(|p| p.eq_ignore_ascii_case(r"C:\work\repo\packages\app")
                    || p.eq_ignore_ascii_case(r"C:\work\repo\skills")),
            "general readonly paths inside a writable root must not downgrade it: {:?}",
            spec.readonly_paths
        );
        assert!(
            spec.readonly_paths
                .contains(&r"C:\shared\docs\input.docx".to_owned())
        );
        assert!(
            spec.readonly_paths
                .contains(&r"C:\Users\Alice\.cowork\skills".to_owned())
        );
        assert!(
            !spec
                .readonly_paths
                .iter()
                .any(|p| p.eq_ignore_ascii_case(r"C:\Users\Alice\.cowork")),
            "~/.cowork parent itself must never be granted read-only: {:?}",
            spec.readonly_paths
        );
        assert!(
            !spec
                .readonly_paths
                .iter()
                .any(|p| p.to_ascii_lowercase().contains(".ssh")
                    || p.to_ascii_lowercase().contains(r"\.cowork\auth")),
            "denied paths and their children must be stripped from readonly_paths: {:?}",
            spec.readonly_paths
        );
        assert_eq!(
            spec.denied_paths,
            vec![
                r"C:\Users\Alice\.ssh".to_owned(),
                r"C:\Users\Alice\.cowork\auth".to_owned(),
            ]
        );
        assert!(
            spec.environment
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("SystemRoot") && v == r"C:\Windows")
        );
        assert!(spec.environment.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("LOCALAPPDATA") && v == r"C:\Users\Alice\AppData\Local"
        }));
        assert!(spec.environment.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("PSModulePath")
                && v == r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules"
        }));
        assert!(
            spec.readonly_paths
                .contains(&r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules".to_owned()),
            "built-in Windows PowerShell modules dir must be granted read-only: {:?}",
            spec.readonly_paths
        );
        assert!(
            !spec
                .environment
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case(PARENT_MANAGED_ENV_VAR)
                    || k == "OPENAI_API_KEY")
        );

        // 2. Scoped child (`writable_roots = [C:\work\repo\src]`, `cwd = C:\work\repo`):
        //    `C:\work\repo` IS added to `readonly_paths` while `C:\work\repo\src` stays writable.
        let scoped = build_windows_mxc_spec_with(
            &SandboxCommand::new("pwsh.exe", ["-NoProfile", "-Command", "echo scoped"]),
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from(r"C:\work\repo\src")],
                writable_root_kinds: HashMap::new(),
                network: true,
            },
            &repo,
            &child_env,
            &host_env,
            &WindowsMxcBuildOptions {
                read_denied_roots: &[ssh_dir],
                supports_deny_paths: false,
                ..Default::default()
            },
            &scratch,
            &fake_8dot3_canon,
        );
        assert!(scoped.allow_network);
        assert!(
            scoped
                .readwrite_paths
                .contains(&r"C:\work\repo\src".to_owned())
        );
        assert!(scoped.readonly_paths.contains(&r"C:\work\repo".to_owned()));
        assert!(
            scoped.denied_paths.is_empty(),
            "denied_paths must be omitted when host PSEC lacks deny-path support"
        );
    }
}
