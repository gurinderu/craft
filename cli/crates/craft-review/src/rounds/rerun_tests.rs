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
fn a_dispatch_runs_again_on_a_finding_the_pool_lacked_when_the_round_began_or_on_no_answer() {
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
        y(&[
            "rust:errors",
            "rust:intent",
            "rust:errors :: src",
            "rust:compat"
        ]),
        "a copy raised in the same round is new to the pool it began with, and a dispatch that \
         died is sent again, its hole still open"
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
}

#[test]
fn a_profile_reruns_only_while_a_lens_that_may_run_again_yielded() {
    let rust = Profile::load("rust").unwrap();
    let plan = plan_of(&["errors", "design", "intent"]);
    let mut r = Rounds::default();
    assert!(r.reruns_any(&rust, &plan), "unknown: every lens may");
    r.rerun = Some(vec!["rust:design".into()]);
    assert!(!r.reruns_any(&rust, &plan), "design runs in the first only");
    r.rerun = Some(vec!["rust:errors :: src".into()]);
    assert!(r.reruns_any(&rust, &plan), "a slice of a planned lens");
    r.rerun = Some(vec!["rust:intent".into()]);
    assert!(r.reruns_any(&rust, &plan));
    r.rerun = Some(vec!["rust:errorsx".into(), "general:errors".into()]);
    assert!(!r.reruns_any(&rust, &plan), "another lens or profile's");
    r.rerun = Some(vec!["rust:money".into()]);
    assert!(!r.reruns_any(&rust, &plan), "a lens not in the plan");
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
