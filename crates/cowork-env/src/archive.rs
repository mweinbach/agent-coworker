use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;

use crate::error::{EnvError, Result};

/// Maximum archive entries allowed before aborting extraction (zip/tar bomb guard).
pub const MAX_ARCHIVE_ENTRY_COUNT: usize = 200_000;

/// Maximum cumulative unpacked bytes allowed across an archive (8 GiB).
pub const MAX_ARCHIVE_UNPACKED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

const MAX_SYMLINK_DEPTH: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    V1Zip,
    V2TarZst,
}

/// Detects whether `path` is a v1 `.zip` archive or a v2 `.tar.zst` pack.
pub fn detect_archive_format(path: &Path) -> Result<ArchiveFormat> {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        return Ok(ArchiveFormat::V2TarZst);
    }
    if lower.ends_with(".zip") {
        return Ok(ArchiveFormat::V1Zip);
    }

    let mut f = File::open(path).map_err(|source| EnvError::IoPath {
        path: path.to_path_buf(),
        source,
    })?;
    let mut magic = [0_u8; 4];
    let n = f.read(&mut magic)?;
    if n >= 4 && magic == [0x28, 0xb5, 0x2f, 0xfd] {
        return Ok(ArchiveFormat::V2TarZst);
    }
    if n >= 4 && magic[0..2] == *b"PK" {
        return Ok(ArchiveFormat::V1Zip);
    }
    Err(EnvError::Archive(format!(
        "Unrecognized runtime archive format for {}",
        path.display()
    )))
}

/// Validates and normalizes a relative POSIX path inside a runtime archive or manifest.
pub fn assert_safe_relative_runtime_path(raw: &str, label: &str) -> Result<String> {
    let trimmed = raw.strip_prefix("./").unwrap_or(raw);
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(EnvError::Archive(format!(
            "Invalid {label}: {raw:?} (empty or NUL)"
        )));
    }
    if trimmed.contains('\\') || trimmed.starts_with('/') {
        return Err(EnvError::Archive(format!(
            "Invalid {label}: {raw:?} (absolute or backslash path)"
        )));
    }
    if trimmed.len() >= 2
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && trimmed.as_bytes()[1] == b':'
    {
        return Err(EnvError::Archive(format!(
            "Invalid {label}: {raw:?} (Windows drive prefix)"
        )));
    }

    let mut clean_segments = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(EnvError::Archive(format!(
                "Unsafe path segment {seg:?} in {label}: {raw:?}"
            )));
        }
        clean_segments.push(seg);
    }
    Ok(clean_segments.join("/"))
}

/// Validates a relative symlink target string before resolving the full graph.
pub fn assert_safe_symlink_target(target: &str) -> Result<()> {
    if target.is_empty() || target.contains('\0') || target.contains('\\') {
        return Err(EnvError::Archive(format!(
            "Unsafe runtime symlink target: {target:?}"
        )));
    }
    if target.starts_with('/')
        || (target.len() >= 2
            && target.as_bytes()[0].is_ascii_alphabetic()
            && target.as_bytes()[1] == b':')
    {
        return Err(EnvError::Archive(format!(
            "Absolute runtime symlink target is forbidden: {target:?}"
        )));
    }
    Ok(())
}

fn posix_dirname(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[..idx],
        None => "",
    }
}

fn resolve_relative_posix(base_dir: &str, rel_target: &str) -> Result<String> {
    let mut stack: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for seg in rel_target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return Err(EnvError::Archive(format!(
                        "Symlink target escapes runtime root: base={base_dir:?} target={rel_target:?}"
                    )));
                }
            }
            other => stack.push(other),
        }
    }
    if stack.is_empty() {
        return Err(EnvError::Archive(format!(
            "Symlink target resolves to empty root: base={base_dir:?} target={rel_target:?}"
        )));
    }
    Ok(stack.join("/"))
}

