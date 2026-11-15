//! Path boundary helpers matching `apps/desktop/electron/services/pathBoundary.ts`.

use std::path::{Component, Path, PathBuf};

use cowork_config::{
    CaseSensitivity, fs_case_sensitivity, host_platform, normalize_lexical_path,
    strip_windows_verbatim_prefix,
};

/// Normalizes a path lexically and losslessly removes Windows `\\?\` verbatim prefixes
/// so equal paths compare consistently across user input and `fs::canonicalize`.
pub fn normalize_for_boundary_check(path: &Path) -> PathBuf {
    let normalized = normalize_lexical_path(path);
    #[cfg(windows)]
    {
        if let Some(plain) = normalized.to_str().and_then(strip_windows_verbatim_prefix) {
            return PathBuf::from(plain);
        }
    }
    #[cfg(not(windows))]
    if let Some(plain) = normalized.to_str().and_then(strip_windows_verbatim_prefix) {
        return PathBuf::from(plain);
    }
    normalized
}

fn components_match(a: Component<'_>, b: Component<'_>, case_insensitive: bool) -> bool {
    if !case_insensitive {
        return a == b;
    }
    match (a, b) {
        (Component::Prefix(pa), Component::Prefix(pb)) => pa
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&pb.as_os_str().to_string_lossy()),
        (Component::Normal(sa), Component::Normal(sb)) => sa
            .to_string_lossy()
            .eq_ignore_ascii_case(&sb.to_string_lossy()),
        _ => a == b,
    }
}

/// Checks whether `target_path` equals or is lexically inside `root_path` on the given platform.
///
/// Unlike [`cowork_config::is_inside`], this does not call `canonicalize` on `target_path`,
/// allowing callers to authorize un-followed directory entries (such as a symlink being
/// renamed or trashed) after resolving ancestor symlinks explicitly.
pub fn is_path_equal_or_inside_for_platform(
    root_path: &Path,
    target_path: &Path,
    platform: &str,
) -> bool {
    let root = normalize_for_boundary_check(root_path);
    let target = normalize_for_boundary_check(target_path);
    let case_insensitive = fs_case_sensitivity(platform) == CaseSensitivity::Insensitive;

    let root_comps: Vec<Component<'_>> = root.components().collect();
    let target_comps: Vec<Component<'_>> = target.components().collect();
    if target_comps.len() < root_comps.len() {
        return false;
    }

    root_comps
        .iter()
        .zip(target_comps.iter())
        .all(|(&rc, &tc)| components_match(rc, tc, case_insensitive))
}

/// Checks whether `target_path` equals or is lexically inside `root_path` on the host platform.
pub fn is_path_equal_or_inside(root_path: &Path, target_path: &Path) -> bool {
    is_path_equal_or_inside_for_platform(root_path, target_path, host_platform())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_and_nested_paths_are_inside() {
        assert!(is_path_equal_or_inside_for_platform(
            Path::new("/tmp/workspace"),
            Path::new("/tmp/workspace"),
            "linux",
        ));
        assert!(is_path_equal_or_inside_for_platform(
            Path::new("/tmp/workspace"),
            Path::new("/tmp/workspace/src/main.rs"),
            "linux",
        ));
    }

    #[test]
    fn sibling_prefix_and_parent_traversal_are_rejected() {
        assert!(!is_path_equal_or_inside_for_platform(
            Path::new("/tmp/work"),
            Path::new("/tmp/workspace/file.txt"),
            "linux",
        ));
        assert!(!is_path_equal_or_inside_for_platform(
            Path::new("/tmp/workspace"),
            Path::new("/tmp/workspace/../other/secret.txt"),
            "linux",
        ));
    }

    #[test]
    fn case_sensitivity_tracks_platform() {
        assert!(is_path_equal_or_inside_for_platform(
            Path::new("/Users/Alice/Workspace"),
            Path::new("/users/alice/workspace/File.md"),
            "darwin",
        ));
        assert!(!is_path_equal_or_inside_for_platform(
            Path::new("/home/alice/Workspace"),
            Path::new("/home/alice/workspace/File.md"),
            "linux",
        ));
    }
}
