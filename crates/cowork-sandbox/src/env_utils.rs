use std::collections::{HashMap, HashSet};

/// Parent-managed sidecar lifecycle variable that MUST never leak into child processes.
pub const PARENT_MANAGED_ENV_VAR: &str = "COWORK_DESKTOP_PARENT_MANAGED";

const SANDBOX_ENV_ALLOWLIST_BASE: &[&str] = &[
    "CI",
    "COLORTERM",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
    "WINDIR",
    // Cowork runtime pointers (not secrets).
    "COWORK_RUNTIME_DIR",
    "COWORK_RUNTIME_VERSION",
    "COWORK_RUNTIME_ASSET",
    "COWORK_RUNTIME_BIN",
    "COWORK_RUNTIME_NODE",
    "COWORK_RUNTIME_PYTHON",
    "COWORK_RUNTIME_GIT",
    "COWORK_RUNTIME_NODE_MODULES",
    "COWORK_RUNTIME_NODE_RESOLVER",
    "COWORK_RUNTIME_POPPLER_BIN",
    "COWORK_RUNTIME_PDFTOPPM",
    "COWORK_RUNTIME_SOFFICE",
    "COWORK_RUNTIME_LIBREOFFICE_DIR",
    "COWORK_RUNTIME_LIBREOFFICE_BINARY",
    "COWORK_RUNTIME_UV",
    "COWORK_RUNTIME_WHEELHOUSE",
    "COWORK_RUNTIME_PACKS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONDONTWRITEBYTECODE",
    "SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION",
    "UV_CACHE_DIR",
    "UV_FIND_LINKS",
    "UV_LINK_MODE",
    "UV_NO_INDEX",
    "UV_NO_MANAGED_PYTHON",
    "UV_OFFLINE",
    "UV_PYTHON",
    "UV_PYTHON_DOWNLOADS",
    "UV_PYTHON_PREFERENCE",
    "VIRTUAL_ENV",
];

const SANDBOX_ENV_ALLOWLIST_WIN32_EXTRA: &[&str] = &[
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
];

/// Returns the Node-compatible host platform identifier (`"darwin"`, `"linux"`, `"win32"`).
pub const fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// Returns the Node-compatible host architecture identifier (`"arm64"`, `"x64"`, `"ia32"`).
pub const fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "x86") {
        "ia32"
    } else {
        std::env::consts::ARCH
    }
}

/// Finds the preserved key spelling in `env` (`win32` case-insensitive fallback, POSIX exact).
pub fn find_env_key<'a>(
    env: &'a HashMap<String, String>,
    name: &str,
    platform: &str,
) -> Option<&'a str> {
    if let Some((k, _)) = env.get_key_value(name) {
        return Some(k.as_str());
    }
    if platform != "win32" {
        return None;
    }
    env.keys()
        .find(|candidate| candidate.eq_ignore_ascii_case(name))
        .map(String::as_str)
}

/// Reads an environment variable honoring platform key case-sensitivity.
pub fn get_env<'a>(
    env: &'a HashMap<String, String>,
    name: &str,
    platform: &str,
) -> Option<&'a str> {
    let key = find_env_key(env, name, platform)?;
    env.get(key).map(String::as_str)
}

/// Sets an environment variable in place, preserving existing Windows key casing (e.g. `"Path"`).
pub fn set_env(env: &mut HashMap<String, String>, name: &str, value: String, platform: &str) {
    if let Some(existing) = find_env_key(env, name, platform).map(str::to_owned) {
        env.insert(existing, value);
    } else {
        env.insert(name.to_owned(), value);
    }
}

/// Removes an environment variable honoring platform key case-sensitivity.
pub fn remove_env(env: &mut HashMap<String, String>, name: &str, platform: &str) {
    if platform == "win32" {
        env.retain(|k, _| !k.eq_ignore_ascii_case(name));
    } else {
        env.remove(name);
    }
}

/// Returns the set of environment variable names allowed through to sandboxed child commands.
pub fn sandbox_env_allowlist(platform: &str) -> HashSet<&'static str> {
    let mut set: HashSet<&'static str> = SANDBOX_ENV_ALLOWLIST_BASE.iter().copied().collect();
    if platform == "win32" {
        set.extend(SANDBOX_ENV_ALLOWLIST_WIN32_EXTRA.iter().copied());
    }
    set
}

/// Builds the minimal redacted environment map for a sandboxed child process.
///
/// Preserves inherited Windows key spellings (`"Path"`) and strips secrets plus
/// `COWORK_DESKTOP_PARENT_MANAGED`.
pub fn minimal_sandbox_env(
    source: &HashMap<String, String>,
    platform: &str,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for &name in SANDBOX_ENV_ALLOWLIST_BASE {
        copy_allowed_key(source, &mut env, name, platform);
    }
    if platform == "win32" {
        for &name in SANDBOX_ENV_ALLOWLIST_WIN32_EXTRA {
            copy_allowed_key(source, &mut env, name, platform);
        }
    }
    remove_env(&mut env, PARENT_MANAGED_ENV_VAR, platform);
    env
}

fn copy_allowed_key(
    source: &HashMap<String, String>,
    dest: &mut HashMap<String, String>,
    name: &str,
    platform: &str,
) {
    let Some(source_key) = find_env_key(source, name, platform) else {
        return;
    };
    if find_env_key(dest, name, platform).is_some() {
        return;
    }
    if let Some(val) = source.get(source_key) {
        dest.insert(source_key.to_owned(), val.clone());
    }
}

/// Collects the current process environment into a `HashMap<String, String>` with
/// `COWORK_DESKTOP_PARENT_MANAGED` stripped.
pub fn sanitized_process_env() -> HashMap<String, String> {
    let mut map: HashMap<String, String> = std::env::vars().collect();
    remove_env(&mut map, PARENT_MANAGED_ENV_VAR, host_platform());
    map
}
