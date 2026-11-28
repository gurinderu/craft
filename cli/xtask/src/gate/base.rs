//! The mutation floor's base: read from the command line, else found, and which step takes it.

use super::{Exec, Status};
use crate::justfile::Recipe;

/// The command line's options.
#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub base: Option<String>,
}

pub fn options(args: &[String]) -> Result<Options, String> {
    let mut base = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--base" => {
                let given = rest.next().filter(|b| !b.trim().is_empty());
                base = Some(given.ok_or("--base needs a ref")?.clone());
            }
            other => {
                return Err(format!(
                    "unknown argument {other}; usage: cargo xtask gate [--base <ref>]"
                ));
            }
        }
    }
    Ok(Options { base })
}

pub const DEFAULT_BASE: &str = "origin/main";

/// The mutation floor's base: the one given, else origin/main when it resolves, else none.
pub fn base(given: Option<String>, exec: &mut dyn Exec) -> Option<String> {
    given.or_else(|| {
        let probe = ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"].map(str::to_owned);
        (exec.run("git", &probe, true) == Status::Exit(0)).then(|| DEFAULT_BASE.to_owned())
    })
}

/// Whether a step's recipe takes the base: a parameter named `base`.
pub fn takes_base(step: &Recipe) -> bool {
    step.params.iter().any(|p| p == "base")
}
