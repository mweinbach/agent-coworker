//! Pre-migration (TS) tar snapshots: `createTarGz` ran `tar -czf <archive> -C <dir> .`, so every
//! archive starts with a `./` root directory entry and names the rest `./<path>`. Those backups
//! must stay restorable and delta-inspectable after the in-place upgrade, while traversal entries
//! are still rejected.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use cowork_config::canonicalize_sync;
use cowork_harness::backups::{
    BackupLifecycle, DeltaChangeKind, SessionLookupMetadata, WorkspaceBackupManager,
    extract_snapshot_tar_gz_confined,
};
use flate2::Compression;
use flate2::write::GzEncoder;
use tempfile::TempDir;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let base = if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    };
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(base)
        .expect("create tempdir");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

enum RawEntry<'a> {
    Dir(&'a str, u32),
    File(&'a str, u32, &'a [u8]),
}

/// Writes a `.tar.gz` with entry names stored byte-for-byte (the `tar` crate's path setters
/// normalize away the leading `./` that GNU/BSD tar emit).
fn write_raw_tar_gz(archive: &Path, entries: &[RawEntry<'_>]) {
    let file = fs::File::create(archive).unwrap();
    let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
    for entry in entries {
        let (name, mode, entry_type, data): (&str, u32, tar::EntryType, &[u8]) = match entry {
            RawEntry::Dir(name, mode) => (*name, *mode, tar::EntryType::Directory, &[]),
            RawEntry::File(name, mode, data) => (*name, *mode, tar::EntryType::Regular, *data),
        };
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(entry_type);
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_mtime(1_700_000_000);
        header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        builder.append(&header, data).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
}

/// The listing `tar -czf <archive> -C <dir> .` (GNU tar 1.35) produces for a workspace holding
/// `notes.txt` and `sub/inner.txt`.
fn write_legacy_fixture(archive: &Path) {
    write_raw_tar_gz(
        archive,
        &[
            RawEntry::Dir("./", 0o755),
            RawEntry::Dir("./sub/", 0o755),
            RawEntry::File("./sub/inner.txt", 0o644, b"legacy inner\n"),
            RawEntry::File("./notes.txt", 0o640, b"legacy notes\n"),
        ],
    );
}

fn lookup(_: &str) -> SessionLookupMetadata {
    SessionLookupMetadata {
        lifecycle: BackupLifecycle::Active,
        title: None,
        provider: None,
        model: None,
        busy: false,
    }
}

struct LegacyBackup {
    _guard: TempDir,
    workspace: PathBuf,
    manager: WorkspaceBackupManager,
}

/// Creates a backup entry for `legacy-sess`, then swaps its original snapshot for an archive
/// written by `write_archive` (as if the backup predates the Rust port).
fn legacy_backup(write_archive: impl FnOnce(&Path)) -> LegacyBackup {
    let (guard, base) = canonical_temp_dir("cowork-legacy-tar-");
    let workspace = base.join("workspace");
    fs::create_dir_all(workspace.join(".ModelScratchpad")).unwrap();
    fs::write(workspace.join("notes.txt"), "current notes\n").unwrap();
    fs::write(workspace.join(".ModelScratchpad/scratch.txt"), "keep-me").unwrap();
    let manager = WorkspaceBackupManager::with_fallback_root(
        base.join("home/.cowork"),
        base.join("fallback-backups"),
    );
    let state = manager
        .ensure_initial_backup("legacy-sess", &workspace, None, None, None)
        .expect("initial backup");
    let backup_dir = PathBuf::from(state.backup_directory.expect("backup directory"));
    let original = backup_dir.join("original.tar.gz");
    assert!(original.is_file(), "expected {}", original.display());
    write_archive(&original);
    LegacyBackup {
        _guard: guard,
        workspace,
        manager,
    }
}

fn assert_legacy_contents_restored(workspace: &Path) {
    assert_eq!(
        fs::read_to_string(workspace.join("notes.txt")).unwrap(),
        "legacy notes\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("sub/inner.txt")).unwrap(),
        "legacy inner\n"
    );
    assert!(!workspace.join("added.txt").exists());
    assert_eq!(
        fs::read_to_string(workspace.join(".ModelScratchpad/scratch.txt")).unwrap(),
        "keep-me"
    );
}

#[test]
fn legacy_tar_with_root_dot_entry_is_delta_inspectable_and_restorable() {
    let backup = legacy_backup(write_legacy_fixture);
    let ws = &backup.workspace;
    fs::write(ws.join("added.txt"), "new\n").unwrap();

    let delta = backup
        .manager
        .read_workspace_backup_delta(ws, "legacy-sess", "original", None)
        .expect("delta against legacy tar");
    let change_of = |path: &str| {
        delta
            .files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} missing from delta {:?}", delta.files))
            .change
    };
    assert_eq!(change_of("notes.txt"), DeltaChangeKind::Modified);
    assert_eq!(change_of("added.txt"), DeltaChangeKind::Added);
    assert_eq!(change_of("sub/inner.txt"), DeltaChangeKind::Deleted);
    // The root entry must not surface as a path of its own.
    assert!(
        delta
            .files
            .iter()
            .all(|f| !f.path.is_empty() && f.path != "." && f.path != "./"),
        "{:?}",
        delta.files
    );

    backup
        .manager
        .restore_workspace_backup(ws, "legacy-sess", Some("original"), None, lookup)
        .expect("restore legacy tar");
    assert_legacy_contents_restored(ws);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(ws.join("notes.txt"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o640);
    }
}

/// Same flow with an archive produced exactly like TS `createTarGz` did, when a `tar` binary is
/// available (it is on the Linux and macOS CI images).
#[test]
fn legacy_tar_created_by_system_tar_is_restorable() {
    if Command::new("tar").arg("--version").output().is_err() {
        eprintln!("skipping: no `tar` binary on PATH");
        return;
    }
    let backup = legacy_backup(|archive| {
        let source = archive.with_file_name("legacy-source");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join("notes.txt"), "legacy notes\n").unwrap();
        fs::write(source.join("sub/inner.txt"), "legacy inner\n").unwrap();
        let status = Command::new("tar")
            .arg("-czf")
            .arg(archive)
            .arg("-C")
            .arg(&source)
            .arg(".")
            .status()
            .expect("run tar");
        assert!(status.success(), "tar failed: {status}");
        fs::remove_dir_all(&source).unwrap();
    });
    let ws = &backup.workspace;
    fs::write(ws.join("added.txt"), "new\n").unwrap();

    backup
        .manager
        .read_workspace_backup_delta(ws, "legacy-sess", "original", None)
        .expect("delta against system-tar snapshot");
    backup
        .manager
        .restore_workspace_backup(ws, "legacy-sess", Some("original"), None, lookup)
        .expect("restore system-tar snapshot");
    assert_legacy_contents_restored(ws);
}

