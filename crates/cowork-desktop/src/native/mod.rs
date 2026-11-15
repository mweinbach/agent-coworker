//! Native platform integration module (owned by `native`).
//!
//! Replaces `apps/desktop/electron/`: `cowork-server` child process manager, desktop JSON
//! persistence, window state, menus/tray/shortcuts, native file/folder dialogs, path-bounded
//! workspace file explorer & preview backend, notifications, diagnostics, and updater stubs.

pub mod appearance;
pub mod apply_desktop_state;
pub mod diagnostics;
pub mod dialogs;
pub mod explorer;
pub mod file_entry_rename;
pub mod file_preview_read;
pub mod launchable_files;
pub mod local_logs;
pub mod menu;
pub mod notifications;
pub mod path_boundary;
pub mod persistence;
pub mod remote_access;
pub mod security;
pub mod server_manager;
pub mod server_platform;
pub mod shell_ops;
pub mod shutdown;
pub mod sidecar;
pub mod telemetry_status;
pub mod tray;
pub mod updater;
pub mod validation;
pub mod watcher;
pub mod window_chrome;
pub mod window_lifecycle;
pub mod window_state;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use cowork_config::canonicalize_sync;
use rune::{App, AppHandle};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::actions::{NativeCommand, StoreEvent};
use crate::state::{AppState, PersistedDesktopState, PrivacyTelemetrySettings};
use appearance::{AppearancePreferences, detect_system_dark};
use apply_desktop_state::apply_desktop_state;
use diagnostics::DiagnosticsService;
use explorer::list_workspace_directory;
use file_preview_read::{DEFAULT_PREVIEW_MAX_BYTES, load_file_preview_state};
use local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger, strip_url_secrets};
use notifications::DesktopNotificationService;
use persistence::{
    PersistenceService, read_user_data_override_env, resolve_legacy_user_data_dir,
    resolve_user_data_dir,
};
use remote_access::RemoteAccessBridge;
use security::{
    AuthorizedUploadRegistry, WorkspaceRootsController, assert_allowed_external_url,
    resolve_effective_feature_flags,
};
use server_manager::{
    ServerManager, ServerManagerRuntime, StartWorkspaceServerOptions, WorkspaceServerFeatureFlags,
};
use shell_ops::{
    DEFAULT_IMAGE_FETCH_MAX_BYTES, OpenInDefaultAppOutcome, fetch_image_bytes,
    open_external_url_os, open_in_default_app, reveal_in_os, trash_workspace_entry,
};
use shutdown::ShutdownCoordinator;
use sidecar::resolve_dev_repo_root;
use telemetry_status::resolve_desktop_telemetry_status;
use tray::QuickChatTrayController;
use updater::DesktopUpdaterService;
use watcher::{WatchChangeKind, WorkspaceDirectoryWatcher};
use window_state::WindowStateStore;

type ShutdownLatch = Arc<(Mutex<bool>, Condvar)>;

const QUIT_SHUTDOWN_WAIT_TIMEOUT: Duration = Duration::from_secs(15);

static APP_HANDLE: OnceLock<Mutex<Option<AppHandle<AppState>>>> = OnceLock::new();
static WORKER_CMD_TX: OnceLock<Mutex<Option<mpsc::UnboundedSender<NativeCommand>>>> =
    OnceLock::new();
static SHUTDOWN_LATCH: OnceLock<Mutex<Option<ShutdownLatch>>> = OnceLock::new();

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

fn worker_cmd_slot() -> &'static Mutex<Option<mpsc::UnboundedSender<NativeCommand>>> {
    WORKER_CMD_TX.get_or_init(|| Mutex::new(None))
}

fn store_worker_cmd_tx(tx: mpsc::UnboundedSender<NativeCommand>) {
    let mut guard = worker_cmd_slot().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(tx);
}

fn take_worker_cmd_tx() -> Option<mpsc::UnboundedSender<NativeCommand>> {
    worker_cmd_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn shutdown_latch_slot() -> &'static Mutex<Option<ShutdownLatch>> {
    SHUTDOWN_LATCH.get_or_init(|| Mutex::new(None))
}

fn store_shutdown_latch(latch: Option<ShutdownLatch>) {
    let mut guard = shutdown_latch_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = latch;
}

