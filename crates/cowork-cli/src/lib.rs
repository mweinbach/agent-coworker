//! `cowork-cli` — Transport & Entrypoint Layer (`cowork` binary).
//!
//! Module boundaries owned by this crate:
//! - **Interactive terminal REPL (`rustyline`)**: Drives an in-process or loopback `cowork-server`
//!   session over the `cowork-protocol` JSON-RPC-lite contract.
//! - **Slash command router**: Supports `/help`, `/provider`, `/model`, `/reasoning`, `/tools`,
//!   `/skills`, `/mcp`, `/sessions`, `/resume`, `/new`, `/compact`, `/clear`, and `/exit`.
//! - **Streaming terminal UI**: Renders live assistant text, thinking summaries, tool executions,
//!   and interactive approval / `AskUserQuestion` prompts, plus one-shot headless prompt execution.

use std::path::PathBuf;

use clap::Parser;

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

/// Command-line interface for the `cowork` interactive REPL and headless runner.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "cowork", version, about = "Cowork interactive AI coworker CLI")]
pub struct CliArgs {
    /// Workspace directory to open.
    #[arg(long)]
    pub dir: Option<PathBuf>,

    /// Disable interactive approval prompts for local experiments.
    #[arg(long)]
    pub yolo: bool,

    /// Optional one-shot prompt executed non-interactively before exiting.
    pub prompt: Option<String>,
}

/// Entrypoint invoked by `crates/cowork-cli/src/main.rs`.
pub async fn run_cli(args: CliArgs) -> anyhow::Result<()> {
    let _ = &args;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_args_and_slash_commands_match_contract() {
        let args = CliArgs::try_parse_from(["cowork", "--dir", "/private/tmp/proj"]).unwrap();
        assert_eq!(args.dir, Some(PathBuf::from("/private/tmp/proj")));
        assert!(!args.yolo);
        assert!(REPL_SLASH_COMMANDS.contains(&"/help"));
        assert!(REPL_SLASH_COMMANDS.contains(&"/exit"));
        assert_eq!(REPL_SLASH_COMMANDS.len(), 13);
        assert_eq!(cowork_protocol::WEBSOCKET_PROTOCOL_VERSION, "7.48");
    }
}
