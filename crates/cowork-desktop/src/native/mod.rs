//! Native platform integration module (owned by `native`).
//!
//! Replaces `apps/desktop/electron/`: `cowork-server` child process manager, desktop JSON
//! persistence, window state, menus/tray/shortcuts, native file/folder dialogs, path-bounded
//! workspace file explorer & preview backend, notifications, diagnostics, and updater stubs.

pub mod appearance;
pub mod apply_desktop_state;
pub mod cloud_sync;
pub mod crash_reporting;
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
pub mod product_analytics;
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

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use rune::{App, AppHandle};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::actions::{NativeCommand, StoreEvent, TranscriptLogEntry};
use crate::state::{
    AppState, DiagnosticsBundleState, NotificationTone, PersistedDesktopState,
    PrivacyTelemetrySettings,
};
use appearance::{AppearancePreferences, detect_system_dark};
use apply_desktop_state::apply_desktop_state;
use cloud_sync::CloudSyncService;
use crash_reporting::CrashReportingService;
use diagnostics::{CreatedDiagnosticsBundle, DiagnosticsService, UploadedDiagnosticsBundle};
use explorer::{list_workspace_directory, rename_workspace_entry};
use file_entry_rename::FileEntryRenamer;
use file_preview_read::{DEFAULT_PREVIEW_MAX_BYTES, load_file_preview_state};
use local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger, strip_url_secrets};
use notifications::DesktopNotificationService;
use persistence::{
    PersistenceService, TranscriptDirection, TranscriptEvent, TranscriptWriteBuffer,
    read_user_data_override_env, resolve_legacy_user_data_dir, resolve_user_data_dir,
};
use product_analytics::{ProductAnalyticsService, read_persisted_product_analytics_state};
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
use telemetry_status::resolve_desktop_telemetry_status_with_runtime;
use tray::QuickChatTrayController;
use updater::{DesktopUpdaterService, UpdaterConfig};
use watcher::{WatchChangeKind, WorkspaceDirectoryWatcher};
use window_lifecycle::{
    WindowCloseCoordinator, complete_window_close_resolution, execute_app_quit_hook,
    execute_window_close_hook, get_window_handle, register_window_handle,
    reveal_and_activate_main_window,
};
use window_state::{
    WindowStateStore, is_headless_invocation, reconcile_opened_window_placement,
    record_window_placement, startup_window_options,
};

type ShutdownLatch = Arc<(Mutex<bool>, Condvar)>;

const QUIT_SHUTDOWN_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const QUIT_UPDATE_INSTALL_WAIT_TIMEOUT: Duration = Duration::from_secs(90);
const SHUTDOWN_TELEMETRY_FLUSH_TIMEOUT: Duration = Duration::from_millis(600);
const BOUNDS_SAMPLE_THROTTLE: Duration = Duration::from_millis(250);

static PENDING_UPDATE_INSTALL_QUIT: AtomicBool = AtomicBool::new(false);

static APP_HANDLE: OnceLock<Mutex<Option<AppHandle<AppState>>>> = OnceLock::new();
static APP_HANDLE_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();
static WORKER_CMD_TX: OnceLock<Mutex<Option<mpsc::UnboundedSender<NativeCommand>>>> =
    OnceLock::new();
static SHUTDOWN_LATCH: OnceLock<Mutex<Option<ShutdownLatch>>> = OnceLock::new();
static WINDOW_STATE_STORE: OnceLock<WindowStateStore> = OnceLock::new();
static WINDOW_CLOSE_COORDINATOR: OnceLock<WindowCloseCoordinator> = OnceLock::new();
static LAST_BOUNDS_SAMPLE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static SHARED_ANALYTICS: OnceLock<Mutex<Option<ProductAnalyticsService>>> = OnceLock::new();

fn shared_analytics_slot() -> &'static Mutex<Option<ProductAnalyticsService>> {
    SHARED_ANALYTICS.get_or_init(|| Mutex::new(None))
}

fn set_shared_analytics(service: Option<ProductAnalyticsService>) {
    let mut guard = shared_analytics_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = service;
}

pub(crate) fn record_quick_chat_opened(icon_enabled: bool, shortcut_enabled: bool) {
    let svc = shared_analytics_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(analytics) = svc {
        let mut props = BTreeMap::new();
        props.insert("quickChatIconEnabled".into(), json!(icon_enabled));
        props.insert("quickChatShortcutEnabled".into(), json!(shortcut_enabled));
        analytics.capture_event("quick_chat_opened", &props);
    }
}

fn resolve_desktop_user_data_dir(is_packaged: bool, env: &HashMap<String, String>) -> PathBuf {
    resolve_user_data_dir(is_packaged, env).unwrap_or_else(|err| {
        eprintln!("[native] falling back from userData resolution error: {err}");
        cowork_config::resolve_home_dir(env, cowork_config::host_platform())
            .join(".cowork")
            .join("desktop")
    })
}

fn shared_window_state_store() -> &'static WindowStateStore {
    WINDOW_STATE_STORE.get_or_init(|| {
        let env = cowork_config::env_map_from_process();
        let user_data_dir = resolve_desktop_user_data_dir(is_packaged_build(), &env);
        WindowStateStore::new(&user_data_dir)
    })
}

fn shared_close_coordinator() -> &'static WindowCloseCoordinator {
    WINDOW_CLOSE_COORDINATOR.get_or_init(WindowCloseCoordinator::new)
}

#[cfg(test)]
pub(crate) fn shared_close_coordinator_for_tests() -> &'static WindowCloseCoordinator {
    shared_close_coordinator()
}

fn sample_open_window_placements() {
    if is_headless_invocation() {
        return;
    }
    let throttle = LAST_BOUNDS_SAMPLE.get_or_init(|| Mutex::new(None));
    let now = Instant::now();
    {
        let mut guard = throttle.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = *guard
            && now.duration_since(prev) < BOUNDS_SAMPLE_THROTTLE
        {
            return;
        }
        *guard = Some(now);
    }
    if let Some(handle) = get_window_handle("main") {
        record_window_placement(shared_window_state_store(), &handle);
    }
}

fn flush_window_bounds_for(window_key: &str) {
    if is_headless_invocation() || window_key != "main" {
        return;
    }
    let store = shared_window_state_store();
    if let Some(handle) = get_window_handle("main") {
        record_window_placement(store, &handle);
    }
    let _ = store.flush();
}

fn app_handle_slot() -> &'static Mutex<Option<AppHandle<AppState>>> {
    APP_HANDLE.get_or_init(|| Mutex::new(None))
}

fn app_handle_notify() -> &'static tokio::sync::Notify {
    APP_HANDLE_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

fn store_app_handle(handle: AppHandle<AppState>) {
    let mut guard = app_handle_slot().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(handle);
    drop(guard);
    app_handle_notify().notify_one();
}

