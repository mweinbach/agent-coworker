use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const SKIPPED_NAMES: &[&str] = &[".git", ".DS_Store", ".cowork-skill.json"];

fn should_skip_rel(rel: &str, file_name: &str) -> bool {
    if SKIPPED_NAMES.contains(&file_name)
        || file_name.starts_with(".incoming-")
        || file_name.starts_with(".backup-")
    {
        return true;
    }
    rel == ".cowork-plugin/install.json" || rel == ".codex-plugin/install.json"
}

/// Deterministic content hash matching `src/skills/sourceRootHash.ts` (`sha256:<hex>`).
pub fn compute_source_root_hash(dir: &Path) -> Result<String, String> {
    let canonical_root = fs::canonicalize(dir)
        .map_err(|e| format!("failed to canonicalize {}: {e}", dir.display()))?;
    let mut records: Vec<(String, Vec<u8>)> = Vec::new();
    collect_hash_records(&canonical_root, &canonical_root, &mut records)?;
    records.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    hasher.update(b"cowork-source-root-v1\0");
    for (_rel, payload) in records {
        hasher.update(&payload);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn collect_hash_records(
    canonical_root: &Path,
    current_dir: &Path,
    out: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let entries = fs::read_dir(current_dir)
        .map_err(|e| format!("failed to read directory {}: {e}", current_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read entry: {e}"))?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let rel = path
            .strip_prefix(canonical_root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if should_skip_rel(&rel, &file_name) {
            continue;
        }
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("failed to stat {}: {e}", path.display()))?;
        let ft = meta.file_type();
        if ft.is_symlink() {
            let link_target = fs::read_link(&path)
                .map_err(|e| format!("failed to read symlink {}: {e}", path.display()))?;
            let resolved = fs::canonicalize(&path).map_err(|_| {
                format!(
                    "symlink '{}' escapes or points to missing target outside '{}'",
                    rel,
                    canonical_root.display()
                )
            })?;
            if !resolved.starts_with(canonical_root) {
                return Err(format!(
                    "symlink '{}' escapes source root '{}'",
                    rel,
                    canonical_root.display()
                ));
            }
            let mut buf = Vec::new();
            buf.extend_from_slice(b"symlink\0");
            buf.extend_from_slice(rel.as_bytes());
            buf.push(0);
            buf.extend_from_slice(link_target.to_string_lossy().replace('\\', "/").as_bytes());
            buf.push(0);
            out.push((rel, buf));
        } else if ft.is_dir() {
            collect_hash_records(canonical_root, &path, out)?;
        } else if ft.is_file() {
            let bytes =
                fs::read(&path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
            let mut buf = Vec::new();
            buf.extend_from_slice(b"file\0");
            buf.extend_from_slice(rel.as_bytes());
            buf.push(0);
            buf.extend_from_slice(&bytes);
            buf.push(0);
            out.push((rel, buf));
        }
    }
    Ok(())
}

/// Recursively copies `src` into `dst`, skipping `.git` and verifying symlinks stay confined to `src`.
pub fn copy_dir_confined(src: &Path, dst: &Path) -> Result<(), String> {
    let canonical_src = fs::canonicalize(src)
        .map_err(|e| format!("failed to canonicalize {}: {e}", src.display()))?;
    copy_dir_inner(&canonical_src, &canonical_src, dst)
}

fn copy_dir_inner(canonical_src: &Path, cur_src: &Path, cur_dst: &Path) -> Result<(), String> {
    fs::create_dir_all(cur_dst)
        .map_err(|e| format!("failed to create directory {}: {e}", cur_dst.display()))?;
    for entry in
        fs::read_dir(cur_src).map_err(|e| format!("failed to read {}: {e}", cur_src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git"
            || name_str == ".DS_Store"
            || name_str.starts_with(".incoming-")
            || name_str.starts_with(".backup-")
        {
            continue;
        }
        let src_path = entry.path();
        let dst_path: PathBuf = cur_dst.join(&name);
        let meta = fs::symlink_metadata(&src_path).map_err(|e| e.to_string())?;
        let ft = meta.file_type();
        if ft.is_symlink() {
            let resolved = fs::canonicalize(&src_path)
                .map_err(|_| format!("broken symlink: {}", src_path.display()))?;
            if !resolved.starts_with(canonical_src) {
                return Err(format!(
                    "refusing to copy symlink escaping source root: {}",
                    src_path.display()
                ));
            }
            if resolved.is_dir() {
                copy_dir_inner(canonical_src, &resolved, &dst_path)?;
            } else {
                fs::copy(&resolved, &dst_path).map_err(|e| e.to_string())?;
            }
        } else if ft.is_dir() {
            copy_dir_inner(canonical_src, &src_path, &dst_path)?;
        } else if ft.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Deterministic unmanaged installation ID `adopted-<sha256[..24]>`.
pub fn unmanaged_skill_installation_id(scope: &str, dir_path: &Path) -> String {
    let canonical = fs::canonicalize(dir_path).unwrap_or_else(|_| dir_path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(format!("{scope}:{}", canonical.display()).as_bytes());
    let hex_digest = hex::encode(hasher.finalize());
    format!("adopted-{}", &hex_digest[..24])
}
