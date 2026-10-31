//! `cowork-server` — Transport & Entrypoint Layer (`cowork-server-<targetTriple>[.exe]`).
//!
//! Module boundaries owned by this crate:
//! - **Axum HTTP & WebSocket transport**: `GET /ws` (`cowork.jsonrpc.v1`), sticky `POST /rpc`,
//!   `GET /cowork/health`, `/cowork/workspaces`, `/cowork/fs/*`, and `/cowork/desktop/*` guarded
//!   by `Origin` and `browserAccessToken` checks.
//! - **Backpressure-aware `SocketSendQueue`**: Bounded `500`-message per-connection outbound queue
//!   evicting only streaming delta notifications under slow-consumer contention.
//! - **Electron sidecar lifecycle**: Parses `--dir`, `--host`, `--port`, `--yolo`, `--json`,
//!   `--mobile-h3*`, and `__sandbox-exec`; emits NDJSON `server_startup_progress` and
//!   `server_listening` (`<100ms` cold start) and shuts down cleanly within `<10s` on `stdin` EOF
//!   when `COWORK_DESKTOP_PARENT_MANAGED=1`.
//! - **Mobile TLS & OpenTunnel**: `--mobile-h3` `rustls` + `rcgen` pairing metadata and admin routes.

pub mod extension_mcp_agent_routes;
pub mod http_desktop;
pub mod http_fs;
pub mod jsonrpc;
pub mod memory_and_fork_routes;
pub mod observability;
pub mod office_backups_imports_routes;
pub mod provider_routes;
pub mod registry;
pub mod security;
pub mod send_queue;
pub mod startup;
pub mod task_routes;
pub mod transport;
pub mod turn_runner;

use std::collections::HashMap;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use cowork_config::{
    canonicalize_sync, ensure_ai_coworker_home, env_map_from_process, get_ai_coworker_paths,
    resolve_home_dir,
};
use cowork_storage::{SessionDb, SessionDbOptions, ThreadJournal};
use dashmap::DashMap;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

pub use registry::{
    DEFAULT_IDLE_EVICTION_SWEEP_INTERVAL, DEFAULT_SESSION_IDLE_TIMEOUT, LiveSession,
    ServerRuntimeState,
};
pub use send_queue::{SendQueueStats, SendSinkOutcome, SocketSendQueue};
pub use startup::{
    MobileH3AdminState, MobileH3ListeningInfo, RuntimeBootstrapProgress, ServerListeningEvent,
    ShutdownCoordinator, StartupProgressEvent, resolve_listening_hints,
};

use http_desktop::{WebDesktopService, resolve_user_data_dir};
use security::is_loopback_host;
use transport::{AppState, build_router};

/// Maximum buffered outbound WebSocket frames per client connection before delta eviction.
pub const MAX_OUTBOUND_QUEUE_CAPACITY: usize = 500;

/// Default loopback bind address for `cowork-server`.
pub const DEFAULT_BIND_HOST: &str = "127.0.0.1";

/// Default standalone port for `cowork-server` (`0` selects an ephemeral OS port).
pub const DEFAULT_BIND_PORT: u16 = 7337;

/// Default bind host for `--mobile-h3`.
pub const DEFAULT_MOBILE_H3_HOST: &str = "0.0.0.0";

/// Default runtime bootstrap version stamp (`^\d{4}-\d{2}-\d{2}$`).
pub const DEFAULT_RUNTIME_BOOTSTRAP_VERSION: &str = "2026-01-01";

/// Command-line interface for the `cowork-server` sidecar and standalone daemon.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(
    name = "cowork-server",
    version,
    about = "Cowork native Rust harness server"
)]
pub struct ServerCli {
    /// Workspace root directory served by this instance.
    #[arg(short = 'd', long)]
    pub dir: Option<PathBuf>,

    /// Bind host address.
    #[arg(short = 'H', long, default_value = DEFAULT_BIND_HOST)]
    pub host: String,

    /// Bind TCP port (`0` requests an ephemeral OS-assigned port).
    #[arg(short = 'p', long, default_value_t = DEFAULT_BIND_PORT)]
    pub port: u16,

    /// Disable interactive approval prompts while preserving hard sandbox floors.
    #[arg(short = 'y', long)]
    pub yolo: bool,

    /// Emit machine-readable NDJSON startup events (`server_listening`) on stdout.
    #[arg(short = 'j', long)]
    pub json: bool,

    /// Enable the Mobile TLS pairing and RPC/SSE listener.
    #[arg(long = "mobile-h3")]
    pub mobile_h3: bool,

