//! The lens rounds' agent budget (realm @nick/craft, node #634).

use super::*;
use crate::agent::Model;
use crate::state::{Task, TaskKind};

/// `n` dispatches of the Rust errors lens in `round`, the first one on a slice.
fn lens_tasks(n: usize, round: u32) -> Vec<Task> {
    (0..n)
        .map(|i| {
            Task::new(
                format!("lens-rust-errors-r{round}-{i}"),
                "l".into(),
                "p".into(),
                Model::Opus,
                serde_json::json!({}),
                TaskKind::Lens {
                    profile: "rust".into(),
                    lens: "errors".into(),
                    round,
                    slice: (i == 0).then(|| "src".to_owned()),
                },
            )
        })
        .collect()
}

fn after_first(first: usize) -> Rounds {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    r.count_sent(&lens_tasks(first, 1));
    r
}

#[test]
fn the_default_budget_is_twice_the_first_round_and_buys_the_round_that_fits() {
    let mut r = after_first(113);
    assert_eq!((r.first, r.sent), (113, 113));
    assert_eq!(r.agent_budget(), Some(226));
    r.round = 2;
    assert_eq!(
        r.over_budget(&lens_tasks(113, 2)),
        None,
        "at the budget, bought"
    );
    r.count_sent(&lens_tasks(110, 2));
    assert_eq!(
        (r.first, r.sent),
        (113, 223),
        "a later round adds to sent alone"
    );
    r.round = 3;
    let note = r
        .over_budget(&lens_tasks(4, 3))
        .expect("223 + 4 is over 226");
    assert_eq!(
        note,
        "lens round 3 not bought: its 4 task(s) would bring the lens rounds to 227 agent(s), over the budget of 226 (twice the first round's 113 task(s)); not run in it: rust:errors (src), rust:errors, rust:errors, rust:errors; what the rounds found went on to verification"
    );
}

#[test]
fn the_first_round_is_always_bought_and_the_launchers_budget_wins() {
    let mut r = Rounds {
        round: 1,
        budget: Some(10),
        ..Rounds::default()
    };
    assert_eq!(
        r.over_budget(&lens_tasks(50, 1)),
        None,
        "the first round, over any budget"
    );
    r.count_sent(&lens_tasks(50, 1));
    assert_eq!(r.agent_budget(), Some(10));
    r.round = 2;
    assert!(
        r.over_budget(&lens_tasks(1, 2))
            .is_some_and(|n| n.contains("the launcher's --lens-agents")),
        "the launcher's budget over the default"
    );
}

#[test]
fn a_state_that_did_not_count_its_first_round_sets_no_budget() {
    let r = Rounds {
        round: 3,
        ..Rounds::default()
    };
    assert_eq!(r.agent_budget(), None);
    assert_eq!(r.over_budget(&lens_tasks(1000, 3)), None);
    let old: Rounds = serde_json::from_value(serde_json::json!({
        "round": 2, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}
    }))
    .unwrap();
    assert_eq!((old.sent, old.first, old.budget), (0, 0, None));
}

#[test]
fn a_state_with_no_round_yet_writes_no_count() {
    let v = serde_json::to_value(Rounds::with_budget(None)).unwrap();
    assert!(
        v.get("sent").is_none() && v.get("first").is_none() && v.get("budget").is_none(),
        "a state is written as before until a round is sent: {v}"
    );
    let v = serde_json::to_value(after_first(3)).unwrap();
    assert_eq!(
        (&v["sent"], &v["first"]),
        (&serde_json::json!(3), &serde_json::json!(3))
    );
}
