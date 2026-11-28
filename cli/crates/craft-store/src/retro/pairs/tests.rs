use super::*;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

fn round(n: u8, ts: &str, more: &str) -> Obj {
    let cost = format!(
        r#"{{"total":{0},"cacheRead":{0},"rule":"per-message","source":"wf_{n}","agents":2}}"#,
        100 * u32::from(n)
    );
    rec(&format!(
        r#"{{"schemaVersion":1,"kind":"workflow","name":"review","engineRevision":4,"project":"/p","branch":"b","round":{n},"ts":"{ts}","head":"h","base":"main","filesDigest":"f","dirty":false,"notRun":[],"gate":{{"status":"pass"}},"verification":{{"candidates":{n}}},"verdict":"Approve","lensScope":"full","intentDigest":"i","specDigest":"s","reReview":{{"chained":true,"ledgerDegraded":false,"journalSourced":false,"priorRound":{prior},"priorHead":"h"}},"cost":{cost}{more}}}"#,
        prior = n.saturating_sub(1)
    ))
}

#[test]
fn a_round_pairs_with_the_newest_earlier_round_before_it_and_only_a_clean_pair_has_a_delta() {
    let rounds = [
        round(1, "2026-01-01T00-00-00Z", ""),
        round(1, "2026-01-01T00-30-00Z", ""),
        round(2, "2026-01-01T01-30-00Z", ""),
        round(3, "2026-01-01T02-00-00Z", r#","dirty":true"#),
        round(2, "2026-01-01T00-10-00Z", r#","driver":"cli""#),
    ];
    let got = pairs(&rounds);
    let statuses: Vec<_> = got
        .iter()
        .map(|p| (p.from.round, p.to.round, p.status))
        .collect();
    assert_eq!(statuses, [(1.0, 2.0, "clean"), (2.0, 3.0, "dirty-tree")]);
    let d = got[0].delta().unwrap();
    assert_eq!(d.by[0], 100.0);
    assert_eq!((d.ratio, d.minutes, d.by[7]), (2.0, Some(60.0), 1.0));
    assert_eq!(got[1].delta(), None);
}

#[test]
fn each_confound_is_named_in_order() {
    let a = round(1, "1", "");
    let cases = [
        (r#","engineRevision":null"#, "engine-unknown"),
        (r#","craftVersion":"2""#, "engine-changed"),
        (
            r#","reReview":{"priorRound":1,"priorHead":"x"}"#,
            "prior-unconfirmed",
        ),
        (r#","base":"other""#, "diff-moved"),
        (r#","dirty":null"#, "dirty-tree"),
        (r#","verdict":"Approve (PARTIAL COVERAGE)""#, "incomplete"),
        (r#","notRun":["x"]"#, "incomplete"),
        (r#","lensScope":"delta""#, "scope-not-full"),
        (r#","specDigest":1"#, "config-unknown"),
        (r#","strict":true"#, "config-changed"),
        (r#","depth":"light""#, "config-changed"),
        (
            r#","reReview":{"chained":true,"ledgerDegraded":false,"journalSourced":false,"priorRound":1,"priorHead":"h","tombstonesDropped":"2"}"#,
            "memory-degraded",
        ),
        (r#","cost":null"#, "cost-missing"),
        (r#","cost":[]"#, "cost-malformed"),
        (
            r#","cost":{"total":0,"cacheRead":0,"rule":"per-message"}"#,
            "cost-empty",
        ),
        (r#","cost":{"total":5,"cacheRead":5}"#, "cost-overcounted"),
        (
            r#","cost":{"total":5,"cacheRead":5,"rule":"x"}"#,
            "cost-unknown-rule",
        ),
        (r#","verification":{"candidates":-1}"#, "counts-malformed"),
        (
            r#","cost":{"total":5,"cacheRead":5,"rule":"per-message","source":"s","skipped":1}"#,
            "cost-partial",
        ),
        (
            r#","cost":{"total":5,"cacheRead":5,"rule":"per-message","source":"wf_1"}"#,
            "cost-unbound",
        ),
    ];
    for (more, want) in cases {
        assert_eq!(checks::status(&a, &round(2, "2", more)), want, "{more}");
    }
    let slice = |i: u8| {
        format!(
            r#","cost":{{"total":5,"cacheRead":5,"rule":"per-message","source":"wf_1","slice":{{"index":{i},"of":2}}}}"#
        )
    };
    let a = round(1, "1", &slice(1));
    assert_eq!(
        checks::status(&a, &round(2, "2", &slice(2))),
        "clean",
        "two slices of one run are distinct"
    );
    assert_eq!(
        checks::status(&a, &round(2, "2", &slice(1))),
        "cost-unbound"
    );
}

#[test]
fn a_review_record_that_is_no_round_is_counted_by_why() {
    let why = |t: &str| excluded(&rec(t));
    assert_eq!(
        why(r#"{"kind":"workflow","name":"review","partial":true}"#),
        Some("did not finish")
    );
    assert_eq!(
        why(r#"{"kind":"workflow","name":"review","schemaVersion":1,"nested":true}"#),
        Some("nested per-crate run")
    );
    assert_eq!(
        why(r#"{"kind":"workflow","name":"cli-review"}"#),
        Some("pre-telemetry")
    );
    assert_eq!(
        why(r#"{"kind":"workflow","name":"review","schemaVersion":1,"round":1.5}"#),
        Some("no round")
    );
    assert_eq!(
        why(r#"{"kind":"workflow","name":"review","schemaVersion":1,"round":1}"#),
        Some("no branch (e.g. a detached HEAD)")
    );
    assert_eq!(why(r#"{"kind":"workflow","name":"triage-findings"}"#), None);
    let kept = kept(&rec(
        r#"{"ledger":[1],"findings":{"total":2,"list":[]},"head":"h"}"#,
    ));
    assert_eq!(
        Js::Obj(kept).compact(),
        r#"{"head":"h","findings":{"total":2}}"#
    );
}

#[test]
fn the_rest_of_the_confounds_at_their_edges() {
    let a = round(1, "1", "");
    let cases = [
        (r#","engineRevision":4.5"#, "engine-unknown"),
        (r#","languages":["rust"]"#, "config-changed"),
        (
            r#","scout":[{"language":"rust","lenses":["b","a"]}]"#,
            "config-changed",
        ),
        (r#","gate":{"status":"unknown"}"#, "incomplete"),
        (r#","verification":null"#, "incomplete"),
        (r#","notRun":null"#, "incomplete"),
        (
            r#","findings":{"total":null},"findingsTotal":-1"#,
            "counts-malformed",
        ),
        (r#","lensRounds":[{"agents":"3"}]"#, "counts-malformed"),
        (
            r#","cost":{"total":5,"cacheRead":5,"rule":"per-message"}"#,
            "cost-unbound",
        ),
    ];
    for (more, want) in cases {
        assert_eq!(checks::status(&a, &round(2, "2", more)), want, "{more}");
    }
    let scout = r#","scout":[{"language":"rust","lenses":["a","b"],"model":null}]"#;
    let same = r#","scout":[{"language":"rust","lenses":["b","a"]}]"#;
    assert_eq!(
        checks::status(&round(1, "1", scout), &round(2, "2", same)),
        "clean",
        "lenses in any order, a null as absent"
    );
    let light = r#","depth":"light""#;
    assert_eq!(
        checks::status(&round(1, "1", light), &round(2, "2", light)),
        "clean"
    );
    let slice = |i: u8, of: u8, tail: &str| {
        format!(
            r#","cost":{{"total":5,"cacheRead":5,"rule":"per-message","source":"wf_1","slice":{{"index":{i},"of":{of}{tail}}}}}"#
        )
    };
    let pair = |x: String, y: String| checks::status(&round(1, "1", &x), &round(2, "2", &y));
    assert_eq!(pair(slice(1, 3, ""), slice(2, 3, r#","tail":1"#)), "clean");
    assert_eq!(
        pair(slice(1, 2, ""), slice(2, 3, "")),
        "cost-unbound",
        "slices of two runs' splits"
    );
    assert_eq!(pair(slice(1, 2, ""), slice(3, 2, "")), "cost-malformed");
}

#[test]
fn a_round_pairs_only_with_one_filed_strictly_before_it_and_the_delta_is_later_minus_earlier() {
    let rounds = [
        round(1, "2026-01-01T01-00-00Z", ""),
        round(
            1,
            "2026-01-01T01-30-00Z",
            r#","cost":{"total":300,"cacheRead":300,"rule":"per-message","source":"wf_x","agents":2}"#,
        ),
        round(
            2,
            "2026-01-01T01-30-00Z",
            r#","lensRounds":[{"agents":2}],"findings":{"total":4}"#,
        ),
    ];
    let got = pairs(&rounds);
    assert_eq!(got.len(), 1);
    let d = got[0].delta().unwrap();
    assert_eq!(
        (d.by[0], d.by[1], d.by[5], d.by[6], d.by[8]),
        (100.0, 100.0, 0.0, 2.0, 4.0)
    );
    assert_eq!(d.minutes, Some(30.0));
}

#[test]
fn of_two_earlier_rounds_filed_at_once_the_first_is_paired_and_a_count_of_zero_is_a_count() {
    let rounds = [
        round(1, "1", r#","lensRounds":[{"agents":3}]"#),
        round(1, "1", r#","dirty":true"#),
        round(2, "2", r#","lensRounds":[{"agents":0}]"#),
    ];
    let got = pairs(&rounds);
    assert_eq!(got[0].status, "clean");
    assert_eq!(got[0].delta().unwrap().by[6], -3.0);
    let model = |m: &str| format!(r#","scout":[{{"language":"rust","model":"{m}"}}]"#);
    assert_eq!(
        checks::status(&round(1, "1", &model("a")), &round(2, "2", &model("b"))),
        "config-changed"
    );
}
