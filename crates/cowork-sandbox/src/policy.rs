use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use cowork_config::{SandboxConfig, SandboxMode as ConfigSandboxMode, canonicalize_sync};
use serde::{Deserialize, Serialize};

use crate::SandboxMode;
use crate::env_utils::host_platform;

/// Creation hint for a non-existent child `targetPaths` entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WritableRootKind {
    Directory,
    File,
}

/// Concrete OS sandbox policy computed from configuration, role, and child scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SandboxPolicy {
    DangerFullAccess {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        network: Option<bool>,
    },
    ReadOnly {
        network: bool,
    },
    NoProjectWrite {
        #[serde(rename = "projectRoots")]
        project_roots: Vec<PathBuf>,
        network: bool,
    },
    WorkspaceWrite {
        #[serde(rename = "writableRoots")]
        writable_roots: Vec<PathBuf>,
        #[serde(
            rename = "writableRootKinds",
            default,
            skip_serializing_if = "HashMap::is_empty"
        )]
        writable_root_kinds: HashMap<PathBuf, WritableRootKind>,
        network: bool,
    },
}

impl SandboxPolicy {
    /// Returns the resolved `SandboxMode` corresponding to this policy.
    pub const fn mode(&self) -> SandboxMode {
        match self {
            Self::DangerFullAccess { .. } => SandboxMode::DangerFullAccess,
            Self::ReadOnly { .. } => SandboxMode::ReadOnly,
            Self::NoProjectWrite { .. } => SandboxMode::NoProjectWrite,
            Self::WorkspaceWrite { .. } => SandboxMode::WorkspaceWrite,
        }
    }

    /// Returns the wire kind string (`"danger-full-access"`, `"read-only"`, `"no-project-write"`, `"workspace-write"`).
    pub const fn kind_str(&self) -> &'static str {
        match self {
            Self::DangerFullAccess { .. } => "danger-full-access",
            Self::ReadOnly { .. } => "read-only",
            Self::NoProjectWrite { .. } => "no-project-write",
            Self::WorkspaceWrite { .. } => "workspace-write",
        }
    }

    /// Returns whether outbound and loopback network access is permitted by this policy.
    pub fn allows_network(&self) -> bool {
        policy_allows_network(self)
    }
}

/// Returns whether a policy allows network access (`DangerFullAccess` defaults to `true`).
pub fn policy_allows_network(policy: &SandboxPolicy) -> bool {
    match policy {
        SandboxPolicy::DangerFullAccess { network } => network.unwrap_or(true),
        SandboxPolicy::ReadOnly { network }
        | SandboxPolicy::NoProjectWrite { network, .. }
        | SandboxPolicy::WorkspaceWrite { network, .. } => *network,
    }
}

/// Inputs to `resolve_sandbox_policy`.
#[derive(Debug, Clone)]
pub struct ResolveSandboxPolicyInput {
    pub config: Option<SandboxConfig>,
    pub working_directory: PathBuf,
    pub project_root: Option<PathBuf>,
    pub output_directory: Option<PathBuf>,
    pub uploads_directory: Option<PathBuf>,
    /// Managed runtime writable roots (e.g. uv cache / ephemeral venvs). Never widens hard floors.
    pub tool_runtime_writable_roots: Vec<PathBuf>,
    /// Child `targetPaths` hard floor; when non-empty, restricts writes strictly to validated paths.
    pub target_paths: Option<Vec<String>>,
    /// Explorer / read-only subagent role (`no-project-write` hard floor).
    pub read_only_role: bool,
    /// `--yolo` lifts sandboxing ONLY when no hard floor (`read-only`, `read_only_role`, `target_paths`, `network: false`) applies.
    pub yolo: bool,
    /// Optional platform override (`"darwin"`, `"linux"`, `"win32"`) for cross-platform tests.
    pub platform: Option<String>,
}

impl ResolveSandboxPolicyInput {
    pub fn new(working_directory: impl Into<PathBuf>) -> Self {
        Self {
            config: None,
            working_directory: working_directory.into(),
            project_root: None,
            output_directory: None,
            uploads_directory: None,
            tool_runtime_writable_roots: Vec::new(),
            target_paths: None,
            read_only_role: false,
            yolo: false,
            platform: None,
        }
    }
}

