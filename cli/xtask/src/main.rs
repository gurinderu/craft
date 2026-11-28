//! `cargo xtask <command>` (run from cli/): the repository's own checks.
//! - `gate [--base <ref>]` — runs the justfile's gate, every step, and exits 1 when any failed;
//! - `gate-steps` — fails when a check the repository names is neither a gate step nor excluded with its reason.

mod cli;
mod coverage;
mod exclusions;
mod gate;
mod gate_steps;
mod justfile;
mod keys;
#[cfg(test)]
mod repo_justfile;
mod sources;

use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
enum Command<'a> {
    Gate(&'a [String]),
    GateSteps,
    Usage,
}

fn command(args: &[String]) -> Command<'_> {
    match args.split_first() {
        Some((cmd, rest)) if cmd == "gate" => Command::Gate(rest),
        Some((cmd, rest)) if cmd == "gate-steps" && rest.is_empty() => Command::GateSteps,
        _ => Command::Usage,
    }
}

/// The repository root: cli/xtask's grandparent.
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mut out, mut err) = (io::stdout().lock(), io::stderr().lock());
    let just = OsStr::new("just");
    let ran = match command(&args) {
        Command::Gate(rest) => cli::gate(rest, &root(), just, &mut out, &mut err),
        Command::GateSteps => {
            cli::gate_steps(&root(), just, exclusions::EXCLUDED, &mut out, &mut err)
        }
        Command::Usage => writeln!(
            err,
            "usage: cargo xtask gate [--base <ref>] | cargo xtask gate-steps"
        )
        .map(|()| cli::USAGE),
    };
    // An error here is stdout or stderr itself failing: nothing is left to tell.
    ExitCode::from(ran.unwrap_or(cli::FAILED))
}

#[cfg(test)]
mod tests {
    use super::{Command, command, root};

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn reads_the_command() {
        let gate = args(&["gate", "--base", "x"]);
        assert_eq!(command(&gate), Command::Gate(&gate[1..]));
        assert_eq!(command(&args(&["gate-steps"])), Command::GateSteps);
        assert_eq!(command(&args(&["gate-steps", "x"])), Command::Usage);
        assert_eq!(command(&args(&["gates"])), Command::Usage);
        assert_eq!(command(&args(&[])), Command::Usage);
    }

    #[test]
    fn the_root_holds_the_justfile_and_this_crate() {
        assert!(root().join("justfile").is_file());
        assert!(root().join("cli/xtask/Cargo.toml").is_file());
    }
}
