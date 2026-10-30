use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use cowork_config::canonicalize_sync;
use dashmap::DashMap;
use data_encoding::BASE64;
use ed25519_dalek::Signature;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest as Sha2Digest, Sha256};
use walkdir::WalkDir;

use crate::archive::{
    assert_safe_relative_runtime_path, assert_safe_symlink_target, validate_symlink_graph,
};
use crate::error::{EnvError, Result};
use crate::manifest::{
    IntegrityEntryKind, IntegrityFileEntry, PreparedRuntime, RuntimeIntegrityManifest,
    RuntimeManifest, RuntimePaths, RuntimeSignatureEnvelope, TrustedKeyRing, resolve_host_asset,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedAttestationRecord {
    schema_version: u32,
    runtime_version: String,
    asset: String,
    key_id: String,
    signature_blake3: String,
    tree_state_blake3: String,
}

fn memory_attestation_cache() -> &'static DashMap<PathBuf, VerifiedAttestationRecord> {
    static CACHE: OnceLock<DashMap<PathBuf, VerifiedAttestationRecord>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

pub fn attestation_sidecar_path(runtime_dir: &Path) -> PathBuf {
    let mut os = runtime_dir.as_os_str().to_os_string();
    os.push(".verified.json");
    PathBuf::from(os)
}

/// Verifies a detached `RuntimeSignatureEnvelope` (`Ed25519`) against `TrustedKeyRing`.
pub fn verify_ed25519_envelope(
    raw_manifest_bytes: &[u8],
    envelope: &RuntimeSignatureEnvelope,
    trusted_keys: &TrustedKeyRing,
) -> Result<()> {
    if envelope.schema_version != 1 {
        return Err(EnvError::Signature(format!(
            "Unsupported signature envelope schemaVersion {}",
            envelope.schema_version
        )));
    }
    if envelope.algorithm != "Ed25519" {
        return Err(EnvError::Signature(format!(
            "Unsupported signature algorithm {:?}",
            envelope.algorithm
        )));
    }
    let Some(verifying_key) = trusted_keys.get(&envelope.key_id) else {
        return Err(EnvError::Signature(format!(
            "Untrusted runtime signing keyId {:?}",
            envelope.key_id
        )));
    };
    let sig_bytes = BASE64
        .decode(envelope.signature.trim().as_bytes())
        .map_err(|e| EnvError::Signature(format!("Malformed base64 Ed25519 signature: {e}")))?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| {
        EnvError::Signature("Invalid Ed25519 signature byte length (expected 64)".to_owned())
    })?;
    let signature = Signature::from_bytes(&sig_arr);
    verifying_key
        .verify_strict(raw_manifest_bytes, &signature)
        .map_err(|e| EnvError::Signature(format!("Ed25519 signature check failed: {e}")))
}

/// Computes `(sha256_hex, blake3_hex, byte_len)` for a regular file in a single streaming read.
pub fn hash_regular_file(path: &Path) -> Result<(String, String, u64)> {
    let mut f = File::open(path).map_err(|source| EnvError::IoPath {
        path: path.to_path_buf(),
        source,
    })?;
    let mut sha = Sha256::new();
    let mut b3 = blake3::Hasher::new();
    let mut total = 0_u64;
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        b3.update(&buf[..n]);
        total += n as u64;
    }
    Ok((
        hex::encode(sha.finalize()),
        b3.finalize().to_hex().to_string(),
        total,
    ))
}

/// Computes `(sha256_hex, blake3_hex, byte_len)` over UTF-8 bytes.
pub fn hash_bytes_dual(bytes: &[u8]) -> (String, String, u64) {
    let sha = hex::encode(Sha256::digest(bytes));
    let b3 = blake3::hash(bytes).to_hex().to_string();
    (sha, b3, bytes.len() as u64)
}

fn relative_posix_from_root(root: &Path, full: &Path) -> Result<String> {
    let rel = full.strip_prefix(root).map_err(|_| {
        EnvError::Integrity(format!(
            "Path {} is outside runtime root {}",
            full.display(),
            root.display()
        ))
    })?;
    let mut parts = Vec::new();
    for comp in rel.components() {
        let s = comp.as_os_str().to_str().ok_or_else(|| {
            EnvError::Integrity(format!("Non-UTF-8 path inside runtime: {}", full.display()))
        })?;
        parts.push(s);
    }
    assert_safe_relative_runtime_path(&parts.join("/"), "runtime disk path")
}

