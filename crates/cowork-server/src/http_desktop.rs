use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, StatusCode, header};
use cowork_config::{
    canonicalize_sync, ensure_private_dir_sync, get_one_off_chats_root,
    is_path_inside_one_off_chats_root, write_text_file_atomic,
};
use cowork_protocol::JsonRpcWorkspaceSummary;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::startup::MobileH3AdminState;

const MAX_TRANSCRIPT_BATCH_RAW_BYTES: usize = 278_528;
const MAX_TRANSCRIPT_BATCH_EVENTS_BYTES: usize = 262_144;
const MAX_TRANSCRIPT_BATCH_COUNT: usize = 100;

pub fn fnv1a32_hex(input: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in input.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

pub fn resolve_user_data_dir(homedir: &Path, env: &HashMap<String, String>) -> PathBuf {
    if let Some(override_dir) = env
        .get("COWORK_DESKTOP_USER_DATA_DIR")
        .or_else(|| env.get("COWORK_ELECTRON_USER_DATA_DIR"))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(override_dir);
    }
    if cfg!(target_os = "macos") {
        homedir
            .join("Library")
            .join("Application Support")
            .join("Cowork")
    } else if cfg!(target_os = "windows") {
        env.get("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| homedir.join("AppData").join("Roaming"))
            .join("Cowork")
    } else {
        env.get("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| homedir.join(".config"))
            .join("Cowork")
    }
}

/// Manages `<userDataDir>/state.json`, one-off chat workspaces, and transcript JSONL persistence when `COWORK_WEB_DESKTOP_SERVICE=1`.
#[derive(Debug)]
pub struct WebDesktopService {
    homedir: PathBuf,
    user_data_dir: PathBuf,
    ws_url_for_primary: RwLockUrl,
    batch_digests: DashMap<String, String>,
}

#[derive(Debug, Default)]
struct RwLockUrl {
    inner: parking_lot::RwLock<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_enable_mcp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yolo: Option<bool>,
}

impl WebDesktopService {
    pub fn new(homedir: PathBuf, user_data_dir: PathBuf) -> Self {
        Self {
            homedir,
            user_data_dir,
            ws_url_for_primary: RwLockUrl::default(),
            batch_digests: DashMap::new(),
        }
    }

    pub fn set_primary_ws_url(&self, ws_url: String) {
        *self.ws_url_for_primary.inner.write() = ws_url;
    }

    fn state_file_path(&self) -> PathBuf {
        self.user_data_dir.join("state.json")
    }

    fn transcripts_dir(&self) -> PathBuf {
        self.user_data_dir.join("transcripts")
    }

    pub fn load_state_json(&self, fallback_cwd: &Path) -> Value {
        let path = self.state_file_path();
        let mut root = if let Ok(raw) = std::fs::read_to_string(&path)
            && let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw)
        {
            map
        } else {
            Map::new()
        };

        root.entry("version".to_owned()).or_insert_with(|| json!(1));
        root.entry("threads".to_owned())
            .or_insert_with(|| json!([]));
        root.entry("developerMode".to_owned())
            .or_insert_with(|| json!(false));
        root.entry("showHiddenFiles".to_owned())
            .or_insert_with(|| json!(false));
        root.entry("perWorkspaceSettings".to_owned())
            .or_insert_with(|| json!({}));
        root.entry("desktopSettings".to_owned())
            .or_insert_with(|| json!({}));
        root.entry("cloudSync".to_owned())
            .or_insert_with(|| json!({}));
        root.entry("desktopFeatureFlagOverrides".to_owned())
            .or_insert_with(|| json!({}));

        let has_workspaces = root
            .get("workspaces")
            .and_then(Value::as_array)
            .is_some_and(|arr| !arr.is_empty());
        if !has_workspaces {
            let fallback = fallback_workspace_entry(fallback_cwd, &self.homedir);
            root.insert(
                "workspaces".to_owned(),
                json!([serde_json::to_value(fallback).unwrap()]),
            );
        }

        Value::Object(root)
    }

    pub fn save_state_json(&self, incoming: Value, fallback_cwd: &Path) -> anyhow::Result<Value> {
        let Value::Object(mut map) = incoming else {
            anyhow::bail!("Desktop state must be a JSON object");
        };
        let existing = self.load_state_json(fallback_cwd);
        if let Value::Object(mut base) = existing {
            base.append(&mut map);
            let serialized = serde_json::to_string_pretty(&base)?;
            let _ = ensure_private_dir_sync(&self.user_data_dir);
            write_text_file_atomic(&self.state_file_path(), &serialized, Some(0o600))?;
            Ok(Value::Object(base))
        } else {
            anyhow::bail!("Invalid base state");
        }
    }

    pub fn workspace_entries(&self, fallback_cwd: &Path) -> Vec<PersistedWorkspaceEntry> {
        let state = self.load_state_json(fallback_cwd);
        state
            .get("workspaces")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        serde_json::from_value::<PersistedWorkspaceEntry>(v.clone()).ok()
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| vec![fallback_workspace_entry(fallback_cwd, &self.homedir)])
    }

    pub fn allowed_fs_roots(&self, fallback_cwd: &Path) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self
            .workspace_entries(fallback_cwd)
            .into_iter()
            .map(|w| PathBuf::from(w.path))
            .collect();
        if !roots.iter().any(|p| p == fallback_cwd) {
            roots.push(fallback_cwd.to_path_buf());
        }
        roots.push(get_one_off_chats_root(&self.homedir));
        roots
    }

    pub fn homedir(&self) -> &Path {
        &self.homedir
    }

    pub fn ensure_workspace_for_import(
        &self,
        target_path: &Path,
        preferred_name: Option<&str>,
        fallback_cwd: &Path,
    ) -> Result<cowork_harness::importers::conversations::EnsuredWorkspaceOutcome, String> {
        let canon = canonicalize_sync(target_path);
        let canon_str = canon.to_string_lossy().into_owned();
        let mut entries = self.workspace_entries(fallback_cwd);
        if let Some(existing) = entries
            .iter()
            .find(|w| canonicalize_sync(Path::new(&w.path)) == canon)
        {
            return Ok(
                cowork_harness::importers::conversations::EnsuredWorkspaceOutcome {
                    workspace_id: Some(existing.id.clone()),
                    workspace_path: canon_str,
                    name: existing.name.clone(),
                    created: false,
                },
            );
        }

        let base_id = format!("import-{}", fnv1a32_hex(&canon_str));
        let mut id = base_id.clone();
        let mut suffix = 2_u32;
        while entries.iter().any(|w| w.id == id) {
            id = format!("{base_id}-{suffix}");
            suffix += 1;
        }
        let name = preferred_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                canon
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| canon_str.clone());
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let kind = if is_path_inside_one_off_chats_root(&canon, &self.homedir) {
            "oneOffChat"
        } else {
            "project"
        };
        entries.push(PersistedWorkspaceEntry {
            id: id.clone(),
            name: name.clone(),
            path: canon_str.clone(),
            workspace_kind: Some(kind.to_owned()),
            created_at: Some(now.clone()),
            last_opened_at: Some(now),
            default_provider: None,
            default_model: None,
            default_enable_mcp: None,
            yolo: None,
        });
        let patch = json!({ "workspaces": entries });
        self.save_state_json(patch, fallback_cwd)
            .map_err(|e| e.to_string())?;
        Ok(
            cowork_harness::importers::conversations::EnsuredWorkspaceOutcome {
                workspace_id: Some(id),
                workspace_path: canon_str,
                name,
                created: true,
            },
        )
    }
}

