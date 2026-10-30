//! `cowork-server` — Transport & Entrypoint Layer (`cowork-server-<targetTriple>[.exe]`).
//!
//! Module boundaries owned by this crate:
//! - **Axum HTTP & WebSocket transport**: `GET /ws` (`cowork.jsonrpc.v1`), sticky `POST /rpc`,
//!   `GET /cowork/health`, `/cowork/workspaces`, `/cowork/fs/*`, and `/cowork/desktop/*` guarded
//!   by `Origin` and `browserAccessToken` checks.
//! - **Backpressure-aware `SocketSendQueue`**: Bounded `500`-message per-connection outbound queue
//!   evicting only streaming delta notifications under slow-consumer contention.
//! - **Electron sidecar lifecycle**: Parses `--dir`, `--host`, `--port`, `--yolo`, `--json`,
//!   `--mobile-h3`, and `__sandbox-exec`; emits NDJSON `server_listening` (`<100ms` cold start)
//!   and shuts down cleanly within `<10s` on `stdin` EOF when `COWORK_DESKTOP_PARENT_MANAGED=1`.
//! - **Mobile TLS & OpenTunnel**: `--mobile-h3` `rustls` + `rcgen` pairing server and relay.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// Maximum buffered outbound WebSocket frames per client connection before delta eviction.
pub const MAX_OUTBOUND_QUEUE_CAPACITY: usize = 500;

/// Default loopback bind address for `cowork-server`.
pub const DEFAULT_BIND_HOST: &str = "127.0.0.1";

/// Default standalone port for `cowork-server` (`0` selects an ephemeral OS port).
pub const DEFAULT_BIND_PORT: u16 = 7337;

/// Command-line interface for the `cowork-server` sidecar and standalone daemon.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(
    name = "cowork-server",
    version,
    about = "Cowork native Rust harness server"
)]
pub struct ServerCli {
    /// Workspace root directory served by this instance.
    #[arg(long)]
    pub dir: Option<PathBuf>,

    /// Bind host address.
    #[arg(long, default_value = DEFAULT_BIND_HOST)]
    pub host: String,

    /// Bind TCP port (`0` requests an ephemeral OS-assigned port).
    #[arg(long, default_value_t = DEFAULT_BIND_PORT)]
    pub port: u16,

    /// Disable interactive approval prompts while preserving hard sandbox floors.
    #[arg(long)]
    pub yolo: bool,

    /// Emit machine-readable NDJSON startup events (`server_listening`) on stdout.
    #[arg(long)]
    pub json: bool,

    /// Enable the Mobile TLS pairing and RPC/SSE listener.
    #[arg(long = "mobile-h3")]
    pub mobile_h3: bool,

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

/// Entrypoint invoked by `crates/cowork-server/src/main.rs`.
pub async fn run_from_cli(cli: ServerCli) -> anyhow::Result<()> {
    let _ = &cli;
    tracing::debug!(
        host = %cli.host,
        port = cli.port,
        protocol_version = cowork_protocol::WEBSOCKET_PROTOCOL_VERSION,
        "cowork-server scaffold initialized"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sidecar_flags_and_sandbox_exec_subcommand() {
        let cli = ServerCli::try_parse_from([
            "cowork-server",
            "--dir",
            "/private/tmp/workspace",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--json",
            "--mobile-h3",
        ])
        .unwrap();

        assert_eq!(cli.dir, Some(PathBuf::from("/private/tmp/workspace")));
        assert_eq!(cli.host, "127.0.0.1");
        assert_eq!(cli.port, 0);
        assert!(cli.json);
        assert!(cli.mobile_h3);
        assert!(!cli.yolo);
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