/// Output of `filter_target_paths_to_workspace`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilteredTargetPaths {
    pub writable_roots: Vec<PathBuf>,
    pub writable_root_kinds: HashMap<PathBuf, WritableRootKind>,
}

/// Infers whether a missing target path represents a file or directory creation target.
///
/// Existing paths return `None` so directories whose names contain dots (e.g. `.github`) are
/// never misclassified as files.
pub fn infer_missing_target_root_kind(
    raw_target: &str,
    resolved_target: &Path,
    platform: &str,
) -> Option<WritableRootKind> {
    if platform == host_platform() && std::fs::metadata(resolved_target).is_ok() {
        return None;
    }
    let trimmed = raw_target.trim();
    if trimmed.ends_with('/') || trimmed.ends_with('\\') {
        return Some(WritableRootKind::Directory);
    }
    let target_lossy = resolved_target.to_string_lossy();
    let base = basename_for_platform(&target_lossy, platform);
    if !base.is_empty() && base != "." && base != ".." && base.contains('.') {
        return Some(WritableRootKind::File);
    }
    None
}

/// Validates and canonicalizes a single `targetPaths` entry against `project_root` (or `working_directory`).
///
/// Rejects empty strings, paths escaping the containment root logically or via symlinks, and
/// paths crossing `.git` or `.cowork` relative to the containment root.
pub fn is_usable_target_path(
    raw_target: &str,
    working_directory: &Path,
    project_root: Option<&Path>,
    platform_override: Option<&str>,
) -> Option<PathBuf> {
    let platform = platform_override.unwrap_or(host_platform());
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return None;
    }
    let wd_str = working_directory.to_string_lossy();
    let contain_str = project_root
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| wd_str.clone().into_owned());

    let logical_root = resolve_for_platform(platform, &wd_str, &contain_str);
    let logical_target = resolve_for_platform(platform, &wd_str, trimmed);
    if !is_inside_for_platform(platform, &logical_root, &logical_target)
        || crosses_protected_subdir(platform, &logical_root, &logical_target)
    {
        return None;
    }

    let canonical_root = canonicalize_for_platform(platform, &logical_root);
    let canonical_target = canonicalize_for_platform(platform, &logical_target);
    if !is_inside_for_platform(platform, &canonical_root, &canonical_target)
        || crosses_protected_subdir(platform, &canonical_root, &canonical_target)
    {
        return None;
    }

    Some(PathBuf::from(canonical_target))
}

/// Resolves, filters, and deduplicates child `targetPaths` inside the workspace.
pub fn filter_target_paths_to_workspace(
    target_paths: &[String],
    working_directory: &Path,
    project_root: Option<&Path>,
    platform_override: Option<&str>,
) -> FilteredTargetPaths {
    let platform = platform_override.unwrap_or(host_platform());
    let mut seen = HashSet::new();
    let mut writable_roots = Vec::new();
    let mut writable_root_kinds = HashMap::new();

    for raw in target_paths {
        let Some(canonical_target) =
            is_usable_target_path(raw, working_directory, project_root, Some(platform))
        else {
            continue;
        };
        let dedupe_key = dedupe_key_for_platform(platform, &canonical_target.to_string_lossy());
        let hinted_kind = infer_missing_target_root_kind(raw, &canonical_target, platform);
        if seen.insert(dedupe_key) {
            if let Some(kind) = hinted_kind {
                writable_root_kinds.insert(canonical_target.clone(), kind);
            }
            writable_roots.push(canonical_target);
        } else if let Some(kind) = hinted_kind {
            writable_root_kinds.entry(canonical_target).or_insert(kind);
        }
    }

    FilteredTargetPaths {
        writable_roots,
        writable_root_kinds,
    }
}