fn current_shutdown_latch() -> Option<ShutdownLatch> {
    shutdown_latch_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Configures OS-level menus, deep links, and synchronous quit coordination on `App`.
pub fn configure_app(app: App<AppState>) -> App<AppState> {
    let handle = app.handle();
    store_app_handle(handle);

    menu::install_application_menus(app)
        .on_open_url(|state, url, _tx| {
            state.apply_store_event(StoreEvent::DeepLink(url.to_string()));
        })
        .on_quit(|state, _tx| {
            on_shutdown(state);
        })
}

/// Spawns the background native runtime (`PersistenceService`, `ServerManager`, `WindowStateStore`,
/// filesystem explorer/preview/watcher, tray/shortcuts, notifications, diagnostics, updater stub)
/// on a dedicated OS thread hosting a Tokio runtime, delivering [`StoreEvent`] updates and
/// waking the UI thread via `waker`.
pub fn spawn_native_worker(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> mpsc::UnboundedSender<NativeCommand> {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<NativeCommand>();
    store_worker_cmd_tx(cmd_tx.clone());
    let latch = Arc::new((Mutex::new(false), Condvar::new()));
    store_shutdown_latch(Some(latch.clone()));

    let spawn_res = std::thread::Builder::new()
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
                    let (lock, cvar) = &*latch;
                    *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    cvar.notify_all();
                    return;
                }
            };

            rt.block_on(async move {
                let emit = make_emitter(event_tx, waker);
                let mut runtime_ctx = NativeWorkerContext::initialize(emit.clone());
                runtime_ctx.notifications.initialize(current_app_handle());

                let persisted = runtime_ctx.load_initial_state();
                let is_packaged = runtime_ctx.is_packaged;
                let system_dark = detect_system_dark();
                emit(StoreEvent::NativeReady {
                    persisted: Box::new(persisted),
                    is_packaged,
                    system_dark,
                });
                emit(StoreEvent::TelemetryStatusChanged(
                    runtime_ctx.compute_telemetry_status(),
                ));
                emit(StoreEvent::RemoteAccessChanged(
                    runtime_ctx.remote_access.current_state(),
                ));

                let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
                runtime_ctx.window_state.spawn_debounce_loop(shutdown_rx);

                let coordinator = ShutdownCoordinator::new(
                    runtime_ctx.server_manager.clone(),
                    Some(runtime_ctx.window_state.clone()),
                    Some(runtime_ctx.logger.clone()),
                    Some(shutdown_tx),
                );
                let coord_latch = coordinator.completion_latch();
                store_shutdown_latch(Some(coord_latch));

                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        NativeCommand::Shutdown => {
                            runtime_ctx.watcher.unwatch_all().await;
                            runtime_ctx.tray.teardown(current_app_handle().as_ref());
                            coordinator.shutdown().await;
                            break;
                        }
                        other => {
                            runtime_ctx.handle_command(other).await;
                        }
                    }
                }

                runtime_ctx.watcher.unwatch_all().await;
                runtime_ctx.tray.teardown(current_app_handle().as_ref());
                coordinator.shutdown().await;
                let (lock, cvar) = &*latch;
                *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
                cvar.notify_all();
            });
        });

    if spawn_res.is_err() {
        store_shutdown_latch(None);
    }

    cmd_tx
}

/// Signals native and WebSocket teardown and blocks briefly until sidecars/logs finish flushing,
/// because Rune runs `fast_exit` immediately after `App::on_quit` returns.
pub fn on_shutdown(state: &mut AppState) {
    state.send_native(NativeCommand::Shutdown);
    state.send_ws(crate::ws::WsCommand::Shutdown);
    if let Some(tx) = take_worker_cmd_tx() {
        let sent = tx.send(NativeCommand::Shutdown).is_ok();
        if sent && let Some(latch) = current_shutdown_latch() {
            let _ = ShutdownCoordinator::wait_until_done(&latch, QUIT_SHUTDOWN_WAIT_TIMEOUT);
        }
    }
}

