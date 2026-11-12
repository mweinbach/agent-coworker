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
use cowork_config::now_iso;
use cowork_config::{
    FileLockOptions, canonicalize_sync, ensure_private_dir_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, is_inside, same_workspace_path, with_file_lock_sync,
    write_text_file_atomic,
};
use cowork_storage::task_review_policy::js_locale_compare;
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
pub const MAX_DELTA_FILES: usize = 200;

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
    digest: String,
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
                        digest,
                    },
                );
            } else if ft.is_dir() {
                out.insert(
                    rel_path,
                    EntrySignature {
                        kind: DeltaEntryKind::Directory,
                        digest: String::new(),
                    },
                );
                walk(base, &full_path, false, out)?;
            } else if ft.is_file() {
                out.insert(
                    rel_path,
                    EntrySignature {
                        kind: DeltaEntryKind::File,
                        digest: hash_file_hex(&full_path)?,
                    },
                );
            }
        }
        Ok(())
    }

    walk(root, root, true, &mut manifest)?;
    Ok(manifest)
}

/// Hex SHA-256 of a file's content.
fn hash_file_hex(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|e| format!("Failed opening {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed hashing {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Deterministic `session-backup-workspace-v2` SHA-256 fingerprint.
///
/// Byte-compatible with the TypeScript `workspaceFingerprint` that wrote the same prefix, so a
/// checkpoint of an unchanged workspace deduplicates against a fingerprint recorded before the
/// upgrade: entries are walked depth-first in pre-order, siblings sorted with `localeCompare`
/// (ICU root collation), and each entry hashes one `JSON.stringify` line:
/// `["directory", rel, mode]`, `["file", rel, mode, sha256]`, `["symlink", rel, rawTarget]`, or
/// `["other", rel, st_mode, size]`. Top-level `.ModelScratchpad` (and `.restore-rollback-*`,
/// which the recovery guard keeps absent whenever a fingerprint is taken) are skipped.
pub fn compute_workspace_fingerprint(working_directory: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"session-backup-workspace-v2\n");
    if working_directory.exists() {
        fingerprint_walk(&mut hasher, working_directory, working_directory, true)?;
    }
    Ok(hex::encode(hasher.finalize()))
}

fn fingerprint_walk(
    hasher: &mut Sha256,
    base: &Path,
    current: &Path,
    is_root: bool,
) -> Result<(), String> {
    let mut entries: Vec<(String, PathBuf)> = fs::read_dir(current)
        .map_err(|e| format!("Failed reading directory {}: {e}", current.display()))?
        .map(|entry| {
            entry
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
                .map_err(|e| {
                    format!(
                        "Failed reading directory entry in {}: {e}",
                        current.display()
                    )
                })
        })
        .collect::<Result<_, _>>()?;
    // `entries.sort((a, b) => a.name.localeCompare(b.name))`; byte order only breaks collation
    // ties, which the TS stable sort left in (unspecified) `readdir` order.
    entries.sort_by(|a, b| js_locale_compare(&a.0, &b.0).then_with(|| a.0.cmp(&b.0)));

    for (name, full_path) in entries {
        if is_root && is_excluded_top_level_name(&name) {
            continue;
        }
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
        let line = if ft.is_dir() {
            serde_json::to_string(&("directory", &rel_path, entry_mode(&meta)))
        } else if ft.is_file() {
            let digest = hash_file_hex(&full_path)?;
            serde_json::to_string(&("file", &rel_path, entry_mode(&meta), digest))
        } else if ft.is_symlink() {
            let target = fs::read_link(&full_path)
                .map_err(|e| format!("Failed reading symlink {}: {e}", full_path.display()))?;
            serde_json::to_string(&("symlink", &rel_path, target.to_string_lossy()))
        } else {
            serde_json::to_string(&("other", &rel_path, raw_st_mode(&meta), meta.len()))
        }
        .map_err(|e| format!("Failed encoding fingerprint entry {rel_path:?}: {e}"))?;
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
        if ft.is_dir() {
            fingerprint_walk(hasher, base, &full_path, false)?;
        }
    }
    Ok(())
}

/// Full `st_mode` (file type and permission bits), as Node's `stat.mode`.
fn raw_st_mode(meta: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.mode()
    }
    #[cfg(not(unix))]
    {
        entry_mode(meta)
    }
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
///
/// Archived directory modes are applied only after every entry has been extracted (deepest
/// first), so a populated read-only directory (e.g. `0555`) can be extracted by a non-root user.
pub fn extract_snapshot_tar_gz_confined(
    archive_path: &Path,
    dest_dir: &Path,
) -> Result<(), String> {
    extract_snapshot_tar_gz_deferred(archive_path, dest_dir)?.apply();
    Ok(())
}

/// Final directory modes recorded while materializing a snapshot, keyed by path relative to the
/// materialization root.
///
/// Directories are kept owner-writable while their descendants are written; the recorded modes
/// are applied once every entry exists, so a populated read-only directory does not block the
/// creation of its own children. Restores publish the still-writable staging tree first (a
/// directory can only be moved to a new parent while it is writable) and apply the modes at the
/// final location.
#[derive(Debug)]
#[must_use = "deferred directory modes must be applied once materialization finishes"]
struct DeferredDirModes {
    root: PathBuf,
    modes: BTreeMap<PathBuf, u32>,
}

impl DeferredDirModes {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            modes: BTreeMap::new(),
        }
    }

    fn record(&mut self, rel_path: &Path, mode: u32) {
        self.modes.insert(rel_path.to_path_buf(), mode);
    }

    /// Applies the recorded modes inside the materialization root.
    fn apply(&self) {
        self.apply_under(&self.root, false);
    }

    /// Applies the recorded modes to the same relative paths under `working_directory` after the
    /// staged tree was published there. Entries under top-level names the restore never publishes
    /// (`.ModelScratchpad`, `.restore-rollback-*`) are skipped so live workspace state is untouched.
    fn apply_to_workspace(&self, working_directory: &Path) {
        self.apply_under(working_directory, true);
    }

    fn apply_under(&self, root: &Path, skip_unpublished_top_level: bool) {
        let mut ordered: Vec<(&PathBuf, u32)> =
            self.modes.iter().map(|(rel, mode)| (rel, *mode)).collect();
        // Deepest first: a parent that ends up without write or search permission must not
        // prevent its descendants' modes from being applied.
        ordered.sort_by_key(|(rel, _)| std::cmp::Reverse(rel.components().count()));
        for (rel, mode) in ordered {
            if skip_unpublished_top_level
                && rel
                    .components()
                    .next()
                    .is_some_and(|c| is_excluded_top_level_name(&c.as_os_str().to_string_lossy()))
            {
                continue;
            }
            if let Some(path) = real_directory_under(root, rel) {
                set_dir_mode_no_follow(&path, mode);
            }
        }
    }
}

