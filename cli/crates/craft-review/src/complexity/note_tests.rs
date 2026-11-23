//! The note on what a measured run's metrics lenses judged without the graph's numbers: only the
//! unread files of the parts a metrics lens runs over, in one note for the plan's and the critic's.

use serde_json::json;

use super::{note_unmeasured, unmeasured};
use crate::profile::Profile;
use crate::prompts::PromptContext;
use crate::state::RunState;

const UNREAD: [&str; 2] = ["src/b.rs (cut)", "web/c.ts (cut)"];

#[test]
fn the_note_names_only_the_unread_files_of_the_parts_a_metrics_lens_runs_over() {
    let mut ctx = PromptContext::default();
    ctx.consumers.metrics_unread = UNREAD.map(str::to_owned).to_vec();
    let rust = Profile::rust().unwrap();
    let files = ["src/a.rs".to_owned()];
    let note = unmeasured(&ctx, &[(&rust, &files)]).unwrap();
    assert!(
        note.contains("src/b.rs (cut)") && !note.contains("web/c.ts"),
        "{note}"
    );
    assert_eq!(unmeasured(&ctx, &[]), None, "no lens runs: no note");
}

/// A run of a Rust part whose plan runs complexity and a general part whose plan does not.
fn two_parts() -> RunState {
    let plan = |lenses: &[&str]| {
        json!({"sizeBucket": "large", "lenses": lenses, "maxRounds": 1, "verifyVotes": 1, "isLibrary": false,
               "securitySensitive": false, "intent": "", "spec": "", "churn": [], "repoRules": [],
               "surfaceDropped": [], "lightSkipped": []})
    };
    let mut run: RunState = serde_json::from_value(json!({
        "version": crate::state::STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "m", "head": "h", "dirty": false, "files": ["src/a.rs", "web/c.ts"], "stat": "", "log": ""},
        "tracks": [
            {"profile": "rust", "files": ["src/a.rs"], "plan": plan(&["complexity"])},
            {"profile": "general", "files": ["web/c.ts"], "plan": plan(&["correctness"])}
        ],
        "light": false, "phase": "verify", "tasks": [], "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap();
    run.context.consumers.metrics_unread = UNREAD.map(str::to_owned).to_vec();
    run
}

#[test]
fn the_plans_lens_and_one_the_critic_admits_share_one_note() {
    let profiles = [Profile::rust().unwrap(), Profile::load("general").unwrap()];
    let mut run = two_parts();
    let host = "round 1: 3 task(s) ran on the default agent type instead".to_owned();
    run.degraded.push(host.clone());
    note_unmeasured(&mut run, &profiles, |_| false);
    assert_eq!(run.degraded.len(), 2, "{:?}", run.degraded);
    assert!(!run.degraded[1].contains("web/c.ts"), "{:?}", run.degraded);
    let other = "1 lens task(s) named no rubric file they read whole".to_owned();
    run.degraded.push(other.clone());
    note_unmeasured(&mut run, &profiles, |p| p.id == "general");
    let unmeasured: Vec<&String> = run
        .degraded
        .iter()
        .filter(|d| d.starts_with(super::look::UNMEASURED))
        .collect();
    assert_eq!(unmeasured.len(), 1, "one note: {:?}", run.degraded);
    assert!(
        unmeasured[0].contains("src/b.rs") && unmeasured[0].contains("web/c.ts"),
        "{:?}",
        run.degraded
    );
    assert!(
        run.degraded.starts_with(&[host, other]),
        "the other notes kept, in order: {:?}",
        run.degraded
    );
}
