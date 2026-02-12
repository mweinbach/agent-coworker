use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use tokio::io::AsyncWriteExt;

use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Error types (Finding 5.1: structured errors instead of String)
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Server startup timed out after {0} seconds")]
    ServerTimeout(u64),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Process error: {0}")]
    Process(String),
}

// Tauri requires InvokeError or Into<InvokeError> for command returns.
// The simplest stable approach is to convert to String.
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

type CommandResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// Input validation helpers (Findings 6.1, 6.2, 6.3: path traversal & input)
// ---------------------------------------------------------------------------

/// Validate that an ID contains only safe characters (alphanumeric, hyphens,
/// underscores). Prevents path traversal via thread_id or workspace_id.
fn validate_safe_id(id: &str, label: &str) -> Result<(), AppError> {
    if id.is_empty() {
        return Err(AppError::InvalidInput(format!("{label} must not be empty")));
    }
    if id.len() > 256 {
        return Err(AppError::InvalidInput(format!("{label} is too long")));
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::InvalidInput(format!(
            "{label} contains invalid characters (only alphanumeric, hyphens, underscores allowed)"
        )));
    }
    Ok(())
}

/// Validate that a workspace path is an existing directory.
fn validate_workspace_path(p: &str) -> Result<(), AppError> {
    let path = Path::new(p);
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "Workspace path does not exist: {p}"
        )));
    }
    if !path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Workspace path is not a directory: {p}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Server process management (Findings 1.1, 2.1, 2.3, 2.4, 5.2)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ServerHandle {
    child: Child,
    url: String,
}

/// Attempt graceful shutdown of a child process: send SIGTERM (Unix) or
/// TerminateProcess (Windows) first, then SIGKILL after a timeout.
fn graceful_kill(child: &mut Child) {
    // On Unix, try SIGTERM first for graceful shutdown.
    #[cfg(unix)]
    {
        let pid = child.id();
        // Send SIGTERM via libc.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        // Wait up to 3 seconds for graceful exit.
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }
    }
    // Fallback: force kill.
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Default)]
struct ServerManager {
    // parking_lot::Mutex: no poisoning, faster than std::sync::Mutex
    servers: Mutex<HashMap<String, ServerHandle>>,
}

impl ServerManager {
    fn stop_all(&self) {
        let mut map = self.servers.lock();
        for (_id, mut handle) in map.drain() {
            graceful_kill(&mut handle.child);
        }
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

// ---------------------------------------------------------------------------
// Persistent state types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerListening {
    #[allow(dead_code)]
    r#type: String,
    url: String,
    #[allow(dead_code)]
    port: u16,
    #[allow(dead_code)]
    cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartServerResponse {
    url: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    version: u32,
    workspaces: Vec<WorkspaceRecord>,
    threads: Vec<ThreadRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    id: String,
    name: String,
    path: String,
    created_at: String,
    last_opened_at: String,
    default_provider: Option<String>,
    default_model: Option<String>,
    default_enable_mcp: bool,
    yolo: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRecord {
    id: String,
    workspace_id: String,
    title: String,
    created_at: String,
    last_message_at: String,
    status: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptEvent {
    ts: String,
    thread_id: String,
    direction: String,
    payload: JsonValue,
}

// ---------------------------------------------------------------------------
// Batch transcript append support (Finding 3.2: reduce file open/close)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptBatchItem {
    ts: String,
    thread_id: String,
    direction: String,
    payload: JsonValue,
}

// ---------------------------------------------------------------------------
// State file mutex for atomic access (Finding 4.3)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StateLock(tokio::sync::Mutex<()>);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    match base.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("Failed to canonicalize repo root: {e}, using relative path");
            base
        }
    }
}

fn sidecar_base_name() -> &'static str {
    "cowork-server"
}

fn sidecar_exact_filename() -> String {
    if cfg!(windows) {
        format!("{}.exe", sidecar_base_name())
    } else {
        sidecar_base_name().to_string()
    }
}