#[test]
fn root_entry_variants_are_skipped_but_traversal_is_still_rejected() {
    let (_guard, base) = canonical_temp_dir("cowork-legacy-tar-entries-");

    for root_name in [".", "./", ".//"] {
        let archive = base.join("root-variant.tar.gz");
        write_raw_tar_gz(
            &archive,
            &[
                RawEntry::Dir(root_name, 0o700),
                RawEntry::File("./a.txt", 0o644, b"a"),
            ],
        );
        let dest = base.join(format!("dest-{}", root_name.len()));
        extract_snapshot_tar_gz_confined(&archive, &dest)
            .unwrap_or_else(|e| panic!("root entry {root_name:?} must be accepted: {e}"));
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "a");
    }

    let rejected: [(&str, Vec<RawEntry<'_>>); 4] = [
        (
            "parent traversal after root entry",
            vec![
                RawEntry::Dir("./", 0o755),
                RawEntry::File("./../escaped.txt", 0o644, b"owned"),
            ],
        ),
        (
            "parent directory entry",
            vec![RawEntry::Dir("./", 0o755), RawEntry::Dir("../", 0o755)],
        ),
        (
            "absolute path",
            vec![
                RawEntry::Dir("./", 0o755),
                RawEntry::File("/escaped.txt", 0o644, b"owned"),
            ],
        ),
        (
            "root name used for a regular file",
            vec![RawEntry::File("./", 0o644, b"owned")],
        ),
    ];
    for (label, entries) in rejected {
        let archive = base.join("rejected.tar.gz");
        write_raw_tar_gz(&archive, &entries);
        let dest = base.join("nested/dest");
        let _ = fs::remove_dir_all(&dest);
        fs::create_dir_all(&dest).unwrap();
        assert!(
            extract_snapshot_tar_gz_confined(&archive, &dest).is_err(),
            "{label} must be rejected"
        );
        assert!(!base.join("nested/escaped.txt").exists(), "{label}");
    }
}
