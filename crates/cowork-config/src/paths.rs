use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

use crate::COWORK_HOME_OVERRIDE_ENV;
use crate::error::{ConfigError, Result};

/// Metadata directory names that must stay read-only even inside a writable root.
pub const PROTECTED_METADATA_DIR_NAMES: [&str; 2] = [".git", ".cowork"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseSensitivity {
    Sensitive,
    Insensitive,
}

pub fn host_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub fn fs_case_sensitivity(platform: &str) -> CaseSensitivity {
    if platform == "win32" || platform == "darwin" {
        CaseSensitivity::Insensitive
    } else {
        CaseSensitivity::Sensitive
    }
}

/// Whether any existing component of `path` is a symbolic link (or, on Windows, a junction or
/// other name-surrogate reparse point). This mirrors what Node's JS `fs.realpathSync` resolves:
/// unlike `std::fs::canonicalize`, it does not treat Windows 8.3 short names or a missing `\\?\`
/// prefix as non-canonical.
pub fn path_has_link_component(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if matches!(
            component,
            std::path::Component::Prefix(_) | std::path::Component::RootDir
        ) {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(&current)
            && meta.file_type().is_symlink()
        {
            return true;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if let Ok(meta) = fs::symlink_metadata(&current)
                && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return true;
            }
        }
    }
    false
}

/// Whether `path` stays inside `root` without traversing a link below it: `path` must be
/// lexically under `root` with only normal components, no existing component below `root` may
/// be a symbolic link or Windows reparse point (junction), and the canonical form of `path` must
/// stay inside the canonical `root`. Components that do not exist yet are allowed (they would be
/// created as real entries). `root` itself may be reached through links (a workspace opened via
/// a symlinked path); only what lies below it is constrained.
///
/// Used for workspace-controlled locations such as `<cwd>/.cowork/config.json` and
/// `<cwd>/.agent`: an untrusted repository must not redirect them at trusted files (for example
/// `<cwd>/.cowork -> ~/.cowork/config`).
pub fn is_confined_below(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return false;
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(meta) if metadata_is_link(&meta) => return false,
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return false,
        }
    }
    canonicalize_sync(path).starts_with(canonicalize_sync(root))
}

/// Symbolic link, or on Windows any reparse point (junctions included).
fn metadata_is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// Purely lexical path normalization resolving `.` and `..` without touching the filesystem.
pub fn normalize_lexical_path(path: &Path) -> PathBuf {
    let base = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };

    let mut normalized = PathBuf::new();
    for component in base.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = normalized
                    .components()
                    .next_back()
                    .is_some_and(|c| matches!(c, Component::Normal(_)));
                if can_pop {
                    normalized.pop();
                }
            }
            Component::Normal(seg) => normalized.push(seg),
        }
    }
    normalized
}

/// Longest legacy Win32 path (`MAX_PATH` minus the terminating NUL) that may be spelled
/// without the `\\?\` verbatim prefix.
const WINDOWS_MAX_PLAIN_PATH_LEN: usize = 259;

/// Converts a Windows verbatim (`\\?\`) path into the plain spelling that
/// `fs.realpathSync.native` (TS `canonicalizeSync`) returns, when that is lossless:
/// `\\?\C:\dir` becomes `C:\dir` and `\\?\UNC\server\share\dir` becomes
/// `\\server\share\dir`. Returns `None` (keep the verbatim form) for other verbatim
/// namespaces (`\\?\Volume{…}`, `\\?\GLOBALROOT…`) and for paths whose meaning would change
/// without the prefix: over-long paths, `/` separators, `.`/`..` or empty components, names
/// with characters Win32 rejects, trailing dots/spaces, or reserved device names (`CON`,
/// `NUL`, `COM1`, …). Platform-independent so the rules are unit-tested everywhere; only
/// applied on Windows.
pub fn strip_windows_verbatim_prefix(raw: &str) -> Option<String> {
    let (plain, components) = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        let mut parts = rest.splitn(3, '\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (format!(r"\\{rest}"), rest)
    } else {
        // Only drive-letter verbatim paths have a plain spelling (`\\?\Volume{…}` does not).
        let rest = raw.strip_prefix(r"\\?\")?;
        let bytes = rest.as_bytes();
        let has_drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\';
        if !has_drive {
            return None;
        }
        (rest.to_owned(), &rest[3..])
    };
    if plain.len() > WINDOWS_MAX_PLAIN_PATH_LEN || components.contains('/') {
        return None;
    }
    let mut segments: Vec<&str> = components.split('\\').collect();
    // A single trailing separator (`C:\dir\`) is harmless; any other empty segment is not.
    if segments.len() > 1 && segments.last() == Some(&"") {
        segments.pop();
    }
    let is_drive_root = segments == [""] && !raw.starts_with(r"\\?\UNC\");
    if !is_drive_root
        && !segments
            .iter()
            .all(|segment| is_plain_win32_segment(segment))
    {
        return None;
    }
    Some(plain)
}

fn is_plain_win32_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return false;
    }
    if segment
        .chars()
        .any(|ch| (ch as u32) < 0x20 || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    // `COM0`-`COM9` / `LPT0`-`LPT9`, including the superscript-digit spellings.
    let is_port = stem.starts_with("COM") || stem.starts_with("LPT");
    let port_suffix = stem.get(3..).unwrap_or_default();
    !(is_port
        && (matches!(port_suffix.as_bytes(), [b'0'..=b'9'])
            || matches!(port_suffix, "\u{b9}" | "\u{b2}" | "\u{b3}")))
}

/// `fs::canonicalize` output in the spelling TS `realpathSync.native` produced: on Windows the
/// `\\?\` verbatim prefix is dropped when that is lossless, so canonical paths keep matching
/// rows that pre-upgrade sessions.db, Electron, and task workspaces stored in plain form.
fn simplify_canonical(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(plain) = path.to_str().and_then(strip_windows_verbatim_prefix) {
            return PathBuf::from(plain);
        }
    }
    path
}

