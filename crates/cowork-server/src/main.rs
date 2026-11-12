use clap::Parser;
use cowork_server::{ServerCli, ServerSubcommand, run_from_cli_with_parent_flag};

fn main() -> anyhow::Result<()> {
    let parent_managed = std::env::var(cowork_sandbox::PARENT_MANAGED_ENV_VAR)
        .ok()
        .as_deref()
        == Some("1");
    if parent_managed {
        // SAFETY: Called on the main thread before starting the Tokio runtime or spawning threads,
        // ensuring child processes never inherit COWORK_DESKTOP_PARENT_MANAGED.
        unsafe {
            std::env::remove_var(cowork_sandbox::PARENT_MANAGED_ENV_VAR);
        }
    }

    let cli = ServerCli::parse();
    match &cli.subcommand {
        Some(ServerSubcommand::SandboxExec { args }) => {
            // Execute `__sandbox-exec` on the single-threaded main process before spinning up Tokio
            // worker threads so Linux seccomp-BPF + `execvp` and macOS Seatbelt run with minimal
            // latency and zero background threads.
            let code = cowork_sandbox::run_sandbox_exec_cli(args);
            std::process::exit(code);
        }
        Some(ServerSubcommand::ExportJsonRpcSchema { manifest }) => {
            use std::io::{self, Write};
            let mut stdout = io::stdout().lock();
            let result: io::Result<()> = if *manifest {
                let value = cowork_protocol::export_protocol_schema_manifest();
                serde_json::to_writer(&mut stdout, &value)
                    .map_err(io::Error::other)
                    .and_then(|()| stdout.write_all(b"\n"))
            } else {
                let raw = cowork_protocol::export_websocket_jsonrpc_schema_json();
                stdout.write_all(raw.as_bytes()).and_then(|()| {
                    if raw.ends_with('\n') {
                        Ok(())
                    } else {
                        stdout.write_all(b"\n")
                    }
                })
            };
            if let Err(err) = result
                && err.kind() != io::ErrorKind::BrokenPipe
            {
                return Err(err.into());
            }
            return Ok(());
        }
        None => {}
    }

    cowork_server::init_tracing();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run_from_cli_with_parent_flag(cli, parent_managed));
    runtime.shutdown_background();
    result
}
