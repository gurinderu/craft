//! The verifier panel of a Critical or High finding, as the engine buys it: a cheap cull vote and one
//! authoritative vote first, the rest of the panel only when those two do not agree; and what dead
//! and off-schema voters leave behind.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

mod common;

use std::path::{Path, PathBuf};

use common::{finding, fixture, ids, lens, opts, past_critic, prompt_of, submit, titled, verdict};
use craft_review::step;
use serde_json::{Map, Value, json};

/// A security-sensitive scout: the plan's verifier votes rise to 3.
fn sensitive_scout() -> Value {
    json!({"sizeBucket": "small", "lenses": ["errors"], "isLibrary": false, "securitySensitive": true,
           "intent": "add f", "churn": [], "repoRules": [], "notes": "n"})
}

/// Every pending lens answered, the first with `found`, the rest empty.
fn lenses(s: &Value, found: &[Value]) -> Value {
    let all: Map<String, Value> = ids(s)
        .iter()
        .enumerate()
        .map(|(k, id)| (id.clone(), lens("x", if k == 0 { found } else { &[] })))
        .collect();
    Value::Object(all)
}

/// A run over a security-sensitive plan whose lenses found `found`; returns the run and the first
/// verify step.
fn verify_step(repo: &Path, out: &Path, found: &[Value]) -> (PathBuf, Value) {
    let run = out.join("run");
    step::start(&opts(repo, out)).unwrap();
    let s = submit(&run, json!({"scout-rust": sensitive_scout()}));
    let s = submit(&run, lenses(&s, found));
    let s = submit(&run, lenses(&s, &[]));
    (run, s)
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

fn task<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(id))
        .unwrap()
}

#[test]
fn an_agreeing_pair_settles_a_high_with_no_further_vote() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = verify_step(repo.path(), out.path(), &[finding("High", 1)]);
    assert_eq!(ids(&s), ["verify-0-v0", "verify-0-v3"]);
    let (cull, auth) = (task(&s, "verify-0-v0"), task(&s, "verify-0-v3"));
    assert_eq!(
        (&cull["model"], &cull["label"]),
        (&json!("sonnet"), &json!("verify:src/lib.rs:1#c1"))
    );
    assert_eq!(
        (&auth["model"], &auth["label"]),
        (&json!("opus"), &json!("verify:src/lib.rs:1#auth"))
    );
    assert!(prompt_of(auth).contains("You are skeptic #4 trying to REFUTE"));
    let s = submit(
        &run,
        json!({"verify-0-v0": verdict(false), "verify-0-v3": verdict(false)}),
    );
    let s = past_critic(&run, s);
    assert_eq!(s["verdict"], json!("Block"));
}

#[test]
fn a_split_pair_buys_the_rest_of_the_panel_and_the_majority_decides() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = verify_step(repo.path(), out.path(), &[finding("High", 1)]);
    let s = submit(
        &run,
        json!({"verify-0-v0": verdict(false), "verify-0-v3": verdict(true)}),
    );
    assert_eq!(ids(&s), ["verify-0-v1", "verify-0-v2"]);
    assert!(prompt_of(&s["tasks"][1]).contains("You are skeptic #3"));
    let s = submit(
        &run,
        json!({"verify-0-v1": verdict(false), "verify-0-v2": verdict(false)}),
    );
    // One refutation of four: suspected, which does not block.
    let s = past_critic(&run, s);
    assert_eq!(s["verdict"], json!("Approve"));
    assert!(
        report(&s).contains("## Suspected findings\n\n- **High** `src/lib.rs:1`"),
        "{}",
        report(&s)
    );
}

#[test]
fn a_dead_and_an_off_schema_voter_thin_the_panel_and_the_report_says_so() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = verify_step(repo.path(), out.path(), &[finding("High", 1)]);
    let mut s = Value::Null;
    for _ in 0..3 {
        s = submit(&run, json!({"verify-0-v3": {"reason": "fine"}}));
    }
    assert_eq!(ids(&s), ["verify-0-v1", "verify-0-v2"], "neither opened");
    let s = submit(
        &run,
        json!({"verify-0-v1": verdict(false), "verify-0-v2": verdict(false)}),
    );
    let s = past_critic(&run, s);
    assert_eq!(s["verdict"], json!("Block"));
    let r = report(&s);
    assert!(
        r.contains("(PANEL THINNED: 1 of 3 returned votes answered off-schema and were discarded before the arithmetic — this confirmed stands on 2 of 3 returned votes, most of the panel that answered)"),
        "{r}"
    );
    assert!(
        r.contains("verify:src/lib.rs:1#c1 gave no valid answer"),
        "{r}"
    );
}

#[test]
fn a_panel_that_never_answers_is_unverified_and_the_verdict_incomplete() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let found = [finding("Critical", 1), titled("High", 1, "another")];
    let (run, _) = verify_step(repo.path(), out.path(), &found);
    let s = submit(&run, json!({"dedup-rust": {"groups": []}}));
    assert_eq!(
        ids(&s),
        ["verify-0-v0", "verify-0-v3", "verify-1-v0", "verify-1-v3"]
    );
    // The other finding's panel answers, so the verification is no dead round (`stop`).
    let mut s = submit(
        &run,
        json!({"verify-1-v0": verdict(true), "verify-1-v3": verdict(true)}),
    );
    for _ in 0..5 {
        assert_eq!(s["done"], json!(false), "{s}");
        s = submit(&run, json!({}));
    }
    let s = past_critic(&run, s);
    assert_eq!(s["verdict"], json!("INCOMPLETE"), "{s}");
    let r = report(&s);
    for want in [
        "(NOT VERIFIED: every verifier vote for this finding died before returning a verdict — nothing was checked against the code)",
        "- rust verification of src/lib.rs — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code",
    ] {
        assert!(r.contains(want), "{want}: {r}");
    }
}

#[test]
fn a_dead_batch_leaves_its_findings_unverified_and_names_the_death() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = verify_step(repo.path(), out.path(), &[titled("Medium", 1, "a")]);
    assert_eq!(ids(&s), ["verify-batch-0"]);
    let mut s = Value::Null;
    for _ in 0..3 {
        s = submit(&run, json!({"verify-batch-0": {"verdicts": "none"}}));
    }
    let s = past_critic(&run, s);
    assert_eq!(s["verdict"], json!("INCOMPLETE"));
    let r = report(&s);
    assert!(
        r.contains("(NOT VERIFIED: the batch verifier for src/lib.rs answered OFF-SCHEMA — its answer carried no verdict list at all, so nothing checked this finding against the code)"),
        "{r}"
    );
}