struct NativeWorkerContext {
    is_packaged: bool,
    logger: Arc<LocalLogger>,
    persistence: Arc<PersistenceService>,
    window_state: WindowStateStore,
    appearance: AppearancePreferences,
    roots: Arc<Mutex<WorkspaceRootsController>>,
    uploads: Arc<Mutex<AuthorizedUploadRegistry>>,
    server_manager: ServerManager,
    remote_access: RemoteAccessBridge,
    watcher: WorkspaceDirectoryWatcher,
    notifications: DesktopNotificationService,
    updater: DesktopUpdaterService,
    diagnostics: DiagnosticsService,
    tray: QuickChatTrayController,
    last_feature_flags: HashMap<String, bool>,
    last_privacy: Option<PrivacyTelemetrySettings>,
    show_hidden_files: Arc<AtomicBool>,
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
        let appearance = AppearancePreferences::new(&user_data_dir);
        let roots = Arc::new(Mutex::new(WorkspaceRootsController::new()));
        let uploads = Arc::new(Mutex::new(AuthorizedUploadRegistry::new()));

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
                user_data_dir: user_data_dir.clone(),
                resources_dir,
                current_exe_dir,
                repo_root,
                is_packaged,
            },
            Some(logger.clone()),
            Some(emit.clone()),
        );

        let notifications = DesktopNotificationService::new(Some(logger.clone()));
        let updater = DesktopUpdaterService::new(Some(logger.clone()), emit.clone());
        let diag_mgr = server_manager.clone();
        let diagnostics = DiagnosticsService::new(
            user_data_dir,
            is_packaged,
            persistence.clone(),
            logger.clone(),
            Some(updater.clone()),
            Arc::new(move || diag_mgr.get_diagnostics()),
        );
        let tray = QuickChatTrayController::new(Some(logger.clone()));
        let remote_access = RemoteAccessBridge::new(
            server_manager.clone(),
            Some(logger.clone()),
            emit.clone(),
            false,
        );

        Self {
            is_packaged,
            logger,
            persistence,
            window_state,
            appearance,
            roots,
            uploads,
            server_manager,
            remote_access,
            watcher: WorkspaceDirectoryWatcher::new(),
            notifications,
            updater,
            diagnostics,
            tray,
            last_feature_flags: HashMap::new(),
            last_privacy: None,
            show_hidden_files: Arc::new(AtomicBool::new(false)),
            emit,
        }
    }

    fn load_initial_state(&mut self) -> PersistedDesktopState {
        let env = cowork_config::env_map_from_process();
        match self.persistence.load_state_value() {
            Ok(doc) => {
                let approved = {
                    let mut guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
                    PersistenceService::sync_workspace_roots(&doc, &mut guard);
                    guard.approved_roots()
                };
                self.logger.set_workspace_paths(approved);
                let mut core = persistence::core_state_from_document(&doc);
                core.feature_flags =
                    resolve_effective_feature_flags(&core.feature_flags, &env, self.is_packaged);
                self.sync_runtime_caches(&core);
                apply_desktop_state(
                    &core,
                    &self.roots,
                    &self.logger,
                    &self.appearance,
                    &self.tray,
                    current_app_handle().as_ref(),
                    false,
                    self.is_packaged,
                );
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
                let core = PersistedDesktopState {
                    feature_flags: resolve_effective_feature_flags(
                        &HashMap::new(),
                        &env,
                        self.is_packaged,
                    ),
                    ..PersistedDesktopState::default()
                };
                self.sync_runtime_caches(&core);
                core
            }
        }
    }

    fn sync_runtime_caches(&mut self, state: &PersistedDesktopState) {
        self.last_feature_flags = state.feature_flags.clone();
        self.last_privacy = Some(state.settings.privacy_telemetry.clone());
        self.show_hidden_files
            .store(state.settings.show_hidden_files, Ordering::Release);

        let remote_available = self
            .last_feature_flags
            .get("remoteAccess")
            .copied()
            .unwrap_or(false);
        let ws_targets: Vec<(String, PathBuf, bool)> = state
            .workspaces
            .iter()
            .filter(|w| !w.archived)
            .map(|w| (w.id.clone(), PathBuf::from(&w.path), w.yolo))
            .collect();
        self.remote_access.sync_catalog(
            remote_available,
            state.active_workspace_id.as_deref(),
            &ws_targets,
        );
    }

    fn server_feature_flags(&self) -> WorkspaceServerFeatureFlags {
        WorkspaceServerFeatureFlags::from_feature_flag_map(&self.last_feature_flags)
    }

    fn compute_telemetry_status(&self) -> Value {
        let mut snapshot = PersistedDesktopState::default();
        if let Some(ref privacy) = self.last_privacy {
            snapshot.settings.privacy_telemetry = privacy.clone();
        }
        let raw_doc = self.persistence.load_state_value().ok();
        let env = cowork_config::env_map_from_process();
        resolve_desktop_telemetry_status(&snapshot, raw_doc.as_ref(), &env, self.is_packaged)
    }

    fn authorize_explorer_workspace_root(
        &self,
        workspace_id: &str,
        workspace_root: &str,
    ) -> Result<PathBuf, String> {
        let trimmed_root = workspace_root.trim();
        let candidate = (!trimmed_root.is_empty()).then(|| PathBuf::from(trimmed_root));
        let mut guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(valid) =
            guard.resolve_authorized_workspace_root(workspace_id, candidate.as_deref())
        {
            return Ok(valid);
        }

        if let Some(raw_path) = candidate {
            let env = cowork_config::env_map_from_process();
            let home = cowork_config::resolve_home_dir(&env, cowork_config::host_platform());
            let chats_root = cowork_config::get_one_off_chats_root(&home);
            let lexical = cowork_config::normalize_lexical_path(&raw_path);
            let chats_lexical = cowork_config::normalize_lexical_path(&chats_root);
            if cowork_config::is_inside(&chats_lexical, &lexical) && lexical != chats_lexical {
                return guard
                    .approve_one_off_chat_workspace(workspace_id, &raw_path, &chats_root)
                    .map_err(|err| err.to_string());
            }
        }

        Err("Unauthorized workspace root".to_string())
    }

    fn approved_roots_snapshot(&self) -> Vec<PathBuf> {
        self.roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .approved_roots()
    }

    fn authorize_workspace_start(
        &self,
        workspace_id: &str,
        raw_path: &Path,
    ) -> Result<PathBuf, String> {
        let mut guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(resolved) = guard.resolve_authorized_workspace_root(workspace_id, Some(raw_path))
        {
            return Ok(resolved);
        }

        // Allow newly created one-off chat directories strictly inside `~/.cowork/chats`.
        let env = cowork_config::env_map_from_process();
        let home = cowork_config::resolve_home_dir(&env, cowork_config::host_platform());
        let chats_root = cowork_config::get_one_off_chats_root(&home);
        let lexical = cowork_config::normalize_lexical_path(raw_path);
        let chats_lexical = cowork_config::normalize_lexical_path(&chats_root);
        if cowork_config::is_inside(&chats_lexical, &lexical) && lexical != chats_lexical {
            return guard
                .approve_one_off_chat_workspace(workspace_id, raw_path, &chats_root)
                .map_err(|err| err.to_string());
        }

        Err(
            "Workspace path is not approved. Select the folder with the desktop picker before starting."
                .to_string(),
        )
    }

    async fn handle_command(&mut self, cmd: NativeCommand) {
        match cmd {
            NativeCommand::StartWorkspaceServer {
                workspace_id,
                path,
                yolo,
            } => {
                let requested = PathBuf::from(&path);
                let authorized_path =
                    match self.authorize_workspace_start(&workspace_id, &requested) {
                        Ok(valid) => valid,
                        Err(err) => {
                            let meta = json!({
                                "workspaceId": workspace_id,
                                "error": err,
                            });
                            self.logger.write(
                                LocalLogFileName::Server,
                                LocalLogLevel::Warn,
                                "security",
                                "blocked server start for unapproved workspace root",
                                Some(&meta),
                            );
                            (self.emit)(StoreEvent::ServerExited {
                                workspace_id,
                                code: None,
                                message: Some(err),
                            });
                            return;
                        }
                    };
                self.logger
                    .set_workspace_paths(self.approved_roots_snapshot());

                // Watch workspace files to keep explorer listings synchronized on external edits.
                let emit_watch = self.emit.clone();
                let watch_roots = vec![authorized_path.clone()];
                let watch_root_canonical = canonicalize_sync(&authorized_path);
                let show_hidden = self.show_hidden_files.clone();
                let watch_ws_id = workspace_id.clone();
                let _ = self
                    .watcher
                    .watch(
                        &watch_ws_id,
                        &authorized_path,
                        Arc::new(move |batch| {
                            if batch.kind == WatchChangeKind::Error {
                                return;
                            }
                            let include_hidden = show_hidden.load(Ordering::Acquire);
                            for dir in batch.affected_dirs {
                                if let Ok(entries) =
                                    list_workspace_directory(&watch_roots, &dir, include_hidden)
                                {
                                    let dir_key = if canonicalize_sync(&dir) == watch_root_canonical
                                    {
                                        ".".to_string()
                                    } else {
                                        dir.to_string_lossy().into_owned()
                                    };
                                    emit_watch(StoreEvent::WorkspaceFilesListed {
                                        workspace_id: batch.workspace_id.clone(),
                                        dir: dir_key,
                                        entries,
                                    });
                                }
                            }
                        }),
                    )
                    .await;

                let mgr = self.server_manager.clone();
                let remote = self.remote_access.clone();
                let logger = self.logger.clone();
                let emit = self.emit.clone();
                let mobile_h3 = self.remote_access.desired_for_workspace(&workspace_id);
                let opts = StartWorkspaceServerOptions {
                    workspace_id: workspace_id.clone(),
                    workspace_path: authorized_path,
                    yolo,
                    force_restart: false,
                    mobile_h3: Some(mobile_h3),
                    rotate_mobile_h3_tls: false,
                    feature_flags: self.server_feature_flags(),
                    privacy_telemetry: self.last_privacy.clone(),
                };
                tokio::spawn(async move {
                    match mgr.start_workspace_server(opts).await {
                        Ok(started) => {
                            remote.on_server_started(
                                &started.workspace_id,
                                started.mobile_h3.as_ref(),
                            );
                        }
                        Err(err) => {
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
                            remote.on_server_exited(&workspace_id);
                            emit(StoreEvent::ServerExited {
                                workspace_id,
                                code: None,
                                message: Some(err),
                            });
                        }
                    }
                });
            }
            NativeCommand::StopWorkspaceServer { workspace_id } => {
                let root = {
                    let guard = self.roots.lock().unwrap_or_else(|e| e.into_inner());
                    guard
                        .resolve_authorized_workspace_root(&workspace_id, None)
                        .ok()
                };
                if let Some(root) = root {
                    self.watcher.unwatch(&workspace_id, &root).await;
                }
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
                        "failed to stop workspace server",
                        Some(&meta),
                    );
                }
                self.remote_access.on_server_exited(&workspace_id);
            }
            NativeCommand::SavePersistedState(snapshot) => {
                let env = cowork_config::env_map_from_process();
                let mut runtime_snapshot = (*snapshot).clone();
                runtime_snapshot.feature_flags = resolve_effective_feature_flags(
                    &snapshot.feature_flags,
                    &env,
                    self.is_packaged,
                );
                self.sync_runtime_caches(&runtime_snapshot);

                if let Err(err) = self.persistence.merge_and_save_core_snapshot(&snapshot) {
                    let meta = json!({ "error": err.to_string() });
                    self.logger.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Error,
                        "persistence",
                        "failed to persist desktop snapshot",
                        Some(&meta),
                    );
                }
                apply_desktop_state(
                    &runtime_snapshot,
                    &self.roots,
                    &self.logger,
                    &self.appearance,
                    &self.tray,
                    current_app_handle().as_ref(),
                    true,
                    self.is_packaged,
                );
                (self.emit)(StoreEvent::TelemetryStatusChanged(
                    self.compute_telemetry_status(),
                ));
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
            NativeCommand::ListWorkspaceFiles {
                request_id: _,
                workspace_id,
                workspace_root,
                dir,
                show_hidden,
            } => {
                let authorized_root =
                    match self.authorize_explorer_workspace_root(&workspace_id, &workspace_root) {
                        Ok(valid) => valid,
                        Err(err) => {
                            let meta = json!({ "workspaceId": workspace_id, "error": err });
                            self.logger.warn(
                                "explorer",
                                "blocked directory listing for unauthorized workspace",
                                Some(&meta),
                            );
                            (self.emit)(StoreEvent::WorkspaceFilesListed {
                                workspace_id,
                                dir,
                                entries: Vec::new(),
                            });
                            return;
                        }
                    };
                let target_dir = resolve_workspace_scoped_path(&authorized_root, &dir);
                let roots = vec![authorized_root];
                let emit = self.emit.clone();
                let logger = self.logger.clone();
                let dir_str = dir;
                tokio::spawn(async move {
                    let res = tokio::task::spawn_blocking(move || {
                        list_workspace_directory(&roots, &target_dir, show_hidden)
                    })
                    .await;
                    let entries = match res {
                        Ok(Ok(entries)) => entries,
                        Ok(Err(err)) => {
                            let meta =
                                json!({ "workspaceId": workspace_id, "error": err.to_string() });
                            logger.warn(
                                "explorer",
                                "failed to list workspace directory",
                                Some(&meta),
                            );
                            Vec::new()
                        }
                        Err(err) => {
                            let meta =
                                json!({ "workspaceId": workspace_id, "error": err.to_string() });
                            logger.error("explorer", "explorer task panicked", Some(&meta));
                            Vec::new()
                        }
                    };
                    emit(StoreEvent::WorkspaceFilesListed {
                        workspace_id,
                        dir: dir_str,
                        entries,
                    });
                });
            }
            NativeCommand::ReadFilePreview {
                request_id: _,
                workspace_id,
                workspace_root,
                path,
            } => {
                let authorized_root =
                    match self.authorize_explorer_workspace_root(&workspace_id, &workspace_root) {
                        Ok(valid) => valid,
                        Err(err) => {
                            let meta = json!({ "workspaceId": workspace_id, "error": err });
                            self.logger.warn(
                                "explorer",
                                "blocked file preview for unauthorized workspace",
                                Some(&meta),
                            );
                            (self.emit)(StoreEvent::FilePreviewLoaded {
                                workspace_id,
                                path,
                                result: Err(err),
                            });
                            return;
                        }
                    };
                let target_path = resolve_workspace_scoped_path(&authorized_root, &path);
                let roots = vec![authorized_root];
                let emit = self.emit.clone();
                let ws_id = workspace_id.clone();
                tokio::spawn(async move {
                    let res = tokio::task::spawn_blocking(move || {
                        load_file_preview_state(
                            &roots,
                            &ws_id,
                            &target_path,
                            DEFAULT_PREVIEW_MAX_BYTES,
                        )
                    })
                    .await;
                    let result = match res {
                        Ok(Ok(preview)) => Ok(preview),
                        Ok(Err(err)) => Err(err.to_string()),
                        Err(err) => Err(format!("Preview reader failed: {err}")),
                    };
                    emit(StoreEvent::FilePreviewLoaded {
                        workspace_id,
                        path,
                        result,
                    });
                });
            }
            NativeCommand::FetchImageBytes { request_id, url } => {
                let emit = self.emit.clone();
                let logger = self.logger.clone();
                tokio::spawn(async move {
                    match fetch_image_bytes(&url, DEFAULT_IMAGE_FETCH_MAX_BYTES).await {
                        Ok((mime_type, bytes)) => {
                            emit(StoreEvent::ImageBytesLoaded {
                                request_id,
                                mime_type,
                                result: Ok(bytes),
                            });
                        }
                        Err(err) => {
                            let meta = json!({
                                "url": strip_url_secrets(&url),
                                "error": err.to_string(),
                            });
                            logger.warn("images", "failed to fetch image bytes", Some(&meta));
                            emit(StoreEvent::ImageBytesLoaded {
                                request_id,
                                mime_type: None,
                                result: Err(err.to_string()),
                            });
                        }
                    }
                });
            }
            NativeCommand::OpenExternalUrl(url) => match assert_allowed_external_url(&url) {
                Ok(parsed) => {
                    let url_str = parsed.to_string();
                    if let Some(handle) = current_app_handle() {
                        let fallback = url_str.clone();
                        handle.update(move |_state, tx| {
                            if tx.open_url(&url_str).is_err() {
                                let _ = open_external_url_os(&fallback);
                            }
                        });
                    } else if let Err(err) = open_external_url_os(&url_str) {
                        let meta =
                            json!({ "url": strip_url_secrets(&url_str), "error": err.to_string() });
                        self.logger
                            .warn("security", "failed to open external url", Some(&meta));
                    }
                }
                Err(err) => {
                    let meta = json!({
                        "url": strip_url_secrets(&url),
                        "error": err.to_string(),
                    });
                    self.logger
                        .warn("security", "blocked invalid external url", Some(&meta));
                }
            },
            NativeCommand::RevealInOs(path) => {
                let roots = self.approved_roots_snapshot();
                if let Err(err) = reveal_in_os(&roots, Path::new(&path)) {
                    let meta = json!({ "error": err.to_string() });
                    self.logger
                        .warn("shell", "failed to reveal path in OS", Some(&meta));
                }
            }
            NativeCommand::OpenInDefaultApp(path) => {
                let roots = self.approved_roots_snapshot();
                match open_in_default_app(&roots, Path::new(&path), false) {
                    Ok(OpenInDefaultAppOutcome::Opened) => {}
                    Ok(OpenInDefaultAppOutcome::ConfirmationRequired {
                        path: safe_path,
                        reason,
                    }) => {
                        let meta = json!({
                            "fileName": safe_path.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                            "reason": reason,
                        });
                        self.logger.warn(
                            "security",
                            "blocked opening launchable file in default app without explicit confirmation",
                            Some(&meta),
                        );
                    }
                    Err(err) => {
                        let meta = json!({ "error": err.to_string() });
                        self.logger.warn(
                            "shell",
                            "failed to open path in default app",
                            Some(&meta),
                        );
                    }
                }
            }
            NativeCommand::TrashPath(path) => {
                let roots = self.approved_roots_snapshot();
                if let Err(err) = trash_workspace_entry(&roots, Path::new(&path)) {
                    let meta = json!({ "error": err.to_string() });
                    self.logger
                        .warn("explorer", "failed to trash workspace entry", Some(&meta));
                }
            }
            NativeCommand::ShowDesktopNotification { title, body } => {
                let id = uuid::Uuid::new_v4().to_string();
                self.notifications.show(&id, &title, &body);
            }
            NativeCommand::ExportDiagnosticsBundle => {
                let diagnostics = self.diagnostics.clone();
                let logger = self.logger.clone();
                let notifications = self.notifications.clone();
                tokio::spawn(async move {
                    let res = tokio::task::spawn_blocking(move || {
                        let created = diagnostics.create_bundle()?;
                        let _ = diagnostics.reveal_bundle(&created.path);
                        Ok::<_, anyhow::Error>(created)
                    })
                    .await;
                    match res {
                        Ok(Ok(bundle)) => {
                            let msg = format!(
                                "Diagnostics saved to {}",
                                bundle
                                    .path
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("diagnostics folder")
                            );
                            notifications.show(
                                "diagnostics-bundle",
                                "Diagnostics Bundle Created",
                                &msg,
                            );
                        }
                        Ok(Err(err)) => {
                            let meta = json!({ "error": err.to_string() });
                            logger.error(
                                "diagnostics",
                                "failed to export diagnostics bundle",
                                Some(&meta),
                            );
                        }
                        Err(err) => {
                            let meta = json!({ "error": err.to_string() });
                            logger.error(
                                "diagnostics",
                                "diagnostics export task panicked",
                                Some(&meta),
                            );
                        }
                    }
                });
            }
            NativeCommand::CheckForUpdates => {
                self.updater.check_for_updates();
            }
            NativeCommand::DownloadUpdate => {
                self.updater.download_update();
            }
            NativeCommand::QuitAndInstallUpdate => {
                self.updater.quit_and_install();
            }
            NativeCommand::CopyText(text) => {
                if let Some(handle) = current_app_handle() {
                    handle.update(move |_state, tx| {
                        tx.copy(&text);
                    });
                }
            }
            NativeCommand::RefreshTelemetryStatus => {
                (self.emit)(StoreEvent::TelemetryStatusChanged(
                    self.compute_telemetry_status(),
                ));
            }
            NativeCommand::SetRemoteAccessEnabled(enabled) => {
                let remote = self.remote_access.clone();
                let flags = self.server_feature_flags();
                let privacy = self.last_privacy.clone();
                tokio::spawn(async move {
                    remote.set_enabled(enabled, flags, privacy).await;
                });
            }
            NativeCommand::RotateRemoteAccessSession => {
                let remote = self.remote_access.clone();
                let flags = self.server_feature_flags();
                let privacy = self.last_privacy.clone();
                tokio::spawn(async move {
                    remote.rotate_session(flags, privacy).await;
                });
            }
            NativeCommand::UpdateTrustedPhonePermissions {
                phone_id,
                permissions,
            } => {
                let remote = self.remote_access.clone();
                tokio::spawn(async move {
                    remote
                        .update_trusted_phone_permissions(&phone_id, &permissions)
                        .await;
                });
            }
            NativeCommand::ForgetTrustedPhone(phone_id) => {
                let remote = self.remote_access.clone();
                tokio::spawn(async move {
                    remote.forget_trusted_phone(&phone_id).await;
                });
            }
            NativeCommand::RevokeAllTrustedPhones
            | NativeCommand::OpenLogsFolder
            | NativeCommand::RevealDiagnosticsBundle(_)
            | NativeCommand::UploadDiagnosticsBundle { .. } => {}
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
            let options = dialogs::build_open_folder_dialog(None);
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

    fn dispatch_pick_files(&self, request_id: String, allow_multiple: bool) {
        let Some(handle) = current_app_handle() else {
            (self.emit)(StoreEvent::FilesPicked {
                request_id,
                paths: Vec::new(),
            });
            return;
        };
        let uploads = self.uploads.clone();
        let logger = self.logger.clone();
        let req_id = request_id.clone();

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if allow_multiple {
            let emit = self.emit.clone();
            let tokio_rt = tokio::runtime::Handle::try_current().ok();
            handle.update(move |_state, _tx| {
                // `rfd::backend::macos::ModalFuture` calls `MainThreadMarker::new_unchecked()`
                // inside `pick_files()`, so the dialog future must be constructed on Rune's UI
                // main thread and awaited asynchronously once the OS sheet completes.
                let pick_fut = rfd::AsyncFileDialog::new()
                    .set_title("Select Files")
                    .pick_files();
                let finish = async move {
                    let candidates = pick_fut
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .map(|fh| fh.path().to_path_buf())
                        .collect();
                    let paths = authorize_picked_files(candidates, &uploads, &logger);
                    (emit)(StoreEvent::FilesPicked {
                        request_id: req_id,
                        paths,
                    });
                };
                if let Some(rt) = tokio_rt {
                    rt.spawn(finish);
                } else {
                    std::thread::spawn(move || {
                        if let Ok(rt) = tokio::runtime::Builder::new_current_thread().build() {
                            rt.block_on(finish);
                        }
                    });
                }
            });
            return;
        }

        handle.update(move |_state, tx| {
            let uploads_inner = uploads.clone();
            let logger_inner = logger.clone();
            let id_inner = req_id.clone();
            let options = dialogs::build_open_files_dialog(None, allow_multiple);
            tx.open_file(options, move |state: &mut AppState, result, _tx| {
                let candidates = result.ok().flatten().into_iter().collect();
                let paths = authorize_picked_files(candidates, &uploads_inner, &logger_inner);
                state.apply_store_event(StoreEvent::FilesPicked {
                    request_id: id_inner,
                    paths,
                });
            });
        });
    }
}