/// Resolves the concrete `SandboxPolicy` from config, role, child scope, and `--yolo`,
/// preserving all hard security floors.
pub fn resolve_sandbox_policy(input: &ResolveSandboxPolicyInput) -> SandboxPolicy {
    let platform = input.platform.as_deref().unwrap_or(host_platform());
    let mode = input
        .config
        .as_ref()
        .map(|c| c.mode)
        .unwrap_or(ConfigSandboxMode::Auto);
    let network = input.config.as_ref().map(|c| c.network).unwrap_or(true);

    // Hard floor 1: explicit read-only config beats everything (including read_only_role & yolo).
    if mode == ConfigSandboxMode::ReadOnly {
        return SandboxPolicy::ReadOnly { network };
    }

    // Hard floor 2: read-only subagent role -> no-project-write (temp scratch allowed, project blocked).
    if input.read_only_role {
        let mut candidates: Vec<&Path> = vec![input.working_directory.as_path()];
        if let Some(pr) = input.project_root.as_deref() {
            candidates.push(pr);
        }
        if let Some(out) = input.output_directory.as_deref() {
            candidates.push(out);
        }
        if let Some(up) = input.uploads_directory.as_deref() {
            candidates.push(up);
        }
        let project_roots = dedupe_canonical_paths(&candidates, platform);
        return SandboxPolicy::NoProjectWrite {
            project_roots,
            network,
        };
    }

    // Hard floor 3: scoped child with non-empty targetPaths -> strictly confined to validated targets.
    if let Some(targets) = input.target_paths.as_ref()
        && !targets.is_empty()
    {
        let filtered = filter_target_paths_to_workspace(
            targets,
            &input.working_directory,
            input.project_root.as_deref(),
            Some(platform),
        );
        return SandboxPolicy::WorkspaceWrite {
            writable_roots: filtered.writable_roots,
            writable_root_kinds: filtered.writable_root_kinds,
            network,
        };
    }

    // Unrestricted filesystem modes (still preserving explicit network: false).
    if input.yolo || mode == ConfigSandboxMode::DangerFullAccess {
        return SandboxPolicy::DangerFullAccess {
            network: Some(network),
        };
    }

    // Default ("auto" or "workspace-write"): workspace + output + uploads + managed runtime roots.
    let mut candidates: Vec<&Path> = vec![input.working_directory.as_path()];
    if let Some(out) = input.output_directory.as_deref() {
        candidates.push(out);
    }
    if let Some(up) = input.uploads_directory.as_deref() {
        candidates.push(up);
    }
    for extra in &input.tool_runtime_writable_roots {
        candidates.push(extra.as_path());
    }
    let writable_roots = dedupe_canonical_paths(&candidates, platform);

    SandboxPolicy::WorkspaceWrite {
        writable_roots,
        writable_root_kinds: HashMap::new(),
        network,
    }
}

/// Returns whether a policy/invocation represents a hard floor that MUST have an OS-enforcing
/// backend and can NEVER be bypassed via `--yolo` or user approval escalation.
pub fn requires_hard_floor_enforcement(
    policy: &SandboxPolicy,
    yolo: bool,
    has_scoped_target_paths: bool,
) -> bool {
    matches!(
        policy,
        SandboxPolicy::ReadOnly { .. } | SandboxPolicy::NoProjectWrite { .. }
    ) || has_scoped_target_paths
        || (yolo && !policy_allows_network(policy))
}

/// Platform scratch directories added alongside workspace writable roots for compiler/runtime temp files.
pub fn scratch_roots(platform_override: Option<&str>) -> Vec<PathBuf> {
    let platform = platform_override.unwrap_or(host_platform());
    match platform {
        "darwin" => vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")],
        "win32" => {
            let raw = std::env::temp_dir();
            if platform == host_platform() {
                let canon = canonicalize_sync(&raw);
                if canon == raw
                    || canon
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&raw.to_string_lossy())
                {
                    vec![raw]
                } else {
                    vec![raw, canon]
                }
            } else {
                vec![raw]
            }
        }
        _ => vec![PathBuf::from("/tmp")],
    }
}

/// Normalizes macOS `/tmp` -> `/private/tmp` and `/var` -> `/private/var` firmlink aliases
/// so ancestor checks work identically across Linux and macOS without disk hits.
pub fn canonical_tmp_alias(p: &Path) -> PathBuf {
    let raw = p.to_string_lossy();
    if is_windows_style_path(&raw) {
        return PathBuf::from(normalize_windows_lexical(&raw));
    }
    let normalized = normalize_posix_lexical(&raw);
    if normalized == "/tmp" {
        PathBuf::from("/private/tmp")
    } else if let Some(rest) = normalized.strip_prefix("/tmp/") {
        PathBuf::from(format!("/private/tmp/{rest}"))
    } else if normalized == "/var" {
        PathBuf::from("/private/var")
    } else if let Some(rest) = normalized.strip_prefix("/var/") {
        PathBuf::from(format!("/private/var/{rest}"))
    } else {
        PathBuf::from(normalized)
    }
}

