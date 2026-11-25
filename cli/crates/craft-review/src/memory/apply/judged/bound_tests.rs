//! Past the match judge's bound, a High a human's decision answers is among the pairs a record can
//! set aside, by the same test as `pair_rank` (realm @nick/craft, nodes #196, #602): it is judged
//! before the Medium pairs, not cut and raised by the title rule.

use serde_json::{Value, json};

use super::super::super::matching::Plan;
use super::super::super::{PriorDecision, RecordKind};
use super::{Asked, PAIRS_MAX};

fn finding(i: usize, file: &str, severity: &str) -> Value {
    json!({"severity": severity, "title": format!("finding {i} nothing guards removal"), "file": file, "line": 100 + i, "tier": "confirmed", "why": "w"})
}

fn record(id: &str, scope: &str, decided_by: &str) -> PriorDecision {
    PriorDecision {
        id: id.into(),
        kind: RecordKind::Decision,
        title: "nothing guards deletion of a referenced group".into(),
        scope: scope.into(),
        reason: "r".into(),
        decided_by: decided_by.into(),
        ..PriorDecision::default()
    }
}

/// The pairs asked of `PAIRS_MAX + 2` Medium findings, each disputed with record 0, and one High,
/// disputed with record 1 decided by `decided_by`; the High is the last finding.
fn asked(decided_by: &str) -> (Vec<(usize, usize)>, usize) {
    let mut findings: Vec<Value> = (0..PAIRS_MAX + 2)
        .map(|i| finding(i, "src/g.rs", "Medium"))
        .collect();
    findings.push(finding(0, "src/h.rs", "High"));
    let ds = [
        record("decision-g", "src/g.rs", "agent"),
        record("decision-h", "src/h.rs", decided_by),
    ];
    let plans: Vec<Plan> = (0..findings.len())
        .map(|fi| Plan {
            sure: None,
            disputed: vec![usize::from(fi == PAIRS_MAX + 2)],
        })
        .collect();
    let a = Asked::new(&findings, &ds, &plans, &|_, _| false, &[]);
    (a.pairs, PAIRS_MAX + 2)
}

#[test]
fn past_the_bound_a_high_a_human_decided_is_judged_ahead_of_the_medium_pairs() {
    let (pairs, high) = asked("human");
    assert_eq!(pairs.len(), PAIRS_MAX);
    assert!(pairs.contains(&(high, 1)), "{pairs:?}");
}

#[test]
fn past_the_bound_a_high_no_human_decided_goes_after_the_pairs_a_record_can_set_aside() {
    let (pairs, high) = asked("agent");
    assert_eq!(pairs.len(), PAIRS_MAX);
    assert!(!pairs.contains(&(high, 1)), "{pairs:?}");
}

/// The refusal naming the pairs past the bound when `focus` names the reviewed paths, or none.
fn cut_refusal(focus: &[String]) -> String {
    let findings: Vec<Value> = (0..=PAIRS_MAX)
        .map(|i| finding(i, "src/g.rs", "Medium"))
        .collect();
    let ds = [record("decision-g", "src/g.rs", "agent")];
    let plans: Vec<Plan> = (0..findings.len())
        .map(|_| Plan {
            sure: None,
            disputed: vec![0],
        })
        .collect();
    let a = Asked::new(&findings, &ds, &plans, &|_, _| false, focus);
    let m = super::matched(&findings, &ds, &plans, &a, None);
    m.refused
        .into_iter()
        .find(|r| r.contains("past the judge's bound"))
        .unwrap()
}

#[test]
fn past_the_bound_a_run_given_no_reviewed_paths_says_so_and_one_given_them_names_them() {
    let pathless = cut_refusal(&[]);
    assert!(
        pathless.contains("not judged — no reviewed paths are given here, so judged first were the pairs whose record"),
        "{pathless}"
    );
    let paths = cut_refusal(&["src/g.rs".to_owned()]);
    assert!(
        paths.contains("not judged — judged first were the findings on the reviewed paths and the priors re-adjudicated"),
        "{paths}"
    );
}
