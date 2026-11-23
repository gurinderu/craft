use super::*;

fn finding(severity: &str) -> Finding {
    Finding(Obj::new().with("severity", severity))
}

fn text(v: &Json) -> String {
    serde_json::to_string(v).unwrap()
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
        text(&s),
        r#"{"total":3,"bySeverity":{"Critical":0,"High":2,"Medium":0,"Low":0,"Info":1}}"#
    );
}

#[test]
fn verdicts_are_tallied_in_order_and_an_unknown_one_left_out() {
    let ledger: Json = serde_json::from_str(r#"[{"verdict":"accept"},{"verdict":"conflict"},{"verdict":"maybe"},null,{"verdict":"accept"}]"#).unwrap();
    let t = tally(ledger.as_array().unwrap());
    assert_eq!(
        text(&Json::Object(t)),
        r#"{"accept":2,"reject":0,"defer":0,"needs-decision":0,"conflict":1}"#
    );
}

#[test]
fn the_record_is_written_in_the_engines_order_naming_what_did_not_run_as_bare_labels() {
    let gathered = [Gathered {
        source: "review".into(),
        findings: vec![finding("Low")],
    }];
    let raw: Vec<Finding> = gathered[0].sourced().collect();
    let r = run_record(&RecordInput {
        craft_version: "1.2.3",
        gathered: &gathered,
        raw: &raw,
        validated: 1,
        not_run_sources: &["pr".into()],
        unjudged: 1,
        repeats: 2,
        ..RecordInput::default()
    });
    assert_eq!(
        text(&r),
        r#"{"schemaVersion":1,"runtime":"claude-code","craftVersion":"1.2.3","kind":"workflow","name":"triage-findings","verdict":"","findings":{"total":1,"bySeverity":{"Critical":0,"High":0,"Medium":0,"Low":1,"Info":0}},"nested":false,"via":null,"sources":[{"source":"review","count":1}],"triage":{"gathered":1,"validated":1,"accept":0,"reject":0,"defer":0,"needs-decision":0,"conflict":0,"sifted":{"repeats":2,"rejectedBefore":0,"deferred":0,"covered":0,"conflict":0,"reraised":0},"issues":0},"memory":null,"notRun":["gather:pr","findings-unjudged"]}"#
    );
}
