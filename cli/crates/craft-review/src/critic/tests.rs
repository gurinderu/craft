use serde_json::json;

use super::admit::followups;
use super::*;
use crate::state::{RunState, Task, TaskState};

/// A run of one Rust track planned as `plan`, read from the JSON a state file holds.
fn run_with(plan: &serde_json::Value) -> RunState {
    let mut run: RunState = serde_json::from_value(json!({
        "version": crate::state::STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "m", "head": "h", "dirty": false, "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [{"profile": "rust", "files": ["src/lib.rs"], "plan": plan}],
        "light": false, "phase": "verify", "tasks": [], "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap();
    run.critic.stage = Stage::Asked;
    run
}

fn plan(
    size: &str,
    security: bool,
    lenses: &[&str],
    surface_dropped: &[&str],
) -> serde_json::Value {
    json!({"sizeBucket": size, "lenses": lenses, "maxRounds": 1, "verifyVotes": 1, "isLibrary": false,
           "securitySensitive": security, "intent": "", "spec": "", "churn": [], "repoRules": [],
           "surfaceDropped": surface_dropped, "lightSkipped": []})
}

#[test]
fn a_critic_is_asked_only_on_a_large_or_security_sensitive_full_review() {
    let profiles = vec![Profile::rust().unwrap()];
    let small = run_with(&plan("small", false, &["errors"], &[]));
    assert!(tasks(&small, &profiles).unwrap().is_empty());
    let large = run_with(&plan("large", false, &["errors"], &[]));
    let asked = tasks(&large, &profiles).unwrap();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0]
            .prompt
            .contains("choose ONLY from: [\"safety\",\"concurrency\"")
    );
    let mut light = run_with(&plan("small", true, &["errors"], &[]));
    light.light = true;
    assert!(
        tasks(&light, &profiles).unwrap().is_empty(),
        "no critic on a light pass"
    );
}

#[test]
fn the_critic_admits_a_candidate_and_refuses_an_optional_or_surface_gated_one() {
    let profiles = vec![Profile::rust().unwrap()];
    let mut run = run_with(&plan("large", false, &["errors"], &["invariants"]));
    let mut critic = Task::new(
        "critic-rust".into(),
        "critic:rust".into(),
        String::new(),
        crate::agent::Model::Opus,
        json!({}),
        TaskKind::Critic {
            profile: "rust".into(),
        },
    );
    critic.state = TaskState::Answered;
    critic.answer = Some(
        json!({"missingLenses": ["safety", "performance", "invariants", "errors", "nonsense", "safety"],
                                "notes": "src/lib.rs has no finding"}),
    );
    run.tasks = vec![critic];
    let lenses = followups(&mut run, &profiles).unwrap();
    let ids: Vec<&str> = lenses.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(
        ids,
        ["critic-lens-rust-safety"],
        "only the candidate the gates admit, once"
    );
    assert!(
        lenses[0]
            .prompt
            .contains("Earlier lenses already produced 0 findings")
    );
    assert_eq!(run.critic.notes, ["src/lib.rs has no finding"]);
    assert!(
        run.notes
            .iter()
            .any(|n| n.contains("optional lens performance") && n.contains("NOT dispatched"))
    );
    assert!(
        run.notes
            .iter()
            .any(|n| n.contains("surface-gated lens invariants"))
    );
    assert!(section(&run).contains("## Coverage gaps\n\nsrc/lib.rs has no finding"));
}

#[test]
fn a_follow_up_finding_the_pool_holds_is_not_new_and_a_dead_lens_is_a_gap() {
    let mut run = run_with(&plan("large", false, &["errors"], &[]));
    run.rounds.pool = vec![json!({"file": "src/lib.rs", "line": 1, "title": "known"})];
    let lens = |id: &str, lens: &str, answer: Option<serde_json::Value>| {
        let mut t = Task::new(
            id.into(),
            id.into(),
            String::new(),
            crate::agent::Model::Opus,
            json!({}),
            TaskKind::CriticLens {
                profile: "rust".into(),
                lens: lens.into(),
            },
        );
        t.state = if answer.is_some() {
            TaskState::Answered
        } else {
            TaskState::Failed
        };
        t.answer = answer;
        t
    };
    run.tasks = vec![
        lens(
            "a",
            "safety",
            Some(json!({"findings": [
            {"file": "src/lib.rs", "line": 1, "title": "Known"},
            {"file": "src/lib.rs", "line": 2, "title": "new"}]})),
        ),
        lens("b", "concurrency", None),
    ];
    let fresh = fresh(&mut run);
    assert_eq!(fresh.len(), 1);
    assert_eq!(
        (fresh[0]["source"].as_str(), fresh[0]["profile"].as_str()),
        (Some("safety"), Some("rust"))
    );
    assert_eq!(run.not_run.len(), 1);
    assert!(run.not_run[0].starts_with("rust critic follow-up lens concurrency"));
}

#[test]
fn the_verification_pass_of_the_critic_runs_under_ids_of_its_own() {
    let mut run = run_with(&plan("large", false, &[], &[]));
    let task = |id: &str| {
        Task::new(
            id.into(),
            id.into(),
            String::new(),
            crate::agent::Model::Opus,
            json!({}),
            TaskKind::Dedup,
        )
    };
    let mut tasks = vec![task("verify-0-v0")];
    relabel(&run, &mut tasks);
    assert_eq!(tasks[0].id, "verify-0-v0");
    run.critic.stage = Stage::Verifying;
    relabel(&run, &mut tasks);
    relabel(&run, &mut tasks);
    assert_eq!(tasks[0].id, "critic-verify-0-v0");
}
