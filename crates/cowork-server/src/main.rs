use clap::Parser;
use cowork_server::{ServerCli, run_from_cli_with_parent_flag};

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
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_from_cli_with_parent_flag(cli, parent_managed))
}
