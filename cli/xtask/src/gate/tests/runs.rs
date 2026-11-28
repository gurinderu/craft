use std::time::Duration;

use super::super::{Io, Status, run};
use super::{gate, recorder, step, steps};

#[test]
fn a_red_step_does_not_stop_the_later_steps_and_the_gate_is_red() {
    let mut exec = recorder(|_, args| {
        if args[0] == "lint" {
            Status::Exit(2)
        } else {
            Status::Exit(0)
        }
    });
    let r = gate(&steps(), None, &mut exec);
    assert!(!r.passed);
    assert_eq!(
        exec.ran,
        ["just lint", "just check-mutation-floor", "just test"]
    );
    assert_eq!(
        r.err,
        "gate: FAIL lint (exit 2, 0s)\ngate: 1 of 3 steps failed: lint\n"
    );
}

#[test]
fn the_gate_is_green_only_when_every_step_is() {
    let mut green = recorder(|_, _| Status::Exit(0));
    let r = gate(&steps(), None, &mut green);
    assert!(r.passed);
    assert!(r.err.is_empty());
    assert!(r.out.ends_with("gate: all 3 steps passed\n"), "{}", r.out);
    for ending in [
        Status::Exit(1),
        Status::Signal,
        Status::NotStarted("no just".to_owned()),
    ] {
        let mut last = recorder(|_, args| {
            if args[0] == "test" {
                ending.clone()
            } else {
                Status::Exit(0)
            }
        });
        assert!(!gate(&steps(), None, &mut last).passed, "{ending:?}");
    }
}

#[test]
fn each_step_prints_its_start_and_its_result() {
    let mut exec = recorder(|_, args| match args[0].as_str() {
        "lint" => Status::Signal,
        "test" => Status::NotStarted("no just".to_owned()),
        _ => Status::Exit(0),
    });
    let r = gate(&steps(), Some("abc"), &mut exec);
    let starts: Vec<&str> = r.out.lines().filter(|l| l.starts_with("gate: ▶")).collect();
    assert_eq!(
        starts,
        [
            "gate: ▶ lint — just lint",
            "gate: ▶ check-mutation-floor — just check-mutation-floor abc",
            "gate: ▶ test — just test"
        ]
    );
    assert!(r.out.contains("gate: PASS check-mutation-floor (0s)\n"));
    assert!(r.out.contains("gate: mutation floor compared with abc\n"));
    assert!(
        r.out
            .contains("gate: not a step — recipe:gate: the gate itself\n")
    );
    assert_eq!(
        r.err,
        "gate: FAIL lint (signal, 0s)\ngate: FAIL test (not started: no just, 0s)\ngate: 2 of 3 steps failed: lint, test\n"
    );
}

#[test]
fn a_step_that_runs_long_prints_its_seconds() {
    let mut exec = recorder(|_, _| Status::Exit(0));
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut t = 0;
    let mut clock = || {
        t += 1600;
        Duration::from_millis(t)
    };
    let passed = run(
        &[step("lint", &[])],
        None,
        &mut exec,
        &mut Io {
            out: &mut out,
            err: &mut err,
            now: &mut clock,
        },
    );
    assert!(passed.unwrap());
    assert!(
        String::from_utf8(out)
            .unwrap()
            .contains("gate: PASS lint (2s)\n")
    );
}

#[test]
fn the_base_goes_only_to_the_step_whose_recipe_takes_it() {
    let mut exec = recorder(|_, _| Status::Exit(0));
    gate(&steps(), Some("deadbeef"), &mut exec);
    assert_eq!(
        exec.ran,
        [
            "just lint",
            "just check-mutation-floor deadbeef",
            "just test"
        ]
    );
    let mut none = recorder(|_, _| Status::Exit(0));
    let r = gate(&steps(), None, &mut none);
    assert_eq!(none.ran[1], "just check-mutation-floor");
    assert!(r.out.contains(
        "gate: mutation floor compared with no base (none given, origin/main not found)\n"
    ));
}

#[test]
fn an_empty_gate_is_red() {
    let mut exec = recorder(|_, _| Status::Exit(0));
    let r = gate(&[], None, &mut exec);
    assert!(!r.passed);
    assert!(exec.ran.is_empty());
    assert!(r.err.contains("no recipe in the gate group"));
}
