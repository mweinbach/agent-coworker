//! Native platform integration module (owned by `native`).
//!
//! Replaces `apps/desktop/electron/`: `cowork-server` child process manager, desktop JSON
//! persistence, window state, menus/tray/shortcuts, native file/folder dialogs, path-bounded
//! workspace file explorer & preview backend, notifications, and updater stubs.

pub mod local_logs;
pub mod path_boundary;
pub mod persistence;
pub mod security;
pub mod server_manager;
pub mod server_platform;
pub mod shutdown;
pub mod sidecar;
pub mod validation;
pub mod window_state;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rune::{App, AppHandle, FileDialogOptions};
use serde_json::json;
use tokio::sync::mpsc;

use crate::actions::{NativeCommand, StoreEvent};
use crate::state::{AppState, PersistedDesktopState};
use local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger, strip_url_secrets};
use persistence::{
    PersistenceService, read_user_data_override_env, resolve_legacy_user_data_dir,
    resolve_user_data_dir,
};
use security::{WorkspaceRootsController, assert_allowed_external_url};
use server_manager::{
    ServerManager, ServerManagerRuntime, StartWorkspaceServerOptions, WorkspaceServerFeatureFlags,
};
use shutdown::ShutdownCoordinator;
use sidecar::resolve_dev_repo_root;
use window_state::WindowStateStore;

static APP_HANDLE: OnceLock<Mutex<Option<AppHandle<AppState>>>> = OnceLock::new();

fn app_handle_slot() -> &'static Mutex<Option<AppHandle<AppState>>> {
    APP_HANDLE.get_or_init(|| Mutex::new(None))
}

fn store_app_handle(handle: AppHandle<AppState>) {
    let mut guard = app_handle_slot().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(handle);
}

fn current_app_handle() -> Option<AppHandle<AppState>> {
    app_handle_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Configures OS-level window chrome, menus, tray, focus/close/quit handlers on `App`.
pub fn configure_app(app: App<AppState>) -> App<AppState> {
    let handle = app.handle();
    store_app_handle(handle);

    app.standard_menus()
        .on_open_url(|state, url, _tx| {
            state.apply_store_event(StoreEvent::DeepLink(url.to_string()));
        })
        .on_quit(|state, _tx| {
            on_shutdown(state);
        })
}

/// Spawns the background native runtime (`PersistenceService`, `ServerManager`, `WindowStateStore`)
/// on a dedicated OS thread hosting a Tokio runtime, delivering [`StoreEvent`] updates and
/// waking the UI thread via `waker`.
pub fn spawn_native_worker(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> mpsc::UnboundedSender<NativeCommand> {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<NativeCommand>();
    let _ = std::thread::Builder::new()
        .name("cowork-native-worker".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("cowork-native-rt")
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    eprintln!("cowork-native-worker failed to build tokio runtime: {err}");
                    return;
                }
            };

            rt.block_on(async move {
                let emit = make_emitter(event_tx, waker);
                let mut runtime_ctx = NativeWorkerContext::initialize(emit.clone());

                let persisted = runtime_ctx.load_initial_state();
                let is_packaged = runtime_ctx.is_packaged;
                let system_dark = detect_system_dark();
                emit(StoreEvent::NativeReady {
                    persisted: Box::new(persisted),
                    is_packaged,
                    system_dark,
                });

                let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
                runtime_ctx.window_state.spawn_debounce_loop(shutdown_rx);

                let coordinator = ShutdownCoordinator::new(
                    runtime_ctx.server_manager.clone(),
                    Some(runtime_ctx.window_state.clone()),
                    Some(runtime_ctx.logger.clone()),
                    Some(shutdown_tx),
                );

                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        NativeCommand::Shutdown => {
                            coordinator.shutdown().await;
                            break;
                        }
                        other => {
                            runtime_ctx.handle_command(other).await;
                        }
                    }
                }

                coordinator.shutdown().await;
            });
        });
    cmd_tx
}

/// Flushes native state and triggers graceful sidecar shutdown.
pub fn on_shutdown(state: &mut AppState) {
    state.send_native(NativeCommand::Shutdown);
    state.send_ws(crate::ws::WsCommand::Shutdown);
}

struct NativeWorkerContext {
    is_packaged: bool,
    logger: Arc<LocalLogger>,
    persistence: Arc<PersistenceService>,
    window_state: WindowStateStore,
    roots: Arc<Mutex<WorkspaceRootsController>>,
    server_manager: ServerManager,
    last_feature_flags: HashMap<String, bool>,
    last_privacy: Option<crate::state::PrivacyTelemetrySettings>,
    emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
}

