use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, StatusCode, header};
use cowork_config::{
    canonicalize_sync, ensure_private_dir_sync, get_one_off_chats_root,
    is_path_inside_one_off_chats_root, write_text_file_atomic,
};
use cowork_protocol::JsonRpcWorkspaceSummary;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::desktop_state_normalize::{
    build_fallback_workspace, default_state, is_safe_id, normalize_state,
};
use crate::desktop_state_watcher::StateChangeHub;
use crate::desktop_transcript_inbox::{
    MAX_SAFE_INTEGER, TRANSCRIPT_REQUEST_BODY_MAX_BYTES, TRANSCRIPT_REQUEST_MAX_EVENTS,
    TranscriptInbox, TranscriptInboxError, TranscriptInboxEvent, is_valid_batch_id,
};
use crate::registry::ServerRuntimeState;
use crate::startup::MobileH3AdminState;
use crate::workspace_servers::WorkspaceServers;

/// TS `fnv1a32`: FNV-1a over UTF-16 code units, zero-padded hex.
pub fn fnv1a32_hex(input: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in input.encode_utf16() {
        hash ^= u32::from(unit);
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
    pub(crate) workspace_servers: WorkspaceServers,
    /// `state.json` change listeners and last-seen file signature.
    state_changes: StateChangeHub,
    /// SQLite-backed transcript inbox (TS `TranscriptInbox`).
    transcript_inbox: TranscriptInbox,
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
        let transcript_inbox = TranscriptInbox::new(&user_data_dir);
        Self {
            homedir,
            user_data_dir,
            workspace_servers: WorkspaceServers::default(),
            state_changes: StateChangeHub::default(),
            transcript_inbox,
        }
    }

    pub fn user_data_dir(&self) -> &Path {
        &self.user_data_dir
    }

    pub fn state_file_path(&self) -> PathBuf {
        self.user_data_dir.join("state.json")
    }

    pub fn state_changes(&self) -> &StateChangeHub {
        &self.state_changes
    }

    pub fn transcript_inbox(&self) -> &TranscriptInbox {
        &self.transcript_inbox
    }

    /// TS `loadState({ fallbackCwd })`: the normalized `state.json` (defaults
    /// when missing or malformed), with a fallback workspace for `fallback_cwd`
    /// when no valid workspace remains.
    pub fn load_state_json(&self, fallback_cwd: &Path) -> Value {
        let mut state = match std::fs::read_to_string(self.state_file_path()) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(parsed) => normalize_state(&parsed, &self.homedir),
                Err(_) => default_state(),
            },
            Err(_) => default_state(),
        };
        let has_workspaces = state
            .get("workspaces")
            .and_then(Value::as_array)
            .is_some_and(|arr| !arr.is_empty());
        if !has_workspaces
            && let Some(fallback) = build_fallback_workspace(fallback_cwd, &self.homedir)
        {
            state["workspaces"] = json!([fallback]);
        }
        state
    }

    /// TS `saveState(state)`: normalizes the full incoming state (it replaces,
    /// not merges, the persisted state), writes it atomically, notifies
    /// `state.json` listeners (`workspace/listChanged`), and returns what was
    /// persisted. `_fallback_cwd` is unused (TS `saveState` takes none) and kept
    /// for call-site compatibility.
    pub fn save_state_json(&self, incoming: Value, _fallback_cwd: &Path) -> anyhow::Result<Value> {
        let normalized = normalize_state(&incoming, &self.homedir);
        ensure_private_dir_sync(&self.user_data_dir)?;
        let serialized = serde_json::to_string_pretty(&normalized)?;
        let state_file = self.state_file_path();
        write_text_file_atomic(&state_file, &serialized, Some(0o600))?;
        self.state_changes.record_signature(&state_file);
        self.state_changes.notify();
        Ok(normalized)
    }

    /// Typed read-only view of the persisted workspaces. Never write these
    /// back: the struct drops per-workspace fields it does not model.
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
        // Work on the raw normalized state so every workspace keeps the fields
        // the typed `PersistedWorkspaceEntry` does not model (TS spreads
        // `...state` / `...item`).
        let mut state = self.load_state_json(fallback_cwd);
        let raw_workspaces: Vec<Value> = state
            .get("workspaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let field = |w: &Value, key: &str| w.get(key).and_then(Value::as_str).map(str::to_owned);
        if let Some(existing) = raw_workspaces
            .iter()
            .find(|w| field(w, "path").is_some_and(|p| canonicalize_sync(Path::new(&p)) == canon))
        {
            return Ok(
                cowork_harness::importers::conversations::EnsuredWorkspaceOutcome {
                    workspace_id: field(existing, "id"),
                    workspace_path: canon_str,
                    name: field(existing, "name").unwrap_or_default(),
                    created: false,
                },
            );
        }

        let base_id = format!("import-{}", fnv1a32_hex(&canon_str));
        let mut id = base_id.clone();
        let mut suffix = 2_u32;
        while raw_workspaces
            .iter()
            .any(|w| field(w, "id").as_deref() == Some(id.as_str()))
        {
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
        let mut workspaces = raw_workspaces;
        workspaces.push(json!({
            "id": id,
            "name": name,
            "path": canon_str,
            "workspaceKind": kind,
            "createdAt": now,
            "lastOpenedAt": now,
            "defaultEnableMcp": true,
            "defaultBackupsEnabled": false,
            "yolo": false,
        }));
        state["workspaces"] = Value::Array(workspaces);
        self.save_state_json(state, fallback_cwd)
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

    /// TS `readTranscript(threadId)`: projects pending inbox batches for the
    /// thread, then returns the JSONL lines that match the transcript event
    /// schema (malformed lines are skipped).
    pub fn read_transcript(&self, thread_id: &str) -> Result<Vec<Value>, TranscriptInboxError> {
        self.transcript_inbox.project_pending(Some(thread_id))?;
        let path = self.transcript_inbox.transcript_file_path(thread_id)?;
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(TranscriptInboxError::new(e.to_string(), 500)),
        };
        Ok(raw
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(parse_stored_transcript_event)
            .collect())
    }
}