/// Validates a symlink map `(link_rel_path -> target)` for cycles (`>40` hops) and root escapes.
pub fn validate_symlink_graph(symlinks: &HashMap<String, String>) -> Result<()> {
    let resolve_entry = |start_path: &str| -> Result<()> {
        let mut current = start_path.to_owned();
        let mut hops = 0usize;

        loop {
            let parts: Vec<&str> = current.split('/').collect();
            let mut prefix = String::new();
            let mut redirected: Option<String> = None;

            for (i, part) in parts.iter().enumerate() {
                if i > 0 {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if let Some(link_target) = symlinks.get(&prefix) {
                    hops += 1;
                    if hops > MAX_SYMLINK_DEPTH {
                        return Err(EnvError::Archive(format!(
                            "Runtime symlink cycle or excessive depth at {start_path}"
                        )));
                    }
                    assert_safe_symlink_target(link_target)?;
                    let base = posix_dirname(&prefix);
                    let resolved_prefix = resolve_relative_posix(base, link_target)?;
                    let remainder = &parts[i + 1..];
                    redirected = Some(if remainder.is_empty() {
                        resolved_prefix
                    } else {
                        format!("{resolved_prefix}/{}", remainder.join("/"))
                    });
                    break;
                }
            }

            match redirected {
                Some(next) => current = next,
                None => return Ok(()),
            }
        }
    };

    for link_path in symlinks.keys() {
        resolve_entry(link_path)?;
    }
    Ok(())
}

fn ensure_canonical_inside(root_canonical: &Path, candidate: &Path) -> Result<()> {
    let resolved = canonicalize_sync(candidate);
    if resolved == root_canonical || resolved.starts_with(root_canonical) {
        Ok(())
    } else {
        Err(EnvError::Archive(format!(
            "Extracted path escapes runtime root: {}",
            candidate.display()
        )))
    }
}

fn copy_capped<R: Read, W: io::Write>(
    reader: R,
    writer: &mut W,
    total_written: &mut u64,
    entry_label: &str,
) -> Result<u64> {
    let remaining = MAX_ARCHIVE_UNPACKED_BYTES.saturating_sub(*total_written);
    let mut limited = reader.take(remaining.saturating_add(1));
    let copied = io::copy(&mut limited, writer)?;
    *total_written = total_written.saturating_add(copied);
    if *total_written > MAX_ARCHIVE_UNPACKED_BYTES {
        return Err(EnvError::Archive(format!(
            "Runtime archive exceeds maximum unpacked size ({} bytes) while reading {entry_label}",
            MAX_ARCHIVE_UNPACKED_BYTES
        )));
    }
    Ok(copied)
}

fn set_extracted_file_mode(path: &Path, unix_mode: Option<u32>) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let exec = unix_mode.is_some_and(|m| (m & 0o111) != 0);
        let target_mode = if exec { 0o755 } else { 0o644 };
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(target_mode);
        std::fs::set_permissions(path, perms)?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, unix_mode);
    }
    Ok(())
}

fn create_deferred_symlinks(dest_dir: &Path, symlinks: &HashMap<String, String>) -> Result<()> {
    if symlinks.is_empty() {
        return Ok(());
    }
    validate_symlink_graph(symlinks)?;
    let root_canonical = canonicalize_sync(dest_dir);

    let mut ordered: Vec<(&String, &String)> = symlinks.iter().collect();
    ordered.sort_by(|a, b| a.0.cmp(b.0));

    for (rel_path, target) in ordered {
        let full_path = dest_dir.join(rel_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
            ensure_canonical_inside(&root_canonical, parent)?;
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, &full_path)?;
        }
        #[cfg(windows)]
        {
            let resolved_target = full_path
                .parent()
                .unwrap_or(dest_dir)
                .join(target.replace('/', "\\"));
            if resolved_target.is_dir() {
                std::os::windows::fs::symlink_dir(&resolved_target, &full_path)?;
            } else {
                std::os::windows::fs::symlink_file(&resolved_target, &full_path)?;
            }
        }
        if std::fs::metadata(&full_path).is_ok() {
            ensure_canonical_inside(&root_canonical, &full_path)?;
        }
    }
    Ok(())
}