impl NativeWorkerContext {
    fn initialize(emit: Arc<dyn Fn(StoreEvent) + Send + Sync>) -> Self {
        let env = cowork_config::env_map_from_process();
        let is_packaged = is_packaged_build();
        let has_override = read_user_data_override_env(&env).is_some();
        let user_data_dir = resolve_user_data_dir(is_packaged, &env).unwrap_or_else(|err| {
            eprintln!("[native] falling back from userData resolution error: {err}");
            cowork_config::resolve_home_dir(&env, cowork_config::host_platform())
                .join(".cowork")
                .join("desktop")
        });
        let legacy_dir = resolve_legacy_user_data_dir(&env);

        let logger = Arc::new(LocalLogger::new(&user_data_dir));
        let persistence = Arc::new(PersistenceService::new(
            user_data_dir.clone(),
            Some(legacy_dir),
            has_override,
            Some(logger.clone()),
        ));
        let window_state = WindowStateStore::new(&user_data_dir);
        let roots = Arc::new(Mutex::new(WorkspaceRootsController::new()));

        let current_exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
        let cwd = std::env::current_dir().ok();
        let repo_root = resolve_dev_repo_root(&env, current_exe_dir.as_deref(), cwd.as_deref());
        let resources_dir = current_exe_dir.as_ref().and_then(|dir| {
            #[cfg(target_os = "macos")]
            {
                let res = dir.parent().map(|contents| contents.join("Resources"));
                if res.as_ref().is_some_and(|p| p.is_dir()) {
                    return res;
                }
            }
            Some(dir.clone())
        });

        let server_manager = ServerManager::new(
            ServerManagerRuntime {
                user_data_dir,
                resources_dir,
                current_exe_dir,
                repo_root,
                is_packaged,
            },
            Some(logger.clone()),
            Some(emit.clone()),
        );

        Self {
            is_packaged,
            logger,
            persistence,
            window_state,
            roots,
            server_manager,
            last_feature_flags: HashMap::new(),
            last_privacy: None,
            emit,
        }
    }

    fn load_initial_state(&mut self) -> PersistedDesktopState {
        match self.persistence.load_state_value() {
            Ok(doc) => {
                let approved = {
                    let mut guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
                    PersistenceService::sync_workspace_roots(&doc, &mut guard);
                    guard.approved_roots()
                };
                self.logger.set_workspace_paths(approved);
                let core = persistence::core_state_from_document(&doc);
                self.last_feature_flags = core.feature_flags.clone();
                self.last_privacy = Some(core.settings.privacy_telemetry.clone());
                core
            }
            Err(err) => {
                let meta = json!({ "error": err.to_string() });
                self.logger.write(
                    LocalLogFileName::Server,
                    LocalLogLevel::Error,
                    "persistence",
                    "failed to load persisted state",
                    Some(&meta),
                );
                PersistedDesktopState::default()
            }
        }
    }

