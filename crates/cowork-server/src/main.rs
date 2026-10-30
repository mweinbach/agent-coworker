use clap::Parser;
use cowork_server::{ServerCli, ServerSubcommand, run_from_cli_with_parent_flag};

fn main() -> anyhow::Result<()> {
    let parent_managed = std::env::var("COWORK_DESKTOP_PARENT_MANAGED")
        .ok()
        .as_deref()
        == Some("1");
    if parent_managed {
        // SAFETY: Called on the main thread before starting the Tokio runtime or spawning threads,
        // ensuring child processes never inherit COWORK_DESKTOP_PARENT_MANAGED.
        unsafe {
            std::env::remove_var("COWORK_DESKTOP_PARENT_MANAGED");
        }
    }

    let cli = ServerCli::parse();
    if let Some(ServerSubcommand::SandboxExec { args }) = cli.subcommand {
        // Execute `__sandbox-exec` on the single-threaded main process before spinning up Tokio
        // worker threads so Linux seccomp-BPF + `execvp` and macOS Seatbelt run with minimal
        // latency and zero background threads.
        let code = cowork_sandbox::run_sandbox_exec_cli(&args);
        std::process::exit(code);
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_from_cli_with_parent_flag(cli, parent_managed))
}
