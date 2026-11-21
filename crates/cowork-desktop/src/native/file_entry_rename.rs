//! Serialized, non-clobbering file/folder/symlink rename helper mirroring
//! `apps/desktop/electron/services/fileEntryRename.ts`.

use std::fs::{self, Metadata};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use tokio::sync::Mutex;

/// Serializes entry rename requests so non-replace checks cannot interleave in-process.
#[derive(Clone, Debug, Default)]
pub struct FileEntryRenamer {
    gate: Arc<Mutex<()>>,
}

impl FileEntryRenamer {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn rename(&self, source: PathBuf, target: PathBuf) -> Result<()> {
        let _guard = self.gate.lock().await;
        tokio::task::spawn_blocking(move || rename_entry_non_clobbering(&source, &target))
            .await
            .context("Rename task panicked")?
    }
}

fn is_same_entry(left: &Metadata, right: &Metadata) -> bool {
    let left_ft = left.file_type();
    let right_ft = right.file_type();
    if left_ft.is_file() != right_ft.is_file()
        || left_ft.is_dir() != right_ft.is_dir()
        || left_ft.is_symlink() != right_ft.is_symlink()
    {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }

    #[cfg(not(unix))]
    {
        left.len() == right.len()
    }
}

fn stat_entry_optional(target: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(target) {
        Ok(meta) => Ok(Some(meta)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn directory_contains_exact_name(dir: &Path, expected_name: &str) -> Result<bool> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_str() == Some(expected_name) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn create_symlink(link_target: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(link_target, target)
    }

    #[cfg(windows)]
    {
        let resolved_target = if link_target.is_absolute() {
            link_target.to_path_buf()
        } else {
            target
                .parent()
                .map(|p| p.join(link_target))
                .unwrap_or_else(|| link_target.to_path_buf())
        };
        if resolved_target.is_dir() {
            std::os::windows::fs::symlink_dir(link_target, target)
        } else {
            std::os::windows::fs::symlink_file(link_target, target)
        }
    }
}

fn is_unsafe_link_fallback_error(err: &std::io::Error) -> bool {
    #[cfg(unix)]
    if let Some(code) = err.raw_os_error() {
        // On Linux glibc `ENOTSUP == EOPNOTSUPP`; `[...].contains` avoids unreachable-pattern warnings.
        return [
            libc::ENOTSUP,
            libc::EOPNOTSUPP,
            libc::EXDEV,
            libc::ENOSYS,
            libc::EPERM,
        ]
        .contains(&code);
    }
    err.kind() == ErrorKind::Unsupported || err.kind() == ErrorKind::PermissionDenied
}

/// Renames `source` to `target` without silently overwriting an existing destination.
pub fn rename_entry_non_clobbering(source: &Path, target: &Path) -> Result<()> {
    let source_meta = fs::symlink_metadata(source)?;
    if source == target {
        return Ok(());
    }

    if let Some(target_meta) = stat_entry_optional(target)? {
        // On case-insensitive filesystems, changing only letter case can resolve `target`
        // to the same underlying inode as `source`. Only proceed when the exact target name
        // does not already exist in the directory.
        if let (Some(src_name), Some(dst_name), Some(parent)) = (
            source.file_name().and_then(|n| n.to_str()),
            target.file_name().and_then(|n| n.to_str()),
            target.parent(),
        ) && is_same_entry(&source_meta, &target_meta)
            && src_name.eq_ignore_ascii_case(dst_name)
            && !directory_contains_exact_name(parent, dst_name)?
        {
            fs::rename(source, target)?;
            return Ok(());
        }
        bail!("A file or folder with that name already exists.");
    }

    if source_meta.is_dir() {
        fs::rename(source, target)?;
        return Ok(());
    }

    let source_is_symlink = source_meta.file_type().is_symlink();
    if !source_meta.is_file() && !source_is_symlink {
        bail!("Only files, folders, and symbolic links can be renamed.");
    }

    let source_link_target = if source_is_symlink {
        Some(fs::read_link(source)?)
    } else {
        None
    };

    let link_result = match source_link_target.as_deref() {
        Some(link_target) => create_symlink(link_target, target),
        None => fs::hard_link(source, target),
    };
    if let Err(err) = link_result {
        if err.kind() == ErrorKind::AlreadyExists {
            bail!("A file or folder with that name already exists.");
        }
        if is_unsafe_link_fallback_error(&err) {
            bail!(
                "This filesystem cannot rename this entry safely. Rename it in your file manager: {err}"
            );
        }
        return Err(err.into());
    }

    let linked_meta = fs::symlink_metadata(target)?;
    let verify_and_unlink = (|| -> Result<()> {
        let current_source = fs::symlink_metadata(source)?;
        let target_matches = match source_link_target.as_deref() {
            None => is_same_entry(&source_meta, &linked_meta),
            Some(expected_link) => {
                linked_meta.file_type().is_symlink() && fs::read_link(target)? == expected_link
            }
        };
        if !target_matches || !is_same_entry(&source_meta, &current_source) {
            bail!("The file changed while it was being renamed. Try again.");
        }
        fs::remove_file(source)?;
        Ok(())
    })();

    if let Err(err) = verify_and_unlink {
        let current_source = stat_entry_optional(source).ok().flatten();
        let current_target = stat_entry_optional(target).ok().flatten();
        if let (Some(src), Some(dst)) = (current_source, current_target)
            && is_same_entry(&source_meta, &src)
            && is_same_entry(&linked_meta, &dst)
        {
            let _ = fs::remove_file(target);
        }
        return Err(err);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn renames_regular_file_without_clobbering_existing_destination() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("alpha.txt");
        let dst = tmp.path().join("beta.txt");
        let existing = tmp.path().join("existing.txt");
        fs::write(&src, "hello").unwrap();
        fs::write(&existing, "keep").unwrap();

        rename_entry_non_clobbering(&src, &dst).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "hello");

        let err = rename_entry_non_clobbering(&dst, &existing)
            .unwrap_err()
            .to_string();
        assert!(err.contains("already exists"));
        assert_eq!(fs::read_to_string(&dst).unwrap(), "hello");
        assert_eq!(fs::read_to_string(&existing).unwrap(), "keep");
    }

    #[test]
    fn supports_case_only_rename() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("notes.md");
        let dst = tmp.path().join("Notes.md");
        fs::write(&src, "content").unwrap();

        rename_entry_non_clobbering(&src, &dst).unwrap();
        let names: Vec<String> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        assert_eq!(names, vec!["Notes.md"]);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "content");
    }

    #[cfg(unix)]
    #[test]
    fn renames_symlink_without_dereferencing_target() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("real.txt");
        fs::write(&target, "real").unwrap();
        let link_src = tmp.path().join("link_a");
        let link_dst = tmp.path().join("link_b");
        std::os::unix::fs::symlink("real.txt", &link_src).unwrap();

        rename_entry_non_clobbering(&link_src, &link_dst).unwrap();
        assert!(fs::symlink_metadata(&link_src).is_err());
        let meta = fs::symlink_metadata(&link_dst).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::read_link(&link_dst).unwrap(), PathBuf::from("real.txt"));
    }
}