/// `transcriptEventSchema.safeParse` (passthrough object; string fields are
/// trimmed and must be non-empty).
fn parse_stored_transcript_event(mut event: Value) -> Option<Value> {
    let obj = event.as_object_mut()?;
    for key in ["ts", "threadId"] {
        let trimmed = obj.get(key)?.as_str()?.trim().to_owned();
        if trimmed.is_empty() {
            return None;
        }
        obj.insert(key.to_owned(), json!(trimmed));
    }
    if !matches!(
        obj.get("direction").and_then(Value::as_str),
        Some("server" | "client")
    ) {
        return None;
    }
    if let Some(generation) = obj.get("generation")
        && parse_generation(generation).is_none()
    {
        return None;
    }
    if let Some(delivery_id) = obj.get("deliveryId") {
        let trimmed = delivery_id.as_str()?.trim().to_owned();
        if trimmed.is_empty() {
            return None;
        }
        obj.insert("deliveryId".to_owned(), json!(trimmed));
    }
    Some(event)
}

/// A JSON number that is a non-negative safe integer (`1.0` counts, as in JS).
fn parse_generation(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER as f64).contains(&n))
        .then_some(n as i64)
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

fn no_content() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap()
}

/// A thrown route error (TS `textResponse(error.message, normalizeErrorStatus(error))`).
struct RouteError {
    status: StatusCode,
    message: String,
}

impl RouteError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::BAD_REQUEST, message)
    }

    fn with_status(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl From<TranscriptInboxError> for RouteError {
    fn from(e: TranscriptInboxError) -> Self {
        let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Self::with_status(status, e.message)
    }
}

type RouteResult = Result<Response<Body>, RouteError>;

fn parse_query(query: Option<&str>) -> HashMap<String, String> {
    query
        .map(|s| {
            url::form_urlencoded::parse(s.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default()
}

/// `readRequiredStringParam`.
fn required_param(params: &HashMap<String, String>, key: &str) -> Result<String, RouteError> {
    params
        .get(key)
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RouteError::bad_request(format!("{key} is required")))
}

/// `readRequiredStringField`.
fn required_field(body: &serde_json::Map<String, Value>, key: &str) -> Result<String, RouteError> {
    body.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RouteError::bad_request(format!("{key} is required")))
}

/// `readJsonBody`: a JSON object, or a 400.
fn read_json_object(body: &[u8]) -> Result<serde_json::Map<String, Value>, RouteError> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(RouteError::bad_request("Expected a JSON object body")),
        Err(err) => Err(RouteError::bad_request(err.to_string())),
    }
}

