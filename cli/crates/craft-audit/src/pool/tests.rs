use craft_step::{Model, TaskState};
use serde_json::{Value, json};

use super::{BATCH_SIZE, Pooled, batches, pool};
use crate::kind::AuditKind;
use crate::state::Task;

mod settle;

pub(super) fn task(kind: AuditKind, state: TaskState, answer: Option<Value>) -> Task {
    let mut t = Task::new(
        "t".into(),
        "t".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        kind,
    );
    t.state = state;
    t.answer = answer;
    t
}

fn lens(profile: &str, lens: &str) -> AuditKind {
    AuditKind::Lens {
        profile: profile.into(),
        lens: lens.into(),
        batch: 0,
    }
}

pub(super) fn verify(findings: Vec<usize>) -> AuditKind {
    AuditKind::Verify {
        profile: "rust".into(),
        findings,
    }
}

pub(super) fn finding(sev: &str) -> Value {
    json!({"severity": sev, "title": sev, "file": "a.rs", "line": 1, "why": "w", "source": "", "harmLevel": "outage"})
}

pub(super) fn pooled(profile: &str, sev: &str) -> Pooled {
    Pooled {
        profile: profile.into(),
        finding: finding(sev),
    }
}

#[test]
fn only_answered_lenses_pool_their_findings_in_task_order_each_naming_its_lens() {
    let tasks = [
        task(
            lens("rust", "safety"),
            TaskState::Answered,
            Some(json!({"findings": [finding("High")]})),
        ),
        task(
            lens("rust", "errors"),
            TaskState::Failed,
            Some(json!({"findings": [finding("Low")]})),
        ),
        task(
            lens("general", "tests"),
            TaskState::Answered,
            Some(json!({"findings": [finding("Low"), finding("Medium")]})),
        ),
    ];
    let got = pool(&tasks);
    let seen: Vec<(&str, &str, &str)> = got
        .iter()
        .map(|p| {
            (
                p.profile.as_str(),
                p.finding["severity"].as_str().unwrap(),
                p.finding["source"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            ("rust", "High", "safety"),
            ("general", "Low", "tests"),
            ("general", "Medium", "tests")
        ]
    );
}

#[test]
fn critical_and_high_are_verified_alone_medium_together_by_profile_and_low_not_at_all() {
    let mut p = vec![
        pooled("rust", "High"),
        pooled("rust", "Low"),
        pooled("rust", "Info"),
    ];
    p.extend((0..=BATCH_SIZE).map(|_| pooled("rust", "Medium")));
    p.push(pooled("general", "Medium"));
    p.push(pooled("nix", "Critical"));
    let got = batches(&p, &[]);
    let shape: Vec<(&str, usize)> = got.iter().map(|(pr, g)| (pr.as_str(), g.len())).collect();
    assert_eq!(
        shape,
        [
            ("rust", 1),
            ("nix", 1),
            ("rust", BATCH_SIZE),
            ("rust", 1),
            ("general", 1)
        ]
    );
    assert_eq!(got[0].1, [0]);
    let routed = [task(verify(vec![0]), TaskState::Answered, None)];
    assert!(batches(&p, &routed).iter().all(|(_, g)| !g.contains(&0)));
}
