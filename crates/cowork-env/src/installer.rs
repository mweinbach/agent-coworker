use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use cowork_sandbox::{host_arch, host_platform};
use data_encoding::BASE64;
use ed25519_dalek::{Signer, SigningKey};
use rayon::prelude::*;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::archive::{
    ArchiveFormat, assert_safe_relative_runtime_path, detect_archive_format,
    extract_v1_zip_archive, extract_v2_tar_zst_archive,
};
use crate::error::{EnvError, Result};
use crate::integrity::{
    hash_bytes_dual, hash_regular_file, remove_sealed_tree, seal_tree_readonly,
    verify_ed25519_envelope, verify_installed_runtime, verify_integrity_tree_parallel,
};
use crate::manifest::{
    InstalledRuntimePointer, IntegrityEntryKind, IntegrityFileEntry, PreparedRuntime,
    RuntimeIntegrityManifest, RuntimeManifest, RuntimeManifestPaths, RuntimePackId,
    RuntimePackManifest, RuntimeProgressCallback, RuntimeSignatureEnvelope, StartupProgressEvent,
    TrustedKeyRing, resolve_host_asset,
};

pub const DEFAULT_BOOTSTRAP_LOCK_TIMEOUT: Duration = Duration::from_secs(120);

pub fn runtime_root_dir(homedir: &Path) -> PathBuf {
    homedir.join(".cowork").join("runtime")
}

pub fn bootstrap_lock_path(homedir: &Path) -> PathBuf {
    runtime_root_dir(homedir).join(".bootstrap.lock")
}

pub fn consumer_lease_lock_path(runtime_dir: &Path) -> PathBuf {
    let mut os = runtime_dir.as_os_str().to_os_string();
    os.push(".lease.lock");
    PathBuf::from(os)
}

fn open_lock_file(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map_err(|source| EnvError::IoPath {
        path: path.to_path_buf(),
        source,
    })
}

/// Synchronous `fs4` single-writer bootstrap lock helper.
pub fn with_runtime_bootstrap_lock_sync<T, F>(
    homedir: &Path,
    version_hint: &str,
    timeout: Duration,
    on_progress: Option<&RuntimeProgressCallback>,
    work: F,
) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let lock_path = bootstrap_lock_path(homedir);
    let file = open_lock_file(&lock_path)?;

    match <File as fs4::FileExt>::try_lock(&file) {
        Ok(()) => {}
        Err(fs4::TryLockError::WouldBlock) => {
            if let Some(cb) = on_progress {
                cb(StartupProgressEvent::waiting(version_hint));
            }
            let deadline = Instant::now() + timeout;
            loop {
                std::thread::sleep(Duration::from_millis(15));
                match <File as fs4::FileExt>::try_lock(&file) {
                    Ok(()) => break,
                    Err(fs4::TryLockError::WouldBlock) => {
                        if Instant::now() >= deadline {
                            return Err(EnvError::LockTimeout { path: lock_path });
                        }
                    }
                    Err(fs4::TryLockError::Error(err)) => return Err(EnvError::Io(err)),
                }
            }
        }
        Err(fs4::TryLockError::Error(err)) => return Err(EnvError::Io(err)),
    }

    let result = work();
    let _ = <File as fs4::FileExt>::unlock(&file);
    result
}

/// Async wrapper around `with_runtime_bootstrap_lock_sync` that offloads lock waiting and work onto
/// `tokio::task::spawn_blocking` so Tokio worker threads never block.
pub async fn with_runtime_bootstrap_lock<T, F>(
    homedir: &Path,
    version_hint: &str,
    timeout: Duration,
    on_progress: Option<RuntimeProgressCallback>,
    work: F,
) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let home = homedir.to_path_buf();
    let ver = version_hint.to_owned();
    tokio::task::spawn_blocking(move || {
        with_runtime_bootstrap_lock_sync(&home, &ver, timeout, on_progress.as_ref(), work)
    })
    .await
    .map_err(|e| EnvError::Lock(format!("Bootstrap task join error: {e}")))?
}

/// OS-kernel-enforced shared reader lease preventing an active runtime directory from being pruned.
#[derive(Debug)]
pub struct RuntimeConsumerLease {
    file: File,
    runtime_dir: PathBuf,
}

impl RuntimeConsumerLease {
    pub fn acquire(runtime_dir: &Path) -> Result<Self> {
        let canonical = canonicalize_sync(runtime_dir);
        let lease_path = consumer_lease_lock_path(&canonical);
        let file = open_lock_file(&lease_path)?;
        <File as fs4::FileExt>::lock_shared(&file)?;
        Ok(Self {
            file,
            runtime_dir: canonical,
        })
    }

    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
}

impl Drop for RuntimeConsumerLease {
    fn drop(&mut self) {
        let _ = <File as fs4::FileExt>::unlock(&self.file);
    }
}

/// Returns `true` if at least one live consumer holds a shared `RuntimeConsumerLease` on `runtime_dir`.
pub fn has_active_consumer_lease(runtime_dir: &Path) -> bool {
    let canonical = canonicalize_sync(runtime_dir);
    let lease_path = consumer_lease_lock_path(&canonical);
    if !lease_path.exists() {
        return false;
    }
    let Ok(file) = open_lock_file(&lease_path) else {
        return true; // fail closed on unreadable lock file
    };
    match <File as fs4::FileExt>::try_lock(&file) {
        Ok(()) => {
            let _ = <File as fs4::FileExt>::unlock(&file);
            false
        }
        Err(fs4::TryLockError::WouldBlock) => true,
        Err(fs4::TryLockError::Error(_)) => true,
    }
}