    /// Bind host for the Mobile TLS listener.
    #[arg(long = "mobile-h3-host", default_value = DEFAULT_MOBILE_H3_HOST)]
    pub mobile_h3_host: String,

    /// Bind port for the Mobile TLS listener (`0` selects an ephemeral port).
    #[arg(long = "mobile-h3-port", default_value_t = 0)]
    pub mobile_h3_port: u16,

    /// Internal self-exec subcommands.
    #[command(subcommand)]
    pub subcommand: Option<ServerSubcommand>,
}

/// Internal subcommands dispatched by `cowork-server`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum ServerSubcommand {
    /// Internal OS sandbox execution helper (`cowork-server __sandbox-exec`).
    #[command(name = "__sandbox-exec", hide = true)]
    SandboxExec {
        /// Serialized sandbox runner arguments.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

/// Programmatic options for launching an in-process `cowork-server` instance.
#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub working_directory: PathBuf,
    pub host: String,
    pub port: u16,
    pub yolo: bool,
    pub mobile_h3: bool,
    pub mobile_h3_host: String,
    pub mobile_h3_port: u16,
    pub homedir: Option<PathBuf>,
    pub built_in_dir: Option<PathBuf>,
    pub env: HashMap<String, String>,
}

/// Handle to a running `cowork-server` listener and runtime.
pub struct ServerHandle {
    bound_addr: SocketAddr,
    host: String,
    ws_url: String,
    rpc_url: String,
    browser_access_token: Option<String>,
    runtime: Arc<ServerRuntimeState>,
    shutdown: ShutdownCoordinator,
    serve_task: JoinHandle<()>,
    evict_task: JoinHandle<()>,
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.bound_addr.port()
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    pub fn browser_access_token(&self) -> Option<&str> {
        self.browser_access_token.as_deref()
    }

    pub fn runtime(&self) -> &Arc<ServerRuntimeState> {
        &self.runtime
    }

    pub fn evict_idle_sessions(&self, max_idle: Duration) -> usize {
        self.runtime.evict_idle_sessions(max_idle)
    }

    pub fn listening_event(&self) -> ServerListeningEvent {
        let host_hints = resolve_listening_hints(&self.host);
        let mobile_h3 = self
            .runtime
            .mobile_h3
            .as_ref()
            .map(|m| m.info.read().clone());
        ServerListeningEvent {
            event_type: "server_listening",
            url: self.ws_url.clone(),
            ws_url: self.ws_url.clone(),
            rpc_url: self.rpc_url.clone(),
            host: self.host.clone(),
            host_hints,
            port: self.port(),
            cwd: self
                .runtime
                .working_directory
                .to_string_lossy()
                .into_owned(),
            browser_access_token: self.browser_access_token.clone(),
            mobile_h3,
        }
    }

    pub async fn shutdown(self) {
        self.shutdown.trigger();
        self.evict_task.abort();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.serve_task).await;
        self.runtime.shutdown().await;
    }
}

fn locate_builtin_dir(cwd: &Path, env: &HashMap<String, String>) -> PathBuf {
    if let Some(repo_root) = env
        .get("COWORK_REPO_ROOT")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(repo_root);
        if p.join("config/defaults.json").is_file() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        while let Some(dir) = cur {
            if dir.join("config/defaults.json").is_file() {
                return dir.to_path_buf();
            }
            cur = dir.parent();
        }
    }
    let mut cur = Some(cwd);
    while let Some(dir) = cur {
        if dir.join("config/defaults.json").is_file() {
            return dir.to_path_buf();
        }
        cur = dir.parent();
    }
    cwd.to_path_buf()
}

fn format_host_port(host: &str, port: u16) -> String {
    let trimmed = host.trim();
    if trimmed.contains(':') && !trimmed.starts_with('[') {
        format!("[{trimmed}]:{port}")
    } else {
        format!("{trimmed}:{port}")
    }
}

