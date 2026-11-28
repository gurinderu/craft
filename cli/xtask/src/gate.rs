//! The gate's runner: every step of the justfile's `gate` group, in order, each run as `just <step>` — a failed
//! one included, so one red step does not hide the verdict of the rest. Each step prints its own output, then one
//! result line; the gate is red when any step is. A step whose recipe takes `base` gets the mutation floor's base.

use std::io::{self, Write};
use std::time::Duration;

use crate::exclusions::EXCLUDED;
use crate::justfile::Recipe;

/// How one command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Exit(i32),
    Signal,
    NotStarted(String),
}

/// Runs one command, its output through unless `quiet`.
pub trait Exec {
    fn run(&mut self, cmd: &str, args: &[String], quiet: bool) -> Status;
}

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
            "--base" => base = Some(rest.next().ok_or("--base needs a ref")?.clone()),
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

/// Where the gate's lines go, and its clock: the time since the run began.
pub struct Io<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub now: &'a mut dyn FnMut() -> Duration,
}

/// Runs every step; `Ok(true)` when all passed.
pub fn run(
    steps: &[Recipe],
    base: Option<&str>,
    exec: &mut dyn Exec,
    io: &mut Io<'_>,
) -> io::Result<bool> {
    let mut failed: Vec<&str> = Vec::new();
    for step in steps {
        let mut args = vec![step.name.clone()];
        if let (Some(b), true) = (base, step.params.iter().any(|p| p == "base")) {
            args.push(b.to_owned());
        }
        writeln!(io.out, "gate: ▶ {} — just {}", step.name, args.join(" "))?;
        io.out.flush()?;
        let start = (io.now)();
        let status = exec.run("just", &args, false);
        let took = seconds((io.now)().saturating_sub(start));
        match status {
            Status::Exit(0) => writeln!(io.out, "gate: PASS {} ({took}s)", step.name)?,
            other @ (Status::Exit(_) | Status::Signal | Status::NotStarted(_)) => {
                failed.push(step.name.as_str());
                writeln!(
                    io.err,
                    "gate: FAIL {} ({}, {took}s)",
                    step.name,
                    ended(&other)
                )?;
            }
        }
    }
    let floor = base.unwrap_or("no base (none given, origin/main not found)");
    writeln!(io.out, "gate: mutation floor compared with {floor}")?;
    for (key, why) in EXCLUDED {
        writeln!(io.out, "gate: not a step — {key}: {why}")?;
    }
    if steps.is_empty() {
        writeln!(
            io.err,
            "gate: the justfile has no recipe in the gate group: nothing was checked"
        )?;
        return Ok(false);
    }
    if failed.is_empty() {
        writeln!(io.out, "gate: all {} steps passed", steps.len())?;
        return Ok(true);
    }
    writeln!(
        io.err,
        "gate: {} of {} steps failed: {}",
        failed.len(),
        steps.len(),
        failed.join(", ")
    )?;
    Ok(false)
}

fn ended(status: &Status) -> String {
    match status {
        Status::Exit(code) => format!("exit {code}"),
        Status::Signal => "signal".to_owned(),
        Status::NotStarted(why) => format!("not started: {why}"),
    }
}

fn seconds(d: Duration) -> u128 {
    (d.as_millis() + 500) / 1000
}

#[cfg(test)]
mod tests;
