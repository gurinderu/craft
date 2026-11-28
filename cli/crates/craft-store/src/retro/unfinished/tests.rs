use super::*;
use crate::filter::Filter;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

const REVIEW: &str = r#""name":"review","project":"/p","branch":"b","head":"abcdef1234""#;

#[test]
fn a_stamp_reads_only_as_a_real_time() {
    assert_eq!(store_ts_ms(&"1970-01-01T00-00-01Z".into()), Some(1000.0));
    for bad in [
        "2026-02-30T00-00-00Z",
        "2026-01-01T24-00-00Z",
        "2026-01-01T00:00:00Z",
        "2026-13-01T00-00-00Z",
    ] {
        assert_eq!(store_ts_ms(&bad.into()), None, "{bad}");
    }
    assert!(store_ts_ms(&"2024-02-29T00-00-00Z".into()).is_some());
}

#[test]
fn a_rebuilt_record_is_hidden_once_its_run_files_a_complete_record_that_folded_its_checkpoints() {
    let mut u = Unfinished::default();
    let phases = r#""phases":[{"phase":"scout","at":"2026-01-01T00:30:00Z"},{"phase":"x","at":"y","ledgerShard":1}]"#;
    u.partial(
        &rec(&format!(
            r#"{{{REVIEW},"ts":"2026-01-01T00-20-00Z",{phases}}}"#
        )),
        Some(true),
    );
    u.partial(
        &rec(&format!(
            r#"{{{REVIEW},"ts":"2026-01-01T00-20-00Z","phases":[{{"phase":"other","at":"z"}}]}}"#
        )),
        Some(true),
    );
    u.partial(
        &rec(&format!(r#"{{{REVIEW},"ts":"2026-01-01T00-40-00Z"}}"#)),
        None,
    );
    u.partial(
        &rec(&format!(r#"{{{REVIEW},"ts":"2026-01-01T00-10-00Z"}}"#)),
        Some(false),
    );
    u.complete(
        &rec(&format!(
            r#"{{{REVIEW},"head":"abcdef1","ts":"2026-01-01T01-00-00Z",{phases}}}"#
        )),
        Some(true),
    );
    u.complete(
        &rec(r#"{"name":"rust-audit","ts":"2026-01-01T01-00-00Z"}"#),
        Some(true),
    );
    let (listed, unattributed, twins) = u.clone().settle(true);
    assert_eq!((listed.len(), unattributed, twins), (2, 0, 2));
    let (listed, unattributed, twins) = u.settle(false);
    assert_eq!(
        (listed.len(), unattributed, twins),
        (1, 0, 2),
        "the journal one ran through the run's start"
    );
}

#[test]
fn a_record_without_a_version_is_unattributed_to_a_version_slice_and_its_checkpoints_name_one() {
    let filter = Filter {
        version: Some("1.0".into()),
        ..Filter::default()
    };
    let s = slice::Slice {
        filter: &filter,
        engine: None,
    };
    assert_eq!(slice::inside(&rec(r#"{"name":"review"}"#), &s), None);
    let from_phases = rec(r#"{"phases":[{"craftVersion":"1.0"},{"craftVersion":"1.0"}]}"#);
    assert_eq!(slice::inside(&from_phases, &s), Some(true));
    let torn = rec(r#"{"phases":[{"craftVersion":"1.0"},{"craftVersion":"2.0"}]}"#);
    assert_eq!(slice::inside(&torn, &s), None);
    assert_eq!(
        slice::inside(&rec(r#"{"craftVersion":"2.0"}"#), &s),
        Some(false)
    );
    let whole = Filter::default();
    assert!(
        slice::Slice {
            filter: &whole,
            engine: None
        }
        .is_whole()
    );
}

#[test]
fn an_engine_slice_reads_the_runs_own_revision_before_the_recovering_crafts() {
    let whole = Filter::default();
    let s = |e| slice::Slice {
        filter: &whole,
        engine: Some(e),
    };
    let r = rec(
        r#"{"runtime":"claude-code","engineRevision":9,"phases":[{"engineRevision":4,"craftVersion":"1.0"}]}"#,
    );
    assert_eq!(slice::inside(&r, &s("claude-code 1.0 r4")), Some(true));
    assert_eq!(slice::inside(&r, &s("claude-code 1.0 r9")), Some(false));
    assert_eq!(slice::inside(&r, &s("claude-code 2.0 r4")), Some(false));
    let unversioned = rec(r#"{"runtime":"claude-code","runEngineRevision":4}"#);
    assert_eq!(slice::inside(&unversioned, &s("claude-code 1.0 r4")), None);
    assert_eq!(
        slice::inside(&unversioned, &s("claude-code unversioned r4")),
        Some(true)
    );
    assert_eq!(
        slice::engine_parts("claude-code 1.0 r?"),
        Some(("claude-code", Some("1.0"), None))
    );
    assert_eq!(slice::engine_parts("claude-code 1.0 r4x"), None);
    assert_eq!(slice::engine_parts("claude-code"), None);
}

#[test]
fn a_leap_day_reads_only_in_a_leap_year_and_each_part_has_its_bound() {
    let ok = |t: &str| store_ts_ms(&t.into()).is_some();
    assert!(ok("2000-02-29T23-59-59Z") && ok("2024-02-29T00-00-00Z"));
    assert!(!ok("1900-02-29T00-00-00Z") && !ok("2023-02-29T00-00-00Z"));
    assert!(!ok("2026-01-00T00-00-00Z") && !ok("2026-04-31T00-00-00Z"));
    assert!(!ok("2026-01-01T00-60-00Z") && !ok("2026-01-01T00-00-60Z"));
    assert!(ok("2026-12-31T23-59-59Z"));
}

#[test]
fn a_finished_form_is_one_review_of_the_same_branch_at_the_same_head_filed_later() {
    let phases = r#""phases":[{"phase":"scout","at":"2026-01-01T00:30:00Z"}]"#;
    let partial = |more: &str| {
        rec(&format!(
            r#"{{{REVIEW},"ts":"2026-01-01T00-20-00Z",{phases}{more}}}"#
        ))
    };
    let hidden = |p: &Obj, c: &str| {
        let mut u = Unfinished::default();
        u.partial(p, Some(true));
        u.complete(&rec(c), Some(true));
        u.settle(true).2 == 1
    };
    let complete =
        |more: &str| format!(r#"{{{REVIEW},"ts":"2026-01-01T01-00-00Z",{phases}{more}}}"#);
    assert!(hidden(&partial(""), &complete("")));
    assert!(
        !hidden(&partial(r#","head":"abc""#), &complete(r#","head":"abc""#)),
        "a short head is no identity"
    );
    assert!(!hidden(&partial(""), &complete(r#","head":"abcdef9999""#)));
    assert!(
        !hidden(&partial(""), &complete(r#","driver":"cli""#)),
        "another chain"
    );
    assert!(!hidden(&partial(""), &complete(r#","project":"/q""#)));
    assert!(
        !hidden(&partial(r#","branch":"""#), &complete(r#","branch":"""#)),
        "no branch, no identity"
    );
    assert!(!hidden(&partial(""), &complete(r#","branch":"c""#)));
    assert!(!hidden(&partial(r#","name":"rust-audit""#), &complete("")));
    assert!(
        !hidden(&partial(""), &complete(r#","ts":"2026-01-01T00-20-00Z""#)),
        "filed at the same time is not later"
    );
    assert!(!hidden(&partial(""), &complete(r#","phases":[]"#)));
    assert!(!hidden(
        &partial(r#","phases":[{"phase":"lens","at":"x"}]"#),
        &complete("")
    ));
    let journal = rec(&format!(r#"{{{REVIEW},"ts":"2026-01-01T00-30-00Z"}}"#));
    assert!(
        !hidden(&journal, &complete("")),
        "a run that started as it was rebuilt was not yet going"
    );
}

#[test]
fn a_revision_is_a_whole_number_and_a_runtime_absent_is_unknown() {
    let whole = Filter::default();
    let s = |e| slice::Slice {
        filter: &whole,
        engine: Some(e),
    };
    let r = rec(
        r#"{"runtimeEngineRevision":1,"runEngineRevision":4.5,"engineRevision":4,"craftVersion":"1.0","runtime":""}"#,
    );
    assert_eq!(slice::inside(&r, &s("unknown-runtime 1.0 r4")), Some(true));
    assert_eq!(slice::engine_parts("a b"), None);
    assert_eq!(slice::engine_parts("a b r1.5"), None);
}

#[test]
fn a_records_part_is_no_evidence_and_a_null_shard_is_its_own_checkpoint() {
    let hidden = |own: &str, folded: &str| {
        let mut u = Unfinished::default();
        u.partial(
            &rec(&format!(
                r#"{{{REVIEW},"ts":"2026-01-01T00-20-00Z","phases":[{own}]}}"#
            )),
            Some(true),
        );
        u.complete(
            &rec(&format!(
                r#"{{{REVIEW},"ts":"2026-01-01T01-00-00Z","phases":[{folded}]}}"#
            )),
            Some(true),
        );
        u.settle(true).2 == 1
    };
    let scout = r#"{"phase":"scout","at":"a"}"#;
    assert!(hidden(
        &format!(r#"{scout},{{"phase":"p","at":"b","recordPart":1}}"#),
        scout
    ));
    assert!(!hidden(
        &format!(r#"{scout},{{"phase":"p","at":"b","ledgerShard":null}}"#),
        scout
    ));
    assert!(
        !hidden(r#"{"phase":"p","at":"b","recordPart":1}"#, scout),
        "nothing else to match on"
    );
}
