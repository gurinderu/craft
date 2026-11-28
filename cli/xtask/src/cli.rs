//! The two commands over a repository root and the just program: what `main` runs, apart from where it runs it.

use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::gate::{self, Exec, Io, Status};
use crate::{gate_steps, justfile, sources};

/// Exit codes.
pub const PASSED: u8 = 0;
pub const FAILED: u8 = 1;
pub const USAGE: u8 = 2;

/// Runs a command in the repository root, `just` as the program given.
struct Spawn {
    root: PathBuf,
    just: OsString,
}

impl Exec for Spawn {
    fn run(&mut self, cmd: &str, args: &[String], quiet: bool) -> Status {
        let program = if cmd == "just" {
            self.just.as_os_str()
        } else {
            OsStr::new(cmd)
        };
        let stdio = || {
            if quiet {
                Stdio::null()
            } else {
                Stdio::inherit()
            }
        };
        let ran = Command::new(program)
            .args(args)
            .current_dir(&self.root)
            .stdout(stdio())
            .stderr(stdio())
            .status();
        match ran {
            Ok(status) => status.code().map_or(Status::Signal, Status::Exit),
            Err(e) => Status::NotStarted(e.to_string()),
        }
    }
}

/// `cargo xtask gate [--base <ref>]`.
pub fn gate(
    args: &[String],
    root: &Path,
    just: &OsStr,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> io::Result<u8> {
    let options = match gate::options(args) {
        Ok(options) => options,
        Err(e) => {
            writeln!(err, "gate: {e}")?;
            return Ok(USAGE);
        }
    };
    let text = match std::fs::read_to_string(root.join("justfile")) {
        Ok(text) => text,
        Err(e) => {
            writeln!(err, "gate: the justfile: {e}")?;
            return Ok(FAILED);
        }
    };
    let steps = justfile::gate_steps(&justfile::recipes(&text));
    let mut exec = Spawn {
        root: root.to_owned(),
        just: just.to_owned(),
    };
    let base = gate::base(options.base, &mut exec);
    let start = Instant::now();
    let mut now = || start.elapsed();
    let passed = gate::run(
        &steps,
        base.as_deref(),
        &mut exec,
        &mut Io {
            out,
            err,
            now: &mut now,
        },
    )?;
    Ok(if passed { PASSED } else { FAILED })
}

/// `cargo xtask gate-steps`, against `excluded`.
pub fn gate_steps(
    root: &Path,
    just: &OsStr,
    excluded: &[(&str, &str)],
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> io::Result<u8> {
    let repo = match sources::Repo::read(root) {
        Ok(repo) => repo,
        Err(e) => {
            writeln!(err, "gate-steps: {e}")?;
            return Ok(FAILED);
        }
    };
    let summary = match Command::new(just)
        .args(["--summary", "--unsorted"])
        .current_dir(root)
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            writeln!(
                err,
                "gate-steps: just --summary failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )?;
            return Ok(FAILED);
        }
        Err(e) => {
            writeln!(err, "gate-steps: just --summary did not start: {e}")?;
            return Ok(FAILED);
        }
    };
    let passed = gate_steps::check(&repo, excluded, &summary, out, err)?;
    Ok(if passed { PASSED } else { FAILED })
}

#[cfg(test)]
mod tests;
