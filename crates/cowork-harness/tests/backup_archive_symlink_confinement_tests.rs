//! Backup archive extraction never writes through a symlink and never leaves a symlink that
//! resolves outside the extraction root, even when each link target looks confined on its own:
//!
//! - a link chain (`up -> ../../../..` then `escape -> d1/d2/d3/d4/up/../../../../victim`) whose
//!   lexical check passes while the kernel resolves through `up`;
//! - links created before the hop they traverse (`esc -> a/..`, then `a -> .`);
//! - a later regular file or directory entry that reuses a symlink's path.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_harness::backups::extract_snapshot_tar_gz_confined;
use flate2::Compression;
use flate2::write::GzEncoder;
use tempfile::TempDir;

enum Entry<'a> {
    Dir(&'a str, u32),
    File(&'a str, u32, &'a [u8]),
    Symlink(&'a str, &'a str),
}

/// Writes a `.tar.gz` holding `entries` in order, names and link targets stored verbatim.
fn write_tar_gz(archive: &Path, entries: &[Entry<'_>]) {
    let file = fs::File::create(archive).unwrap();
    let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
    for entry in entries {
        let mut header = tar::Header::new_gnu();
        header.set_mtime(1_700_000_000);
        let (name, data): (&str, &[u8]) = match entry {
            Entry::Dir(name, mode) => {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_mode(*mode);
                (name, &[])
            }
            Entry::File(name, mode, data) => {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_mode(*mode);
                (name, data)
            }
            Entry::Symlink(name, target) => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_mode(0o777);
                let gnu = header.as_gnu_mut().unwrap();
                gnu.linkname[..target.len()].copy_from_slice(target.as_bytes());
                (name, &[])
            }
        };
        header.set_size(data.len() as u64);
        header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        builder.append(&header, data).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
}

struct Fixture {
    _guard: TempDir,
    /// `<tmp>/h1/h2/h3/h4`: four levels between the extraction root and `top`.
    top: PathBuf,
    dest: PathBuf,
    archive: PathBuf,
}

fn fixture(prefix: &str) -> Fixture {
    let guard = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let base = canonicalize_sync(guard.path());
    let top = base.join("top");
    let dest = top.join("h1/h2/h3/dest");
    fs::create_dir_all(&dest).unwrap();
    Fixture {
        _guard: guard,
        archive: base.join("snapshot.tar.gz"),
        top,
        dest,
    }
}

fn chain_entries<'a>(tail: &'a [Entry<'a>]) -> Vec<Entry<'a>> {
    let mut entries = vec![
        Entry::Dir("d1", 0o755),
        Entry::Dir("d1/d2", 0o755),
        Entry::Dir("d1/d2/d3", 0o755),
        Entry::Dir("d1/d2/d3/d4", 0o755),
        // Lexically confined (depth 4 -> 0): resolves to the extraction root itself.
        Entry::Symlink("d1/d2/d3/d4/up", "../../../.."),
        // Lexically confined (pushes five components before popping four), but the kernel
        // resolves `up` to the root first, so this lands four levels above it: `top/victim`.
        Entry::Symlink("escape", "d1/d2/d3/d4/up/../../../../victim"),
    ];
    for entry in tail {
        entries.push(match entry {
            Entry::Dir(n, m) => Entry::Dir(n, *m),
            Entry::File(n, m, d) => Entry::File(n, *m, d),
            Entry::Symlink(n, t) => Entry::Symlink(n, t),
        });
    }
    entries
}

#[test]
fn file_entry_reusing_a_chained_escape_symlink_never_writes_outside_the_destination() {
    let fx = fixture("bk-chain-file-");
    write_tar_gz(
        &fx.archive,
        &chain_entries(&[Entry::File("escape", 0o644, b"pwned\n")]),
    );

    let result = extract_snapshot_tar_gz_confined(&fx.archive, &fx.dest);

    assert!(
        !fx.top.join("victim").exists(),
        "extraction wrote through the escaping symlink (result: {result:?})"
    );
    if result.is_ok() {
        // The later file entry replaced the link instead of following it.
        let meta = fs::symlink_metadata(fx.dest.join("escape")).unwrap();
        assert!(meta.file_type().is_file());
        assert_eq!(fs::read(fx.dest.join("escape")).unwrap(), b"pwned\n");
    }
}

#[test]
fn chained_symlink_escape_is_rejected_after_extraction() {
    let fx = fixture("bk-chain-link-");
    fs::write(fx.top.join("victim"), "host file\n").unwrap();
    write_tar_gz(&fx.archive, &chain_entries(&[]));

    let err = extract_snapshot_tar_gz_confined(&fx.archive, &fx.dest)
        .expect_err("a symlink resolving outside the destination must be rejected");
    assert!(err.contains("escape"), "{err}");
    assert!(
        fs::symlink_metadata(fx.dest.join("escape")).is_err(),
        "the escaping link must not be left in the destination"
    );
    assert_eq!(
        fs::read_to_string(fx.top.join("victim")).unwrap(),
        "host file\n"
    );
}

#[test]
fn link_created_before_the_hop_it_traverses_is_rejected() {
    let fx = fixture("bk-late-hop-");
    write_tar_gz(
        &fx.archive,
        &[
            // `a` does not exist yet, so this resolves lexically to the root ...
            Entry::Symlink("esc", "a/.."),
            // ... until `a` becomes a link to the root, making `esc` its parent.
            Entry::Symlink("a", "."),
        ],
    );

    let err = extract_snapshot_tar_gz_confined(&fx.archive, &fx.dest)
        .expect_err("esc resolves to the destination's parent");
    assert!(err.contains("esc"), "{err}");
}

#[test]
fn file_entry_reusing_an_in_tree_symlink_replaces_the_link() {
    let fx = fixture("bk-leaf-file-");
    write_tar_gz(
        &fx.archive,
        &[
            Entry::File("inner.txt", 0o644, b"keep\n"),
            Entry::Symlink("link", "inner.txt"),
            Entry::File("link", 0o600, b"replacement\n"),
        ],
    );

    extract_snapshot_tar_gz_confined(&fx.archive, &fx.dest).unwrap();

    assert_eq!(fs::read(fx.dest.join("inner.txt")).unwrap(), b"keep\n");
    let link_meta = fs::symlink_metadata(fx.dest.join("link")).unwrap();
    assert!(link_meta.file_type().is_file(), "link must be replaced");
    assert_eq!(link_meta.permissions().mode() & 0o7777, 0o600);
    assert_eq!(fs::read(fx.dest.join("link")).unwrap(), b"replacement\n");
    let inner_mode = fs::metadata(fx.dest.join("inner.txt"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(inner_mode & 0o7777, 0o644, "chmod must not follow the link");
}

#[test]
fn directory_entry_reusing_a_symlink_replaces_the_link() {
    let fx = fixture("bk-leaf-dir-");
    write_tar_gz(
        &fx.archive,
        &[
            Entry::Dir("real", 0o755),
            Entry::File("real/data.txt", 0o644, b"data\n"),
            Entry::Symlink("alias", "real"),
            Entry::Dir("alias", 0o700),
            Entry::File("alias/own.txt", 0o644, b"own\n"),
        ],
    );

    extract_snapshot_tar_gz_confined(&fx.archive, &fx.dest).unwrap();

    let alias = fs::symlink_metadata(fx.dest.join("alias")).unwrap();
    assert!(alias.file_type().is_dir(), "alias must be a real directory");
    assert_eq!(alias.permissions().mode() & 0o7777, 0o700);
    assert!(!fx.dest.join("real/own.txt").exists());
    assert_eq!(
        fs::metadata(fx.dest.join("real"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o755
    );
}

#[test]
fn confined_symlinks_and_chains_still_extract() {
    let fx = fixture("bk-legit-links-");
    write_tar_gz(
        &fx.archive,
        &[
            Entry::Dir("build", 0o755),
            Entry::Dir("build/lib", 0o755),
            Entry::File("build/lib/mod.js", 0o644, b"module\n"),
            Entry::Dir("node_modules", 0o755),
            Entry::Dir("node_modules/.bin", 0o755),
            Entry::Symlink("node_modules/.bin/tool", "../../build/lib/mod.js"),
            Entry::Symlink("lib", "build/lib"),
            // Traverses the `lib` link and stays inside.
            Entry::Symlink("entry.js", "lib/mod.js"),
            Entry::Symlink("lib-parent", "lib/.."),
            Entry::Symlink("self", "."),
            Entry::Symlink("dangling", "missing/target"),
        ],
    );

    extract_snapshot_tar_gz_confined(&fx.archive, &fx.dest).unwrap();

    assert_eq!(fs::read(fx.dest.join("entry.js")).unwrap(), b"module\n");
    assert_eq!(
        fs::read(fx.dest.join("node_modules/.bin/tool")).unwrap(),
        b"module\n"
    );
    assert_eq!(
        fs::read_link(fx.dest.join("lib-parent")).unwrap(),
        PathBuf::from("lib/..")
    );
    assert_eq!(
        fs::read_link(fx.dest.join("dangling")).unwrap(),
        PathBuf::from("missing/target")
    );
}
