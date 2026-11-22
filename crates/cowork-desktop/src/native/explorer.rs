//! Workspace file explorer operations (listing, directory creation, non-clobbering rename,
//! trash, and authorized attachment upload copying) matching `apps/desktop/electron/ipc/files.ts`
//! and `apps/desktop/electron/services/explorerVisibility.ts`.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use cowork_config::canonicalize_sync;

use super::file_entry_rename::FileEntryRenamer;
use super::path_boundary::is_path_equal_or_inside;
use super::security::{AuthorizedUploadRegistry, MAX_ATTACHMENT_UPLOAD_BYTE_SIZE};
use super::validation::{assert_directory_entry_within_roots, assert_path_within_roots};
use crate::state::WorkspaceFileEntry;

const DEFAULT_WORKSPACE_UPLOADS_DIR_NAME: &str = "uploads";
const WORKSPACE_USER_UPLOADS_SUBDIR: &str = "User Uploads";

/// Hidden files and noisy dependency folders omitted from explorer listings unless requested.
pub fn is_explorer_entry_hidden(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("~$") || name == "node_modules"
}

fn validate_single_entry_name(name: &str, label: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        bail!("Invalid {label}");
    }
    Ok(())
}

/// Lists immediate directory entries inside an authorized workspace root.
pub fn list_workspace_directory(
    workspace_roots: &[PathBuf],
    requested_dir: &Path,
    include_hidden: bool,
) -> Result<Vec<WorkspaceFileEntry>> {
    let safe_dir = assert_path_within_roots(workspace_roots, requested_dir, "path")?;
    let dir_meta = fs::metadata(&safe_dir)
        .with_context(|| format!("Unable to inspect {}", safe_dir.display()))?;
    if !dir_meta.is_dir() {
        bail!("Requested explorer path is not a directory");
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&safe_dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !include_hidden && is_explorer_entry_hidden(&name) {
            continue;
        }

        let full_path = item.path();
        let (is_dir, size_bytes) = match fs::metadata(&full_path) {
            Ok(meta) => (meta.is_dir(), meta.is_file().then_some(meta.len())),
            Err(_) => {
                // Broken symlinks etc. fall back to dirent metadata without crashing the listing.
                let is_dir = item.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                (is_dir, None)
            }
        };

        entries.push(WorkspaceFileEntry {
            name,
            path: full_path.to_string_lossy().into_owned(),
            is_dir,
            size_bytes,
            git_status: None,
        });
    }

    let mut keyed: Vec<(bool, String, WorkspaceFileEntry)> = entries
        .into_iter()
        .map(|entry| {
            let lower = entry.name.to_lowercase();
            (!entry.is_dir, lower, entry)
        })
        .collect();
    keyed.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.name.cmp(&right.2.name))
    });
    let entries: Vec<WorkspaceFileEntry> = keyed.into_iter().map(|(_, _, entry)| entry).collect();

    Ok(entries)
}

/// Creates a new subdirectory inside an authorized workspace directory.
pub fn create_workspace_directory(
    workspace_roots: &[PathBuf],
    parent_path: &Path,
    dir_name: &str,
) -> Result<PathBuf> {
    validate_single_entry_name(dir_name, "directory name")?;
    let safe_parent = assert_path_within_roots(workspace_roots, parent_path, "parentPath")?;
    let target = safe_parent.join(dir_name);
    let _ = assert_directory_entry_within_roots(workspace_roots, &target, "path")?;
    fs::create_dir(&target)?;
    assert_path_within_roots(workspace_roots, &target, "path")
}