/// Verifies every file and symlink under `root_dir` against `files` in parallel using `rayon`.
pub fn verify_integrity_tree_parallel(
    root_dir: &Path,
    files: &[IntegrityFileEntry],
    trusted_symlinks: &[String],
    extra_excluded_rel_paths: &HashSet<String>,
) -> Result<()> {
    let root_canonical = canonicalize_sync(root_dir);
    let trusted_symlink_set: HashSet<&str> = trusted_symlinks.iter().map(String::as_str).collect();

    // Validate manifest entries & check for duplicates.
    let mut expected_by_path: HashMap<String, &IntegrityFileEntry> =
        HashMap::with_capacity(files.len());
    for entry in files {
        let clean = assert_safe_relative_runtime_path(&entry.path, "integrity file path")?;
        if entry.sha256.is_none() && entry.blake3.is_none() {
            return Err(EnvError::Integrity(format!(
                "Integrity entry {clean} must declare sha256 and/or blake3 digest"
            )));
        }
        if entry.kind == IntegrityEntryKind::Symlink
            && !trusted_symlinks.is_empty()
            && !trusted_symlink_set.contains(clean.as_str())
        {
            return Err(EnvError::Integrity(format!(
                "Untrusted symlink in integrity manifest: {clean}"
            )));
        }
        if expected_by_path.insert(clean.clone(), entry).is_some() {
            return Err(EnvError::Integrity(format!(
                "Duplicate integrity entry for {clean}"
            )));
        }
    }

    // Walk disk tree (no symlink following) to detect extra or unexpected files.
    let mut disk_paths: HashSet<String> = HashSet::new();
    let mut disk_symlinks: HashMap<String, String> = HashMap::new();

    for item in WalkDir::new(root_dir).follow_links(false) {
        let dir_entry =
            item.map_err(|e| EnvError::Integrity(format!("Failed walking runtime tree: {e}")))?;
        if dir_entry.path() == root_dir {
            continue;
        }
        let rel = relative_posix_from_root(root_dir, dir_entry.path())?;
        if extra_excluded_rel_paths.contains(&rel) {
            continue;
        }
        let ft = dir_entry.file_type();
        if ft.is_dir() {
            continue;
        }
        if ft.is_symlink() {
            let target_os = std::fs::read_link(dir_entry.path())?;
            let target = target_os
                .to_str()
                .ok_or_else(|| EnvError::Integrity(format!("Non-UTF-8 symlink target at {rel}")))?
                .replace('\\', "/");
            assert_safe_symlink_target(&target)?;
            disk_symlinks.insert(rel.clone(), target);
            disk_paths.insert(rel);
        } else if ft.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let meta = std::fs::symlink_metadata(dir_entry.path())?;
                if meta.nlink() != 1 {
                    return Err(EnvError::Integrity(format!(
                        "Hardlinked runtime file is forbidden ({rel}, nlink={})",
                        meta.nlink()
                    )));
                }
            }
            disk_paths.insert(rel);
        } else {
            return Err(EnvError::Integrity(format!(
                "Unsupported special file inside runtime tree: {rel}"
            )));
        }
    }

    if !disk_symlinks.is_empty() {
        validate_symlink_graph(&disk_symlinks)?;
    }

    for disk_rel in &disk_paths {
        if !expected_by_path.contains_key(disk_rel) {
            return Err(EnvError::Integrity(format!(
                "Unexpected extra file in runtime tree: {disk_rel}"
            )));
        }
    }
    for expected_rel in expected_by_path.keys() {
        if !disk_paths.contains(expected_rel) {
            return Err(EnvError::Integrity(format!(
                "Missing expected file in runtime tree: {expected_rel}"
            )));
        }
    }

    // Parallel verification across CPU cores via `rayon`.
    files.par_iter().try_for_each(|entry| -> Result<()> {
        let full_path = root_dir.join(&entry.path);
        let meta = std::fs::symlink_metadata(&full_path).map_err(|source| EnvError::IoPath {
            path: full_path.clone(),
            source,
        })?;
        let ft = meta.file_type();

        match entry.kind {
            IntegrityEntryKind::File => {
                if !ft.is_file() || ft.is_symlink() {
                    return Err(EnvError::Integrity(format!(
                        "Expected regular file at {}, found symlink/other",
                        entry.path
                    )));
                }
                if meta.len() != entry.size {
                    return Err(EnvError::Integrity(format!(
                        "File size mismatch at {}: expected {}, got {}",
                        entry.path,
                        entry.size,
                        meta.len()
                    )));
                }
                let (sha256_actual, blake3_actual, actual_len) = hash_regular_file(&full_path)?;
                if actual_len != entry.size {
                    return Err(EnvError::Integrity(format!(
                        "Concurrent size change at {}: expected {}, read {}",
                        entry.path, entry.size, actual_len
                    )));
                }
                if let Some(expected_b3) = &entry.blake3
                    && !blake3_actual.eq_ignore_ascii_case(expected_b3)
                {
                    return Err(EnvError::Integrity(format!(
                        "blake3 digest mismatch at {}",
                        entry.path
                    )));
                }
                if let Some(expected_sha) = &entry.sha256
                    && !sha256_actual.eq_ignore_ascii_case(expected_sha)
                {
                    return Err(EnvError::Integrity(format!(
                        "sha256 digest mismatch at {}",
                        entry.path
                    )));
                }
            }
            IntegrityEntryKind::Symlink => {
                if !ft.is_symlink() {
                    return Err(EnvError::Integrity(format!(
                        "Expected symlink at {}, found non-symlink",
                        entry.path
                    )));
                }
                let target_raw = std::fs::read_link(&full_path)?;
                let target = target_raw
                    .to_str()
                    .ok_or_else(|| {
                        EnvError::Integrity(format!("Non-UTF-8 symlink at {}", entry.path))
                    })?
                    .replace('\\', "/");
                assert_safe_symlink_target(&target)?;
                if std::fs::metadata(&full_path).is_ok() {
                    let resolved = canonicalize_sync(&full_path);
                    if resolved != root_canonical && !resolved.starts_with(&root_canonical) {
                        return Err(EnvError::Integrity(format!(
                            "Symlink {} escapes runtime root",
                            entry.path
                        )));
                    }
                }
                let (sha256_actual, blake3_actual, actual_len) = hash_bytes_dual(target.as_bytes());
                if actual_len != entry.size {
                    return Err(EnvError::Integrity(format!(
                        "Symlink target length mismatch at {}",
                        entry.path
                    )));
                }
                if let Some(expected_b3) = &entry.blake3
                    && !blake3_actual.eq_ignore_ascii_case(expected_b3)
                {
                    return Err(EnvError::Integrity(format!(
                        "Symlink blake3 digest mismatch at {}",
                        entry.path
                    )));
                }
                if let Some(expected_sha) = &entry.sha256
                    && !sha256_actual.eq_ignore_ascii_case(expected_sha)
                {
                    return Err(EnvError::Integrity(format!(
                        "Symlink sha256 digest mismatch at {}",
                        entry.path
                    )));
                }
            }
        }
        Ok(())
    })
}

