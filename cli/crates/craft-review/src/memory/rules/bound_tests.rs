//! Past the rule judge's bound a High is judged with the findings a rule can cover (realm
//! @nick/craft, node #273): only a Critical, raised whatever the verdict, goes after them.

use serde_json::{Value, json};

use super::{Pairs, SENT_MAX};
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
