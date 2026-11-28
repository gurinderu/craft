//! The retro's text where the parity store does not reach: a slice with nothing noisy, a memory
//! with nothing degraded, an unfinished listing alone, versions that collide in semver order.

use std::collections::BTreeSet;

use craft_store::js::{Obj, parse};
use craft_store::retro::{Lens, Retro};

fn printed(f: impl FnOnce(&mut Vec<u8>) -> std::io::Result<()>) -> String {
    let mut out = Vec::new();
    f(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}

#[test]
fn rated_lenses_below_the_noise_floor_are_said_none() {
    let name = "rust:errors".to_owned();
    let quiet = Lens {
        confirmed: 4.0,
        refuted: 1.0,
        ..Lens::default()
    };
    let text = printed(|o| super::noise::text(o, &[(&name, &quiet)]));
    assert!(
        text.contains("none: all 1 lens(es) with enough candidates refute below 0.25"),
        "{text}"
    );
    let few = Lens {
        refuted: 3.0,
        ..Lens::default()
    };
    let text = printed(|o| super::noise::text(o, &[(&name, &few)]));
    assert!(text.contains("no per-lens refute data yet"), "{text}");
}

#[test]
fn a_memory_with_nothing_degraded_prints_no_degraded_line() {
    let mut r = Retro::default();
    (r.memory.runs, r.memory.carrying, r.memory.recalled) = (2, 2, 2);
    assert!(!printed(|o| super::recall::text(o, &r)).contains("degraded"));
    r.memory.partly_read = 1;
    assert!(
        printed(|o| super::recall::text(o, &r)).contains("degraded: 0 not read · 1 partly read")
    );
}

fn partial(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn an_unfinished_run_alone_is_listed_with_what_it_spent() {
    let mut r = Retro::default();
    r.listed.push(partial(r#"{"ts":"t","name":"rust-audit","runtimeStats":{"agents":2,"wallClockMinutes":9,"longestStallSeconds":600}}"#));
    let text = printed(|o| super::listed::text(o, &r));
    assert!(text.contains("Runs that did not finish (1;"), "{text}");
    assert!(
        text.contains("t rust-audit — incomplete · 2 agent(s), 9min wall\n"),
        "a ten-minute stall is not named: {text}"
    );
    assert!(
        !text.contains("could not be attributed") && !text.contains("hidden"),
        "{text}"
    );
    r.listed_unattributed = 1;
    assert!(printed(|o| super::listed::text(o, &r)).contains("1 could not be attributed"));
    let none = Retro {
        listed_twins: 1,
        ..Retro::default()
    };
    assert!(printed(|o| super::listed::text(o, &none)).contains("1 rebuilt record(s) hidden"));
}

#[test]
fn versions_that_collide_are_ordered_by_semver_and_their_revisions_by_number() {
    let mut r = Retro::default();
    let revs = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<BTreeSet<_>>();
    r.revisions
        .insert("0.10.0".into(), revs(&["r10", "r9", "r?"]));
    r.revisions.insert("0.9.1".into(), revs(&["r1", "r2"]));
    r.revisions.insert("0.9.0-rc".into(), revs(&["r1", "r2"]));
    r.revisions.insert("0.8.0".into(), revs(&["r1"]));
    let got: Vec<(String, Vec<String>)> = super::noise::collisions(&r)
        .into_iter()
        .map(|(v, rs)| (v.clone(), rs.into_iter().cloned().collect()))
        .collect();
    let want = [
        ("0.9.0-rc", vec!["r1", "r2"]),
        ("0.9.1", vec!["r1", "r2"]),
        ("0.10.0", vec!["r9", "r10", "r?"]),
    ];
    let want: Vec<(String, Vec<String>)> = want
        .iter()
        .map(|(v, rs)| {
            (
                (*v).to_owned(),
                rs.iter().map(|s| (*s).to_owned()).collect(),
            )
        })
        .collect();
    assert_eq!(got, want);
}
