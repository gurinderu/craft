//! Later rounds rerun only the dispatches that found something new (realm @nick/craft, node #625),
//! and a per-file lens of the general profile reads no data file.

use serde_json::{Value, json};

use super::*;
use crate::units::Slice;

fn f(title: &str) -> Value {
    json!({"severity": "Medium", "title": title, "file": "src/a.rs", "line": 1})
}

fn dispatch(lens: &str, round: u32, slice: Option<&str>, found: &[&str]) -> Task {
    let mut t = Task::new(
        format!("lens-rust-{lens}-r{round}"),
        "l".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        TaskKind::Lens {
            profile: "rust".into(),
            lens: lens.into(),
            round,
            slice: slice.map(str::to_owned),
        },
    );
    let findings: Vec<Value> = found.iter().map(|x| f(x)).collect();
    t.answer = Some(json!({"lens": lens, "findings": findings}));
    t.state = TaskState::Answered;
    t
}

/// A dispatch of `lens` that died without an answer.
fn dead(lens: &str, round: u32) -> Task {
    let mut t = dispatch(lens, round, None, &[]);
    t.answer = None;
    t.state = TaskState::Failed;
    t
}

fn plan_of(lenses: &[&str]) -> Plan {
    Plan {
        size_bucket: "large".into(),
        lenses: lenses.iter().map(|l| (*l).to_owned()).collect(),
        max_rounds: 3,
        verify_votes: 3,
        is_library: false,
        security_sensitive: false,
        intent: String::new(),
        spec: String::new(),
        churn: Vec::new(),
        repo_rules: Vec::new(),
        surface_dropped: Vec::new(),
        light_skipped: Vec::new(),
        metrics_dropped: Vec::new(),
        signal_skipped: Vec::new(),
        profile_off: Vec::new(),
        data_skipped: Vec::new(),
        data_files: Vec::new(),
    }
}

/// The ids of `tasks` as `lens` or `lens slice`.
fn sent(tasks: &[Task]) -> Vec<String> {
    tasks
        .iter()
        .filter_map(|t| {
            let TaskKind::Lens { lens, slice, .. } = &t.kind else {
                return None;
            };
            Some(match slice {
                Some(s) => format!("{lens} {s}"),
                None => lens.clone(),
            })
        })
        .collect()
}

#[test]
fn a_dispatch_runs_again_only_on_a_finding_the_pool_lacked() {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    assert_eq!(r.rerun, None, "unknown before the first round");
    r.absorb(&[
        dispatch("errors", 1, None, &["a"]),
        dispatch("intent", 1, None, &["a"]),
        dispatch("tests", 1, None, &[]),
        dispatch("errors", 1, Some("src"), &["b"]),
        dead("compat", 1),
    ]);
    let y = |v: &[&str]| Some(v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
    assert_eq!(
        r.rerun,
        y(&["rust:errors", "rust:intent", "rust:errors :: src"]),
        "a copy raised in the same round is new to the pool it began with; a dispatch that died \
         is a hole, not sent again"
    );
    r.round = 2;
    r.absorb(&[
        dispatch("errors", 2, None, &["a"]),
        dispatch("intent", 2, None, &["a", "c"]),
    ]);
    assert_eq!(r.rerun, y(&["rust:intent"]), "a pooled finding is not new");
}

#[test]
fn a_later_round_sends_only_the_dispatches_that_yielded_slice_by_slice() {
    let ctx = PromptContext::fixture("/work/repo", "main");
    let rust = Profile::load("rust").unwrap();
    let plan = plan_of(&["errors", "intent", "tests"]);
    let slices = [
        Slice::loose("a".into(), vec!["a/x.rs".into()]),
        Slice::loose("b".into(), vec!["b/y.rs".into()]),
    ];
    let files = ["a/x.rs".to_owned(), "b/y.rs".to_owned()];
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let all = ["errors a", "errors b", "intent", "tests a", "tests b"];
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &slices, &r).unwrap()),
        all
    );
    r.rerun = Some(vec!["rust:errors :: b".into(), "rust:intent".into()]);
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &slices, &r).unwrap()),
        all,
        "the first round sends every dispatch"
    );
    r.round = 2;
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &slices, &r).unwrap()),
        ["errors b", "intent"]
    );
    r.rerun = None;
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &slices, &r).unwrap()),
        all,
        "a state written before it reruns every lens"
    );
    let design = plan_of(&["errors", "design"]);
    r.rerun = Some(vec!["rust:design".into()]);
    assert!(
        sent(&tasks(&ctx, (&rust, &design), &files, &[], &r).unwrap()).is_empty(),
        "a first-round-only lens that found something does not run again"
    );
}