/// Resolves `rel` under `root` only when every component is a real directory (no symlinks).
fn real_directory_under(root: &Path, rel: &Path) -> Option<PathBuf> {
    let mut cursor = root.to_path_buf();
    for comp in rel.components() {
        let Component::Normal(name) = comp else {
            return None;
        };
        cursor.push(name);
        let meta = fs::symlink_metadata(&cursor).ok()?;
        if !meta.file_type().is_dir() {
            return None;
        }
    }
    Some(cursor)
}

/// Mode a directory carries while its descendants are being materialized: the archived mode plus
/// owner `rwx`.
fn writable_dir_mode(final_mode: u32) -> u32 {
    final_mode | 0o700
}

/// Sets a directory's mode without following a symlink at `path` (best effort, like
/// [`apply_unix_mode`]). Uses `fchmod` on a no-follow directory handle when the directory can be
/// opened, and otherwise (a directory without read permission) a path `chmod` after re-checking
/// that `path` is still a real directory.
fn set_dir_mode_no_follow(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let opened = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path);
        match opened {
            Ok(dir) => {
                let _ = dir.set_permissions(fs::Permissions::from_mode(mode));
            }
            Err(_) => {
                if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir()) {
                    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

/// `fs::remove_dir_all` that also removes trees holding read-only directories.
///
/// A populated directory without owner write permission cannot be emptied by a non-root user,
/// so when removal is refused the real directories under `path` (never following symlinks) are
/// made owner-writable and removal is retried. Used for backup-owned trees: restore/delta staging
/// directories, restore rollback directories, and snapshot storage.
fn remove_dir_all_force(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            #[cfg(unix)]
            {
                make_real_dirs_owner_writable(path);
                fs::remove_dir_all(path)
            }
            #[cfg(not(unix))]
            {
                Err(err)
            }
        }
        other => other,
    }
}

#[cfg(unix)]
fn make_real_dirs_owner_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if !meta.file_type().is_dir() {
        return;
    }
    let mode = meta.permissions().mode() & 0o7777;
    if mode & 0o700 != 0o700 {
        set_dir_mode_no_follow(path, mode | 0o700);
    }
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            make_real_dirs_owner_writable(&entry.path());
        }
    }
}