/// Renames an entry inside an authorized workspace without replacing existing files.
pub async fn rename_workspace_entry(
    renamer: &FileEntryRenamer,
    workspace_roots: &[PathBuf],
    source_path: &Path,
    new_name: &str,
) -> Result<PathBuf> {
    validate_single_entry_name(new_name, "entry name")?;
    let safe_source = assert_directory_entry_within_roots(workspace_roots, source_path, "path")?;

    let is_root_itself = workspace_roots
        .iter()
        .any(|root| canonicalize_sync(root) == safe_source);
    if is_root_itself {
        bail!("Cannot rename an approved workspace root.");
    }

    let Some(parent) = safe_source.parent() else {
        bail!("Invalid source path");
    };
    let target = parent.join(new_name);
    let safe_target = assert_directory_entry_within_roots(workspace_roots, &target, "target")?;

    renamer.rename(safe_source, safe_target.clone()).await?;
    Ok(safe_target)
}

/// Copies a one-time authorized user-picked file into the workspace's uploads directory
/// (`<workspace>/uploads/User Uploads` by default, matching `cowork-harness` confinement).
pub fn copy_authorized_upload_to_workspace(
    registry: &mut AuthorizedUploadRegistry,
    workspace_roots: &[PathBuf],
    workspace_path: &Path,
    source_path: &Path,
    auth_token: &str,
    filename: &str,
    uploads_dir_override: Option<&Path>,
) -> Result<PathBuf> {
    let safe_workspace =
        assert_path_within_roots(workspace_roots, workspace_path, "workspacePath")?;
    validate_single_entry_name(filename, "filename")?;

    let src_file = registry.consume_and_open(auth_token, source_path)?;
    let requested_uploads_dir = match uploads_dir_override {
        Some(rel_or_abs) if rel_or_abs.is_absolute() => rel_or_abs.to_path_buf(),
        Some(rel) => safe_workspace.join(rel),
        None => safe_workspace
            .join(DEFAULT_WORKSPACE_UPLOADS_DIR_NAME)
            .join(WORKSPACE_USER_UPLOADS_SUBDIR),
    };

    let safe_uploads_base = assert_directory_entry_within_roots(
        std::slice::from_ref(&safe_workspace),
        &requested_uploads_dir,
        "uploadsDirectory",
    )?;
    // If a configured uploads directory resolves to the workspace root itself, narrow to
    // `<workspace>/User Uploads` so `cowork-harness`'s `open_uploaded_file` accepts it.
    let target_uploads_dir = if safe_uploads_base == safe_workspace {
        assert_directory_entry_within_roots(
            std::slice::from_ref(&safe_workspace),
            &safe_workspace.join(WORKSPACE_USER_UPLOADS_SUBDIR),
            "uploadsDirectory",
        )?
    } else {
        safe_uploads_base
    };
    fs::create_dir_all(&target_uploads_dir)?;
    let resolved_uploads_dir = assert_path_within_roots(
        std::slice::from_ref(&safe_workspace),
        &target_uploads_dir,
        "uploadsDirectory",
    )?;

    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    let stem = filename
        .strip_suffix(&ext)
        .filter(|s| !s.is_empty())
        .unwrap_or(filename);

    for attempt in 0..10_000u32 {
        let candidate_name = if attempt == 0 {
            filename.to_string()
        } else {
            format!("{stem}_{attempt}{ext}")
        };
        let target_path = resolved_uploads_dir.join(&candidate_name);
        if !is_path_equal_or_inside(&resolved_uploads_dir, &target_path) {
            bail!("Invalid filename (path traversal)");
        }
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
        {
            Ok(mut dst_file) => {
                let mut reader = src_file.take(MAX_ATTACHMENT_UPLOAD_BYTE_SIZE + 1);
                let copied = io::copy(&mut reader, &mut dst_file)?;
                if copied > MAX_ATTACHMENT_UPLOAD_BYTE_SIZE {
                    let _ = fs::remove_file(&target_path);
                    bail!("File too large to upload (max 100MB)");
                }
                dst_file.flush()?;
                return Ok(target_path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }

    bail!("Too many colliding upload filenames in uploads directory")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn hides_dotfiles_office_locks_and_node_modules_and_sorts_dirs_first() {
        assert!(is_explorer_entry_hidden(".git"));
        assert!(is_explorer_entry_hidden("~$budget.xlsx"));
        assert!(is_explorer_entry_hidden("node_modules"));
        assert!(!is_explorer_entry_hidden("src"));

        let ws = tempdir().unwrap();
        fs::create_dir(ws.path().join("src")).unwrap();
        fs::create_dir(ws.path().join("node_modules")).unwrap();
        fs::write(ws.path().join(".env"), "SECRET=1").unwrap();
        fs::write(ws.path().join("~$lock.docx"), "x").unwrap();
        fs::write(ws.path().join("zeta.txt"), "z").unwrap();
        fs::write(ws.path().join("Alpha.md"), "a").unwrap();

        let roots = vec![ws.path().to_path_buf()];
        let visible = list_workspace_directory(&roots, ws.path(), false).unwrap();
        let names: Vec<&str> = visible.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "Alpha.md", "zeta.txt"]);

        let all = list_workspace_directory(&roots, ws.path(), true).unwrap();
        assert!(all.iter().any(|e| e.name == "node_modules"));
        assert!(all.iter().any(|e| e.name == ".env"));
    }

    #[test]
    fn copy_upload_consumes_one_time_token_and_deduplicates_names() {
        let ws = tempdir().unwrap();
        let src_dir = tempdir().unwrap();
        let src_file = src_dir.path().join("photo.png");
        fs::write(&src_file, b"png-bytes").unwrap();

        let mut registry = AuthorizedUploadRegistry::new();
        let tok1 = registry.authorize_file(&src_file).unwrap();
        let roots = vec![ws.path().to_path_buf()];

        let out1 = copy_authorized_upload_to_workspace(
            &mut registry,
            &roots,
            ws.path(),
            &src_file,
            &tok1,
            "photo.png",
            None,
        )
        .unwrap();
        assert_eq!(out1.file_name().and_then(|s| s.to_str()), Some("photo.png"));
        assert!(
            out1.starts_with(
                canonicalize_sync(ws.path())
                    .join("uploads")
                    .join("User Uploads")
            ),
            "default staged upload must live inside <workspace>/uploads/User Uploads (got {})",
            out1.display()
        );

        // Reusing a consumed token must fail closed.
        let reuse_err = copy_authorized_upload_to_workspace(
            &mut registry,
            &roots,
            ws.path(),
            &src_file,
            &tok1,
            "photo.png",
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(reuse_err.contains("not authorized"));

        // Second valid token writes photo_1.png without clobbering.
        let tok2 = registry.authorize_file(&src_file).unwrap();
        let out2 = copy_authorized_upload_to_workspace(
            &mut registry,
            &roots,
            ws.path(),
            &src_file,
            &tok2,
            "photo.png",
            None,
        )
        .unwrap();
        assert_eq!(
            out2.file_name().and_then(|s| s.to_str()),
            Some("photo_1.png")
        );
    }

    #[tokio::test]
    async fn enforces_strict_workspace_isolation() {
        let ws_a = tempdir().unwrap();
        let ws_b = tempdir().unwrap();
        fs::write(ws_b.path().join("secret.txt"), "other-workspace").unwrap();

        let err = list_workspace_directory(&[ws_a.path().to_path_buf()], ws_b.path(), false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("outside allowed workspace roots"));

        let err_mkdir =
            create_workspace_directory(&[ws_a.path().to_path_buf()], ws_b.path(), "dir")
                .unwrap_err()
                .to_string();
        assert!(err_mkdir.contains("outside allowed workspace roots"));

        let renamer = FileEntryRenamer::default();
        let err_rename = rename_workspace_entry(
            &renamer,
            &[ws_a.path().to_path_buf()],
            &ws_b.path().join("secret.txt"),
            "renamed.txt",
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err_rename.contains("outside allowed workspace roots"));
    }
}
