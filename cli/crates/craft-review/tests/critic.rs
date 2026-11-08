//! The completeness critic end to end: on a large plan it is asked after verification, a lens it
//! names that the plan did not run is dispatched, and what that lens finds is verified under ids
//! of its own and joins the verdict beside the first pass's findings.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers are steps of the test, failing loudly like it"
)]

mod common;

use std::path::Path;

use common::{fixture, ids, lens, opts, prompt_of, submit, titled, verdict};
use craft_review::step;
use serde_json::{Map, Value, json};

/// Every pending lens of `s` answered: `errors` with `found`, the rest with nothing.
fn lenses(s: &Value, found: &[Value]) -> Value {
    let all: Map<String, Value> = ids(s)
        .into_iter()
        .map(|id| {
            let mine = id.starts_with("lens-rust-errors-");
            (id, lens("x", if mine { found } else { &[] }))
        })
        .collect();
    Value::Object(all)
}

/// Every pending verifier of `s` upholds its finding.
fn upheld(s: &Value) -> Value {
    let all: Map<String, Value> = ids(s).into_iter().map(|id| (id, verdict(false))).collect();
    Value::Object(all)
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

/// A large plan's lens rounds that find one High, verified: returns the critic's step.
fn to_critic(run: &Path) -> Value {
    let scout = json!({"sizeBucket": "large", "lenses": ["errors"], "isLibrary": false,
                       "securitySensitive": false, "intent": "add f", "churn": [], "repoRules": [], "notes": "n"});
    let s = submit(run, json!({"scout-rust": scout}));
    let s = submit(run, lenses(&s, &[titled("High", 1, "f returns 1")]));
    let s = submit(run, lenses(&s, &[]));
    assert_eq!(ids(&s), ["verify-0-v0", "verify-0-v3"]);
    submit(run, upheld(&s))
}

#[test]
fn the_critic_admits_a_lens_and_its_finding_is_verified() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = to_critic(&run);
    assert_eq!(ids(&s), ["critic-rust"]);
    let p = prompt_of(&s["tasks"][0]);
    assert!(p.contains("Confirmed: 1, Suspected: 0."), "{p}");
    assert!(
        p.contains(r#"choose ONLY from: ["safety","concurrency","performance""#),
        "{p}"
    );

    let s = submit(
        &run,
        json!({"critic-rust": {"missingLenses": ["safety", "performance"], "notes": "the panic path of f is untested"}}),
    );
    assert_eq!(ids(&s), ["critic-lens-rust-safety"]);
    let p = prompt_of(&s["tasks"][0]);
    assert!(p.contains("You are the **safety** review lens"), "{p}");
    assert!(
        p.contains("Earlier lenses already produced 1 findings"),
        "{p}"
    );

    let found = [
        titled("High", 1, "f returns 1"),
        titled("High", 1, "unsafe read past the end"),
    ];
    let s = submit(
        &run,
        json!({"critic-lens-rust-safety": lens("safety", &found)}),
    );
    assert_eq!(
        ids(&s),
        ["critic-verify-0-v0", "critic-verify-0-v3"],
        "only the new finding, under ids the first pass did not use"
    );
    let s = submit(&run, upheld(&s));
    assert_eq!(s["verdict"], json!("Block"));
    let r = report(&s);
    for want in [
        "`src/lib.rs:1` — f returns 1 (errors)",
        "`src/lib.rs:1` — unsafe read past the end (safety)",
        "## Coverage gaps\n\nthe panic path of f is untested",
        "the completeness critic named the optional lens performance",
        "completeness critic → follow-up lenses: rust:safety",
        "2 finding(s) reported: 2 confirmed",
    ] {
        assert!(r.contains(want), "{want}: {r}");
    }
    assert!(
        !r.contains("· the completeness critic"),
        "no longer named as not run: {r}"
    );
}

#[test]
fn a_critic_that_names_nothing_ends_the_run_as_it_stood() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(ids(&to_critic(&run)), ["critic-rust"]);
    let s = submit(
        &run,
        json!({"critic-rust": {"missingLenses": [], "notes": "coverage complete"}}),
    );
    assert_eq!(s["verdict"], json!("Block"));
    assert!(!report(&s).contains("## Coverage gaps"));
}
