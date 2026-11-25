//! Past the rule judge's bound a High is judged with the findings a rule can cover (realm
//! @nick/craft, node #273): only a Critical, raised whatever the verdict, goes after them.

use serde_json::{Value, json};

use super::{Pairs, SENT_MAX, apply};
use crate::memory::{PriorDecision, RecordKind};

fn finding(file: &str, severity: &str) -> Value {
    json!({"severity": severity, "title": format!("defect in {file}"), "file": file, "line": 25, "tier": "confirmed", "why": "w"})
}

#[test]
fn past_the_bound_a_high_is_judged_with_the_lows_and_a_critical_goes_last() {
    let mut findings: Vec<Value> = (0..SENT_MAX)
        .map(|i| finding(&format!("o{i}.rs"), "Low"))
        .collect();
    findings.push(finding("c.rs", "Critical"));
    findings.push(finding("h.rs", "High"));
    let rule = PriorDecision {
        id: "rule-a".into(),
        kind: RecordKind::Rule,
        title: "clones are fine".into(),
        scope: ".".into(),
        reason: "r".into(),
        ..PriorDecision::default()
    };
    let p = Pairs::new(&findings, &[rule], &[]);
    let sent: Vec<usize> = p.pairs().iter().take(SENT_MAX).map(|&(fi, _)| fi).collect();
    assert!(sent.contains(&(SENT_MAX + 1)), "the High is judged");
    assert!(!sent.contains(&SENT_MAX), "the Critical is cut");
}

#[test]
fn a_critical_read_through_javascripts_trim_is_raised_under_a_covering_rule() {
    let findings: Vec<Value> = ["\u{feff}Critical", " critical ", "\u{85}Critical"]
        .iter()
        .enumerate()
        .map(|(i, s)| finding(&format!("c{i}.rs"), s))
        .collect();
    let rule = PriorDecision {
        id: "rule-a".into(),
        kind: RecordKind::Rule,
        title: "defects are fine".into(),
        scope: ".".into(),
        reason: "r".into(),
        ..PriorDecision::default()
    };
    let p = Pairs::new(&findings, &[rule], &[]);
    let verdicts: Vec<Value> = (0..p.pairs().len())
        .map(|i| json!({"pair": i, "covered": true, "violates": false, "why": "y"}))
        .collect();
    let out = apply(
        findings,
        &p,
        &[Some(json!({ "verdicts": verdicts }))],
        "why",
    );
    let severities = |list: &[Value]| -> Vec<String> {
        list.iter()
            .map(|f| f["severity"].as_str().unwrap().to_owned())
            .collect()
    };
    let mut raised = severities(&out.kept);
    raised.sort();
    assert_eq!(raised, [" critical ", "\u{feff}Critical"]);
    assert_eq!(severities(&out.covered), ["\u{85}Critical"]);
}
