use super::*;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

fn gate(runs: &[&str]) -> Gate {
    let mut f = Flow::default();
    for r in runs {
        f.add(&rec(r), true).unwrap();
    }
    f.gate
}

#[test]
fn the_share_is_the_saved_over_the_saved_and_dispatched_of_the_runs_that_count_both() {
    let g = gate(&[
        r#"{"surfaceGate":{"dropped":["a","b"],"dispatched":["c"]}}"#,
        r#"{"surfaceGate":{"dropped":["a"]}}"#,
        r#"{"surfaceGate":{"dropped":[],"dispatched":["c","d","e"]}}"#,
        "{}",
        r#"{"surfaceGate":[]}"#,
    ]);
    assert_eq!(
        (g.pre_gate, g.gate_runs, g.saved_runs, g.saved_passes),
        (1, 4, 2, 3)
    );
    assert_eq!(
        (
            g.share_saved_passes,
            g.dispatched_passes,
            g.missing_dispatched_runs
        ),
        (2, 4, 2)
    );
    assert_eq!(g.saved_by_lens.get("a"), Some(&2));
    assert_eq!(g.share(), Some(33.33));
    assert_eq!(Gate::default().share(), None);
    let one = gate(&[r#"{"surfaceGate":{"dropped":["a"],"dispatched":[]}}"#]);
    assert_eq!(one.share(), Some(100.0));
}

#[test]
fn only_a_failed_gate_with_nothing_dispatched_and_no_lens_back_is_left_out() {
    let failed = r#"{"gate":{"status":"fail"},"surfaceGate":{"dropped":["a"],"dispatched":[]}}"#;
    let ran = r#"{"gate":{"status":"fail"},"surfaceGate":{"dropped":["a"],"dispatched":[],"lensesRan":true}}"#;
    let dispatched =
        r#"{"gate":{"status":"fail"},"surfaceGate":{"dropped":["a"],"dispatched":["b"]}}"#;
    let passed = r#"{"gate":{"status":"pass"},"surfaceGate":{"dropped":["a"],"dispatched":[]}}"#;
    let g = gate(&[failed, ran, dispatched, passed]);
    assert_eq!((g.failed_runs, g.saved_runs), (1, 3));
    let mut light = Flow::default();
    light.add(&rec(failed), false).unwrap();
    assert_eq!(
        light.gate,
        Gate::default(),
        "a light run is outside the gate's figures"
    );
}

#[test]
fn the_refute_basis_and_thinning_count_what_the_record_carried() {
    let mut f = Flow::default();
    for r in [
        r#"{"verification":{"refuteRate":0.5,"unverified":0,"thinned":0}}"#,
        r#"{"verification":{"refuteRate":0.5,"thinned":3}}"#,
        r#"{"verification":{"thinned":1}}"#,
    ] {
        f.add(&rec(r), true).unwrap();
    }
    assert_eq!(f.refute_basis(), Some("mixed"));
    assert_eq!((f.thinned, f.thinned_runs, f.thinned_measured), (4.0, 2, 3));
    assert_eq!(basis(1, 0), Some("strict"));
    assert_eq!(basis(0, 1), Some("legacy"));
    assert_eq!(basis(0, 0), None);
}
