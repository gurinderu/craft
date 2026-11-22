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
use craft_review::step::{self, Said};
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
        p.contains(r#"choose ONLY from: ["money","maintainability","design","sql-queries""#),
        "{p}"
    );

    let s = submit(
        &run,
        json!({"critic-rust": {"missingLenses": ["maintainability", "api-idioms"], "notes": "the panic path of f is untested"}}),
    );
    assert_eq!(ids(&s), ["critic-lens-rust-maintainability"]);
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("You are the **maintainability** review lens"),
        "{p}"
    );
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
        json!({"critic-lens-rust-maintainability": lens("maintainability", &found)}),
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
        "`src/lib.rs:1` — unsafe read past the end (maintainability)",
        "## Coverage gaps\n\nthe panic path of f is untested",
        "the completeness critic named the optional lens api-idioms",
        "completeness critic → follow-up lenses: rust:maintainability",
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
fn a_follow_up_lens_that_read_no_rubric_file_whole_is_named_as_degraded() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    to_critic(&run);
    let s = submit(
        &run,
        json!({"critic-rust": {"missingLenses": ["maintainability"], "notes": "n"}}),
    );
    let mut silent = lens("maintainability", &[]);
    silent.as_object_mut().unwrap().remove("rubricRead");
    let s = submit(&run, json!({"critic-lens-rust-maintainability": silent}));
    assert_eq!(s["verdict"], json!("Block"), "the verdict stands: {s}");
    let degraded = s["degraded"].to_string();
    assert!(
        degraded.contains("1 lens task(s) named no rubric file they read whole")
            && degraded.contains("maintainability"),
        "{s}"
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

#[test]
fn a_limit_stop_in_the_critics_verification_keeps_the_first_passs_findings() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    to_critic(&run);
    submit(
        &run,
        json!({"critic-rust": {"missingLenses": ["maintainability"], "notes": "n"}}),
    );
    let found = [titled("High", 2, "unsafe read past the end")];
    let s = submit(
        &run,
        json!({"critic-lens-rust-maintainability": lens("maintainability", &found)}),
    );
    assert_eq!(ids(&s), ["critic-verify-0-v0", "critic-verify-0-v3"]);
    let said = Said {
        limit: Some("You've hit your limit"),
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &said).unwrap();
    assert_eq!(s["stopped"]["cause"], json!("limit"), "{s}");
    assert_eq!(s["verdict"], json!("Block (INCOMPLETE)"), "{s}");
    let r = report(&s);
    let (_, confirmed) = r.split_once("## Confirmed findings").unwrap();
    let confirmed = confirmed.split("\n## ").next().unwrap_or_default();
    assert!(confirmed.contains("f returns 1"), "{r}");
    assert!(r.contains("unsafe read past the end"), "{r}");
}