fn current_app_handle() -> Option<AppHandle<AppState>> {
    app_handle_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn resolve_shutdown_wait_timeout(pending_update_install: bool) -> Duration {
    if pending_update_install {
        QUIT_UPDATE_INSTALL_WAIT_TIMEOUT
    } else {
        QUIT_SHUTDOWN_WAIT_TIMEOUT
    }
}

fn request_app_quit_for_update() {
    PENDING_UPDATE_INSTALL_QUIT.store(true, Ordering::Release);
    if let Some(app_handle) = current_app_handle() {
        app_handle.quit();
    }
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

/// Registers an opened window handle for bounds restoration/persistence on Rune's UI thread.
pub fn on_window_opened(window_key: &str, handle: &rune::WindowHandle) {
    if is_headless_invocation() {
        return;
    }
    register_window_handle(window_key, handle.clone());
    if window_key == "main" {
        reconcile_opened_window_placement(shared_window_state_store(), handle);
    }
}

/// Evaluates per-window close guards on Rune's UI thread, reopening & confirming when dirty/busy.
pub fn on_window_close(window_key: &str, state: &mut AppState, tx: &mut rune::Tx) {
    let key = window_key.to_string();
    execute_window_close_hook(
        shared_close_coordinator(),
        window_key,
        state,
        tx,
        current_app_handle().as_ref(),
        move || flush_window_bounds_for(&key),
    );
}

/// Evaluates explicit quit requests against unsaved/busy work before entering Rune's quit path.
pub fn request_app_quit(state: &mut AppState, tx: &mut rune::Tx) {
    execute_app_quit_hook(
        shared_close_coordinator(),
        state,
        tx,
        current_app_handle().as_ref(),
        || flush_window_bounds_for("main"),
    );
}

/// Completes a pending close confirmation dialog after user confirmation or cancellation.
pub fn resolve_window_close_dialog(window_key: &str, request_id: &str, confirmed: bool) {
    let Some(handle) = current_app_handle() else {
        return;
    };
    let key = window_key.to_string();
    let req_id = request_id.to_string();
    handle.update(move |_state, tx| {
        let key_for_flush = key.clone();
        complete_window_close_resolution(
            shared_close_coordinator(),
            &key,
            &req_id,
            confirmed,
            tx,
            move || flush_window_bounds_for(&key_for_flush),
        );
    });
}

/// Whether the main window was created transparent so its sidebar can show the native
/// vibrancy material (macOS only; decided once at launch).
static MAIN_WINDOW_VIBRANCY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// True when the main window is transparent and backs the sidebar with a system material.
pub fn main_window_uses_vibrancy() -> bool {
    MAIN_WINDOW_VIBRANCY.get().copied().unwrap_or(false)
}

/// Configures OS-level menus, window bounds restore, close guards, deep links, and quit hooks.
pub fn configure_app(app: App<AppState>) -> App<AppState> {
    let handle = app.handle();
    store_app_handle(handle);

    let headless = is_headless_invocation();
    let (mut startup_opts, startup_max) =
        startup_window_options(shared_window_state_store(), headless);
    let vibrancy = !headless
        && window_chrome::recommended_rune_system_material(
            appearance::detect_reduced_transparency(),
        )
        .is_some();
    let _ = MAIN_WINDOW_VIBRANCY.set(vibrancy);
    startup_opts.transparent = vibrancy;

    let mut configured = menu::install_application_menus(app).keep_running();
    if !headless {
        configured = configured
            .window_options(startup_opts)
            .maximized(startup_max);
    }

    configured
        .on_window(|window_handle| {
            on_window_opened("main", window_handle);
        })
        .on_frame_drawn(|_rt| {
            sample_open_window_placements();
        })
        .on_reopen(|_state, has_visible_windows, _tx| {
            if !has_visible_windows && let Some(app_handle) = current_app_handle() {
                reveal_and_activate_main_window(&app_handle);
                return true;
            }
            false
        })
        .on_open_url(|state, url, _tx| {
            state.apply_store_event(StoreEvent::DeepLink(url.to_string()));
        })
        .on_close(|state, tx| {
            on_window_close("main", state, tx);
        })
        .on_quit(|state, _tx| {
            flush_window_bounds_for("main");
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
                emit(StoreEvent::UpdaterChanged(runtime_ctx.updater.get_state()));
                runtime_ctx.updater.start();

                let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
                runtime_ctx.window_state.spawn_debounce_loop(shutdown_rx);

                let coordinator = ShutdownCoordinator::new(
                    runtime_ctx.server_manager.clone(),
                    Some(runtime_ctx.window_state.clone()),
                    Some(runtime_ctx.logger.clone()),
                    Some(shutdown_tx),
                );

                let handle_notify = app_handle_notify();
                let mut handle_synced = false;
                loop {
                    if !handle_synced && let Some(app_handle) = current_app_handle() {
                        runtime_ctx
                            .tray
                            .sync_with_handle_if_needed(Some(&app_handle));
                        handle_synced = true;
                    }
                    tokio::select! {
                        biased;
                        maybe_cmd = cmd_rx.recv() => {
                            match maybe_cmd {
                                Some(NativeCommand::Shutdown) | None => break,
                                Some(other) => {
                                    runtime_ctx.handle_command(other).await;
                                }
                            }
                        }
                        _ = handle_notify.notified(), if !handle_synced => {}
                    }
                }

                run_native_shutdown(&runtime_ctx, &coordinator).await;
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
async fn run_native_shutdown(runtime_ctx: &NativeWorkerContext, coordinator: &ShutdownCoordinator) {
    set_shared_analytics(None);
    runtime_ctx.remote_access.stop_polling();
    runtime_ctx.updater.dispose();
    let _ = runtime_ctx.transcript_buffer.flush();
    runtime_ctx.tray.teardown_for_shutdown();
    tokio::join!(
        runtime_ctx.watcher.unwatch_all(),
        async {
            let _ = tokio::time::timeout(
                SHUTDOWN_TELEMETRY_FLUSH_TIMEOUT,
                runtime_ctx.crash_reporting.flush(),
            )
            .await;
            runtime_ctx.crash_reporting.shutdown();
        },
        async {
            let _ = tokio::time::timeout(
                SHUTDOWN_TELEMETRY_FLUSH_TIMEOUT,
                runtime_ctx.product_analytics.flush(),
            )
            .await;
            runtime_ctx.product_analytics.shutdown();
        },
        async {
            let _ = tokio::time::timeout(
                SHUTDOWN_TELEMETRY_FLUSH_TIMEOUT,
                runtime_ctx.cloud_sync.flush(),
            )
            .await;
            runtime_ctx.cloud_sync.shutdown();
        },
        coordinator.shutdown(),
    );
    if let Err(err) = runtime_ctx.updater.execute_pending_install_on_shutdown() {
        let meta = json!({ "error": err.to_string() });
        runtime_ctx.logger.error(
            "updater",
            "failed to install staged update on shutdown",
            Some(&meta),
        );
        runtime_ctx.logger.flush_all();
        eprintln!("cowork-desktop failed to install staged update on shutdown: {err}");
    }
}

pub fn on_shutdown(state: &mut AppState) {
    #[cfg(target_os = "macos")]
    tray::destroy_macos_tray_on_main_thread();
    if !state.scene_mode && state.window_mode == crate::state::WindowMode::Main {
        state.persist_state_for_shutdown();
    }
    state.send_native(NativeCommand::Shutdown);
    state.send_ws(crate::ws::WsCommand::Shutdown);
    let wait_timeout =
        resolve_shutdown_wait_timeout(PENDING_UPDATE_INSTALL_QUIT.swap(false, Ordering::AcqRel));
    if let Some(tx) = take_worker_cmd_tx() {
        let sent = tx.send(NativeCommand::Shutdown).is_ok();
        if sent && let Some(latch) = current_shutdown_latch() {
            let _ = ShutdownCoordinator::wait_until_done(&latch, wait_timeout);
        }
    }
}

struct NativeWorkerContext {
    is_packaged: bool,
    logger: Arc<LocalLogger>,
    persistence: Arc<PersistenceService>,
    transcript_buffer: TranscriptWriteBuffer,
    window_state: WindowStateStore,
    appearance: AppearancePreferences,
    roots: Arc<Mutex<WorkspaceRootsController>>,
    uploads: Arc<Mutex<AuthorizedUploadRegistry>>,
    renamer: FileEntryRenamer,
    server_manager: ServerManager,
    remote_access: RemoteAccessBridge,
    watcher: WorkspaceDirectoryWatcher,
    notifications: DesktopNotificationService,
    updater: DesktopUpdaterService,
    diagnostics: DiagnosticsService,
    crash_reporting: CrashReportingService,
    product_analytics: ProductAnalyticsService,
    cloud_sync: CloudSyncService,
    tray: QuickChatTrayController,
    last_feature_flags: HashMap<String, bool>,
    last_privacy: Option<PrivacyTelemetrySettings>,
    show_hidden_files: Arc<AtomicBool>,
    last_diagnostics_bundle: Arc<Mutex<Option<DiagnosticsBundleState>>>,
    emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
}

impl NativeWorkerContext {
    fn initialize(emit: Arc<dyn Fn(StoreEvent) + Send + Sync>) -> Self {
        let env = cowork_config::env_map_from_process();
        Self::initialize_with_env(emit, is_packaged_build(), &env, true)
    }

    fn initialize_with_env(
        emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
        is_packaged: bool,
        env: &HashMap<String, String>,
        register_globals: bool,
    ) -> Self {
        let has_override = read_user_data_override_env(env).is_some();
        let user_data_dir = resolve_desktop_user_data_dir(is_packaged, env);
        let legacy_dir = resolve_legacy_user_data_dir(env);

        let logger = Arc::new(LocalLogger::new(&user_data_dir));
        let persistence = Arc::new(PersistenceService::new(
            user_data_dir.clone(),
            Some(legacy_dir),
            has_override,
            Some(logger.clone()),
        ));
        let window_state = if register_globals {
            shared_window_state_store().clone()
        } else {
            WindowStateStore::new(&user_data_dir)
        };
        let appearance = AppearancePreferences::new(&user_data_dir);
        let roots = Arc::new(Mutex::new(WorkspaceRootsController::new()));
        let uploads = Arc::new(Mutex::new(AuthorizedUploadRegistry::new()));

        let initial_doc = persistence.load_state_value().ok();
        let initial_privacy = initial_doc
            .as_ref()
            .map(persistence::core_state_from_document)
            .map(|c| c.settings.privacy_telemetry)
            .unwrap_or_default();
        let initial_roots = initial_doc
            .as_ref()
            .map(|doc| {
                let mut guard = roots.lock().unwrap_or_else(|e| e.into_inner());
                PersistenceService::sync_workspace_roots(doc, &mut guard);
                guard.approved_roots()
            })
            .unwrap_or_default();
        let initial_analytics = initial_doc
            .as_ref()
            .map(read_persisted_product_analytics_state);

        let crash_reporting =
            CrashReportingService::new(is_packaged, initial_roots, &initial_privacy, env);
        if register_globals {
            crash_reporting.install_panic_hook();
        }

        let product_analytics = ProductAnalyticsService::new(
            is_packaged,
            &initial_privacy,
            initial_analytics,
            Some(persistence.as_ref()),
            env,
        );
        let cloud_sync_persistence = Arc::clone(&persistence);
        let cloud_sync_emit = Arc::clone(&emit);
        let cloud_sync = CloudSyncService::new(
            is_packaged,
            &initial_privacy,
            initial_doc.as_ref(),
            env,
            Some(Arc::new(move |cloud_status| {
                let live_env = cowork_config::env_map_from_process();
                let raw_doc = cloud_sync_persistence.load_state_value().ok();
                let snapshot = raw_doc
                    .as_ref()
                    .map(persistence::core_state_from_document)
                    .unwrap_or_default();
                cloud_sync_emit(StoreEvent::TelemetryStatusChanged(
                    resolve_desktop_telemetry_status_with_runtime(
                        &snapshot,
                        raw_doc.as_ref(),
                        &live_env,
                        is_packaged,
                        Some(cloud_status),
                    ),
                ));
            })),
        );

        let current_exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
        let cwd = std::env::current_dir().ok();
        let repo_root = resolve_dev_repo_root(env, current_exe_dir.as_deref(), cwd.as_deref());
        let resources_dir = resolve_packaged_resources_dir_for(
            cowork_config::host_platform(),
            current_exe_dir.as_deref(),
        );

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
        server_manager.set_product_analytics_state(product_analytics.persisted_state());

        let notifications = DesktopNotificationService::new(Some(logger.clone()));
        let mut updater_cfg = UpdaterConfig::from_build_env(is_packaged);
        updater_cfg.staging_dir = Some(user_data_dir.join("updates-staging"));
        if let Some(appimage) = env
            .get("APPIMAGE")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            updater_cfg.target.appimage_path = Some(PathBuf::from(appimage));
        }
        if register_globals {
            PENDING_UPDATE_INSTALL_QUIT.store(false, Ordering::Release);
            updater_cfg.request_quit = Some(Arc::new(request_app_quit_for_update));
        }
        let updater =
            DesktopUpdaterService::with_config(updater_cfg, Some(logger.clone()), emit.clone())
                .with_notifications(notifications.clone())
                .with_analytics(product_analytics.clone());
        let diag_mgr = server_manager.clone();
        let diag_crash = crash_reporting.clone();
        let diagnostics = DiagnosticsService::new(
            user_data_dir,
            is_packaged,
            persistence.clone(),
            logger.clone(),
            Some(updater.clone()),
            Arc::new(move || diag_mgr.get_diagnostics()),
        )
        .with_recent_report_ids_provider(Arc::new(move || diag_crash.recent_report_ids()));
        let tray = QuickChatTrayController::new(Some(logger.clone())).with_emitter(emit.clone());
        let remote_access = RemoteAccessBridge::new(
            server_manager.clone(),
            Some(logger.clone()),
            emit.clone(),
            false,
        )
        .with_analytics(product_analytics.clone());
        let transcript_buffer =
            TranscriptWriteBuffer::new(persistence.clone(), Some(logger.clone()));
        if register_globals {
            set_shared_analytics(Some(product_analytics.clone()));
        }

        Self {
            is_packaged,
            logger,
            persistence,
            transcript_buffer,
            window_state,
            appearance,
            roots,
            uploads,
            renamer: FileEntryRenamer::new(),
            server_manager,
            remote_access,
            watcher: WorkspaceDirectoryWatcher::new(),
            notifications,
            updater,
            diagnostics,
            crash_reporting,
            product_analytics,
            cloud_sync,
            tray,
            last_feature_flags: HashMap::new(),
            last_privacy: None,
            show_hidden_files: Arc::new(AtomicBool::new(false)),
            last_diagnostics_bundle: Arc::new(Mutex::new(None)),
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
                core.product_analytics = self.product_analytics_value().or(core.product_analytics);
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
                let mut core = PersistedDesktopState {
                    feature_flags: resolve_effective_feature_flags(
                        &HashMap::new(),
                        &env,
                        self.is_packaged,
                    ),
                    ..PersistedDesktopState::default()
                };
                core.settings.theme = self.appearance.load_theme_preference();
                core.product_analytics = self.product_analytics_value();
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
        }
    }

    fn sync_runtime_caches(&mut self, state: &PersistedDesktopState) {
        let env = cowork_config::env_map_from_process();
        self.sync_runtime_caches_with_env(state, &env);
    }

    fn sync_runtime_caches_with_env(
        &mut self,
        state: &PersistedDesktopState,
        env: &HashMap<String, String>,
    ) {
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
        self.sync_telemetry_services_with_env(&state.settings.privacy_telemetry, env);
        let raw_doc = self.persistence.load_state_value().ok();
        let _ = self
            .cloud_sync
            .sync_persisted_state(state, raw_doc.as_ref(), env);
    }

    fn product_analytics_value(&self) -> Option<Value> {
        let state = self.product_analytics.persisted_state();
        if state.anonymous_installation_id.is_none() && state.last_app_version.is_none() {
            return None;
        }
        serde_json::to_value(&state).ok().filter(|v| v.is_object())
    }

    fn sync_telemetry_services_with_env(
        &self,
        privacy: &PrivacyTelemetrySettings,
        env: &HashMap<String, String>,
    ) {
        let approved = self.approved_roots_snapshot();
        self.crash_reporting.reconfigure(privacy, approved, env);
        let before = self.product_analytics.persisted_state();
        self.product_analytics
            .reconfigure(privacy, Some(self.persistence.as_ref()), env);
        let after = self.product_analytics.persisted_state();
        self.server_manager
            .set_product_analytics_state(after.clone());
        if after != before {
            (self.emit)(StoreEvent::ProductAnalyticsStateUpdated(
                self.product_analytics_value(),
            ));
        }
    }

    fn save_persisted_state_with_env(
        &mut self,
        snapshot: &PersistedDesktopState,
        env: &HashMap<String, String>,
    ) -> PersistedDesktopState {
        // Persist user/core state first (keeping the live analytics IDs if the UI snapshot is older),
        // then reconfigure telemetry services so newly generated `anonymousInstallationId` values
        // written by `reconfigure` are never clobbered by the pre-reconfigure snapshot.
        let mut snapshot_to_save = snapshot.clone();
        if let Some(current_analytics) = self.product_analytics_value() {
            snapshot_to_save.product_analytics = Some(current_analytics);
        }
        let mut runtime_snapshot = snapshot.clone();
        match self
            .persistence
            .merge_and_save_core_snapshot(&snapshot_to_save)
        {
            Ok(saved_doc) => {
                let saved_core = persistence::core_state_from_document(&saved_doc);
                runtime_snapshot.workspaces = saved_core.workspaces;
                runtime_snapshot.workspace_order = saved_core.workspace_order;
            }
            Err(err) => {
                let meta = json!({ "error": err.to_string() });
                self.logger.write(
                    LocalLogFileName::Server,
                    LocalLogLevel::Error,
                    "persistence",
                    "failed to persist desktop snapshot",
                    Some(&meta),
                );
            }
        }

        runtime_snapshot.feature_flags =
            resolve_effective_feature_flags(&snapshot.feature_flags, env, self.is_packaged);
        self.sync_runtime_caches_with_env(&runtime_snapshot, env);
        runtime_snapshot
    }

    fn server_feature_flags(&self) -> WorkspaceServerFeatureFlags {
        WorkspaceServerFeatureFlags::from_feature_flag_map(&self.last_feature_flags)
    }

    fn compute_telemetry_status(&self) -> Value {
        let env = cowork_config::env_map_from_process();
        self.compute_telemetry_status_with_env(&env)
    }

    fn compute_telemetry_status_with_env(&self, env: &HashMap<String, String>) -> Value {
        let mut snapshot = PersistedDesktopState::default();
        if let Some(ref privacy) = self.last_privacy {
            snapshot.settings.privacy_telemetry = privacy.clone();
        }
        let raw_doc = self.persistence.load_state_value().ok();
        let cloud_status = self.cloud_sync.status_for_env(
            &snapshot.settings.privacy_telemetry,
            raw_doc.as_ref(),
            env,
        );
        resolve_desktop_telemetry_status_with_runtime(
            &snapshot,
            raw_doc.as_ref(),
            env,
            self.is_packaged,
            Some(&cloud_status),
        )
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
            NativeCommand::LoadImportedWorkspaces(ids) => {
                let result = self.persistence.load_core_state().map(|state| {
                    state
                        .workspaces
                        .into_iter()
                        .filter(|w| ids.contains(&w.id) && !w.archived)
                        .collect::<Vec<_>>()
                });
                match result {
                    Ok(workspaces) => {
                        if workspaces.len() != ids.len() {
                            (self.emit)(StoreEvent::Toast {
                                key: "import-workspaces-missing".into(),
                                title: "Some import destinations are no longer available".into(),
                                description: None,
                                tone: NotificationTone::Warning,
                            });
                        }
                        (self.emit)(StoreEvent::ImportedWorkspacesLoaded(workspaces));
                    }
                    Err(error) => (self.emit)(StoreEvent::Toast {
                        key: "import-workspaces-error".into(),
                        title: "Could not refresh imported workspaces".into(),
                        description: Some(error.to_string()),
                        tone: NotificationTone::Error,
                    }),
                }
            }
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
                let analytics = self.product_analytics.clone();
                let crash = self.crash_reporting.clone();
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
                    let started_at = Instant::now();
                    match mgr.start_workspace_server(opts).await {
                        Ok(started) => {
                            let mut props = BTreeMap::new();
                            props.insert(
                                "durationMs".to_string(),
                                json!(started_at.elapsed().as_millis() as u64),
                            );
                            let _ = analytics.capture_event("workspace_server_started", &props);
                            crash.add_breadcrumb(
                                "server",
                                "info",
                                "workspace server started",
                                Some(json!({ "workspaceId": started.workspace_id })),
                            );
                            remote.on_server_started(
                                &started.workspace_id,
                                started.mobile_h3.as_ref(),
                            );
                        }
                        Err(err) => {
                            let mut props = BTreeMap::new();
                            props.insert(
                                "durationMs".to_string(),
                                json!(started_at.elapsed().as_millis() as u64),
                            );
                            props.insert("errorCategory".to_string(), json!("startup_failed"));
                            let _ = analytics.capture_event("workspace_server_failed", &props);
                            crash.add_breadcrumb(
                                "server",
                                "error",
                                "workspace server start failed",
                                Some(json!({ "workspaceId": workspace_id })),
                            );
                            let mut tags = BTreeMap::new();
                            tags.insert("workspaceId".to_string(), workspace_id.clone());
                            let _ = crash.capture_exception(
                                "WorkspaceServerStartError",
                                &err,
                                tags,
                                None,
                            );
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
                let runtime_snapshot = self.save_persisted_state_with_env(&snapshot, &env);
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
                    self.compute_telemetry_status_with_env(&env),
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
            NativeCommand::StageComposerUpload {
                key,
                workspace_id,
                workspace_root,
                uploads_directory,
                source_path,
                filename,
                mime_type,
            } => {
                let roots = self.roots.clone();
                let uploads = self.uploads.clone();
                let logger = self.logger.clone();
                let emit = self.emit.clone();
                tokio::spawn(async move {
                    let filename_for_task = filename.clone();
                    let staged = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
                        let (approved_roots, authorized_ws) = {
                            let guard = roots.lock().unwrap_or_else(|e| e.into_inner());
                            let ws = guard
                                .resolve_authorized_workspace_root(
                                    &workspace_id,
                                    Some(Path::new(&workspace_root)),
                                )
                                .map_err(|err| err.to_string())?;
                            (guard.approved_roots(), ws)
                        };
                        let mut reg = uploads.lock().unwrap_or_else(|e| e.into_inner());
                        let token = reg
                            .authorize_file(&source_path)
                            .map_err(|err| err.to_string())?;
                        let uploads_override = uploads_directory
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(PathBuf::from);
                        explorer::copy_authorized_upload_to_workspace(
                            &mut reg,
                            &approved_roots,
                            &authorized_ws,
                            &source_path,
                            &token,
                            &filename_for_task,
                            uploads_override.as_deref(),
                        )
                        .map_err(|err| err.to_string())
                    })
                    .await
                    .unwrap_or_else(|err| Err(format!("Attachment upload worker panicked: {err}")));

                    if let Err(ref err) = staged {
                        let meta = json!({ "error": err });
                        logger.warn(
                            "security",
                            "failed to stage large composer attachment into workspace uploads",
                            Some(&meta),
                        );
                    }
                    let staged_name = staged
                        .as_ref()
                        .ok()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        .map(ToString::to_string)
                        .unwrap_or(filename);
                    emit(StoreEvent::ComposerUploadStaged {
                        key,
                        filename: staged_name,
                        mime_type,
                        result: staged,
                    });
                });
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
                request_id,
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
                                request_id,
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
                        request_id,
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
            NativeCommand::OpenInDefaultApp { path, confirmed } => {
                let roots = self.approved_roots_snapshot();
                handle_open_in_default_app_result(
                    open_in_default_app(&roots, Path::new(&path), confirmed),
                    &self.logger,
                    self.emit.as_ref(),
                );
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
                let emit = self.emit.clone();
                let last_bundle = self.last_diagnostics_bundle.clone();
                tokio::spawn(async move {
                    let res = tokio::task::spawn_blocking(move || {
                        let created = diagnostics.create_bundle()?;
                        let _ = diagnostics.reveal_bundle(&created.path);
                        Ok::<_, anyhow::Error>(created)
                    })
                    .await;
                    match res {
                        Ok(Ok(bundle)) => {
                            let state = build_diagnostics_bundle_state(&bundle);
                            {
                                *last_bundle.lock().unwrap_or_else(|e| e.into_inner()) =
                                    Some(state.clone());
                            }
                            emit(StoreEvent::DiagnosticsBundleUpdated(Some(state)));
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
                            emit(StoreEvent::Toast {
                                key: "diagnostics-bundle-created".to_string(),
                                title: "Diagnostics Bundle Created".to_string(),
                                description: Some(msg),
                                tone: NotificationTone::Success,
                            });
                        }
                        Ok(Err(err)) => {
                            let err_str = err.to_string();
                            let meta = json!({ "error": err_str });
                            logger.error(
                                "diagnostics",
                                "failed to export diagnostics bundle",
                                Some(&meta),
                            );
                            emit(StoreEvent::Toast {
                                key: "diagnostics-bundle-error".to_string(),
                                title: "Failed to Create Diagnostics Bundle".to_string(),
                                description: Some(err_str),
                                tone: NotificationTone::Error,
                            });
                        }
                        Err(err) => {
                            let err_str = err.to_string();
                            let meta = json!({ "error": err_str });
                            logger.error(
                                "diagnostics",
                                "diagnostics export task panicked",
                                Some(&meta),
                            );
                            emit(StoreEvent::Toast {
                                key: "diagnostics-bundle-error".to_string(),
                                title: "Failed to Create Diagnostics Bundle".to_string(),
                                description: Some(err_str),
                                tone: NotificationTone::Error,
                            });
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
            NativeCommand::RefreshRemoteAccessTrustedDevices => {
                let remote = self.remote_access.clone();
                tokio::spawn(async move {
                    remote.refresh_trusted_devices().await;
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
            NativeCommand::RevokeAllTrustedPhones => {
                let remote = self.remote_access.clone();
                tokio::spawn(async move {
                    remote.revoke_all_trusted_phones().await;
                });
            }
            NativeCommand::OpenLogsFolder => {
                let diagnostics = self.diagnostics.clone();
                let logger = self.logger.clone();
                let emit = self.emit.clone();
                tokio::spawn(async move {
                    let res =
                        tokio::task::spawn_blocking(move || diagnostics.open_logs_folder()).await;
                    let err_msg = match res {
                        Ok(Ok(())) => return,
                        Ok(Err(err)) => err.to_string(),
                        Err(err) => err.to_string(),
                    };
                    report_diagnostics_error(
                        &logger,
                        emit.as_ref(),
                        "failed to open logs folder",
                        "open-logs-folder-error",
                        "Unable to Open Logs Folder",
                        err_msg,
                    );
                });
            }
            NativeCommand::RevealDiagnosticsBundle(path) => {
                let Some(target) =
                    resolve_diagnostics_bundle_target(path, &self.last_diagnostics_bundle)
                else {
                    emit_missing_bundle_warning(
                        self.emit.as_ref(),
                        "Create a diagnostics bundle before revealing it.",
                    );
                    return;
                };
                let diagnostics = self.diagnostics.clone();
                let logger = self.logger.clone();
                let emit = self.emit.clone();
                tokio::spawn(async move {
                    let res =
                        tokio::task::spawn_blocking(move || diagnostics.reveal_bundle(&target))
                            .await;
                    let err_msg = match res {
                        Ok(Ok(())) => return,
                        Ok(Err(err)) => err.to_string(),
                        Err(err) => err.to_string(),
                    };
                    report_diagnostics_error(
                        &logger,
                        emit.as_ref(),
                        "failed to reveal diagnostics bundle",
                        "diagnostics-reveal-error",
                        "Unable to Reveal Diagnostics Bundle",
                        err_msg,
                    );
                });
            }
            NativeCommand::UploadDiagnosticsBundle { path, confirmed } => {
                let Some(target) =
                    resolve_diagnostics_bundle_target(path, &self.last_diagnostics_bundle)
                else {
                    emit_missing_bundle_warning(
                        self.emit.as_ref(),
                        "Create a diagnostics bundle before uploading.",
                    );
                    return;
                };
                let diagnostics = self.diagnostics.clone();
                let logger = self.logger.clone();
                let emit = self.emit.clone();
                let last_bundle = self.last_diagnostics_bundle.clone();
                tokio::spawn(async move {
                    match diagnostics.upload_bundle(&target, confirmed).await {
                        Ok(uploaded) => {
                            let updated =
                                merge_uploaded_bundle_state(&target, Ok(&uploaded), &last_bundle);
                            emit(StoreEvent::DiagnosticsBundleUpdated(Some(updated)));
                            let tone = if uploaded.uploaded {
                                NotificationTone::Success
                            } else {
                                NotificationTone::Info
                            };
                            emit(StoreEvent::Toast {
                                key: "diagnostics-upload".to_string(),
                                title: if uploaded.uploaded {
                                    "Diagnostics Bundle Uploaded".to_string()
                                } else {
                                    "Diagnostics Upload Skipped".to_string()
                                },
                                description: Some(uploaded.message),
                                tone,
                            });
                        }
                        Err(err) => {
                            let err_msg = err.to_string();
                            let updated =
                                merge_uploaded_bundle_state(&target, Err(&err_msg), &last_bundle);
                            emit(StoreEvent::DiagnosticsBundleUpdated(Some(updated)));
                            report_diagnostics_error(
                                &logger,
                                emit.as_ref(),
                                "failed to upload diagnostics bundle",
                                "diagnostics-upload-error",
                                "Diagnostics Upload Failed",
                                err_msg,
                            );
                        }
                    }
                });
            }
            NativeCommand::RenameWorkspaceEntry {
                request_id: _,
                workspace_id,
                workspace_root,
                path,
                new_name,
            } => {
                let authorized_root =
                    match self.authorize_explorer_workspace_root(&workspace_id, &workspace_root) {
                        Ok(valid) => valid,
                        Err(err) => {
                            let meta = json!({ "workspaceId": workspace_id, "error": err });
                            self.logger.warn(
                                "explorer",
                                "blocked entry rename for unauthorized workspace",
                                Some(&meta),
                            );
                            (self.emit)(StoreEvent::WorkspaceEntryRenameFailed {
                                workspace_id,
                                path,
                                error: err,
                            });
                            return;
                        }
                    };
                let renamer = self.renamer.clone();
                let show_hidden = self.show_hidden_files.load(Ordering::Acquire);
                let emit = self.emit.clone();
                let logger = self.logger.clone();
                tokio::spawn(async move {
                    execute_rename_workspace_entry(
                        &renamer,
                        authorized_root,
                        workspace_id,
                        path,
                        new_name,
                        show_hidden,
                        logger,
                        emit,
                    )
                    .await;
                });
            }
            NativeCommand::ResolveWindowClose {
                window_id,
                request_id,
                confirmed,
            } => {
                resolve_window_close_dialog(&window_id, &request_id, confirmed);
            }
            NativeCommand::ReadLocalTranscript {
                request_id,
                thread_id,
                candidate_ids,
            } => {
                let persistence = self.persistence.clone();
                let transcript_buffer = self.transcript_buffer.clone();
                let emit = self.emit.clone();
                let tid = thread_id.clone();
                tokio::spawn(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        let _ = transcript_buffer.flush();
                        persistence
                            .read_transcript_with_candidates(&tid, &candidate_ids)
                            .map(|events| {
                                events
                                    .into_iter()
                                    .map(transcript_event_to_log_entry)
                                    .collect()
                            })
                            .map_err(|err| err.to_string())
                    })
                    .await
                    .unwrap_or_else(|err| Err(format!("Transcript reader panicked: {err}")));
                    emit(StoreEvent::LocalTranscriptLoaded {
                        request_id,
                        thread_id,
                        result,
                    });
                });
            }
            NativeCommand::DeleteLocalTranscripts { thread_ids } => {
                self.transcript_buffer.discard_threads(&thread_ids);
                let persistence = self.persistence.clone();
                let logger = self.logger.clone();
                tokio::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        for tid in thread_ids {
                            if let Err(err) = persistence.delete_transcript(&tid) {
                                let meta = json!({ "threadId": tid, "error": err.to_string() });
                                logger.warn(
                                    "persistence",
                                    "failed to delete local transcript",
                                    Some(&meta),
                                );
                            }
                        }
                    })
                    .await;
                });
            }
            NativeCommand::AppendTranscriptEvent(entry) => {
                match transcript_log_entry_to_event(entry) {
                    Ok(ev) => self.transcript_buffer.enqueue(ev),
                    Err(err) => {
                        let meta = json!({ "error": err });
                        self.logger.warn(
                            "persistence",
                            "dropped invalid local transcript entry",
                            Some(&meta),
                        );
                    }
                }
            }
            NativeCommand::TrackAnalyticsEvent { name, properties } => {
                let props = json_properties_to_btree(&properties);
                let _ = self.product_analytics.capture_event(&name, &props);
            }
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

/// Resolves the compile-time desktop app version, preferring `COWORK_APP_VERSION` over the
/// authoritative `packaging/Packager.toml` version (`COWORK_DESKTOP_VERSION`) and `CARGO_PKG_VERSION`.
pub(crate) fn resolve_desktop_app_version() -> &'static str {
    option_env!("COWORK_APP_VERSION")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            option_env!("COWORK_DESKTOP_VERSION")
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}

fn is_cargo_dev_exe_path(exe: &Path) -> bool {
    let Some(parent) = exe.parent() else {
        return false;
    };
    let comps: Vec<String> = parent
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let tail = match comps.last().map(String::as_str) {
        Some("deps" | "examples") if comps.len() >= 2 => &comps[..comps.len() - 1],
        _ => &comps[..],
    };
    let n = tail.len();
    let is_profile_tail = tail
        .last()
        .is_some_and(|s| matches!(s.as_str(), "debug" | "release"));
    if !is_profile_tail {
        return false;
    }
    (n >= 2 && tail[n - 2] == "target") || (n >= 3 && tail[n - 3] == "target")
}

fn has_packaged_resource_markers(dir: &Path) -> bool {
    let has_dist = dir
        .join("dist")
        .join("config")
        .join("defaults.json")
        .is_file();
    if !has_dist {
        return false;
    }
    let binaries_dir = dir.join("binaries");
    if binaries_dir.join("cowork-server-manifest.json").is_file() {
        return true;
    }
    std::fs::read_dir(&binaries_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("cowork-server"))
                && entry.path().is_file()
        })
}

/// Resolves the bundled resources directory (`dist/` + `binaries/`) for a packaged app layout.
pub(crate) fn resolve_packaged_resources_dir_for(
    platform: &str,
    current_exe_dir: Option<&Path>,
) -> Option<PathBuf> {
    let exe_dir = current_exe_dir?;
    match platform {
        "darwin" => {
            if let Some(res) = exe_dir.parent().map(|contents| contents.join("Resources"))
                && res.is_dir()
            {
                return Some(res);
            }
            Some(exe_dir.to_path_buf())
        }
        "win32" => {
            let nested = exe_dir.join("resources");
            if has_packaged_resource_markers(&nested) || nested.is_dir() {
                return Some(nested);
            }
            Some(exe_dir.to_path_buf())
        }
        "linux" => {
            if let Some(lib_dir) = exe_dir
                .parent()
                .map(|prefix| prefix.join("lib").join("cowork-desktop"))
                && lib_dir.is_dir()
            {
                return Some(lib_dir);
            }
            if matches!(exe_dir.to_str(), Some("/usr/bin") | Some("/usr/local/bin")) {
                let sys_lib = PathBuf::from("/usr/lib/cowork-desktop");
                if sys_lib.is_dir() {
                    return Some(sys_lib);
                }
            }
            Some(exe_dir.to_path_buf())
        }
        _ => Some(exe_dir.to_path_buf()),
    }
}

fn detect_packaged_build_with(
    env: &HashMap<String, String>,
    platform: &str,
    current_exe: Option<&Path>,
) -> bool {
    if let Some(raw) = env.get("COWORK_IS_PACKAGED") {
        let trimmed = raw.trim().to_ascii_lowercase();
        if matches!(trimmed.as_str(), "1" | "true" | "yes" | "on") {
            return true;
        }
        if matches!(trimmed.as_str(), "0" | "false" | "no" | "off") {
            return false;
        }
    }
    let Some(exe) = current_exe else {
        return false;
    };
    if platform == "darwin" {
        return exe.to_string_lossy().contains(".app/Contents/MacOS/");
    }
    if is_cargo_dev_exe_path(exe) {
        return false;
    }
    resolve_packaged_resources_dir_for(platform, exe.parent())
        .is_some_and(|dir| has_packaged_resource_markers(&dir))
}

fn is_packaged_build() -> bool {
    let env = cowork_config::env_map_from_process();
    let exe = std::env::current_exe().ok();
    detect_packaged_build_with(&env, cowork_config::host_platform(), exe.as_deref())
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

fn build_diagnostics_bundle_state(created: &CreatedDiagnosticsBundle) -> DiagnosticsBundleState {
    DiagnosticsBundleState {
        path: created.path.to_string_lossy().into_owned(),
        created_at: created.created_at.clone(),
        summary: created.summary.clone(),
        upload_configured: created.upload_configured,
        upload_enabled: created.upload_enabled,
        uploaded: false,
        diagnostic_id: None,
        upload_url: None,
        upload_message: None,
    }
}

fn resolve_diagnostics_bundle_target(
    explicit: Option<String>,
    cached: &Arc<Mutex<Option<DiagnosticsBundleState>>>,
) -> Option<PathBuf> {
    if let Some(raw) = explicit
        && !raw.trim().is_empty()
    {
        return Some(PathBuf::from(raw.trim()));
    }
    let guard = cached.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .map(|b| b.path.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn merge_uploaded_bundle_state(
    target: &Path,
    outcome: Result<&UploadedDiagnosticsBundle, &str>,
    cached: &Arc<Mutex<Option<DiagnosticsBundleState>>>,
) -> DiagnosticsBundleState {
    let mut guard = cached.lock().unwrap_or_else(|e| e.into_inner());
    let target_canonical = canonicalize_sync(target);
    let mut state = match guard.as_ref() {
        Some(existing)
            if Path::new(&existing.path) == target
                || canonicalize_sync(Path::new(&existing.path)) == target_canonical =>
        {
            existing.clone()
        }
        _ => DiagnosticsBundleState {
            path: target.to_string_lossy().into_owned(),
            ..DiagnosticsBundleState::default()
        },
    };
    match outcome {
        Ok(uploaded) => {
            state.path = uploaded.path.to_string_lossy().into_owned();
            state.uploaded = uploaded.uploaded;
            state.diagnostic_id = uploaded.diagnostic_id.clone();
            state.upload_url = uploaded.url.clone();
            state.upload_message = Some(uploaded.message.clone());
        }
        Err(err) => {
            state.uploaded = false;
            state.upload_message = Some(err.to_string());
        }
    }
    *guard = Some(state.clone());
    state
}

fn emit_missing_bundle_warning(emit: &(dyn Fn(StoreEvent) + Send + Sync), detail: &str) {
    emit(StoreEvent::Toast {
        key: "diagnostics-bundle-missing".to_string(),
        title: "No Diagnostics Bundle Available".to_string(),
        description: Some(detail.to_string()),
        tone: NotificationTone::Warning,
    });
}

fn report_diagnostics_error(
    logger: &LocalLogger,
    emit: &(dyn Fn(StoreEvent) + Send + Sync),
    log_msg: &str,
    toast_key: &str,
    toast_title: &str,
    err_str: String,
) {
    let meta = json!({ "error": err_str });
    logger.warn("diagnostics", log_msg, Some(&meta));
    emit(StoreEvent::Toast {
        key: toast_key.to_string(),
        title: toast_title.to_string(),
        description: Some(err_str),
        tone: NotificationTone::Error,
    });
}

fn handle_open_in_default_app_result(
    outcome: anyhow::Result<OpenInDefaultAppOutcome>,
    logger: &LocalLogger,
    emit: &(dyn Fn(StoreEvent) + Send + Sync),
) {
    match outcome {
        Ok(OpenInDefaultAppOutcome::Opened) => {}
        Ok(OpenInDefaultAppOutcome::ConfirmationRequired {
            path: safe_path,
            reason,
        }) => {
            let file_name = safe_path
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("this file")
                .to_string();
            let meta = json!({
                "fileName": file_name,
                "reason": reason,
            });
            logger.warn(
                "security",
                "blocked opening launchable file in default app without explicit confirmation",
                Some(&meta),
            );
            emit(StoreEvent::LaunchableFileConfirmRequired {
                path: safe_path.to_string_lossy().into_owned(),
                file_name,
            });
        }
        Err(err) => {
            let msg = err.to_string();
            let meta = json!({ "error": msg });
            logger.warn("shell", "failed to open path in default app", Some(&meta));
            emit(StoreEvent::Toast {
                key: "open-in-default-app-error".to_string(),
                title: "Could not open file".to_string(),
                description: Some(msg),
                tone: NotificationTone::Error,
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_rename_workspace_entry(
    renamer: &FileEntryRenamer,
    authorized_root: PathBuf,
    workspace_id: String,
    path: String,
    new_name: String,
    show_hidden: bool,
    logger: Arc<LocalLogger>,
    emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
) {
    let roots = vec![authorized_root.clone()];
    let source_path = resolve_workspace_scoped_path(&authorized_root, &path);
    let old_canonical_leaf = source_path
        .parent()
        .map(canonicalize_sync)
        .and_then(|parent| source_path.file_name().map(|name| parent.join(name)))
        .unwrap_or_else(|| source_path.clone());

    match rename_workspace_entry(renamer, &roots, &source_path, &new_name).await {
        Ok(new_safe_path) => {
            emit(StoreEvent::WorkspaceEntryRenamed {
                workspace_id: workspace_id.clone(),
                old_path: old_canonical_leaf.to_string_lossy().into_owned(),
                new_path: new_safe_path.to_string_lossy().into_owned(),
            });
            let parent_dir = new_safe_path
                .parent()
                .unwrap_or(&authorized_root)
                .to_path_buf();
            let dir_str = parent_dir.to_string_lossy().into_owned();
            let list_roots = roots;
            let list_dir = parent_dir;
            let listed = tokio::task::spawn_blocking(move || {
                list_workspace_directory(&list_roots, &list_dir, show_hidden)
            })
            .await;
            match listed {
                Ok(Ok(entries)) => emit(StoreEvent::WorkspaceFilesListed {
                    workspace_id,
                    dir: dir_str,
                    entries,
                }),
                Ok(Err(err)) => {
                    let meta = json!({ "workspaceId": workspace_id, "error": err.to_string() });
                    logger.warn(
                        "explorer",
                        "failed to refresh workspace listing after rename",
                        Some(&meta),
                    );
                }
                Err(err) => {
                    let meta = json!({ "workspaceId": workspace_id, "error": err.to_string() });
                    logger.warn("explorer", "rename refresh task panicked", Some(&meta));
                }
            }
        }
        Err(err) => {
            let msg = err.to_string();
            let meta = json!({ "workspaceId": workspace_id, "error": msg });
            logger.warn("explorer", "failed to rename workspace entry", Some(&meta));
            emit(StoreEvent::WorkspaceEntryRenameFailed {
                workspace_id,
                path,
                error: msg,
            });
        }
    }
}

fn transcript_event_to_log_entry(event: TranscriptEvent) -> TranscriptLogEntry {
    TranscriptLogEntry {
        ts: event.ts,
        thread_id: event.thread_id,
        direction: match event.direction {
            TranscriptDirection::Server => "server".to_string(),
            TranscriptDirection::Client => "client".to_string(),
        },
        payload: event.payload,
    }
}

fn transcript_log_entry_to_event(entry: TranscriptLogEntry) -> Result<TranscriptEvent, String> {
    let direction = match entry.direction.trim() {
        "server" => TranscriptDirection::Server,
        "client" => TranscriptDirection::Client,
        other => return Err(format!("Unsupported transcript direction: {other}")),
    };
    Ok(TranscriptEvent {
        ts: entry.ts,
        thread_id: entry.thread_id,
        direction,
        payload: entry.payload,
        extra: Map::new(),
    })
}

fn json_properties_to_btree(value: &Value) -> BTreeMap<String, Value> {
    let Some(obj) = value.as_object() else {
        return BTreeMap::new();
    };
    obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
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

    #[test]
    fn resolves_and_merges_diagnostics_bundle_state_across_export_and_upload() {
        let cached = Arc::new(Mutex::new(None));
        assert_eq!(resolve_diagnostics_bundle_target(None, &cached), None);
        assert_eq!(
            resolve_diagnostics_bundle_target(Some("  ".to_string()), &cached),
            None
        );

        let created = CreatedDiagnosticsBundle {
            path: PathBuf::from("/tmp/diagnostics/cowork-diagnostics-1.json"),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            summary: "Cowork diagnostics".to_string(),
            upload_configured: true,
            upload_enabled: true,
        };
        let initial = build_diagnostics_bundle_state(&created);
        *cached.lock().unwrap() = Some(initial);
        assert_eq!(
            resolve_diagnostics_bundle_target(None, &cached),
            Some(created.path.clone())
        );

        let uploaded = UploadedDiagnosticsBundle {
            uploaded: true,
            path: created.path.clone(),
            diagnostic_id: Some("diag-42".to_string()),
            url: Some("https://support.example/diag-42".to_string()),
            message: "Uploaded".to_string(),
        };
        let after_ok = merge_uploaded_bundle_state(&created.path, Ok(&uploaded), &cached);
        assert!(after_ok.uploaded);
        assert_eq!(after_ok.summary, "Cowork diagnostics");
        assert_eq!(after_ok.diagnostic_id.as_deref(), Some("diag-42"));
        assert_eq!(
            after_ok.upload_url.as_deref(),
            Some("https://support.example/diag-42")
        );

        let after_err = merge_uploaded_bundle_state(&created.path, Err("HTTP 502"), &cached);
        assert!(!after_err.uploaded);
        assert_eq!(after_err.upload_message.as_deref(), Some("HTTP 502"));
        assert_eq!(after_err.created_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn launchable_open_outcome_emits_confirmation_and_error_toast() {
        let tmp = tempfile::tempdir().unwrap();
        let logger = LocalLogger::new(tmp.path());
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let emit = move |ev: StoreEvent| {
            captured.lock().unwrap().push(ev);
        };

        let script = tmp.path().join("deploy.command");
        handle_open_in_default_app_result(
            Ok(OpenInDefaultAppOutcome::ConfirmationRequired {
                path: script.clone(),
                reason: "Executable shell command".to_string(),
            }),
            &logger,
            &emit,
        );
        handle_open_in_default_app_result(
            Err(anyhow::anyhow!("Path outside allowed workspace roots")),
            &logger,
            &emit,
        );

        let recorded = events.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert!(matches!(
            &recorded[0],
            StoreEvent::LaunchableFileConfirmRequired { path, file_name }
                if path == &script.to_string_lossy() && file_name == "deploy.command"
        ));
        assert!(matches!(
            &recorded[1],
            StoreEvent::Toast { key, tone: NotificationTone::Error, .. }
                if key == "open-in-default-app-error"
        ));
    }

    #[test]
    fn rename_helper_emits_renamed_listing_and_failure_without_clobbering() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        std::fs::create_dir_all(ws.join("src")).unwrap();
        let old_file = ws.join("src").join("before.txt");
        let conflict_file = ws.join("src").join("taken.txt");
        std::fs::write(&old_file, "hello").unwrap();
        std::fs::write(&conflict_file, "existing").unwrap();

        let canon_ws = canonicalize_sync(&ws);
        let logger = Arc::new(LocalLogger::new(tmp.path()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(move |ev| {
            captured.lock().unwrap().push(ev);
        });
        let renamer = FileEntryRenamer::new();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            execute_rename_workspace_entry(
                &renamer,
                canon_ws.clone(),
                "ws-1".to_string(),
                "src/before.txt".to_string(),
                "after.txt".to_string(),
                false,
                logger.clone(),
                emit.clone(),
            )
            .await;

            execute_rename_workspace_entry(
                &renamer,
                canon_ws.clone(),
                "ws-1".to_string(),
                "src/after.txt".to_string(),
                "taken.txt".to_string(),
                false,
                logger,
                emit,
            )
            .await;
        });

        let recorded = events.lock().unwrap();
        assert!(matches!(
            &recorded[0],
            StoreEvent::WorkspaceEntryRenamed { workspace_id, old_path, new_path }
                if workspace_id == "ws-1"
                    && old_path.ends_with("src/before.txt")
                    && new_path.ends_with("src/after.txt")
        ));
        assert!(matches!(
            &recorded[1],
            StoreEvent::WorkspaceFilesListed { workspace_id, entries, .. }
                if workspace_id == "ws-1"
                    && entries.iter().any(|e| e.name == "after.txt")
                    && !entries.iter().any(|e| e.name == "before.txt")
        ));
        assert!(matches!(
            &recorded[2],
            StoreEvent::WorkspaceEntryRenameFailed { workspace_id, path, .. }
                if workspace_id == "ws-1" && path == "src/after.txt"
        ));
    }

    #[test]
    fn transcript_entry_conversion_and_analytics_property_extraction() {
        let ok = transcript_log_entry_to_event(TranscriptLogEntry {
            ts: "2026-01-01T00:00:01.000Z".into(),
            thread_id: "thread-1".into(),
            direction: "client".into(),
            payload: json!({ "text": "hi" }),
        })
        .unwrap();
        let back = transcript_event_to_log_entry(ok);
        assert_eq!(back.direction, "client");
        assert_eq!(back.thread_id, "thread-1");

        assert!(
            transcript_log_entry_to_event(TranscriptLogEntry {
                ts: "2026-01-01T00:00:01.000Z".into(),
                thread_id: "thread-1".into(),
                direction: "bogus".into(),
                payload: json!({}),
            })
            .is_err()
        );

        let btree = json_properties_to_btree(&json!({
            "workspaceCount": 2,
            "eventSource": "renderer",
        }));
        assert_eq!(btree.get("workspaceCount"), Some(&json!(2)));
        assert_eq!(btree.get("eventSource"), Some(&json!("renderer")));
        assert!(json_properties_to_btree(&json!("not-an-object")).is_empty());
    }

    #[test]
    fn save_persisted_state_preserves_newly_generated_product_analytics_id() {
        let tmp = tempfile::tempdir().unwrap();
        let user_data_dir = tmp.path().join("Cowork");
        let mut env = HashMap::new();
        env.insert(
            "HOME".to_string(),
            tmp.path().join("home").to_string_lossy().to_string(),
        );
        env.insert(
            "COWORK_USER_DATA_DIR".to_string(),
            user_data_dir.to_string_lossy().to_string(),
        );

        let persistence = PersistenceService::new(user_data_dir, None, true, None);
        let stale_analytics = json!({ "lastAppVersion": "0.9.0" });
        persistence
            .merge_and_save_core_snapshot(&PersistedDesktopState {
                product_analytics: Some(stale_analytics.clone()),
                ..PersistedDesktopState::default()
            })
            .unwrap();

        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let emit: Arc<dyn Fn(StoreEvent) + Send + Sync> = Arc::new(move |ev| {
            captured.lock().unwrap().push(ev);
        });
        let mut ctx = NativeWorkerContext::initialize_with_env(emit, false, &env, false);

        // Saving while opting in triggers `reconfigure` to mint `anonymousInstallationId` on disk;
        // the save path must not overwrite disk state with the pre-reconfigure snapshot.
        let mut opt_in_snapshot = PersistedDesktopState {
            product_analytics: Some(stale_analytics.clone()),
            ..PersistedDesktopState::default()
        };
        opt_in_snapshot
            .settings
            .privacy_telemetry
            .product_analytics_enabled = true;
        ctx.save_persisted_state_with_env(&opt_in_snapshot, &env);

        let disk_after_first = ctx.persistence.load_core_state().unwrap();
        let generated_id = disk_after_first
            .product_analytics
            .as_ref()
            .and_then(|v| v.get("anonymousInstallationId"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .expect("expected generated anonymousInstallationId on disk");
        assert!(generated_id.starts_with("anon_"));

        let recorded = events.lock().unwrap();
        assert!(recorded.iter().any(|ev| matches!(
            ev,
            StoreEvent::ProductAnalyticsStateUpdated(Some(v))
                if v.get("anonymousInstallationId").and_then(Value::as_str)
                    == Some(generated_id.as_str())
        )));
        drop(recorded);

        // Even if a subsequent save arrives carrying the older snapshot before UI applies the
        // `ProductAnalyticsStateUpdated` event, the generated installation ID stays preserved.
        ctx.save_persisted_state_with_env(&opt_in_snapshot, &env);
        let disk_after_second = ctx.persistence.load_core_state().unwrap();
        assert_eq!(
            disk_after_second
                .product_analytics
                .as_ref()
                .and_then(|v| v.get("anonymousInstallationId"))
                .and_then(Value::as_str),
            Some(generated_id.as_str())
        );
    }

    fn seed_packaged_markers(root: &Path) {
        let dist_cfg = root.join("dist").join("config");
        let bin_dir = root.join("binaries");
        std::fs::create_dir_all(&dist_cfg).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(dist_cfg.join("defaults.json"), "{}").unwrap();
        std::fs::write(bin_dir.join("cowork-server-manifest.json"), "{}").unwrap();
    }

    #[test]
    fn packaged_layout_detection_covers_macos_windows_linux_and_excludes_cargo_dev() {
        let tmp = tempfile::tempdir().unwrap();
        let empty_env = HashMap::new();

        // macOS .app/Contents/MacOS -> Contents/Resources
        let mac_exe = tmp
            .path()
            .join("Cowork.app")
            .join("Contents")
            .join("MacOS")
            .join("cowork-desktop");
        let mac_res = tmp
            .path()
            .join("Cowork.app")
            .join("Contents")
            .join("Resources");
        std::fs::create_dir_all(mac_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&mac_res).unwrap();
        assert_eq!(
            resolve_packaged_resources_dir_for("darwin", mac_exe.parent()),
            Some(mac_res)
        );
        assert!(detect_packaged_build_with(
            &empty_env,
            "darwin",
            Some(&mac_exe)
        ));

        // Windows direct exe_dir and nested resources/ layouts
        let win_direct_dir = tmp.path().join("win-direct");
        std::fs::create_dir_all(&win_direct_dir).unwrap();
        seed_packaged_markers(&win_direct_dir);
        let win_direct_exe = win_direct_dir.join("cowork-desktop.exe");
        assert_eq!(
            resolve_packaged_resources_dir_for("win32", win_direct_exe.parent()),
            Some(win_direct_dir.clone())
        );
        assert!(detect_packaged_build_with(
            &empty_env,
            "win32",
            Some(&win_direct_exe)
        ));

        let win_nested_dir = tmp.path().join("win-nested");
        let win_nested_res = win_nested_dir.join("resources");
        seed_packaged_markers(&win_nested_res);
        let win_nested_exe = win_nested_dir.join("cowork-desktop.exe");
        assert_eq!(
            resolve_packaged_resources_dir_for("win32", win_nested_exe.parent()),
            Some(win_nested_res)
        );
        assert!(detect_packaged_build_with(
            &empty_env,
            "win32",
            Some(&win_nested_exe)
        ));

        // Linux FHS (.deb / .AppImage): usr/bin -> usr/lib/cowork-desktop
        let linux_exe = tmp
            .path()
            .join("linux-pkg")
            .join("usr")
            .join("bin")
            .join("cowork-desktop");
        let linux_res = tmp
            .path()
            .join("linux-pkg")
            .join("usr")
            .join("lib")
            .join("cowork-desktop");
        std::fs::create_dir_all(linux_exe.parent().unwrap()).unwrap();
        seed_packaged_markers(&linux_res);
        assert_eq!(
            resolve_packaged_resources_dir_for("linux", linux_exe.parent()),
            Some(linux_res)
        );
        assert!(detect_packaged_build_with(
            &empty_env,
            "linux",
            Some(&linux_exe)
        ));

        // Cargo dev target paths remain unpackaged unless explicitly overridden
        let dev_exe = tmp
            .path()
            .join("repo")
            .join("target")
            .join("debug")
            .join("cowork-desktop");
        std::fs::create_dir_all(dev_exe.parent().unwrap()).unwrap();
        seed_packaged_markers(dev_exe.parent().unwrap());
        assert!(!detect_packaged_build_with(
            &empty_env,
            "linux",
            Some(&dev_exe)
        ));
        assert!(!detect_packaged_build_with(
            &empty_env,
            "win32",
            Some(&dev_exe)
        ));

        let mut forced_env = HashMap::new();
        forced_env.insert("COWORK_IS_PACKAGED".into(), "true".into());
        assert!(detect_packaged_build_with(
            &forced_env,
            "linux",
            Some(&dev_exe)
        ));
        forced_env.insert("COWORK_IS_PACKAGED".into(), "0".into());
        assert!(!detect_packaged_build_with(
            &forced_env,
            "darwin",
            Some(&mac_exe)
        ));
    }

    #[test]
    fn shutdown_wait_timeout_expands_for_pending_update_install() {
        assert_eq!(
            resolve_shutdown_wait_timeout(false),
            Duration::from_secs(15)
        );
        assert_eq!(resolve_shutdown_wait_timeout(true), Duration::from_secs(90));
    }

    #[test]
    fn desktop_app_version_defaults_to_packager_toml_version() {
        let packager_toml = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("packaging")
                .join("Packager.toml"),
        )
        .expect("read packaging/Packager.toml");
        let packager_version = packager_toml
            .lines()
            .find_map(|line| {
                let trimmed = line.trim();
                let (key, value) = trimmed.split_once('=')?;
                (key.trim() == "version").then(|| value.trim().trim_matches('"').trim_matches('\''))
            })
            .expect("Packager.toml declares version");
        assert_eq!(
            option_env!("COWORK_DESKTOP_VERSION"),
            Some(
                option_env!("COWORK_APP_VERSION")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(packager_version)
            )
        );
        if option_env!("COWORK_APP_VERSION")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            assert_eq!(resolve_desktop_app_version(), packager_version);
        }
    }
}