fn authorize_picked_files(
    candidates: Vec<PathBuf>,
    uploads: &Arc<Mutex<AuthorizedUploadRegistry>>,
    logger: &Arc<LocalLogger>,
) -> Vec<PathBuf> {
    let mut reg = uploads.lock().unwrap_or_else(|e| e.into_inner());
    let mut authorized = Vec::with_capacity(candidates.len());
    for path in candidates {
        // Native Rune feeds picked paths directly into in-process `ingest_composer_paths`
        // (no IPC upload boundary), so `authorize_file` enforces regular-file, non-symlink,
        // and 100 MiB validation before forwarding each selected path.
        match reg.authorize_file(&path) {
            Ok(_token) => authorized.push(path),
            Err(err) => {
                let meta = json!({ "error": err.to_string() });
                logger.warn(
                    "security",
                    "picked upload source failed file authorization",
                    Some(&meta),
                );
            }
        }
    }
    authorized
}

fn make_emitter(
    event_tx: mpsc::UnboundedSender<StoreEvent>,
    waker: Option<rune::Waker>,
) -> Arc<dyn Fn(StoreEvent) + Send + Sync> {
    Arc::new(move |event| {
        let _ = event_tx.send(event);
        if let Some(ref w) = waker {
            (w)();
        }
    })
}

