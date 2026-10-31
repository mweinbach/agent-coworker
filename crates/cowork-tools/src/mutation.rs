use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use cowork_storage::{FileLockOptions, with_file_lock_sync};
use uuid::Uuid;

use crate::context::{ToolError, ToolExecutionContext, ToolResult, assert_write_path_allowed};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileVersion {
    pub exists: bool,
    pub len: u64,
    pub modified_ns: u128,
    #[cfg(unix)]
    pub ino: u64,
    #[cfg(unix)]
    pub dev: u64,
}

pub fn stat_file_version(path: &Path) -> ToolResult<FileVersion> {
    match fs::metadata(path) {
        Ok(meta) => {
            let modified_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                Ok(FileVersion {
                    exists: true,
                    len: meta.len(),
                    modified_ns,
                    ino: meta.ino(),
                    dev: meta.dev(),
                })
            }
            #[cfg(not(unix))]
            {
                Ok(FileVersion {
                    exists: true,
                    len: meta.len(),
                    modified_ns,
                })
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(FileVersion {
            exists: false,
            len: 0,
            modified_ns: 0,
            #[cfg(unix)]
            ino: 0,
            #[cfg(unix)]
            dev: 0,
        }),
        Err(err) => Err(ToolError::Execution(format!(
            "Failed to stat '{}': {err}",
            path.display()
        ))),
    }
}

pub fn same_file_version(a: &FileVersion, b: &FileVersion) -> bool {
    a == b
}

pub struct ExistingFileSnapshot {
    pub exists: bool,
    pub bytes: Option<Vec<u8>>,
    pub permissions: Option<fs::Permissions>,
}

/// Coordinates exclusive per-target-file mutations across tasks & processes using
/// `cowork_storage::with_file_lock`, verifying `same_file_version` before staging
/// and immediately before atomic temp-file rename.
pub async fn with_file_mutation<F, R>(
    target_path: &Path,
    ctx: &ToolExecutionContext,
    mutate: F,
) -> ToolResult<R>
where
    F: FnOnce(ExistingFileSnapshot) -> ToolResult<(Vec<u8>, R)> + Send + 'static,
    R: Send + 'static,
{
    let resolved = assert_write_path_allowed(target_path, ctx)?;
    if let Some(handler) = &ctx.approval_handler
        && !ctx.yolo
    {
        let approved = handler
            .approve_file_change(&resolved, None)
            .await
            .map_err(ToolError::Execution)?;
        if !approved {
            return Err(ToolError::Execution(format!(
                "File modification was not approved for '{}'.",
                resolved.display()
            )));
        }
    }

    let lock_root = ctx.lock_root.clone();

    tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&lock_root)
            .map_err(|e| ToolError::Execution(format!("Failed to create lock directory: {e}")))?;

        with_file_lock_sync(
            &resolved,
            || -> ToolResult<R> {
                let parent = resolved.parent().ok_or_else(|| {
                    ToolError::InvalidArguments(format!(
                        "Target path '{}' has no parent directory",
                        resolved.display()
                    ))
                })?;
                fs::create_dir_all(parent).map_err(|e| {
                    ToolError::Execution(format!(
                        "Failed to create parent directory '{}': {e}",
                        parent.display()
                    ))
                })?;

                let v_before_read = stat_file_version(&resolved)?;
                let (existing_bytes, permissions) = if v_before_read.exists {
                    let meta = fs::metadata(&resolved).map_err(|e| {
                        ToolError::Execution(format!("Failed to read metadata: {e}"))
                    })?;
                    if meta.is_dir() {
                        return Err(ToolError::InvalidArguments(format!(
                            "'{}' is a directory, not a file.",
                            resolved.display()
                        )));
                    }
                    let bytes = fs::read(&resolved).map_err(|e| {
                        ToolError::Execution(format!(
                            "Failed to read '{}': {e}",
                            resolved.display()
                        ))
                    })?;
                    (Some(bytes), Some(meta.permissions()))
                } else {
                    (None, None)
                };

                let v_after_read = stat_file_version(&resolved)?;
                if !same_file_version(&v_before_read, &v_after_read) {
                    return Err(ToolError::Execution(format!(
                        "Concurrent modification detected while reading '{}'; retry.",
                        resolved.display()
                    )));
                }

                let (new_bytes, output) = mutate(ExistingFileSnapshot {
                    exists: v_before_read.exists,
                    bytes: existing_bytes,
                    permissions: permissions.clone(),
                })?;

                let tmp_name = format!(
                    ".cowork-stage-{}-{}.tmp",
                    resolved
                        .file_name()
                        .map(|n| n.to_string_lossy())
                        .unwrap_or_default(),
                    Uuid::new_v4()
                );
                let tmp_path = parent.join(tmp_name);

                let write_res = (|| -> ToolResult<()> {
                    let mut tmp_file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&tmp_path)
                        .map_err(|e| {
                            ToolError::Execution(format!("Failed to create staging file: {e}"))
                        })?;
                    if let Some(perms) = permissions {
                        let _ = tmp_file.set_permissions(perms);
                    }
                    tmp_file.write_all(&new_bytes).map_err(|e| {
                        ToolError::Execution(format!("Failed to write staging file: {e}"))
                    })?;
                    tmp_file.sync_all().map_err(|e| {
                        ToolError::Execution(format!("Failed to sync staging file: {e}"))
                    })?;
                    drop(tmp_file);

                    let v_before_rename = stat_file_version(&resolved)?;
                    if !same_file_version(&v_before_read, &v_before_rename) {
                        return Err(ToolError::Execution(format!(
                            "File '{}' changed externally before atomic commit; aborting.",
                            resolved.display()
                        )));
                    }

                    fs::rename(&tmp_path, &resolved).map_err(|e| {
                        ToolError::Execution(format!(
                            "Failed to atomically replace '{}': {e}",
                            resolved.display()
                        ))
                    })?;
                    Ok(())
                })();

                if write_res.is_err() {
                    let _ = fs::remove_file(&tmp_path);
                }
                write_res?;
                Ok(output)
            },
            FileLockOptions {
                acquire_timeout_ms: Some(15_000),
                retry_delay_ms: Some(10),
                lock_root: Some(lock_root),
            },
        )
    })
    .await
    .map_err(|e| ToolError::Execution(format!("File mutation worker panicked: {e}")))?
}