/// Computes a deterministic `blake3` fingerprint over `(path, kind, dev, ino, size, nlink, mtime, mode)`
/// for every file, directory, and symlink in `root_dir` in parallel via `rayon`.
pub fn compute_tree_state_digest_parallel(root_dir: &Path) -> Result<String> {
    let mut paths: Vec<(String, PathBuf)> = Vec::new();
    for item in WalkDir::new(root_dir).follow_links(false) {
        let de =
            item.map_err(|e| EnvError::Integrity(format!("Failed walking tree state: {e}")))?;
        let rel = if de.path() == root_dir {
            ".".to_owned()
        } else {
            relative_posix_from_root(root_dir, de.path())?
        };
        paths.push((rel, de.path().to_path_buf()));
    }

    let mut records: Vec<(String, String)> = paths
        .par_iter()
        .map(|(rel, p)| -> Result<(String, String)> {
            let meta = std::fs::symlink_metadata(p)?;
            let ft = meta.file_type();
            let kind = if ft.is_symlink() {
                "L"
            } else if ft.is_dir() {
                "D"
            } else {
                "F"
            };
            #[cfg(unix)]
            let stat_line = {
                use std::os::unix::fs::MetadataExt;
                format!(
                    "{rel}|{kind}|dev={}|ino={}|sz={}|nl={}|mt={}.{}|mode={:o}",
                    meta.dev(),
                    meta.ino(),
                    meta.len(),
                    meta.nlink(),
                    meta.mtime(),
                    meta.mtime_nsec(),
                    meta.mode() & 0o7777
                )
            };
            #[cfg(not(unix))]
            let stat_line = {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                format!(
                    "{rel}|{kind}|sz={}|ro={}|mt={mtime}",
                    meta.len(),
                    meta.permissions().readonly()
                )
            };
            Ok((rel.clone(), stat_line))
        })
        .collect::<Result<Vec<_>>>()?;

    records.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = blake3::Hasher::new();
    for (_, line) in records {
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Seals a verified runtime directory tree read-only (`0555` on executables/dirs, `0444` on files).
pub fn seal_tree_readonly(root_dir: &Path) -> Result<()> {
    let mut dirs_by_depth: Vec<(usize, PathBuf)> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for item in WalkDir::new(root_dir).follow_links(false) {
        let de = item.map_err(|e| EnvError::Integrity(format!("Seal walk failed: {e}")))?;
        let ft = de.file_type();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            dirs_by_depth.push((de.depth(), de.path().to_path_buf()));
        } else if ft.is_file() {
            files.push(de.path().to_path_buf());
        }
    }

    for file_path in &files {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::symlink_metadata(file_path)?;
            let old_mode = meta.permissions().mode();
            let exec = (old_mode & 0o111) != 0;
            let new_mode = if exec { 0o555 } else { 0o444 };
            let mut perms = meta.permissions();
            perms.set_mode(new_mode);
            std::fs::set_permissions(file_path, perms)?;
        }
        #[cfg(not(unix))]
        {
            let mut perms = std::fs::metadata(file_path)?.permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(file_path, perms)?;
        }
    }

    // Seal directories bottom-up so parent directories stay writable until all children are sealed.
    dirs_by_depth.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (_, dir_path) in &dirs_by_depth {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::symlink_metadata(dir_path)?;
            let mut perms = meta.permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(dir_path, perms)?;
        }
        #[cfg(not(unix))]
        {
            let _ = dir_path;
        }
    }

    Ok(())
}