/// Boots an Axum HTTP/WebSocket `cowork-server` listener and background maintenance tasks.
pub async fn start_server(mut opts: ServerOptions) -> anyhow::Result<ServerHandle> {
    opts.env.remove("COWORK_DESKTOP_PARENT_MANAGED");

    let meta = std::fs::metadata(&opts.working_directory).map_err(|_| {
        anyhow::anyhow!(
            "--dir is not a directory: {}",
            opts.working_directory.display()
        )
    })?;
    if !meta.is_dir() {
        anyhow::bail!(
            "--dir is not a directory: {}",
            opts.working_directory.display()
        );
    }
    let working_directory = canonicalize_sync(&opts.working_directory);
    opts.env.insert(
        "AGENT_WORKING_DIR".to_owned(),
        working_directory.to_string_lossy().into_owned(),
    );

    let homedir = opts
        .homedir
        .map(|h| canonicalize_sync(&h))
        .unwrap_or_else(|| {
            canonicalize_sync(&resolve_home_dir(&opts.env, cowork_config::host_platform()))
        });
    let built_in_dir = opts
        .built_in_dir
        .unwrap_or_else(|| locate_builtin_dir(&working_directory, &opts.env));

    let ai_paths = get_ai_coworker_paths(Some(&homedir), &opts.env);
    ensure_ai_coworker_home(&ai_paths)?;

    let session_db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: ai_paths.root_dir.clone(),
            db_path: Some(ai_paths.root_dir.join("sessions.db")),
            sessions_dir: ai_paths.sessions_dir.clone(),
            busy_timeout_ms: None,
        })
        .await?,
    );
    let _ = session_db
        .reconcile_stale_execution_states(Some(&working_directory.to_string_lossy()))
        .await;

    let journal = Arc::new(ThreadJournal::new(session_db.clone()));

    let desktop_service = if opts
        .env
        .get("COWORK_WEB_DESKTOP_SERVICE")
        .map(String::as_str)
        == Some("1")
    {
        let user_data_dir = resolve_user_data_dir(&homedir, &opts.env);
        Some(Arc::new(WebDesktopService::new(
            homedir.clone(),
            user_data_dir,
        )))
    } else {
        None
    };

    let mobile_h3 = if opts.mobile_h3 {
        Some(Arc::new(MobileH3AdminState::generate(
            &opts.mobile_h3_host,
            opts.mobile_h3_port,
        )?))
    } else {
        None
    };

    let network_exposed_listener = !is_loopback_host(&opts.host);
    let browser_access_token = opts
        .env
        .get("COWORK_BROWSER_ACCESS_TOKEN")
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            (desktop_service.is_some() || network_exposed_listener)
                .then(|| format!("{}{}", Uuid::new_v4(), Uuid::new_v4().simple()))
        });

    let max_pending_requests = opts
        .env
        .get("COWORK_JSONRPC_MAX_PENDING_REQUESTS")
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(128);

    let bind_addr = format_host_port(&opts.host, opts.port);
    let listener = TcpListener::bind(&bind_addr).await?;
    let bound_addr = listener.local_addr()?;
    let actual_port = bound_addr.port();

    let connect_host = match opts.host.trim() {
        "0.0.0.0" | "::" => "127.0.0.1",
        other => other,
    };
    let host_port_for_url = format_host_port(connect_host, actual_port);
    let ws_url = format!("ws://{host_port_for_url}/ws");
    let rpc_url = format!("http://{host_port_for_url}/rpc");

    if let Some(svc) = &desktop_service {
        svc.set_primary_ws_url(ws_url.clone());
    }

    let runtime = Arc::new(ServerRuntimeState::new(
        working_directory,
        homedir,
        built_in_dir,
        opts.env,
        opts.yolo,
        session_db,
        journal,
        desktop_service,
        mobile_h3,
        browser_access_token.clone(),
        network_exposed_listener,
        max_pending_requests,
    ));
    runtime.init_task_coordinator().await;
    runtime.start_background_runtime_bootstrap(None);

    let app_state = AppState {
        runtime: runtime.clone(),
        http_clients: Arc::new(DashMap::new()),
    };
    let router = build_router(app_state);

    let shutdown = ShutdownCoordinator::new();
    let serve_shutdown = shutdown.clone();
    let serve_task = tokio::spawn(async move {
        let make_svc = router.into_make_service_with_connect_info::<SocketAddr>();
        let _ = axum::serve(listener, make_svc)
            .with_graceful_shutdown(async move {
                serve_shutdown.cancelled().await;
            })
            .await;
    });

    let evict_runtime = runtime.clone();
    let evict_shutdown = shutdown.clone();
    let evict_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(DEFAULT_IDLE_EVICTION_SWEEP_INTERVAL);
        interval.tick().await;
        loop {
            tokio::select! {
                _ = evict_shutdown.cancelled() => break,
                _ = interval.tick() => {
                    evict_runtime.evict_idle_sessions(DEFAULT_SESSION_IDLE_TIMEOUT);
                }
            }
        }
    });

    Ok(ServerHandle {
        bound_addr,
        host: opts.host,
        ws_url,
        rpc_url,
        browser_access_token,
        runtime,
        shutdown,
        serve_task,
        evict_task,
    })
}

