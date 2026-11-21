//! Versioned native process identity helper (realm @nick/craft, node #563).
use std::process::ExitCode;

#[derive(Debug, clap::Args)]
pub struct Args {
    #[arg(long)]
    pid: u32,
}

pub fn run(args: &Args) -> anyhow::Result<ExitCode> {
    let identity = craft_store::process_identity::query(args.pid)?;
    let reply = serde_json::json!({"version": 1, "pid": args.pid, "identity": identity});
    #[expect(clippy::print_stdout, reason = "the helper's one JSON response")]
    {
        println!("{reply}");
    }
    Ok(ExitCode::SUCCESS)
}