/// Options controlling offline/local Cowork runtime installation and retention.
#[derive(Clone)]
pub struct RuntimeInstallOptions {
    pub homedir: PathBuf,
    pub trusted_keys: TrustedKeyRing,
    pub expected_version: Option<String>,
    pub expected_archive_sha256: Option<String>,
    pub force: bool,
    pub keep_versions: usize,
    pub on_progress: Option<RuntimeProgressCallback>,
}

fn write_current_pointer(root: &Path, pointer: &InstalledRuntimePointer) -> Result<()> {
    std::fs::create_dir_all(root)?;
    let tmp = root.join(format!("current.json.tmp.{}", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(pointer)
        .map_err(|e| EnvError::Manifest(format!("Failed serializing current.json: {e}")))?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, root.join("current.json"))?;
    Ok(())
}

pub fn read_current_pointer(homedir: &Path) -> Option<InstalledRuntimePointer> {
    let raw = std::fs::read_to_string(runtime_root_dir(homedir).join("current.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Prunes older installed runtime directories under `<homedir>/.cowork/runtime`, keeping `keep_versions`
/// newest versions while always preserving `current.json` and any runtime with an active `RuntimeConsumerLease`.
pub fn prune_installed_runtimes(homedir: &Path, keep_versions: usize) -> Result<Vec<PathBuf>> {
    let root = runtime_root_dir(homedir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let keep = keep_versions.max(1);
    let current_ver = read_current_pointer(homedir).map(|p| p.version);

    let mut version_dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.ends_with(".json") || name.ends_with(".lock") {
            continue;
        }
        let p = entry.path();
        if p.is_dir() && p.join("runtime.json").is_file() {
            version_dirs.push((name, p));
        }
    }

    // Newest version names sort lexicographically descending (`YYYY-MM-DD`).
    version_dirs.sort_by(|a, b| b.0.cmp(&a.0));

    let mut kept = 0usize;
    let mut removed = Vec::new();
    for (ver, dir_path) in version_dirs {
        let is_current = current_ver.as_deref() == Some(ver.as_str());
        if is_current || kept < keep {
            kept += 1;
            continue;
        }
        if has_active_consumer_lease(&dir_path) {
            continue;
        }
        remove_sealed_tree(&dir_path)?;
        let _ = std::fs::remove_file(consumer_lease_lock_path(&dir_path));
        removed.push(dir_path);
    }
    Ok(removed)
}

fn verify_optional_archive_sha256(archive_path: &Path, expected: Option<&str>) -> Result<()> {
    let Some(expected_hex) = expected.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let (actual_sha256, _, _) = hash_regular_file(archive_path)?;
    if !actual_sha256.eq_ignore_ascii_case(expected_hex) {
        return Err(EnvError::Integrity(format!(
            "Archive SHA-256 mismatch for {}: expected {expected_hex}, got {actual_sha256}",
            archive_path.display()
        )));
    }
    Ok(())
}

/// Installs, cryptographically verifies, read-only seals, and activates a signed v1 `.zip` runtime archive.
pub fn install_v1_zip_runtime(
    archive_path: &Path,
    opts: &RuntimeInstallOptions,
) -> Result<PreparedRuntime> {
    let version_hint = opts
        .expected_version
        .as_deref()
        .unwrap_or("installing")
        .to_owned();

    with_runtime_bootstrap_lock_sync(
        &opts.homedir,
        &version_hint,
        DEFAULT_BOOTSTRAP_LOCK_TIMEOUT,
        opts.on_progress.as_ref(),
        || {
            if let Some(cb) = &opts.on_progress {
                cb(StartupProgressEvent::installing(&version_hint));
            }
            verify_optional_archive_sha256(archive_path, opts.expected_archive_sha256.as_deref())?;

            let rt_root = runtime_root_dir(&opts.homedir);
            std::fs::create_dir_all(&rt_root)?;
            let staging_dir = rt_root.join(format!(".staging-v1-{}", Uuid::new_v4().simple()));

            let install_res = (|| -> Result<PreparedRuntime> {
                extract_v1_zip_archive(archive_path, &staging_dir)?;
                let staging_verified =
                    verify_installed_runtime(&staging_dir, &opts.trusted_keys, true)?;

                if let Some(expected_ver) = &opts.expected_version
                    && &staging_verified.version != expected_ver
                {
                    return Err(EnvError::Manifest(format!(
                        "Archive version {} does not match expected version {expected_ver}",
                        staging_verified.version
                    )));
                }

                let final_dir = rt_root.join(&staging_verified.version);
                if final_dir.exists() {
                    if !opts.force
                        && let Ok(existing) =
                            verify_installed_runtime(&final_dir, &opts.trusted_keys, false)
                    {
                        let _ = remove_sealed_tree(&staging_dir);
                        write_current_pointer(
                            &rt_root,
                            &InstalledRuntimePointer {
                                version: existing.version.clone(),
                                asset: existing.asset.clone(),
                                installed_at: chrono::Utc::now().to_rfc3339(),
                                runtime_dir: existing.root_dir.to_string_lossy().into_owned(),
                                installed_packs: existing.installed_packs.clone(),
                            },
                        )?;
                        let _ = prune_installed_runtimes(&opts.homedir, opts.keep_versions);
                        if let Some(cb) = &opts.on_progress {
                            cb(StartupProgressEvent::ready(&existing.version));
                        }
                        return Ok(existing);
                    }
                    if has_active_consumer_lease(&final_dir) {
                        return Err(EnvError::Lock(format!(
                            "Cannot overwrite active leased runtime {}",
                            final_dir.display()
                        )));
                    }
                    remove_sealed_tree(&final_dir)?;
                }

                // Remove staging sidecar before moving + sealing final_dir, then verify+attest sealed final_dir.
                let _ =
                    std::fs::remove_file(crate::integrity::attestation_sidecar_path(&staging_dir));
                std::fs::rename(&staging_dir, &final_dir)?;
                seal_tree_readonly(&final_dir)?;
                let final_verified =
                    verify_installed_runtime(&final_dir, &opts.trusted_keys, true)?;

                write_current_pointer(
                    &rt_root,
                    &InstalledRuntimePointer {
                        version: final_verified.version.clone(),
                        asset: final_verified.asset.clone(),
                        installed_at: chrono::Utc::now().to_rfc3339(),
                        runtime_dir: final_verified.root_dir.to_string_lossy().into_owned(),
                        installed_packs: final_verified.installed_packs.clone(),
                    },
                )?;
                let _ = prune_installed_runtimes(&opts.homedir, opts.keep_versions);
                if let Some(cb) = &opts.on_progress {
                    cb(StartupProgressEvent::ready(&final_verified.version));
                }
                Ok(final_verified)
            })();

            if install_res.is_err() && staging_dir.exists() {
                let _ = remove_sealed_tree(&staging_dir);
            }
            install_res
        },
    )
}

fn copy_dir_tree_preserving_symlinks(
    src: &Path,
    dst: &Path,
    skip_rel: &HashSet<&str>,
) -> Result<()> {
    for item in WalkDir::new(src).follow_links(false) {
        let de = item.map_err(|e| EnvError::Archive(format!("Merge walk failed: {e}")))?;
        if de.path() == src {
            continue;
        }
        let rel = de.path().strip_prefix(src).unwrap();
        let rel_posix = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if skip_rel.contains(rel_posix.as_str()) {
            continue;
        }
        let target = dst.join(rel);
        let ft = de.file_type();
        if ft.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if ft.is_symlink() {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p)?;
            }
            let link_dest = std::fs::read_link(de.path())?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(link_dest, &target)?;
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_file(link_dest, &target)?;
            }
        } else if ft.is_file() {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(de.path(), &target)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::symlink_metadata(de.path())?.permissions().mode();
                let mut perms = std::fs::metadata(&target)?.permissions();
                perms.set_mode(mode & 0o777);
                std::fs::set_permissions(&target, perms)?;
            }
        }
    }
    Ok(())
}

