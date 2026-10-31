//! Opt-in workspace session backups (`cowork/backups/workspace/*` + `cowork/session/backupState`).
//!
//! Enforces strict workspace & backup root confinement, tar-entry count/size/traversal/symlink
//! bounds, deterministic `session-backup-workspace-v2` SHA-256 fingerprinting, and crash-safe
//! `.restore-rollback-<id>` directory replacement.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use cowork_config::{
    FileLockOptions, canonicalize_sync, ensure_private_dir_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, is_inside, same_workspace_path, with_file_lock_sync,
    write_text_file_atomic,
};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::{Archive, Builder, EntryType, Header};
use uuid::Uuid;

pub const MODEL_SCRATCHPAD_DIRNAME: &str = ".ModelScratchpad";
pub const RECOVERY_DIRECTORY_PREFIX: &str = ".restore-rollback-";
pub const AUTO_CHECKPOINT_THROTTLE: Duration = Duration::from_secs(30);
pub const MAX_DELTA_FILES: usize = 500;

/// Strict archive safety bounds on backup tar extraction (`VAL-EXT-006` / preconditions).
pub const MAX_BACKUP_ARCHIVE_ENTRIES: usize = 50_000;
pub const MAX_BACKUP_ARCHIVE_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_BACKUP_ARCHIVE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTrigger {
    Initial,
    Auto,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupStatus {
    Initializing,
    Ready,
    Disabled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupLifecycle {
    Active,
    Closed,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginalSnapshotKind {
    Pending,
    Directory,
    TarGz,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBackupPublicCheckpoint {
    pub id: String,
    pub index: usize,
    pub created_at: String,
    pub trigger: BackupTrigger,
    pub changed: bool,
    pub patch_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOriginalSnapshot {
    pub kind: OriginalSnapshotKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBackupPublicState {
    pub status: BackupStatus,
    pub session_id: String,
    pub working_directory: String,
    pub backup_directory: Option<String>,
    pub created_at: String,
    pub original_snapshot: SessionOriginalSnapshot,
    pub checkpoints: Vec<SessionBackupPublicCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBackupStateEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    pub reason: String,
    pub backup: SessionBackupPublicState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupEntry {
    pub target_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub lifecycle: BackupLifecycle,
    pub status: BackupStatus,
    pub working_directory: String,
    pub backup_directory: Option<String>,
    pub original_snapshot_kind: OriginalSnapshotKind,
    pub original_snapshot_bytes: Option<u64>,
    pub checkpoint_bytes_total: Option<u64>,
    pub total_bytes: Option<u64>,
    pub checkpoints: Vec<SessionBackupPublicCheckpoint>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupsEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub workspace_path: String,
    pub backups: Vec<WorkspaceBackupEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaEntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupDeltaCounts {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupDeltaFile {
    pub path: String,
    pub change: DeltaChangeKind,
    pub kind: DeltaEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupDeltaEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub target_session_id: String,
    pub checkpoint_id: String,
    pub baseline_label: String,
    pub current_label: String,
    pub counts: WorkspaceBackupDeltaCounts,
    pub files: Vec<WorkspaceBackupDeltaFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct SessionLookupMetadata {
    pub lifecycle: BackupLifecycle,
    pub title: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub busy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupMetadataState {
    Active,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotRef {
    pub kind: OriginalSnapshotKind,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCheckpointRecord {
    id: String,
    index: usize,
    created_at: String,
    trigger: BackupTrigger,
    changed: bool,
    patch_bytes: u64,
    fingerprint: String,
    snapshot: BackupSnapshotRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSessionBackupMetadata {
    version: u32,
    session_id: String,
    working_directory: String,
    created_at: String,
    state: BackupMetadataState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_fingerprint: Option<String>,
    original_snapshot: BackupSnapshotRef,
    #[serde(default)]
    checkpoints: Vec<StoredCheckpointRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EntrySignature {
    kind: DeltaEntryKind,
    mode: u32,
    digest: String,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn is_excluded_top_level_name(name: &str) -> bool {
    name == MODEL_SCRATCHPAD_DIRNAME || name.starts_with(RECOVERY_DIRECTORY_PREFIX)
}

fn sanitize_session_dir_name(session_id: &str) -> Result<String, String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(format!("Invalid session ID for backup: {session_id:?}"));
    }
    Ok(trimmed.to_owned())
}

/// Validates a relative path stored in or extracted from a backup tar archive.
pub fn validate_contained_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err("Archive entry path must not be empty or contain NUL bytes.".to_owned());
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(format!(
            "Archive entry {raw:?} must be relative, not absolute."
        ));
    }
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' && raw.as_bytes()[0].is_ascii_alphabetic() {
        return Err(format!(
            "Archive entry {raw:?} contains a drive prefix and is rejected."
        ));
    }
    let normalized = raw.replace('\\', "/");
    let mut out = PathBuf::new();
    let mut first_segment: Option<String> = None;
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!(
                "Archive entry {raw:?} contains parent directory traversal."
            ));
        }
        if first_segment.is_none() {
            first_segment = Some(part.to_owned());
        }
        out.push(part);
    }
    let Some(first) = first_segment else {
        return Err(format!(
            "Archive entry {raw:?} has no valid relative path components."
        ));
    };
    if is_excluded_top_level_name(&first) {
        return Err(format!(
            "Archive entry {raw:?} targets reserved workspace directory {first:?}."
        ));
    }
    Ok(out)
}

fn validate_symlink_target_confined(
    rel_entry_path: &Path,
    link_target: &Path,
) -> Result<(), String> {
    let target_str = link_target.to_string_lossy();
    if target_str.contains('\0') {
        return Err("Symlink target contains NUL byte.".to_owned());
    }
    if link_target.is_absolute()
        || target_str.starts_with('/')
        || target_str.starts_with('\\')
        || (target_str.len() >= 2
            && target_str.as_bytes()[1] == b':'
            && target_str.as_bytes()[0].is_ascii_alphabetic())
    {
        return Err(format!(
            "Archive symlink {:?} -> {:?} points to an absolute path outside workspace.",
            rel_entry_path, link_target
        ));
    }

    let mut depth_stack: Vec<String> = rel_entry_path
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    for comp in target_str.replace('\\', "/").split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." {
            if depth_stack.pop().is_none() {
                return Err(format!(
                    "Archive symlink {:?} -> {:?} escapes the workspace root.",
                    rel_entry_path, link_target
                ));
            }
        } else {
            depth_stack.push(comp.to_owned());
        }
    }
    if let Some(first) = depth_stack.first()
        && is_excluded_top_level_name(first)
    {
        return Err(format!(
            "Archive symlink {:?} targets reserved directory {first:?}.",
            rel_entry_path
        ));
    }
    Ok(())
}

/// Checks whether an interrupted `.restore-rollback-*` directory exists in `working_directory`.
pub fn workspace_recovery_failure_reason(working_directory: &Path) -> Option<String> {
    let entries = fs::read_dir(working_directory).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(RECOVERY_DIRECTORY_PREFIX) {
            return Some(format!(
                "Workspace contains an unfinished restore recovery directory ({name}). Resolve or inspect it before running another backup operation."
            ));
        }
    }
    None
}

fn entry_mode(meta: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        if meta.permissions().readonly() {
            0o444
        } else {
            0o644
        }
    }
}

fn collect_directory_manifest(root: &Path) -> Result<BTreeMap<String, EntrySignature>, String> {
    let mut manifest = BTreeMap::new();
    if !root.exists() {
        return Ok(manifest);
    }

    fn walk(
        base: &Path,
        current: &Path,
        is_root: bool,
        out: &mut BTreeMap<String, EntrySignature>,
    ) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(current)
            .map_err(|e| format!("Failed reading directory {}: {e}", current.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                format!(
                    "Failed reading directory entry in {}: {e}",
                    current.display()
                )
            })?;
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_root && is_excluded_top_level_name(&name) {
                continue;
            }
            let full_path = entry.path();
            let rel_path = full_path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let meta = fs::symlink_metadata(&full_path)
                .map_err(|e| format!("Failed stating {}: {e}", full_path.display()))?;
            let ft = meta.file_type();
            if ft.is_symlink() {
                let target = fs::read_link(&full_path)
                    .map_err(|e| format!("Failed reading symlink {}: {e}", full_path.display()))?;
                let digest = hex::encode(Sha256::digest(target.to_string_lossy().as_bytes()));
                out.insert(
                    rel_path,
                    EntrySignature {
                        kind: DeltaEntryKind::Symlink,
                        mode: 0o777,
                        digest,
                    },
                );
            } else if ft.is_dir() {
                out.insert(
                    rel_path,
                    EntrySignature {
                        kind: DeltaEntryKind::Directory,
                        mode: entry_mode(&meta),
                        digest: String::new(),
                    },
                );
                walk(base, &full_path, false, out)?;
            } else if ft.is_file() {
                let mut file = File::open(&full_path)
                    .map_err(|e| format!("Failed opening {}: {e}", full_path.display()))?;
                let mut hasher = Sha256::new();
                let mut buf = [0_u8; 64 * 1024];
                loop {
                    let n = file
                        .read(&mut buf)
                        .map_err(|e| format!("Failed hashing {}: {e}", full_path.display()))?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                }
                out.insert(
                    rel_path,
                    EntrySignature {
                        kind: DeltaEntryKind::File,
                        mode: entry_mode(&meta),
                        digest: hex::encode(hasher.finalize()),
                    },
                );
            }
        }
        Ok(())
    }

    walk(root, root, true, &mut manifest)?;
    Ok(manifest)
}

/// Deterministic `session-backup-workspace-v2` SHA-256 fingerprint.
pub fn compute_workspace_fingerprint(working_directory: &Path) -> Result<String, String> {
    let manifest = collect_directory_manifest(working_directory)?;
    Ok(fingerprint_from_manifest(&manifest))
}

fn fingerprint_from_manifest(manifest: &BTreeMap<String, EntrySignature>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"session-backup-workspace-v2\n");
    for (rel_path, sig) in manifest {
        let kind_str = match sig.kind {
            DeltaEntryKind::Directory => "directory",
            DeltaEntryKind::File => "file",
            DeltaEntryKind::Symlink => "symlink",
        };
        let line =
            serde_json::to_string(&(kind_str, rel_path, sig.mode, &sig.digest)).unwrap_or_default();
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

/// Creates a `.tar.gz` archive of `source_dir` (excluding `.ModelScratchpad` and `.restore-rollback-*`).
pub fn write_snapshot_tar_gz(source_dir: &Path, archive_path: &Path) -> Result<u64, String> {
    if let Some(parent) = archive_path.parent() {
        ensure_private_dir_sync(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = archive_path.with_extension(format!("tar.gz.tmp.{}", Uuid::new_v4().simple()));
    let result = (|| -> Result<u64, String> {
        let file = File::create(&tmp_path)
            .map_err(|e| format!("Failed creating temp archive {}: {e}", tmp_path.display()))?;
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);
        builder.follow_symlinks(false);

        let mut total_entries = 0_usize;
        let mut total_bytes = 0_u64;

        fn append_walk(
            builder: &mut Builder<GzEncoder<File>>,
            base: &Path,
            current: &Path,
            is_root: bool,
            total_entries: &mut usize,
            total_bytes: &mut u64,
        ) -> Result<(), String> {
            let mut entries: Vec<_> = fs::read_dir(current)
                .map_err(|e| format!("Failed reading {}: {e}", current.display()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            entries.sort_by_key(|e| e.file_name());

            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_root && is_excluded_top_level_name(&name) {
                    continue;
                }
                *total_entries += 1;
                if *total_entries > MAX_BACKUP_ARCHIVE_ENTRIES {
                    return Err(format!(
                        "Workspace exceeds backup entry limit ({MAX_BACKUP_ARCHIVE_ENTRIES})."
                    ));
                }

                let full_path = entry.path();
                let rel_str = full_path
                    .strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                let rel_path = validate_contained_relative_path(&rel_str)?;
                let meta = fs::symlink_metadata(&full_path)
                    .map_err(|e| format!("Failed stating {}: {e}", full_path.display()))?;
                let ft = meta.file_type();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                if ft.is_symlink() {
                    let link_target = fs::read_link(&full_path).map_err(|e| {
                        format!("Failed reading symlink {}: {e}", full_path.display())
                    })?;
                    validate_symlink_target_confined(&rel_path, &link_target)?;
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Symlink);
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_mtime(mtime);
                    header.set_cksum();
                    builder
                        .append_link(&mut header, &rel_path, &link_target)
                        .map_err(|e| format!("Failed archiving symlink {}: {e}", rel_str))?;
                } else if ft.is_dir() {
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Directory);
                    header.set_size(0);
                    header.set_mode(entry_mode(&meta));
                    header.set_mtime(mtime);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, &rel_path, std::io::empty())
                        .map_err(|e| format!("Failed archiving dir {}: {e}", rel_str))?;
                    append_walk(builder, base, &full_path, false, total_entries, total_bytes)?;
                } else if ft.is_file() {
                    let len = meta.len();
                    if len > MAX_BACKUP_ARCHIVE_ENTRY_BYTES {
                        return Err(format!(
                            "Workspace file {rel_str:?} ({len} bytes) exceeds single-entry backup limit ({MAX_BACKUP_ARCHIVE_ENTRY_BYTES} bytes)."
                        ));
                    }
                    *total_bytes = total_bytes.saturating_add(len);
                    if *total_bytes > MAX_BACKUP_ARCHIVE_TOTAL_BYTES {
                        return Err(format!(
                            "Workspace exceeds total backup size limit ({MAX_BACKUP_ARCHIVE_TOTAL_BYTES} bytes)."
                        ));
                    }
                    let mut file = File::open(&full_path)
                        .map_err(|e| format!("Failed opening {}: {e}", full_path.display()))?;
                    let mut header = Header::new_gnu();
                    header.set_entry_type(EntryType::Regular);
                    header.set_size(len);
                    header.set_mode(entry_mode(&meta));
                    header.set_mtime(mtime);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, &rel_path, &mut file)
                        .map_err(|e| format!("Failed archiving file {}: {e}", rel_str))?;
                }
            }
            Ok(())
        }

        append_walk(
            &mut builder,
            source_dir,
            source_dir,
            true,
            &mut total_entries,
            &mut total_bytes,
        )?;
        let encoder = builder
            .into_inner()
            .map_err(|e| format!("Failed finalizing tar builder: {e}"))?;
        let mut out_file = encoder
            .finish()
            .map_err(|e| format!("Failed finishing gzip stream: {e}"))?;
        out_file
            .flush()
            .map_err(|e| format!("Failed flushing archive: {e}"))?;
        harden_private_file_sync(&tmp_path);
        fs::rename(&tmp_path, archive_path)
            .map_err(|e| format!("Failed moving archive into place: {e}"))?;
        harden_private_file_sync(archive_path);
        let compressed_bytes = fs::metadata(archive_path).map(|m| m.len()).unwrap_or(0);
        Ok(compressed_bytes)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

/// Safely extracts a backup `.tar.gz` archive into `dest_dir` with full confinement & bomb bounds.
pub fn extract_snapshot_tar_gz_confined(
    archive_path: &Path,
    dest_dir: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| {
        format!(
            "Failed creating extraction root {}: {e}",
            dest_dir.display()
        )
    })?;
    let canon_dest = canonicalize_sync(dest_dir);

    let file = File::open(archive_path).map_err(|e| {
        format!(
            "Failed opening backup archive {}: {e}",
            archive_path.display()
        )
    })?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);

    let entries = archive
        .entries()
        .map_err(|e| format!("Failed reading tar header stream: {e}"))?;

    let mut count = 0_usize;
    let mut total_uncompressed = 0_u64;

    for entry_res in entries {
        count += 1;
        if count > MAX_BACKUP_ARCHIVE_ENTRIES {
            return Err(format!(
                "Backup archive exceeds maximum entry count ({MAX_BACKUP_ARCHIVE_ENTRIES})."
            ));
        }
        let entry = entry_res.map_err(|e| format!("Corrupt tar entry: {e}"))?;
        let raw_path = entry
            .path()
            .map_err(|e| format!("Invalid tar entry path: {e}"))?
            .to_string_lossy()
            .into_owned();
        let rel_path = validate_contained_relative_path(&raw_path)?;
        let target_path = canon_dest.join(&rel_path);
        if !is_inside(&canon_dest, &target_path) {
            return Err(format!(
                "Tar entry {raw_path:?} escapes extraction destination."
            ));
        }

        // Verify no existing ancestor of target_path is a symlink escaping canon_dest.
        if let Some(parent) = target_path.parent() {
            ensure_confined_ancestor_dirs(&canon_dest, parent)?;
        }

        let entry_type = entry.header().entry_type();
        let mode = entry.header().mode().unwrap_or(0o644) & 0o7777;
        match entry_type {
            EntryType::Directory => {
                fs::create_dir_all(&target_path)
                    .map_err(|e| format!("Failed creating dir {}: {e}", target_path.display()))?;
                apply_unix_mode(&target_path, if mode == 0 { 0o755 } else { mode });
            }
            EntryType::Regular | EntryType::Continuous => {
                let declared_size = entry.header().size().unwrap_or(0);
                if declared_size > MAX_BACKUP_ARCHIVE_ENTRY_BYTES {
                    return Err(format!(
                        "Archive entry {raw_path:?} ({declared_size} bytes) exceeds single-entry limit ({MAX_BACKUP_ARCHIVE_ENTRY_BYTES})."
                    ));
                }
                let mut limited = entry.take(MAX_BACKUP_ARCHIVE_ENTRY_BYTES + 1);
                let mut out_file = File::create(&target_path)
                    .map_err(|e| format!("Failed creating {}: {e}", target_path.display()))?;
                let copied = std::io::copy(&mut limited, &mut out_file)
                    .map_err(|e| format!("Failed extracting {raw_path:?}: {e}"))?;
                if copied > MAX_BACKUP_ARCHIVE_ENTRY_BYTES {
                    let _ = fs::remove_file(&target_path);
                    return Err(format!(
                        "Archive entry {raw_path:?} exceeded {MAX_BACKUP_ARCHIVE_ENTRY_BYTES} byte read bound."
                    ));
                }
                total_uncompressed = total_uncompressed.saturating_add(copied);
                if total_uncompressed > MAX_BACKUP_ARCHIVE_TOTAL_BYTES {
                    let _ = fs::remove_file(&target_path);
                    return Err(format!(
                        "Backup archive exceeded {MAX_BACKUP_ARCHIVE_TOTAL_BYTES} byte total uncompressed limit."
                    ));
                }
                out_file
                    .flush()
                    .map_err(|e| format!("Failed flushing {raw_path:?}: {e}"))?;
                apply_unix_mode(&target_path, if mode == 0 { 0o644 } else { mode });
            }
            EntryType::Symlink => {
                let link_name = entry
                    .link_name()
                    .map_err(|e| format!("Invalid symlink header in {raw_path:?}: {e}"))?
                    .ok_or_else(|| format!("Missing symlink target in {raw_path:?}"))?;
                validate_symlink_target_confined(&rel_path, &link_name)?;
                if fs::symlink_metadata(&target_path).is_ok() {
                    let _ = fs::remove_file(&target_path);
                }
                create_symlink(&link_name, &target_path)?;
            }
            other => {
                return Err(format!(
                    "Unsupported tar entry type {other:?} for {raw_path:?} in backup archive."
                ));
            }
        }
    }

    Ok(())
}

fn ensure_confined_ancestor_dirs(root: &Path, target_parent: &Path) -> Result<(), String> {
    let rel = target_parent
        .strip_prefix(root)
        .map_err(|_| "Ancestor escapes extraction root.".to_owned())?;
    let mut cursor = root.to_path_buf();
    for comp in rel.components() {
        cursor.push(comp);
        if let Ok(meta) = fs::symlink_metadata(&cursor) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to extract through symlink directory {}.",
                    cursor.display()
                ));
            }
        } else {
            fs::create_dir(&cursor)
                .map_err(|e| format!("Failed creating directory {}: {e}", cursor.display()))?;
        }
    }
    Ok(())
}

