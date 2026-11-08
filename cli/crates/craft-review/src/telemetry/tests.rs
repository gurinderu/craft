use serde_json::json;

use super::*;
use crate::agent::Model;

/// A run of one Rust track planned with `lenses`, as a state file holds it, with `expected` lens
/// dispatches of which `returned` answered.
fn run_with(lenses: &[&str], expected: &[&str], returned: &[&str]) -> RunState {
    let plan = json!({"sizeBucket": "large", "lenses": lenses, "maxRounds": 1, "verifyVotes": 1, "isLibrary": false,
                      "securitySensitive": false, "intent": "", "spec": "", "churn": [], "repoRules": [],
                      "surfaceDropped": [], "lightSkipped": []});
    serde_json::from_value(json!({
        "version": crate::state::STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "m", "head": "h", "dirty": false, "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [{"profile": "rust", "files": ["src/lib.rs"], "plan": plan}],
        "light": false, "phase": "verify", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": expected, "returned": returned, "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap()
}

fn task(id: &str, kind: TaskKind, answered: bool) -> Task {
    let mut t = Task::new(
        id.into(),
        id.into(),
        String::new(),
        Model::Sonnet,
        json!({}),
        kind,
    );
    if answered {
        t.state = TaskState::Answered;
        t.answer = Some(json!({}));
    }
    t
}

fn lens(lens: &str, slice: Option<&str>, answered: bool) -> Task {
    let kind = TaskKind::Lens {
        profile: "rust".into(),
        lens: lens.into(),
        round: 1,
        slice: slice.map(str::to_owned),
    };
    task(&format!("lens-{lens}"), kind, answered)
}

fn settled(source: &str, severity: &str, tier: &str, discarded: u64) -> Value {
    json!({"source": source, "profile": "rust", "severity": severity, "tier": tier, "votesDiscarded": discarded,
           "file": "src/lib.rs", "line": 1, "title": format!("{source} {tier}")})
}

#[test]
fn a_run_no_verification_settled_carries_null_and_rows_with_nothing_counted() {
    let run = run_with(&["errors"], &["rust:errors"], &[]);
    assert_eq!(verification(&run), Value::Null);
    let rows = dimensions(&run);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            &rows[0]["ran"],
            &rows[0]["findingCount"],
            &rows[0]["rounds"]
        ),
        (&json!(false), &json!(0), &json!(0)),
        "a lens that never answered is told apart from one that found nothing"
    );
}

#[test]
fn each_pass_adds_to_the_counts_and_a_thinned_panel_is_counted_on_any_tier() {
    let mut run = run_with(&["errors"], &["rust:errors"], &["rust:errors"]);
    // A sliced lens is one dispatch pass however many slices it had.
    run.telemetry.dispatched(&[
        lens("errors", Some("a"), true),
        lens("errors", Some("b"), false),
    ]);
    run.tasks = vec![
        task(
            "verify-0-v0",
            TaskKind::Verify {
                finding: 0,
                voter: 0,
            },
            true,
        ),
        task(
            "verify-batch-0",
            TaskKind::VerifyBatch { findings: vec![1] },
            false,
        ),
    ];
    verified(
        &mut run,
        &[
            settled("errors", "High", "confirmed", 0),
            settled("errors", "Low", "refuted", 1),
        ],
    );
    // The critic's pass: its lens, then its own verification.
    let critic = TaskKind::CriticLens {
        profile: "rust".into(),
        lens: "safety".into(),
    };
    run.telemetry
        .dispatched(&[task("critic-lens-rust-safety", critic, true)]);
    run.tasks = vec![task(
        "critic-verify-1-v0",
        TaskKind::Verify {
            finding: 0,
            voter: 0,
        },
        true,
    )];
    verified(
        &mut run,
        &[
            settled("safety", "Critical", "unverified", 2),
            settled("safety", "Bogus", "confirmed", 0),
        ],
    );
    assert_eq!(
        verification(&run),
        json!({"candidates": 3, "confirmed": 2, "refuteRate": 0.33, "unverified": 1, "thinned": 2,
               "suspected": 0, "refuted": 1, "votes": {"sent": 3, "returned": 2}})
    );
    let rows = dimensions(&run);
    let names: Vec<&Value> = rows.iter().map(|r| &r["dimension"]).collect();
    assert_eq!(names, [&json!("rust:errors"), &json!("rust:safety")]);
    assert_eq!(
        (
            &rows[0]["ran"],
            &rows[0]["rounds"],
            &rows[0]["bySeverity"]["High"]
        ),
        (&json!(true), &json!(1), &json!(1))
    );
    assert_eq!(
        (
            &rows[1]["ran"],
            &rows[1]["confirmedCount"],
            &rows[1]["findingCount"]
        ),
        (&json!(true), &json!(1), &json!(0)),
        "a critic's lens has its row; a severity no reader counts is in no bucket, as countBySeverity"
    );
}

#[test]
fn the_refute_rate_rounds_half_up_to_two_places() {
    assert!((refute_rate(1, 8) - 0.13).abs() < f64::EPSILON);
    assert!((refute_rate(1, 3) - 0.33).abs() < f64::EPSILON);
    assert!((refute_rate(0, 0)).abs() < f64::EPSILON);
    assert!((refute_rate(4, 4) - 1.0).abs() < f64::EPSILON);
}