/// Installs, verifies (`ed25519-dalek` + parallel `rayon` `blake3`/`sha256`), composes, and
/// read-only seals a set of modular v2 `.tar.zst` runtime packs (`core`, `python-wheels`, `libreoffice`).
pub fn install_v2_pack_set(
    packs: &[(RuntimePackId, &Path)],
    opts: &RuntimeInstallOptions,
) -> Result<PreparedRuntime> {
    if packs.is_empty() {
        return Err(EnvError::Manifest(
            "install_v2_pack_set requires at least one pack".to_owned(),
        ));
    }
    let version_hint = opts
        .expected_version
        .as_deref()
        .unwrap_or("installing")
        .to_owned();

    with_runtime_bootstrap_lock_sync(
        &opts.homedir,
        &version_hint,
        DEFAULT_BOOTSTRAP_LOCK_TIMEOUT,
        opts.on_progress.as_ref(),
        || {
            if let Some(cb) = &opts.on_progress {
                cb(StartupProgressEvent::installing(&version_hint));
            }
            let rt_root = runtime_root_dir(&opts.homedir);
            std::fs::create_dir_all(&rt_root)?;
            let workspace_staging =
                rt_root.join(format!(".staging-v2-{}", Uuid::new_v4().simple()));
            let merged_dir = workspace_staging.join("merged");
            std::fs::create_dir_all(&merged_dir)?;

            let host_asset = resolve_host_asset()?;

            let res = (|| -> Result<PreparedRuntime> {
                let mut resolved_version: Option<String> = None;
                let mut components = BTreeMap::new();
                let mut provided_paths: HashMap<String, String> = HashMap::new();
                let mut trusted_symlinks: Vec<String> = Vec::new();
                let mut installed_pack_names: Vec<String> = Vec::new();

                for (expected_pack_id, archive_path) in packs {
                    let pack_extract_dir =
                        workspace_staging.join(format!("pack-{}", expected_pack_id.as_str()));
                    extract_v2_tar_zst_archive(archive_path, &pack_extract_dir)?;

                    let pack_json_raw = std::fs::read_to_string(pack_extract_dir.join("pack.json"))
                        .map_err(|e| {
                            EnvError::Manifest(format!(
                                "Missing pack.json in {}: {e}",
                                archive_path.display()
                            ))
                        })?;
                    let pack_manifest: RuntimePackManifest =
                        serde_json::from_str(&pack_json_raw)
                            .map_err(|e| EnvError::Manifest(format!("Invalid pack.json: {e}")))?;

                    if pack_manifest.schema_version != 2 {
                        return Err(EnvError::Manifest(format!(
                            "Unsupported pack.json schemaVersion {}",
                            pack_manifest.schema_version
                        )));
                    }
                    if pack_manifest.pack_id != *expected_pack_id {
                        return Err(EnvError::Manifest(format!(
                            "Pack id mismatch: expected {}, got {}",
                            expected_pack_id, pack_manifest.pack_id
                        )));
                    }
                    if pack_manifest.asset != host_asset {
                        return Err(EnvError::Manifest(format!(
                            "Pack {} asset {} does not match host {host_asset}",
                            pack_manifest.pack_id, pack_manifest.asset
                        )));
                    }
                    if let Some(ver) = &resolved_version {
                        if ver != &pack_manifest.version {
                            return Err(EnvError::Manifest(format!(
                                "Mismatched pack versions inside v2 set: {ver} vs {}",
                                pack_manifest.version
                            )));
                        }
                    } else {
                        resolved_version = Some(pack_manifest.version.clone());
                    }
                    if let Some(exp_ver) = &opts.expected_version
                        && &pack_manifest.version != exp_ver
                    {
                        return Err(EnvError::Manifest(format!(
                            "Pack version {} does not match expected {exp_ver}",
                            pack_manifest.version
                        )));
                    }

                    let int_bytes = std::fs::read(pack_extract_dir.join("pack-integrity.json"))
                        .map_err(|e| {
                            EnvError::Integrity(format!(
                                "Missing pack-integrity.json in {}: {e}",
                                archive_path.display()
                            ))
                        })?;
                    let sig_raw =
                        std::fs::read_to_string(pack_extract_dir.join("pack-integrity.sig"))
                            .map_err(|e| {
                                EnvError::Signature(format!(
                                    "Missing pack-integrity.sig in {}: {e}",
                                    archive_path.display()
                                ))
                            })?;
                    let envelope: RuntimeSignatureEnvelope = serde_json::from_str(&sig_raw)
                        .map_err(|e| EnvError::Signature(format!("Invalid pack sig: {e}")))?;

                    verify_ed25519_envelope(&int_bytes, &envelope, &opts.trusted_keys)?;

                    let pack_int: RuntimeIntegrityManifest = serde_json::from_slice(&int_bytes)
                        .map_err(|e| {
                            EnvError::Integrity(format!("Invalid pack-integrity.json: {e}"))
                        })?;
                    if pack_int.pack_id != Some(*expected_pack_id) {
                        return Err(EnvError::Integrity(
                            "pack-integrity.json packId mismatch".to_owned(),
                        ));
                    }

                    let mut excluded = HashSet::new();
                    excluded.insert("pack.json".to_owned());
                    excluded.insert("pack-integrity.json".to_owned());
                    excluded.insert("pack-integrity.sig".to_owned());
                    verify_integrity_tree_parallel(
                        &pack_extract_dir,
                        &pack_int.files,
                        &pack_manifest.trusted_symlinks,
                        &excluded,
                    )?;

                    // Merge verified payload into `merged_dir` and store signed pack metadata under `.packs/<id>/`.
                    let skip: HashSet<&str> =
                        ["pack.json", "pack-integrity.json", "pack-integrity.sig"]
                            .into_iter()
                            .collect();
                    copy_dir_tree_preserving_symlinks(&pack_extract_dir, &merged_dir, &skip)?;

                    let meta_dir = merged_dir.join(".packs").join(expected_pack_id.as_str());
                    std::fs::create_dir_all(&meta_dir)?;
                    std::fs::write(meta_dir.join("pack.json"), &pack_json_raw)?;
                    std::fs::write(meta_dir.join("pack-integrity.json"), &int_bytes)?;
                    std::fs::write(meta_dir.join("pack-integrity.sig"), &sig_raw)?;

                    components.extend(pack_manifest.components);
                    provided_paths.extend(pack_manifest.provided_paths);
                    for s in pack_manifest.trusted_symlinks {
                        if !trusted_symlinks.contains(&s) {
                            trusted_symlinks.push(s);
                        }
                    }
                    installed_pack_names.push(expected_pack_id.as_str().to_owned());
                }

                let version = resolved_version.expect("non-empty packs");
                let combined_manifest = RuntimeManifest {
                    schema_version: 2,
                    version: version.clone(),
                    platform: host_platform().to_owned(),
                    arch: host_arch().to_owned(),
                    asset: host_asset,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    installed_packs: installed_pack_names,
                    components,
                    paths: RuntimeManifestPaths {
                        bin: provided_paths
                            .get("bin")
                            .cloned()
                            .unwrap_or_else(|| "dependencies/bin".to_owned()),
                        node: provided_paths
                            .get("node")
                            .cloned()
                            .unwrap_or_else(|| "dependencies/node/bin/node".to_owned()),
                        python: provided_paths
                            .get("python")
                            .cloned()
                            .unwrap_or_else(|| "dependencies/python/bin/python3".to_owned()),
                        git: provided_paths.get("git").cloned(),
                        node_modules: provided_paths
                            .get("nodeModules")
                            .cloned()
                            .unwrap_or_else(|| "node_modules".to_owned()),
                        node_resolver: provided_paths
                            .get("nodeResolver")
                            .cloned()
                            .unwrap_or_else(|| "cowork/node-resolver/register.mjs".to_owned()),
                        poppler_bin: provided_paths.get("popplerBin").cloned(),
                        pdftoppm: provided_paths.get("pdftoppm").cloned(),
                        pdfinfo: provided_paths.get("pdfinfo").cloned(),
                        libreoffice: provided_paths.get("libreoffice").cloned(),
                        soffice: provided_paths.get("soffice").cloned(),
                        libreoffice_binary: provided_paths.get("libreofficeBinary").cloned(),
                        uv: provided_paths.get("uv").cloned(),
                        wheelhouse: provided_paths.get("wheelhouse").cloned(),
                    },
                    python_packages: Vec::new(),
                    node_packages: Vec::new(),
                    system_tools: Vec::new(),
                    trusted_symlinks,
                };

                std::fs::write(
                    merged_dir.join("runtime.json"),
                    serde_json::to_vec_pretty(&combined_manifest).unwrap(),
                )?;

                let final_dir = rt_root.join(&version);
                if final_dir.exists() {
                    if has_active_consumer_lease(&final_dir) {
                        return Err(EnvError::Lock(format!(
                            "Cannot overwrite active leased runtime {}",
                            final_dir.display()
                        )));
                    }
                    remove_sealed_tree(&final_dir)?;
                }

                std::fs::rename(&merged_dir, &final_dir)?;
                seal_tree_readonly(&final_dir)?;
                let final_verified =
                    verify_installed_runtime(&final_dir, &opts.trusted_keys, true)?;

                write_current_pointer(
                    &rt_root,
                    &InstalledRuntimePointer {
                        version: final_verified.version.clone(),
                        asset: final_verified.asset.clone(),
                        installed_at: chrono::Utc::now().to_rfc3339(),
                        runtime_dir: final_verified.root_dir.to_string_lossy().into_owned(),
                        installed_packs: final_verified.installed_packs.clone(),
                    },
                )?;
                let _ = prune_installed_runtimes(&opts.homedir, opts.keep_versions);
                if let Some(cb) = &opts.on_progress {
                    cb(StartupProgressEvent::ready(&final_verified.version));
                }
                Ok(final_verified)
            })();

            if workspace_staging.exists() {
                let _ = remove_sealed_tree(&workspace_staging);
            }
            res
        },
    )
}