fn apply_unix_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

fn create_symlink(link_target: &Path, dst: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(link_target, dst)
            .map_err(|e| format!("Failed creating symlink {}: {e}", dst.display()))
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(link_target, dst)
            .map_err(|e| format!("Failed creating symlink {}: {e}", dst.display()))
    }
}

fn validate_snapshot_ref(snapshot: &BackupSnapshotRef) -> Result<PathBuf, String> {
    if snapshot.kind == OriginalSnapshotKind::Pending {
        return Err("Stored backup snapshot kind must not be 'pending'.".to_owned());
    }
    validate_contained_relative_path(&snapshot.path)
}

fn resolve_snapshot_path_confined(
    session_dir: &Path,
    snapshot: &BackupSnapshotRef,
) -> Result<PathBuf, String> {
    let rel = validate_snapshot_ref(snapshot)?;
    let canon_session = canonicalize_sync(session_dir);
    let mut cursor = session_dir.to_path_buf();
    for comp in rel.components() {
        cursor.push(comp);
        if let Ok(meta) = fs::symlink_metadata(&cursor)
            && meta.file_type().is_symlink()
        {
            return Err(format!(
                "Refusing to use a symlink in backup snapshot path: {}",
                cursor.display()
            ));
        }
    }
    if cursor.exists() {
        let canon_target = canonicalize_sync(&cursor);
        if canon_target == canon_session || !is_inside(&canon_session, &canon_target) {
            return Err(format!(
                "Backup snapshot path escapes session backup directory: {}",
                snapshot.path
            ));
        }
    }
    Ok(cursor)
}