/// Extracts like [`extract_snapshot_tar_gz_confined`] but leaves directories owner-writable and
/// returns their archived modes for the caller to apply.
fn extract_snapshot_tar_gz_deferred(
    archive_path: &Path,
    dest_dir: &Path,
) -> Result<DeferredDirModes, String> {
    fs::create_dir_all(dest_dir).map_err(|e| {
        format!(
            "Failed creating extraction root {}: {e}",
            dest_dir.display()
        )
    })?;
    let canon_dest = canonicalize_sync(dest_dir);
    let mut deferred = DeferredDirModes::new(canon_dest.clone());

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
    let mut extracted_symlinks: Vec<PathBuf> = Vec::new();

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
        if is_archive_root_entry(&raw_path) && entry.header().entry_type().is_dir() {
            // The extraction root already exists; legacy snapshots carry no other data for it.
            continue;
        }
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
                // An earlier entry may have planted a symlink (or file) at this path: replace it
                // rather than creating/chmodding through it.
                ensure_real_directory_leaf(&target_path, &raw_path)?;
                let final_mode = if mode == 0 { 0o755 } else { mode };
                // Archives list a directory before its descendants: keep it writable until the
                // whole archive is extracted.
                set_dir_mode_no_follow(&target_path, writable_dir_mode(final_mode));
                deferred.record(&rel_path, final_mode);
            }
            EntryType::Regular | EntryType::Continuous => {
                let declared_size = entry.header().size().unwrap_or(0);
                if declared_size > MAX_BACKUP_ARCHIVE_ENTRY_BYTES {
                    return Err(format!(
                        "Archive entry {raw_path:?} ({declared_size} bytes) exceeds single-entry limit ({MAX_BACKUP_ARCHIVE_ENTRY_BYTES})."
                    ));
                }
                let mut limited = entry.take(MAX_BACKUP_ARCHIVE_ENTRY_BYTES + 1);
                // A later entry reusing a symlink's path replaces the link; it never writes
                // through it (the file is created exclusively and without following symlinks).
                unlink_non_directory_leaf(&target_path, &raw_path)?;
                let mut out_file = create_new_file_no_follow(&target_path)
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
                set_file_mode_on_handle(&out_file, if mode == 0 { 0o644 } else { mode });
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
                extracted_symlinks.push(rel_path);
            }
            other => {
                return Err(format!(
                    "Unsupported tar entry type {other:?} for {raw_path:?} in backup archive."
                ));
            }
        }
    }

    // Each target was checked lexically on its own when it was created; later entries can still
    // add the symlink hops that make it resolve elsewhere, so re-resolve every link against the
    // finished tree.
    validate_materialized_symlinks(&canon_dest, &extracted_symlinks)?;
    Ok(deferred)
}

/// Makes `target_path` a real directory, replacing a symlink or non-directory left there by an
/// earlier archive entry (never following it).
fn ensure_real_directory_leaf(target_path: &Path, raw_path: &str) -> Result<(), String> {
    match fs::symlink_metadata(target_path) {
        Ok(meta) if meta.file_type().is_dir() => return Ok(()),
        Ok(_) => fs::remove_file(target_path).map_err(|e| {
            format!("Failed replacing existing entry for archive directory {raw_path:?}: {e}")
        })?,
        Err(_) => {}
    }
    fs::create_dir(target_path)
        .map_err(|e| format!("Failed creating dir {}: {e}", target_path.display()))
}

/// Removes a symlink or file left at `target_path` by an earlier archive entry (the link itself,
/// never what it points to). A directory there conflicts with a file entry and is rejected.
fn unlink_non_directory_leaf(target_path: &Path, raw_path: &str) -> Result<(), String> {
    match fs::symlink_metadata(target_path) {
        Ok(meta) if meta.file_type().is_dir() => Err(format!(
            "Archive file entry {raw_path:?} conflicts with an extracted directory."
        )),
        Ok(_) => fs::remove_file(target_path).map_err(|e| {
            format!("Failed replacing existing entry for archive file {raw_path:?}: {e}")
        }),
        Err(_) => Ok(()),
    }
}

/// Creates a new file exclusively (`O_CREAT | O_EXCL`, plus `O_NOFOLLOW` on Unix), so a symlink
/// at `path` is never followed.
fn create_new_file_no_follow(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options.open(path)
}

/// Best-effort `fchmod` on an open handle (no path lookup, so nothing can be followed).
fn set_file_mode_on_handle(file: &File, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (file, mode);
    }
}

/// Re-resolves every extracted symlink against the materialized tree under `root` (see
/// [`ensure_materialized_symlink_confined`]). A link that fails is removed before the error is
/// returned so it is not left pointing outside the destination.
fn validate_materialized_symlinks(root: &Path, symlinks: &[PathBuf]) -> Result<(), String> {
    for rel in symlinks {
        let link_path = root.join(rel);
        let still_symlink =
            fs::symlink_metadata(&link_path).is_ok_and(|m| m.file_type().is_symlink());
        if !still_symlink {
            // Replaced by a later entry.
            continue;
        }
        if let Err(err) = ensure_materialized_symlink_confined(root, rel) {
            let _ = fs::remove_file(&link_path);
            return Err(err);
        }
    }
    Ok(())
}

/// Upper bound on symlinks followed while resolving one link; well above the kernel's own limit
/// (40 on Linux, 32 on macOS), so a link still unresolved past it cannot resolve at all.
const MAX_MATERIALIZED_SYMLINK_HOPS: usize = 256;

