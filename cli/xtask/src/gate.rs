//! The gate's runner: every step of the justfile's `gate` group, in order, each run as `just <step>` — a failed
//! one included, so one red step does not hide the verdict of the rest. Each step prints its own output, then one
//! result line; the gate is red when any step is. A step whose recipe takes `base` gets the mutation floor's base.

use std::io::{self, Write};
use std::time::Duration;

use crate::exclusions::EXCLUDED;
use crate::justfile::Recipe;

mod base;
pub use base::{base, options, takes_base};

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

/// Where the gate's lines go, and its clock: the time since the run began.
pub struct Io<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub now: &'a mut dyn FnMut() -> Duration,
}

/// Runs every step; `Ok(true)` when all passed. A base that no step takes is red: the floor would not see it.
pub fn run(
    steps: &[Recipe],
    base: Option<&str>,
    exec: &mut dyn Exec,
    io: &mut Io<'_>,
) -> io::Result<bool> {
    let failed = run_steps(steps, base, exec, io)?;
    let base_unused = report_base(steps, base, io)?;
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
    if !failed.is_empty() {
        writeln!(
            io.err,
            "gate: {} of {} steps failed: {}",
            failed.len(),
            steps.len(),
            failed.join(", ")
        )?;
    }
    if failed.is_empty() && !base_unused {
        writeln!(io.out, "gate: all {} steps passed", steps.len())?;
        return Ok(true);
    }
    Ok(false)
}

/// Each step in turn, a failed one included; the names of those that failed.
fn run_steps<'s>(
    steps: &'s [Recipe],
    base: Option<&str>,
    exec: &mut dyn Exec,
    io: &mut Io<'_>,
) -> io::Result<Vec<&'s str>> {
    let mut failed = Vec::new();
    for step in steps {
        let mut args = vec![step.name.clone()];
        if let (Some(b), true) = (base, takes_base(step)) {
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
    Ok(failed)
}

/// What the mutation floor was compared with; `true` when a base was set and no step took it.
fn report_base(steps: &[Recipe], base: Option<&str>, io: &mut Io<'_>) -> io::Result<bool> {
    match (base, steps.iter().any(takes_base)) {
        (Some(b), true) => writeln!(io.out, "gate: mutation floor compared with {b}")?,
        (Some(b), false) => {
            writeln!(
                io.err,
                "gate: the base {b} reached no step: no gate recipe takes a `base` parameter, so the mutation floor was not compared with it"
            )?;
            return Ok(true);
        }
        (None, _) => writeln!(
            io.out,
            "gate: mutation floor compared with no base (none given, origin/main not found)"
        )?,
    }
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