/// Options for `ensure_cowork_runtime_ready`.
#[derive(Clone)]
pub struct EnsureRuntimeOptions {
    pub homedir: PathBuf,
    pub env: HashMap<String, String>,
    pub trusted_keys: TrustedKeyRing,
    pub on_progress: Option<RuntimeProgressCallback>,
}

fn env_truthy(env: &HashMap<String, String>, key: &str) -> bool {
    matches!(
        env.get(key)
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Ensures the Cowork runtime is verified and ready without blocking Tokio async worker threads.
///
/// Honors `COWORK_DISABLE_RUNTIME`, `COWORK_RUNTIME_DIR`, `COWORK_RUNTIME_ARCHIVE_PATH`,
/// `COWORK_RUNTIME_ARCHIVE_SHA256`, `COWORK_RUNTIME_VERSION`, `COWORK_RUNTIME_FORCE`,
/// `COWORK_RUNTIME_FULL_VERIFY`, and fails closed offline unless `COWORK_RUNTIME_ALLOW_NETWORK=1`.
pub async fn ensure_cowork_runtime_ready(opts: EnsureRuntimeOptions) -> Result<PreparedRuntime> {
    if env_truthy(&opts.env, "COWORK_DISABLE_RUNTIME") {
        return Err(EnvError::RuntimeDisabled);
    }

    tokio::task::spawn_blocking(move || {
        let force_full = env_truthy(&opts.env, "COWORK_RUNTIME_FULL_VERIFY");
        let force_reinstall = env_truthy(&opts.env, "COWORK_RUNTIME_FORCE");
        let expected_version = opts
            .env
            .get("COWORK_RUNTIME_VERSION")
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());

        if let Some(dir_raw) = opts
            .env
            .get("COWORK_RUNTIME_DIR")
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let dir = PathBuf::from(dir_raw);
            let verified = verify_installed_runtime(&dir, &opts.trusted_keys, force_full)?;
            if let Some(cb) = &opts.on_progress {
                cb(StartupProgressEvent::ready(&verified.version));
            }
            return Ok(verified);
        }

        if let Some(archive_raw) = opts
            .env
            .get("COWORK_RUNTIME_ARCHIVE_PATH")
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let archive_path = PathBuf::from(archive_raw);
            let install_opts = RuntimeInstallOptions {
                homedir: opts.homedir.clone(),
                trusted_keys: opts.trusted_keys.clone(),
                expected_version,
                expected_archive_sha256: opts.env.get("COWORK_RUNTIME_ARCHIVE_SHA256").cloned(),
                force: force_reinstall,
                keep_versions: 2,
                on_progress: opts.on_progress.clone(),
            };
            return match detect_archive_format(&archive_path)? {
                ArchiveFormat::V1Zip => install_v1_zip_runtime(&archive_path, &install_opts),
                ArchiveFormat::V2TarZst => {
                    install_v2_pack_set(&[(RuntimePackId::Core, &archive_path)], &install_opts)
                }
            };
        }

        if !force_reinstall
            && let Some(pointer) = read_current_pointer(&opts.homedir)
            && expected_version
                .as_ref()
                .is_none_or(|v| v == &pointer.version)
        {
            let dir = PathBuf::from(&pointer.runtime_dir);
            if dir.is_dir()
                && let Ok(verified) = verify_installed_runtime(&dir, &opts.trusted_keys, force_full)
            {
                if let Some(cb) = &opts.on_progress {
                    cb(StartupProgressEvent::ready(&verified.version));
                }
                return Ok(verified);
            }
        }

        if !env_truthy(&opts.env, "COWORK_RUNTIME_ALLOW_NETWORK") {
            return Err(EnvError::NetworkDisabled(format!(
                "No verified runtime found under {}",
                runtime_root_dir(&opts.homedir).display()
            )));
        }

        Err(EnvError::NetworkDisabled(
            "Online GitHub release download was not configured with an archive source".to_owned(),
        ))
    })
    .await
    .map_err(|e| EnvError::Lock(format!("Runtime bootstrap join failure: {e}")))?
}