fn is_packaged_build() -> bool {
    if let Ok(raw) = std::env::var("COWORK_IS_PACKAGED") {
        let trimmed = raw.trim().to_ascii_lowercase();
        if matches!(trimmed.as_str(), "1" | "true" | "yes" | "on") {
            return true;
        }
        if matches!(trimmed.as_str(), "0" | "false" | "no" | "off") {
            return false;
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(exe) = std::env::current_exe()
        && exe.to_string_lossy().contains(".app/Contents/MacOS/")
    {
        return true;
    }
    false
}

/// Resolves an explorer/preview request path (`"."`, `""`, relative, or absolute) against `authorized_root`.
fn resolve_workspace_scoped_path(authorized_root: &Path, raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." {
        return authorized_root.to_path_buf();
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        authorized_root.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_workspace_scoped_paths_with_dot_and_relative_anchoring() {
        let root = Path::new("/tmp/cowork/proj-a");
        assert_eq!(resolve_workspace_scoped_path(root, "."), root);
        assert_eq!(resolve_workspace_scoped_path(root, ""), root);
        assert_eq!(
            resolve_workspace_scoped_path(root, "src/lib.rs"),
            root.join("src/lib.rs")
        );
        assert_eq!(
            resolve_workspace_scoped_path(root, "/tmp/cowork/proj-a/README.md"),
            Path::new("/tmp/cowork/proj-a/README.md")
        );
    }
}