pub fn fallback_workspace_entry(cwd: &Path, homedir: &Path) -> PersistedWorkspaceEntry {
    let cwd_str = cwd.to_string_lossy().into_owned();
    let name = cwd
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd_str.clone());
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let kind = if is_path_inside_one_off_chats_root(cwd, homedir) {
        "oneOffChat"
    } else {
        "project"
    };
    PersistedWorkspaceEntry {
        id: format!("server-{}", fnv1a32_hex(&cwd_str)),
        name,
        path: cwd_str,
        workspace_kind: Some(kind.to_owned()),
        created_at: Some(now.clone()),
        last_opened_at: Some(now),
        default_provider: None,
        default_model: None,
        default_enable_mcp: None,
        yolo: None,
    }
}

pub fn build_workspace_summaries(
    working_directory: &Path,
    homedir: &Path,
    desktop_service: Option<&WebDesktopService>,
) -> (Vec<JsonRpcWorkspaceSummary>, Option<String>) {
    let entries = match desktop_service {
        Some(svc) => svc.workspace_entries(working_directory),
        None => vec![fallback_workspace_entry(working_directory, homedir)],
    };
    let wd_str = working_directory.to_string_lossy();
    let summaries: Vec<JsonRpcWorkspaceSummary> = entries
        .into_iter()
        .map(|entry| {
            let kind = match entry.workspace_kind.as_deref() {
                Some("project") => "project",
                Some("oneOffChat") => "oneOffChat",
                _ if is_path_inside_one_off_chats_root(Path::new(&entry.path), homedir) => {
                    "oneOffChat"
                }
                _ => "project",
            };
            JsonRpcWorkspaceSummary {
                id: entry.id,
                name: entry.name,
                path: entry.path,
                workspace_kind: kind.to_owned(),
                created_at: entry.created_at,
                last_opened_at: entry.last_opened_at,
                default_provider: entry.default_provider,
                default_model: entry.default_model,
                default_enable_mcp: entry.default_enable_mcp,
                yolo: entry.yolo,
            }
        })
        .collect();

    let active_id = summaries
        .iter()
        .find(|w| w.path == wd_str)
        .map(|w| w.id.clone())
        .or_else(|| summaries.first().map(|w| w.id.clone()));

    (summaries, active_id)
}

