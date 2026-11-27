//! Two gate tool lenses are one lens for an outright match when the tool rule is the same
//! (realm @nick/craft, node #718): the memory writes `tool`, the gate prints the tool's name.

use serde_json::{Value, json};

use super::{plan, tried_order};
use crate::memory::PriorDecision;

fn record(lens: &str, rule: &str) -> PriorDecision {
    PriorDecision {
        id: "decision-c540c47bcf".into(),
        title: "pub(crate) function inside private module".into(),
        scope: "src/deferral.rs".into(),
        reason: "r".into(),
        line: 20,
        lens: lens.into(),
        tool_rule: rule.into(),
        ..PriorDecision::default()
    }
}

fn finding(lens: &str, rule: &str) -> Value {
    json!({"title": "pub(crate) function inside private module", "file": "src/deferral.rs", "line": 20,
        "lens": lens, "toolRule": rule, "severity": "Low"})
}

/// The outright match's `how`, and how many candidates went to the judge.
fn outcome(f: &Value, d: PriorDecision) -> (Option<String>, usize) {
    let ds = [d];
    let p = plan(f, &ds, &tried_order(&ds));
    (p.sure.map(|m| m.how), p.disputed.len())
}

#[test]
fn a_tool_record_meets_another_tool_lens_of_the_same_rule_outright() {
    let rule = "clippy::redundant_pub_crate";
    assert_eq!(
        outcome(&finding("clippy-pedantic", rule), record("tool", rule)),
        (Some("matched by file:line+lens+toolRule".into()), 0)
    );
    assert_eq!(
        outcome(
            &finding("tool", "redundant_pub_crate"),
            record("clippy", rule)
        )
        .0,
        Some("matched by file:line+lens+toolRule".into()),
        "the rule compares without its tool prefix"
    );
}

#[test]
fn another_rule_or_a_review_lens_keeps_its_old_path() {
    let rule = "clippy::redundant_pub_crate";
    assert_eq!(
        outcome(
            &finding("clippy-pedantic", "clippy::needless_borrow"),
            record("tool", rule)
        ),
        (None, 0),
        "another rule is another finding"
    );
    assert_eq!(
        outcome(
            &finding("clippy-pedantic", rule),
            record("correctness", rule)
        ),
        (None, 1),
        "a review lens's record goes to the judge"
    );
    assert_eq!(
        outcome(&finding("clippy-pedantic", rule), record("", rule)),
        (None, 1),
        "a record with no lens goes to the judge"
    );
}
