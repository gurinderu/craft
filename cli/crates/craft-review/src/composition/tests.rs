//! The composition as the profiles check it, its round ceiling as the rounds read it, and the plan
//! it holds lenses out of.

use serde_json::json;

use super::{Composition, State, apply, hold};
use crate::plan::Plan;
use crate::profile::Profile;

fn profiles() -> Vec<Profile> {
    ["rust", "general"]
        .into_iter()
        .map(|p| Profile::load(p).unwrap())
        .collect()
}

fn of(entries: &[(&str, State)]) -> Result<Composition, String> {
    let lenses: Vec<(String, State)> = entries.iter().map(|(l, s)| ((*l).to_owned(), *s)).collect();
    Composition::of(&lenses, &profiles())
}

#[test]
fn a_lens_turned_off_or_held_is_kept_by_its_qualified_name() {
    let c = of(&[
        ("rust:money", State::Off),
        ("rust:maintainability", State::FirstRound),
        ("rust:errors", State::Always),
    ])
    .unwrap();
    assert_eq!(c.off, ["rust:money"]);
    assert_eq!(c.first_round, ["rust:maintainability"]);
    let line = c.line().unwrap();
    assert!(
        line.contains("turned off: rust:money")
            && line.contains("held to the first round: rust:maintainability"),
        "{line}"
    );
    assert_eq!(Composition::default().line(), None);
    assert!(Composition::default().is_empty() && !c.is_empty());
}

#[test]
fn the_security_floor_is_never_touched_and_concurrency_never_off() {
    let rust = Profile::load("rust").unwrap();
    assert_eq!(rust.safety_lens, "safety");
    for lens in ["rust:security", "rust:safety", "general:security"] {
        for state in [State::Off, State::FirstRound] {
            let e = of(&[(lens, state)]).unwrap_err();
            assert!(e.contains("security lens"), "{lens}: {e}");
        }
    }
    assert!(
        of(&[("general:concurrency", State::Off)])
            .unwrap_err()
            .contains("first round at most")
    );
    assert_eq!(
        of(&[("general:concurrency", State::FirstRound)])
            .unwrap()
            .first_round,
        ["general:concurrency"]
    );
}

#[test]
fn a_name_that_is_no_profiles_lens_is_refused() {
    assert!(
        of(&[("rust:no-such-lens", State::Off)])
            .unwrap_err()
            .contains("no such lens")
    );
    for bad in ["money", "rust:", ":money"] {
        let e = of(&[(bad, State::Off)]).unwrap_err();
        assert!(e.contains("profile:lens"), "{bad}: {e}");
    }
    assert!(
        of(&[("nope:money", State::Off)])
            .unwrap_err()
            .contains("no such lens")
    );
}

#[test]
fn a_held_lens_gets_one_round_and_the_others_keep_theirs() {
    let mut ps = profiles();
    let before = ps[0].lens("errors").unwrap().rounds;
    let general = ps[1].lens("maintainability").map(|l| l.rounds);
    apply(
        &mut ps,
        &of(&[("rust:maintainability", State::FirstRound)]).unwrap(),
    );
    assert_eq!(
        ps[0]
            .lens("maintainability")
            .unwrap()
            .rounds
            .map(std::num::NonZeroU32::get),
        Some(1)
    );
    assert_eq!(ps[0].lens("errors").unwrap().rounds, before);
    assert_eq!(
        ps[1].lens("maintainability").map(|l| l.rounds),
        general,
        "only its own profile's lens"
    );
}

fn small_plan(extra: &serde_json::Value) -> Plan {
    let mut v = json!({
        "sizeBucket": "small", "lenses": ["errors", "money", "tests"], "maxRounds": 1, "verifyVotes": 1,
        "isLibrary": false, "securitySensitive": false, "intent": "", "spec": "", "churn": [],
        "repoRules": [], "surfaceDropped": [], "lightSkipped": []
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

#[test]
fn a_lens_turned_off_leaves_its_profiles_plan_and_is_named_there() {
    let mut plan = small_plan(&json!({}));
    let other = of(&[("general:money", State::Off)]).unwrap();
    assert_eq!(hold(&mut plan, &other, "rust", &[]), None);
    assert_eq!(
        plan.lenses,
        ["errors", "money", "tests"],
        "general's money is not rust's"
    );
    assert!(plan.profile_off.is_empty());
    let money = of(&[("rust:money", State::Off)]).unwrap();
    assert_eq!(hold(&mut plan, &money, "rust", &[]), None);
    assert_eq!(plan.lenses, ["errors", "tests"]);
    assert_eq!(plan.profile_off, ["money"]);
}

#[test]
fn a_lens_turned_off_but_never_planned_is_named_and_left_out_of_every_held_back_list() {
    let mut plan = small_plan(&json!({
        "lenses": ["errors"], "signalSkipped": ["performance"], "metricsDropped": ["complexity"],
        "lightSkipped": ["compat"], "surfaceDropped": ["design"]
    }));
    let c = of(&[
        ("rust:performance", State::Off),
        ("rust:complexity", State::Off),
        ("rust:compat", State::Off),
        ("rust:design", State::Off),
        ("rust:money", State::Off),
    ])
    .unwrap();
    assert_eq!(hold(&mut plan, &c, "rust", &[]), None);
    assert_eq!(plan.lenses, ["errors"]);
    assert!(plan.signal_skipped.is_empty(), "{:?}", plan.signal_skipped);
    assert!(
        plan.metrics_dropped.is_empty(),
        "{:?}",
        plan.metrics_dropped
    );
    assert!(plan.light_skipped.is_empty(), "{:?}", plan.light_skipped);
    assert!(
        plan.surface_dropped.is_empty(),
        "{:?}",
        plan.surface_dropped
    );
    assert_eq!(
        plan.profile_off,
        ["performance", "complexity", "compat", "design", "money"]
    );
}

#[test]
fn what_the_run_asked_for_itself_stays_and_a_plan_left_with_nothing_keeps_its_lenses() {
    let c = of(&[
        ("rust:money", State::Off),
        ("rust:errors", State::Off),
        ("rust:tests", State::Off),
    ])
    .unwrap();
    let mut asked = small_plan(&json!({}));
    assert_eq!(hold(&mut asked, &c, "rust", &["money".to_owned()]), None);
    assert_eq!(asked.lenses, ["money"]);
    assert_eq!(asked.profile_off, ["errors", "tests"]);

    let mut all = small_plan(&json!({}));
    let line = hold(&mut all, &c, "rust", &[]).unwrap();
    assert!(
        line.contains("every lens planned for rust") && line.contains("errors, money, tests"),
        "{line}"
    );
    assert_eq!(all.lenses, ["errors", "money", "tests"]);
    assert!(all.profile_off.is_empty());
}