/// Appends platform scratch roots unless `writable_roots` is empty or already contains a root
/// strictly inside a scratch directory (preventing `/tmp` from widening `/tmp/proj/src`).
pub fn with_tmp_scratch(writable_roots: &[PathBuf], scratch: &[PathBuf]) -> Vec<PathBuf> {
    if writable_roots.is_empty() {
        return Vec::new();
    }
    let norm_roots: Vec<PathBuf> = writable_roots
        .iter()
        .map(|r| canonical_tmp_alias(r))
        .collect();
    let mut out = writable_roots.to_vec();
    for t in scratch {
        if out.iter().any(|existing| existing == t) {
            continue;
        }
        let norm_t = canonical_tmp_alias(t);
        let widens_scoped_root = norm_roots
            .iter()
            .any(|r| r != &norm_t && is_path_inside_auto(&norm_t, r));
        if !widens_scoped_root {
            out.push(t.clone());
        }
    }
    out
}

/// Computes temp scratch directories safe to mount writable when `blocked_roots` must remain
/// un-writable (`no-project-write` and empty-workspace fallback).
///
/// Includes BOTH lexical `blocked_roots` and `canonicalize_sync`-resolved `blocked_roots`
/// normalized via `canonical_tmp_alias` so neither `/tmp -> /private/tmp` nor a workspace
/// symlinked to `/private/tmp` can leak writable access to a blocked project root.
pub fn tmp_scratch_roots(blocked_roots: &[PathBuf], scratch: &[PathBuf]) -> Vec<PathBuf> {
    let canonical_blocked: Vec<PathBuf> = blocked_roots
        .iter()
        .map(|b| {
            let s = b.to_string_lossy();
            if is_windows_style_path(&s) && host_platform() != "win32" {
                PathBuf::from(normalize_windows_lexical(&s))
            } else {
                canonicalize_sync(b)
            }
        })
        .collect();

    let scratch_set: HashSet<&Path> = scratch.iter().map(PathBuf::as_path).collect();
    let candidates: Vec<PathBuf> = if canonical_blocked.is_empty() {
        scratch.to_vec()
    } else {
        with_tmp_scratch(&canonical_blocked, scratch)
            .into_iter()
            .filter(|p| scratch_set.contains(p.as_path()))
            .collect()
    };

    let mut blocked_aliases: Vec<PathBuf> = Vec::new();
    for b in blocked_roots.iter().chain(canonical_blocked.iter()) {
        let alias = canonical_tmp_alias(b);
        if !blocked_aliases.contains(&alias) {
            blocked_aliases.push(alias);
        }
    }

    candidates
        .into_iter()
        .filter(|t| {
            let norm_t = canonical_tmp_alias(t);
            !blocked_aliases
                .iter()
                .any(|b| is_path_inside_auto(b, &norm_t))
        })
        .collect()
}

/// Rewrites `LC_MESSAGES=C` and non-empty `TMPDIR`/`TMP`/`TEMP` pointing outside effective
/// writable roots to `/tmp` on POSIX when `/tmp` is writable under `policy`.
///
/// No-op on `"win32"`, where `build_windows_sandbox_command` handles `TEMP`/`TMP` directly.
pub fn normalize_sandbox_child_env(
    env: &HashMap<String, String>,
    policy: &SandboxPolicy,
    platform_override: Option<&str>,
) -> HashMap<String, String> {
    let platform = platform_override.unwrap_or(host_platform());
    if platform == "win32" {
        return env.clone();
    }

    let mut out = env.clone();
    out.insert("LC_MESSAGES".to_owned(), "C".to_owned());

    let scratch = scratch_roots(Some(platform));
    let effective_roots: Vec<PathBuf> = match policy {
        SandboxPolicy::DangerFullAccess { .. } => return out,
        SandboxPolicy::ReadOnly { .. } => Vec::new(),
        SandboxPolicy::NoProjectWrite { project_roots, .. } => {
            tmp_scratch_roots(project_roots, &scratch)
        }
        SandboxPolicy::WorkspaceWrite { writable_roots, .. } => {
            with_tmp_scratch(writable_roots, &scratch)
        }
    };

    let canonical_roots: Vec<PathBuf> = effective_roots
        .iter()
        .map(|r| canonicalize_posix_or_alias(r))
        .collect();
    let slash_tmp = canonicalize_posix_or_alias(Path::new("/tmp"));
    let can_write_slash_tmp = canonical_roots
        .iter()
        .any(|root| is_path_inside_auto(root, &slash_tmp));
    if !can_write_slash_tmp {
        return out;
    }

    for key in ["TMPDIR", "TMP", "TEMP"] {
        let Some(current) = env.get(key) else {
            continue;
        };
        if current.is_empty() {
            continue;
        }
        let resolved = canonicalize_posix_or_alias(Path::new(current));
        let already_writable = canonical_roots
            .iter()
            .any(|root| is_path_inside_auto(root, &resolved));
        if !already_writable {
            out.insert(key.to_owned(), "/tmp".to_owned());
        }
    }

    out
}