#[test]
fn a_profile_goes_on_only_when_it_found_something_new_and_a_lens_that_did_may_run_again() {
    let rust = Profile::load("rust").unwrap();
    let plan = plan_of(&["errors", "design", "intent"]);
    let mut r = Rounds::default();
    assert!(r.goes_on(&rust, &plan, true), "unknown: every lens may");
    assert!(!r.goes_on(&rust, &plan, false), "nothing new");
    r.rerun = Some(vec!["rust:design".into()]);
    assert!(
        !r.goes_on(&rust, &plan, true),
        "design runs in the first only"
    );
    r.rerun = Some(vec!["rust:errors :: src".into()]);
    assert!(r.goes_on(&rust, &plan, true), "a slice of a planned lens");
    assert!(
        !r.goes_on(&rust, &plan, false),
        "marked, but the profile found nothing new"
    );
    r.rerun = Some(vec!["rust:intent".into()]);
    assert!(r.goes_on(&rust, &plan, true));
    r.rerun = Some(vec!["rust:errorsx".into(), "general:errors".into()]);
    assert!(!r.goes_on(&rust, &plan, true), "another lens or profile's");
    r.rerun = Some(vec!["rust:money".into()]);
    assert!(!r.goes_on(&rust, &plan, true), "a lens not in the plan");
}

#[test]
fn a_general_per_file_lens_reads_no_data_file_and_a_whole_diff_lens_reads_all() {
    let ctx = PromptContext::fixture("/work/repo", "main");
    let general = Profile::load("general").unwrap();
    let plan = plan_of(&["errors", "compat"]);
    let r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let files = ["web/app.ts".to_owned(), "web/data.json".to_owned()];
    let got = tasks(&ctx, (&general, &plan), &files, &[], &r).unwrap();
    assert!(got[0].prompt.contains("web/app.ts"));
    assert!(
        !got[0].prompt.contains("web/data.json"),
        "errors reads source"
    );
    assert!(
        got[1].prompt.contains("web/data.json"),
        "compat reads it all"
    );
    let data = ["web/data.json".to_owned()];
    let got = tasks(&ctx, (&general, &plan), &data, &[], &r).unwrap();
    assert_eq!(
        sent(&got),
        ["compat"],
        "a per-file lens with nothing to read is not sent"
    );
    let rust = Profile::load("rust").unwrap();
    let mixed = ["src/a.rs".to_owned(), "Cargo.toml".to_owned()];
    let got = tasks(&ctx, (&rust, &plan_of(&["errors"])), &mixed, &[], &r).unwrap();
    assert_eq!(
        sent(&got),
        ["errors"],
        "the Rust profile keeps its manifest"
    );
}

