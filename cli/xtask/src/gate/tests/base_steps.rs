use super::super::Status;
use super::{gate, recorder, step, steps};

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
fn a_base_no_step_takes_turns_the_gate_red_and_is_not_reported_as_compared() {
    let no_taker = [step("lint", &[]), step("check-mutation-floor", &["since"])];
    let mut exec = recorder(|_, _| Status::Exit(0));
    let r = gate(&no_taker, Some("deadbeef"), &mut exec);
    assert!(!r.passed);
    assert_eq!(exec.ran, ["just lint", "just check-mutation-floor"]);
    assert!(!r.out.contains("compared with"), "{}", r.out);
    assert!(!r.out.contains("steps passed"), "{}", r.out);
    assert_eq!(
        r.err,
        "gate: the base deadbeef reached no step: no gate recipe takes a `base` parameter, so the mutation floor was not compared with it\n"
    );
    let mut none = recorder(|_, _| Status::Exit(0));
    assert!(gate(&no_taker, None, &mut none).passed);
}

#[test]
fn a_base_no_step_takes_still_reports_the_failed_steps() {
    let no_taker = [step("lint", &[])];
    let mut exec = recorder(|_, _| Status::Exit(1));
    let r = gate(&no_taker, Some("abc"), &mut exec);
    assert!(!r.passed);
    assert!(
        r.err.contains("gate: 1 of 1 steps failed: lint\n"),
        "{}",
        r.err
    );
    assert!(r.err.contains("the base abc reached no step"), "{}", r.err);
}
