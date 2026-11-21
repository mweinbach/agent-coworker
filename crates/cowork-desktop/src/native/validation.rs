//! Path, ID, workspace, and Windows UNC/device validation matching
//! `apps/desktop/electron/services/validation.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use cowork_config::{canonicalize_sync, host_platform, normalize_lexical_path};

use super::path_boundary::is_path_equal_or_inside;

#[derive(Clone, Debug, PartialEq, Eq)]
enum WindowsRemotePath {
    Local,
    Device,
    Share(String),
}

/// Checks whether `id` consists of 1..=256 `[A-Za-z0-9_-]` characters.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Validates an identifier used for file names or map keys (`[A-Za-z0-9_-]{1,256}`).
pub fn assert_safe_id(id: &str, label: &str) -> Result<()> {
    if !is_safe_id(id) {
        bail!("{label} contains invalid characters");
    }
    Ok(())
}

/// Validates that `workspace_path` is a non-empty existing directory.
pub fn assert_workspace_directory(workspace_path: &Path) -> Result<()> {
    let raw = workspace_path.to_string_lossy();
    if raw.trim().is_empty() {
        bail!("workspacePath must not be empty");
    }
    let meta = match fs::metadata(workspace_path) {
        Ok(m) => m,
        Err(_) => bail!(
            "Workspace folder is unavailable: {}. Reconnect its drive or restore access, then retry.",
            workspace_path.display()
        ),
    };
    if !meta.is_dir() {
        bail!(
            "Workspace path is not a directory: {}",
            workspace_path.display()
        );
    }
    Ok(())
}

/// Validates message direction strings (`"server"` or `"client"`).
pub fn assert_direction(direction: &str) -> Result<&'static str> {
    match direction.trim().to_ascii_lowercase().as_str() {
        "server" => Ok("server"),
        "client" => Ok("client"),
        _ => bail!("direction must be 'server' or 'client'"),
    }
}

/// Ensures resolved transcript file paths stay strictly inside `root`.
pub fn assert_within_transcripts_dir(root: &Path, file_path: &Path) -> Result<()> {
    let normalized_root = normalize_lexical_path(root);
    let normalized_path = normalize_lexical_path(file_path);
    if !is_path_equal_or_inside(&normalized_root, &normalized_path) {
        bail!("Resolved transcript path escapes transcript root");
    }
    Ok(())
}

fn is_win_sep(b: u8) -> bool {
    b == b'\\' || b == b'/'
}

fn classify_windows_remote_path(raw_target: &str) -> WindowsRemotePath {
    let trimmed = raw_target.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 2 || !is_win_sep(bytes[0]) || !is_win_sep(bytes[1]) {
        return WindowsRemotePath::Local;
    }

    // `\\?\C:\...` (drive long path) -> local.
    if bytes.len() >= 6
        && bytes[2] == b'?'
        && is_win_sep(bytes[3])
        && bytes[4].is_ascii_alphabetic()
        && bytes[5] == b':'
        && (bytes.len() == 6 || is_win_sep(bytes[6]))
    {
        return WindowsRemotePath::Local;
    }

    // `\\?\UNC\server\share` or `\\server\share`
    let after_prefix = if bytes.len() >= 8
        && bytes[2] == b'?'
        && is_win_sep(bytes[3])
        && bytes[4..7].eq_ignore_ascii_case(b"UNC")
        && is_win_sep(bytes[7])
    {
        &trimmed[8..]
    } else {
        &trimmed[2..]
    };

    let mut parts = after_prefix
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty());
    if let (Some(server), Some(share)) = (parts.next(), parts.next())
        && server != "?"
        && server != "."
    {
        return WindowsRemotePath::Share(format!(
            "{}\\{}",
            server.to_ascii_lowercase(),
            share.to_ascii_lowercase()
        ));
    }

    WindowsRemotePath::Device
}

/// Rejects Windows UNC (`\\server\share`, `\\?\UNC\server\share`) and device-namespace
/// (`\\.\`, `\\?\GLOBALROOT`) targets lexically before touching the filesystem, preventing
/// accidental NTLM credential leaks unless an approved root lives on that same UNC share.
pub fn assert_no_unapproved_remote_path(
    roots: &[PathBuf],
    target_path: &Path,
    label: &str,
    platform: &str,
) -> Result<()> {
    if platform != "win32" {
        return Ok(());
    }
    let target = classify_windows_remote_path(&target_path.to_string_lossy());
    match target {
        WindowsRemotePath::Local => Ok(()),
        WindowsRemotePath::Share(ref target_share) => {
            for root in roots {
                if let WindowsRemotePath::Share(root_share) =
                    classify_windows_remote_path(&root.to_string_lossy())
                    && &root_share == target_share
                {
                    return Ok(());
                }
            }
            bail!("{label} is outside allowed workspace roots");
        }
        WindowsRemotePath::Device => bail!("{label} is outside allowed workspace roots"),
    }
}