fn sidecar_matches_filename(name: &str) -> bool {
    let base = sidecar_base_name();
    if cfg!(windows) {
        let exact = format!("{base}.exe");
        if name == exact {
            return true;
        }
        // Be tolerant: accept target-suffixed binaries (ex: cowork-server-x86_64-pc-windows-msvc.exe)
        return name.starts_with(&format!("{base}-")) && name.ends_with(".exe");
    }

    if name == base {
        return true;
    }
    // Accept target-suffixed binaries (ex: cowork-server-aarch64-apple-darwin)
    name.starts_with(&format!("{base}-"))
}

fn find_sidecar_binary(app: &AppHandle) -> Result<PathBuf, AppError> {
    if let Ok(p) = std::env::var("COWORK_DESKTOP_SIDECAR_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }

    let exact = sidecar_exact_filename();
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.clone());
        dirs.push(resource_dir.join("binaries"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
            dirs.push(parent.join("binaries"));

            // macOS app layout: Cowork.app/Contents/MacOS/Cowork
            #[cfg(target_os = "macos")]
            {
                if let Some(contents) = parent.parent() {
                    let resources = contents.join("Resources");
                    dirs.push(resources.clone());
                    dirs.push(resources.join("binaries"));
                }
            }
        }
    }

    // First pass: exact filename.
    for dir in &dirs {
        let candidate = dir.join(&exact);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // Second pass: scan for target-suffixed binaries.
    for dir in &dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if sidecar_matches_filename(name) {
                return Ok(p);
            }
        }
    }

    Err(AppError::NotFound(format!(
        "Server sidecar binary not found (expected {})",
        exact
    )))
}

fn ensure_dir(p: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(p)?;
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))
}

fn state_file_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(app_data_dir(app)?.join("state.json"))
}

fn transcripts_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(app_data_dir(app)?.join("transcripts"))
}

fn transcript_file_path(app: &AppHandle, thread_id: &str) -> CommandResult<PathBuf> {
    // thread_id must already be validated before calling this.
    Ok(transcripts_dir(app)?.join(format!("{thread_id}.jsonl")))
}

// ---------------------------------------------------------------------------
// Server commands (Findings 1.2, 1.3, 2.1, 2.2, 4.1, 6.2, 6.3)
// ---------------------------------------------------------------------------

const SERVER_STARTUP_TIMEOUT_SECS: u64 = 15;