/// In a sliced general part, the security lens reads the part's data once, in one dispatch more over
/// the data alone; a per-file lens reads its slices alone; no Rust slice is ever given data (realm
/// @nick/craft, node #625).
#[test]
fn the_security_lens_of_a_sliced_general_part_reads_its_data_once() {
    let ctx = PromptContext::fixture("/work/repo", "main");
    let general = Profile::load("general").unwrap();
    let plan = plan_of(&["errors", "security"]);
    let r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let slices = [
        Slice::loose("a".into(), vec!["a/x.ts".into()]),
        Slice::loose("b".into(), vec!["b/y.ts".into()]),
    ];
    let files: Vec<String> = ["a/x.ts", "b/y.ts", "fixtures/rows.csv", "api/s.json"]
        .iter()
        .map(|f| (*f).to_owned())
        .collect();
    let got = tasks(&ctx, (&general, &plan), &files, &slices, &r).unwrap();
    assert_eq!(
        sent(&got),
        [
            "errors a",
            "errors b",
            "security a",
            "security b",
            "security /data files"
        ]
    );
    for t in &got[..4] {
        assert!(!t.prompt.contains("fixtures/rows.csv"), "{}", t.prompt);
    }
    let data = &got[4].prompt;
    assert!(
        data.contains("fixtures/rows.csv")
            && data.contains("api/s.json")
            && !data.contains("a/x.ts"),
        "{data}"
    );
    assert_eq!(got[4].id, "lens-general-security-r1-s2");
    let rust = Profile::load("rust").unwrap();
    let mixed: Vec<String> = ["a/x.rs", "b/y.rs", "fixtures/rows.json"]
        .iter()
        .map(|f| (*f).to_owned())
        .collect();
    let got = tasks(&ctx, (&rust, &plan), &mixed, &slices, &r).unwrap();
    assert_eq!(
        sent(&got),
        ["errors a", "errors b", "security a", "security b"],
        "a Rust lens is never given data beside its slices"
    );
}

/// The data-files dispatch has a key no directory slice can have, and later rounds rerun or
/// withhold it by that key like any other (realm @nick/craft, node #625).
#[test]
fn the_data_dispatch_is_keyed_apart_from_every_slice_and_reruns_by_its_key() {
    let ctx = PromptContext::fixture("/work/repo", "main");
    let general = Profile::load("general").unwrap();
    let plan = plan_of(&["security"]);
    let slices = [
        Slice::loose("data files".into(), vec!["data files/x.ts".into()]),
        Slice::loose("b".into(), vec!["b/y.ts".into()]),
    ];
    let files: Vec<String> = ["data files/x.ts", "b/y.ts", "rows.csv"]
        .iter()
        .map(|f| (*f).to_owned())
        .collect();
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let all = ["security data files", "security b", "security /data files"];
    assert_eq!(
        sent(&tasks(&ctx, (&general, &plan), &files, &slices, &r).unwrap()),
        all,
        "a directory named like it is a slice of its own"
    );
    r.round = 2;
    r.rerun = Some(vec!["general:security :: /data files".into()]);
    assert_eq!(
        sent(&tasks(&ctx, (&general, &plan), &files, &slices, &r).unwrap()),
        ["security /data files"],
        "rerun by its key, and the directory slice of that name not"
    );
    r.rerun = Some(vec!["general:security :: data files".into()]);
    assert_eq!(
        sent(&tasks(&ctx, (&general, &plan), &files, &slices, &r).unwrap()),
        ["security data files"],
        "withheld when only the directory slice found something"
    );
}

/// A dispatch that died is a hole even after an earlier round's answer (realm @nick/craft, node
/// #625).
#[test]
fn a_dispatch_that_answered_then_died_is_a_hole() {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    r.absorb(&[dispatch("errors", 1, None, &["a"])]);
    assert!(r.holes("rust").is_empty());
    r.round = 2;
    r.absorb(&[dead("errors", 2)]);
    assert_eq!(
        r.holes("rust"),
        ["errors: returned no result (skipped or died without an error)"]
    );
}

/// A state written while rounds still kept a `retry` list loads, the list ignored.
#[test]
fn a_state_with_the_removed_retry_list_still_loads() {
    let r: Rounds = serde_json::from_value(json!({
        "round": 2, "pool": [], "yields": [], "expected": ["rust:errors"], "returned": [],
        "failures": {}, "rerun": ["rust:errors"], "retry": ["rust:design"]
    }))
    .unwrap();
    assert_eq!(r.rerun, Some(vec!["rust:errors".to_owned()]));
}

