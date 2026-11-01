use clap::Parser;
use cowork_cli::{CliArgs, run_cli};

fn main() -> anyhow::Result<()> {
    run_cli(CliArgs::parse())
}
