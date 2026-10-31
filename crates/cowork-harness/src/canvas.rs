//! Canvas document persistence service (`src/server/canvasDocumentPersistence.ts` parity)
//! backing `cowork/workspace/document/{open,revision,save,saveAs,close}`.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;

use cowork_config::{ConfigError, FileLockOptions, with_file_lock};
use cowork_storage::sha256_hex;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ooxml::FileChangeVersion;

pub const CANVAS_DOCUMENT_DEFAULT_MAX_BYTES: usize = 256 * 1024;
pub const CANVAS_DOCUMENT_MAX_BYTES: usize = 5 * 1024 * 1024;

const OUTSIDE_WORKSPACE_MESSAGE: &str = "Path is outside the workspace root.";
const SESSION_NOT_FOUND_MESSAGE: &str = "The Canvas document session is no longer available.";
const CONFLICT_MESSAGE: &str = "File changed on disk. Your unsaved changes were not overwritten.";

pub type CanvasDocumentRevision = FileChangeVersion;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocumentOpenRequest {
    pub path: String,
    pub document_id: String,
    pub generation: u64,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocumentSessionRef {
    pub document_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocumentSaveRequest {
    pub document_id: String,
    pub generation: u64,
    pub edit_revision: u64,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocumentSaveAsRequest {
    pub document_id: String,
    pub generation: u64,
    pub edit_revision: u64,
    pub content: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocumentSnapshot {
    pub document_id: String,
    pub generation: u64,
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub revision: CanvasDocumentRevision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasErrorPayload {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CanvasDocumentOpenResult {
    Ok {
        ok: bool,
        document: CanvasDocumentSnapshot,
    },
    Err {
        ok: bool,
        #[serde(rename = "documentId")]
        document_id: String,
        generation: u64,
        path: String,
        error: CanvasErrorPayload,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CanvasDocumentRevisionResult {
    Ok {
        ok: bool,
        #[serde(rename = "documentId")]
        document_id: String,
        generation: u64,
        path: String,
        revision: CanvasDocumentRevision,
    },
    Err {
        ok: bool,
        #[serde(rename = "documentId")]
        document_id: String,
        generation: u64,
        error: CanvasErrorPayload,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CanvasDocumentSaveResult {
    Ok {
        ok: bool,
        #[serde(rename = "documentId")]
        document_id: String,
        generation: u64,
        #[serde(rename = "editRevision")]
        edit_revision: u64,
        path: String,
        revision: CanvasDocumentRevision,
        status: String,
    },
    Err {
        ok: bool,
        #[serde(rename = "documentId")]
        document_id: String,
        generation: u64,
        #[serde(rename = "editRevision")]
        edit_revision: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(rename = "currentRevision", skip_serializing_if = "Option::is_none")]
        current_revision: Option<CanvasDocumentRevision>,
        error: CanvasErrorPayload,
    },
}

impl CanvasDocumentSaveResult {
    pub fn saved_file(&self) -> Option<(&str, &CanvasDocumentRevision)> {
        match self {
            Self::Ok {
                ok: true,
                path,
                revision,
                status,
                ..
            } if status == "saved" => Some((path.as_str(), revision)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocumentCloseResult {
    pub ok: bool,
    pub document_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone)]
struct CanvasSessionEntry {
    workspace_root: PathBuf,
    path: PathBuf,
    base_revision: CanvasDocumentRevision,
    highest_requested_edit_revision: u64,
}

#[derive(Debug)]
enum CanvasOpError {
    NotFound,
    OutsideWorkspace,
    Conflict,
    AlreadyExists,
    Io(String),
}

impl From<ConfigError> for CanvasOpError {
    fn from(e: ConfigError) -> Self {
        Self::Io(e.to_string())
    }
}

pub struct CanvasDocumentPersistenceService {
    cowork_home: PathBuf,
    sessions: Mutex<HashMap<String, CanvasSessionEntry>>,
    session_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    path_locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl CanvasDocumentPersistenceService {
    pub fn new(cowork_home: impl Into<PathBuf>) -> Self {
        Self {
            cowork_home: cowork_home.into(),
            sessions: Mutex::new(HashMap::new()),
            session_locks: Mutex::new(HashMap::new()),
            path_locks: Mutex::new(HashMap::new()),
        }
    }

    fn session_key(document_id: &str, generation: u64) -> String {
        format!("{document_id}:{generation}")
    }

    fn session_mutex(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.session_locks.lock();
        Arc::clone(
            map.entry(key.to_owned())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    fn path_mutex(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.path_locks.lock();
        Arc::clone(
            map.entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    fn lock_options(&self) -> FileLockOptions {
        let lock_root = self.cowork_home.join("locks").join("canvas");
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        }
    }

    pub async fn open(
        &self,
        server_workspace_root: &Path,
        req: CanvasDocumentOpenRequest,
    ) -> CanvasDocumentOpenResult {
        let max_bytes = req
            .max_bytes
            .unwrap_or(CANVAS_DOCUMENT_DEFAULT_MAX_BYTES)
            .min(CANVAS_DOCUMENT_MAX_BYTES);
        let root_owned = server_workspace_root.to_path_buf();
        let req_path = req.path.clone();

        let res = tokio::task::spawn_blocking(
            move || -> Result<(PathBuf, PathBuf, StableFileRead), CanvasOpError> {
                let (ws_root, resolved) = resolve_existing_workspace_file(&root_owned, &req_path)?;
                let snapshot = read_stable_file(&resolved, max_bytes)?;
                Ok((ws_root, resolved, snapshot))
            },
        )
        .await
        .map_err(|e| CanvasOpError::Io(e.to_string()))
        .and_then(|r| r);

        match res {
            Ok((ws_root, resolved, snapshot)) => {
                let key = Self::session_key(&req.document_id, req.generation);
                self.sessions.lock().insert(
                    key,
                    CanvasSessionEntry {
                        workspace_root: ws_root,
                        path: resolved.clone(),
                        base_revision: snapshot.revision.clone(),
                        highest_requested_edit_revision: 0,
                    },
                );
                CanvasDocumentOpenResult::Ok {
                    ok: true,
                    document: CanvasDocumentSnapshot {
                        document_id: req.document_id,
                        generation: req.generation,
                        path: resolved.to_string_lossy().into_owned(),
                        content: snapshot.content,
                        truncated: snapshot.truncated,
                        revision: snapshot.revision,
                    },
                }
            }
            Err(err) => {
                let (kind, message) = match err {
                    CanvasOpError::NotFound => ("not_found", "File was not found.".to_owned()),
                    CanvasOpError::OutsideWorkspace => {
                        ("outside_workspace", OUTSIDE_WORKSPACE_MESSAGE.to_owned())
                    }
                    CanvasOpError::Io(m) => ("read_error", m),
                    CanvasOpError::Conflict | CanvasOpError::AlreadyExists => {
                        ("read_error", CONFLICT_MESSAGE.to_owned())
                    }
                };
                CanvasDocumentOpenResult::Err {
                    ok: false,
                    document_id: req.document_id,
                    generation: req.generation,
                    path: req.path,
                    error: CanvasErrorPayload {
                        kind: kind.to_owned(),
                        message,
                    },
                }
            }
        }
    }

    pub async fn revision(
        &self,
        server_workspace_root: &Path,
        req: CanvasDocumentSessionRef,
    ) -> CanvasDocumentRevisionResult {
        let key = Self::session_key(&req.document_id, req.generation);
        let Some(session) = self.sessions.lock().get(&key).cloned() else {
            return CanvasDocumentRevisionResult::Err {
                ok: false,
                document_id: req.document_id,
                generation: req.generation,
                error: CanvasErrorPayload {
                    kind: "session_not_found".to_owned(),
                    message: SESSION_NOT_FOUND_MESSAGE.to_owned(),
                },
            };
        };

        let server_ws = server_workspace_root.to_path_buf();
        let res = tokio::task::spawn_blocking(
            move || -> Result<(PathBuf, CanvasDocumentRevision), CanvasOpError> {
                assert_session_workspace(&server_ws, &session.workspace_root)?;
                revalidate_existing_workspace_file(&session.workspace_root, &session.path)?;
                let rev = read_file_revision(&session.path)?;
                Ok((session.path, rev))
            },
        )
        .await
        .map_err(|e| CanvasOpError::Io(e.to_string()))
        .and_then(|r| r);

        match res {
            Ok((path, revision)) => CanvasDocumentRevisionResult::Ok {
                ok: true,
                document_id: req.document_id,
                generation: req.generation,
                path: path.to_string_lossy().into_owned(),
                revision,
            },
            Err(err) => {
                let (kind, message) = match err {
                    CanvasOpError::OutsideWorkspace => {
                        ("outside_workspace", OUTSIDE_WORKSPACE_MESSAGE.to_owned())
                    }
                    CanvasOpError::NotFound => ("read_error", "File was not found.".to_owned()),
                    CanvasOpError::Io(m) => ("read_error", m),
                    CanvasOpError::Conflict | CanvasOpError::AlreadyExists => {
                        ("read_error", CONFLICT_MESSAGE.to_owned())
                    }
                };
                CanvasDocumentRevisionResult::Err {
                    ok: false,
                    document_id: req.document_id,
                    generation: req.generation,
                    error: CanvasErrorPayload {
                        kind: kind.to_owned(),
                        message,
                    },
                }
            }
        }
    }

    pub async fn save(
        &self,
        server_workspace_root: &Path,
        req: CanvasDocumentSaveRequest,
    ) -> CanvasDocumentSaveResult {
        let key = Self::session_key(&req.document_id, req.generation);
        {
            let mut sessions = self.sessions.lock();
            let Some(entry) = sessions.get_mut(&key) else {
                return session_not_found_save_result(
                    &req.document_id,
                    req.generation,
                    req.edit_revision,
                );
            };
            entry.highest_requested_edit_revision =
                entry.highest_requested_edit_revision.max(req.edit_revision);
        }

        let s_mutex = self.session_mutex(&key);
        let _s_guard = s_mutex.lock().await;

        let current_session = {
            let sessions = self.sessions.lock();
            match sessions.get(&key).cloned() {
                Some(s) => s,
                None => {
                    return session_not_found_save_result(
                        &req.document_id,
                        req.generation,
                        req.edit_revision,
                    );
                }
            }
        };

        if let Err(err) =
            assert_session_workspace(server_workspace_root, &current_session.workspace_root)
        {
            return save_failure_result(
                &req.document_id,
                req.generation,
                req.edit_revision,
                Some(&current_session.path),
                err,
            );
        }

        if req.edit_revision < current_session.highest_requested_edit_revision {
            return CanvasDocumentSaveResult::Ok {
                ok: true,
                document_id: req.document_id,
                generation: req.generation,
                edit_revision: req.edit_revision,
                path: current_session.path.to_string_lossy().into_owned(),
                revision: current_session.base_revision,
                status: "superseded".to_owned(),
            };
        }

        let p_mutex = self.path_mutex(&current_session.path);
        let _p_guard = p_mutex.lock().await;
        let lock_opts = self.lock_options();
        let target_path = current_session.path.clone();
        let ws_root = current_session.workspace_root.clone();
        let expected_rev = current_session.base_revision.clone();
        let content = req.content;

        let write_res = with_file_lock(
            &target_path,
            || {
                let p = target_path.clone();
                let w = ws_root.clone();
                let exp = expected_rev.clone();
                let c = content.clone();
                async move {
                    tokio::task::spawn_blocking(move || replace_file_atomically(&w, &p, &c, &exp))
                        .await
                        .map_err(|e| CanvasOpError::Io(e.to_string()))?
                }
            },
            lock_opts,
        )
        .await;

        match write_res {
            Ok(revision) => {
                if let Some(entry) = self.sessions.lock().get_mut(&key) {
                    entry.base_revision = revision.clone();
                }
                CanvasDocumentSaveResult::Ok {
                    ok: true,
                    document_id: req.document_id,
                    generation: req.generation,
                    edit_revision: req.edit_revision,
                    path: current_session.path.to_string_lossy().into_owned(),
                    revision,
                    status: "saved".to_owned(),
                }
            }
            Err(err) => save_failure_result(
                &req.document_id,
                req.generation,
                req.edit_revision,
                Some(&current_session.path),
                err,
            ),
        }
    }

    pub async fn save_as(
        &self,
        server_workspace_root: &Path,
        req: CanvasDocumentSaveAsRequest,
    ) -> CanvasDocumentSaveResult {
        let key = Self::session_key(&req.document_id, req.generation);
        {
            let mut sessions = self.sessions.lock();
            let Some(entry) = sessions.get_mut(&key) else {
                return session_not_found_save_result(
                    &req.document_id,
                    req.generation,
                    req.edit_revision,
                );
            };
            entry.highest_requested_edit_revision =
                entry.highest_requested_edit_revision.max(req.edit_revision);
        }

        let s_mutex = self.session_mutex(&key);
        let _s_guard = s_mutex.lock().await;

        let current_session = {
            let sessions = self.sessions.lock();
            match sessions.get(&key).cloned() {
                Some(s) => s,
                None => {
                    return session_not_found_save_result(
                        &req.document_id,
                        req.generation,
                        req.edit_revision,
                    );
                }
            }
        };

        if let Err(err) =
            assert_session_workspace(server_workspace_root, &current_session.workspace_root)
        {
            return save_failure_result(
                &req.document_id,
                req.generation,
                req.edit_revision,
                Some(&current_session.path),
                err,
            );
        }

        if req.edit_revision < current_session.highest_requested_edit_revision {
            return CanvasDocumentSaveResult::Ok {
                ok: true,
                document_id: req.document_id,
                generation: req.generation,
                edit_revision: req.edit_revision,
                path: current_session.path.to_string_lossy().into_owned(),
                revision: current_session.base_revision,
                status: "superseded".to_owned(),
            };
        }

        let target_path =
            match resolve_new_workspace_file(&current_session.workspace_root, &req.path) {
                Ok((_, p)) => p,
                Err(err) => {
                    let (kind, msg) = match err {
                        CanvasOpError::OutsideWorkspace => {
                            ("outside_workspace", OUTSIDE_WORKSPACE_MESSAGE.to_owned())
                        }
                        CanvasOpError::NotFound => {
                            ("write_error", "Target directory was not found.".to_owned())
                        }
                        CanvasOpError::Io(m) => ("write_error", m),
                        CanvasOpError::Conflict | CanvasOpError::AlreadyExists => {
                            ("conflict", CONFLICT_MESSAGE.to_owned())
                        }
                    };
                    return CanvasDocumentSaveResult::Err {
                        ok: false,
                        document_id: req.document_id,
                        generation: req.generation,
                        edit_revision: req.edit_revision,
                        path: Some(req.path),
                        current_revision: None,
                        error: CanvasErrorPayload {
                            kind: kind.to_owned(),
                            message: msg,
                        },
                    };
                }
            };

        let p_mutex = self.path_mutex(&target_path);
        let _p_guard = p_mutex.lock().await;
        let lock_opts = self.lock_options();
        let ws_root = current_session.workspace_root.clone();
        let req_path_str = req.path.clone();
        let content = req.content;
        let target_clone = target_path.clone();

        let write_res = with_file_lock(
            &target_path,
            || {
                let w = ws_root.clone();
                let rp = req_path_str.clone();
                let tp = target_clone.clone();
                let c = content.clone();
                async move {
                    tokio::task::spawn_blocking(move || create_file_atomically(&w, &rp, &tp, &c))
                        .await
                        .map_err(|e| CanvasOpError::Io(e.to_string()))?
                }
            },
            lock_opts,
        )
        .await;

        match write_res {
            Ok(revision) => {
                if let Some(entry) = self.sessions.lock().get_mut(&key) {
                    entry.path = target_path.clone();
                    entry.base_revision = revision.clone();
                }
                CanvasDocumentSaveResult::Ok {
                    ok: true,
                    document_id: req.document_id,
                    generation: req.generation,
                    edit_revision: req.edit_revision,
                    path: target_path.to_string_lossy().into_owned(),
                    revision,
                    status: "saved".to_owned(),
                }
            }
            Err(err) => save_failure_result(
                &req.document_id,
                req.generation,
                req.edit_revision,
                Some(&target_path),
                err,
            ),
        }
    }

    pub async fn close(
        &self,
        server_workspace_root: &Path,
        req: CanvasDocumentSessionRef,
    ) -> Result<CanvasDocumentCloseResult, String> {
        let key = Self::session_key(&req.document_id, req.generation);
        let s_mutex = self.session_mutex(&key);
        let _s_guard = s_mutex.lock().await;
        let maybe_session = self.sessions.lock().get(&key).cloned();
        if let Some(session) = maybe_session {
            assert_session_workspace(server_workspace_root, &session.workspace_root)
                .map_err(|_| OUTSIDE_WORKSPACE_MESSAGE.to_owned())?;
            self.sessions.lock().remove(&key);
        }
        Ok(CanvasDocumentCloseResult {
            ok: true,
            document_id: req.document_id,
            generation: req.generation,
        })
    }
}

fn session_not_found_save_result(
    document_id: &str,
    generation: u64,
    edit_revision: u64,
) -> CanvasDocumentSaveResult {
    CanvasDocumentSaveResult::Err {
        ok: false,
        document_id: document_id.to_owned(),
        generation,
        edit_revision,
        path: None,
        current_revision: None,
        error: CanvasErrorPayload {
            kind: "session_not_found".to_owned(),
            message: SESSION_NOT_FOUND_MESSAGE.to_owned(),
        },
    }
}

fn save_failure_result(
    document_id: &str,
    generation: u64,
    edit_revision: u64,
    file_path: Option<&Path>,
    err: CanvasOpError,
) -> CanvasDocumentSaveResult {
    let path_str = file_path.map(|p| p.to_string_lossy().into_owned());
    match err {
        CanvasOpError::Conflict | CanvasOpError::AlreadyExists => {
            let current_revision = file_path.and_then(|p| read_file_revision(p).ok());
            CanvasDocumentSaveResult::Err {
                ok: false,
                document_id: document_id.to_owned(),
                generation,
                edit_revision,
                path: path_str,
                current_revision,
                error: CanvasErrorPayload {
                    kind: "conflict".to_owned(),
                    message: CONFLICT_MESSAGE.to_owned(),
                },
            }
        }
        CanvasOpError::OutsideWorkspace => CanvasDocumentSaveResult::Err {
            ok: false,
            document_id: document_id.to_owned(),
            generation,
            edit_revision,
            path: path_str,
            current_revision: None,
            error: CanvasErrorPayload {
                kind: "outside_workspace".to_owned(),
                message: OUTSIDE_WORKSPACE_MESSAGE.to_owned(),
            },
        },
        CanvasOpError::NotFound => CanvasDocumentSaveResult::Err {
            ok: false,
            document_id: document_id.to_owned(),
            generation,
            edit_revision,
            path: path_str,
            current_revision: None,
            error: CanvasErrorPayload {
                kind: "write_error".to_owned(),
                message: "File was not found.".to_owned(),
            },
        },
        CanvasOpError::Io(message) => CanvasDocumentSaveResult::Err {
            ok: false,
            document_id: document_id.to_owned(),
            generation,
            edit_revision,
            path: path_str,
            current_revision: None,
            error: CanvasErrorPayload {
                kind: "write_error".to_owned(),
                message,
            },
        },
    }
}

struct StableFileRead {
    content: String,
    truncated: bool,
    revision: CanvasDocumentRevision,
}

fn revision_from_meta_and_digest(meta: &fs::Metadata, digest_hex: &str) -> CanvasDocumentRevision {
    #[cfg(unix)]
    {
        let modified_at_ms =
            (meta.mtime() as f64) * 1000.0 + (meta.mtime_nsec() as f64) / 1_000_000.0;
        let change_time_ms =
            (meta.ctime() as f64) * 1000.0 + (meta.ctime_nsec() as f64) / 1_000_000.0;
        CanvasDocumentRevision {
            modified_at_ms,
            change_time_ms,
            size: meta.len(),
            fingerprint: format!("sha256:{digest_hex}"),
        }
    }
    #[cfg(not(unix))]
    {
        let modified_at_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        CanvasDocumentRevision {
            modified_at_ms,
            change_time_ms: modified_at_ms,
            size: meta.len(),
            fingerprint: format!("sha256:{digest_hex}"),
        }
    }
}

fn same_meta_snapshot(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        a.len() == b.len()
            && a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}

fn read_stable_file(path: &Path, max_bytes: usize) -> Result<StableFileRead, CanvasOpError> {
    for _ in 0..3 {
        let mut file = File::open(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CanvasOpError::NotFound
            } else {
                CanvasOpError::Io(e.to_string())
            }
        })?;
        let before = file
            .metadata()
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        if !before.is_file() {
            return Err(CanvasOpError::Io("Path is not a file.".to_owned()));
        }
        let size = before.len() as usize;
        let prefix_cap = size.min(max_bytes);
        let mut prefix = Vec::with_capacity(prefix_cap);
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut total_read = 0usize;
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| CanvasOpError::Io(e.to_string()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            if prefix.len() < prefix_cap {
                let take = n.min(prefix_cap - prefix.len());
                prefix.extend_from_slice(&buf[..take]);
            }
            total_read += n;
        }
        let after = file
            .metadata()
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        if total_read != after.len() as usize || !same_meta_snapshot(&before, &after) {
            continue;
        }
        let digest = hex::encode(hasher.finalize());
        let content = String::from_utf8_lossy(&prefix).into_owned();
        return Ok(StableFileRead {
            content,
            truncated: size > max_bytes,
            revision: revision_from_meta_and_digest(&after, &digest),
        });
    }
    Err(CanvasOpError::Io(
        "File kept changing while it was being read. Try again.".to_owned(),
    ))
}

fn read_file_revision(path: &Path) -> Result<CanvasDocumentRevision, CanvasOpError> {
    Ok(read_stable_file(path, 0)?.revision)
}

fn assert_inside_workspace(workspace_root: &Path, candidate: &Path) -> Result<(), CanvasOpError> {
    if !candidate.starts_with(workspace_root) {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(())
}

fn resolve_existing_workspace_file(
    workspace_root_input: &Path,
    file_path: &str,
) -> Result<(PathBuf, PathBuf), CanvasOpError> {
    let workspace_root =
        fs::canonicalize(workspace_root_input).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    let p = Path::new(file_path);
    let candidate = if p.is_absolute() {
        p.to_path_buf()
    } else {
        workspace_root.join(p)
    };
    let resolved = fs::canonicalize(&candidate).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CanvasOpError::NotFound
        } else {
            CanvasOpError::Io(e.to_string())
        }
    })?;
    assert_inside_workspace(&workspace_root, &resolved)?;
    Ok((workspace_root, resolved))
}

fn resolve_new_workspace_file(
    workspace_root_input: &Path,
    file_path: &str,
) -> Result<(PathBuf, PathBuf), CanvasOpError> {
    let workspace_root =
        fs::canonicalize(workspace_root_input).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    let p = Path::new(file_path);
    let candidate = if p.is_absolute() {
        cowork_config::normalize_lexical_path(p)
    } else {
        cowork_config::normalize_lexical_path(&workspace_root.join(p))
    };
    let Some(file_name) = candidate.file_name() else {
        return Err(CanvasOpError::Io("Invalid target file path.".to_owned()));
    };
    let Some(parent_raw) = candidate.parent() else {
        return Err(CanvasOpError::OutsideWorkspace);
    };
    let canonical_parent = fs::canonicalize(parent_raw).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CanvasOpError::NotFound
        } else {
            CanvasOpError::OutsideWorkspace
        }
    })?;
    let resolved = canonical_parent.join(file_name);
    assert_inside_workspace(&workspace_root, &resolved)?;
    Ok((workspace_root, resolved))
}

fn assert_session_workspace(
    server_workspace_root: &Path,
    session_workspace_root: &Path,
) -> Result<(), CanvasOpError> {
    let current =
        fs::canonicalize(server_workspace_root).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    if current != session_workspace_root {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(())
}

fn revalidate_canonical_parent(
    workspace_root: &Path,
    file_path: &Path,
) -> Result<PathBuf, CanvasOpError> {
    let current_root =
        fs::canonicalize(workspace_root).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    if current_root != workspace_root {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    let Some(expected_parent) = file_path.parent() else {
        return Err(CanvasOpError::OutsideWorkspace);
    };
    let current_parent =
        fs::canonicalize(expected_parent).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    assert_inside_workspace(workspace_root, &current_parent)?;
    if current_parent != expected_parent {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(current_parent)
}

fn revalidate_existing_workspace_file(
    workspace_root: &Path,
    file_path: &Path,
) -> Result<(), CanvasOpError> {
    revalidate_canonical_parent(workspace_root, file_path)?;
    let current_path = fs::canonicalize(file_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CanvasOpError::NotFound
        } else {
            CanvasOpError::OutsideWorkspace
        }
    })?;
    assert_inside_workspace(workspace_root, &current_path)?;
    if current_path != file_path {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    let lmeta = fs::symlink_metadata(file_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CanvasOpError::NotFound
        } else {
            CanvasOpError::OutsideWorkspace
        }
    })?;
    if lmeta.file_type().is_symlink() || !lmeta.is_file() {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(())
}

fn revalidate_new_workspace_file(
    workspace_root: &Path,
    requested_path: &str,
    expected_path: &Path,
) -> Result<(), CanvasOpError> {
    let (ws, current) = resolve_new_workspace_file(workspace_root, requested_path)?;
    if ws != workspace_root || current != expected_path {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(())
}

fn replace_file_atomically(
    workspace_root: &Path,
    file_path: &Path,
    content: &str,
    expected_revision: &CanvasDocumentRevision,
) -> Result<CanvasDocumentRevision, CanvasOpError> {
    revalidate_existing_workspace_file(workspace_root, file_path)?;
    let current_rev = read_file_revision(file_path)?;
    if current_rev.fingerprint != expected_revision.fingerprint {
        return Err(CanvasOpError::Conflict);
    }

    let parent = file_path.parent().ok_or(CanvasOpError::OutsideWorkspace)?;
    let base_name = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let temp_path = parent.join(format!(".{base_name}.{}.tmp", Uuid::new_v4()));
    let orig_meta = fs::metadata(file_path).map_err(|e| CanvasOpError::Io(e.to_string()))?;

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(orig_meta.permissions().mode() & 0o777);

    let mut tmp_file = opts
        .open(&temp_path)
        .map_err(|e| CanvasOpError::Io(e.to_string()))?;

    let commit_res = (|| -> Result<CanvasDocumentRevision, CanvasOpError> {
        tmp_file
            .write_all(content.as_bytes())
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        tmp_file
            .sync_all()
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        let staged_meta = tmp_file
            .metadata()
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        drop(tmp_file);

        let digest = sha256_hex(content.as_bytes());
        revalidate_existing_workspace_file(workspace_root, file_path)?;
        revalidate_staged_temp_file(workspace_root, &temp_path, &staged_meta, &digest)?;

        let rev_before_commit = read_file_revision(file_path)?;
        if rev_before_commit.fingerprint != expected_revision.fingerprint {
            return Err(CanvasOpError::Conflict);
        }
        revalidate_existing_workspace_file(workspace_root, file_path)?;
        fs::rename(&temp_path, file_path).map_err(|e| CanvasOpError::Io(e.to_string()))?;
        revalidate_existing_workspace_file(workspace_root, file_path)?;
        let committed_meta =
            fs::symlink_metadata(file_path).map_err(|e| CanvasOpError::Io(e.to_string()))?;
        verify_committed_identity(&committed_meta, &staged_meta)?;
        sync_directory_best_effort(parent);
        Ok(revision_from_meta_and_digest(&committed_meta, &digest))
    })();

    if commit_res.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    commit_res
}

fn create_file_atomically(
    workspace_root: &Path,
    requested_path: &str,
    file_path: &Path,
    content: &str,
) -> Result<CanvasDocumentRevision, CanvasOpError> {
    let parent = file_path.parent().ok_or(CanvasOpError::OutsideWorkspace)?;
    let base_name = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let temp_path = parent.join(format!(".{base_name}.{}.tmp", Uuid::new_v4()));

    revalidate_new_workspace_file(workspace_root, requested_path, file_path)?;
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600);

    let mut tmp_file = opts
        .open(&temp_path)
        .map_err(|e| CanvasOpError::Io(e.to_string()))?;

    let commit_res = (|| -> Result<CanvasDocumentRevision, CanvasOpError> {
        tmp_file
            .write_all(content.as_bytes())
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        tmp_file
            .sync_all()
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        let staged_meta = tmp_file
            .metadata()
            .map_err(|e| CanvasOpError::Io(e.to_string()))?;
        drop(tmp_file);

        let digest = sha256_hex(content.as_bytes());
        revalidate_new_workspace_file(workspace_root, requested_path, file_path)?;
        revalidate_staged_temp_file(workspace_root, &temp_path, &staged_meta, &digest)?;

        fs::hard_link(&temp_path, file_path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                CanvasOpError::AlreadyExists
            } else {
                CanvasOpError::Io(e.to_string())
            }
        })?;
        let _ = fs::remove_file(&temp_path);
        revalidate_existing_workspace_file(workspace_root, file_path)?;
        let committed_meta =
            fs::symlink_metadata(file_path).map_err(|e| CanvasOpError::Io(e.to_string()))?;
        verify_committed_identity(&committed_meta, &staged_meta)?;
        sync_directory_best_effort(parent);
        Ok(revision_from_meta_and_digest(&committed_meta, &digest))
    })();

    if commit_res.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    commit_res
}

fn revalidate_staged_temp_file(
    workspace_root: &Path,
    temp_path: &Path,
    expected_meta: &fs::Metadata,
    expected_digest: &str,
) -> Result<(), CanvasOpError> {
    revalidate_canonical_parent(workspace_root, temp_path)?;
    let lmeta = fs::symlink_metadata(temp_path).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    if lmeta.file_type().is_symlink() || !lmeta.is_file() {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    verify_committed_identity(&lmeta, expected_meta)?;
    let bytes = fs::read(temp_path).map_err(|_| CanvasOpError::OutsideWorkspace)?;
    if sha256_hex(&bytes) != expected_digest {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(())
}

fn verify_committed_identity(
    actual: &fs::Metadata,
    expected: &fs::Metadata,
) -> Result<(), CanvasOpError> {
    if actual.file_type().is_symlink() || !actual.is_file() || actual.len() != expected.len() {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    #[cfg(unix)]
    if actual.ino() != 0
        && expected.ino() != 0
        && (actual.dev() != expected.dev() || actual.ino() != expected.ino())
    {
        return Err(CanvasOpError::OutsideWorkspace);
    }
    Ok(())
}

fn sync_directory_best_effort(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}
