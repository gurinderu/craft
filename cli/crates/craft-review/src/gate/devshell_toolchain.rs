//! Whether the flake's dev shell enters and its clippy is its rustc's. `nix develop` keeps the
//! caller's PATH behind the shell's, so a shell with cargo and rustc but no clippy runs the host's
//! `cargo-clippy`: a clippy-driver of another rustc fails the workspace's crates against the
//! dependencies the shell's rustc built (E0514, which compares the whole version string, so one
//! release built twice differs — nixpkgs' rustc says `(built from a source tarball)`, rustup's
//! does not). Each names the toolchain it belongs to by its sysroot: `clippy-driver --print
//! sysroot` and `rustc --print sysroot`, inside the shell, must be the same directory. Observed
//! with nixpkgs' rustc 1.99.1 beside rustup's clippy (two sysroots) and beside nixpkgs' clippy
//! (one).

use std::path::Path;
use std::time::Duration;

use super::check::Cx;
use super::devshell::{inside, named, why};
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
    /// Entering the dev shell came to nothing: the command, as named, and what came of it.
    Ran { cmd: String, ran: Ran },
    /// It has no clippy of its rustc's toolchain: what was seen.
    NoClippy(String),
}

/// Enters the dev shell and checks its clippy is its rustc's.
pub(super) fn toolchain(cx: &Cx<'_>) -> Result<(), Fault> {
    let clippy = match first_line(cx, "cargo", &["clippy", "--version"]) {
        Ok(v) => v,
        Err(Fault::Ran {
            ran: Ran::Exited { ok: false, err, .. },
            ..
        }) if NO_CLIPPY.iter().any(|n| err.contains(n)) => {
            return Err(Fault::NoClippy(
                "`cargo clippy --version`: not installed".into(),
            ));
        }
        Err(e) => return Err(e),
    };
    // The shell entered: what fails from here is its toolchain's.
    let driver = first_line(cx, "clippy-driver", &["--print", "sysroot"]).map_err(seen)?;
    let rustc = first_line(cx, "rustc", &["--print", "sysroot"]).map_err(seen)?;
    if !driver.is_empty() && same_dir(&driver, &rustc) {
        return Ok(());
    }
    let version = first_line(cx, "rustc", &["--version"]).unwrap_or_else(|f| match f {
        Fault::Ran { ran, .. } => why(&ran),
        Fault::NoClippy(s) => s,
    });
    Err(Fault::NoClippy(format!(
        "clippy's sysroot {driver}, rustc's {rustc}; `cargo clippy --version`: {clippy}; `rustc --version`: {version}"
    )))
}

/// A call into the entered shell that came to nothing, as what was seen.
fn seen(f: Fault) -> Fault {
    match f {
        Fault::Ran { cmd, ran } => Fault::NoClippy(format!("{cmd}: {}", why(&ran))),
        f @ Fault::NoClippy(_) => f,
    }
}

/// Whether two sysroots are one directory.
fn same_dir(a: &str, b: &str) -> bool {
    let real = |p: &str| std::fs::canonicalize(Path::new(p)).ok();
    a == b || real(a).is_some_and(|r| Some(r) == real(b))
}

/// The first line `program args` prints inside the dev shell.
fn first_line(cx: &Cx<'_>, program: &str, args: &[&str]) -> Result<String, Fault> {
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