fn copy_snapshot_directory_confined(snapshot_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| {
        format!(
            "Failed creating directory snapshot destination {}: {e}",
            dest_dir.display()
        )
    })?;
    let canon_dest = canonicalize_sync(dest_dir);
    let mut total_entries = 0_usize;
    let mut total_bytes = 0_u64;

    fn copy_walk(
        base: &Path,
        current: &Path,
        canon_dest: &Path,
        is_root: bool,
        total_entries: &mut usize,
        total_bytes: &mut u64,
    ) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(current)
            .map_err(|e| {
                format!(
                    "Failed reading snapshot directory {}: {e}",
                    current.display()
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_root && is_excluded_top_level_name(&name) {
                continue;
            }
            *total_entries += 1;
            if *total_entries > MAX_BACKUP_ARCHIVE_ENTRIES {
                return Err(format!(
                    "Snapshot directory exceeds entry limit ({MAX_BACKUP_ARCHIVE_ENTRIES})."
                ));
            }
            let full_path = entry.path();
            let rel_str = full_path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let rel_path = validate_contained_relative_path(&rel_str)?;
            let target_path = canon_dest.join(&rel_path);
            if !is_inside(canon_dest, &target_path) {
                return Err(format!(
                    "Snapshot entry {rel_str:?} escapes destination directory."
                ));
            }
            if let Some(parent) = target_path.parent() {
                ensure_confined_ancestor_dirs(canon_dest, parent)?;
            }

            let meta = fs::symlink_metadata(&full_path).map_err(|e| {
                format!("Failed stating snapshot entry {}: {e}", full_path.display())
            })?;
            let ft = meta.file_type();
            if ft.is_symlink() {
                let link_target = fs::read_link(&full_path).map_err(|e| {
                    format!(
                        "Failed reading snapshot symlink {}: {e}",
                        full_path.display()
                    )
                })?;
                validate_symlink_target_confined(&rel_path, &link_target)?;
                if fs::symlink_metadata(&target_path).is_ok() {
                    let _ = fs::remove_file(&target_path);
                }
                create_symlink(&link_target, &target_path)?;
            } else if ft.is_dir() {
                fs::create_dir_all(&target_path).map_err(|e| {
                    format!("Failed creating directory {}: {e}", target_path.display())
                })?;
                apply_unix_mode(&target_path, entry_mode(&meta));
                copy_walk(
                    base,
                    &full_path,
                    canon_dest,
                    false,
                    total_entries,
                    total_bytes,
                )?;
            } else if ft.is_file() {
                let len = meta.len();
                if len > MAX_BACKUP_ARCHIVE_ENTRY_BYTES {
                    return Err(format!(
                        "Snapshot entry {rel_str:?} ({len} bytes) exceeds single-entry limit ({MAX_BACKUP_ARCHIVE_ENTRY_BYTES})."
                    ));
                }
                *total_bytes = total_bytes.saturating_add(len);
                if *total_bytes > MAX_BACKUP_ARCHIVE_TOTAL_BYTES {
                    return Err(format!(
                        "Snapshot directory exceeds total size limit ({MAX_BACKUP_ARCHIVE_TOTAL_BYTES})."
                    ));
                }
                fs::copy(&full_path, &target_path)
                    .map_err(|e| format!("Failed copying snapshot entry {rel_str:?}: {e}"))?;
                apply_unix_mode(&target_path, entry_mode(&meta));
            }
        }
        Ok(())
    }

    copy_walk(
        snapshot_dir,
        snapshot_dir,
        &canon_dest,
        true,
        &mut total_entries,
        &mut total_bytes,
    )
}