/// Canonicalizes `target_path` against the real filesystem, resolving the longest
/// existing ancestor via `fs::canonicalize` and lexically appending any missing suffix.
pub fn canonicalize_sync(target_path: &Path) -> PathBuf {
    let resolved = normalize_lexical_path(target_path);
    if let Ok(canon) = fs::canonicalize(&resolved) {
        return simplify_canonical(canon);
    }

    let mut pending_segments: Vec<std::ffi::OsString> = Vec::new();
    let mut current = resolved.as_path();

    loop {
        if let Ok(canon_ancestor) = fs::canonicalize(current) {
            let mut out = simplify_canonical(canon_ancestor);
            for seg in pending_segments.into_iter().rev() {
                out.push(seg);
            }
            return out;
        }

        let Some(file_name) = current.file_name() else {
            return resolved;
        };
        let Some(parent) = current.parent() else {
            return resolved;
        };
        if parent == current {
            return resolved;
        }
        pending_segments.push(file_name.to_os_string());
        current = parent;
    }
}

fn strip_trailing_separators(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    let mut end = bytes.len();
    while end > 1 && (bytes[end - 1] == b'/' || bytes[end - 1] == b'\\') {
        end -= 1;
    }
    if end == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && raw.len() > 2 {
        return &raw[..3];
    }
    &raw[..end]
}

/// Canonical dedupe/lock key (case-folded on win32 and darwin).
pub fn canonical_key(path: &Path, platform: &str) -> String {
    let canon = canonicalize_sync(path);
    let stripped = strip_trailing_separators(&canon.to_string_lossy()).to_string();
    if fs_case_sensitivity(platform) == CaseSensitivity::Insensitive {
        stripped.to_lowercase()
    } else {
        stripped
    }
}

/// Whether two paths refer to the same filesystem location.
pub fn same_path(a: &Path, b: &Path, platform: &str) -> bool {
    let canon_a = canonicalize_sync(a);
    let canon_b = canonicalize_sync(b);
    let lossy_a = canon_a.to_string_lossy();
    let lossy_b = canon_b.to_string_lossy();
    let str_a = strip_trailing_separators(&lossy_a);
    let str_b = strip_trailing_separators(&lossy_b);
    if platform == "win32" {
        str_a.eq_ignore_ascii_case(str_b)
    } else {
        str_a == str_b
    }
}

/// Workspace equality helper matching `src/utils/workspacePath.ts`.
pub fn same_workspace_path(a: &str, b: &str) -> bool {
    let ta = a.trim();
    let tb = b.trim();
    if ta.is_empty() || tb.is_empty() {
        return false;
    }
    same_path(Path::new(ta), Path::new(tb), host_platform())
}

/// Accept-side containment check (`child` canonicalizes inside `parent`, or equals it).
pub fn is_inside(parent: &Path, child: &Path) -> bool {
    is_inside_with_options(parent, child, host_platform(), true)
}

pub fn is_inside_with_options(
    parent: &Path,
    child: &Path,
    platform: &str,
    allow_equal: bool,
) -> bool {
    let canon_parent = canonicalize_sync(parent);
    let canon_child = canonicalize_sync(child);

    if platform == "win32" {
        let p_low = PathBuf::from(canon_parent.to_string_lossy().to_lowercase());
        let c_low = PathBuf::from(canon_child.to_string_lossy().to_lowercase());
        match c_low.strip_prefix(&p_low) {
            Ok(rel) => allow_equal || !rel.as_os_str().is_empty(),
            Err(_) => false,
        }
    } else {
        match canon_child.strip_prefix(&canon_parent) {
            Ok(rel) => allow_equal || !rel.as_os_str().is_empty(),
            Err(_) => false,
        }
    }
}

