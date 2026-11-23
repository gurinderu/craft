use super::*;

fn plan(text: &str) -> Plan {
    Plan::read(&serde_json::from_str(text).unwrap()).unwrap()
}

fn text(p: Plan) -> String {
    serde_json::to_string(&Json::Object(p.0)).unwrap()
}

const BODY: &str = r#"{"summary":"SUM","plan_markdown":"BODY","ledger":[]}"#;

#[test]
fn a_clean_plan_keeps_its_body_and_its_order_and_gains_the_memory_line() {
    let b = Banners {
        memory: "memory: m".into(),
        ..Banners::default()
    };
    assert_eq!(
        text(bannered(plan(BODY), &b)),
        r#"{"summary":"SUM","plan_markdown":"BODY","ledger":[],"memory":"memory: m"}"#
    );
}

#[test]
fn the_lost_record_leads_then_what_did_not_run_then_the_memory_each_field_in_the_engines_order() {
    let b = Banners {
        memory_degraded: vec!["memory: not read".into()],
        not_run_sources: vec!["pr".into()],
        unjudged: 2,
        lost_section: "LOST\n".into(),
        telemetry_lost: vec!["l".into()],
        memory: "m".into(),
        prior_refused: vec!["r".into()],
        rule_notices: vec!["n".into()],
        issues: vec![Json::from("i")],
    };
    let p = bannered(plan(BODY), &b);
    assert_eq!(
        p.0.text("plan_markdown"),
        "LOST\n> **INCOMPLETE TRIAGE** — this plan does not cover everything that was asked for:\n> - source `pr` produced nothing — its findings are NOT in this plan\n> - 2 finding(s) were never judged against the code (validator died); they sit in the ledger as needs-decision, not in the plan\n\n> **MEMORY DEGRADED** — the sift may have run without some or all of the project's records:\n> - memory: not read\n\nBODY"
    );
    assert!(
        p.0.text("summary")
            .starts_with("INCOMPLETE: source `pr` produced nothing")
    );
    assert!(p.0.text("summary").ends_with("not in the plan\n\nSUM"));
    let order = text(bannered(plan(BODY), &b));
    let at = |k: &str| order.find(&format!("\"{k}\":")).unwrap();
    let wanted = [
        "summary",
        "plan_markdown",
        "ledger",
        "memoryDegraded",
        "notRun",
        "telemetryLost",
        "memory",
        "priorDecisionsNotApplied",
        "ruleNotices",
        "issues",
    ];
    let places: Vec<usize> = wanted.iter().map(|k| at(k)).collect();
    assert!(places.is_sorted(), "{order}");
}

#[test]
fn a_dead_plan_is_named_after_the_lost_record() {
    assert_eq!(
        failed("L\n"),
        "L\nTriage failed: the Plan-phase agent returned no result. Re-run, or triage the findings manually."
    );
}

#[test]
fn a_plan_missing_what_the_schema_requires_is_refused_one_with_any_ledger_read() {
    for bad in [
        r#"{"plan_markdown":3,"summary":"","ledger":[]}"#,
        r#"{"plan_markdown":"","ledger":[]}"#,
        r#"{"plan_markdown":"","summary":""}"#,
        "[]",
    ] {
        let answer = serde_json::from_str(bad).unwrap();
        assert!(
            matches!(Plan::read(&answer), Err(TriageError::Answer { .. })),
            "{bad}"
        );
    }
    assert_eq!(
        plan(r#"{"plan_markdown":"","summary":"","ledger":"oops"}"#).rows(),
        None
    );
}