/// Resolves symlinks and ensures `target_path` falls within one of `roots`.
pub fn assert_path_within_roots(
    roots: &[PathBuf],
    target_path: &Path,
    label: &str,
) -> Result<PathBuf> {
    if target_path.to_string_lossy().trim().is_empty() {
        bail!("{label} must not be empty");
    }
    assert_no_unapproved_remote_path(roots, target_path, label, host_platform())?;

    let normalized_target = canonicalize_sync(target_path);
    for root in roots {
        let normalized_root = canonicalize_sync(root);
        if is_path_equal_or_inside(&normalized_root, &normalized_target) {
            return Ok(normalized_target);
        }
    }
    bail!("{label} is outside allowed workspace roots");
}

/// Authorizes a directory entry (for rename/trash) by canonicalizing its parent directory
/// without following a symlink at the leaf segment itself.
pub fn assert_directory_entry_within_roots(
    roots: &[PathBuf],
    target_path: &Path,
    label: &str,
) -> Result<PathBuf> {
    if target_path.to_string_lossy().trim().is_empty() {
        bail!("{label} must not be empty");
    }
    assert_no_unapproved_remote_path(roots, target_path, label, host_platform())?;

    let resolved = normalize_lexical_path(target_path);
    let Some(parent_dir) = resolved.parent() else {
        bail!("{label} is outside allowed workspace roots");
    };
    let Some(file_name) = resolved.file_name() else {
        bail!("{label} is outside allowed workspace roots");
    };

    let canonical_parent = canonicalize_sync(parent_dir);
    let entry_path = canonical_parent.join(file_name);
    for root in roots {
        let canonical_root = canonicalize_sync(root);
        if is_path_equal_or_inside(&canonical_root, &entry_path) {
            return Ok(entry_path);
        }
    }
    bail!("{label} is outside allowed workspace roots");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_id_validation() {
        assert!(assert_safe_id("abc-123_XYZ", "threadId").is_ok());
        assert!(assert_safe_id("", "threadId").is_err());
        assert!(assert_safe_id("../escape", "threadId").is_err());
        assert!(assert_safe_id("bad/slash", "threadId").is_err());
        assert!(assert_safe_id(&"a".repeat(257), "threadId").is_err());
    }

    #[test]
    fn windows_unc_and_device_paths_blocked_before_fs_access() {
        let roots = vec![PathBuf::from(r"\\fileserver\approved\repo")];
        assert!(
            assert_no_unapproved_remote_path(
                &roots,
                Path::new(r"\\attacker\evil\share"),
                "path",
                "win32"
            )
            .is_err()
        );
        assert!(
            assert_no_unapproved_remote_path(
                &roots,
                Path::new(r"\\?\GLOBALROOT\Device\HarddiskVolume1"),
                "path",
                "win32"
            )
            .is_err()
        );
        assert!(
            assert_no_unapproved_remote_path(
                &roots,
                Path::new(r"\\?\UNC\fileserver\approved\repo\notes.md"),
                "path",
                "win32"
            )
            .is_ok()
        );
        assert!(
            assert_no_unapproved_remote_path(
                &roots,
                Path::new(r"\\?\C:\Users\me\repo\file.txt"),
                "path",
                "win32"
            )
            .is_ok()
        );
    }

    #[test]
    fn path_within_roots_and_symlink_escape_checks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let inside_file = root.join("hello.txt");
        let outside_file = outside.join("secret.txt");
        fs::write(&inside_file, "ok").unwrap();
        fs::write(&outside_file, "secret").unwrap();

        #[cfg(unix)]
        {
            let link_in_ws = root.join("escape-link");
            std::os::unix::fs::symlink(&outside_file, &link_in_ws).unwrap();

            // Following leaf symlink escapes workspace and must fail for reads.
            assert!(
                assert_path_within_roots(std::slice::from_ref(&root), &link_in_ws, "preview")
                    .is_err()
            );

            // Authorizing the directory entry itself (for rename/trash) succeeds without dereferencing leaf.
            assert!(
                assert_directory_entry_within_roots(
                    std::slice::from_ref(&root),
                    &link_in_ws,
                    "trash"
                )
                .is_ok()
            );
        }

        assert!(assert_path_within_roots(&[root], &inside_file, "preview").is_ok());
    }

    #[test]
    fn transcript_root_containment() {
        let root = Path::new("/tmp/userData/transcripts");
        assert!(assert_within_transcripts_dir(root, &root.join("abc.jsonl")).is_ok());
        assert!(assert_within_transcripts_dir(root, &root.join("../state.json")).is_err());
    }
}
