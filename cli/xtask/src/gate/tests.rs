use std::time::Duration;

use super::{Exec, Io, Status, run};
use crate::justfile::Recipe;

/// Records every command it is handed and answers each with `answer`.
struct Recorder<F: FnMut(&str, &[String]) -> Status> {
    ran: Vec<String>,
    quiet: Vec<String>,
    answer: F,
}

impl<F: FnMut(&str, &[String]) -> Status> Exec for Recorder<F> {
    fn run(&mut self, cmd: &str, args: &[String], quiet: bool) -> Status {
        let line = std::iter::once(cmd.to_owned())
            .chain(args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
        if quiet {
            &mut self.quiet
        } else {
            &mut self.ran
        }
        .push(line);
        (self.answer)(cmd, args)
    }
}

fn recorder<F: FnMut(&str, &[String]) -> Status>(answer: F) -> Recorder<F> {
    Recorder {
        ran: Vec::new(),
        quiet: Vec::new(),
        answer,
    }
}

fn step(name: &str, params: &[&str]) -> Recipe {
    Recipe {
        name: name.to_owned(),
        params: params.iter().map(|p| (*p).to_owned()).collect(),
        groups: vec!["gate".to_owned()],
        script: false,
        body: Vec::new(),
    }
}

fn steps() -> Vec<Recipe> {
    vec![
        step("lint", &[]),
        step("check-mutation-floor", &["base"]),
        step("test", &[]),
    ]
}

struct Run {
    passed: bool,
    out: String,
    err: String,
}

fn gate(steps: &[Recipe], base: Option<&str>, exec: &mut dyn Exec) -> Run {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut clock = || Duration::from_millis(1600);
    let passed = run(
        steps,
        base,
        exec,
        &mut Io {
            out: &mut out,
            err: &mut err,
            now: &mut clock,
        },
    )
    .unwrap();
    Run {
        passed,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
    }
}

mod base;
mod base_steps;
mod runs;
