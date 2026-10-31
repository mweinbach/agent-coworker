//! `cowork-cli` — Transport & Entrypoint Layer (`cowork` binary).
//!
//! Module boundaries owned by this crate:
//! - **Interactive terminal REPL (`rustyline`)**: Drives an in-process or loopback `cowork-server`
//!   session over the `cowork-protocol` JSON-RPC-lite contract (`cowork.jsonrpc.v1`).
//! - **Slash command router**: Supports `/help`, `/provider`, `/model`, `/reasoning`, `/tools`,
//!   `/skills`, `/mcp`, `/sessions`, `/resume`, `/new`, `/compact`, `/clear`, and `/exit`.
//! - **CLI state store**: Persists per-workspace last active thread IDs in
//!   `~/.cowork/state/cli-state.json` with `0600` private permissions.

pub mod client;
pub mod parser;
pub mod repl;
pub mod state_store;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use cowork_config::{
    MigrateAgentConfigOptions, env_map_from_process, format_agent_config_migration_report,
    migrate_agent_config, resolve_home_dir,
};

pub use client::ReplRpcClient;
pub use parser::{ParsedReplCommand, parse_repl_input};
pub use repl::{
    ReplOptions, run_repl_interactive, run_repl_scripted, run_repl_scripted_with_interrupt,
};
pub use state_store::{
    cli_state_file_path, get_stored_session_for_cwd, repl_history_file_path,
    set_stored_session_for_cwd,
};

/// Canonical interactive REPL slash commands supported by `cowork`.
pub const REPL_SLASH_COMMANDS: [&str; 13] = [
    "/help",
    "/provider",
    "/model",
    "/reasoning",
    "/tools",
    "/skills",
    "/mcp",
    "/sessions",
    "/resume",
    "/new",
    "/compact",
    "/clear",
    "/exit",
];

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum CliSubcommand {
    /// Migrate legacy `.agent` configuration directories into `.cowork`.
    #[command(name = "migrate-agent-config")]
    MigrateAgentConfig,
}

/// Command-line interface for the `cowork` interactive REPL and headless runner.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "cowork", version, about = "Cowork interactive AI coworker CLI")]
pub struct CliArgs {
    /// Workspace directory to open.
    #[arg(short = 'd', long)]
    pub dir: Option<PathBuf>,

    /// Loopback TCP port for the embedded harness server (`0` selects an ephemeral port).
    #[arg(short = 'p', long)]
    pub port: Option<u16>,

    /// Explicit CLI REPL flag (accepted for compatibility with legacy `src/index.ts --cli`).
    #[arg(short = 'c', long)]
    pub cli: bool,

    /// Disable interactive approval prompts for local experiments.
    #[arg(short = 'y', long)]
    pub yolo: bool,

    /// Optional administrative subcommand.
    #[command(subcommand)]
    pub subcommand: Option<CliSubcommand>,

    /// Optional one-shot prompt executed non-interactively before exiting.
    pub prompt: Option<String>,
}

/// Entrypoint invoked by `crates/cowork-cli/src/main.rs`.
pub async fn run_cli(args: CliArgs) -> anyhow::Result<()> {
    let env = env_map_from_process();
    let working_directory = match args.dir {
        Some(dir) => {
            if dir.is_absolute() {
                dir
            } else {
                std::env::current_dir()?.join(dir)
            }
        }
        None => std::env::current_dir()?,
    };

    let meta = std::fs::metadata(&working_directory).map_err(|_| {
        anyhow::anyhow!("--dir is not a directory: {}", working_directory.display())
    })?;
    if !meta.is_dir() {
        anyhow::bail!("--dir is not a directory: {}", working_directory.display());
    }

    if matches!(args.subcommand, Some(CliSubcommand::MigrateAgentConfig)) {
        let homedir = resolve_home_dir(&env, cowork_config::host_platform());
        let report = migrate_agent_config(MigrateAgentConfigOptions {
            cwd: Some(working_directory),
            homedir: Some(homedir),
        })
        .await?;
        println!("{}", format_agent_config_migration_report(&report));
        return Ok(());
    }

    run_repl_interactive(
        ReplOptions {
            working_directory,
            port: args.port.unwrap_or(0),
            yolo: args.yolo,
            homedir: None,
            built_in_dir: None,
            env,
        },
        args.prompt,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_args_and_slash_commands_match_contract() {
        let args =
            CliArgs::try_parse_from(["cowork", "-d", "/private/tmp/proj", "-p", "0", "--cli"])
                .unwrap();
        assert_eq!(args.dir, Some(PathBuf::from("/private/tmp/proj")));
        assert_eq!(args.port, Some(0));
        assert!(args.cli);
        assert!(!args.yolo);
        assert!(REPL_SLASH_COMMANDS.contains(&"/help"));
        assert!(REPL_SLASH_COMMANDS.contains(&"/exit"));
        assert_eq!(REPL_SLASH_COMMANDS.len(), 13);
        assert_eq!(cowork_protocol::WEBSOCKET_PROTOCOL_VERSION, "7.48");
    }
}