/// Extracts a v1 `.zip` runtime archive safely into `dest_dir`.
pub fn extract_v1_zip_archive(archive_path: &Path, dest_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dest_dir)?;
    let root_canonical = canonicalize_sync(dest_dir);

    let file = File::open(archive_path).map_err(|source| EnvError::IoPath {
        path: archive_path.to_path_buf(),
        source,
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        EnvError::Archive(format!(
            "Invalid zip archive {}: {e}",
            archive_path.display()
        ))
    })?;

    if archive.len() > MAX_ARCHIVE_ENTRY_COUNT {
        return Err(EnvError::Archive(format!(
            "Runtime zip exceeds max entry count ({} > {})",
            archive.len(),
            MAX_ARCHIVE_ENTRY_COUNT
        )));
    }

    let mut seen_entries: HashSet<String> = HashSet::new();
    let mut deferred_symlinks: HashMap<String, String> = HashMap::new();
    let mut total_unpacked_bytes = 0_u64;

    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| EnvError::Archive(format!("Corrupt zip entry #{idx}: {e}")))?;
        let raw_name = entry
            .name()
            .map_err(|e| EnvError::Archive(format!("Invalid UTF-8 zip entry #{idx}: {e}")))?
            .into_owned();

        let is_dir = entry.is_dir() || raw_name.ends_with('/');
        let trimmed_dir = raw_name.trim_end_matches('/');
        if trimmed_dir.is_empty() {
            continue;
        }
        let rel_path = assert_safe_relative_runtime_path(trimmed_dir, "zip entry")?;
        let dedup_key = if cfg!(windows) {
            rel_path.to_ascii_lowercase()
        } else {
            rel_path.clone()
        };
        if !seen_entries.insert(dedup_key) {
            return Err(EnvError::Archive(format!(
                "Duplicate runtime zip entry: {rel_path}"
            )));
        }

        if is_dir {
            let dir_path = dest_dir.join(&rel_path);
            std::fs::create_dir_all(&dir_path)?;
            ensure_canonical_inside(&root_canonical, &dir_path)?;
            continue;
        }

        let unix_mode = entry.unix_mode();
        let is_symlink =
            entry.is_symlink() || unix_mode.is_some_and(|m| (m & 0o170000) == 0o120000);

        if is_symlink {
            let mut link_bytes = Vec::new();
            copy_capped(
                &mut entry,
                &mut link_bytes,
                &mut total_unpacked_bytes,
                &rel_path,
            )?;
            let target = String::from_utf8(link_bytes).map_err(|_| {
                EnvError::Archive(format!("Non-UTF-8 symlink target at {rel_path}"))
            })?;
            assert_safe_symlink_target(&target)?;
            deferred_symlinks.insert(rel_path, target);
            continue;
        }

        if let Some(m) = unix_mode {
            let ftype = m & 0o170000;
            if ftype != 0 && ftype != 0o100000 {
                return Err(EnvError::Archive(format!(
                    "Unsupported special file mode {m:#o} at {rel_path}"
                )));
            }
        }

        let out_path: PathBuf = dest_dir.join(&rel_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
            ensure_canonical_inside(&root_canonical, parent)?;
        }
        let mut out_file = File::create(&out_path)?;
        copy_capped(
            &mut entry,
            &mut out_file,
            &mut total_unpacked_bytes,
            &rel_path,
        )?;
        drop(out_file);
        set_extracted_file_mode(&out_path, unix_mode)?;
    }

    create_deferred_symlinks(dest_dir, &deferred_symlinks)?;
    Ok(())
}

