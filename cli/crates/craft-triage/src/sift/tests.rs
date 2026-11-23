use super::*;
use crate::finding::id_of;

fn sifted(severity: &str, title: &str, location: &str, thread: &str) -> Sifted {
    let f = Finding(
        Obj::new()
            .with("severity", severity)
            .with("title", title)
            .with("location", location)
            .with("thread_id", thread)
            .with("source", "review"),
    );
    let id = id_of(&f);
    Sifted::new(f, id)
}

#[test]
fn a_repeat_is_the_same_thread_or_the_same_site_and_words() {
    let a = sifted("Low", "memory leak", "src/a.rs:10", "");
    assert!(repeats_finding(
        &a,
        &sifted("Low", "leak of memory", "src/a.rs:13", "")
    ));
    assert!(!repeats_finding(
        &a,
        &sifted("Low", "leak of memory", "src/a.rs:14", "")
    ));
    assert!(!repeats_finding(
        &a,
        &sifted("Low", "leak here", "src/a.rs:10", "")
    ));
    assert!(!repeats_finding(
        &a,
        &sifted("Low", "memory leak", "src/b.rs:10", "")
    ));
    assert!(repeats_finding(
        &a,
        &sifted("Low", "memory leak", "src/a.rs", "")
    ));
    let t = sifted("Low", "x", "", "T1");
    assert!(repeats_finding(&t, &sifted("Low", "y", "z.rs:1", "T1")));
    let none = sifted("Low", "memory leak", "", "");
    assert!(!repeats_finding(&none, &none.clone()));
}

#[test]
fn the_most_severe_repeat_is_kept_and_earlier_repeats_follow_it() {
    let low = sifted("Low", "memory leak", "src/a.rs:10", "");
    let mid = sifted("Medium", "leak of memory", "src/a.rs:11", "");
    let high = sifted("High", "the memory leak", "src/a.rs:12", "");
    let c = collapse_repeats(vec![mid.clone(), low.clone(), high.clone(), low.clone()]);
    assert_eq!(c.kept, std::slice::from_ref(&high));
    let of: Vec<(&str, &str)> = c
        .repeated
        .iter()
        .map(|r| (r.finding.stable_id.as_str(), r.of.as_str()))
        .collect();
    assert_eq!(
        of,
        [
            (low.stable_id.as_str(), high.stable_id.as_str()),
            (mid.stable_id.as_str(), high.stable_id.as_str()),
        ]
    );
}

#[test]
fn a_tie_in_severity_keeps_the_finding_already_kept() {
    let first = sifted("High", "memory leak", "src/a.rs:10", "");
    let second = sifted("High", "leak of memory", "src/a.rs:11", "");
    let c = collapse_repeats(vec![first.clone(), second.clone()]);
    assert_eq!(c.kept, std::slice::from_ref(&first));
    assert_eq!(c.repeated[0].finding, second);
}

#[test]
fn a_repeat_row_is_a_sifted_reject_naming_its_twin_in_the_engines_order() {
    let r = Repeat {
        finding: sifted("Low", "t", "a.rs:1", ""),
        of: "x".into(),
    };
    let row = serde_json::to_string(&crate::json::Json::from(repeat_entry(&r))).unwrap();
    assert_eq!(
        row,
        r#"{"stable_id":"review::a.rs:1::t","verdict":"reject","sifted":true,"repeat_of":"x","reason":"SIFTED BEFORE VALIDATION — repeats x in this batch (same site, same title words); judged there"}"#
    );
}