pub fn assert_within_roots(roots: &[PathBuf], target: &Path) -> Result<PathBuf> {
    let canon_target = canonicalize_sync(target);
    for root in roots {
        if is_inside(root, &canon_target) {
            return Ok(canon_target);
        }
    }
    Err(ConfigError::OutsidePermittedRoots(canon_target))
}

/// Deny-side check: does `target` relative to `base` pass through `.git` or `.cowork`?
pub fn crosses_protected_metadata(base: &Path, target: &Path, platform: &str) -> bool {
    let lex_base = normalize_lexical_path(base);
    let lex_target = normalize_lexical_path(target);
    let fold = fs_case_sensitivity(platform) == CaseSensitivity::Insensitive;

    let rel = if platform == "win32" {
        let b_low = PathBuf::from(lex_base.to_string_lossy().to_lowercase());
        let t_low = PathBuf::from(lex_target.to_string_lossy().to_lowercase());
        match t_low.strip_prefix(&b_low) {
            Ok(r) if !r.as_os_str().is_empty() => r.to_path_buf(),
            _ => return false,
        }
    } else {
        match lex_target.strip_prefix(&lex_base) {
            Ok(r) if !r.as_os_str().is_empty() => r.to_path_buf(),
            _ => return false,
        }
    };

    for comp in rel.components() {
        if let Component::Normal(os) = comp {
            let s = os.to_string_lossy();
            let candidate = if fold {
                s.to_lowercase()
            } else {
                s.into_owned()
            };
            for protected in PROTECTED_METADATA_DIR_NAMES {
                let expected = if fold {
                    protected.to_lowercase()
                } else {
                    protected.to_string()
                };
                if candidate == expected {
                    return true;
                }
            }
        }
    }
    false
}

/// Resolves the effective user home directory honoring `COWORK_HOME_OVERRIDE`,
/// `HOME` on non-Windows platforms, and falling back to OS home directory.
pub fn resolve_home_dir(env: &HashMap<String, String>, platform: &str) -> PathBuf {
    if let Some(override_dir) = env
        .get(COWORK_HOME_OVERRIDE_ENV)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return canonicalize_sync(Path::new(override_dir));
    }

    if platform != "win32"
        && let Some(posix_home) = env.get("HOME").map(|s| s.trim()).filter(|s| !s.is_empty())
    {
        return canonicalize_sync(Path::new(posix_home));
    }

    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn env_map_from_process() -> HashMap<String, String> {
    std::env::vars().collect()
}

pub fn cowork_home(env: &HashMap<String, String>) -> PathBuf {
    resolve_home_dir(env, host_platform()).join(".cowork")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiCoworkerPaths {
    pub root_dir: PathBuf,
    pub auth_dir: PathBuf,
    pub codex_auth_dir: PathBuf,
    pub config_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub memories_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub chats_dir: PathBuf,
    pub connections_file: PathBuf,
}

pub fn get_ai_coworker_paths(
    homedir: Option<&Path>,
    env: &HashMap<String, String>,
) -> AiCoworkerPaths {
    let home = homedir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| resolve_home_dir(env, host_platform()));
    let root_dir = home.join(".cowork");
    let auth_dir = root_dir.join("auth");
    let config_dir = root_dir.join("config");
    let sessions_dir = root_dir.join("sessions");
    let logs_dir = root_dir.join("logs");
    let skills_dir = root_dir.join("skills");
    let memories_dir = root_dir.join("memories");
    let codex_auth_dir = auth_dir.join("codex-cli");
    let runtime_dir = root_dir.join("runtime");
    let bin_dir = root_dir.join("bin");
    let chats_dir = root_dir.join("chats");
    let connections_file = auth_dir.join("connections.json");
    AiCoworkerPaths {
        root_dir,
        auth_dir,
        codex_auth_dir,
        config_dir,
        sessions_dir,
        logs_dir,
        skills_dir,
        memories_dir,
        runtime_dir,
        bin_dir,
        chats_dir,
        connections_file,
    }
}

