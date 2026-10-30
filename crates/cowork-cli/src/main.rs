use clap::Parser;
use cowork_cli::{CliArgs, run_cli};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = CliArgs::parse();
    run_cli(args).await
}