fn canonicalize_posix_or_alias(p: &Path) -> PathBuf {
    let canon = canonicalize_sync(p);
    canonical_tmp_alias(&canon)
}

fn dedupe_canonical_paths(candidates: &[&Path], platform: &str) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let canon_str = canonicalize_for_platform(platform, &candidate.to_string_lossy());
        let key = dedupe_key_for_platform(platform, &canon_str);
        if seen.insert(key) {
            out.push(PathBuf::from(canon_str));
        }
    }
    out
}

fn dedupe_key_for_platform(platform: &str, path: &str) -> String {
    if platform == "win32" {
        normalize_windows_lexical(path).to_ascii_lowercase()
    } else {
        normalize_posix_lexical(path)
    }
}

fn canonicalize_for_platform(platform: &str, logical_path: &str) -> String {
    if platform == host_platform() {
        canonicalize_sync(Path::new(logical_path))
            .to_string_lossy()
            .into_owned()
    } else if platform == "win32" {
        normalize_windows_lexical(logical_path)
    } else {
        normalize_posix_lexical(logical_path)
    }
}

fn resolve_for_platform(platform: &str, base: &str, target: &str) -> String {
    if platform == "win32" {
        resolve_windows_lexical(base, target)
    } else if target.starts_with('/') {
        normalize_posix_lexical(target)
    } else {
        normalize_posix_lexical(&format!("{base}/{target}"))
    }
}

fn is_inside_for_platform(platform: &str, root: &str, target: &str) -> bool {
    if platform == "win32" {
        is_inside_windows_lexical(root, target)
    } else {
        is_inside_posix_lexical(root, target)
    }
}

fn crosses_protected_subdir(platform: &str, root: &str, target: &str) -> bool {
    let Some(rel_segments) = relative_segments_if_inside(platform, root, target) else {
        return false;
    };
    rel_segments
        .iter()
        .any(|seg| seg.eq_ignore_ascii_case(".git") || seg.eq_ignore_ascii_case(".cowork"))
}

fn relative_segments_if_inside(platform: &str, root: &str, target: &str) -> Option<Vec<String>> {
    if platform == "win32" {
        let (root_prefix, root_segs) = split_windows_components(&normalize_windows_lexical(root))?;
        let (target_prefix, target_segs) =
            split_windows_components(&normalize_windows_lexical(target))?;
        if !root_prefix.eq_ignore_ascii_case(&target_prefix) || target_segs.len() < root_segs.len()
        {
            return None;
        }
        for (r, t) in root_segs.iter().zip(target_segs.iter()) {
            if !r.eq_ignore_ascii_case(t) {
                return None;
            }
        }
        Some(target_segs[root_segs.len()..].to_vec())
    } else {
        let norm_root = normalize_posix_lexical(root);
        let norm_target = normalize_posix_lexical(target);
        if norm_root == norm_target {
            return Some(Vec::new());
        }
        if norm_root == "/" {
            let rest = norm_target.strip_prefix('/')?;
            return Some(
                rest.split('/')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
            );
        }
        let prefix = format!("{norm_root}/");
        let rest = norm_target.strip_prefix(&prefix)?;
        Some(
            rest.split('/')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }
}

fn is_path_inside_auto(root: &Path, target: &Path) -> bool {
    let r = root.to_string_lossy();
    let t = target.to_string_lossy();
    if is_windows_style_path(&r) || is_windows_style_path(&t) {
        is_inside_windows_lexical(&r, &t)
    } else {
        is_inside_posix_lexical(&r, &t)
    }
}

fn is_windows_style_path(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || raw.starts_with("\\\\")
}

fn normalize_posix_lexical(raw: &str) -> String {
    let abs = raw.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if let Some(last) = stack.last()
                && *last != ".."
            {
                stack.pop();
            } else if !abs {
                stack.push("..");
            }
        } else {
            stack.push(seg);
        }
    }
    if abs {
        if stack.is_empty() {
            "/".to_owned()
        } else {
            format!("/{}", stack.join("/"))
        }
    } else if stack.is_empty() {
        ".".to_owned()
    } else {
        stack.join("/")
    }
}