fn verify_snapshot_exists_confined(
    session_dir: &Path,
    snapshot: &BackupSnapshotRef,
) -> Result<PathBuf, String> {
    let path = resolve_snapshot_path_confined(session_dir, snapshot)?;
    match snapshot.kind {
        OriginalSnapshotKind::TarGz => {
            if !path.is_file() {
                return Err(format!(
                    "Snapshot archive is missing on disk: {}",
                    path.display()
                ));
            }
        }
        OriginalSnapshotKind::Directory => {
            if !path.is_dir() {
                return Err(format!(
                    "Snapshot directory is missing on disk: {}",
                    path.display()
                ));
            }
        }
        OriginalSnapshotKind::Pending => {
            return Err("Pending backup snapshot is not materialized.".to_owned());
        }
    }
    Ok(path)
}

fn materialize_snapshot_confined(
    session_dir: &Path,
    snapshot: &BackupSnapshotRef,
    dest_dir: &Path,
) -> Result<(), String> {
    let path = verify_snapshot_exists_confined(session_dir, snapshot)?;
    match snapshot.kind {
        OriginalSnapshotKind::TarGz => extract_snapshot_tar_gz_confined(&path, dest_dir),
        OriginalSnapshotKind::Directory => copy_snapshot_directory_confined(&path, dest_dir),
        OriginalSnapshotKind::Pending => {
            Err("Pending backup snapshot cannot be materialized.".to_owned())
        }
    }
}

fn snapshot_byte_size(session_dir: &Path, snapshot: &BackupSnapshotRef) -> Option<u64> {
    let path = resolve_snapshot_path_confined(session_dir, snapshot).ok()?;
    match snapshot.kind {
        OriginalSnapshotKind::TarGz => fs::metadata(&path)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len()),
        OriginalSnapshotKind::Directory => {
            if !path.is_dir() {
                return None;
            }
            fn sum_dir(dir: &Path) -> Option<u64> {
                let mut total = 0_u64;
                for entry in fs::read_dir(dir).ok()?.flatten() {
                    let p = entry.path();
                    let meta = fs::symlink_metadata(&p).ok()?;
                    let ft = meta.file_type();
                    if ft.is_file() {
                        total = total.saturating_add(meta.len());
                    } else if ft.is_dir() {
                        total = total.saturating_add(sum_dir(&p)?);
                    }
                }
                Some(total)
            }
            sum_dir(&path)
        }
        OriginalSnapshotKind::Pending => None,
    }
}

fn effective_updated_at(meta: &StoredSessionBackupMetadata) -> String {
    let mut best = meta.created_at.as_str();
    if let Some(last) = meta.checkpoints.last()
        && last.created_at.as_str() > best
    {
        best = last.created_at.as_str();
    }
    if let Some(ref closed) = meta.closed_at
        && closed.as_str() > best
    {
        best = closed.as_str();
    }
    if let Some(ref upd) = meta.updated_at
        && upd.as_str() > best
    {
        best = upd.as_str();
    }
    best.to_owned()
}