    async fn handle_command(&mut self, cmd: NativeCommand) {
        match cmd {
            NativeCommand::StartWorkspaceServer {
                workspace_id,
                path,
                yolo,
            } => {
                let approved = {
                    let mut guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = guard.register_workspace(&workspace_id, &PathBuf::from(&path));
                    guard.approved_roots()
                };
                self.logger.set_workspace_paths(approved);

                let mgr = self.server_manager.clone();
                let logger = self.logger.clone();
                let emit = self.emit.clone();
                let opts = StartWorkspaceServerOptions {
                    workspace_id: workspace_id.clone(),
                    workspace_path: PathBuf::from(&path),
                    yolo,
                    force_restart: false,
                    mobile_h3: None,
                    rotate_mobile_h3_tls: false,
                    feature_flags: WorkspaceServerFeatureFlags::from_feature_flag_map(
                        &self.last_feature_flags,
                    ),
                    privacy_telemetry: self.last_privacy.clone(),
                };
                tokio::spawn(async move {
                    if let Err(err) = mgr.start_workspace_server(opts).await {
                        let meta = json!({
                            "workspaceId": workspace_id,
                            "error": err,
                        });
                        logger.write(
                            LocalLogFileName::Server,
                            LocalLogLevel::Error,
                            "server-manager",
                            "failed to start workspace server",
                            Some(&meta),
                        );
                        emit(StoreEvent::ServerExited {
                            workspace_id,
                            code: None,
                            message: Some(err),
                        });
                    }
                });
            }
            NativeCommand::StopWorkspaceServer { workspace_id } => {
                if let Err(err) = self
                    .server_manager
                    .stop_workspace_server(&workspace_id)
                    .await
                {
                    let meta = json!({
                        "workspaceId": workspace_id,
                        "error": err,
                    });
                    self.logger.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Warn,
                        "server-manager",
                        "failed to stop workspace server cleanly",
                        Some(&meta),
                    );
                }
            }
            NativeCommand::SavePersistedState(snapshot) => {
                self.last_feature_flags = snapshot.feature_flags.clone();
                self.last_privacy = Some(snapshot.settings.privacy_telemetry.clone());
                match self.persistence.merge_and_save_core_snapshot(&snapshot) {
                    Ok(doc) => {
                        let approved = {
                            let mut guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
                            PersistenceService::sync_workspace_roots(&doc, &mut guard);
                            guard.approved_roots()
                        };
                        self.logger.set_workspace_paths(approved);
                    }
                    Err(err) => {
                        let meta = json!({ "error": err.to_string() });
                        self.logger.write(
                            LocalLogFileName::Server,
                            LocalLogLevel::Error,
                            "persistence",
                            "failed to persist desktop state",
                            Some(&meta),
                        );
                    }
                }
            }
            NativeCommand::PickFolder { request_id } => {
                self.dispatch_pick_folder(request_id);
            }
            NativeCommand::PickFiles {
                request_id,
                allow_multiple,
            } => {
                self.dispatch_pick_files(request_id, allow_multiple);
            }
            NativeCommand::OpenExternalUrl(url) => {
                if let Err(err) = assert_allowed_external_url(&url) {
                    let meta = json!({
                        "url": strip_url_secrets(&url),
                        "error": err.to_string(),
                    });
                    self.logger.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Warn,
                        "security",
                        "blocked disallowed external URL",
                        Some(&meta),
                    );
                    return;
                }
                if let Some(handle) = current_app_handle() {
                    handle.update(move |_state, tx| {
                        let _ = tx.open_url(&url);
                    });
                }
            }
            // Slice 2 platform services (file explorer, watcher, preview, notifications,
            // diagnostics, updater) will be wired in the second native slice commit.
            NativeCommand::ListWorkspaceFiles {
                workspace_id, dir, ..
            } => {
                (self.emit)(StoreEvent::WorkspaceFilesListed {
                    workspace_id,
                    dir,
                    entries: Vec::new(),
                });
            }
            NativeCommand::ReadFilePreview {
                workspace_id, path, ..
            } => {
                (self.emit)(StoreEvent::FilePreviewLoaded {
                    workspace_id,
                    path,
                    result: Err("Native file preview service is queued for Slice 2".into()),
                });
            }
            NativeCommand::FetchImageBytes { request_id, .. } => {
                (self.emit)(StoreEvent::ImageBytesLoaded {
                    request_id,
                    mime_type: None,
                    result: Err("Native image fetcher is queued for Slice 2".into()),
                });
            }
            NativeCommand::RevealInOs(_)
            | NativeCommand::OpenInDefaultApp(_)
            | NativeCommand::TrashPath(_)
            | NativeCommand::ShowDesktopNotification { .. }
            | NativeCommand::ExportDiagnosticsBundle
            | NativeCommand::CheckForUpdates
            | NativeCommand::QuitAndInstallUpdate => {}
            NativeCommand::Shutdown => {}
        }
    }

    fn dispatch_pick_folder(&self, request_id: String) {
        let Some(handle) = current_app_handle() else {
            (self.emit)(StoreEvent::FolderPicked {
                request_id,
                path: None,
            });
            return;
        };
        let roots = self.roots.clone();
        let req_id = request_id.clone();
        handle.update(move |_state, tx| {
            let roots_inner = roots.clone();
            let id_inner = req_id.clone();
            let options = FileDialogOptions {
                title: "Open Workspace Folder".into(),
                ..Default::default()
            };
            tx.open_folder(options, move |state: &mut AppState, result, _tx| {
                let picked = result.ok().flatten();
                if let Some(ref p) = picked {
                    let mut guard = roots_inner.lock().unwrap_or_else(|e| e.into_inner());
                    guard.approve_root(p, false);
                }
                state.apply_store_event(StoreEvent::FolderPicked {
                    request_id: id_inner,
                    path: picked,
                });
            });
        });
    }

    fn dispatch_pick_files(&self, request_id: String, _allow_multiple: bool) {
        let Some(handle) = current_app_handle() else {
            (self.emit)(StoreEvent::FilesPicked {
                request_id,
                paths: Vec::new(),
            });
            return;
        };
        let roots = self.roots.clone();
        let req_id = request_id.clone();
        handle.update(move |_state, tx| {
            let roots_inner = roots.clone();
            let id_inner = req_id.clone();
            // Note: Rune's native FileDialogOptions currently supports single-file open_file;
            // multi-select falls back to single file selection cleanly until Rune exposes `.multiple`.
            let options = FileDialogOptions {
                title: "Select Files".into(),
                ..Default::default()
            };
            tx.open_file(options, move |state: &mut AppState, result, _tx| {
                let paths = match result.ok().flatten() {
                    Some(p) => {
                        let mut guard = roots_inner.lock().unwrap_or_else(|e| e.into_inner());
                        guard.approve_root(&p, false);
                        vec![p]
                    }
                    None => Vec::new(),
                };
                state.apply_store_event(StoreEvent::FilesPicked {
                    request_id: id_inner,
                    paths,
                });
            });
        });
    }
}

fn make_emitter(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> Arc<dyn Fn(StoreEvent) + Send + Sync> {
    Arc::new(move |event| {
        if event_tx.send(event).is_ok()
            && let Some(ref w) = waker
        {
            (w)();
        }
    })
}

fn is_packaged_build() -> bool {
    if std::env::var("COWORK_DESKTOP_PACKAGED").as_deref() == Ok("1") {
        return true;
    }
    #[cfg(target_os = "macos")]
    if let Ok(exe) = std::env::current_exe()
        && exe.to_string_lossy().contains(".app/Contents/MacOS/")
    {
        return true;
    }
    false
}

fn detect_system_dark() -> Option<bool> {
    None
}