pub fn ensure_private_dir_sync(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).map_err(|source| ConfigError::Io {
        path: dir.to_path_buf(),
        source,
    })?;
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn harden_private_file_sync(path: &Path) {
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

pub fn ensure_ai_coworker_home(paths: &AiCoworkerPaths) -> Result<()> {
    for dir in [
        &paths.root_dir,
        &paths.auth_dir,
        &paths.config_dir,
        &paths.sessions_dir,
        &paths.logs_dir,
        &paths.skills_dir,
        &paths.memories_dir,
    ] {
        ensure_private_dir_sync(dir)?;
    }
    Ok(())
}

pub fn get_one_off_chats_root(homedir: &Path) -> PathBuf {
    homedir.join(".cowork").join("chats")
}

pub fn is_path_inside_one_off_chats_root(cwd: &Path, homedir: &Path) -> bool {
    let root = get_one_off_chats_root(homedir);
    is_inside_with_options(&root, cwd, host_platform(), false)
}

/// File name of the SQLite memory store (`src/memoryStore.ts`): `<project>/.cowork/memory.sqlite`
/// and `~/.cowork/memory.sqlite`. Existing installs keep their memories in these files.
pub const MEMORY_DB_FILE_NAME: &str = "memory.sqlite";

/// `.cowork` directory owning a workspace's project memory (`src/config.ts`
/// `projectMemoryCoworkDir`): one-off chat workspaces share `<home>/.cowork/chats/.cowork`;
/// every other workspace uses its own `<cwd>/.cowork`.
pub fn project_memory_cowork_dir(cwd: &Path, homedir: &Path) -> PathBuf {
    if is_path_inside_one_off_chats_root(cwd, homedir) {
        get_one_off_chats_root(homedir).join(".cowork")
    } else {
        cwd.join(".cowork")
    }
}

/// Workspace-scope SQLite memory database (`AgentConfig::project_memory_db_path`).
pub fn project_memory_db_path(cwd: &Path, homedir: &Path) -> PathBuf {
    project_memory_cowork_dir(cwd, homedir).join(MEMORY_DB_FILE_NAME)
}

/// User-scope SQLite memory database (`AgentSession`: `${userCoworkDir}/memory.sqlite`).
pub fn user_memory_db_path(user_cowork_dir: &Path) -> PathBuf {
    user_cowork_dir.join(MEMORY_DB_FILE_NAME)
}

/// Writes `contents` atomically via a sibling temporary file and applies optional POSIX mode.
pub fn write_text_file_atomic(target: &Path, contents: &str, mode: Option<u32>) -> Result<()> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| ConfigError::Io {
        path: parent.to_path_buf(),
        source,
    })?;

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let tmp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));

    let write_res = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(m) = mode {
            opts.mode(m);
        }
        let mut file = opts.open(&tmp_path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        if let Some(m) = mode {
            let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(m));
        }
        fs::rename(&tmp_path, target)?;
        #[cfg(unix)]
        if let Some(m) = mode {
            let _ = fs::set_permissions(target, fs::Permissions::from_mode(m));
        }
        Ok(())
    })();

    if let Err(source) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(ConfigError::Io {
            path: target.to_path_buf(),
            source,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_windows_verbatim_prefix_returns_plain_drive_and_unc_paths() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\me\project").as_deref(),
            Some(r"C:\Users\me\project")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\d:\work\").as_deref(),
            Some(r"d:\work\")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\").as_deref(),
            Some(r"C:\")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\dir").as_deref(),
            Some(r"\\server\share\dir")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share").as_deref(),
            Some(r"\\server\share")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\My Docs\notes.v2.md").as_deref(),
            Some(r"C:\My Docs\notes.v2.md")
        );
    }

    #[test]
    fn strip_windows_verbatim_prefix_keeps_paths_that_would_change_meaning() {
        for raw in [
            // Not verbatim at all, or a verbatim namespace without a plain spelling.
            r"C:\already\plain",
            r"\\server\share",
            r"\\?\Volume{0f2c5c1e-0000-0000-0000-100000000000}\dir",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1",
            r"\\?\C:",
            r"\\?\UNC\server",
            r"\\?\UNC\\share",
            // Components Win32 would reinterpret without the prefix.
            r"\\?\C:\dir\..\secret",
            r"\\?\C:\dir\.\file",
            r"\\?\C:\dir\\file",
            r"\\?\C:\dir/file",
            r"\\?\C:\trailing.",
            r"\\?\C:\trailing ",
            r"\\?\C:\bad<name",
            r"\\?\C:\ads:stream",
            r"\\?\C:\dir\CON",
            r"\\?\C:\dir\nul.txt",
            r"\\?\C:\dir\com1",
            r"\\?\C:\dir\LPT9.log",
            r"\\?\UNC\server\share\aux",
        ] {
            assert_eq!(strip_windows_verbatim_prefix(raw), None, "{raw}");
        }
        let long = format!(r"\\?\C:\{}", "a".repeat(WINDOWS_MAX_PLAIN_PATH_LEN));
        assert_eq!(strip_windows_verbatim_prefix(&long), None);
        let fits = format!(r"\\?\C:\{}", "a".repeat(WINDOWS_MAX_PLAIN_PATH_LEN - 3));
        assert_eq!(
            strip_windows_verbatim_prefix(&fits).map(|p| p.len()),
            Some(WINDOWS_MAX_PLAIN_PATH_LEN)
        );
        // Names that merely start with a device name are ordinary.
        assert!(strip_windows_verbatim_prefix(r"\\?\C:\console\conf\com10\lpt").is_some());
    }
}
