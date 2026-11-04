//! Renames that never replace an existing destination, for `/cowork/fs/rename` and
//! `/cowork/fs/trash` (`renameWithoutReplacing` in `src/server/webDesktopRoutes.ts`).
//!
//! `std::fs::rename` silently replaces an existing destination on Unix (and on Windows), so a
//! destination check followed by a rename lets two concurrent requests both pass the check and the
//! second one overwrite the first entry. Two layers close that race:
//!
//! 1. A process-wide lock keyed by destination (parent directory plus lowercased name, like the TS
//!    `pendingRenames` map) serializes the check and the rename against every other server request
//!    aiming at the same name.
//! 2. Where the OS offers one, the rename itself is an atomic no-replace operation (Linux
//!    `renameat2(RENAME_NOREPLACE)`, macOS `renamex_np(RENAME_EXCL)`, Windows `MoveFileExW`
//!    without `MOVEFILE_REPLACE_EXISTING`), so even a process outside the server cannot have its
//!    entry replaced. Filesystems that reject the flag fall back to a plain rename, which the lock
//!    still keeps race-free within the server.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

type DestinationLocks = Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>;

static PENDING_RENAMES: LazyLock<DestinationLocks> = LazyLock::new(Default::default);

/// Lock key for `destination`: its parent with the lowercased file name, so case variants of one
/// name (which collide on case-insensitive filesystems) share a lock.
fn destination_key(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match destination.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

/// Runs `f` while holding the process-wide lock for `destination`.
fn with_destination_lock<T>(destination: &Path, f: impl FnOnce() -> T) -> T {
    let key = destination_key(destination);
    let entry = Arc::clone(PENDING_RENAMES.lock().entry(key.clone()).or_default());
    let result = {
        let _guard = entry.lock();
        f()
    };
    let mut map = PENDING_RENAMES.lock();
    // Clones are only taken under the map lock, so a count of 2 (the map's and ours) means no
    // other request is waiting on this destination.
    if map.get(&key).is_some_and(|held| Arc::ptr_eq(held, &entry)) && Arc::strong_count(&entry) == 2
    {
        map.remove(&key);
    }
    result
}

/// Whether `dir` contains an entry whose name is byte-for-byte `name`.
fn directory_has_exact_entry(dir: &Path, name: &OsStr) -> io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        if entry?.file_name() == name {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether renaming `source` to an existing `destination` is only a case change of the source
/// itself on a case-insensitive filesystem: the names differ only in case and the directory has
/// no entry spelled exactly like `destination` (on a case-sensitive filesystem `Report.txt` and
/// `report.txt` can both exist, and the latter is a distinct entry).
fn is_case_only_rename(source: &Path, destination: &Path) -> io::Result<bool> {
    let (Some(source_name), Some(destination_name), Some(parent)) = (
        source.file_name(),
        destination.file_name(),
        destination.parent(),
    ) else {
        return Ok(false);
    };
    if !source_name
        .to_string_lossy()
        .eq_ignore_ascii_case(&destination_name.to_string_lossy())
    {
        return Ok(false);
    }
    Ok(!directory_has_exact_entry(parent, destination_name)?)
}

/// Renames `source` to `destination` unless an entry already exists there, in which case it
/// fails with [`io::ErrorKind::AlreadyExists`] and touches nothing. A case-only rename of the
/// source on a case-insensitive filesystem is allowed, and `source == destination` only checks
/// that the source exists. Works for files, directories and symlinks (which are not followed).
/// Blocking.
pub(super) fn rename_without_replacing(source: &Path, destination: &Path) -> io::Result<()> {
    if source == destination {
        return std::fs::symlink_metadata(source).map(|_| ());
    }
    with_destination_lock(destination, || {
        match std::fs::symlink_metadata(destination) {
            Ok(_) => {
                if !is_case_only_rename(source, destination)? {
                    return Err(already_exists());
                }
                // The "existing" destination is the source itself; a no-replace rename would
                // refuse it, and a plain rename only changes the name's case.
                std::fs::rename(source, destination)
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                atomic_rename_no_replace(source, destination)
            }
            Err(err) => Err(err),
        }
    })
}

fn already_exists() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "An entry with that name already exists",
    )
}

#[cfg(unix)]
fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

/// Errors meaning the kernel or filesystem does not support the no-replace flag. A genuine error
/// of the same kind resurfaces from the fallback rename, since the destination was just found
/// absent under the lock.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
fn no_replace_unsupported(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(code) if code == libc::ENOSYS
            || code == libc::EINVAL
            || code == libc::ENOTSUP
            || code == libc::EOPNOTSUPP
            || code == libc::EPERM
    )
}

#[cfg(target_os = "linux")]
fn atomic_rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let from = c_path(source)?;
    let to = c_path(destination)?;
    // Raw syscall rather than the `renameat2` wrapper, which needs glibc 2.28+.
    // SAFETY: both pointers are valid NUL-terminated strings that outlive the call.
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if no_replace_unsupported(&err) {
        std::fs::rename(source, destination)
    } else {
        Err(err)
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn atomic_rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let from = c_path(source)?;
    let to = c_path(destination)?;
    // SAFETY: both pointers are valid NUL-terminated strings that outlive the call.
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if no_replace_unsupported(&err) {
        std::fs::rename(source, destination)
    } else {
        Err(err)
    }
}

#[cfg(windows)]
fn atomic_rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    let from = wide(source);
    let to = wide(destination);
    // No `MOVEFILE_REPLACE_EXISTING`: an existing destination fails with
    // `ERROR_ALREADY_EXISTS`/`ERROR_FILE_EXISTS`, which std maps to `AlreadyExists`.
    // SAFETY: both pointers are valid NUL-terminated UTF-16 strings that outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// No atomic no-replace rename on this platform: the destination lock keeps the check and the
/// rename race-free within the server.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios", windows)))]
fn atomic_rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_existing_destination_and_keeps_both_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let err = rename_without_replacing(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b");
    }

    #[test]
    fn atomic_rename_refuses_existing_destination() {
        // Bypasses the lock and the pre-check, so this exercises the OS-level no-replace path.
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        if cfg!(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "ios",
            windows
        )) {
            match atomic_rename_no_replace(&a, &b) {
                Err(err) => assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{err}"),
                // A filesystem without no-replace support fell back to a plain rename.
                Ok(()) => assert_eq!(std::fs::read_to_string(&b).unwrap(), "a"),
            }
        }
    }

    #[test]
    fn renames_directories_and_releases_locks() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("dir");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("f"), "f").unwrap();
        let moved = tmp.path().join("moved");
        rename_without_replacing(&dir, &moved).unwrap();
        assert_eq!(std::fs::read_to_string(moved.join("f")).unwrap(), "f");
        assert!(
            !PENDING_RENAMES
                .lock()
                .contains_key(&destination_key(&moved))
        );
    }

    #[test]
    fn same_path_only_checks_existence() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        assert_eq!(
            rename_without_replacing(&a, &a).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        std::fs::write(&a, "a").unwrap();
        rename_without_replacing(&a, &a).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a");
    }
}