/// Restores owner write permissions top-down so a sealed runtime tree can be removed cleanly.
pub fn unseal_tree_for_removal(root_dir: &Path) -> Result<()> {
    if !root_dir.exists() {
        return Ok(());
    }
    let mut dirs_by_depth: Vec<(usize, PathBuf)> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    // First make root_dir itself writable so WalkDir can traverse/mutate inside if needed.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::symlink_metadata(root_dir)
            && meta.file_type().is_dir()
        {
            let mut perms = meta.permissions();
            perms.set_mode(0o700);
            let _ = std::fs::set_permissions(root_dir, perms);
        }
    }

    for item in WalkDir::new(root_dir).follow_links(false) {
        let Ok(de) = item else {
            continue;
        };
        let ft = de.file_type();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            dirs_by_depth.push((de.depth(), de.path().to_path_buf()));
        } else if ft.is_file() {
            files.push(de.path().to_path_buf());
        }
    }

    dirs_by_depth.sort_by_key(|a| a.0);
    for (_, dir_path) in &dirs_by_depth {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::symlink_metadata(dir_path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o700);
                let _ = std::fs::set_permissions(dir_path, perms);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = dir_path;
        }
    }

    for file_path in &files {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::symlink_metadata(file_path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(file_path, perms);
            }
        }
        #[cfg(not(unix))]
        {
            if let Ok(meta) = std::fs::metadata(file_path) {
                let mut perms = meta.permissions();
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(file_path, perms);
            }
        }
    }
    Ok(())
}

/// Unseals and deletes an installed or staging runtime directory and its attestation sidecar.
pub fn remove_sealed_tree(root_dir: &Path) -> Result<()> {
    memory_attestation_cache().remove(&canonicalize_sync(root_dir));
    let sidecar = attestation_sidecar_path(root_dir);
    let _ = std::fs::remove_file(&sidecar);
    if root_dir.exists() {
        let _ = unseal_tree_for_removal(root_dir);
        std::fs::remove_dir_all(root_dir)?;
    }
    Ok(())
}