/// Crash-safe workspace replacement with `.restore-rollback-<id>` rollback protection.
pub fn replace_directory_contents(
    working_directory: &Path,
    staged_snapshot_dir: &Path,
) -> Result<(), String> {
    if let Some(reason) = workspace_recovery_failure_reason(working_directory) {
        return Err(reason);
    }

    let rollback_dir_name = format!("{RECOVERY_DIRECTORY_PREFIX}{}", Uuid::new_v4().simple());
    let rollback_dir = working_directory.join(&rollback_dir_name);
    let rollback_files_dir = rollback_dir.join("files");
    fs::create_dir_all(&rollback_files_dir).map_err(|e| {
        format!(
            "Failed creating restore rollback directory {}: {e}",
            rollback_files_dir.display()
        )
    })?;

    let write_phase = |phase: &str| -> Result<(), String> {
        let payload = serde_json::json!({
            "phase": phase,
            "updatedAt": now_iso(),
        });
        write_text_file_atomic(
            &rollback_dir.join("recovery.json"),
            &serde_json::to_string_pretty(&payload).unwrap_or_default(),
            Some(0o600),
        )
        .map_err(|e| e.to_string())
    };

    write_phase("moving")?;

    let existing_entries: Vec<String> = fs::read_dir(working_directory)
        .map_err(|e| {
            format!(
                "Failed listing workspace {}: {e}",
                working_directory.display()
            )
        })?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !is_excluded_top_level_name(name))
        .collect();

    let mut moved_to_rollback: Vec<String> = Vec::new();
    for name in &existing_entries {
        let src = working_directory.join(name);
        let dst = rollback_files_dir.join(name);
        if let Err(err) = fs::rename(&src, &dst) {
            for prev in moved_to_rollback.iter().rev() {
                let _ = fs::rename(rollback_files_dir.join(prev), working_directory.join(prev));
            }
            let _ = fs::remove_dir_all(&rollback_dir);
            return Err(format!(
                "Failed staging workspace entry {name:?} for restore: {err}"
            ));
        }
        moved_to_rollback.push(name.clone());
    }

    write_phase("restoring")?;

    let staged_entries: Vec<String> = fs::read_dir(staged_snapshot_dir)
        .map_err(|e| format!("Failed listing staged snapshot: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !is_excluded_top_level_name(name))
        .collect();

    let mut placed_entries: Vec<String> = Vec::new();
    for name in &staged_entries {
        let src = staged_snapshot_dir.join(name);
        let dst = working_directory.join(name);
        if let Err(err) = fs::rename(&src, &dst) {
            for placed in placed_entries.iter().rev() {
                let target = working_directory.join(placed);
                if target.is_dir() && !target.is_symlink() {
                    let _ = fs::remove_dir_all(&target);
                } else {
                    let _ = fs::remove_file(&target);
                }
            }
            for prev in moved_to_rollback.iter().rev() {
                let _ = fs::rename(rollback_files_dir.join(prev), working_directory.join(prev));
            }
            let _ = fs::remove_dir_all(&rollback_dir);
            return Err(format!("Failed placing restored entry {name:?}: {err}"));
        }
        placed_entries.push(name.clone());
    }

    write_phase("complete")?;
    let _ = fs::remove_dir_all(&rollback_dir);
    Ok(())
}

/// Manages session & workspace backups across primary and fallback backup roots.
#[derive(Debug, Clone)]
pub struct WorkspaceBackupManager {
    cowork_home: PathBuf,
    fallback_tmp_root: PathBuf,
}

impl WorkspaceBackupManager {
    pub fn new(cowork_home: PathBuf) -> Self {
        let fallback_tmp_root = std::env::temp_dir().join("cowork-session-backups");
        Self {
            cowork_home,
            fallback_tmp_root,
        }
    }

    pub fn with_fallback_root(cowork_home: PathBuf, fallback_tmp_root: PathBuf) -> Self {
        Self {
            cowork_home,
            fallback_tmp_root,
        }
    }

    fn candidate_roots(&self) -> [PathBuf; 2] {
        [
            self.cowork_home.join("session-backups"),
            self.fallback_tmp_root.clone(),
        ]
    }

    fn run_locked<R, F>(&self, target: &Path, f: F) -> Result<R, String>
    where
        F: FnOnce() -> Result<R, String>,
    {
        let lock_root = file_lock_root_for_cowork_home(&self.cowork_home);
        with_file_lock_sync::<R, anyhow::Error, _>(
            target,
            || f().map_err(|m| anyhow::anyhow!(m)),
            FileLockOptions {
                lock_root: Some(lock_root),
                ..FileLockOptions::default()
            },
        )
        .map_err(|e| e.to_string())
    }

    fn select_session_dir_for_workspace(
        &self,
        session_id: &str,
        working_directory: &Path,
    ) -> Result<PathBuf, String> {
        let safe_id = sanitize_session_dir_name(session_id)?;
        let canon_wd = canonicalize_sync(working_directory);

        // If an existing backup directory already exists in one of our roots, prefer it when disjoint.
        for root in self.candidate_roots() {
            let candidate = root.join(&safe_id);
            if candidate.exists() {
                let canon_cand = canonicalize_sync(&candidate);
                if !is_inside(&canon_wd, &canon_cand) && !is_inside(&canon_cand, &canon_wd) {
                    return Ok(candidate);
                }
            }
        }

        for root in self.candidate_roots() {
            let _ = ensure_private_dir_sync(&root);
            let canon_root = canonicalize_sync(&root);
            let session_dir = canon_root.join(&safe_id);
            if !is_inside(&canon_wd, &session_dir) && !is_inside(&session_dir, &canon_wd) {
                return Ok(session_dir);
            }
        }

        Err(
            "Workspace path overlaps with all available session-backup storage roots; refusing backup inside workspace."
                .to_owned(),
        )
    }

    fn find_existing_session_dir(&self, session_id: &str) -> Result<Option<PathBuf>, String> {
        let safe_id = sanitize_session_dir_name(session_id)?;
        for root in self.candidate_roots() {
            let candidate = root.join(&safe_id);
            if candidate.join("metadata.json").is_file() {
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }

    fn read_metadata(session_dir: &Path) -> Result<StoredSessionBackupMetadata, String> {
        let path = session_dir.join("metadata.json");
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed reading backup metadata {}: {e}", path.display()))?;
        let parsed: StoredSessionBackupMetadata = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid backup metadata {}: {e}", path.display()))?;
        if parsed.version != 1 {
            return Err(format!(
                "Unsupported backup metadata version: {}",
                parsed.version
            ));
        }
        if parsed.session_id.trim().is_empty()
            || parsed.working_directory.trim().is_empty()
            || parsed.created_at.trim().is_empty()
        {
            return Err(format!(
                "Invalid backup metadata {}: required string fields must not be empty.",
                path.display()
            ));
        }
        validate_snapshot_ref(&parsed.original_snapshot).map_err(|e| {
            format!(
                "Invalid originalSnapshot in backup metadata {}: {e}",
                path.display()
            )
        })?;
        for cp in &parsed.checkpoints {
            if cp.id.trim().is_empty()
                || cp.index < 1
                || cp.created_at.trim().is_empty()
                || cp.fingerprint.trim().is_empty()
            {
                return Err(format!(
                    "Invalid checkpoint record {:?} in backup metadata {}.",
                    cp.id,
                    path.display()
                ));
            }
            validate_snapshot_ref(&cp.snapshot).map_err(|e| {
                format!(
                    "Invalid checkpoint {:?} snapshot path in backup metadata {}: {e}",
                    cp.id,
                    path.display()
                )
            })?;
        }
        Ok(parsed)
    }

    fn write_metadata(
        session_dir: &Path,
        meta: &StoredSessionBackupMetadata,
    ) -> Result<(), String> {
        ensure_private_dir_sync(session_dir).map_err(|e| e.to_string())?;
        let serialized = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
        write_text_file_atomic(&session_dir.join("metadata.json"), &serialized, Some(0o600))
            .map_err(|e| e.to_string())
    }

    /// Ensures the initial original snapshot + `cp-0001` (`trigger: "initial"`) exist for an opt-in session.
    pub fn ensure_initial_backup(
        &self,
        session_id: &str,
        working_directory: &Path,
        title: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<SessionBackupPublicState, String> {
        if let Some(reason) = workspace_recovery_failure_reason(working_directory) {
            return Err(reason);
        }
        let canon_wd = canonicalize_sync(working_directory);
        let session_dir = self.select_session_dir_for_workspace(session_id, &canon_wd)?;

        self.run_locked(&session_dir, || {
            if session_dir.join("metadata.json").is_file() {
                let mut existing = Self::read_metadata(&session_dir)?;
                let mut dirty = false;
                if existing.state != BackupMetadataState::Active {
                    existing.state = BackupMetadataState::Active;
                    existing.closed_at = None;
                    dirty = true;
                }
                if title.is_some() && existing.title != title {
                    existing.title = title.clone();
                    dirty = true;
                }
                if provider.is_some() && existing.provider != provider {
                    existing.provider = provider.clone();
                    dirty = true;
                }
                if model.is_some() && existing.model != model {
                    existing.model = model.clone();
                    dirty = true;
                }
                if dirty {
                    existing.updated_at = Some(now_iso());
                    Self::write_metadata(&session_dir, &existing)?;
                }
                return Ok(Self::to_public_state(true, &session_dir, &existing));
            }

            ensure_private_dir_sync(&session_dir).map_err(|e| e.to_string())?;
            ensure_private_dir_sync(&session_dir.join("checkpoints")).map_err(|e| e.to_string())?;

            let now = now_iso();
            let fp = compute_workspace_fingerprint(&canon_wd)?;
            let orig_rel = "original.tar.gz".to_owned();
            let orig_bytes = write_snapshot_tar_gz(&canon_wd, &session_dir.join(&orig_rel))?;
            let orig_ref = BackupSnapshotRef {
                kind: OriginalSnapshotKind::TarGz,
                path: orig_rel,
            };

            let cp_id = "cp-0001".to_owned();
            let meta = StoredSessionBackupMetadata {
                version: 1,
                session_id: session_id.to_owned(),
                working_directory: canon_wd.to_string_lossy().into_owned(),
                created_at: now.clone(),
                state: BackupMetadataState::Active,
                closed_at: None,
                original_fingerprint: Some(fp.clone()),
                original_snapshot: orig_ref.clone(),
                checkpoints: vec![StoredCheckpointRecord {
                    id: cp_id,
                    index: 1,
                    created_at: now.clone(),
                    trigger: BackupTrigger::Initial,
                    changed: true,
                    patch_bytes: orig_bytes,
                    fingerprint: fp,
                    snapshot: orig_ref,
                }],
                title,
                provider,
                model,
                updated_at: Some(now),
            };
            Self::write_metadata(&session_dir, &meta)?;
            Ok(Self::to_public_state(true, &session_dir, &meta))
        })
    }

    /// Creates a manual or auto checkpoint (auto is throttled to 30s).
    pub fn create_checkpoint(
        &self,
        session_id: &str,
        working_directory: &Path,
        trigger: BackupTrigger,
        title: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<Option<SessionBackupPublicState>, String> {
        if let Some(reason) = workspace_recovery_failure_reason(working_directory) {
            return Err(reason);
        }
        let canon_wd = canonicalize_sync(working_directory);
        let session_dir = match self.find_existing_session_dir(session_id)? {
            Some(dir) => dir,
            None => {
                let state = self.ensure_initial_backup(
                    session_id,
                    &canon_wd,
                    title.clone(),
                    provider.clone(),
                    model.clone(),
                )?;
                if trigger == BackupTrigger::Auto {
                    return Ok(Some(state));
                }
                self.select_session_dir_for_workspace(session_id, &canon_wd)?
            }
        };

        self.run_locked(&session_dir, || {
            let mut meta = Self::read_metadata(&session_dir)?;
            if !same_workspace_path(&meta.working_directory, &canon_wd.to_string_lossy()) {
                return Err("Target backup session belongs to a different workspace.".to_owned());
            }

            if trigger == BackupTrigger::Auto
                && let Some(last) = meta.checkpoints.last()
                && let Ok(last_dt) = DateTime::parse_from_rfc3339(&last.created_at)
            {
                let elapsed = Utc::now().signed_duration_since(last_dt.with_timezone(&Utc));
                if elapsed >= chrono::Duration::zero()
                    && elapsed.to_std().unwrap_or(Duration::ZERO) < AUTO_CHECKPOINT_THROTTLE
                {
                    return Ok(None);
                }
            }

            let fp = compute_workspace_fingerprint(&canon_wd)?;
            let idx = meta.checkpoints.iter().map(|c| c.index).max().unwrap_or(0) + 1;
            let cp_id = format!("cp-{idx:04}");
            let now = now_iso();

            let prev_record = meta.checkpoints.last().cloned();
            let (changed, patch_bytes, snapshot) =
                if let Some(prev) = prev_record.filter(|p| p.fingerprint == fp) {
                    (false, 0_u64, prev.snapshot)
                } else {
                    let rel = format!("checkpoints/{cp_id}.tar.gz");
                    let bytes = write_snapshot_tar_gz(&canon_wd, &session_dir.join(&rel))?;
                    (
                        true,
                        bytes,
                        BackupSnapshotRef {
                            kind: OriginalSnapshotKind::TarGz,
                            path: rel,
                        },
                    )
                };

            meta.updated_at = Some(now.clone());
            if title.is_some() {
                meta.title = title;
            }
            if provider.is_some() {
                meta.provider = provider;
            }
            if model.is_some() {
                meta.model = model;
            }
            meta.checkpoints.push(StoredCheckpointRecord {
                id: cp_id,
                index: idx,
                created_at: now,
                trigger,
                changed,
                patch_bytes,
                fingerprint: fp,
                snapshot,
            });
            Self::write_metadata(&session_dir, &meta)?;
            Ok(Some(Self::to_public_state(true, &session_dir, &meta)))
        })
    }

    /// Reads current session backup state for `cowork/session/backupState`.
    pub fn read_session_backup_state(
        &self,
        session_id: &str,
        working_directory: &Path,
        enabled: bool,
    ) -> SessionBackupPublicState {
        let canon_wd = canonicalize_sync(working_directory);
        let wd_str = canon_wd.to_string_lossy().into_owned();
        if let Ok(Some(session_dir)) = self.find_existing_session_dir(session_id)
            && let Ok(meta) = Self::read_metadata(&session_dir)
        {
            return Self::to_public_state(enabled, &session_dir, &meta);
        }
        SessionBackupPublicState {
            status: if enabled {
                BackupStatus::Initializing
            } else {
                BackupStatus::Disabled
            },
            session_id: session_id.to_owned(),
            working_directory: wd_str,
            backup_directory: None,
            created_at: now_iso(),
            original_snapshot: SessionOriginalSnapshot {
                kind: OriginalSnapshotKind::Pending,
            },
            checkpoints: Vec::new(),
            failure_reason: None,
        }
    }

    /// Lists all workspace backup entries matching `working_directory`.
    pub fn read_workspace_backups<F>(
        &self,
        working_directory: &Path,
        session_id_for_event: Option<String>,
        mut lookup_session: F,
    ) -> Result<WorkspaceBackupsEvent, String>
    where
        F: FnMut(&str) -> SessionLookupMetadata,
    {
        let canon_wd = canonicalize_sync(working_directory);
        let wd_str = canon_wd.to_string_lossy().into_owned();
        let mut seen_sessions = BTreeSet::new();
        let mut entries = Vec::new();

        for root in self.candidate_roots() {
            let Ok(read_dir) = fs::read_dir(&root) else {
                continue;
            };
            for dir_entry in read_dir.flatten() {
                let session_dir = dir_entry.path();
                if !session_dir.join("metadata.json").is_file() {
                    continue;
                }
                let Ok(meta) = Self::read_metadata(&session_dir) else {
                    continue;
                };
                if !same_workspace_path(&meta.working_directory, &wd_str) {
                    continue;
                }
                if !seen_sessions.insert(meta.session_id.clone()) {
                    continue;
                }
                let live_info = lookup_session(&meta.session_id);
                entries.push(Self::to_workspace_entry(&session_dir, &meta, live_info));
            }
        }

        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(WorkspaceBackupsEvent {
            event_type: "workspace_backups".to_owned(),
            session_id: session_id_for_event,
            workspace_path: wd_str,
            backups: entries,
        })
    }

    /// Computes added/modified/deleted delta between a backup checkpoint (or `"original"`) and current workspace.
    pub fn read_workspace_backup_delta(
        &self,
        working_directory: &Path,
        target_session_id: &str,
        checkpoint_id: &str,
        session_id_for_event: Option<String>,
    ) -> Result<WorkspaceBackupDeltaEvent, String> {
        let canon_wd = canonicalize_sync(working_directory);
        let wd_str = canon_wd.to_string_lossy().into_owned();
        let session_dir = self
            .find_existing_session_dir(target_session_id)?
            .ok_or_else(|| format!("Backup entry not found for session {target_session_id}."))?;
        let meta = Self::read_metadata(&session_dir)?;
        if !same_workspace_path(&meta.working_directory, &wd_str) {
            return Err("Backup session does not belong to this workspace.".to_owned());
        }

        let (snapshot_ref, baseline_label) =
            Self::resolve_snapshot_ref(&meta, Some(checkpoint_id))?;
        let temp_extract = session_dir.join(format!(".delta-extract-{}", Uuid::new_v4().simple()));
        let baseline_manifest = {
            let res = (|| -> Result<BTreeMap<String, EntrySignature>, String> {
                materialize_snapshot_confined(&session_dir, &snapshot_ref, &temp_extract)?;
                collect_directory_manifest(&temp_extract)
            })();
            let _ = fs::remove_dir_all(&temp_extract);
            res?
        };
        let current_manifest = collect_directory_manifest(&canon_wd)?;

        let mut all_paths = BTreeSet::new();
        all_paths.extend(baseline_manifest.keys().cloned());
        all_paths.extend(current_manifest.keys().cloned());

        let mut added = 0_usize;
        let mut modified = 0_usize;
        let mut deleted = 0_usize;
        let mut files = Vec::new();
        let mut truncated = false;

        for path in all_paths {
            match (baseline_manifest.get(&path), current_manifest.get(&path)) {
                (None, Some(curr)) => {
                    added += 1;
                    if files.len() < MAX_DELTA_FILES {
                        files.push(WorkspaceBackupDeltaFile {
                            path,
                            change: DeltaChangeKind::Added,
                            kind: curr.kind,
                        });
                    } else {
                        truncated = true;
                    }
                }
                (Some(base), None) => {
                    deleted += 1;
                    if files.len() < MAX_DELTA_FILES {
                        files.push(WorkspaceBackupDeltaFile {
                            path,
                            change: DeltaChangeKind::Deleted,
                            kind: base.kind,
                        });
                    } else {
                        truncated = true;
                    }
                }
                (Some(base), Some(curr)) if base != curr => {
                    modified += 1;
                    if files.len() < MAX_DELTA_FILES {
                        files.push(WorkspaceBackupDeltaFile {
                            path,
                            change: DeltaChangeKind::Modified,
                            kind: curr.kind,
                        });
                    } else {
                        truncated = true;
                    }
                }
                _ => {}
            }
        }

        Ok(WorkspaceBackupDeltaEvent {
            event_type: "workspace_backup_delta".to_owned(),
            session_id: session_id_for_event,
            target_session_id: target_session_id.to_owned(),
            checkpoint_id: checkpoint_id.to_owned(),
            baseline_label,
            current_label: "Current workspace".to_owned(),
            counts: WorkspaceBackupDeltaCounts {
                added,
                modified,
                deleted,
            },
            files,
            truncated,
        })
    }

    /// Creates a `"manual"` safety checkpoint first, then restores `checkpoint_id` (or original snapshot).
    pub fn restore_workspace_backup<F>(
        &self,
        working_directory: &Path,
        target_session_id: &str,
        checkpoint_id: Option<&str>,
        session_id_for_event: Option<String>,
        lookup_session: F,
    ) -> Result<(WorkspaceBackupsEvent, SessionBackupPublicState), String>
    where
        F: FnMut(&str) -> SessionLookupMetadata,
    {
        if let Some(reason) = workspace_recovery_failure_reason(working_directory) {
            return Err(reason);
        }
        let canon_wd = canonicalize_sync(working_directory);
        let wd_str = canon_wd.to_string_lossy().into_owned();
        let session_dir = self
            .find_existing_session_dir(target_session_id)?
            .ok_or_else(|| format!("Backup entry not found for session {target_session_id}."))?;

        let meta_before = Self::read_metadata(&session_dir)?;
        if !same_workspace_path(&meta_before.working_directory, &wd_str) {
            return Err("Backup session does not belong to this workspace.".to_owned());
        }
        // Validate the requested checkpoint (and confined snapshot existence) BEFORE creating safety checkpoint.
        let (snapshot_ref, _) = Self::resolve_snapshot_ref(&meta_before, checkpoint_id)?;
        verify_snapshot_exists_confined(&session_dir, &snapshot_ref)?;

        // Create safety manual checkpoint before overwriting workspace contents.
        let _ = self.create_checkpoint(
            target_session_id,
            &canon_wd,
            BackupTrigger::Manual,
            None,
            None,
            None,
        )?;

        let state = self.run_locked(&session_dir, || {
            self.run_locked(&canon_wd, || {
                let stage_parent =
                    session_dir.join(format!(".stage-restore-{}", Uuid::new_v4().simple()));
                let res = (|| -> Result<SessionBackupPublicState, String> {
                    materialize_snapshot_confined(&session_dir, &snapshot_ref, &stage_parent)?;
                    replace_directory_contents(&canon_wd, &stage_parent)?;
                    let mut meta = Self::read_metadata(&session_dir)?;
                    meta.updated_at = Some(now_iso());
                    Self::write_metadata(&session_dir, &meta)?;
                    Ok(Self::to_public_state(true, &session_dir, &meta))
                })();
                let _ = fs::remove_dir_all(&stage_parent);
                res
            })
        })?;

        let event = self.read_workspace_backups(&canon_wd, session_id_for_event, lookup_session)?;
        Ok((event, state))
    }

    /// Deletes a non-initial checkpoint from a session backup.
    pub fn delete_checkpoint<F>(
        &self,
        working_directory: &Path,
        target_session_id: &str,
        checkpoint_id: &str,
        session_id_for_event: Option<String>,
        lookup_session: F,
    ) -> Result<(WorkspaceBackupsEvent, SessionBackupPublicState), String>
    where
        F: FnMut(&str) -> SessionLookupMetadata,
    {
        let canon_wd = canonicalize_sync(working_directory);
        let wd_str = canon_wd.to_string_lossy().into_owned();
        let session_dir = self
            .find_existing_session_dir(target_session_id)?
            .ok_or_else(|| format!("Backup entry not found for session {target_session_id}."))?;

        let state = self.run_locked(&session_dir, || {
            let mut meta = Self::read_metadata(&session_dir)?;
            if !same_workspace_path(&meta.working_directory, &wd_str) {
                return Err("Backup session does not belong to this workspace.".to_owned());
            }
            let pos = meta
                .checkpoints
                .iter()
                .position(|c| c.id == checkpoint_id)
                .ok_or_else(|| format!("Checkpoint {checkpoint_id} not found."))?;
            if meta.checkpoints[pos].trigger == BackupTrigger::Initial {
                return Err("The initial checkpoint cannot be deleted.".to_owned());
            }
            let removed = meta.checkpoints.remove(pos);
            let still_referenced = meta.original_snapshot == removed.snapshot
                || meta
                    .checkpoints
                    .iter()
                    .any(|c| c.snapshot == removed.snapshot);
            if !still_referenced
                && let Ok(snap_path) =
                    resolve_snapshot_path_confined(&session_dir, &removed.snapshot)
            {
                match removed.snapshot.kind {
                    OriginalSnapshotKind::TarGz => {
                        let _ = fs::remove_file(snap_path);
                    }
                    OriginalSnapshotKind::Directory => {
                        let _ = fs::remove_dir_all(snap_path);
                    }
                    OriginalSnapshotKind::Pending => {}
                }
            }
            meta.updated_at = Some(now_iso());
            Self::write_metadata(&session_dir, &meta)?;
            Ok(Self::to_public_state(true, &session_dir, &meta))
        })?;

        let event = self.read_workspace_backups(&canon_wd, session_id_for_event, lookup_session)?;
        Ok((event, state))
    }

    /// Deletes an entire backup entry for `target_session_id` under `session_dir -> working_directory` lock order.
    pub fn delete_entry<F>(
        &self,
        working_directory: &Path,
        target_session_id: &str,
        session_id_for_event: Option<String>,
        lookup_session: F,
    ) -> Result<WorkspaceBackupsEvent, String>
    where
        F: FnMut(&str) -> SessionLookupMetadata,
    {
        let canon_wd = canonicalize_sync(working_directory);
        let wd_str = canon_wd.to_string_lossy().into_owned();
        let Some(session_dir) = self.find_existing_session_dir(target_session_id)? else {
            return Err(format!(
                "Backup entry not found for session {target_session_id}."
            ));
        };
        let meta = Self::read_metadata(&session_dir)?;
        if !same_workspace_path(&meta.working_directory, &wd_str) {
            return Err("Backup session does not belong to this workspace.".to_owned());
        }

        self.run_locked(&session_dir, || {
            self.run_locked(&canon_wd, || {
                fs::remove_dir_all(&session_dir).map_err(|e| {
                    format!(
                        "Failed removing backup directory {}: {e}",
                        session_dir.display()
                    )
                })
            })
        })?;

        self.read_workspace_backups(&canon_wd, session_id_for_event, lookup_session)
    }

    /// Marks an existing session backup `metadata.json` as `"closed"` with `closedAt`.
    pub fn mark_session_closed(&self, session_id: &str) -> Result<(), String> {
        let Some(session_dir) = self.find_existing_session_dir(session_id)? else {
            return Ok(());
        };
        self.run_locked(&session_dir, || {
            let mut meta = Self::read_metadata(&session_dir)?;
            if meta.state != BackupMetadataState::Closed {
                let now = now_iso();
                meta.state = BackupMetadataState::Closed;
                meta.closed_at = Some(now.clone());
                meta.updated_at = Some(now);
                Self::write_metadata(&session_dir, &meta)?;
            }
            Ok(())
        })
    }

    fn resolve_snapshot_ref(
        meta: &StoredSessionBackupMetadata,
        checkpoint_id: Option<&str>,
    ) -> Result<(BackupSnapshotRef, String), String> {
        let trimmed = checkpoint_id.map(str::trim).filter(|s| !s.is_empty());
        match trimmed {
            None | Some("original") => Ok((
                meta.original_snapshot.clone(),
                "Original snapshot".to_owned(),
            )),
            Some(cp_id) => {
                let cp = meta
                    .checkpoints
                    .iter()
                    .find(|c| c.id == cp_id)
                    .ok_or_else(|| format!("Checkpoint {cp_id} not found."))?;
                Ok((
                    cp.snapshot.clone(),
                    format!("Checkpoint #{} ({})", cp.index, cp.id),
                ))
            }
        }
    }

    fn to_public_checkpoints(
        checkpoints: &[StoredCheckpointRecord],
    ) -> Vec<SessionBackupPublicCheckpoint> {
        checkpoints
            .iter()
            .map(|c| SessionBackupPublicCheckpoint {
                id: c.id.clone(),
                index: c.index,
                created_at: c.created_at.clone(),
                trigger: c.trigger,
                changed: c.changed,
                patch_bytes: c.patch_bytes,
            })
            .collect()
    }

    fn to_public_state(
        enabled: bool,
        session_dir: &Path,
        meta: &StoredSessionBackupMetadata,
    ) -> SessionBackupPublicState {
        let checkpoints = Self::to_public_checkpoints(&meta.checkpoints);
        let failure_reason = workspace_recovery_failure_reason(Path::new(&meta.working_directory));
        let status = if !enabled {
            BackupStatus::Disabled
        } else if failure_reason.is_some() {
            BackupStatus::Failed
        } else {
            BackupStatus::Ready
        };
        SessionBackupPublicState {
            status,
            session_id: meta.session_id.clone(),
            working_directory: meta.working_directory.clone(),
            backup_directory: Some(session_dir.to_string_lossy().into_owned()),
            created_at: meta.created_at.clone(),
            original_snapshot: SessionOriginalSnapshot {
                kind: meta.original_snapshot.kind,
            },
            checkpoints,
            failure_reason,
        }
    }

    fn to_workspace_entry(
        session_dir: &Path,
        meta: &StoredSessionBackupMetadata,
        live_info: SessionLookupMetadata,
    ) -> WorkspaceBackupEntry {
        let orig_bytes = snapshot_byte_size(session_dir, &meta.original_snapshot);
        let mut unique_cp_snapshots = BTreeSet::new();
        let mut cp_bytes_total = 0_u64;
        for cp in &meta.checkpoints {
            if cp.snapshot == meta.original_snapshot {
                continue;
            }
            if unique_cp_snapshots.insert(cp.snapshot.clone())
                && let Some(sz) = snapshot_byte_size(session_dir, &cp.snapshot)
            {
                cp_bytes_total = cp_bytes_total.saturating_add(sz);
            }
        }
        let total_bytes = orig_bytes.map(|o| o.saturating_add(cp_bytes_total));
        let failure_reason = workspace_recovery_failure_reason(Path::new(&meta.working_directory));
        let status = if failure_reason.is_some() {
            BackupStatus::Failed
        } else {
            BackupStatus::Ready
        };

        WorkspaceBackupEntry {
            target_session_id: meta.session_id.clone(),
            title: live_info.title.or_else(|| meta.title.clone()),
            provider: live_info.provider.or_else(|| meta.provider.clone()),
            model: live_info.model.or_else(|| meta.model.clone()),
            lifecycle: live_info.lifecycle,
            status,
            working_directory: meta.working_directory.clone(),
            backup_directory: Some(session_dir.to_string_lossy().into_owned()),
            original_snapshot_kind: meta.original_snapshot.kind,
            original_snapshot_bytes: orig_bytes,
            checkpoint_bytes_total: Some(cp_bytes_total),
            total_bytes,
            checkpoints: Self::to_public_checkpoints(&meta.checkpoints),
            created_at: meta.created_at.clone(),
            updated_at: effective_updated_at(meta),
            closed_at: meta.closed_at.clone(),
            failure_reason,
        }
    }
}
