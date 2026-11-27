//! The lens rounds' agent budget end to end (realm @nick/craft, node #634): a later round whose
//! tasks would take the rounds past the budget is not bought, and the run goes on to verification
//! with what it found, a ceiling the report names, never a hole.
mod common;

use common::{assert_contains_all, fixture, ids, lens, opts, scout, submit, titled, verdict};
use craft_review::step::{self, StartOptions};
use serde_json::json;

#[test]
fn a_round_over_the_budget_is_not_bought_and_the_run_verifies_what_it_found() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    common::sized(repo.path(), "medium");
    step::start(&StartOptions {
        lens_agents: Some(4),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("medium", &["errors"])}));
    assert_eq!(
        ids(&s).len(),
        3,
        "the first round, bought whatever the budget"
    );
    // Two lenses find something new: round 2 would send them, 3 + 2 over the budget of 4.
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r1": lens("errors", &[titled("High", 1, "f returns 1 where 0 is claimed")]),
            "lens-rust-intent-r1": lens("intent", &[titled("Medium", 1, "no doc")]),
            "lens-rust-tests-r1": lens("tests", &[]),
        }),
    );
    assert_eq!(
        ids(&s),
        ["dedup-rust"],
        "no round 2: straight on to the dedup"
    );
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    assert_eq!(
        (
            &state["rounds"]["round"],
            &state["rounds"]["sent"],
            &state["rounds"]["first"],
            &state["rounds"]["auto"]
        ),
        (&json!(1), &json!(3), &json!(3), &json!(6)),
        "the round not bought is not counted: a coordinator stamps what it finds with the last round run"
    );
    let s = submit(&run, json!({"dedup-rust": {"groups": []}}));
    let mut answers = serde_json::Map::new();
    for id in ids(&s) {
        let a = if id.starts_with("verify-batch") {
            json!({"verdicts": [{"index": 0, "refuted": true, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "behaviourIntended": false, "harmSupported": false, "confirmedHarmLevel": "none", "reason": "documented"}]})
        } else {
            verdict(false)
        };
        answers.insert(id, a);
    }
    let s = submit(&run, serde_json::Value::Object(answers));
    assert_eq!(s["done"], json!(true), "{:?}", ids(&s));
    assert_eq!(
        s["verdict"],
        json!("Block"),
        "a ceiling, not a hole: no INCOMPLETE"
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "lens round 2 not bought: its 2 task(s) would bring the lens rounds to 5 agent(s), over the budget of 4 (the launcher's --lens-agents); not run in it: rust:errors, rust:intent; what the rounds found went on to verification",
            "- Round 1: 3 lens(es) dispatched, 3 returned, 2 new finding(s).",
        ],
    );
    assert!(!report.contains("- Round 2:"), "{report}");
}

/// A lens a later round never sends — design, a lens its profile limits to one round — spends the
/// budget in the first round but makes none of the default's base (realm @nick/craft, node #634).
#[test]
fn a_lens_run_once_spends_the_budget_but_makes_none_of_its_default_base() {
    let repo = fixture(true);
    std::fs::write(repo.path().join("src/more.rs"), "pub fn g() {}\n").unwrap();
    common::git(repo.path(), &["add", "."]);
    common::git(repo.path(), &["commit", "-qm", "feat: add g"]);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    common::sized(repo.path(), "medium");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("medium", &["errors"])}));
    let sent = ids(&s);
    let once = |id: &&String| {
        ["design", "maintainability", "performance", "complexity"]
            .iter()
            .any(|l| id.starts_with(&format!("lens-rust-{l}-")))
    };
    assert!(
        sent.iter().any(|id| id == "lens-rust-design-r1"),
        "{sent:?}"
    );
    let base = sent.len() - sent.iter().filter(once).count();
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    assert_eq!(
        (
            &state["rounds"]["sent"],
            &state["rounds"]["first"],
            &state["rounds"]["auto"]
        ),
        (&json!(sent.len()), &json!(base), &json!(sent.len() + base)),
        "{sent:?}"
    );
}
