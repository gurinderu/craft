use super::*;

fn finding(severity: &str) -> Finding {
    Finding {
        severity: severity.into(),
        ..Finding::default()
    }
}

#[test]
fn findings_are_counted_by_their_exact_severity() {
    let s = summarize(&[
        finding("High"),
        finding("High"),
        finding("low"),
        finding("Info"),
    ]);
    assert_eq!(s["total"], 3);
    assert_eq!(s["bySeverity"]["High"], 2);
    assert_eq!(s["bySeverity"]["Low"], 0);
}

#[test]
fn verdicts_are_tallied_and_an_unknown_one_left_out() {
    let row = |v: &str| LedgerEntry {
        verdict: v.into(),
        ..LedgerEntry::default()
    };
    let t = tally(&[row("accept"), row("conflict"), row("maybe"), row("accept")]);
    assert_eq!(t["accept"], 2);
    assert_eq!(t["conflict"], 1);
    assert_eq!(t.len(), 5);
}

#[test]
fn the_record_names_what_did_not_run_as_bare_labels() {
    let gathered = [Gathered {
        source: "review".into(),
        findings: vec![finding("Low")],
    }];
    let raw = gathered[0].sourced();
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
    assert_eq!(r["notRun"], json!(["gather:pr", "findings-unjudged"]));
    assert_eq!(r["sources"], json!([{"source": "review", "count": 1}]));
    assert_eq!(r["triage"]["sifted"], json!({"repeats": 2}));
    assert_eq!(r["triage"]["gathered"], 1);
    assert_eq!(r["craftVersion"], "1.2.3");
    assert_eq!(r["memory"], Value::Null);
}
