//! Whether the flake's dev shell enters and its clippy is its rustc's. `nix develop` keeps the
//! caller's PATH behind the shell's, so a shell with cargo and rustc but no clippy runs the host's
//! `cargo-clippy`: a clippy-driver built for another rustc fails the workspace's crates against
//! the dependencies the shell's rustc built (E0514), which would read as a red gate. Both report
//! their versions inside the shell — `clippy 0.1.N (<commit> <date>)` and
//! `rustc 1.N.P (<commit> <date>)` — and must name the same release, and the same commit and date
//! where both print them.

use std::time::Duration;

use super::check::Cx;
use super::devshell::{inside, named};
use super::runner::Ran;

/// How long entering the dev shell may take: its first entry builds it.
const ENTRY_MAX: Duration = Duration::from_secs(120);

/// What cargo says when it has no clippy.
const NO_CLIPPY: [&str; 2] = [
    "no such command: `clippy`",
    "cargo-clippy` is not installed",
];

/// Why the dev shell is not one clippy runs in.
pub(super) enum Fault {
    /// A call into the dev shell came to nothing: the command, as named, and what came of it.
    Ran { cmd: String, ran: Ran },
    /// It has no clippy of its rustc's toolchain: what each said.
    NoClippy(String),
}

/// Enters the dev shell and checks its clippy is its rustc's.
pub(super) fn toolchain(cx: &Cx<'_>) -> Result<(), Fault> {
    let clippy = version(cx, "cargo", &["clippy", "--version"]);
    let clippy = match clippy {
        Err(Fault::Ran {
            ran: Ran::Exited { ok: false, err, .. },
            ..
        }) if NO_CLIPPY.iter().any(|n| err.contains(n)) => {
            return Err(Fault::NoClippy(
                "`cargo clippy --version`: not installed".into(),
            ));
        }
        other => other?,
    };
    let rustc = version(cx, "rustc", &["--version"])?;
    if same_toolchain(&clippy, &rustc) {
        Ok(())
    } else {
        Err(Fault::NoClippy(format!(
            "`cargo clippy --version`: {clippy}; `rustc --version`: {rustc}"
        )))
    }
}

/// The first line `program args` prints inside the dev shell.
fn version(cx: &Cx<'_>, program: &str, args: &[&str]) -> Result<String, Fault> {
    let ran = cx
        .runner
        .run_within(cx.top, "nix", &inside(program, args), ENTRY_MAX);
    match ran {
        Ran::Exited { ok: true, out, .. } => Ok(out.lines().next().unwrap_or("").trim().to_owned()),
        ran @ (Ran::Exited { .. } | Ran::Missing | Ran::TimedOut(_) | Ran::Broken(_)) => {
            Err(Fault::Ran {
                cmd: named(program, args),
                ran,
            })
        }
    }
}

/// Whether `clippy` (`clippy 0.1.N …`) and `rustc` (`rustc 1.N.P …`) name one toolchain.
pub(super) fn same_toolchain(clippy: &str, rustc: &str) -> bool {
    let (Some((cv, cid)), Some((rv, rid))) = (parse(clippy, "clippy"), parse(rustc, "rustc"))
    else {
        return false;
    };
    let release = |v: &str, at: usize| {
        v.split('-')
            .next()
            .and_then(|v| v.split('.').nth(at))
            .map(str::to_owned)
    };
    if release(cv, 2).is_none() || release(cv, 2) != release(rv, 1) {
        return false;
    }
    match (cid, rid) {
        (Some((ch, cd)), Some((rh, rd))) => cd == rd && (ch.starts_with(rh) || rh.starts_with(ch)),
        _ => true,
    }
}

/// The version and, when printed, the `(<commit> <date>)` of `<name> <version> (<commit> <date>)`.
fn parse<'a>(line: &'a str, name: &str) -> Option<(&'a str, Option<(&'a str, &'a str)>)> {
    let rest = line.trim().strip_prefix(name)?.strip_prefix(' ')?;
    let (version, rest) = rest.split_once(' ').unwrap_or((rest, ""));
    let id = rest
        .strip_prefix('(')
        .and_then(|r| r.split_once(')'))
        .and_then(|(id, _)| id.split_once(' '));
    Some((version, id))
}
