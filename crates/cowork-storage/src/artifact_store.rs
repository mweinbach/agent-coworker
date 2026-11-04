//! Content-addressed SHA-256 storage for task artifact versions (`~/.cowork/artifacts`).
//!
//! Mirrors `src/server/tasks/ArtifactVersionStore.ts`:
//! - Objects live under `<root>/objects/sha256/<2-char>/<sha256>`.
//! - Directories are hardened to `0700` and object files to `0600` on Unix.
//! - Every `put_bytes` and `read_bytes` verifies the SHA-256 digest on disk.
//! - `restore_file` optionally verifies `expected_fingerprint` before overwriting
//!   live workspace files, returning `StorageError::ArtifactFingerprintConflict`
//!   when the live file drifted externally.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{Result, StorageError};
use crate::hardening::{ensure_private_directory, harden_private_file};

#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifactBlob {
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ArtifactVersionStoreOptions {
    pub root_dir: Option<PathBuf>,
    pub homedir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct RestoreArtifactFileInput {
    pub blob_sha256: String,
    pub file_path: PathBuf,
    pub expected_fingerprint: Option<String>,
}

/// Immutable content-addressed storage for task artifact bytes.
#[derive(Debug, Clone)]
pub struct ArtifactVersionStore {
    root_dir: PathBuf,
}

impl ArtifactVersionStore {
    pub fn new(options: ArtifactVersionStoreOptions) -> Self {
        let root_dir = if let Some(root) = options.root_dir {
            root
        } else {
            let home = options
                .homedir
                .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("."));
            home.join(".cowork").join("artifacts")
        };
        Self { root_dir }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    /// Internal test/maintenance helper; never include this path in public records.
    pub fn get_blob_path(&self, blob_sha256: &str) -> Result<PathBuf> {
        self.blob_path(blob_sha256)
    }

    fn blob_path(&self, blob_sha256: &str) -> Result<PathBuf> {
        let normalized = blob_sha256.trim().to_ascii_lowercase();
        if !is_valid_sha256_hex(&normalized) {
            return Err(StorageError::Task(
                "Invalid artifact object SHA-256".to_string(),
            ));
        }
        Ok(self
            .root_dir
            .join("objects")
            .join("sha256")
            .join(&normalized[..2])
            .join(&normalized))
    }

    pub fn put_bytes_sync(&self, bytes: &[u8]) -> Result<StoredArtifactBlob> {
        let digest = sha256_hex(bytes);
        let blob_path = self.blob_path(&digest)?;

        ensure_private_directory(&self.root_dir)?;
        let objects_dir = self.root_dir.join("objects");
        ensure_private_directory(&objects_dir)?;
        let sha_dir = objects_dir.join("sha256");
        ensure_private_directory(&sha_dir)?;
        if let Some(parent) = blob_path.parent() {
            ensure_private_directory(parent)?;
        }

        if blob_path.exists() {
            let existing = fs::read(&blob_path)?;
            if sha256_hex(&existing) != digest {
                return Err(StorageError::Task(format!(
                    "Artifact object failed integrity validation: {digest}"
                )));
            }
            harden_private_file(&blob_path);
            return Ok(StoredArtifactBlob {
                sha256: digest,
                size_bytes: existing.len() as u64,
            });
        }

        let parent = blob_path
            .parent()
            .ok_or_else(|| StorageError::InvalidPath("Invalid artifact blob parent".to_string()))?;
        let temp_path = parent.join(format!(
            ".{digest}.{}.{}.tmp",
            std::process::id(),
            Uuid::new_v4()
        ));

        let write_result = (|| -> Result<()> {
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            opts.mode(PRIVATE_FILE_MODE);
            let mut file = opts.open(&temp_path)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);

            match fs::hard_link(&temp_path, &blob_path) {
                Ok(()) => {
                    harden_private_file(&blob_path);
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => {
                    // Fallback to atomic rename if hard_link is unsupported on the filesystem.
                    if !blob_path.exists() {
                        match fs::rename(&temp_path, &blob_path) {
                            Ok(()) => {
                                harden_private_file(&blob_path);
                            }
                            Err(rename_err)
                                if rename_err.kind() == std::io::ErrorKind::AlreadyExists
                                    || blob_path.exists() => {}
                            Err(rename_err) => return Err(StorageError::Io(rename_err)),
                        }
                    }
                }
            }
            Ok(())
        })();

        let _ = fs::remove_file(&temp_path);
        write_result?;

        let persisted = fs::read(&blob_path)?;
        if sha256_hex(&persisted) != digest {
            return Err(StorageError::Task(format!(
                "Artifact object failed integrity validation: {digest}"
            )));
        }
        harden_private_file(&blob_path);
        Ok(StoredArtifactBlob {
            sha256: digest,
            size_bytes: persisted.len() as u64,
        })
    }

    pub async fn put_bytes(&self, bytes: Vec<u8>) -> Result<StoredArtifactBlob> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.put_bytes_sync(&bytes))
            .await
            .map_err(|e| StorageError::Task(format!("Artifact put_bytes join error: {e}")))?
    }

    pub fn capture_file_sync(&self, file_path: &Path) -> Result<StoredArtifactBlob> {
        let bytes = fs::read(file_path)?;
        self.put_bytes_sync(&bytes)
    }

    pub async fn capture_file(&self, file_path: PathBuf) -> Result<StoredArtifactBlob> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.capture_file_sync(&file_path))
            .await
            .map_err(|e| StorageError::Task(format!("Artifact capture_file join error: {e}")))?
    }

    pub fn fingerprint_file_sync(&self, file_path: &Path) -> Result<Option<StoredArtifactBlob>> {
        let meta = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(StorageError::Io(err)),
        };
        if !meta.is_file() {
            return Err(StorageError::Task(format!(
                "Artifact is not a file: {}",
                file_path.display()
            )));
        }
        let mut file = File::open(file_path)?;
        let mut hasher = Sha256::new();
        let mut size_bytes: u64 = 0;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size_bytes += n as u64;
        }
        Ok(Some(StoredArtifactBlob {
            sha256: hex::encode(hasher.finalize()),
            size_bytes,
        }))
    }

    pub async fn fingerprint_file(&self, file_path: PathBuf) -> Result<Option<StoredArtifactBlob>> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.fingerprint_file_sync(&file_path))
            .await
            .map_err(|e| StorageError::Task(format!("Artifact fingerprint_file join error: {e}")))?
    }

    pub fn read_bytes_sync(&self, blob_sha256: &str) -> Result<Vec<u8>> {
        let normalized = blob_sha256.trim().to_ascii_lowercase();
        let blob_path = self.blob_path(&normalized)?;
        let bytes = fs::read(&blob_path)?;
        if sha256_hex(&bytes) != normalized {
            return Err(StorageError::Task(format!(
                "Artifact object failed integrity validation: {normalized}"
            )));
        }
        Ok(bytes)
    }

    pub async fn read_bytes(&self, blob_sha256: String) -> Result<Vec<u8>> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.read_bytes_sync(&blob_sha256))
            .await
            .map_err(|e| StorageError::Task(format!("Artifact read_bytes join error: {e}")))?
    }

    pub fn restore_file_sync(
        &self,
        input: &RestoreArtifactFileInput,
    ) -> Result<StoredArtifactBlob> {
        if let Some(expected) = &input.expected_fingerprint {
            let current = self.fingerprint_file_sync(&input.file_path)?;
            let actual_sha = current.as_ref().map(|b| b.sha256.clone());
            if actual_sha.as_deref() != Some(expected.as_str()) {
                return Err(StorageError::ArtifactFingerprintConflict {
                    expected_fingerprint: expected.clone(),
                    actual_fingerprint: actual_sha,
                });
            }
        }

        let normalized = input.blob_sha256.trim().to_ascii_lowercase();
        let bytes = self.read_bytes_sync(&normalized)?;
        let parent = input.file_path.parent().ok_or_else(|| {
            StorageError::InvalidPath(format!(
                "Invalid artifact target path: {}",
                input.file_path.display()
            ))
        })?;
        fs::create_dir_all(parent)?;

        #[cfg(unix)]
        let existing_mode = fs::metadata(&input.file_path)
            .ok()
            .map(|m| m.permissions().mode());

        let file_name = input
            .file_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "artifact".to_string());
        let temp_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));

        let copy_res = (|| -> Result<()> {
            fs::write(&temp_path, &bytes)?;
            fs::copy(&temp_path, &input.file_path)?;
            #[cfg(unix)]
            if let Some(mode) = existing_mode {
                let _ = fs::set_permissions(&input.file_path, fs::Permissions::from_mode(mode));
            }
            Ok(())
        })();

        let _ = fs::remove_file(&temp_path);
        copy_res?;

        Ok(StoredArtifactBlob {
            sha256: normalized,
            size_bytes: bytes.len() as u64,
        })
    }

    pub async fn restore_file(
        &self,
        input: RestoreArtifactFileInput,
    ) -> Result<StoredArtifactBlob> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.restore_file_sync(&input))
            .await
            .map_err(|e| StorageError::Task(format!("Artifact restore_file join error: {e}")))?
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
