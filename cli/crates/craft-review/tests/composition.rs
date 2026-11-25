//! The reviewer's lens composition end to end over a fixture repository (realm @nick/craft, node
//! #644): a lens turned off leaves the lens step and is named in the report, `--all-lenses` sets the
//! composition aside and says so, and a composition naming the security lens is refused whole.
#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use common::{fixture, ids, opts, scout, submit};
use craft_review::composition::State;
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// The lens step of a small run over a Rust fixture whose start takes `lenses` and `all`, its
/// scout picking `errors`: the step and the run's state.
fn lens_step(lenses: &[(&str, State)], all: bool) -> (Value, Value) {
    lens_step_with(lenses, |o| StartOptions {
        all_lenses: all,
        ..o
    })
}

/// As [`lens_step`], the start's other options as `with` sets them.
fn lens_step_with(
    lenses: &[(&str, State)],
    with: impl FnOnce(StartOptions) -> StartOptions,
) -> (Value, Value) {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let run = out.path().join("run");
    step::start(&with(StartOptions {
        lenses: lenses.iter().map(|(l, s)| ((*l).to_owned(), *s)).collect(),
        ..opts(repo.path(), out.path())
    }))
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    (s, state)
}

fn notes(state: &Value) -> String {
    state["notes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_lens_the_profile_turns_off_leaves_the_lens_step_and_is_named() {
    let (s, state) = lens_step(&[("rust:errors", State::Off)], false);
    assert_eq!(ids(&s), ["lens-rust-intent-r1", "lens-rust-tests-r1"]);
    assert_eq!(state["tracks"][0]["plan"]["profileOff"], json!(["errors"]));
    assert!(
        notes(&state).contains("turned off: rust:errors"),
        "{}",
        notes(&state)
    );
}

#[test]
fn all_lenses_sets_the_composition_aside_and_says_what_it_would_have_done() {
    let (s, state) = lens_step(&[("rust:errors", State::Off)], true);
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    assert!(
        notes(&state).contains("every lens runs (`--all-lenses`), though"),
        "{}",
        notes(&state)
    );
}

#[test]
fn a_composition_naming_the_security_lens_is_refused_whole() {
    let (s, state) = lens_step(
        &[("rust:errors", State::Off), ("rust:safety", State::Off)],
        false,
    );
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    assert!(
        notes(&state).contains("was refused (rust:safety"),
        "{}",
        notes(&state)
    );
}

#[test]
fn a_composition_that_would_leave_a_part_with_no_lens_runs_them_all_and_says_so() {
    let (s, state) = lens_step(
        &[
            ("rust:errors", State::Off),
            ("rust:intent", State::Off),
            ("rust:tests", State::Off),
        ],
        false,
    );
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    assert!(
        notes(&state).contains("would turn off every lens planned for rust's part"),
        "{}",
        notes(&state)
    );
}

#[test]
fn a_section_that_could_not_be_read_is_named_and_every_lens_runs() {
    let (s, state) = lens_step_with(&[], |o| StartOptions {
        lenses_unread: "review.toml: [lenses]: bad state".into(),
        ..o
    });
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    assert!(
        notes(&state).contains("could not be read (review.toml: [lenses]: bad state)"),
        "{}",
        notes(&state)
    );
    let (_, clean) = lens_step(&[], false);
    assert!(
        !notes(&clean).contains("could not be read"),
        "{}",
        notes(&clean)
    );
}

#[test]
fn what_the_run_asks_for_itself_runs_though_the_profile_turns_it_off() {
    let off = [
        ("rust:maintainability", State::Off),
        ("rust:api-idioms", State::Off),
    ];
    let (plain, _) = lens_step(&off, false);
    assert!(
        !ids(&plain)
            .iter()
            .any(|id| id.contains("maintainability") || id.contains("api-idioms"))
    );
    let (s, state) = lens_step_with(&off, |o| StartOptions {
        strict: true,
        optional: Some("api-idioms".into()),
        ..o
    });
    let ran = ids(&s);
    assert!(
        ran.contains(&"lens-rust-maintainability-r1".to_owned())
            && ran.contains(&"lens-rust-api-idioms-r1".to_owned()),
        "{ran:?}"
    );
    assert!(
        notes(&state).contains("the run asks for rust's maintainability, api-idioms itself"),
        "{}",
        notes(&state)
    );
}

/// The second round's lens step of a medium run whose `errors` found something new in the first,
/// the start taking `lenses`.
fn second_round(lenses: &[(&str, State)]) -> Vec<String> {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let run = out.path().join("run");
    step::start(&StartOptions {
        lenses: lenses.iter().map(|(l, s)| ((*l).to_owned(), *s)).collect(),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("medium", &["errors"])}));
    let first: serde_json::Map<String, Value> = ids(&s)
        .into_iter()
        .map(|id| {
            let found = if id.contains("-errors-") {
                vec![common::finding("Medium", 2)]
            } else {
                Vec::new()
            };
            let name = id
                .trim_start_matches("lens-rust-")
                .trim_end_matches("-r1")
                .to_owned();
            (id, common::lens(&name, &found))
        })
        .collect();
    let s = step::submit(&run, Some(&first)).unwrap();
    ids(&s)
}

#[test]
fn a_lens_held_to_the_first_round_is_not_sent_again_though_it_found_something() {
    assert!(
        second_round(&[])
            .iter()
            .any(|id| id == "lens-rust-errors-r2"),
        "unheld, it goes again"
    );
    let held = second_round(&[("rust:errors", State::FirstRound)]);
    assert!(!held.iter().any(|id| id.contains("-errors-")), "{held:?}");
}