pub fn handle_http_workspaces(
    working_directory: &Path,
    homedir: &Path,
    desktop_service: Option<&WebDesktopService>,
) -> Response<Body> {
    let (summaries, _) = build_workspace_summaries(working_directory, homedir, desktop_service);
    let list: Vec<Value> = summaries
        .into_iter()
        .filter(|w| desktop_service.is_none() || w.workspace_kind != "oneOffChat")
        .map(|w| json!({ "name": w.name, "path": w.path }))
        .collect();
    json_response(StatusCode::OK, &json!({ "workspaces": list }))
}

fn is_valid_thread_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_valid_batch_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn plain_response(status: StatusCode, msg: impl Into<String>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(msg.into()))
        .unwrap()
}

fn json_response(status: StatusCode, val: &Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(val).unwrap_or_default()))
        .unwrap()
}

pub fn handle_desktop_route(
    method: &Method,
    pathname: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
    working_directory: &Path,
    desktop_service: Option<&WebDesktopService>,
) -> Response<Body> {
    let Some(svc) = desktop_service else {
        return plain_response(StatusCode::NOT_FOUND, "Desktop web service unavailable");
    };

    match (method.as_str(), pathname) {
        ("GET", "/cowork/desktop/state") => {
            json_response(StatusCode::OK, &svc.load_state_json(working_directory))
        }
        ("POST", "/cowork/desktop/state") => {
            let Ok(incoming) = serde_json::from_slice::<Value>(body) else {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid JSON body");
            };
            match svc.save_state_json(incoming, working_directory) {
                Ok(saved) => json_response(StatusCode::OK, &saved),
                Err(err) => plain_response(StatusCode::BAD_REQUEST, err.to_string()),
            }
        }
        ("POST", "/cowork/desktop/one-off-chat/workspace") => {
            let parsed: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
            let hint = parsed
                .get("titleHint")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Quick Chat");
            let root = get_one_off_chats_root(svc.homedir());
            let _ = ensure_private_dir_sync(&root);
            let dir = root.join(format!("chat-{}", Uuid::new_v4()));
            if let Err(err) = std::fs::create_dir_all(&dir) {
                return plain_response(StatusCode::BAD_REQUEST, err.to_string());
            }
            let canon = canonicalize_sync(&dir);
            json_response(
                StatusCode::OK,
                &json!({
                    "name": hint,
                    "path": canon.to_string_lossy(),
                }),
            )
        }
        ("POST", "/cowork/desktop/workspace/resolve") => {
            let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid JSON body");
            };
            let Some(raw_path) = parsed.get("path").and_then(Value::as_str) else {
                return plain_response(StatusCode::BAD_REQUEST, "Missing path");
            };
            let p = Path::new(raw_path.trim());
            match std::fs::canonicalize(p) {
                Ok(real) if real.is_dir() => {
                    json_response(StatusCode::OK, &json!({ "path": real.to_string_lossy() }))
                }
                Ok(_) => plain_response(StatusCode::BAD_REQUEST, "Path is not a directory"),
                Err(err) => plain_response(StatusCode::NOT_FOUND, err.to_string()),
            }
        }
        ("POST", "/cowork/desktop/workspace/start") => {
            let ws_url = svc.ws_url_for_primary.inner.read().clone();
            json_response(StatusCode::OK, &json!({ "url": ws_url }))
        }
        ("POST", "/cowork/desktop/workspace/stop") => Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap(),
        ("GET", "/cowork/desktop/transcript") => {
            let q: HashMap<String, String> = query
                .map(|s| {
                    url::form_urlencoded::parse(s.as_bytes())
                        .into_owned()
                        .collect()
                })
                .unwrap_or_default();
            let Some(thread_id) = q.get("threadId") else {
                return plain_response(StatusCode::BAD_REQUEST, "Missing threadId");
            };
            if !is_valid_thread_id(thread_id) {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid threadId");
            }
            let file = svc.transcripts_dir().join(format!("{thread_id}.jsonl"));
            let mut items = Vec::new();
            if let Ok(raw) = std::fs::read_to_string(file) {
                for line in raw.lines() {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        items.push(v);
                    }
                }
            }
            json_response(StatusCode::OK, &Value::Array(items))
        }
        ("DELETE", "/cowork/desktop/transcript") => {
            let q: HashMap<String, String> = query
                .map(|s| {
                    url::form_urlencoded::parse(s.as_bytes())
                        .into_owned()
                        .collect()
                })
                .unwrap_or_default();
            let Some(thread_id) = q.get("threadId") else {
                return plain_response(StatusCode::BAD_REQUEST, "Missing threadId");
            };
            if !is_valid_thread_id(thread_id) {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid threadId");
            }
            let file = svc.transcripts_dir().join(format!("{thread_id}.jsonl"));
            let _ = std::fs::remove_file(file);
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .unwrap()
        }
        ("POST", "/cowork/desktop/transcript/event") => {
            let Ok(ev) = serde_json::from_slice::<Value>(body) else {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid JSON body");
            };
            let Some(thread_id) = ev.get("threadId").and_then(Value::as_str) else {
                return plain_response(StatusCode::BAD_REQUEST, "Missing threadId");
            };
            if !is_valid_thread_id(thread_id) {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid threadId");
            }
            if let Err(err) =
                append_transcript_events(&svc.transcripts_dir(), std::slice::from_ref(&ev))
            {
                return plain_response(StatusCode::BAD_REQUEST, err.to_string());
            }
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .unwrap()
        }
        ("POST", "/cowork/desktop/transcript/batch") => {
            if body.len() > MAX_TRANSCRIPT_BATCH_RAW_BYTES {
                return plain_response(StatusCode::PAYLOAD_TOO_LARGE, "Transcript batch too large");
            }
            let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
                return plain_response(StatusCode::BAD_REQUEST, "Invalid JSON body");
            };
            let header_key = headers
                .get("idempotency-key")
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty());

            let (batch_id, events) = match parsed {
                Value::Array(arr) => (header_key.map(str::to_owned), arr),
                Value::Object(mut obj) => {
                    let bid = obj
                        .remove("batchId")
                        .and_then(|v| v.as_str().map(str::to_owned));
                    let Some(Value::Array(arr)) = obj.remove("events") else {
                        return plain_response(StatusCode::BAD_REQUEST, "Missing events array");
                    };
                    (bid, arr)
                }
                _ => return plain_response(StatusCode::BAD_REQUEST, "Invalid batch payload"),
            };

            if events.is_empty() || events.len() > MAX_TRANSCRIPT_BATCH_COUNT {
                return plain_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Transcript batch count out of bounds",
                );
            }
            let events_serialized = serde_json::to_vec(&events).unwrap_or_default();
            if events_serialized.len() > MAX_TRANSCRIPT_BATCH_EVENTS_BYTES {
                return plain_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Transcript batch events exceed byte limit",
                );
            }

            if let (Some(hk), Some(bid)) = (header_key, batch_id.as_deref())
                && hk != bid
            {
                return plain_response(
                    StatusCode::BAD_REQUEST,
                    "Idempotency-Key must match batchId",
                );
            }
            let effective_id = batch_id.or_else(|| header_key.map(str::to_owned));
            if let Some(id) = effective_id {
                if !is_valid_batch_id(&id) {
                    return plain_response(StatusCode::BAD_REQUEST, "Invalid batchId");
                }
                let digest = hex::encode(Sha256::digest(&events_serialized));
                if let Some(existing) = svc.batch_digests.get(&id) {
                    if *existing != digest {
                        return plain_response(
                            StatusCode::CONFLICT,
                            "Idempotency key conflict for transcript batch",
                        );
                    }
                    return Response::builder()
                        .status(StatusCode::NO_CONTENT)
                        .body(Body::empty())
                        .unwrap();
                }
                svc.batch_digests.insert(id, digest);
            }

            if let Err(err) = append_transcript_events(&svc.transcripts_dir(), &events) {
                return plain_response(StatusCode::BAD_REQUEST, err.to_string());
            }
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .unwrap()
        }
        _ => plain_response(StatusCode::NOT_FOUND, "Desktop web service unavailable"),
    }
}