/// Validates one transcript event record the way the TS batch/event routes do.
fn parse_transcript_event(
    record: &serde_json::Map<String, Value>,
    allow_generation: bool,
) -> Result<TranscriptInboxEvent, RouteError> {
    let thread_id = required_field(record, "threadId")?;
    let ts = required_field(record, "ts")?;
    let direction = required_field(record, "direction")?;
    if direction != "server" && direction != "client" {
        return Err(RouteError::bad_request(
            "direction must be 'server' or 'client'",
        ));
    }
    let generation =
        match record.get("generation") {
            Some(value) if allow_generation => Some(parse_generation(value).ok_or_else(|| {
                RouteError::bad_request("generation must be a non-negative integer")
            })?),
            _ => None,
        };
    Ok(TranscriptInboxEvent {
        thread_id,
        ts,
        direction,
        payload: record.get("payload").cloned(),
        generation,
    })
}

fn legacy_batch_id() -> String {
    format!("legacy-{}", Uuid::new_v4())
}

pub(crate) enum WorkspaceAction {
    Start,
    Status,
    Stop,
}

pub(crate) async fn handle_workspace_lifecycle(
    action: WorkspaceAction,
    body: &[u8],
    runtime: &ServerRuntimeState,
) -> Response<Body> {
    let Some(service) = &runtime.desktop_service else {
        return plain_response(StatusCode::NOT_FOUND, "Desktop web service unavailable");
    };
    let Ok(params) = serde_json::from_slice::<Value>(body) else {
        return plain_response(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let id = params["workspaceId"].as_str().unwrap_or_default().trim();
    if !is_safe_id(id) {
        return plain_response(StatusCode::BAD_REQUEST, "Invalid workspaceId");
    }
    match action {
        WorkspaceAction::Status => {
            let (reason, url) = service.workspace_servers.status(id).await;
            return json_response(
                StatusCode::OK,
                &json!({
                    "workspaceId": id, "running": url.is_some(), "reason": reason, "url": url
                }),
            );
        }
        WorkspaceAction::Stop => {
            service.workspace_servers.stop(id).await;
            return no_content();
        }
        WorkspaceAction::Start => {}
    }

    let Some(path) = params["workspacePath"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return plain_response(StatusCode::BAD_REQUEST, "Missing workspacePath");
    };
    let Ok(path) = tokio::fs::canonicalize(path).await else {
        return plain_response(StatusCode::BAD_REQUEST, "Workspace path does not exist");
    };
    if !path.is_dir() {
        return plain_response(StatusCode::BAD_REQUEST, "Workspace path is not a directory");
    }
    let yolo = params["yolo"].as_bool().unwrap_or(false);
    match service
        .workspace_servers
        .start(id, &path, yolo, runtime)
        .await
    {
        Ok(url) => json_response(StatusCode::OK, &json!({ "url": url })),
        Err(err) => plain_response(StatusCode::INTERNAL_SERVER_ERROR, format!("{err:#}")),
    }
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
    match route_desktop_request(
        method,
        pathname,
        query,
        headers,
        body,
        working_directory,
        svc,
    ) {
        Ok(response) => response,
        Err(err) => plain_response(err.status, err.message),
    }
}

fn route_desktop_request(
    method: &Method,
    pathname: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
    working_directory: &Path,
    svc: &WebDesktopService,
) -> RouteResult {
    match (method.as_str(), pathname) {
        ("GET", "/cowork/desktop/state") => Ok(json_response(
            StatusCode::OK,
            &svc.load_state_json(working_directory),
        )),
        ("POST", "/cowork/desktop/state") => {
            let incoming = read_json_object(body)?;
            let saved = svc
                .save_state_json(Value::Object(incoming), working_directory)
                .map_err(|err| {
                    RouteError::with_status(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
                })?;
            Ok(json_response(StatusCode::OK, &saved))
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
            std::fs::create_dir_all(&dir)
                .map_err(|err| RouteError::bad_request(err.to_string()))?;
            let canon = canonicalize_sync(&dir);
            Ok(json_response(
                StatusCode::OK,
                &json!({
                    "name": hint,
                    "path": canon.to_string_lossy(),
                }),
            ))
        }
        ("POST", "/cowork/desktop/workspace/resolve") => {
            let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
                return Err(RouteError::bad_request("Invalid JSON body"));
            };
            let Some(raw_path) = parsed.get("path").and_then(Value::as_str) else {
                return Err(RouteError::bad_request("Missing path"));
            };
            let p = Path::new(raw_path.trim());
            match std::fs::canonicalize(p) {
                Ok(real) if real.is_dir() => Ok(json_response(
                    StatusCode::OK,
                    &json!({ "path": real.to_string_lossy() }),
                )),
                Ok(_) => Err(RouteError::bad_request("Path is not a directory")),
                Err(err) => Err(RouteError::with_status(
                    StatusCode::NOT_FOUND,
                    err.to_string(),
                )),
            }
        }
        ("GET", "/cowork/desktop/transcript") => {
            let thread_id = required_param(&parse_query(query), "threadId")?;
            let items = svc.read_transcript(&thread_id)?;
            Ok(json_response(StatusCode::OK, &Value::Array(items)))
        }
        ("DELETE", "/cowork/desktop/transcript") => {
            let params = parse_query(query);
            let thread_id = required_param(&params, "threadId")?;
            let generation = match params.get("generation") {
                None => None,
                Some(raw) => Some(parse_delete_generation(raw).ok_or_else(|| {
                    RouteError::bad_request("generation must be a positive integer")
                })?),
            };
            svc.transcript_inbox()
                .delete_thread(&thread_id, generation)?;
            Ok(no_content())
        }
        ("POST", "/cowork/desktop/transcript/event") => {
            let record = read_json_object(body)?;
            let event = parse_transcript_event(&record, false)?;
            svc.transcript_inbox()
                .append_batch(std::slice::from_ref(&event), &legacy_batch_id())?;
            Ok(no_content())
        }
        ("POST", "/cowork/desktop/transcript/batch") => handle_transcript_batch(headers, body, svc),
        _ => Err(RouteError::with_status(
            StatusCode::NOT_FOUND,
            "Desktop web service unavailable",
        )),
    }
}

/// `Number.parseInt(value, 10)` that must round-trip to the same string and be
/// a positive safe integer.
fn parse_delete_generation(raw: &str) -> Option<i64> {
    let generation = raw.parse::<i64>().ok()?;
    ((1..=MAX_SAFE_INTEGER).contains(&generation) && generation.to_string() == raw)
        .then_some(generation)
}

fn handle_transcript_batch(
    headers: &HeaderMap,
    body: &[u8],
    svc: &WebDesktopService,
) -> RouteResult {
    let declared_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declared_length.is_some_and(|n| n > TRANSCRIPT_REQUEST_BODY_MAX_BYTES as u64)
        || body.len() > TRANSCRIPT_REQUEST_BODY_MAX_BYTES
    {
        return Err(RouteError::with_status(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Transcript request body exceeds the byte limit",
        ));
    }
    let parsed = serde_json::from_slice::<Value>(body)
        .map_err(|_| RouteError::bad_request("Transcript request body must be valid JSON"))?;
    let (raw_events, body_batch_id) = match parsed {
        Value::Array(arr) => (Value::Array(arr), None),
        Value::Object(mut obj) => {
            let batch_id = required_field(&obj, "batchId")?;
            (obj.remove("events").unwrap_or(Value::Null), Some(batch_id))
        }
        _ => {
            return Err(RouteError::bad_request(
                "Expected a transcript batch object or legacy JSON array body",
            ));
        }
    };
    let Value::Array(raw_events) = raw_events else {
        return Err(RouteError::bad_request("events must be a JSON array"));
    };
    if raw_events.is_empty() || raw_events.len() > TRANSCRIPT_REQUEST_MAX_EVENTS {
        return Err(RouteError::with_status(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("events must contain 1-{TRANSCRIPT_REQUEST_MAX_EVENTS} entries"),
        ));
    }
    let header_batch_id = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if let (Some(header_id), Some(body_id)) = (&header_batch_id, &body_batch_id)
        && header_id != body_id
    {
        return Err(RouteError::bad_request(
            "Idempotency-Key must match batchId",
        ));
    }
    let batch_id = body_batch_id.or(header_batch_id);
    if let Some(id) = &batch_id
        && !is_valid_batch_id(id)
    {
        return Err(RouteError::bad_request(
            "batchId contains invalid characters",
        ));
    }
    let events = raw_events
        .iter()
        .map(|item| {
            let record = item.as_object().ok_or_else(|| {
                RouteError::bad_request("Transcript batch entries must be objects")
            })?;
            parse_transcript_event(record, true)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let batch_id = batch_id.unwrap_or_else(legacy_batch_id);
    svc.transcript_inbox().append_batch(&events, &batch_id)?;
    Ok(no_content())
}

pub async fn handle_mobile_h3_admin_route(
    method: &Method,
    pathname: &str,
    headers: &HeaderMap,
    body: &[u8],
    mobile_h3: Option<Arc<MobileH3AdminState>>,
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
        .map(str::trim)
        .and_then(|s| {
            (s.len() >= 7 && s[..7].eq_ignore_ascii_case("bearer ")).then(|| s[7..].trim())
        })
        .filter(|s| !s.is_empty());

    let expected_token = h3.info.read().admin_token.clone();
    if bearer != Some(expected_token.as_str()) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "Unauthorized." }),
        );
    }

    if pathname == "/mobile-h3/trusted" {
        if method == Method::GET {
            let devices = h3.list_trusted_devices().await;
            return json_response(StatusCode::OK, &json!({ "trustedDevices": devices }));
        }
        if method == Method::DELETE {
            if let Err(err) = h3.revoke_trusted_devices().await {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &json!({ "error": err.to_string() }),
                );
            }
            return json_response(StatusCode::OK, &json!({ "ok": true }));
        }
    }

    if let Some(rest) = pathname.strip_prefix("/mobile-h3/trusted/") {
        if let Some(encoded_id) = rest.strip_suffix("/permissions")
            && method == Method::PATCH
        {
            let Ok(decoded_cow) = percent_encoding::percent_decode_str(encoded_id).decode_utf8()
            else {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Invalid device identifier." }),
                );
            };
            let device_id = decoded_cow.trim();
            if device_id.is_empty() {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Invalid device identifier." }),
                );
            }
            let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Invalid permissions payload." }),
                );
            };
            let Some(perms_obj) = parsed
                .as_object()
                .and_then(|o| o.get("permissions"))
                .and_then(Value::as_object)
            else {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Invalid permissions payload." }),
                );
            };
            match h3
                .update_trusted_device_permissions(device_id, perms_obj)
                .await
            {
                Ok(Some(updated)) => {
                    return json_response(StatusCode::OK, &json!({ "trustedDevice": updated }));
                }
                Ok(None) => {
                    return json_response(
                        StatusCode::NOT_FOUND,
                        &json!({ "error": "Trusted device not found." }),
                    );
                }
                Err(err) => {
                    return json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &json!({ "error": err.to_string() }),
                    );
                }
            }
        } else if method == Method::DELETE && !rest.contains('/') {
            let Ok(decoded_cow) = percent_encoding::percent_decode_str(rest).decode_utf8() else {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Invalid device identifier." }),
                );
            };
            let device_id = decoded_cow.trim();
            if device_id.is_empty() {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Invalid device identifier." }),
                );
            }
            match h3.revoke_trusted_device(device_id).await {
                Ok(removed) => {
                    return json_response(
                        StatusCode::OK,
                        &json!({ "ok": true, "removed": removed }),
                    );
                }
                Err(err) => {
                    return json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &json!({ "error": err.to_string() }),
                    );
                }
            }
        }
    }

    plain_response(StatusCode::NOT_FOUND, "Not found")
}
