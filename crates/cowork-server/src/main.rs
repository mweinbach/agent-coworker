use clap::Parser;
use cowork_server::{ServerCli, run_from_cli};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = ServerCli::parse();
    run_from_cli(cli).await
}
