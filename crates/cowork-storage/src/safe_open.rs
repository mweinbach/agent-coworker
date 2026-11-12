//! Symlink-safe file opening shared by every crate that reads paths an earlier check accepted
//! (`cowork-tools` file tools, the server's `/cowork/fs/*` routes, legacy memory import).
//!
//! A path validated by an earlier check can be swapped for a symlink (or a FIFO) before it is
//! opened. [`open_no_follow`] refuses to follow a final-component link on every platform; callers
//! then `fstat` the handle (rejecting anything that is not a regular file) and finally call
//! [`restore_blocking_mode`].

use std::fs::{self, File, Metadata};
use std::path::Path;

/// Opens `path` read-only without following a final-component symlink.
///
/// - **Unix**: `O_NOFOLLOW` (a symlink fails with `ELOOP`; `EMLINK` on FreeBSD) plus
///   `O_NONBLOCK`, so a FIFO swapped in after the check cannot block the open. Call
///   [`restore_blocking_mode`] once the handle is verified.
/// - **Windows**: `FILE_FLAG_OPEN_REPARSE_POINT` opens a symlink/junction itself instead of its
///   target; its metadata is then not a regular file and callers refuse it.
/// - **Elsewhere**: an `lstat` symlink check before the open (best effort).
#[cfg(unix)]
pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

/// Opens `path` read-only without following a final-component symlink (see the Unix variant).
#[cfg(windows)]
pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

/// Opens `path` read-only without following a final-component symlink (see the Unix variant).
#[cfg(not(any(unix, windows)))]
pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::Error::other("symbolic link"));
    }
    File::open(path)
}

/// Clears the `O_NONBLOCK` flag [`open_no_follow`] set on Unix. No-op elsewhere.
#[cfg(unix)]
pub fn restore_blocking_mode(file: &File) {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    // SAFETY: `fd` is a valid open descriptor owned by `file` for the duration of these calls.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 && flags & libc::O_NONBLOCK != 0 {
            libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
    }
}

/// Clears the `O_NONBLOCK` flag [`open_no_follow`] set on Unix. No-op elsewhere.
#[cfg(not(unix))]
pub fn restore_blocking_mode(_file: &File) {}

/// Whether a path's `lstat` metadata and an opened handle's `fstat` metadata describe the same
/// file, detecting a swap between the check and the open.
///
/// Unix compares device and inode. Elsewhere stable Rust exposes no file ID for path-based
/// metadata, so this compares the creation time when both sides report one (a swapped-in file
/// almost always has a different one); callers must still re-validate the opened handle's real
/// path, which is what bounds the handle on Windows.
#[cfg(unix)]
pub fn same_file_identity(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// See the Unix variant.
#[cfg(not(unix))]
pub fn same_file_identity(a: &Metadata, b: &Metadata) -> bool {
    match (a.created(), b.created()) {
        (Ok(left), Ok(right)) => left == right,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_regular_files_and_matches_their_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "hello").unwrap();
        let lstat = fs::symlink_metadata(&path).unwrap();
        let file = open_no_follow(&path).unwrap();
        restore_blocking_mode(&file);
        let fstat = file.metadata().unwrap();
        assert!(fstat.is_file());
        assert!(same_file_identity(&lstat, &fstat));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_final_component_symlink_and_detects_a_swap() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        let other = dir.path().join("other.txt");
        fs::write(&target, "t").unwrap();
        fs::write(&other, "o").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = open_no_follow(&link).unwrap_err();
        assert!(
            matches!(err.raw_os_error(), Some(code) if code == libc::ELOOP || code == libc::EMLINK)
        );

        let a = fs::symlink_metadata(&target).unwrap();
        let b = open_no_follow(&other).unwrap().metadata().unwrap();
        assert!(!same_file_identity(&a, &b));
    }
}
