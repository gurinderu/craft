//! An agent that could not look (realm @nick/craft, node #511): a lens answering `blocked` is a
//! failed lens with its reason, its findings dropped, and the verdict INCOMPLETE — never a lens
//! that returned nothing; a lens answering empty findings without it stays a clean one (#24).

mod common;

use common::{fixture, lens, prompt_of, small_run, submit, titled};
use serde_json::{Value, json};

const SANDBOX: &str = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";

fn blocked(name: &str, findings: &[Value]) -> Value {
    let mut a = lens(name, findings);
    if let Some(o) = a.as_object_mut() {
        o.insert("blocked".into(), json!(SANDBOX));
    }
    a
}

#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests below, failing loudly like them"
)]
fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

#[test]
fn every_lens_and_the_scout_are_told_how_to_say_they_could_not_look() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    for t in s["tasks"].as_array().unwrap() {
        assert!(
            prompt_of(t).contains("COULD NOT LOOK: if you could not read the code"),
            "{t}"
        );
    }
    let scout = std::fs::read_to_string(run.join("tasks/scout-rust.md")).unwrap();
    assert!(scout.contains("COULD NOT LOOK"), "{scout}");
    let schema: Value = serde_json::from_str(
        &std::fs::read_to_string(run.join("tasks/lens-rust-errors-r1.schema.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(schema["properties"]["blocked"]["type"], json!("string"));
    assert!(
        !schema["required"]
            .as_array()
            .unwrap()
            .contains(&json!("blocked")),
        "optional"
    );
}

#[test]
fn lenses_that_could_not_look_fail_with_their_reason_and_make_the_verdict_incomplete() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r1": blocked("errors", &[titled("High", 1, "a guess from the diff alone")]),
            "lens-rust-intent-r1": blocked("intent", &[]),
            "lens-rust-tests-r1": blocked("tests", &[]),
        }),
    );
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("INCOMPLETE")),
        "a review no lens could look at is no clean one, and not a stopped one: {s}"
    );
    let r = report(&s);
    for want in [
        "- Round 1: 3 lens(es) dispatched, 0 returned, 0 new finding(s).",
        "## Not run\n\n- rust lenses that never returned — errors: could not review: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted · intent: could not review: bwrap",
        "## Confirmed findings\n\nNone.",
    ] {
        assert!(r.contains(want), "{want}\n---\n{r}");
    }
    assert!(
        !r.contains("a guess from the diff alone"),
        "a blocked answer's findings are dropped: {r}"
    );
}

#[test]
fn one_lens_that_could_not_look_holds_an_otherwise_clean_review_incomplete() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r1": lens("errors", &[]),
            "lens-rust-intent-r1": lens("intent", &[]),
            "lens-rust-tests-r1": blocked("tests", &[]),
        }),
    );
    assert_eq!(s["verdict"], json!("INCOMPLETE"), "{s}");
    let r = report(&s);
    assert!(
        r.contains("- rust lenses that never returned — tests: could not review: bwrap"),
        "{r}"
    );
}

#[test]
fn empty_findings_without_blocked_stay_clean() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    // A blank field says nothing.
    let mut quiet = lens("tests", &[]);
    quiet["blocked"] = json!("  ");
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r1": lens("errors", &[]),
            "lens-rust-intent-r1": lens("intent", &[]),
            "lens-rust-tests-r1": quiet,
        }),
    );
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
}