#[tauri::command(rename_all = "camelCase")]
async fn start_workspace_server(
    app: AppHandle,
    servers: State<'_, ServerManager>,
    workspace_id: String,
    workspace_path: String,
    yolo: bool,
) -> CommandResult<StartServerResponse> {
    // Validate inputs (Findings 6.2, 6.3).
    validate_safe_id(&workspace_id, "workspace_id")?;
    validate_workspace_path(&workspace_path)?;

    // Check for existing running server. Hold lock for the full duration to
    // prevent TOCTOU races where two callers both pass the check and spawn
    // duplicate servers (Finding 4.1).
    {
        let mut map = servers.servers.lock();
        if let Some(handle) = map.get_mut(&workspace_id) {
            match handle.child.try_wait() {
                Ok(None) => {
                    return Ok(StartServerResponse {
                        url: handle.url.clone(),
                    })
                }
                Ok(Some(_)) => {
                    // Process exited; drop and restart.
                    map.remove(&workspace_id);
                }
                Err(err) => {
                    map.remove(&workspace_id);
                    return Err(AppError::Process(format!(
                        "Failed to check server process status: {err}"
                    ))
                    .into());
                }
            }
        }
        // NOTE: We drop the lock here so we don't hold it during the spawn +
        // wait. The TOCTOU window is acceptable for desktop (single user) and
        // avoids blocking other workspace operations during the 15s timeout.
    }

    let root = repo_root();

    let use_source = cfg!(debug_assertions)
        || std::env::var("COWORK_DESKTOP_USE_SOURCE")
            .ok()
            .as_deref()
            == Some("1");

    let mut cmd = if use_source {
        let server_entry = root.join("src/server/index.ts");
        if !server_entry.exists() {
            return Err(AppError::NotFound(format!(
                "Server entrypoint not found: {}",
                server_entry.display()
            ))
            .into());
        }

        let mut c = Command::new("bun");
        c.current_dir(&root).arg(&server_entry);
        c
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| AppError::Process(format!("Failed to resolve resource dir: {e}")))?;

        let built_in_dir = resource_dir.join("dist");
        if !built_in_dir.exists() {
            return Err(AppError::NotFound(format!(
                "Bundled dist directory not found: {}",
                built_in_dir.display()
            ))
            .into());
        }

        let sidecar = find_sidecar_binary(&app)?;

        let mut c = Command::new(sidecar);
        c.current_dir(&resource_dir)
            .env("COWORK_BUILTIN_DIR", built_in_dir.as_os_str())
            .env("COWORK_DESKTOP_BUNDLE", "1");
        c
    };

    cmd.arg("--dir")
        .arg(&workspace_path)
        .arg("--port")
        .arg("0")
        .arg("--json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if yolo {
        cmd.arg("--yolo");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Process(format!("Failed to spawn server process: {e}")))?;

    // Read first stdout line for startup JSON (Finding 1.2, 1.3: use tokio
    // channels instead of OS threads + blocking mpsc).
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Process("Failed to capture server stdout".to_string()))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() {
            let _ = tx.send(line);
        }
    });

    // Drain stderr in background (Finding 2.3: thread lifetime tied to pipe).
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // pipe closed — process exited
                    Ok(_) => {
                        eprint!("[cowork-server] {line}");
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Non-blocking wait with increased timeout (Finding 1.3, Finding: 27).
    let first_line = tokio::time::timeout(
        std::time::Duration::from_secs(SERVER_STARTUP_TIMEOUT_SECS),
        async {
            rx.await.map_err(|_| {
                AppError::Process(
                    "Failed to read server startup line: server stdout reader closed".to_string(),
                )
            })
        },
    )
    .await
    .map_err(|_| AppError::ServerTimeout(SERVER_STARTUP_TIMEOUT_SECS))??;

    let listening: ServerListening = serde_json::from_str(first_line.trim())
        .map_err(|e| AppError::Process(format!("Failed to parse server startup JSON: {e}")))?;

    let url = listening.url.clone();

    {
        let mut map = servers.servers.lock();
        map.insert(
            workspace_id,
            ServerHandle {
                child,
                url: url.clone(),
            },
        );
    }

    // Ensure app data dirs exist early.
    let _ = ensure_dir(&app_data_dir(&app)?);
    let _ = ensure_dir(&transcripts_dir(&app)?);

    Ok(StartServerResponse { url })
}

#[tauri::command(rename_all = "camelCase")]
fn stop_workspace_server(
    servers: State<'_, ServerManager>,
    workspace_id: String,
) -> CommandResult<()> {
    validate_safe_id(&workspace_id, "workspace_id").map_err(|e| e.to_string())?;

    let mut map = servers.servers.lock();
    if let Some(mut handle) = map.remove(&workspace_id) {
        graceful_kill(&mut handle.child);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// State persistence (Findings 3.1, 4.2, 4.3)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
async fn load_state(app: AppHandle, state_lock: State<'_, StateLock>) -> CommandResult<PersistedState> {
    let p = state_file_path(&app)?;
    if !p.exists() {
        return Ok(PersistedState {
            version: 1,
            workspaces: vec![],
            threads: vec![],
        });
    }

    // Hold lock for read consistency (Finding 4.3).
    // Uses tokio::sync::Mutex so we don't block the runtime across .await.
    let _guard = state_lock.0.lock().await;
    let raw = tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| format!("Failed to read state file: {e}"))?;
    drop(_guard);

    let mut parsed: PersistedState =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse state file JSON: {e}"))?;
    if parsed.version == 0 {
        parsed.version = 1;
    }
    Ok(parsed)
}

#[tauri::command(rename_all = "camelCase")]
async fn save_state(
    app: AppHandle,
    state_lock: State<'_, StateLock>,
    state: PersistedState,
) -> CommandResult<()> {
    let p = state_file_path(&app)?;
    if let Some(parent) = p.parent() {
        ensure_dir(parent).map_err(|e| e.to_string())?;
    }

    let raw =
        serde_json::to_string_pretty(&state).map_err(|e| format!("Failed to serialize state: {e}"))?;

    // Atomic write: write to temp file then rename (Finding 4.2).
    let tmp = p.with_extension("json.tmp");

    // Uses tokio::sync::Mutex so we don't block the runtime across .await.
    let _guard = state_lock.0.lock().await;
    tokio::fs::write(&tmp, &raw)
        .await
        .map_err(|e| format!("Failed to write temp state file: {e}"))?;
    tokio::fs::rename(&tmp, &p)
        .await
        .map_err(|e| format!("Failed to rename state file: {e}"))?;
    drop(_guard);

    Ok(())
}

// ---------------------------------------------------------------------------
// Transcript commands (Findings 3.2, 3.3, 6.1)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
async fn read_transcript(
    app: AppHandle,
    thread_id: String,
) -> CommandResult<Vec<TranscriptEvent>> {
    // Validate thread_id to prevent path traversal (Finding 6.1).
    validate_safe_id(&thread_id, "thread_id").map_err(|e| e.to_string())?;

    let p = transcript_file_path(&app, &thread_id)?;
    if !p.exists() {
        return Ok(vec![]);
    }

    // Use async file read (Finding 3.1).
    let raw = tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| format!("Failed to read transcript: {e}"))?;

    let mut out: Vec<TranscriptEvent> = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<TranscriptEvent>(trimmed) {
            Ok(evt) => out.push(evt),
            Err(err) => {
                return Err(format!(
                    "Failed to parse transcript line {} ({}): {}",
                    idx + 1,
                    p.display(),
                    err
                ));
            }
        }
    }
    Ok(out)
}

