use super::*;
use crate::finding::id_of;

fn sifted(severity: &str, title: &str, location: &str, thread: &str) -> Sifted {
    let f = Finding(
        Obj::new()
            .with("severity", Js::str(severity))
            .with("title", Js::str(title))
            .with("location", Js::str(location))
            .with("thread_id", Js::str(thread))
            .with("source", Js::str("review")),
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
    let of: Vec<(&JsString, &JsString)> = c
        .repeated
        .iter()
        .map(|r| (&r.finding.stable_id, &r.of))
        .collect();
    assert_eq!(
        of,
        [
            (&low.stable_id, &high.stable_id),
            (&mid.stable_id, &high.stable_id),
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
    let row = Js::from(repeat_entry(&r)).compact();
    assert_eq!(
        row,
        r#"{"stable_id":"review::a.rs:1::t","verdict":"reject","sifted":true,"repeat_of":"x","reason":"SIFTED BEFORE VALIDATION — repeats x in this batch (same site, same title words); judged there"}"#
    );
}

#[test]
fn files_apart_only_in_an_unpaired_surrogate_are_two_sites() {
    let at = |location: &str| {
        let answer = format!(
            r#"{{"severity":"Low","title":"memory leak","location":"{location}","detail":"d","proposed_fix":"","thread_id":"","source":"r"}}"#
        );
        let f = Finding(
            craft_store::js::parse(&answer)
                .unwrap()
                .as_obj()
                .unwrap()
                .clone(),
        );
        let id = id_of(&f);
        Sifted::new(f, id)
    };
    let (a, b) = (at("\\ud800.rs:10"), at("\\ud801.rs:10"));
    assert_eq!(a.file, JsString::from_utf16(vec![0xd800, 0x2e, 0x72, 0x73]));
    assert_eq!(a.line, 10);
    assert!(!repeats_finding(&a, &b));
    assert!(repeats_finding(&a, &at(" \\ud800.rs:12")));
}
