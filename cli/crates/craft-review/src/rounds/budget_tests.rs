//! The lens rounds' agent budget (realm @nick/craft, node #634).

use super::*;

fn after_first(first: usize) -> Rounds {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    r.count_sent(first);
    r
}

#[test]
fn the_default_budget_is_twice_the_first_round_and_buys_the_round_that_fits() {
    let mut r = after_first(113);
    assert_eq!((r.first, r.sent), (113, 113));
    assert_eq!(r.agent_budget(), Some(226));
    r.round = 2;
    assert_eq!(r.over_budget(113), None, "at the budget, bought");
    r.count_sent(110);
    assert_eq!(
        (r.first, r.sent),
        (113, 223),
        "a later round adds to sent alone"
    );
    r.round = 3;
    let note = r.over_budget(4).expect("223 + 4 is over 226");
    assert_eq!(
        note,
        "lens round 3 not bought: its 4 task(s) would bring the lens rounds to 227 agent(s), over the budget of 226 (twice the first round's 113 task(s)); what the rounds found went on to verification"
    );
}

#[test]
fn the_first_round_is_always_bought_and_the_launchers_budget_wins() {
    let mut r = Rounds {
        round: 1,
        budget: Some(10),
        ..Rounds::default()
    };
    assert_eq!(r.over_budget(50), None, "the first round, over any budget");
    r.count_sent(50);
    assert_eq!(r.agent_budget(), Some(10));
    r.round = 2;
    assert!(
        r.over_budget(1)
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
    assert_eq!(r.over_budget(1000), None);
    let old: Rounds = serde_json::from_value(serde_json::json!({
        "round": 2, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}
    }))
    .unwrap();
    assert_eq!((old.sent, old.first, old.budget), (0, 0, None));
}