/// Resolves the symlink at `rel_link` (relative to `root`) the way the kernel would, following
/// every symlink it traverses, and fails when any step climbs above `root`, reaches an absolute
/// path, or enters a reserved top-level directory. Components that do not exist (yet) are treated
/// as plain directories, so later-created entries cannot turn a dangling link into an escape
/// without themselves being symlinks that this check also covers.
fn ensure_materialized_symlink_confined(root: &Path, rel_link: &Path) -> Result<(), String> {
    use std::collections::VecDeque;
    use std::ffi::OsString;

    let escape_error = || {
        format!(
            "Archive symlink {} resolves outside the extraction destination.",
            rel_link.display()
        )
    };
    let push_target = |pending: &mut VecDeque<OsString>, target: &Path| -> Result<(), String> {
        let mut parts = Vec::new();
        for comp in target.components() {
            match comp {
                Component::Normal(name) => parts.push(name.to_os_string()),
                Component::ParentDir => parts.push(OsString::from("..")),
                Component::CurDir => {}
                Component::RootDir | Component::Prefix(_) => return Err(escape_error()),
            }
        }
        for part in parts.into_iter().rev() {
            pending.push_front(part);
        }
        Ok(())
    };

    // Directory holding the link, as real path components under `root`.
    let mut dir: Vec<OsString> = rel_link
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_os_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let link_path = root.join(rel_link);
    let first_target = fs::read_link(&link_path)
        .map_err(|e| format!("Failed reading symlink {}: {e}", link_path.display()))?;
    let mut pending = VecDeque::new();
    push_target(&mut pending, &first_target)?;

    let mut hops = 0_usize;
    while let Some(part) = pending.pop_front() {
        if part == ".." {
            if dir.pop().is_none() {
                return Err(escape_error());
            }
            continue;
        }
        dir.push(part);
        if dir.len() == 1 && is_excluded_top_level_name(&dir[0].to_string_lossy()) {
            return Err(format!(
                "Archive symlink {} resolves into reserved directory {:?}.",
                rel_link.display(),
                dir[0]
            ));
        }
        let cursor: PathBuf = dir.iter().fold(root.to_path_buf(), |acc, c| acc.join(c));
        let Ok(meta) = fs::symlink_metadata(&cursor) else {
            continue;
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        hops += 1;
        if hops > MAX_MATERIALIZED_SYMLINK_HOPS {
            // The kernel gives up (ELOOP) long before this; nothing is reachable through it.
            return Ok(());
        }
        let next = fs::read_link(&cursor)
            .map_err(|e| format!("Failed reading symlink {}: {e}", cursor.display()))?;
        // The hop's target is relative to the directory holding it.
        dir.pop();
        push_target(&mut pending, &next)?;
    }

    // Belt and braces for links whose target exists: the kernel's own resolution must agree.
    if let Ok(resolved) = fs::canonicalize(&link_path) {
        let real_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if !resolved.starts_with(&real_root) {
            return Err(escape_error());
        }
    }
    Ok(())
}

/// Whether a tar entry path names the archive root itself.
///
/// Snapshots written by the pre-migration TS `createTarGz` (`tar -czf <archive> -C <dir> .`)
/// start with a `./` directory entry for the root (`.` from some tar implementations). It has no
/// relative path components, so it is skipped rather than validated; every other entry, including
/// `./..` style traversal, still goes through `validate_contained_relative_path`.
fn is_archive_root_entry(raw: &str) -> bool {
    raw.trim_end_matches('/') == "."
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

/// Copies a directory snapshot into `dest_dir`, leaving directories owner-writable and returning
/// their snapshot modes for the caller to apply (see [`DeferredDirModes`]).
fn copy_snapshot_directory_confined(
    snapshot_dir: &Path,
    dest_dir: &Path,
) -> Result<DeferredDirModes, String> {
    fs::create_dir_all(dest_dir).map_err(|e| {
        format!(
            "Failed creating directory snapshot destination {}: {e}",
            dest_dir.display()
        )
    })?;
    let canon_dest = canonicalize_sync(dest_dir);
    let mut total_entries = 0_usize;
    let mut total_bytes = 0_u64;
    let mut deferred = DeferredDirModes::new(canon_dest.clone());

    fn copy_walk(
        base: &Path,
        current: &Path,
        canon_dest: &Path,
        is_root: bool,
        total_entries: &mut usize,
        total_bytes: &mut u64,
        deferred: &mut DeferredDirModes,
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
                // Copied before its descendants: keep it writable until the copy finishes.
                let final_mode = entry_mode(&meta);
                apply_unix_mode(&target_path, writable_dir_mode(final_mode));
                deferred.record(&rel_path, final_mode);
                copy_walk(
                    base,
                    &full_path,
                    canon_dest,
                    false,
                    total_entries,
                    total_bytes,
                    deferred,
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
        &mut deferred,
    )?;
    let mut symlinks = Vec::new();
    collect_relative_symlinks(&canon_dest, Path::new(""), &mut symlinks);
    validate_materialized_symlinks(&canon_dest, &symlinks)?;
    Ok(deferred)
}

/// Relative paths of every symlink under `root/rel` (never following symlinks).
fn collect_relative_symlinks(root: &Path, rel: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root.join(rel)) else {
        return;
    };
    for entry in entries.flatten() {
        let child = rel.join(entry.file_name());
        match entry.file_type() {
            Ok(ft) if ft.is_symlink() => out.push(child),
            Ok(ft) if ft.is_dir() => collect_relative_symlinks(root, &child, out),
            _ => {}
        }
    }
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

/// Materializes a snapshot into `dest_dir`. Directory modes are returned rather than applied so
/// the caller can apply them where the tree ends up (see [`DeferredDirModes`]).
fn materialize_snapshot_confined(
    session_dir: &Path,
    snapshot: &BackupSnapshotRef,
    dest_dir: &Path,
) -> Result<DeferredDirModes, String> {
    let path = verify_snapshot_exists_confined(session_dir, snapshot)?;
    match snapshot.kind {
        OriginalSnapshotKind::TarGz => extract_snapshot_tar_gz_deferred(&path, dest_dir),
        OriginalSnapshotKind::Directory => copy_snapshot_directory_confined(&path, dest_dir),
        OriginalSnapshotKind::Pending => {
            Err("Pending backup snapshot cannot be materialized.".to_owned())
        }
    }
}

/// Materializes `snapshot` into a temporary directory inside `session_dir` and returns its file and
/// symlink entries (directories carry no content of their own and are not reported). The
/// temporary directory is always removed.
fn snapshot_delta_entries(
    session_dir: &Path,
    snapshot: &BackupSnapshotRef,
    prefix: &str,
) -> Result<BTreeMap<String, EntrySignature>, String> {
    let dir = session_dir.join(format!("{prefix}{}", Uuid::new_v4().simple()));
    let result = (|| -> Result<BTreeMap<String, EntrySignature>, String> {
        materialize_snapshot_confined(session_dir, snapshot, &dir)?.apply();
        collect_directory_manifest(&dir)
    })();
    let _ = remove_dir_all_force(&dir);
    Ok(result?
        .into_iter()
        .filter(|(_, entry)| entry.kind != DeltaEntryKind::Directory)
        .collect())
}

/// Compares two saved snapshots: counts cover the full delta, the file preview is capped at
/// [`MAX_DELTA_FILES`], and an entry is modified when its kind or content digest changed.
fn summarize_snapshot_delta(
    session_dir: &Path,
    baseline: &BackupSnapshotRef,
    current: &BackupSnapshotRef,
) -> Result<
    (
        WorkspaceBackupDeltaCounts,
        Vec<WorkspaceBackupDeltaFile>,
        bool,
    ),
    String,
> {
    let baseline_entries = snapshot_delta_entries(session_dir, baseline, ".delta-baseline-")?;
    let current_entries = snapshot_delta_entries(session_dir, current, ".delta-current-")?;

    let mut all_paths = BTreeSet::new();
    all_paths.extend(baseline_entries.keys().cloned());
    all_paths.extend(current_entries.keys().cloned());

    let mut counts = WorkspaceBackupDeltaCounts {
        added: 0,
        modified: 0,
        deleted: 0,
    };
    let mut files = Vec::new();
    for path in all_paths {
        let (change, kind) = match (baseline_entries.get(&path), current_entries.get(&path)) {
            (None, Some(after)) => {
                counts.added += 1;
                (DeltaChangeKind::Added, after.kind)
            }
            (Some(before), None) => {
                counts.deleted += 1;
                (DeltaChangeKind::Deleted, before.kind)
            }
            (Some(before), Some(after))
                if before.kind != after.kind || before.digest != after.digest =>
            {
                counts.modified += 1;
                (DeltaChangeKind::Modified, after.kind)
            }
            _ => continue,
        };
        if files.len() < MAX_DELTA_FILES {
            files.push(WorkspaceBackupDeltaFile { path, change, kind });
        }
    }

    let total_changes = counts.added + counts.modified + counts.deleted;
    let truncated = total_changes > files.len();
    Ok((counts, files, truncated))
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
///
/// If publishing the staged snapshot fails, the original entries are moved back. When any
/// original cannot be moved back, the rollback directory (which still holds it) is kept and its
/// path is reported in the error so the user can recover by hand.
///
/// The staged snapshot normally lives under the session backup directory, which may be on a
/// different filesystem than the workspace (e.g. a workspace on an external drive with backups in
/// the home directory). Staged entries are therefore renamed into place when possible and copied
/// (see [`place_staged_entry`]) when the rename fails with `EXDEV`. The originals always move
/// into a rollback directory inside the workspace itself, so rollback stays same-filesystem.
pub fn replace_directory_contents(
    working_directory: &Path,
    staged_snapshot_dir: &Path,
) -> Result<(), String> {
    replace_directory_contents_with(working_directory, staged_snapshot_dir, |src, dst| {
        place_staged_entry(src, dst, |from, to| fs::rename(from, to))
    })
}

/// Moves one staged entry to `dst` via `rename`, falling back to a copy that does not follow
/// symlinks when the rename crosses filesystems. `rename` is injectable so tests can simulate
/// `EXDEV` without a second mount.
///
/// A failed copy may leave a partial `dst`; the caller records `dst` as placed before calling
/// this so rollback removes it.
fn place_staged_entry<R>(src: &Path, dst: &Path, rename: R) -> std::io::Result<()>
where
    R: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    match rename(src, dst) {
        Err(err) if is_cross_device_error(&err) => copy_entry_no_follow(src, dst),
        other => other,
    }
}

fn is_cross_device_error(err: &std::io::Error) -> bool {
    // std maps `EXDEV` (Unix) and `ERROR_NOT_SAME_DEVICE` (Windows) to `CrossesDevices`.
    err.kind() == std::io::ErrorKind::CrossesDevices
}

/// Recursively copies `src` to a new `dst` without following symlinks on either side.
///
/// Symlinks are recreated verbatim (they were validated when the snapshot was staged), files and
/// directories are created exclusively (`create_new` / `create_dir`, so a pre-existing `dst` or a
/// symlink planted at `dst` is never written through), and permission bits are carried over on a
/// best-effort basis (filesystems such as exFAT reject `chmod`). Directory modes are applied after
/// their children so read-only directories can still be populated.
fn copy_entry_no_follow(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        let link_target = fs::read_link(src)?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&link_target, dst)
        }
        #[cfg(windows)]
        {
            if fs::metadata(src).is_ok_and(|m| m.is_dir()) {
                std::os::windows::fs::symlink_dir(&link_target, dst)
            } else {
                std::os::windows::fs::symlink_file(&link_target, dst)
            }
        }
    } else if ft.is_dir() {
        fs::create_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_entry_no_follow(&entry.path(), &dst.join(entry.file_name()))?;
        }
        apply_unix_mode(dst, entry_mode(&meta));
        Ok(())
    } else if ft.is_file() {
        let mut input = File::open(src)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dst)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        let _ = output.set_permissions(meta.permissions());
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "Unsupported staged entry type at {}",
            src.display()
        )))
    }
}