/// Extracts a modular v2 `.tar.zst` runtime pack archive safely into `dest_dir`.
pub fn extract_v2_tar_zst_archive(archive_path: &Path, dest_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dest_dir)?;
    let root_canonical = canonicalize_sync(dest_dir);

    let file = File::open(archive_path).map_err(|source| EnvError::IoPath {
        path: archive_path.to_path_buf(),
        source,
    })?;
    let decoder = zstd::stream::read::Decoder::new(file).map_err(|e| {
        EnvError::Archive(format!(
            "Failed to initialize zstd decoder for {}: {e}",
            archive_path.display()
        ))
    })?;
    let mut archive = tar::Archive::new(decoder);
    archive.set_preserve_permissions(false);
    archive.set_unpack_xattrs(false);

    let entries = archive.entries().map_err(|e| {
        EnvError::Archive(format!(
            "Failed to read tar stream in {}: {e}",
            archive_path.display()
        ))
    })?;

    let mut entry_count = 0usize;
    let mut total_unpacked_bytes = 0_u64;
    let mut seen_entries: HashSet<String> = HashSet::new();
    let mut deferred_symlinks: HashMap<String, String> = HashMap::new();

    for item in entries {
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRY_COUNT {
            return Err(EnvError::Archive(format!(
                "Runtime tar.zst exceeds max entry count ({entry_count} > {MAX_ARCHIVE_ENTRY_COUNT})"
            )));
        }

        let mut entry = item.map_err(|e| EnvError::Archive(format!("Corrupt tar entry: {e}")))?;
        let entry_type = entry.header().entry_type();
        if matches!(
            entry_type,
            tar::EntryType::XGlobalHeader | tar::EntryType::XHeader
        ) {
            continue;
        }

        let raw_path = entry
            .path()
            .map_err(|e| EnvError::Archive(format!("Invalid tar entry path: {e}")))?
            .to_string_lossy()
            .into_owned();
        let trimmed = raw_path.trim_end_matches('/');
        if trimmed.is_empty() || trimmed == "." {
            continue;
        }

        let rel_path = assert_safe_relative_runtime_path(trimmed, "tar.zst entry")?;
        let dedup_key = if cfg!(windows) {
            rel_path.to_ascii_lowercase()
        } else {
            rel_path.clone()
        };
        if !seen_entries.insert(dedup_key) {
            return Err(EnvError::Archive(format!(
                "Duplicate runtime tar.zst entry: {rel_path}"
            )));
        }

        match entry_type {
            tar::EntryType::Directory => {
                let dir_path = dest_dir.join(&rel_path);
                std::fs::create_dir_all(&dir_path)?;
                ensure_canonical_inside(&root_canonical, &dir_path)?;
            }
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                let unix_mode = entry.header().mode().ok();
                let out_path = dest_dir.join(&rel_path);
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent)?;
                    ensure_canonical_inside(&root_canonical, parent)?;
                }
                let mut out_file = File::create(&out_path)?;
                copy_capped(
                    &mut entry,
                    &mut out_file,
                    &mut total_unpacked_bytes,
                    &rel_path,
                )?;
                drop(out_file);
                set_extracted_file_mode(&out_path, unix_mode)?;
            }
            tar::EntryType::Symlink => {
                let link_name = entry
                    .link_name()
                    .map_err(|e| EnvError::Archive(format!("Invalid symlink in tar: {e}")))?
                    .ok_or_else(|| {
                        EnvError::Archive(format!("Missing symlink target for {rel_path}"))
                    })?
                    .to_string_lossy()
                    .into_owned();
                assert_safe_symlink_target(&link_name)?;
                deferred_symlinks.insert(rel_path, link_name);
            }
            other => {
                return Err(EnvError::Archive(format!(
                    "Unsupported tar entry type {other:?} at {rel_path} (hardlinks/devices forbidden)"
                )));
            }
        }
    }

    create_deferred_symlinks(dest_dir, &deferred_symlinks)?;
    Ok(())
}