fn collect_integrity_entries_parallel(
    root: &Path,
    excluded: &HashSet<&str>,
) -> Result<(Vec<IntegrityFileEntry>, Vec<String>)> {
    let mut disk_entries: Vec<(String, PathBuf, bool)> = Vec::new();
    let mut trusted_symlinks: Vec<String> = Vec::new();

    for item in WalkDir::new(root).follow_links(false) {
        let de = item.map_err(|e| EnvError::Archive(format!("Fixture walk failed: {e}")))?;
        if de.path() == root {
            continue;
        }
        let rel = de
            .path()
            .strip_prefix(root)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let clean = assert_safe_relative_runtime_path(&rel, "fixture entry")?;
        if excluded.contains(clean.as_str()) {
            continue;
        }
        let ft = de.file_type();
        if ft.is_dir() {
            continue;
        }
        if ft.is_symlink() {
            trusted_symlinks.push(clean.clone());
            disk_entries.push((clean, de.path().to_path_buf(), true));
        } else if ft.is_file() {
            disk_entries.push((clean, de.path().to_path_buf(), false));
        }
    }

    disk_entries.sort_by(|a, b| a.0.cmp(&b.0));
    trusted_symlinks.sort();

    let files = disk_entries
        .par_iter()
        .map(|(rel, full, is_link)| -> Result<IntegrityFileEntry> {
            if *is_link {
                let target = std::fs::read_link(full)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let (sha256, blake3, size) = hash_bytes_dual(target.as_bytes());
                Ok(IntegrityFileEntry {
                    path: rel.clone(),
                    kind: IntegrityEntryKind::Symlink,
                    size,
                    sha256: Some(sha256),
                    blake3: Some(blake3),
                })
            } else {
                let (sha256, blake3, size) = hash_regular_file(full)?;
                Ok(IntegrityFileEntry {
                    path: rel.clone(),
                    kind: IntegrityEntryKind::File,
                    size,
                    sha256: Some(sha256),
                    blake3: Some(blake3),
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;

    Ok((files, trusted_symlinks))
}

fn sign_bytes_envelope(
    bytes: &[u8],
    key_id: &str,
    signing_key: &SigningKey,
) -> RuntimeSignatureEnvelope {
    let sig = signing_key.sign(bytes);
    RuntimeSignatureEnvelope {
        schema_version: 1,
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        signature: BASE64.encode(&sig.to_bytes()),
    }
}

fn detect_staging_manifest_paths(staging: &Path) -> RuntimeManifestPaths {
    let pick = |rel: &str| staging.join(rel).exists().then(|| rel.to_owned());
    let poppler_bin = staging
        .join("dependencies/poppler/bin")
        .is_dir()
        .then(|| "dependencies/poppler/bin".to_owned());
    let libreoffice = staging
        .join("dependencies/libreoffice")
        .is_dir()
        .then(|| "dependencies/libreoffice".to_owned());
    let wheelhouse = staging.join("wheels").is_dir().then(|| "wheels".to_owned());

    RuntimeManifestPaths {
        bin: "dependencies/bin".to_owned(),
        node: "dependencies/node/bin/node".to_owned(),
        python: "dependencies/python/bin/python3".to_owned(),
        git: pick("dependencies/git/bin/git"),
        node_modules: "node_modules".to_owned(),
        node_resolver: "cowork/node-resolver/register.mjs".to_owned(),
        poppler_bin,
        pdftoppm: pick("dependencies/poppler/bin/pdftoppm"),
        pdfinfo: pick("dependencies/poppler/bin/pdfinfo"),
        libreoffice,
        soffice: pick("dependencies/bin/soffice"),
        libreoffice_binary: pick("dependencies/libreoffice/program/soffice"),
        uv: pick("dependencies/bin/uv"),
        wheelhouse,
    }
}

/// Builds a signed v1 `.zip` Cowork runtime archive from `staging_dir` for packaging or deterministic offline tests.
pub fn build_signed_v1_zip_fixture(
    staging_dir: &Path,
    version: &str,
    asset: &str,
    key_id: &str,
    signing_key: &SigningKey,
    output_zip_path: &Path,
) -> Result<()> {
    let tmp_build = staging_dir
        .parent()
        .unwrap_or(staging_dir)
        .join(format!(".v1-zip-build-{}", Uuid::new_v4().simple()));
    copy_dir_tree_preserving_symlinks(staging_dir, &tmp_build, &HashSet::new())?;

    let (_, symlinks_pre) = collect_integrity_entries_parallel(&tmp_build, &HashSet::new())?;
    let (platform, arch) = asset
        .split_once('-')
        .unwrap_or((host_platform(), host_arch()));

    let manifest = RuntimeManifest {
        schema_version: 2,
        version: version.to_owned(),
        platform: platform.to_owned(),
        arch: arch.to_owned(),
        asset: asset.to_owned(),
        created_at: "2026-06-22T00:00:00Z".to_owned(),
        installed_packs: Vec::new(),
        components: BTreeMap::new(),
        paths: detect_staging_manifest_paths(&tmp_build),
        python_packages: Vec::new(),
        node_packages: Vec::new(),
        system_tools: Vec::new(),
        trusted_symlinks: symlinks_pre,
    };
    std::fs::write(
        tmp_build.join("runtime.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;

    let excluded: HashSet<&str> = ["runtime-integrity.json", "runtime-integrity.sig"]
        .into_iter()
        .collect();
    let (files, _) = collect_integrity_entries_parallel(&tmp_build, &excluded)?;

    let integrity = RuntimeIntegrityManifest {
        schema_version: 2,
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        runtime_version: version.to_owned(),
        asset: asset.to_owned(),
        pack_id: None,
        files,
        components: BTreeMap::new(),
        entrypoints: BTreeMap::new(),
    };
    let int_bytes = serde_json::to_vec_pretty(&integrity).unwrap();
    let sig_env = sign_bytes_envelope(&int_bytes, key_id, signing_key);

    std::fs::write(tmp_build.join("runtime-integrity.json"), &int_bytes)?;
    std::fs::write(
        tmp_build.join("runtime-integrity.sig"),
        serde_json::to_vec_pretty(&sig_env).unwrap(),
    )?;

    let out_file = File::create(output_zip_path)?;
    let mut zw = zip::ZipWriter::new(out_file);

    for item in WalkDir::new(&tmp_build)
        .follow_links(false)
        .sort_by_file_name()
    {
        let de = item.unwrap();
        if de.path() == tmp_build {
            continue;
        }
        let rel = de
            .path()
            .strip_prefix(&tmp_build)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let ft = de.file_type();
        if ft.is_dir() {
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            zw.add_directory(format!("{rel}/"), opts)
                .map_err(|e| EnvError::Archive(format!("Zip dir write failed: {e}")))?;
        } else if ft.is_symlink() {
            let target = std::fs::read_link(de.path())?
                .to_string_lossy()
                .replace('\\', "/");
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o120777);
            zw.start_file(&rel, opts)
                .map_err(|e| EnvError::Archive(format!("Zip symlink write failed: {e}")))?;
            zw.write_all(target.as_bytes())?;
        } else if ft.is_file() {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                std::fs::symlink_metadata(de.path())?.permissions().mode() & 0o777
            };
            #[cfg(not(unix))]
            let mode = 0o755_u32;
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(mode);
            zw.start_file(&rel, opts)
                .map_err(|e| EnvError::Archive(format!("Zip file write failed: {e}")))?;
            let bytes = std::fs::read(de.path())?;
            zw.write_all(&bytes)?;
        }
    }
    zw.finish()
        .map_err(|e| EnvError::Archive(format!("Zip finalize failed: {e}")))?;
    let _ = std::fs::remove_dir_all(&tmp_build);
    Ok(())
}

fn belongs_to_pack(rel_path: &str, pack_id: RuntimePackId) -> bool {
    match pack_id {
        RuntimePackId::Core => {
            rel_path.starts_with("dependencies/node/")
                || rel_path.starts_with("node_modules/")
                || rel_path.starts_with("cowork/")
                || rel_path.starts_with("dependencies/git/")
                || rel_path == "dependencies/bin/uv"
        }
        RuntimePackId::PythonWheels => {
            rel_path.starts_with("dependencies/python/") || rel_path.starts_with("wheels/")
        }
        RuntimePackId::LibreOffice => {
            rel_path.starts_with("dependencies/libreoffice/")
                || rel_path.starts_with("dependencies/poppler/")
                || rel_path == "dependencies/bin/soffice"
        }
    }
}

/// Builds a signed modular v2 `.tar.zst` runtime pack (`core`, `python-wheels`, or `libreoffice`).
pub fn build_signed_v2_pack_tar_zst_fixture(
    staging_dir: &Path,
    pack_id: RuntimePackId,
    version: &str,
    asset: &str,
    key_id: &str,
    signing_key: &SigningKey,
    output_tar_zst_path: &Path,
) -> Result<()> {
    let tmp_pack = staging_dir.parent().unwrap_or(staging_dir).join(format!(
        ".v2-pack-build-{}-{}",
        pack_id.as_str(),
        Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&tmp_pack)?;

    for item in WalkDir::new(staging_dir).follow_links(false) {
        let de = item.unwrap();
        if de.path() == staging_dir || de.file_type().is_dir() {
            continue;
        }
        let rel = de
            .path()
            .strip_prefix(staging_dir)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if !belongs_to_pack(&rel, pack_id) {
            continue;
        }
        let dst = tmp_pack.join(&rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        if de.file_type().is_symlink() {
            let link_dest = std::fs::read_link(de.path())?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(link_dest, &dst)?;
            }
        } else {
            std::fs::copy(de.path(), &dst)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::symlink_metadata(de.path())?.permissions().mode();
                let mut perms = std::fs::metadata(&dst)?.permissions();
                perms.set_mode(mode & 0o777);
                std::fs::set_permissions(&dst, perms)?;
            }
        }
    }

    let excluded: HashSet<&str> = ["pack.json", "pack-integrity.json", "pack-integrity.sig"]
        .into_iter()
        .collect();
    let (files, trusted_symlinks) = collect_integrity_entries_parallel(&tmp_pack, &excluded)?;

    let mut provided_paths = BTreeMap::new();
    match pack_id {
        RuntimePackId::Core => {
            provided_paths.insert("bin".to_owned(), "dependencies/bin".to_owned());
            provided_paths.insert("node".to_owned(), "dependencies/node/bin/node".to_owned());
            provided_paths.insert("nodeModules".to_owned(), "node_modules".to_owned());
            provided_paths.insert(
                "nodeResolver".to_owned(),
                "cowork/node-resolver/register.mjs".to_owned(),
            );
            if tmp_pack.join("dependencies/bin/uv").is_file() {
                provided_paths.insert("uv".to_owned(), "dependencies/bin/uv".to_owned());
            }
        }
        RuntimePackId::PythonWheels => {
            provided_paths.insert(
                "python".to_owned(),
                "dependencies/python/bin/python3".to_owned(),
            );
            if tmp_pack.join("wheels").is_dir() {
                provided_paths.insert("wheelhouse".to_owned(), "wheels".to_owned());
            }
        }
        RuntimePackId::LibreOffice => {
            if tmp_pack.join("dependencies/libreoffice").is_dir() {
                provided_paths.insert(
                    "libreoffice".to_owned(),
                    "dependencies/libreoffice".to_owned(),
                );
            }
            if tmp_pack.join("dependencies/bin/soffice").is_file() {
                provided_paths.insert("soffice".to_owned(), "dependencies/bin/soffice".to_owned());
            }
            if tmp_pack
                .join("dependencies/libreoffice/program/soffice")
                .is_file()
            {
                provided_paths.insert(
                    "libreofficeBinary".to_owned(),
                    "dependencies/libreoffice/program/soffice".to_owned(),
                );
            }
            if tmp_pack.join("dependencies/poppler/bin").is_dir() {
                provided_paths.insert(
                    "popplerBin".to_owned(),
                    "dependencies/poppler/bin".to_owned(),
                );
            }
            if tmp_pack.join("dependencies/poppler/bin/pdftoppm").is_file() {
                provided_paths.insert(
                    "pdftoppm".to_owned(),
                    "dependencies/poppler/bin/pdftoppm".to_owned(),
                );
            }
        }
    }

    let (platform, arch) = asset
        .split_once('-')
        .unwrap_or((host_platform(), host_arch()));
    let pack_manifest = RuntimePackManifest {
        schema_version: 2,
        pack_id,
        version: version.to_owned(),
        platform: platform.to_owned(),
        arch: arch.to_owned(),
        asset: asset.to_owned(),
        created_at: "2026-07-01T00:00:00Z".to_owned(),
        components: BTreeMap::new(),
        provided_paths,
        trusted_symlinks,
    };
    let integrity = RuntimeIntegrityManifest {
        schema_version: 2,
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        runtime_version: version.to_owned(),
        asset: asset.to_owned(),
        pack_id: Some(pack_id),
        files,
        components: BTreeMap::new(),
        entrypoints: BTreeMap::new(),
    };
    let int_bytes = serde_json::to_vec_pretty(&integrity).unwrap();
    let sig_env = sign_bytes_envelope(&int_bytes, key_id, signing_key);

    std::fs::write(
        tmp_pack.join("pack.json"),
        serde_json::to_vec_pretty(&pack_manifest).unwrap(),
    )?;
    std::fs::write(tmp_pack.join("pack-integrity.json"), &int_bytes)?;
    std::fs::write(
        tmp_pack.join("pack-integrity.sig"),
        serde_json::to_vec_pretty(&sig_env).unwrap(),
    )?;

    let out_file = File::create(output_tar_zst_path)?;
    let encoder = zstd::stream::write::Encoder::new(out_file, 3)
        .map_err(|e| EnvError::Archive(format!("zstd encoder init failed: {e}")))?;
    let mut tar_builder = tar::Builder::new(encoder);
    tar_builder.follow_symlinks(false);
    tar_builder
        .append_dir_all(".", &tmp_pack)
        .map_err(|e| EnvError::Archive(format!("tar build failed: {e}")))?;
    let encoder = tar_builder
        .into_inner()
        .map_err(|e| EnvError::Archive(format!("tar finish failed: {e}")))?;
    encoder
        .finish()
        .map_err(|e| EnvError::Archive(format!("zstd finish failed: {e}")))?;

    let _ = std::fs::remove_dir_all(&tmp_pack);
    Ok(())
}