/// Entrypoint invoked by `crates/cowork-server/src/main.rs` with pre-extracted `parent_managed` flag.
pub async fn run_from_cli_with_parent_flag(
    cli: ServerCli,
    parent_managed: bool,
) -> anyhow::Result<()> {
    if let Some(ServerSubcommand::SandboxExec { args }) = cli.subcommand {
        tracing::debug!(argc = args.len(), "__sandbox-exec invoked");
        let code = tokio::task::spawn_blocking(move || cowork_sandbox::run_sandbox_exec_cli(&args))
            .await?;
        if code != 0 {
            anyhow::bail!("__sandbox-exec exited with status {code}");
        }
        return Ok(());
    }

    let mut env = env_map_from_process();
    env.remove("COWORK_DESKTOP_PARENT_MANAGED");

    let shutdown = ShutdownCoordinator::new();
    shutdown.install_process_watchers(parent_managed);

    let working_directory = match cli.dir {
        Some(dir) => {
            if dir.is_absolute() {
                dir
            } else {
                std::env::current_dir()?.join(dir)
            }
        }
        None => std::env::current_dir()?,
    };

    if cli.json && env.get("COWORK_DESKTOP_STARTUP_EVENTS").map(String::as_str) == Some("1") {
        let version = env
            .get("COWORK_RUNTIME_VERSION")
            .cloned()
            .unwrap_or_else(|| DEFAULT_RUNTIME_BOOTSTRAP_VERSION.to_owned());
        let evt = StartupProgressEvent::ready(version);
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", serde_json::to_string(&evt)?)?;
        out.flush()?;
    }

    let handle = start_server(ServerOptions {
        working_directory,
        host: cli.host,
        port: cli.port,
        yolo: cli.yolo,
        mobile_h3: cli.mobile_h3,
        mobile_h3_host: cli.mobile_h3_host,
        mobile_h3_port: cli.mobile_h3_port,
        homedir: None,
        built_in_dir: None,
        env: env.clone(),
    })
    .await?;

    if shutdown.is_triggered() {
        let _ = tokio::time::timeout(Duration::from_secs(9), handle.shutdown()).await;
        return Ok(());
    }

    if cli.json {
        let evt = handle.listening_event();
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", serde_json::to_string(&evt)?)?;
        out.flush()?;
    } else {
        let mut out = std::io::stdout().lock();
        writeln!(
            out,
            "[cowork-server] listening on {} (cwd={})",
            handle.ws_url(),
            handle.runtime().working_directory.display()
        )?;
        writeln!(out, "[cowork-server] loopback RPC: {}", handle.rpc_url())?;
        if let Some(tok) = handle.browser_access_token() {
            writeln!(
                out,
                "[cowork-server] native client: COWORK_BROWSER_TOKEN={tok}"
            )?;
        }
        out.flush()?;
    }

    shutdown.cancelled().await;
    let _ = tokio::time::timeout(Duration::from_secs(9), handle.shutdown()).await;
    Ok(())
}

/// Entrypoint preserving compatibility for direct `run_from_cli(cli)` callers.
pub async fn run_from_cli(cli: ServerCli) -> anyhow::Result<()> {
    let parent_managed = std::env::var("COWORK_DESKTOP_PARENT_MANAGED")
        .ok()
        .as_deref()
        == Some("1");
    run_from_cli_with_parent_flag(cli, parent_managed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sidecar_flags_short_aliases_and_sandbox_exec_subcommand() {
        let cli = ServerCli::try_parse_from([
            "cowork-server",
            "-d",
            "/private/tmp/workspace",
            "-H",
            "127.0.0.1",
            "-p",
            "0",
            "-j",
            "-y",
            "--mobile-h3",
            "--mobile-h3-host",
            "127.0.0.1",
            "--mobile-h3-port",
            "17443",
        ])
        .unwrap();

        assert_eq!(cli.dir, Some(PathBuf::from("/private/tmp/workspace")));
        assert_eq!(cli.host, "127.0.0.1");
        assert_eq!(cli.port, 0);
        assert!(cli.json);
        assert!(cli.yolo);
        assert!(cli.mobile_h3);
        assert_eq!(cli.mobile_h3_host, "127.0.0.1");
        assert_eq!(cli.mobile_h3_port, 17443);
        assert_eq!(MAX_OUTBOUND_QUEUE_CAPACITY, 500);

        let sandbox_cli = ServerCli::try_parse_from([
            "cowork-server",
            "__sandbox-exec",
            "--",
            "bash",
            "-c",
            "echo ok",
        ])
        .unwrap();
        assert!(matches!(
            sandbox_cli.subcommand,
            Some(ServerSubcommand::SandboxExec { .. })
        ));
    }
}
