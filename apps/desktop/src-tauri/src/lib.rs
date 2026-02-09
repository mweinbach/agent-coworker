use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

type CommandResult<T> = Result<T, String>;

#[derive(Debug)]
struct ServerHandle {
    child: Child,
    url: String,
}

#[derive(Default)]
struct ServerManager {
    servers: Mutex<HashMap<String, ServerHandle>>,
}

impl ServerManager {
    fn stop_all(&self) {
        let mut map = match self.servers.lock() {
            Ok(v) => v,
            Err(_) => return,
        };

        for (_id, mut handle) in map.drain() {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        // Best-effort cleanup on app exit.
        self.stop_all();
    }
}

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

fn repo_root() -> PathBuf {
    // apps/desktop/src-tauri -> repo root is ../../../
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn ensure_dir(p: &Path) -> CommandResult<()> {
    fs::create_dir_all(p).map_err(|e| format!("Failed to create directory {}: {}", p.display(), e))?;
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
    Ok(transcripts_dir(app)?.join(format!("{thread_id}.jsonl")))
}

#[tauri::command(rename_all = "camelCase")]
async fn start_workspace_server(
    app: AppHandle,
    servers: State<'_, ServerManager>,
    workspace_id: String,
    workspace_path: String,
    yolo: bool,
) -> CommandResult<StartServerResponse> {
    // Return existing server url if already running.
    {
        let mut map = servers
            .servers
            .lock()
            .map_err(|_| "Server manager lock poisoned".to_string())?;
        if let Some(handle) = map.get_mut(&workspace_id) {
            match handle.child.try_wait() {
                Ok(None) => return Ok(StartServerResponse { url: handle.url.clone() }),
                Ok(Some(_)) => {
                    // Process exited; drop and restart.
                    map.remove(&workspace_id);
                }
                Err(err) => {
                    map.remove(&workspace_id);
                    return Err(format!("Failed to check server process status: {err}"));
                }
            }
        }
    }

    let root = repo_root();
    let bun_exe = "bun";

    // In dev (debug build), prefer the source server entrypoint for faster iteration.
    // In production bundles, use the bundled `dist/server/index.js` from app resources.
    let use_source = cfg!(debug_assertions)
        || std::env::var("COWORK_DESKTOP_USE_SOURCE")
            .ok()
            .as_deref()
            == Some("1");

    let (spawn_cwd, server_entry) = if use_source {
        (root.clone(), root.join("src/server/index.ts"))
    } else {
        match app.path().resource_dir() {
            Ok(resource_dir) => {
                let bundled = resource_dir.join("dist/server/index.js");
                if bundled.exists() {
                    (resource_dir, bundled)
                } else {
                    // If resources are missing, fall back to source (useful when running from the repo).
                    (root.clone(), root.join("src/server/index.ts"))
                }
            }
            Err(_) => (root.clone(), root.join("src/server/index.ts")),
        }
    };

    if !server_entry.exists() {
        return Err(format!("Server entrypoint not found: {}", server_entry.display()));
    }

    let mut cmd = Command::new(bun_exe);
    cmd.current_dir(&spawn_cwd)
        .arg(server_entry)
        .arg("--dir")
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
        .map_err(|e| format!("Failed to spawn server process: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture server stdout".to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() {
            let _ = tx.send(line);
        }
    });

    // Drain stderr in the background to avoid blocking if the server is noisy.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        eprint!("[cowork-server] {line}");
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let first_line = rx
        .recv_timeout(Duration::from_secs(6))
        .map_err(|_| "Timed out waiting for server startup JSON".to_string())?;

    let listening: ServerListening = serde_json::from_str(first_line.trim())
        .map_err(|e| format!("Failed to parse server startup JSON: {e}"))?;

    let url = listening.url.clone();

    {
        let mut map = servers
            .servers
            .lock()
            .map_err(|_| "Server manager lock poisoned".to_string())?;
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
fn stop_workspace_server(servers: State<'_, ServerManager>, workspace_id: String) -> CommandResult<()> {
    let mut map = servers
        .servers
        .lock()
        .map_err(|_| "Server manager lock poisoned".to_string())?;
    if let Some(mut handle) = map.remove(&workspace_id) {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn load_state(app: AppHandle) -> CommandResult<PersistedState> {
    let p = state_file_path(&app)?;
    if !p.exists() {
        return Ok(PersistedState {
            version: 1,
            workspaces: vec![],
            threads: vec![],
        });
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("Failed to read state file: {e}"))?;
    let mut parsed: PersistedState =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse state file JSON: {e}"))?;
    if parsed.version == 0 {
        parsed.version = 1;
    }
    Ok(parsed)
}

#[tauri::command(rename_all = "camelCase")]
fn save_state(app: AppHandle, state: PersistedState) -> CommandResult<()> {
    let p = state_file_path(&app)?;
    if let Some(parent) = p.parent() {
        ensure_dir(parent)?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|e| format!("Failed to serialize state: {e}"))?;
    fs::write(&p, raw).map_err(|e| format!("Failed to write state file: {e}"))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn read_transcript(app: AppHandle, thread_id: String) -> CommandResult<Vec<TranscriptEvent>> {
    let p = transcript_file_path(&app, &thread_id)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("Failed to read transcript: {e}"))?;
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
fn append_transcript_event(
    app: AppHandle,
    ts: String,
    thread_id: String,
    direction: String,
    payload: JsonValue,
) -> CommandResult<()> {
    let direction_norm = direction.trim().to_lowercase();
    if direction_norm != "server" && direction_norm != "client" {
        return Err("direction must be 'server' or 'client'".to_string());
    }

    let p = transcript_file_path(&app, &thread_id)?;
    if let Some(parent) = p.parent() {
        ensure_dir(parent)?;
    }

    let evt = TranscriptEvent {
        ts,
        thread_id,
        direction: direction_norm,
        payload,
    };
    let line = serde_json::to_string(&evt).map_err(|e| format!("Failed to serialize transcript event: {e}"))?;

    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("Failed to open transcript file: {e}"))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("Failed to append transcript event: {e}"))?;

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn delete_transcript(app: AppHandle, thread_id: String) -> CommandResult<()> {
    let p = transcript_file_path(&app, &thread_id)?;
    if !p.exists() {
        return Ok(());
    }
    fs::remove_file(&p).map_err(|e| format!("Failed to delete transcript {}: {}", p.display(), e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_workspace_server,
            stop_workspace_server,
            load_state,
            save_state,
            read_transcript,
            append_transcript_event,
            delete_transcript
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
