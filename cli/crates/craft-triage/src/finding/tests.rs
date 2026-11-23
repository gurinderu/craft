use serde_json::json;

use super::*;

fn at(source: &str, location: &str, title: &str) -> Finding {
    Finding {
        source: source.into(),
        location: location.into(),
        title: title.into(),
        ..Finding::default()
    }
}

#[test]
fn a_report_source_is_a_known_engine_trimmed_else_report() {
    assert_eq!(report_source(Some(" rust-audit ")), "rust-audit");
    assert_eq!(report_source(Some("weird")), "report");
    assert_eq!(report_source(Some("")), "report");
    assert_eq!(report_source(None), "report");
}

#[test]
fn the_id_is_source_location_title_with_no_loc_for_none() {
    assert_eq!(
        id_of(&at("review", "src/a.rs:1", "t")),
        "review::src/a.rs:1::t"
    );
    assert_eq!(id_of(&at("review", "", "t")), "review::no-loc::t");
}

#[test]
fn a_location_names_its_file_and_line() {
    let parts = |s: &str| location_parts(s);
    assert_eq!(parts("src/a.rs:10"), ("src/a.rs".into(), 10));
    assert_eq!(parts(" src/a.rs:10:4 "), ("src/a.rs".into(), 10));
    assert_eq!(parts("src/a.rs:10-12"), ("src/a.rs".into(), 10));
    assert_eq!(parts("src/a.rs"), ("src/a.rs".into(), 0));
    assert_eq!(parts("PR-level"), (String::new(), 0));
    assert_eq!(parts("crate/module"), ("crate/module".into(), 0));
    assert_eq!(parts(""), (String::new(), 0));
    assert_eq!(parts("two words.rs:3"), (String::new(), 0));
}

#[test]
fn severities_rank_critical_first_and_unknown_last() {
    assert_eq!(severity_rank("Critical"), 0);
    assert_eq!(severity_rank(" low "), 3);
    assert_eq!(severity_rank("INFO"), 4);
    assert_eq!(severity_rank("bad"), 5);
}

#[test]
fn a_gathered_answer_is_read_with_its_source_on_each_finding() {
    let answer = json!({"source": " review ", "findings": [{"title": "t", "severity": "Low"}]});
    let g = Gathered::read(&answer, true).unwrap();
    assert_eq!(g.source, "review");
    assert_eq!(g.sourced()[0].source, "review");
    assert_eq!(Gathered::read(&answer, false).unwrap().source, " review ");
    assert!(matches!(
        Gathered::read(&json!({"findings": "x"}), true),
        Err(TriageError::Answer { .. })
    ));
}