fn is_inside_posix_lexical(root: &str, target: &str) -> bool {
    relative_segments_if_inside("linux", root, target).is_some()
}

fn resolve_windows_lexical(base: &str, target: &str) -> String {
    let bytes = target.as_bytes();
    let is_drive_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_unc_abs = (target.starts_with("\\\\") || target.starts_with("//")) && target.len() > 2;
    if is_drive_abs || is_unc_abs {
        return normalize_windows_lexical(target);
    }
    if target.starts_with('\\') || target.starts_with('/') {
        if let Some((prefix, _)) = split_windows_components(&normalize_windows_lexical(base)) {
            return normalize_windows_lexical(&format!("{prefix}\\{target}"));
        }
        return normalize_windows_lexical(target);
    }
    normalize_windows_lexical(&format!("{base}\\{target}"))
}

fn normalize_windows_lexical(raw: &str) -> String {
    let unified = raw.replace('/', "\\");
    if let Some(rest) = unified.strip_prefix("\\\\") {
        let mut parts = rest.split('\\').filter(|s| !s.is_empty());
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        let mut stack: Vec<&str> = Vec::new();
        for seg in parts {
            if seg == "." {
                continue;
            }
            if seg == ".." {
                stack.pop();
            } else {
                stack.push(seg);
            }
        }
        let prefix = format!("\\\\{server}\\{share}");
        if stack.is_empty() {
            prefix
        } else {
            format!("{prefix}\\{}", stack.join("\\"))
        }
    } else if unified.len() >= 2
        && unified.as_bytes()[0].is_ascii_alphabetic()
        && unified.as_bytes()[1] == b':'
    {
        let drive = &unified[..2];
        let rest = &unified[2..];
        let mut stack: Vec<&str> = Vec::new();
        for seg in rest.split('\\') {
            if seg.is_empty() || seg == "." {
                continue;
            }
            if seg == ".." {
                stack.pop();
            } else {
                stack.push(seg);
            }
        }
        if stack.is_empty() {
            format!("{drive}\\")
        } else {
            format!("{drive}\\{}", stack.join("\\"))
        }
    } else {
        unified
    }
}

fn split_windows_components(normalized: &str) -> Option<(String, Vec<String>)> {
    if let Some(rest) = normalized.strip_prefix("\\\\") {
        let mut parts = rest.split('\\').filter(|s| !s.is_empty());
        let server = parts.next()?;
        let share = parts.next()?;
        let prefix = format!("\\\\{server}\\{share}");
        let segs = parts.map(str::to_owned).collect();
        Some((prefix, segs))
    } else if normalized.len() >= 2
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && normalized.as_bytes()[1] == b':'
    {
        let prefix = normalized[..2].to_owned();
        let rest = &normalized[2..];
        let segs = rest
            .split('\\')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        Some((prefix, segs))
    } else {
        None
    }
}

fn is_inside_windows_lexical(root: &str, target: &str) -> bool {
    relative_segments_if_inside("win32", root, target).is_some()
}

fn basename_for_platform<'a>(path: &'a str, platform: &str) -> &'a str {
    let trimmed = if platform == "win32" {
        path.trim_end_matches(['/', '\\'])
    } else {
        path.trim_end_matches('/')
    };
    let idx = if platform == "win32" {
        trimmed.rfind(['/', '\\'])
    } else {
        trimmed.rfind('/')
    };
    match idx {
        Some(pos) => &trimmed[pos + 1..],
        None => trimmed,
    }
}