fn append_transcript_events(dir: &Path, events: &[Value]) -> anyhow::Result<()> {
    let _ = ensure_private_dir_sync(dir);
    for ev in events {
        let Some(thread_id) = ev.get("threadId").and_then(Value::as_str) else {
            anyhow::bail!("Event missing threadId");
        };
        if !is_valid_thread_id(thread_id) {
            anyhow::bail!("Invalid threadId");
        }
        let path = dir.join(format!("{thread_id}.jsonl"));
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let line = serde_json::to_string(ev)?;
        writeln!(f, "{line}")?;
    }
    Ok(())
}

pub fn handle_mobile_h3_admin_route(
    method: &Method,
    pathname: &str,
    headers: &HeaderMap,
    body: &[u8],
    mobile_h3: Option<&MobileH3AdminState>,
) -> Response<Body> {
    let Some(h3) = mobile_h3 else {
        return json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "Mobile H3 endpoint is not running." }),
        );
    };

    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().strip_prefix("Bearer "))
        .map(str::trim);

    let expected_token = h3.info.read().admin_token.clone();
    if bearer != Some(expected_token.as_str()) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "Unauthorized." }),
        );
    }

    if pathname == "/mobile-h3/trusted" {
        if method == Method::GET {
            let devices = h3.info.read().trusted_devices.clone();
            return json_response(StatusCode::OK, &json!({ "trustedDevices": devices }));
        }
        if method == Method::DELETE {
            let mut info = h3.info.write();
            info.trusted_devices.clear();
            info.trusted_device = None;
            return json_response(StatusCode::OK, &json!({ "ok": true }));
        }
    }

    if let Some(rest) = pathname.strip_prefix("/mobile-h3/trusted/") {
        if let Some(encoded_id) = rest.strip_suffix("/permissions")
            && method == Method::PATCH
        {
            let device_id = url::form_urlencoded::parse(encoded_id.as_bytes())
                .next()
                .map(|(k, _)| k.into_owned())
                .unwrap_or_else(|| encoded_id.to_owned());
            let parsed: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
            let mut info = h3.info.write();
            let Some(dev) = info
                .trusted_devices
                .iter_mut()
                .find(|d| d.device_id == device_id)
            else {
                return json_response(
                    StatusCode::NOT_FOUND,
                    &json!({ "error": "Trusted device not found." }),
                );
            };
            if let Some(perms) = parsed.get("permissions").and_then(Value::as_object) {
                if let Some(v) = perms.get("turns").and_then(Value::as_bool) {
                    dev.permissions.turns = v;
                }
                if let Some(v) = perms.get("serverRequests").and_then(Value::as_bool) {
                    dev.permissions.server_requests = v;
                }
                if let Some(v) = perms.get("providerAuth").and_then(Value::as_bool) {
                    dev.permissions.provider_auth = v;
                }
                if let Some(v) = perms.get("mcpAuth").and_then(Value::as_bool) {
                    dev.permissions.mcp_auth = v;
                }
                if let Some(v) = perms.get("workspaceSettings").and_then(Value::as_bool) {
                    dev.permissions.workspace_settings = v;
                }
                if let Some(v) = perms.get("backups").and_then(Value::as_bool) {
                    dev.permissions.backups = v;
                }
                if let Some(v) = perms.get("conversations").and_then(Value::as_bool) {
                    dev.permissions.conversations = v;
                }
            }
            let updated = dev.clone();
            return json_response(StatusCode::OK, &json!({ "trustedDevice": updated }));
        } else if method == Method::DELETE && !rest.contains('/') {
            let device_id = url::form_urlencoded::parse(rest.as_bytes())
                .next()
                .map(|(k, _)| k.into_owned())
                .unwrap_or_else(|| rest.to_owned());
            let mut info = h3.info.write();
            let before = info.trusted_devices.len();
            info.trusted_devices.retain(|d| d.device_id != device_id);
            let removed = info.trusted_devices.len() < before;
            if info
                .trusted_device
                .as_ref()
                .is_some_and(|d| d.device_id == device_id)
            {
                info.trusted_device = info.trusted_devices.first().cloned();
            }
            return json_response(StatusCode::OK, &json!({ "ok": true, "removed": removed }));
        }
    }

    plain_response(StatusCode::NOT_FOUND, "Not found")
}