/// Verifies an extracted Cowork runtime root (`runtime.json` + `runtime-integrity.json` + `runtime-integrity.sig`),
/// consulting the `(inode, mtime, size)` attestation cache unless `force_full_verify` is set.
pub fn verify_installed_runtime(
    runtime_dir: &Path,
    trusted_keys: &TrustedKeyRing,
    force_full_verify: bool,
) -> Result<PreparedRuntime> {
    let canonical_root = canonicalize_sync(runtime_dir);
    let manifest_raw =
        std::fs::read_to_string(canonical_root.join("runtime.json")).map_err(|e| {
            EnvError::Manifest(format!(
                "Missing or unreadable runtime.json in {}: {e}",
                canonical_root.display()
            ))
        })?;
    let manifest: RuntimeManifest = serde_json::from_str(&manifest_raw).map_err(|e| {
        EnvError::Manifest(format!(
            "Invalid runtime.json in {}: {e}",
            canonical_root.display()
        ))
    })?;
    if manifest.schema_version != 2 {
        return Err(EnvError::Manifest(format!(
            "Unsupported runtime.json schemaVersion {} (expected 2)",
            manifest.schema_version
        )));
    }

    let host_asset = resolve_host_asset()?;
    if manifest.asset != host_asset {
        return Err(EnvError::Manifest(format!(
            "Runtime asset mismatch: manifest={} host={host_asset}",
            manifest.asset
        )));
    }

    let has_monolithic_integrity = canonical_root.join("runtime-integrity.json").is_file()
        && canonical_root.join("runtime-integrity.sig").is_file();

    let (key_id_record, sig_digest, combined_files, excluded_rel_paths) =
        if has_monolithic_integrity {
            let integrity_bytes = std::fs::read(canonical_root.join("runtime-integrity.json"))
                .map_err(|e| {
                    EnvError::Integrity(format!(
                        "Missing runtime-integrity.json in {}: {e}",
                        canonical_root.display()
                    ))
                })?;
            let sig_raw = std::fs::read_to_string(canonical_root.join("runtime-integrity.sig"))
                .map_err(|e| {
                    EnvError::Signature(format!(
                        "Missing runtime-integrity.sig in {}: {e}",
                        canonical_root.display()
                    ))
                })?;
            let envelope: RuntimeSignatureEnvelope =
                serde_json::from_str(&sig_raw).map_err(|e| {
                    EnvError::Signature(format!("Invalid runtime-integrity.sig JSON: {e}"))
                })?;

            verify_ed25519_envelope(&integrity_bytes, &envelope, trusted_keys)?;

            let integrity: RuntimeIntegrityManifest = serde_json::from_slice(&integrity_bytes)
                .map_err(|e| EnvError::Integrity(format!("Invalid runtime-integrity.json: {e}")))?;
            if integrity.schema_version != 2 {
                return Err(EnvError::Integrity(format!(
                    "Unsupported runtime-integrity.json schemaVersion {}",
                    integrity.schema_version
                )));
            }
            if integrity.key_id != envelope.key_id {
                return Err(EnvError::Signature(
                    "runtime-integrity.json keyId does not match signature envelope keyId"
                        .to_owned(),
                ));
            }
            if integrity.runtime_version != manifest.version || integrity.asset != manifest.asset {
                return Err(EnvError::Integrity(
                    "runtime-integrity.json version/asset does not match runtime.json".to_owned(),
                ));
            }

            let mut sig_hasher = blake3::Hasher::new();
            sig_hasher.update(&integrity_bytes);
            sig_hasher.update(sig_raw.as_bytes());
            let mut excluded = HashSet::new();
            excluded.insert("runtime-integrity.json".to_owned());
            excluded.insert("runtime-integrity.sig".to_owned());
            (
                envelope.key_id,
                sig_hasher.finalize().to_hex().to_string(),
                integrity.files,
                excluded,
            )
        } else if !manifest.installed_packs.is_empty() {
            let mut sig_hasher = blake3::Hasher::new();
            let mut merged_files: Vec<IntegrityFileEntry> = Vec::new();
            let mut excluded = HashSet::new();
            excluded.insert("runtime.json".to_owned());
            let mut first_key_id = String::new();

            for pack_name in &manifest.installed_packs {
                let pack_id = crate::manifest::RuntimePackId::parse(pack_name)?;
                let meta_prefix = format!(".packs/{}", pack_id.as_str());
                let pack_json_rel = format!("{meta_prefix}/pack.json");
                let int_rel = format!("{meta_prefix}/pack-integrity.json");
                let sig_rel = format!("{meta_prefix}/pack-integrity.sig");
                excluded.insert(pack_json_rel);
                excluded.insert(int_rel.clone());
                excluded.insert(sig_rel.clone());

                let int_bytes = std::fs::read(canonical_root.join(&int_rel))
                    .map_err(|e| EnvError::Integrity(format!("Missing {int_rel}: {e}")))?;
                let sig_raw = std::fs::read_to_string(canonical_root.join(&sig_rel))
                    .map_err(|e| EnvError::Signature(format!("Missing {sig_rel}: {e}")))?;
                let envelope: RuntimeSignatureEnvelope = serde_json::from_str(&sig_raw)
                    .map_err(|e| EnvError::Signature(format!("Invalid {sig_rel}: {e}")))?;
                verify_ed25519_envelope(&int_bytes, &envelope, trusted_keys)?;

                let pack_int: RuntimeIntegrityManifest = serde_json::from_slice(&int_bytes)
                    .map_err(|e| EnvError::Integrity(format!("Invalid {int_rel}: {e}")))?;
                if pack_int.pack_id != Some(pack_id) {
                    return Err(EnvError::Integrity(format!(
                        "Pack integrity manifest id mismatch in {int_rel}"
                    )));
                }
                if pack_int.runtime_version != manifest.version || pack_int.asset != manifest.asset
                {
                    return Err(EnvError::Integrity(format!(
                        "Pack integrity version/asset mismatch in {int_rel}"
                    )));
                }
                if first_key_id.is_empty() {
                    first_key_id = envelope.key_id.clone();
                }
                sig_hasher.update(&int_bytes);
                sig_hasher.update(sig_raw.as_bytes());
                merged_files.extend(pack_int.files);
            }

            (
                first_key_id,
                sig_hasher.finalize().to_hex().to_string(),
                merged_files,
                excluded,
            )
        } else {
            return Err(EnvError::Integrity(format!(
                "Missing signed integrity manifest in {}",
                canonical_root.display()
            )));
        };

    let tree_digest = compute_tree_state_digest_parallel(&canonical_root)?;
    let sidecar_path = attestation_sidecar_path(&canonical_root);

    let cache_hit = if !force_full_verify {
        if let Some(mem) = memory_attestation_cache().get(&canonical_root)
            && mem.signature_blake3 == sig_digest
            && mem.tree_state_blake3 == tree_digest
            && mem.key_id == key_id_record
        {
            true
        } else if let Ok(disk_raw) = std::fs::read_to_string(&sidecar_path)
            && let Ok(disk_rec) = serde_json::from_str::<VerifiedAttestationRecord>(&disk_raw)
            && disk_rec.schema_version == 1
            && disk_rec.signature_blake3 == sig_digest
            && disk_rec.tree_state_blake3 == tree_digest
            && disk_rec.key_id == key_id_record
        {
            memory_attestation_cache().insert(canonical_root.clone(), disk_rec);
            true
        } else {
            false
        }
    } else {
        false
    };

    if !cache_hit {
        verify_integrity_tree_parallel(
            &canonical_root,
            &combined_files,
            &manifest.trusted_symlinks,
            &excluded_rel_paths,
        )?;

        let rec = VerifiedAttestationRecord {
            schema_version: 1,
            runtime_version: manifest.version.clone(),
            asset: manifest.asset.clone(),
            key_id: key_id_record,
            signature_blake3: sig_digest,
            tree_state_blake3: tree_digest,
        };
        if let Ok(json_bytes) = serde_json::to_vec_pretty(&rec) {
            let _ = std::fs::write(&sidecar_path, json_bytes);
        }
        memory_attestation_cache().insert(canonical_root.clone(), rec);
    }

    let paths = RuntimePaths::from_manifest_paths(&canonical_root, &manifest.paths);
    for required in [&paths.node, &paths.python, &paths.node_resolver] {
        if !required.is_file() {
            return Err(EnvError::Manifest(format!(
                "Verified runtime missing entrypoint file: {}",
                required.display()
            )));
        }
    }

    Ok(PreparedRuntime {
        version: manifest.version,
        asset: manifest.asset,
        root_dir: canonical_root,
        installed_packs: manifest.installed_packs,
        paths,
    })
}
