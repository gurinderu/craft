use serde_json::json;

use super::*;

fn plan() -> Plan {
    Plan::read(&json!({"plan_markdown": "BODY", "summary": "SUM", "ledger": []})).unwrap()
}

#[test]
fn a_clean_plan_keeps_its_body_and_gains_the_memory_line() {
    let b = Banners {
        memory: "memory: m".into(),
        ..Banners::default()
    };
    let p = bannered(plan(), &b);
    assert_eq!(p.plan_markdown, "BODY");
    assert_eq!(p.memory.as_deref(), Some("memory: m"));
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        json!({"plan_markdown": "BODY", "summary": "SUM", "ledger": [], "memory": "memory: m"})
    );
}

#[test]
fn the_lost_record_leads_then_what_did_not_run_then_the_memory() {
    let b = Banners {
        memory_degraded: vec!["memory: not read".into()],
        not_run_sources: vec!["pr".into()],
        unjudged: 2,
        lost_section: "LOST\n".into(),
        telemetry_lost: vec!["l".into()],
        prior_refused: vec!["r".into()],
        ..Banners::default()
    };
    let p = bannered(plan(), &b);
    assert_eq!(
        p.plan_markdown,
        "LOST\n> **INCOMPLETE TRIAGE** — this plan does not cover everything that was asked for:\n> - source `pr` produced nothing — its findings are NOT in this plan\n> - 2 finding(s) were never judged against the code (validator died); they sit in the ledger as needs-decision, not in the plan\n\n> **MEMORY DEGRADED** — the sift may have run without some or all of the project's records:\n> - memory: not read\n\nBODY"
    );
    assert!(
        p.summary
            .starts_with("INCOMPLETE: source `pr` produced nothing")
    );
    assert!(p.summary.ends_with("not in the plan\n\nSUM"));
    assert_eq!(p.not_run.map(|n| n.len()), Some(2));
    assert_eq!(p.telemetry_lost, Some(vec!["l".into()]));
    assert_eq!(p.prior_decisions_not_applied, Some(vec!["r".into()]));
    assert_eq!(p.rule_notices, None);
}

#[test]
fn a_dead_plan_is_named_after_the_lost_record() {
    assert_eq!(
        failed("L\n"),
        "L\nTriage failed: the Plan-phase agent returned no result. Re-run, or triage the findings manually."
    );
    assert!(matches!(
        Plan::read(&json!({"plan_markdown": 3})),
        Err(crate::TriageError::Answer { .. })
    ));
}
