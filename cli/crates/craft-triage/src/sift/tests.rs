use super::*;
use crate::finding::id_of;

fn sifted(severity: &str, title: &str, location: &str, thread: &str) -> Sifted {
    let f = Finding {
        severity: severity.into(),
        title: title.into(),
        location: location.into(),
        thread_id: thread.into(),
        source: "review".into(),
        ..Finding::default()
    };
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
fn a_repeat_row_is_a_sifted_reject_naming_its_twin() {
    let r = Repeat {
        finding: sifted("Low", "t", "a.rs:1", ""),
        of: "x".into(),
    };
    let e = repeat_entry(&r);
    assert_eq!(e.verdict, "reject");
    assert_eq!(e.sifted, Some(true));
    assert_eq!(e.repeat_of.as_deref(), Some("x"));
    assert_eq!(
        e.reason,
        "SIFTED BEFORE VALIDATION — repeats x in this batch (same site, same title words); judged there"
    );
}