/// `replace_directory_contents` with an injectable operation for placing each staged entry
/// (tests use it to fail mid-publish).
fn replace_directory_contents_with<P>(
    working_directory: &Path,
    staged_snapshot_dir: &Path,
    mut place_entry: P,
) -> Result<(), String>
where
    P: FnMut(&Path, &Path) -> std::io::Result<()>,
{
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

    let mut moved_to_rollback: Vec<String> = Vec::new();
    // Original modes of read-only directories made owner-writable so they could be moved into
    // the rollback directory; reapplied if they are moved back.
    let mut relaxed_original_modes: BTreeMap<String, u32> = BTreeMap::new();
    let mut placed_entries: Vec<String> = Vec::new();

    let mut publish = || -> Result<(), String> {
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

        for name in &existing_entries {
            let relaxed_mode = move_entry_to_new_parent(
                &working_directory.join(name),
                &rollback_files_dir.join(name),
            )
            .map_err(|err| format!("Failed staging workspace entry {name:?} for restore: {err}"))?;
            moved_to_rollback.push(name.clone());
            if let Some(mode) = relaxed_mode {
                relaxed_original_modes.insert(name.clone(), mode);
            }
        }

        write_phase("restoring")?;

        let staged_entries: Vec<String> = fs::read_dir(staged_snapshot_dir)
            .map_err(|e| format!("Failed listing staged snapshot: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| !is_excluded_top_level_name(name))
            .collect();

        for name in &staged_entries {
            // Recorded before placing so rollback also removes a partially copied entry.
            placed_entries.push(name.clone());
            place_entry(
                &staged_snapshot_dir.join(name),
                &working_directory.join(name),
            )
            .map_err(|err| format!("Failed placing restored entry {name:?}: {err}"))?;
        }

        write_phase("complete")
    };

    let Err(error) = publish() else {
        let _ = remove_dir_all_force(&rollback_dir);
        return Ok(());
    };

    let rollback = roll_back_replaced_entries(
        working_directory,
        &rollback_files_dir,
        &moved_to_rollback,
        &relaxed_original_modes,
        &placed_entries,
    );
    if rollback.unrestored_originals.is_empty() {
        let _ = remove_dir_all_force(&rollback_dir);
        if rollback.leftover_restored.is_empty() {
            return Err(error);
        }
        return Err(format!(
            "{error}. Rollback restored every original entry but could not remove some restored entries: {}",
            rollback.leftover_restored.join("; ")
        ));
    }

    // Some originals are still only in the rollback directory: keep it (and mark it) so they can
    // be recovered; `workspace_recovery_failure_reason` blocks further restores until then.
    let _ = write_phase("rollback-failed");
    let mut details = rollback.unrestored_originals;
    details.extend(rollback.leftover_restored);
    Err(format!(
        "{error}. Restore rollback was incomplete; recover previous files from {}: {}",
        rollback_files_dir.display(),
        details.join("; ")
    ))
}

/// Renames a top-level workspace entry into the rollback directory.
///
/// Moving a directory to a different parent rewrites its `..` entry, which requires write
/// permission on the directory itself, so a read-only directory (e.g. one an earlier restore
/// recreated with mode `0555`) cannot be moved by a non-root user. When the rename is refused for
/// a real directory lacking owner write permission, it is made owner-writable and the rename is
/// retried; the original mode is returned so a rollback can reapply it. On failure the original
/// mode is reapplied before returning the error.
fn move_entry_to_new_parent(src: &Path, dst: &Path) -> std::io::Result<Option<u32>> {
    let err = match fs::rename(src, dst) {
        Ok(()) => return Ok(None),
        Err(err) => err,
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if err.kind() == std::io::ErrorKind::PermissionDenied
            && let Ok(meta) = fs::symlink_metadata(src)
            && meta.file_type().is_dir()
        {
            let mode = meta.permissions().mode() & 0o7777;
            if mode & 0o200 == 0 {
                set_dir_mode_no_follow(src, mode | 0o200);
                return match fs::rename(src, dst) {
                    Ok(()) => Ok(Some(mode)),
                    Err(retry_err) => {
                        set_dir_mode_no_follow(src, mode);
                        Err(retry_err)
                    }
                };
            }
        }
    }
    Err(err)
}

struct RestoreRollbackOutcome {
    /// Original entries that could not be moved back out of the rollback directory.
    unrestored_originals: Vec<String>,
    /// Restored entries that could not be removed from the workspace.
    leftover_restored: Vec<String>,
}

fn roll_back_replaced_entries(
    working_directory: &Path,
    rollback_files_dir: &Path,
    moved_to_rollback: &[String],
    relaxed_original_modes: &BTreeMap<String, u32>,
    placed_entries: &[String],
) -> RestoreRollbackOutcome {
    let mut leftover_restored = Vec::new();
    for placed in placed_entries.iter().rev() {
        let target = working_directory.join(placed);
        let removed = if target.is_dir() && !target.is_symlink() {
            remove_dir_all_force(&target)
        } else {
            fs::remove_file(&target)
        };
        if let Err(err) = removed
            && err.kind() != std::io::ErrorKind::NotFound
        {
            leftover_restored.push(format!("failed removing restored entry {placed:?}: {err}"));
        }
    }
    let mut unrestored_originals = Vec::new();
    for prev in moved_to_rollback.iter().rev() {
        let original = working_directory.join(prev);
        if let Err(err) = fs::rename(rollback_files_dir.join(prev), &original) {
            unrestored_originals.push(format!("failed moving back original entry {prev:?}: {err}"));
        } else if let Some(mode) = relaxed_original_modes.get(prev) {
            set_dir_mode_no_follow(&original, *mode);
        }
    }
    RestoreRollbackOutcome {
        unrestored_originals,
        leftover_restored,
    }
}

#[cfg(test)]
#[path = "backups_rollback_tests.rs"]
mod rollback_tests;

#[cfg(test)]
#[path = "backups_cross_device_tests.rs"]
mod cross_device_tests;

#[cfg(all(test, unix))]
#[path = "backups_readonly_dir_tests.rs"]
mod readonly_dir_tests;

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

    /// Runs `f` holding the session-backup lock and then the workspace lock, re-checking for an
    /// unfinished restore recovery directory once both are held.
    ///
    /// Lock order (matches the TS `SessionBackupManager.withLatestMetadata` and
    /// `withBackupPathLock`): session directory first, workspace second, never the reverse. Every
    /// operation that reads or replaces the workspace tree (initial snapshot, checkpoint capture,
    /// restore) holds the workspace lock, and no operation acquires a session lock while holding a
    /// workspace lock, so sessions that share a workspace serialize without deadlocking.
    fn run_session_then_workspace_locked<R, F>(
        &self,
        session_dir: &Path,
        canon_wd: &Path,
        f: F,
    ) -> Result<R, String>
    where
        F: FnOnce() -> Result<R, String>,
    {
        self.run_locked(session_dir, || {
            self.run_locked(canon_wd, || {
                if let Some(reason) = workspace_recovery_failure_reason(canon_wd) {
                    return Err(reason);
                }
                f()
            })
        })
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
        let canon_wd = canonicalize_sync(working_directory);
        let session_dir = self.select_session_dir_for_workspace(session_id, &canon_wd)?;

        // Session lock, then workspace lock (see `run_session_then_workspace_locked`): the original
        // snapshot must not observe a tree another session is mid-way through restoring.
        self.run_session_then_workspace_locked(&session_dir, &canon_wd, || {
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
            let meta = Self::read_metadata(&session_dir)?;
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

            // The workspace lock is held (after the session lock) from the recovery check through
            // the fingerprint, the snapshot and the metadata write, so a concurrent restore from
            // another session sharing this workspace can never be observed half-applied.
            self.run_locked(&canon_wd, || {
                if let Some(reason) = workspace_recovery_failure_reason(&canon_wd) {
                    return Err(reason);
                }
                Self::capture_checkpoint_locked(
                    &session_dir,
                    &canon_wd,
                    meta,
                    trigger,
                    title,
                    provider,
                    model,
                )
            })
        })
    }

    /// Fingerprints and (when changed) snapshots the workspace into a new checkpoint record.
    /// Callers must hold the session lock and then the workspace lock.
    fn capture_checkpoint_locked(
        session_dir: &Path,
        canon_wd: &Path,
        mut meta: StoredSessionBackupMetadata,
        trigger: BackupTrigger,
        title: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<Option<SessionBackupPublicState>, String> {
        let fp = compute_workspace_fingerprint(canon_wd)?;
        let idx = meta.checkpoints.iter().map(|c| c.index).max().unwrap_or(0) + 1;
        let cp_id = format!("cp-{idx:04}");
        let now = now_iso();

        let prev_record = meta.checkpoints.last().cloned();
        let (changed, patch_bytes, snapshot) =
            if let Some(prev) = prev_record.filter(|p| p.fingerprint == fp) {
                (false, 0_u64, prev.snapshot)
            } else {
                let rel = format!("checkpoints/{cp_id}.tar.gz");
                let bytes = write_snapshot_tar_gz(canon_wd, &session_dir.join(&rel))?;
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
        Self::write_metadata(session_dir, &meta)?;
        Ok(Some(Self::to_public_state(true, session_dir, &meta)))
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
        // Under the workspace lock (TS `listWorkspaceBackups`), so the `.restore-rollback-*`
        // directory of a restore in progress is never reported as a recovery failure.
        self.run_locked(&canon_wd, || {
            self.read_workspace_backups_locked(&canon_wd, session_id_for_event, &mut lookup_session)
        })
    }

    fn read_workspace_backups_locked<F>(
        &self,
        canon_wd: &Path,
        session_id_for_event: Option<String>,
        lookup_session: &mut F,
    ) -> Result<WorkspaceBackupsEvent, String>
    where
        F: FnMut(&str) -> SessionLookupMetadata,
    {
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

    /// Computes the added/modified/deleted delta a checkpoint introduced: the preceding checkpoint
    /// (or the original snapshot for the first checkpoint) against the selected checkpoint. Both
    /// sides are saved snapshots, so the live workspace never affects the preview.
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
        // The session lock covers the metadata read and the `.delta-*` staging directories created
        // inside `session_dir`, so `delete_entry` / `delete_checkpoint` cannot remove the backup (or
        // a snapshot) mid-preview. Only the session lock is taken: the preview never reads the
        // live workspace.
        self.run_locked(&session_dir, || {
            Self::read_workspace_backup_delta_locked(
                &session_dir,
                &wd_str,
                target_session_id,
                checkpoint_id,
                session_id_for_event,
            )
        })
    }

    fn read_workspace_backup_delta_locked(
        session_dir: &Path,
        wd_str: &str,
        target_session_id: &str,
        checkpoint_id: &str,
        session_id_for_event: Option<String>,
    ) -> Result<WorkspaceBackupDeltaEvent, String> {
        let meta = Self::read_metadata(session_dir)?;
        if !same_workspace_path(&meta.working_directory, wd_str) {
            return Err("Backup session does not belong to this workspace.".to_owned());
        }

        let checkpoint_index = meta
            .checkpoints
            .iter()
            .position(|checkpoint| checkpoint.id == checkpoint_id)
            .ok_or_else(|| format!("Unknown checkpoint id: {checkpoint_id}"))?;
        let checkpoint = &meta.checkpoints[checkpoint_index];
        let baseline_checkpoint = checkpoint_index
            .checked_sub(1)
            .map(|index| &meta.checkpoints[index]);
        let baseline_snapshot =
            baseline_checkpoint.map_or(&meta.original_snapshot, |cp| &cp.snapshot);
        let baseline_label =
            baseline_checkpoint.map_or_else(|| "Original snapshot".to_owned(), |cp| cp.id.clone());

        let (counts, files, truncated) = if checkpoint.snapshot.kind == baseline_snapshot.kind
            && checkpoint.snapshot.path == baseline_snapshot.path
        {
            (
                WorkspaceBackupDeltaCounts {
                    added: 0,
                    modified: 0,
                    deleted: 0,
                },
                Vec::new(),
                false,
            )
        } else {
            summarize_snapshot_delta(session_dir, baseline_snapshot, &checkpoint.snapshot)?
        };

        Ok(WorkspaceBackupDeltaEvent {
            event_type: "workspace_backup_delta".to_owned(),
            session_id: session_id_for_event,
            target_session_id: target_session_id.to_owned(),
            checkpoint_id: checkpoint_id.to_owned(),
            baseline_label,
            current_label: checkpoint.id.clone(),
            counts,
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

        // Create safety manual checkpoint before overwriting workspace contents. It checks for an
        // unfinished restore recovery directory under the workspace lock, so a workspace needing
        // recovery is refused here.
        let _ = self.create_checkpoint(
            target_session_id,
            &canon_wd,
            BackupTrigger::Manual,
            None,
            None,
            None,
        )?;

        // The recovery check is repeated once both locks are held: another session sharing this
        // workspace may have stranded a recovery directory after the safety checkpoint.
        let state = self.run_session_then_workspace_locked(&session_dir, &canon_wd, || {
            let stage_parent =
                session_dir.join(format!(".stage-restore-{}", Uuid::new_v4().simple()));
            let res = (|| -> Result<SessionBackupPublicState, String> {
                // The staged tree stays writable so its entries can be moved into the
                // workspace; snapshot directory modes are applied once they are in place.
                let deferred_modes =
                    materialize_snapshot_confined(&session_dir, &snapshot_ref, &stage_parent)?;
                replace_directory_contents(&canon_wd, &stage_parent)?;
                deferred_modes.apply_to_workspace(&canon_wd);
                let mut meta = Self::read_metadata(&session_dir)?;
                meta.updated_at = Some(now_iso());
                Self::write_metadata(&session_dir, &meta)?;
                Ok(Self::to_public_state(true, &session_dir, &meta))
            })();
            let _ = remove_dir_all_force(&stage_parent);
            res
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
                        let _ = remove_dir_all_force(&snap_path);
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

        // Session lock, then workspace lock, with the recovery guard (TS `deleteEntry`): a
        // backup cannot be deleted while an interrupted restore still needs recovering.
        self.run_session_then_workspace_locked(&session_dir, &canon_wd, || {
            if !session_dir.join("metadata.json").is_file() {
                return Err(format!(
                    "Backup entry not found for session {target_session_id}."
                ));
            }
            remove_dir_all_force(&session_dir).map_err(|e| {
                format!(
                    "Failed removing backup directory {}: {e}",
                    session_dir.display()
                )
            })
        })?;

        self.read_workspace_backups(&canon_wd, session_id_for_event, lookup_session)
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