#[tauri::command(rename_all = "camelCase")]
async fn append_transcript_event(
    app: AppHandle,
    ts: String,
    thread_id: String,
    direction: String,
    payload: JsonValue,
) -> CommandResult<()> {
    validate_safe_id(&thread_id, "thread_id").map_err(|e| e.to_string())?;

    let direction_norm = direction.trim().to_lowercase();
    if direction_norm != "server" && direction_norm != "client" {
        return Err("direction must be 'server' or 'client'".to_string());
    }

    let p = transcript_file_path(&app, &thread_id)?;
    if let Some(parent) = p.parent() {
        ensure_dir(parent).map_err(|e| e.to_string())?;
    }

    let evt = TranscriptEvent {
        ts,
        thread_id,
        direction: direction_norm,
        payload,
    };
    let mut line =
        serde_json::to_string(&evt).map_err(|e| format!("Failed to serialize transcript event: {e}"))?;
    line.push('\n');

    // Use async file append (Finding 3.1).
    tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .await
        .map_err(|e| format!("Failed to open transcript file: {e}"))?
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to append transcript event: {e}"))?;

    Ok(())
}

/// Batch-append multiple transcript events in a single file open/write cycle
/// (Finding 3.2: reduce IPC + file I/O overhead for rapid events).
#[tauri::command(rename_all = "camelCase")]
async fn append_transcript_batch(
    app: AppHandle,
    events: Vec<TranscriptBatchItem>,
) -> CommandResult<()> {
    if events.is_empty() {
        return Ok(());
    }

    // Group events by thread_id so we can write to each file once.
    let mut by_thread: HashMap<String, Vec<&TranscriptBatchItem>> = HashMap::new();
    for evt in &events {
        validate_safe_id(&evt.thread_id, "thread_id").map_err(|e| e.to_string())?;
        let direction = evt.direction.trim().to_lowercase();
        if direction != "server" && direction != "client" {
            return Err("direction must be 'server' or 'client'".to_string());
        }
        by_thread
            .entry(evt.thread_id.clone())
            .or_default()
            .push(evt);
    }

    let transcripts = transcripts_dir(&app)?;
    ensure_dir(&transcripts).map_err(|e| e.to_string())?;

    for (thread_id, thread_events) in &by_thread {
        let p = transcripts.join(format!("{thread_id}.jsonl"));

        // Build a single buffer of all JSONL lines for this thread.
        let mut buf = String::new();
        for evt in thread_events {
            let te = TranscriptEvent {
                ts: evt.ts.clone(),
                thread_id: evt.thread_id.clone(),
                direction: evt.direction.trim().to_lowercase(),
                payload: evt.payload.clone(),
            };
            let line =
                serde_json::to_string(&te).map_err(|e| format!("Failed to serialize event: {e}"))?;
            buf.push_str(&line);
            buf.push('\n');
        }

        // Single async write per thread.
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .await
            .map_err(|e| format!("Failed to open transcript file: {e}"))?;
        f.write_all(buf.as_bytes())
            .await
            .map_err(|e| format!("Failed to write transcript batch: {e}"))?;
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_transcript(app: AppHandle, thread_id: String) -> CommandResult<()> {
    validate_safe_id(&thread_id, "thread_id").map_err(|e| e.to_string())?;

    let p = transcript_file_path(&app, &thread_id)?;
    if !p.exists() {
        return Ok(());
    }
    tokio::fs::remove_file(&p)
        .await
        .map_err(|e| format!("Failed to delete transcript {}: {}", p.display(), e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// DevTools probe compatibility
// ---------------------------------------------------------------------------

fn parse_debug_port(raw: &str) -> Option<u16> {
    if let Ok(port) = raw.parse::<u16>() {
        return Some(port);
    }
    if let Ok(addr) = raw.parse::<SocketAddr>() {
        return Some(addr.port());
    }
    raw.rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
}

fn write_probe_response(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())
}

fn handle_probe_client(stream: &mut TcpStream, bind_addr: SocketAddr) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
    }

    let path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let ws_url = format!("ws://127.0.0.1:{}/devtools/page/1", bind_addr.port());

    match path {
        "/json/version" => {
            let body = serde_json::json!({
                "Browser": "Cowork WKWebView",
                "Protocol-Version": "1.3",
                "User-Agent": "Tauri/WKWebView",
                "webSocketDebuggerUrl": ws_url
            })
            .to_string();
            write_probe_response(stream, "200 OK", &body)
        }
        "/json/list" => {
            let body = serde_json::json!([{
                "id": "1",
                "title": "Cowork",
                "type": "page",
                "url": "app://cowork",
                "webSocketDebuggerUrl": ws_url
            }])
            .to_string();
            write_probe_response(stream, "200 OK", &body)
        }
        _ => {
            let body = serde_json::json!({ "error": "not found" }).to_string();
            write_probe_response(stream, "404 Not Found", &body)
        }
    }
}

fn start_devtools_probe_server(bind_addr: SocketAddr) {
    std::thread::Builder::new()
        .name("cowork-devtools-probe".to_string())
        .spawn(move || {
            let listener = match TcpListener::bind(bind_addr) {
                Ok(listener) => listener,
                Err(e) => {
                    tracing::warn!(
                        "Failed to bind devtools probe server on {}: {}",
                        bind_addr,
                        e
                    );
                    return;
                }
            };
            if let Err(e) = listener.set_nonblocking(true) {
                tracing::warn!("Failed to configure devtools probe server: {}", e);
                return;
            }
            tracing::info!("Devtools probe server listening on {}", bind_addr);

            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if let Err(e) = handle_probe_client(&mut stream, bind_addr) {
                            tracing::debug!("Devtools probe request error: {}", e);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(e) => {
                        tracing::warn!("Devtools probe server stopped: {}", e);
                        break;
                    }
                }
            }
        })
        .map_err(|e| {
            tracing::warn!("Failed to start devtools probe server thread: {}", e);
        })
        .ok();
}

fn maybe_start_devtools_probe_server() {
    if !cfg!(debug_assertions) {
        return;
    }
    let raw = match std::env::var("WEBKIT_INSPECTOR_SERVER") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return,
    };

    let Some(port) = parse_debug_port(raw.trim()) else {
        tracing::warn!(
            "WEBKIT_INSPECTOR_SERVER was set to '{}' but no valid port was found",
            raw
        );
        return;
    };

    // Keep the endpoint local-only even if the incoming env var contains a
    // broader bind address.
    let bind_addr = SocketAddr::from(([127, 0, 0, 1], port));
    start_devtools_probe_server(bind_addr);
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tauri MCP looks for Chromium-style /json/version and /json/list debug
    // endpoints. WKWebView on macOS doesn't expose those, so provide a tiny
    // local compatibility endpoint in debug mode.
    maybe_start_devtools_probe_server();

    tauri::Builder::default()
        .manage(ServerManager::default())
        .manage(StateLock::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_workspace_server,
            stop_workspace_server,
            load_state,
            save_state,
            read_transcript,
            append_transcript_event,
            append_transcript_batch,
            delete_transcript
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
