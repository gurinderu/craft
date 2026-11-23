use craft_store::js::parse;

use super::*;

fn finding(severity: &str) -> Finding {
    Finding(Obj::new().with("severity", Js::str(severity)))
}

#[test]
fn findings_are_counted_by_their_exact_severity() {
    let s = summarize(&[
        finding("High"),
        finding("High"),
        finding("low"),
        finding("Info"),
    ]);
    assert_eq!(
        s.compact(),
        r#"{"total":3,"bySeverity":{"Critical":0,"High":2,"Medium":0,"Low":0,"Info":1}}"#
    );
}

#[test]
fn verdicts_are_tallied_in_order_and_an_unknown_one_left_out() {
    let ledger = parse(r#"[{"verdict":"accept"},{"verdict":"conflict"},{"verdict":"maybe"},null,{"verdict":"accept"}]"#).unwrap();
    let t = tally(ledger.as_arr().unwrap());
    assert_eq!(
        Js::Obj(t).compact(),
        r#"{"accept":2,"reject":0,"defer":0,"needs-decision":0,"conflict":1}"#
    );
}

#[test]
fn the_record_is_written_in_the_engines_order_each_count_under_its_own_key() {
    let gathered = [Gathered {
        source: "review".into(),
        findings: vec![finding("Low")],
    }];
    let raw: Vec<Finding> = gathered[0].sourced().collect();
    let sift_counts = SiftCounts {
        rejected_before: 3,
        deferred: 4,
        covered: 5,
        conflict: 6,
        reraised: 7,
    };
    let r = run_record(&RecordInput {
        craft_version: "1.2.3",
        gathered: &gathered,
        raw: &raw,
        validated: 1,
        not_run_sources: &["pr".into()],
        unjudged: 1,
        repeats: 2,
        sift_counts,
        issues: 8,
        memory: parse(r#"{"source":"none","count":0}"#).unwrap(),
        ledger: &[],
    });
    assert_eq!(
        r.compact(),
        r#"{"schemaVersion":1,"runtime":"claude-code","craftVersion":"1.2.3","kind":"workflow","name":"triage-findings","verdict":"","findings":{"total":1,"bySeverity":{"Critical":0,"High":0,"Medium":0,"Low":1,"Info":0}},"nested":false,"via":null,"sources":[{"source":"review","count":1}],"triage":{"gathered":1,"validated":1,"accept":0,"reject":0,"defer":0,"needs-decision":0,"conflict":0,"sifted":{"repeats":2,"rejectedBefore":3,"deferred":4,"covered":5,"conflict":6,"reraised":7},"issues":8},"memory":{"source":"none","count":0},"notRun":["gather:pr","findings-unjudged"]}"#
    );
}
