//! The commands over a scratch repository, `just` a shell script that logs each step it is asked for.
#![cfg(unix)]

use std::fs;
use std::path::Path;

use super::{FAILED, PASSED, USAGE, gate, gate_steps};

mod fixture;
use fixture::{JUSTFILE, fake_just, repo};

struct Ran {
    code: u8,
    out: String,
    err: String,
    log: String,
}

fn run(root: &Path, just: &Path, command: &[&str]) -> Ran {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = if let Some((&"gate", rest)) = command.split_first() {
        let args: Vec<String> = rest.iter().map(|s| (*s).to_owned()).collect();
        gate(&args, root, just.as_os_str(), &mut out, &mut err).unwrap()
    } else {
        let excluded = [("recipe:gate", "the gate"), ("cmd:npm ci", "installs")];
        gate_steps(root, just.as_os_str(), &excluded, &mut out, &mut err).unwrap()
    };
    let log = fs::read_to_string(root.join("log")).unwrap_or_default();
    Ran {
        code,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
        log,
    }
}

#[test]
fn the_gate_runs_every_step_past_a_red_one_and_exits_red() {
    let dir = repo(JUSTFILE);
    let just = fake_just(dir.path(), "", 0);
    let r = run(dir.path(), &just, &["gate", "--base", "b1"]);
    assert_eq!(r.code, FAILED);
    assert_eq!(r.log, "ok\nred\nlast b1\n");
    assert!(r.out.contains("gate: PASS ok ("), "{}", r.out);
    assert!(r.err.contains("gate: FAIL red (exit 3, "), "{}", r.err);
}

#[test]
fn the_gate_is_green_when_every_step_is_and_takes_no_base_outside_a_repository() {
    let dir = repo(&JUSTFILE.replace("red:", "fine:"));
    let just = fake_just(dir.path(), "", 0);
    let r = run(dir.path(), &just, &["gate"]);
    assert_eq!(r.code, PASSED, "{}", r.err);
    assert_eq!(r.log, "ok\nfine\nlast\n");
}

#[test]
fn the_gate_refuses_an_unknown_argument_and_a_missing_justfile() {
    let dir = repo(JUSTFILE);
    let just = fake_just(dir.path(), "", 0);
    assert_eq!(run(dir.path(), &just, &["gate", "--bse"]).code, USAGE);
    assert_eq!(run(dir.path(), &just, &["gate", "--base", ""]).code, USAGE);
    fs::remove_file(dir.path().join("justfile")).unwrap();
    let r = run(dir.path(), &just, &["gate"]);
    assert_eq!(r.code, FAILED);
    assert!(r.err.starts_with("gate: the justfile: "), "{}", r.err);
}

#[test]
fn gate_steps_passes_a_complete_gate_and_fails_a_gap() {
    let dir = repo(JUSTFILE);
    let just = fake_just(dir.path(), "gate ok red last", 0);
    let r = run(dir.path(), &just, &["gate-steps"]);
    assert_eq!(r.code, PASSED, "{}", r.err);
    assert!(r.out.starts_with("gate-steps: "), "{}", r.out);
    let gap = repo(&JUSTFILE.replace("npm run --silent test -- ", "npm run --silent missing -- "));
    let r = run(
        gap.path(),
        &fake_just(gap.path(), "gate ok red last", 0),
        &["gate-steps"],
    );
    assert_eq!(r.code, FAILED);
    assert!(
        r.err
            .contains("gate-steps: not a gate step and not excluded: script:test\n"),
        "{}",
        r.err
    );
}

#[test]
fn gate_steps_fails_when_just_cannot_list_the_recipes() {
    let dir = repo(JUSTFILE);
    let r = run(dir.path(), &fake_just(dir.path(), "", 1), &["gate-steps"]);
    assert_eq!(
        (r.code, r.err.as_str()),
        (FAILED, "gate-steps: just --summary failed: no justfile\n")
    );
    let r = run(
        dir.path(),
        &dir.path().join("no-such-just"),
        &["gate-steps"],
    );
    assert_eq!(r.code, FAILED);
    assert!(
        r.err
            .starts_with("gate-steps: just --summary did not start: "),
        "{}",
        r.err
    );
    fs::remove_file(dir.path().join("AGENTS.md")).unwrap();
    let r = run(
        dir.path(),
        &fake_just(dir.path(), "gate ok red last", 0),
        &["gate-steps"],
    );
    assert_eq!(r.code, FAILED);
    assert!(r.err.starts_with("gate-steps: AGENTS.md: "), "{}", r.err);
}