/// A lens its profile limits to one round is not sent in the second, even after finding something
/// new, while a lens with no limit is; the limit never drops the lens from the first round (realm
/// @nick/craft, node #632).
#[test]
fn a_lens_limited_to_one_round_is_not_sent_again_though_it_found_something_new() {
    let ctx = PromptContext::fixture("/work/repo", "main");
    let rust = Profile::load("rust").unwrap();
    let plan = plan_of(&["errors", "maintainability"]);
    let files = ["src/a.rs".to_owned()];
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &[], &r).unwrap()),
        ["errors", "maintainability"],
        "the first round sends the limited lens too"
    );
    r.absorb(&[
        dispatch("errors", 1, None, &["a"]),
        dispatch("maintainability", 1, None, &["b"]),
    ]);
    r.round = 2;
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &[], &r).unwrap()),
        ["errors"]
    );
    r.rerun = None;
    assert_eq!(
        sent(&tasks(&ctx, (&rust, &plan), &files, &[], &r).unwrap()),
        ["errors"],
        "a state that does not know what it found still keeps the limit"
    );
}

#[test]
fn a_profile_whose_only_new_finding_came_from_a_limited_lens_goes_no_further() {
    let rust = Profile::load("rust").unwrap();
    let plan = plan_of(&["errors", "performance", "maintainability"]);
    let mut r = Rounds {
        round: 1,
        rerun: Some(vec![
            "rust:performance".into(),
            "rust:maintainability :: src".into(),
        ]),
        ..Rounds::default()
    };
    assert!(!r.goes_on(&rust, &plan, true));
    r.rerun = Some(vec!["rust:errors".into()]);
    assert!(r.goes_on(&rust, &plan, true), "an unlimited lens goes on");
}

/// The limits #632 names, and none beyond them: Rust errors, concurrency and the Nix
/// maintainability lens keep every round the plan allows.
#[test]
fn the_profiles_limit_the_low_yield_lenses_to_one_round() {
    let rounds = |p: &str, l: &str| {
        Profile::load(p)
            .unwrap()
            .lens(l)
            .and_then(|x| x.rounds)
            .map(std::num::NonZeroU32::get)
    };
    for (p, l) in [
        ("rust", "maintainability"),
        ("rust", "performance"),
        ("general", "maintainability"),
        ("general", "performance"),
        ("general", "errors"),
    ] {
        assert_eq!(rounds(p, l), Some(1), "{p}:{l}");
    }
    for (p, l) in [
        ("rust", "errors"),
        ("rust", "concurrency"),
        ("general", "concurrency"),
        ("nix", "maintainability"),
    ] {
        assert_eq!(rounds(p, l), None, "{p}:{l}");
    }
}

#[test]
fn a_round_limit_of_zero_is_refused() {
    let lens = |r: u32| {
        serde_json::from_value::<crate::profile::Lens>(json!({
            "id": "errors", "brief": "lens-briefs/rust-errors", "model": "opus", "rounds": r
        }))
    };
    assert!(
        lens(0).is_err(),
        "a lens limited to no round would never run"
    );
    assert_eq!(
        lens(1).unwrap().rounds.map(std::num::NonZeroU32::get),
        Some(1)
    );
}

/// What a later round may send again: a lens with no limit, not design, a metrics lens or one the
/// profile limits to one round (realm @nick/craft, node #634).
#[test]
fn only_a_lens_a_later_round_may_send_again_is_resendable() {
    let rust = Profile::load("rust").unwrap();
    assert!(resendable(&rust, "errors"));
    for lens in ["design", "complexity", "maintainability", "performance"] {
        assert!(!resendable(&rust, lens), "{lens}");
    }
}
